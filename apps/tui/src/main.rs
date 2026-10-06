//! `merkur-tui`: the Merkur terminal client.
//!
//! `connect` enters the controlling terminal, reads a masked password, and
//! opens the named machine. Ctrl-\ is the prefix; q closes the session and
//! a second Ctrl-\ sends that key to the machine.
//!
//! `merkur-tui headless` signs in, connects to one machine and reports what the
//! session does as JSON lines, with no screen. It is how the client core is
//! driven end to end without a host screen in `test:e2e:transport`:
//!
//! ```text
//! merkur-tui headless --origin <url> --opaque-server-key <base64url> \
//!     --username <name> --machine <daemon id> [--edge-port <port>] [--relay-only]
//! ```
//!
//! The password is the first line of standard input, which must not be a
//! terminal: a password never travels in arguments or the environment, and
//! headless mode has no way to stop a terminal echoing it. The rest of
//! standard input is the keyboard: each character is typed into the machine's
//! shell as one key press, a newline as Enter, and every key is shown to the
//! viewer's speculative model first. `--edge-port` and `--relay-only` are the
//! e2e harness's: the first dials the edge through the client role's own proxy
//! listener, the second keeps the session on the relay as `VITE_FORCE_EDGE`
//! keeps the browser's.
//!
//! The viewer applies the machine's display to a grid it never draws, and
//! presents it as a 60 Hz display would, which is what keeps the daemon's
//! display grants flowing and releases held redraws. `SIGUSR1` prints the
//! presented grid's rows, what a screen would show, and so does the end of the
//! session. It claims the machine's terminal size as a focused window of fixed
//! cells would, which also gives the daemon the pixel geometry it places
//! images by.

use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use merkur_client::session::graphics::GraphicsAsset;
use merkur_client::session::{Config, Session, Status};
use merkur_client::uuid_v4;
use merkur_client::viewer::{self, Viewer};
use merkur_client_native::account::{Account, AccountError, Credentials};
use merkur_client_native::driver::{self, Command, OsEntropy, Output};
use merkur_client_native::grid::NativeGrid;
use merkur_wire::input_record::{build, keys};
use serde_json::json;
use tokio::signal::unix::{SignalKind, signal};
use tokio::time::Instant;

mod headless_input;

/// The display headless mode presents as: a frame every 60th of a second
/// while anything applied or the daemon waits on a grant.
const PRESENT_PERIOD_MS: f64 = 1_000.0 / 60.0;
/// The viewport headless mode claims, and its grid until the first snapshot.
const INITIAL_COLS: u16 = 80;
const INITIAL_ROWS: u16 = 24;
/// The cell headless mode claims and sizes image placements by, in pixels.
const CELL_WIDTH: f64 = 10.0;
const CELL_HEIGHT: f64 = 20.0;

struct Headless {
    origin: String,
    opaque_server_key: [u8; 32],
    username: String,
    machine: String,
    edge_port: Option<u16>,
    relay_only: bool,
}

