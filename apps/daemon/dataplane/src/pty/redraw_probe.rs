//! Opt-in real-application diagnostic. Captures only its own generated fixture,
//! never a user's shell. Read timestamps precede the diagnostic channel and
//! parser work; this is not a benchmark of the production PTY reader.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{RecvTimeoutError, sync_channel};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::{Value, json};

use super::{TerminalEvent, TerminalState, configure_blocking_master};

struct OwnedProbe {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    fixture: PathBuf,
}

impl Drop for OwnedProbe {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Exact exclusively-created fixture, not a recursive directory removal.
        let _ = std::fs::remove_file(&self.fixture);
    }
}

#[test]
#[ignore = "real Neovim diagnostic; set NVIM_PROBE_EXECUTABLE to an absolute executable"]
fn neovim_pty_redraw_boundaries() {
    let executable = std::fs::canonicalize(
        std::env::var_os("NVIM_PROBE_EXECUTABLE").expect("NVIM_PROBE_EXECUTABLE is required"),
    )
    .unwrap();
    let count: usize = std::env::var("BENCH_SAMPLES")
        .unwrap_or_else(|_| "100".to_owned())
        .parse()
        .unwrap();
    assert!((1..=1000).contains(&count));
    let fixture = std::env::temp_dir().join(format!(
        "merkur-owned-nvim-redraw-{}-{}.rs",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&fixture)
        .unwrap();
    for line in 1..=2400 {
        writeln!(
            file,
            "pub fn merkur_line_{line:04}() {{ let value = \"{}\"; }}",
            "navigation_payload_".repeat(6)
        )
        .unwrap();
    }
    drop(file);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 53,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    configure_blocking_master(pair.master.as_ref()).unwrap();
    let mut command = CommandBuilder::new(&executable);
    command.args(["-u", "NONE", "-N", "--noplugin", "-n", "-i", "NONE", "-R",
        "--cmd", "set shortmess+=I", "--cmd",
        "set noswapfile noundofile nowrap nonumber norelativenumber laststatus=0 showtabline=0 noshowmode noruler",
        "-c", "set filetype=rust | syntax enable | normal! gg"]);
    command.arg(&fixture);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Merkur");
    let owned = OwnedProbe {
        child: pair.slave.spawn_command(command).unwrap(),
        fixture,
    };
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (tx, rx) = sync_channel(64);
    let origin = Instant::now();
    let reader_thread = std::thread::spawn(move || {
        loop {
            let mut bytes = vec![0; 32 * 1024];
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(size) => {
                    let at = origin.elapsed().as_secs_f64() * 1000.0;
                    bytes.truncate(size);
                    if tx.send((at, bytes)).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
    let (event_tx, event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(120, 53, event_tx);
    let mut hashes = Vec::new();
    terminal.current_row_hashes_into(&mut hashes);
    let mut records: Vec<Value> = Vec::with_capacity(count * 8);
    for operation in 0..=count {
        let start = origin.elapsed().as_secs_f64() * 1000.0;
        if operation > 0 {
            writer
                .write_all(if operation % 2 == 1 { b"\x06" } else { b"\x02" })
                .unwrap();
            writer.flush().unwrap();
        }
        let limit = Instant::now()
            + if operation == 0 {
                Duration::from_secs(10)
            } else {
                Duration::from_secs(2)
            };
        let quiet = if operation == 0 {
            Duration::from_millis(500)
        } else {
            Duration::from_millis(100)
        };
        let mut total_bytes = 0;
        let mut chunks = 0;
        loop {
            assert!(Instant::now() < limit, "unbounded application output");
            match rx.recv_timeout(quiet.min(limit.saturating_duration_since(Instant::now()))) {
                Ok((read_at, bytes)) => {
                    total_bytes += bytes.len();
                    chunks += 1;
                    assert!(total_bytes <= 2 * 1024 * 1024 && chunks <= 512);
                    let before_header = terminal.current_display_header_signal();
                    let before = hashes.clone();
                    terminal.apply_bytes(&bytes);
                    terminal.current_row_hashes_into(&mut hashes);
                    let changed: Vec<_> = before
                        .iter()
                        .zip(&hashes)
                        .enumerate()
                        .filter_map(|(row, (old, new))| (old != new).then_some(row))
                        .collect();
                    let mut replies = Vec::new();
                    while let Ok(event) = event_rx.try_recv() {
                        if let TerminalEvent::PtyWrite(reply) = event {
                            writer.write_all(&reply).unwrap();
                            replies.push(base64::engine::general_purpose::STANDARD.encode(reply));
                        } else {
                            panic!("unexpected emulator event");
                        }
                    }
                    writer.flush().unwrap();
                    records.push(json!({"operation":operation, "inputAtMs":start,
                        "readAtMs":read_at, "applyDoneAtMs":origin.elapsed().as_secs_f64()*1000.0,
                        "changedRows":changed, "headerChanged":before_header != terminal.current_display_header_signal(),
                        "header":terminal.current_display_header_signal().to_string(),
                        "cursor":terminal.current_cursor_position(), "bytesBase64":base64::engine::general_purpose::STANDARD.encode(bytes),
                        "repliesBase64":replies}));
                    terminal.clear_dirty();
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => panic!("Neovim exited during diagnostic"),
            }
        }
        assert!(chunks > 0, "operation {operation} produced no output");
    }
    drop(owned);
    drop(writer);
    drop(pair.master);
    drop(rx);
    reader_thread.join().unwrap();
    println!(
        "NVIM_PTY_PROBE {}",
        json!({"executable":executable, "samples":count,
        "boundary":"PTY read completion, not application write or browser paint", "records":records})
    );
}
