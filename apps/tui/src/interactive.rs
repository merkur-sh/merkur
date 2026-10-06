//! Interactive account entry and a session, on the host's UI reactor.
//! The native transport owns a separate reactor; only commands and decoded
//! output cross between them. Host writes never hold up terminal ACKs.

use std::io;
use std::sync::Arc;

use merkur_client_native::account::{Account, AccountError, Credentials};
use merkur_client_native::driver::OsEntropy;
use merkur_wire::input_record::{InputRecord, KeyEvent, KeyText, decode, keys, mods};
use tokio::time::Instant;
use zeroize::{Zeroize, Zeroizing};

use crate::account_store::Store;
use crate::chrome::Chrome;
use crate::host::{Host, HostRead, HostSize};
use crate::host_input::{HostEvent, HostInput, Reply};
use crate::sensitive::{append_text, push_char};
use crate::session_view::HostFrames;
use crate::ui::{self, OrbAnimation};

pub struct Connect {
    pub origin: Option<String>,
    pub opaque_server_key: Option<[u8; 32]>,
    pub username: Option<String>,
    pub machine: Option<String>,
    pub edge_port: Option<u16>,
    pub relay_only: bool,
    pub state_directory: std::path::PathBuf,
    pub login_only: bool,
    pub identity_backend: Option<merkur_identity_seal::Backend>,
}