fn main() -> ExitCode {
    if let Err(error) = merkur_identity_seal::disable_core_dumps() {
        eprintln!("merkur: {error}");
        return ExitCode::FAILURE;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (command, rest) = match args.split_first() {
        None => ("", &args[..]),
        Some((command, _)) if command.starts_with("--") => ("", &args[..]),
        Some((command, rest)) => (command.as_str(), rest),
    };
    if args.as_slice() == ["--help"]
        || args.as_slice() == ["-h"]
        || command == "help" && rest.is_empty()
    {
        print_usage();
        return ExitCode::SUCCESS;
    }
    if command == "version" && rest.is_empty() {
        println!("{}", option_env!("MERKUR_VERSION").unwrap_or("dev"));
        return ExitCode::SUCCESS;
    }
    match command {
        "logout" => match parse_state(rest) {
            Some(directory) => {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("account reactor")
                    .block_on(async move {
                        let store = tokio::task::spawn_blocking(move || {
                            merkur_tui::account_store::Store::open(&directory)
                        })
                        .await
                        .map_err(std::io::Error::other)??;
                        if let Some(store) = store {
                            store.sign_out().await?;
                        }
                        Ok::<(), std::io::Error>(())
                    });
                match result {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(error) => {
                        eprintln!("merkur: {error}");
                        ExitCode::FAILURE
                    }
                }
            }
            None => usage(),
        },
        "headless" => match parse_headless(rest) {
            Some(headless) => tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime")
                .block_on(run_headless(headless)),
            None => usage(),
        },
        "" | "login" | "connect" => match parse_connect(rest) {
            Some(mut options) if command != "connect" || options.machine.is_some() => {
                options.login_only = command == "login";
                io_exit(
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("UI reactor")
                        .block_on(merkur_tui::interactive::connect(options)),
                )
            }
            _ => usage(),
        },
        "machines" => match parse_state(rest) {
            Some(directory) => io_exit(
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("account reactor")
                    .block_on(list_machines(directory)),
            ),
            None => usage(),
        },
        _ => usage(),
    }
}

fn print_usage() {
    println!(
        "usage: merkur-tui [login|logout|machines|connect <machine>] [--state-dir <path>]\n\
        first sign-in: [--origin <url>] [--opaque-server-key <base64url>] [--username <name>]\n\
        identity custody: [--identity-seal <hardware|software>]\n\
        headless: --origin <url> --opaque-server-key <base64url> --username <name> --machine <id>"
    );
}

fn usage() -> ExitCode {
    print_usage();
    ExitCode::from(2)
}

fn parse_headless(args: &[String]) -> Option<Headless> {
    let mut origin = None;
    let mut key = None;
    let mut username = None;
    let mut machine = None;
    let mut edge_port = None;
    let mut relay_only = false;
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let slot = match flag.as_str() {
            "--relay-only" if !relay_only => {
                relay_only = true;
                continue;
            }
            "--origin" => &mut origin,
            "--opaque-server-key" => &mut key,
            "--username" => &mut username,
            "--machine" => &mut machine,
            "--edge-port" => &mut edge_port,
            _ => return None,
        };
        if slot.replace(args.next()?.clone()).is_some() {
            return None;
        }
    }
    let opaque_server_key = URL_SAFE_NO_PAD.decode(key?).ok()?.try_into().ok()?;
    let edge_port = match edge_port {
        Some(port) => Some(port.parse().ok()?),
        None => None,
    };
    Some(Headless {
        origin: origin?,
        opaque_server_key,
        username: username?,
        machine: machine?,
        edge_port,
        relay_only,
    })
}

fn parse_state(args: &[String]) -> Option<std::path::PathBuf> {
    match args {
        [] => Some(std::path::PathBuf::from(std::env::var_os("HOME")?).join(".merkur-tui")),
        [flag, directory] if flag == "--state-dir" => Some(directory.into()),
        _ => None,
    }
}

fn parse_connect(args: &[String]) -> Option<merkur_tui::interactive::Connect> {
    let mut origin = None;
    let mut opaque_server_key = None;
    let mut username = None;
    let mut machine = None;
    let mut edge_port = None;
    let mut relay_only = false;
    let mut state_directory = None;
    let mut identity_backend = None;
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--origin" if origin.is_none() => origin = Some(args.next()?.clone()),
            "--opaque-server-key" if opaque_server_key.is_none() => {
                let encoded = args.next()?;
                let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
                if URL_SAFE_NO_PAD.encode(&decoded) != *encoded {
                    return None;
                }
                opaque_server_key = Some(decoded.try_into().ok()?);
            }
            "--username" if username.is_none() => username = Some(args.next()?.clone()),
            "--machine" if machine.is_none() => machine = Some(args.next()?.clone()),
            "--edge-port" if edge_port.is_none() => edge_port = Some(args.next()?.parse().ok()?),
            "--relay-only" if !relay_only => relay_only = true,
            "--state-dir" if state_directory.is_none() => {
                state_directory = Some(std::path::PathBuf::from(args.next()?))
            }
            "--identity-seal" if identity_backend.is_none() => {
                identity_backend = Some(match args.next()?.as_str() {
                    "hardware" => merkur_identity_seal::Backend::Hardware,
                    "software" => merkur_identity_seal::Backend::Software,
                    _ => return None,
                })
            }
            value if !value.starts_with('-') && machine.is_none() && !value.is_empty() => {
                machine = Some(value.to_owned())
            }
            _ => return None,
        }
    }
    let state_directory = state_directory.or_else(|| parse_state(&[]))?;
    Some(merkur_tui::interactive::Connect {
        origin,
        opaque_server_key,
        username,
        machine,
        edge_port,
        relay_only,
        state_directory,
        identity_backend,
        login_only: false,
    })
}
fn io_exit(result: std::io::Result<u8>) -> ExitCode {
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("merkur: {error}");
            ExitCode::FAILURE
        }
    }
}
async fn list_machines(directory: std::path::PathBuf) -> std::io::Result<u8> {
    let resumed =
        tokio::task::spawn_blocking(move || merkur_tui::account_store::Store::resume(&directory))
            .await
            .map_err(std::io::Error::other)??
            .ok_or_else(|| std::io::Error::other("sign in with merkur login first"))?;
    let pin = merkur_authorization::decode_exact::<32>(
        &resumed.profile.opaque_server_key,
        "OPAQUE server key",
    )
    .map_err(std::io::Error::other)?;
    let account = Account::new(&resumed.profile.origin, pin)
        .map_err(|error| std::io::Error::other(format!("{error:?}")))?;
    let credentials = Credentials::stored(&resumed.session, resumed.store);
    let mut events = account
        .devices(&credentials, None)
        .await
        .map_err(|error| std::io::Error::other(format!("{error:?}")))?;
    loop {
        match events
            .next()
            .await
            .map_err(|error| std::io::Error::other(format!("{error:?}")))?
        {
            Some(merkur_client_native::account::devices::Event::Snapshot(snapshot)) => {
                let mut list = merkur_client_native::account::devices::List::default();
                list.apply(merkur_client_native::account::devices::Event::Snapshot(
                    snapshot,
                ))
                .map_err(|error| std::io::Error::other(format!("{error:?}")))?;
                println!("ID\tNAME\tPLATFORM\tSTATUS");
                for device in list.devices {
                    let clean = |value: &str| {
                        value
                            .chars()
                            .filter(|c| !c.is_control())
                            .collect::<String>()
                    };
                    println!(
                        "{}\t{}\t{}\t{:?}",
                        clean(&device.id),
                        clean(&device.name),
                        clean(&device.platform),
                        device.status
                    );
                }
                return Ok(0);
            }
            Some(merkur_client_native::account::devices::Event::SessionEnded) => {
                return Err(std::io::Error::other(
                    "account session revoked; sign in again",
                ));
            }
            None => {
                return Err(std::io::Error::other(
                    "machine stream ended before its snapshot",
                ));
            }
            _ => {}
        }
    }
}

fn emit(value: serde_json::Value) {
    println!("{value}");
}