/// Enters the host before reading a secret. Dropping it restores the original
/// terminal, including failures during account authentication or connection.
pub async fn connect(mut options: Connect) -> io::Result<u8> {
    let mut host = Host::enter()?;
    let epoch = Instant::now();
    let mut frames = HostFrames::default();
    let mut chrome = Chrome::default();
    let mut orb = OrbAnimation::default();
    let mut parser = HostInput::default();
    let mut size = host.size()?;
    host.write_all(b"\x1b[16t").await?;
    let directory = options.state_directory.clone();
    let mut resumed = match progress(
        &mut host,
        &mut parser,
        &mut frames,
        &mut chrome,
        &mut orb,
        &mut size,
        epoch,
        options.origin.as_deref().unwrap_or("merkur"),
        options.username.as_deref().unwrap_or(""),
        "Opening account…",
        async move {
            tokio::task::spawn_blocking(move || Store::resume(&directory))
                .await
                .map_err(io::Error::other)?
        },
    )
    .await?
    {
        Entry::Value(value) => value,
        Entry::Exit(code) => return Ok(code),
    };
    if let Some(resumed) = &resumed {
        let pin = merkur_authorization::decode_exact::<32>(
            &resumed.profile.opaque_server_key,
            "OPAQUE server key",
        )
        .map_err(io::Error::other)?;
        if options
            .origin
            .as_ref()
            .is_some_and(|origin| origin != &resumed.profile.origin)
            || options
                .username
                .as_ref()
                .is_some_and(|username| username != &resumed.profile.username)
            || options
                .opaque_server_key
                .is_some_and(|expected| expected != pin)
        {
            return Err(io::Error::other(
                "stored account differs; sign out before changing the account or server",
            ));
        }
        options.origin = Some(resumed.profile.origin.clone());
        options.username = Some(resumed.profile.username.clone());
        options.opaque_server_key = Some(pin);
    }
    let origin = options.origin.unwrap_or_else(|| {
        option_env!("MERKUR_PUBLIC_ORIGIN")
            .unwrap_or("https://merkur.sh")
            .to_owned()
    });
    let pin = match options.opaque_server_key {
        Some(pin) => pin,
        None => merkur_authorization::decode_exact::<32>(
            option_env!("MERKUR_OPAQUE_SERVER_PUBLIC_KEY").ok_or_else(|| {
                io::Error::other(
                    "this build has no server pin; pass --opaque-server-key for first sign-in",
                )
            })?,
            "OPAQUE server key",
        )
        .map_err(io::Error::other)?,
    };
    let username = match options.username {
        Some(username) => username,
        None => match field(
            &mut host,
            &mut parser,
            &mut frames,
            &mut chrome,
            &mut orb,
            &mut size,
            epoch,
            &origin,
            "",
            "Username",
            false,
        )
        .await?
        {
            Entry::Value(username) => username.to_string(),
            Entry::Exit(code) => return Ok(code),
        },
    };
    if username.is_empty() {
        return Err(io::Error::other("username is empty"));
    }
    let account = Arc::new(
        Account::new(&origin, pin).map_err(|error| io::Error::other(format!("{error:?}")))?,
    );
    let mut password_prompt = "Password";
    loop {
        let (delegation, delegate, credentials, store) = if let Some(resumed) = resumed.take() {
            let credentials =
                Arc::new(Credentials::stored(&resumed.session, resumed.store.clone()));
            (
                resumed.delegation,
                resumed.delegate,
                credentials,
                resumed.store,
            )
        } else {
            let backend = if let Some(backend) = options.identity_backend {
                backend
            } else {
                let backend = match progress(
                    &mut host,
                    &mut parser,
                    &mut frames,
                    &mut chrome,
                    &mut orb,
                    &mut size,
                    epoch,
                    &origin,
                    &username,
                    "Checking identity hardware…",
                    async {
                        tokio::task::spawn_blocking(merkur_identity_seal::probe)
                            .await
                            .map_err(io::Error::other)?
                            .map_err(io::Error::other)
                    },
                )
                .await?
                {
                    Entry::Value(value) => value,
                    Entry::Exit(code) => return Ok(code),
                };
                if backend == merkur_identity_seal::Backend::Software {
                    match software_choice(
                        &mut host,
                        &mut parser,
                        &mut frames,
                        &mut chrome,
                        &mut orb,
                        &mut size,
                        epoch,
                        &origin,
                        &username,
                    )
                    .await?
                    {
                        Entry::Value(()) => backend,
                        Entry::Exit(code) => return Ok(code),
                    }
                } else {
                    backend
                }
            };
            options.identity_backend = Some(backend);
            let password = match field(
                &mut host,
                &mut parser,
                &mut frames,
                &mut chrome,
                &mut orb,
                &mut size,
                epoch,
                &origin,
                &username,
                password_prompt,
                true,
            )
            .await?
            {
                Entry::Value(value) => value,
                Entry::Exit(code) => return Ok(code),
            };
            let directory = options.state_directory.clone();
            let login_username = username.clone();
            let login_account = Arc::clone(&account);
            // Password submission commits the account operation. Its blocking task
            // owns authentication through durable storage, even if the screen is
            // cancelled; reactor shutdown waits for this task. No minted delegation
            // can be abandoned between the server's finish and local publication.
            let commit = tokio::task::spawn_blocking(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?;
                // The delegate key exists in its custody before the root
                // certifies it, so no secret of it is ever outside custody.
                let (identity, delegate) =
                    merkur_identity_seal::create(backend).map_err(io::Error::other)?;
                let signed_in = match runtime.block_on(login_account.sign_in(
                    &login_username,
                    password,
                    delegate.public_key(),
                    &mut OsEntropy,
                )) {
                    Ok(signed_in) => signed_in,
                    Err(AccountError::WrongCredentials) => return Ok(None),
                    Err(error) => return Err(io::Error::other(format!("{error:?}"))),
                };
                let store =
                    match Store::create(&directory, &login_username, &pin, &signed_in, identity) {
                        Ok(store) => store,
                        Err(error) => {
                            let sessions = runtime
                                .block_on(login_account.sessions(&signed_in.session.access_token))
                                .map_err(|cleanup| {
                                    io::Error::other(format!(
                                        "{error}; cleanup failed: {cleanup:?}"
                                    ))
                                })?;
                            runtime
                                .block_on(login_account.logout(
                                    &signed_in.delegation,
                                    &*delegate,
                                    &signed_in.refresh,
                                    sessions.server_time_ms,
                                    &mut OsEntropy,
                                ))
                                .map_err(|cleanup| {
                                    io::Error::other(format!(
                                        "{error}; cleanup failed: {cleanup:?}"
                                    ))
                                })?;
                            return Err(error);
                        }
                    };
                let credentials = Arc::new(Credentials::stored(&signed_in.session, store.clone()));
                let delegate: Arc<dyn merkur_identity_seal::KeyCustody> = Arc::from(delegate);
                Ok(Some((signed_in.delegation, delegate, credentials, store)))
            });
            match progress(
                &mut host,
                &mut parser,
                &mut frames,
                &mut chrome,
                &mut orb,
                &mut size,
                epoch,
                &origin,
                &username,
                "Signing in…",
                async move { commit.await.map_err(io::Error::other)? },
            )
            .await
            {
                Ok(Entry::Value(Some(value))) => value,
                Ok(Entry::Exit(code)) => return Ok(code),
                Ok(Entry::Value(None)) => {
                    password_prompt = "Password incorrect · Password";
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        if options.login_only {
            return Ok(0);
        }
        match crate::workspace::run(
            &mut host,
            &mut parser,
            &mut frames,
            &mut chrome,
            &mut orb,
            size,
            epoch,
            crate::workspace::AccountState {
                account: Arc::clone(&account),
                credentials,
                delegation: Arc::new(delegation),
                delegate,
                store,
                username: username.clone(),
                edge_port: options.edge_port,
                relay_only: options.relay_only,
            },
            options.machine.take(),
        )
        .await?
        {
            crate::workspace::Exit::Quit(code) => return Ok(code),
            crate::workspace::Exit::Revoked(current_size) => {
                size = current_size;
                password_prompt = "Session revoked · Password to sign in";
                // The workspace has retired every transport and wiped custody.
                // Re-enter account entry on this same host and consumption fence.
            }
        }
    }
}

enum Entry<T> {
    Value(T),
    Exit(u8),
}

#[expect(
    clippy::too_many_arguments,
    reason = "one screen's host state and account identity"
)]
async fn progress<T>(
    host: &mut Host,
    parser: &mut HostInput,
    frames: &mut HostFrames,
    chrome: &mut Chrome,
    orb: &mut OrbAnimation,
    size: &mut HostSize,
    epoch: Instant,
    origin: &str,
    username: &str,
    prompt: &str,
    future: impl Future<Output = io::Result<T>>,
) -> io::Result<Entry<T>> {
    let mut future = Box::pin(future);
    let mut read = [0; 4096];
    let mut events = Vec::new();
    let mut dirty = true;
    let mut paint = Vec::new();
    let mut written = 0;
    let mut completed: Option<io::Result<T>> = None;
    loop {
        // The first screen holds until the host answers its first frame. The
        // `CSI 16 t` written before it then has its reply, or the host states no
        // cell pixels: a session's first viewport never precedes that fact.
        if written == paint.len()
            && frames.answered()
            && let Some(result) = completed.take()
        {
            return result.map(Entry::Value);
        }
        let clock = now(epoch);
        orb.set_visible(clock, account_layout(*size).orb.is_some());
        let writable = written == paint.len() && frames.next_frame(clock, true, true).is_some();
        let at = frames
            .next_frame(clock, dirty && writable, dirty)
            .into_iter()
            .chain(orb.next_frame(clock, writable))
            .reduce(f64::min);
        tokio::select! {
            result = &mut future, if completed.is_none() => { completed = Some(result); },
            count = host.write_chunk(&paint[written..]), if written < paint.len() => { written += count?; },
            event = host.read_event(&mut read) => match event? {
                HostRead::Exit(code) => return Ok(Entry::Exit(code as u8)),
                HostRead::Bytes(0) => return Ok(Entry::Exit(0)),
                HostRead::Resize => { *size = host.resized(*size)?; paint.extend_from_slice(b"\x1b[16t"); dirty = true; },
                HostRead::Bytes(count) => {
                    parser.feed(&read[..count], &mut events);
                    read.zeroize();
                    for mut event in events.drain(..) {
                        reply(&event, frames, size);
                        if let HostEvent::Record(record) = &event
                            && let Some(InputRecord::Focus(focused)) = decode(record)
                        { orb.set_focused(now(epoch), focused); }
                        let cancel = cancelled(&event);
                        erase(&mut event);
                        if cancel { return Ok(Entry::Exit(0)); }
                    }
                    parser.clear_typed();
                },
            },
            _ = wake(epoch, at) => {
                let clock = now(epoch);
                if frames.begin(clock, dirty || orb.due(clock)) {
                    paint.clear();
                    if dirty {
                        chrome.present(*size, |screen| account_frame(screen, *size, origin, username, AccountPrompt::Message(prompt), orb.frame(clock)), &mut paint);
                    } else if let Some(placement) = account_layout(*size).orb {
                        chrome.present(*size, |screen| orb.patch(screen, *size, placement, clock), &mut paint);
                    }
                    orb.painted(clock);
                    written = 0;
                    dirty = false;
                }
            }
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "one screen’s host state and account identity"
)]
async fn software_choice(
    host: &mut Host,
    parser: &mut HostInput,
    frames: &mut HostFrames,
    chrome: &mut Chrome,
    orb: &mut OrbAnimation,
    size: &mut HostSize,
    epoch: Instant,
    origin: &str,
    username: &str,
) -> io::Result<Entry<()>> {
    let mut read = [0; 4096];
    let mut events = Vec::new();
    let mut dirty = true;
    let mut paint = Vec::new();
    let mut written = 0;
    let mut accepted = false;
    loop {
        if accepted && written == paint.len() {
            parser.clear_sensitive();
            return Ok(Entry::Value(()));
        }
        let clock = now(epoch);
        orb.set_visible(clock, account_layout(*size).orb.is_some() && !accepted);
        let writable = written == paint.len() && frames.next_frame(clock, true, true).is_some();
        let at = frames
            .next_frame(clock, dirty && !accepted && writable, dirty)
            .into_iter()
            .chain(orb.next_frame(clock, writable))
            .reduce(f64::min);
        tokio::select! {
            count = host.write_chunk(&paint[written..]), if written < paint.len() => { written += count?; },
            event = host.read_event(&mut read) => match event? {
                HostRead::Exit(code) => return Ok(Entry::Exit(code as u8)),
                HostRead::Bytes(0) => return Ok(Entry::Exit(0)),
                HostRead::Resize => { *size = host.resized(*size)?; paint.extend_from_slice(b"\x1b[16t"); dirty = true; },
                HostRead::Bytes(count) => {
                    parser.feed(&read[..count], &mut events);
                    read.zeroize();
                    for mut event in events.drain(..) {
                        reply(&event, frames, size);
                        if let HostEvent::Record(record) = &event
                            && let Some(InputRecord::Focus(focused)) = decode(record)
                        { orb.set_focused(now(epoch), focused); }
                        let cancel = cancelled(&event);
                        if let HostEvent::Record(record) = &event {
                            accepted |= match decode(record) {
                                Some(InputRecord::Key(key)) => key.event == KeyEvent::Press
                                    && key.key == u32::from('s') && key.mods & !mods::LOCKS == 0,
                                Some(InputRecord::Text("s")) => true,
                                _ => false,
                            };
                        }
                        erase(&mut event);
                        if cancel { return Ok(Entry::Exit(0)); }
                    }
                    parser.clear_typed();
                },
            },
            _ = wake(epoch, at) => {
                let clock = now(epoch);
                if frames.begin(clock, dirty || orb.due(clock)) {
                    paint.clear();
                    if dirty {
                        chrome.present(*size, |screen| account_frame(screen, *size, origin, username, AccountPrompt::SoftwareChoice, orb.frame(clock)), &mut paint);
                    } else if let Some(placement) = account_layout(*size).orb {
                        chrome.present(*size, |screen| orb.patch(screen, *size, placement, clock), &mut paint);
                    }
                    orb.painted(clock);
                    written = 0;
                    dirty = false;
                }
            }
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "one account field and host screen state"
)]
async fn field(
    host: &mut Host,
    parser: &mut HostInput,
    frames: &mut HostFrames,
    chrome: &mut Chrome,
    orb: &mut OrbAnimation,
    size: &mut HostSize,
    epoch: Instant,
    origin: &str,
    username: &str,
    label: &str,
    masked: bool,
) -> io::Result<Entry<Zeroizing<String>>> {
    let mut secret = Zeroizing::new(String::new());
    let mut read = [0u8; 4096];
    let mut events = Vec::new();
    let mut dirty = true;
    let mut paint = Vec::new();
    let mut written = 0;
    let mut submitted = None;
    loop {
        if written == paint.len()
            && let Some(submit) = submitted
        {
            parser.clear_sensitive();
            return Ok(if submit {
                Entry::Value(secret)
            } else {
                Entry::Exit(0)
            });
        }
        let clock = now(epoch);
        orb.set_visible(
            clock,
            account_layout(*size).orb.is_some() && submitted.is_none(),
        );
        let writable = written == paint.len() && frames.next_frame(clock, true, true).is_some();
        let at = frames
            .next_frame(clock, dirty && submitted.is_none() && writable, dirty)
            .into_iter()
            .chain(orb.next_frame(clock, writable))
            .reduce(f64::min);
        tokio::select! {
            count = host.write_chunk(&paint[written..]), if written < paint.len() => { written += count?; },
            event = host.read_event(&mut read) => match event? {
                HostRead::Exit(code) => return Ok(Entry::Exit(code as u8)),
                HostRead::Bytes(0) => return Ok(Entry::Exit(0)),
                HostRead::Resize => { *size = host.resized(*size)?; paint.extend_from_slice(b"\x1b[16t"); dirty = true; }
                HostRead::Bytes(count) => {
                    parser.feed(&read[..count], &mut events);
                    read.zeroize();
                    let mut done = None;
                    for mut event in events.drain(..) {
                        reply(&event, frames, size);
                        if let HostEvent::Record(record) = &event
                            && let Some(InputRecord::Focus(focused)) = decode(record)
                        { orb.set_focused(now(epoch), focused); }
                        if done.is_none() && submitted.is_none() {
                            if cancelled(&event) { done = Some(false); }
                            if let HostEvent::Record(record) = &event {
                                match decode(record) {
                                    Some(InputRecord::Key(key)) if key.event != KeyEvent::Release => {
                                        if key.key == keys::ENTER { done = Some(true); }
                                        else if key.key == keys::BACKSPACE { erase_last(&mut secret); }
                                        else { match key.text {
                                            KeyText::Implied(c) => push_char(&mut secret, c),
                                            KeyText::Explicit(text) => append_text(&mut secret, text),
                                            KeyText::None => {},
                                        }}
                                        dirty = true;
                                    }
                                    Some(InputRecord::Text(text) | InputRecord::Paste(text)) => {
                                        append_text(&mut secret, text); dirty = true;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        erase(&mut event);
                    }
                    parser.clear_typed();
                    if let Some(submit) = done {
                        submitted = Some(submit);
                    }
                }
            },
            _ = wake(epoch, at) => {
                let clock = now(epoch);
                if frames.begin(clock, dirty || orb.due(clock)) {
                    paint.clear();
                    if dirty {
                        chrome.present(*size, |screen| account_frame(screen, *size, origin, username, AccountPrompt::Field { label, value: &secret, masked }, orb.frame(clock)), &mut paint);
                    } else if let Some(placement) = account_layout(*size).orb {
                        chrome.present(*size, |screen| orb.patch(screen, *size, placement, clock), &mut paint);
                    }
                    orb.painted(clock);
                    written = 0;
                    dirty = false;
                }
            }
        }
    }
}

pub(crate) fn now(epoch: Instant) -> f64 {
    epoch.elapsed().as_secs_f64() * 1000.0
}
pub(crate) async fn wake(epoch: Instant, at: Option<f64>) {
    match at {
        Some(at) => {
            let deadline = epoch + std::time::Duration::from_secs_f64(at.max(0.0) / 1000.0);
            // Ready composition is an event, not a millisecond timer. Register
            // only future deadlines for maintenance and viewer timeouts.
            if deadline > Instant::now() {
                tokio::time::sleep_until(deadline).await;
            }
        }
        None => std::future::pending().await,
    }
}
pub(crate) fn reply(event: &HostEvent, frames: &mut HostFrames, size: &mut HostSize) {
    match event {
        HostEvent::Reply(Reply::Consumed) => {
            crate::graphics::host_consumed();
            frames.consumed();
        }
        HostEvent::Reply(Reply::CellSize { width, height }) => {
            size.cell = Some((f64::from(*width), f64::from(*height)));
        }
        _ => {}
    }
}
pub(crate) fn cancelled(event: &HostEvent) -> bool {
    matches!(event, HostEvent::Record(record) if matches!(decode(record),
        Some(InputRecord::Key(key)) if key.event != KeyEvent::Release &&
            (key.key == 0xE000 || (key.key == u32::from('c') && key.mods & !mods::LOCKS == mods::CTRL))))
}
pub(crate) fn erase(event: &mut HostEvent) {
    if let HostEvent::Record(record) = event {
        record.zeroize();
    }
}
pub(crate) fn erase_last(secret: &mut String) {
    if let Some((at, _)) = secret.char_indices().next_back() {
        // A safe string split lets zeroize overwrite exactly the erased UTF-8
        // scalar before the vector's length changes.
        let (_, tail) = secret.split_at_mut(at);
        tail.zeroize();
        secret.truncate(at);
    }
}
pub(crate) fn safe(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}
enum AccountPrompt<'a> {
    Message(&'a str),
    Field {
        label: &'a str,
        value: &'a str,
        masked: bool,
    },
    SoftwareChoice,
}

struct AccountLayout {
    width: u16,
    left: u16,
    card_top: u16,
    text_width: u16,
    orb: Option<((u16, u16), ui::OrbSize)>,
}
fn account_layout(size: HostSize) -> AccountLayout {
    let width = if size.cols >= 24 {
        size.cols.saturating_sub(4).min(64)
    } else {
        size.cols
    };
    let left = size.cols.saturating_sub(width) / 2 + 1;
    let inner = width.saturating_sub(4);
    let beside = inner >= 56;
    let above = !beside && size.rows >= 20 && width >= 16;
    let top = size.rows.saturating_sub(if above { 20 } else { 13 }) / 2 + 1;
    let card_top = top + if above { 7 } else { 0 };
    let text_width = if beside { inner - 24 } else { inner };
    let orb = if size.rows < 13 || width < 12 {
        None
    } else if beside {
        Some(((card_top + 1, left + width - 24), ui::OrbSize::Large))
    } else if above {
        Some((
            (top, size.cols.saturating_sub(12) / 2 + 1),
            ui::OrbSize::Small,
        ))
    } else {
        None
    };
    AccountLayout {
        width,
        left,
        card_top,
        text_width,
        orb,
    }
}

fn account_frame(
    out: &mut Vec<u8>,
    size: HostSize,
    origin: &str,
    username: &str,
    prompt: AccountPrompt<'_>,
    frame: usize,
) {
    use crate::ui::{self, Style};
    let AccountLayout {
        width,
        left,
        card_top,
        text_width,
        orb,
    } = account_layout(size);
    out.extend_from_slice(ui::BEGIN);
    // Compact hosts retain the prompt and controls instead of a clipped card.
    if size.rows < 13 || width < 12 {
        ui::paint(
            out,
            size,
            (1, 1),
            size.cols,
            "MERKUR / SIGN IN",
            Style::Accent,
        );
        ui::paint(out, size, (2, 1), size.cols, origin, Style::Meta);
        let (label, value, hint) = account_content(&prompt, size.cols);
        ui::paint(out, size, (3, 1), size.cols, &label, Style::Heading);
        ui::paint(out, size, (4, 1), size.cols, &value, Style::Body);
        ui::paint(out, size, (size.rows, 1), size.cols, &hint, Style::Bar);
        if matches!(prompt, AccountPrompt::Field { .. }) && size.rows > 4 && size.cols > 0 {
            let col = 1 + ui::columns(&value).min(usize::from(size.cols - 1)) as u16;
            out.extend_from_slice(format!("\x1b[4;{col}H\x1b[6 q\x1b[?25h").as_bytes());
        }
        out.extend_from_slice(ui::END);
        return;
    }
    for row in 0..13 {
        let border = if row == 0 {
            format!("╭{}╮", "─".repeat(usize::from(width - 2)))
        } else if row == 12 {
            format!("╰{}╯", "─".repeat(usize::from(width - 2)))
        } else {
            format!("│{}│", " ".repeat(usize::from(width - 2)))
        };
        ui::paint(
            out,
            size,
            (card_top + row, left),
            width,
            &border,
            Style::Line,
        );
    }
    let mut content = |row, text: &str, style| {
        ui::paint(
            out,
            size,
            (card_top + row, left + 2),
            text_width,
            text,
            style,
        );
    };
    content(1, "MERKUR", Style::Accent);
    content(2, "Your terminal, from anywhere.", Style::Meta);
    content(4, origin, Style::Meta);
    if !username.is_empty() {
        content(5, "Account", Style::Meta);
    }
    let (label, value, hint) = account_content(&prompt, text_width);
    content(7, &label, Style::Heading);
    content(8, &value, Style::Body);
    content(10, &hint, Style::Meta);
    if !username.is_empty() {
        ui::paint(
            out,
            size,
            (card_top + 5, left + 11),
            text_width.saturating_sub(9),
            username,
            Style::Body,
        );
    }
    if let Some((position, art)) = orb {
        ui::orb(out, size, position, art, frame, None);
    }
    if matches!(prompt, AccountPrompt::Field { .. }) {
        let col =
            left + 2 + ui::columns(&value).min(usize::from(text_width.saturating_sub(1))) as u16;
        out.extend_from_slice(
            format!("\x1b[{};{}H\x1b[6 q\x1b[?25h", card_top + 8, col).as_bytes(),
        );
    }
    out.extend_from_slice(ui::END);
}

fn account_content(prompt: &AccountPrompt<'_>, width: u16) -> (String, String, String) {
    match prompt {
        AccountPrompt::Message(message) => (
            (*message).into(),
            "Please wait.".into(),
            "Esc cancel".into(),
        ),
        AccountPrompt::SoftwareChoice => (
            "Hardware protection unavailable".into(),
            "Store the login key on this machine?".into(),
            "s store key · Esc cancel".into(),
        ),
        AccountPrompt::Field {
            label,
            value,
            masked,
        } => {
            let display = if *masked {
                "•".repeat(value.chars().count())
            } else {
                safe(value)
            };
            // Keep the editing end visible, leaving a column for the cursor.
            let budget = usize::from(width.saturating_sub(1));
            let display = if crate::ui::columns(&display) > budget {
                let mut used = 1;
                let suffix: String = display
                    .chars()
                    .rev()
                    .take_while(|c| {
                        used += unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0);
                        used <= budget
                    })
                    .collect();
                format!("…{}", suffix.chars().rev().collect::<String>())
            } else {
                display
            };
            (
                (*label).into(),
                display,
                "Enter continue · Esc cancel".into(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };

    #[test]
    fn ready_work_needs_no_runtime_timer_and_idle_work_never_wakes() {
        let epoch = Instant::now();
        let mut cx = Context::from_waker(Waker::noop());
        assert_eq!(
            std::pin::pin!(wake(epoch, Some(0.0))).poll(&mut cx),
            Poll::Ready(())
        );
        assert_eq!(
            std::pin::pin!(wake(epoch, None)).poll(&mut cx),
            Poll::Pending
        );
    }

    #[test]
    fn animated_sign_in_keeps_the_prompt_and_password_outside_its_patch() {
        for (cols, rows) in [(80, 24), (40, 24)] {
            let size = HostSize {
                cols,
                rows,
                cell: None,
            };
            let placement = account_layout(size).orb.unwrap();
            let mut clock = OrbAnimation::default();
            clock.set_visible(0.0, true);
            let password = |out: &mut Vec<u8>, frame| {
                account_frame(
                    out,
                    size,
                    "https://merkur.example",
                    "ada",
                    AccountPrompt::Field {
                        label: "Password",
                        value: "private-secret",
                        masked: true,
                    },
                    frame,
                )
            };
            let mut chrome = crate::chrome::Chrome::default();
            let mut displayed = Vec::new();
            chrome.present(size, |screen| password(screen, 0), &mut displayed);
            clock.painted(0.0);
            crate::ui::tests::preview(&format!("animation-{cols}-00"), &displayed);
            for frame in 1..crate::orb::FRAME_COUNT {
                let at = frame as f64 * 1_000.0 / 12.0 + 0.001;
                chrome.present(
                    size,
                    |screen| clock.patch(screen, size, placement, at),
                    &mut displayed,
                );
                clock.painted(at);
                let mut expected = Vec::new();
                password(&mut expected, frame);
                assert_eq!(
                    crate::ui::tests::screen(size, &displayed),
                    crate::ui::tests::screen(size, &expected)
                );
                assert!(!String::from_utf8_lossy(&displayed).contains("private-secret"));
                crate::ui::tests::preview(&format!("animation-{cols}-{frame:02}"), &displayed);
            }
        }
        assert!(
            account_layout(HostSize {
                cols: 32,
                rows: 8,
                cell: None
            })
            .orb
            .is_none()
        );
    }

    #[test]
    fn sign_in_keeps_the_editing_end_visible_and_never_paints_a_password() {
        for (cols, rows) in [(80, 13), (40, 24), (80, 24), (32, 8)] {
            let size = HostSize {
                cols,
                rows,
                cell: None,
            };
            let mut frame = Vec::new();
            account_frame(
                &mut frame,
                size,
                "https://merkur.example",
                "ada",
                AccountPrompt::Field {
                    label: "Password",
                    value: "secret-password-界",
                    masked: true,
                },
                0,
            );
            assert!(!String::from_utf8_lossy(&frame).contains("secret-password"));
            let screen = crate::ui::tests::screen(size, &frame).join("\n");
            assert!(screen.contains("Password"));
            assert!(screen.contains("Enter continue"));
            crate::ui::tests::preview(&format!("sign-in-{cols}"), &frame);
        }
        let (_, value, _) = account_content(
            &AccountPrompt::Field {
                label: "Username",
                value: "a-very-long-username-終",
                masked: false,
            },
            12,
        );
        assert!(value.starts_with('…'));
        assert!(value.ends_with('終'));
        assert!(crate::ui::columns(&value) < 12);
    }
}