async fn run_headless(headless: Headless) -> ExitCode {
    if std::io::stdin().is_terminal() {
        eprintln!("merkur-tui headless: pipe the password on standard input");
        return ExitCode::from(2);
    }
    // Duplicate the raw descriptor before constructing any buffered reader.
    // std/Tokio stdin must never retain a consumed plaintext password prefix.
    let password = tokio::task::spawn_blocking(|| {
        let fd = rustix::io::dup(std::io::stdin())?;
        let mut input = std::fs::File::from(fd);
        merkur_tui::password_line::read(&mut input)
    })
    .await;
    let password = match password {
        Ok(Ok(Some(password))) => password,
        _ => {
            eprintln!("merkur-tui headless: no valid password on standard input");
            return ExitCode::from(2);
        }
    };
    let mut keyboard = match headless_input::HeadlessInput::stdin() {
        Ok(keyboard) => keyboard,
        Err(error) => {
            eprintln!("merkur-tui headless: cannot watch input: {error}");
            return ExitCode::FAILURE;
        }
    };

    let account = match Account::new(&headless.origin, headless.opaque_server_key) {
        Ok(account) => Arc::new(account),
        Err(error) => return fail("account", &error),
    };
    let mut entropy = OsEntropy;
    // Headless keeps no account: its delegate is an ephemeral software key,
    // dropped with the process.
    let delegate: Arc<dyn merkur_identity_seal::KeyCustody> =
        match merkur_identity_seal::create(merkur_identity_seal::Backend::Software) {
            Ok((_, custody)) => Arc::from(custody),
            Err(error) => {
                eprintln!("merkur-tui headless: delegate key: {error}");
                return ExitCode::FAILURE;
            }
        };
    let signed_in = match account
        .sign_in(&headless.username, password, delegate.public_key(), &mut entropy)
        .await
    {
        Ok(signed_in) => signed_in,
        Err(error) => return fail("sign_in", &error),
    };
    emit(json!({
        "event": "signed_in",
        "user_id": signed_in.session.user_id,
        "delegation_id": signed_in.session.delegation_id,
    }));

    let session = Session::new(
        Config {
            browser_node_id: uuid_v4(&mut entropy),
            relay_only: headless.relay_only,
        },
        signed_in.delegation,
    );
    let credentials = Arc::new(Credentials::new(&signed_in.session, signed_in.refresh));
    let (commands, session_commands) = driver::Commands::channel();
    let _ = commands.send(Command::Focused(true));
    let _ = commands.send(Command::Viewport {
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        cell: Some((CELL_WIDTH, CELL_HEIGHT)),
    });
    let (outputs, mut output) = driver::Outputs::channel();
    let (machine, edge_port) = (headless.machine, headless.edge_port);
    let driver = tokio::spawn(async move {
        driver::run(
            session,
            &machine,
            Arc::new(merkur_client_native::issuer::AccountIssuer {
                account,
                credentials,
            }),
            delegate,
            edge_port,
            session_commands,
            outputs,
        )
        .await;
    });
    let Ok(mut screen_requests) = signal(SignalKind::user_defined1()) else {
        eprintln!("merkur-tui headless: cannot watch SIGUSR1");
        return ExitCode::FAILURE;
    };

    let epoch = Instant::now();
    let now_ms = || epoch.elapsed().as_secs_f64() * 1_000.0;
    let mut viewer = Viewer::new(NativeGrid::new(INITIAL_COLS, INITIAL_ROWS));
    viewer.set_cell_size(now_ms(), CELL_WIDTH, CELL_HEIGHT);
    // Applied state not yet presented.
    let mut frame_owed = false;
    // Dropped at the end of input, which ends the session.
    let mut commands = Some(commands);
    // Every record's number in the host's own sequence, from 1.
    let mut local_seq = 0u32;
    let mut read = [0u8; 4096];
    // The start of a character a read split.
    let mut partial = Vec::new();
    let mut code = ExitCode::FAILURE;
    loop {
        let wake = next_wake(&viewer, frame_owed, now_ms())
            .map(|at_ms| epoch + std::time::Duration::from_secs_f64(at_ms / 1_000.0));
        tokio::select! {
            count = keyboard.read(&mut read), if commands.is_some() => match count {
                Ok(count) if count > 0 => {
                    partial.extend_from_slice(&read[..count]);
                    let now = now_ms();
                    for key in take_keys(&mut partial) {
                        let record = if key == '\n' {
                            build::functional(keys::ENTER, 0, 0)
                        } else {
                            build::press(key)
                        };
                        local_seq += 1;
                        let modelled = viewer.input(now, local_seq, &record);
                        if let Some(commands) = &commands {
                            let _ = commands.send(Command::Input {
                                local_seq,
                                record,
                                modelled,
                            });
                        }
                    }
                }
                Ok(_) => commands = None,
                Err(error) => {
                    eprintln!("merkur-tui headless: input failed: {error}");
                    drop(commands.take());
                    break;
                }
            },
            delivery = output.recv() => {
                let (event, _lease) = match delivery {
                    Some(delivery) => { let (output, lease) = delivery.into_parts(); (Some(output), Some(lease)) },
                    None => (None, None),
                };
                match event {
                Some(Output::InputAcknowledged(_)) => {},
                Some(Output::TerminalUi(effect)) => {
                    use merkur_wire::terminal_ui::TerminalUi;
                    match effect {
                        TerminalUi::Title(title) => emit(json!({ "event": "title", "title": title })),
                        TerminalUi::Bell => emit(json!({ "event": "bell" })),
                        TerminalUi::Notification { title, body } => emit(json!({ "event": "notification", "title": title, "body": body })),
                        TerminalUi::Clipboard { selection, text } => emit(json!({ "event": "clipboard", "selection": selection, "bytes": text.len() })),
                    }
                },
                Some(Output::OpenUrl { id, url }) => {
                    // The headless host publishes the request, never launches it.
                    emit(json!({ "event": "open_url", "epoch": id.epoch, "seq": id.seq, "url": url }));
                    if let Some(commands) = &commands { let _ = commands.send(Command::OpenUrlAcknowledged(id)); }
                },
                Some(Output::Status(status)) => {
                    emit(json!({ "event": "status", "status": format!("{status:?}") }));
                    if let Status::Closed(_) = status {
                        break;
                    }
                }
                Some(Output::ObservedPath(_)) => {},
                Some(Output::Observation(observation)) => emit(json!({ "event": "observation", "measurement": observation })),
                Some(Output::Path(path)) => {
                    emit(json!({ "event": "path", "path": format!("{path:?}") }));
                }
                Some(Output::GeometryState(status)) => {
                    emit(json!({ "event": "geometry", "status": format!("{status:?}") }));
                }
                Some(Output::DisplayFence(fence)) => viewer.fence(now_ms(), fence),
                Some(Output::GraphicsAsset { epoch, key, asset, bytes }) => {
                    emit(json!({
                        "event": "graphics_asset",
                        "epoch": epoch,
                        "key": key,
                        "asset": format!("{asset:?}"),
                        "bytes": bytes.len(),
                    }));
                    // Holding a tile is what a drawn one would be: resident.
                    match asset {
                        GraphicsAsset::Tile => {
                            viewer.set_graphics_resident(now_ms(), epoch, &key, true);
                        }
                        GraphicsAsset::Animation => {
                            viewer.graphics_manifest(now_ms(), epoch, &key, bytes);
                        }
                    }
                }
                Some(Output::GraphicsClock { monotonic_us, rtt_ms }) => {
                    viewer.graphics_clock(now_ms(), monotonic_us, rtt_ms as f64);
                }
                Some(Output::Terminal { channel, payload, input, .. }) => {
                    let before = viewer.stats();
                    let now = now_ms();
                    viewer.receive(now, channel, &payload, input);
                    // Urgent state, and a transaction that closed early, show at once.
                    viewer.present_now(now);
                    let after = viewer.stats();
                    frame_owed |= after.frames != before.frames;
                    if after.snapshots != before.snapshots {
                        let grid = viewer.grid().terminal();
                        emit(json!({
                            "event": "snapshot",
                            "generation": viewer.generation(),
                            "cols": grid.cols(),
                            "rows": grid.rows(),
                        }));
                    }
                }
                Some(Output::IssuanceRefused(error)) => {
                    emit(json!({ "event": "issuance_refused", "error": format!("{error:?}") }));
                }
                None => {
                    code = ExitCode::SUCCESS;
                    break;
                }
                }
            },
            () = sleep_until(wake) => {
                let now = now_ms();
                viewer.handle_timeout(now);
                // A hold whose deadline passed lets what applied show.
                viewer.present_now(now);
                if frame_owed || viewer.wants_frame(true) {
                    let frame_ms = (now / PRESENT_PERIOD_MS).floor() * PRESENT_PERIOD_MS;
                    viewer.frame(frame_ms, PRESENT_PERIOD_MS, true, None);
                    frame_owed = false;
                }
            }
            Some(()) = screen_requests.recv() => emit_screen(&viewer, local_seq),
        }
        while let Some(message) = viewer.poll_output(now_ms()) {
            let command = match message {
                viewer::Output::Ack { payload, durable } => {
                    Command::DisplayAck { payload, durable }
                }
                viewer::Output::SnapshotRequest => Command::SnapshotRequest,
                viewer::Output::ResyncRows { generation, rows } => {
                    Command::ResyncRows { generation, rows }
                }
                viewer::Output::DictionaryReady(ready) => Command::DictionaryReady(ready),
                viewer::Output::DictionaryAck(id) => Command::DictionaryAck(id),
                viewer::Output::GraphicsDemand { epoch, demands } => {
                    emit(json!({
                        "event": "graphics_demand",
                        "epoch": epoch,
                        "tiles": demands.len(),
                    }));
                    Command::GraphicsDemand { epoch, demands }
                }
                viewer::Output::Resume(resume) => {
                    emit(json!({
                        "event": "resume",
                        "generation": resume.generation,
                        "applied_seq": resume.applied_seq,
                        "kept": resume.row_hashes.is_some(),
                    }));
                    Command::DisplayResume(resume)
                }
            };
            if let Some(commands) = &commands {
                let _ = commands.send(command);
            }
        }
    }
    emit_screen(&viewer, local_seq);
    let _ = driver.await;
    code
}

/// The whole characters at the front of `bytes`, which keeps the start of one
/// a read split. A byte that begins no character is dropped.
fn take_keys(bytes: &mut Vec<u8>) -> Vec<char> {
    let mut keys = Vec::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(text) => {
                keys.extend(text.chars());
                bytes.clear();
                return keys;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                keys.extend(
                    std::str::from_utf8(&bytes[..valid])
                        .expect("the valid prefix")
                        .chars(),
                );
                match error.error_len() {
                    // Split by the read: the rest arrives with the next.
                    None => {
                        bytes.drain(..valid);
                        return keys;
                    }
                    Some(invalid) => {
                        bytes.drain(..valid + invalid);
                    }
                }
            }
        }
    }
}

/// The next presented frame, when one is owed, or the viewer's own deadline.
fn next_wake(viewer: &Viewer<NativeGrid>, frame_owed: bool, now_ms: f64) -> Option<f64> {
    let frame = (frame_owed || viewer.wants_frame(true))
        .then(|| ((now_ms / PRESENT_PERIOD_MS).floor() + 1.0) * PRESENT_PERIOD_MS);
    match (frame, viewer.next_deadline()) {
        (Some(frame), Some(deadline)) => Some(frame.min(deadline)),
        (frame, deadline) => frame.or(deadline),
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// The presented grid and the viewer's counters. `sent` is the newest record
/// the host numbered, and `covered` the newest the applied display answers.
fn emit_screen(viewer: &Viewer<NativeGrid>, sent: u32) {
    let stats = viewer.stats();
    let prediction = viewer.prediction();
    // The frame each animated image shows: the one its bindings name.
    let scene = viewer.graphics_scene();
    let animation_frames: Vec<u32> = scene
        .animations
        .iter()
        .filter_map(|group| {
            let (_, key) = group.bindings.first()?;
            scene
                .tiles
                .iter()
                .find(|tile| tile.key == *key)
                .map(|tile| tile.frame)
        })
        .collect();
    emit(json!({
        "event": "screen",
        "generation": viewer.generation(),
        "frames": stats.frames,
        "presentations": stats.presentations,
        "snapshots": stats.snapshots,
        "resyncs": stats.resyncs,
        "last_resync": stats.last_resync.map(|reason| format!("{reason:?}")),
        "recovered": stats.recovered,
        "resync_rows": stats.resync_rows,
        "dictionaries": stats.dictionaries,
        "resumes": stats.resumes,
        "repairs": stats.repairs,
        "input": {
            "sent": sent,
            "covered": viewer.authoritative_input(),
        },
        "prediction": {
            "state": format!("{:?}", prediction.state),
            // Whether the next modellable key would be modelled.
            "armed": viewer.prediction_armed(),
            "modelled": prediction.modelled,
            "confirmed": prediction.confirmed,
            "mismatched": prediction.mismatched,
            "expired_covered": prediction.expired_covered,
            "expired_stalled": prediction.expired_stalled,
        },
        "animation_frames": animation_frames,
        "rows": viewer.grid().screen(),
    }));
}

fn fail(stage: &str, error: &AccountError) -> ExitCode {
    let detail = match error {
        AccountError::WrongCredentials => "wrong username or password".to_string(),
        other => format!("{other:?}"),
    };
    emit(json!({ "event": "error", "stage": stage, "error": detail }));
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::take_keys;

    #[test]
    fn a_character_a_read_split_waits_for_the_rest_and_a_stray_byte_is_dropped() {
        let mut bytes = vec![b'a', 0xc3];
        assert_eq!(take_keys(&mut bytes), ['a']);
        assert_eq!(bytes, [0xc3]);
        bytes.extend_from_slice(&[0xa9, 0xff, b'\n']);
        assert_eq!(take_keys(&mut bytes), ['é', '\n']);
        assert!(bytes.is_empty());
    }
}
