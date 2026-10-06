//! Account dialogs share the UI loop with every session. Passwords and link
//! codes remain wiped owners; crypto and committed mutations run off the UI.
use super::{AccountState, line, open_url};
use crate::sensitive::push_char;
use crate::{
    host::HostSize,
    host_input::HostEvent,
    interactive::{cancelled, erase_last},
};
use merkur_authorization::RevocationTarget;
use merkur_client_native::{
    account::{
        AccountError,
        devices::Device,
        management::{Revocation, Sessions, VerifiedLink},
    },
    driver::OsEntropy,
};
use merkur_wire::input_record::{InputRecord, KeyEvent, KeyText, decode, keys};
use merkur_wire::protocol::OpenUrlId;
use std::sync::Arc;
use zeroize::Zeroizing;

pub(super) enum Mutation {
    Rename(Device, String),
    Unlink(Device),
    Revoke(RevocationTarget, String),
    Approve(Box<VerifiedLink>),
}
pub(super) enum Job {
    Inspect(Zeroizing<String>),
    Sessions,
    Commit(Mutation, Zeroizing<String>),
}
pub(super) enum Outcome {
    Link(Box<VerifiedLink>),
    Sessions(Sessions),
    Done,
}
pub(super) enum Intent {
    None,
    Close,
    DismissUrl(u64, OpenUrlId),
    OpenUrl(u64, open_url::Request),
    Request(Job),
}
enum Field {
    Name(Device),
    Code,
}
enum Stage {
    Help(usize),
    Url(u64, open_url::Request, usize),
    Field(Field, Zeroizing<String>),
    Review(Mutation),
    Password(Mutation, Zeroizing<String>),
    Sessions(Sessions, usize),
    Pending,
    Done(String),
}
pub(super) struct Dialog {
    stage: Stage,
    pub previous: Option<u64>,
    pub request: u64,
    is_url: bool,
}
impl Dialog {
    pub fn is_help(&self) -> bool {
        matches!(self.stage, Stage::Help(_))
    }
    pub fn help(previous: Option<u64>) -> Self {
        Self {
            stage: Stage::Help(0),
            previous,
            request: 0,
            is_url: false,
        }
    }
    pub fn rename(device: Device, previous: Option<u64>) -> Self {
        Self {
            stage: Stage::Field(Field::Name(device), Zeroizing::new(String::new())),
            previous,
            request: 0,
            is_url: false,
        }
    }
    pub fn unlink(device: Device, previous: Option<u64>) -> Self {
        Self {
            stage: Stage::Review(Mutation::Unlink(device)),
            previous,
            request: 0,
            is_url: false,
        }
    }
    pub fn link(previous: Option<u64>) -> Self {
        Self {
            stage: Stage::Field(Field::Code, Zeroizing::new(String::new())),
            previous,
            request: 0,
            is_url: false,
        }
    }
    pub fn sessions(previous: Option<u64>) -> Self {
        Self {
            stage: Stage::Pending,
            previous,
            request: 0,
            is_url: false,
        }
    }
    pub fn url(tab: u64, request: open_url::Request, previous: Option<u64>) -> Self {
        Self {
            stage: Stage::Url(tab, request, 0),
            previous,
            request: 0,
            is_url: true,
        }
    }
    pub fn pending(&mut self, request: u64) {
        self.request = request;
        self.stage = Stage::Pending;
    }
    pub fn receive(&mut self, result: Result<Outcome, String>) {
        self.stage = match result {
            Ok(Outcome::Link(link)) => Stage::Review(Mutation::Approve(link)),
            Ok(Outcome::Sessions(sessions)) => Stage::Sessions(sessions, 0),
            Ok(Outcome::Done) => Stage::Done("Completed".into()),
            Err(error) => Stage::Done(error),
        };
    }
    pub fn opened(&mut self, result: Result<(), String>) {
        self.stage =
            Stage::Done(result.map_or_else(|error| error, |()| "Opened in your browser".into()));
    }
    pub fn input(&mut self, event: &HostEvent) -> Intent {
        if cancelled(event) {
            // The submitted worker owns a mutation through its response. Its
            // screen may close, but cancelling the screen cannot cancel it.
            return Intent::Close;
        }
        let HostEvent::Record(record) = event else {
            return Intent::None;
        };
        let input = decode(record);
        let key = match input {
            Some(InputRecord::Key(key)) if key.event != KeyEvent::Release => Some(key),
            _ => None,
        };
        let enter = key.is_some_and(|key| key.key == keys::ENTER);
        match &mut self.stage {
            Stage::Help(scroll) => {
                if key.is_some_and(|key| key.key == crate::host_input::functional::UP) {
                    *scroll = scroll.saturating_sub(1);
                } else if key.is_some_and(|key| key.key == crate::host_input::functional::DOWN) {
                    *scroll = scroll.saturating_add(1).min(SHORTCUTS.len() - 1);
                }
                return if enter { Intent::Close } else { Intent::None };
            }
            Stage::Url(tab, request, scroll) => {
                if key.is_some_and(|key| key.key == crate::host_input::functional::UP) {
                    *scroll = scroll.saturating_sub(1);
                } else if key.is_some_and(|key| key.key == crate::host_input::functional::DOWN) {
                    *scroll = scroll.saturating_add(1).min(request.url.len());
                }
                let dismiss = key.is_some_and(|key| key.mods == 0 && key.key == u32::from('d'))
                    || matches!(input, Some(InputRecord::Text("d")));
                if dismiss {
                    return Intent::DismissUrl(*tab, request.id);
                }
                if enter {
                    let intent = Intent::OpenUrl(*tab, request.clone());
                    self.stage = Stage::Pending;
                    return intent;
                }
                return Intent::None;
            }
            Stage::Field(_, text) | Stage::Password(_, text) => {
                if !enter {
                    match input {
                        Some(InputRecord::Key(key)) if key.event != KeyEvent::Release => {
                            if key.key == keys::BACKSPACE {
                                erase_last(text);
                            } else {
                                match key.text {
                                    KeyText::Implied(c) if !c.is_control() => push_char(text, c),
                                    KeyText::Explicit(value) => {
                                        for c in value.chars().filter(|c| !c.is_control()) {
                                            push_char(text, c);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some(InputRecord::Text(value) | InputRecord::Paste(value)) => {
                            for c in value.chars().filter(|c| !c.is_control()) {
                                push_char(text, c);
                            }
                        }
                        _ => {}
                    }
                    return Intent::None;
                }
                if text.is_empty() {
                    return Intent::None;
                }
            }
            Stage::Sessions(sessions, selection) => {
                if sessions.sessions.is_empty() {
                    return if enter { Intent::Close } else { Intent::None };
                }
                if key.is_some_and(|key| key.key == crate::host_input::functional::UP) {
                    *selection = selection.saturating_sub(1);
                }
                if key.is_some_and(|key| key.key == crate::host_input::functional::DOWN) {
                    *selection = (*selection + 1).min(sessions.sessions.len() - 1);
                }
                if !enter {
                    return Intent::None;
                }
                let session = &sessions.sessions[*selection];
                if session.revoked_at.is_some() || session.expires_at <= sessions.server_time_ms {
                    return Intent::None;
                }
                self.stage = Stage::Review(Mutation::Revoke(
                    RevocationTarget {
                        delegation_id: session.delegation_id.clone(),
                        expires_at: session.expires_at,
                    },
                    session_label(session),
                ));
                return Intent::None;
            }
            Stage::Review(_) if !enter => return Intent::None,
            Stage::Pending => return Intent::None,
            Stage::Done(_) => return if enter { Intent::Close } else { Intent::None },
            Stage::Review(_) => {}
        }
        match std::mem::replace(&mut self.stage, Stage::Pending) {
            Stage::Field(Field::Code, text) => Intent::Request(Job::Inspect(text)),
            Stage::Field(Field::Name(device), text) => {
                let name = text.trim();
                if name.is_empty() {
                    self.stage = Stage::Done("Name cannot be empty".into());
                } else {
                    self.stage = Stage::Review(Mutation::Rename(device, name.to_owned()));
                }
                Intent::None
            }
            Stage::Review(mutation) => {
                self.stage = Stage::Password(mutation, Zeroizing::new(String::new()));
                Intent::None
            }
            Stage::Password(mutation, password) => Intent::Request(Job::Commit(mutation, password)),
            _ => Intent::None,
        }
    }
    pub fn frame(&self, size: HostSize, out: &mut Vec<u8>) {
        if let Stage::Help(scroll) = self.stage {
            out.extend_from_slice(crate::ui::BEGIN);
            crate::ui::paint(
                out,
                size,
                (1, 1),
                size.cols,
                " MERKUR / SHORTCUTS",
                crate::ui::Style::Accent,
            );
            let capacity = usize::from(size.rows.saturating_sub(3));
            let start = scroll.min(SHORTCUTS.len().saturating_sub(capacity));
            for (index, text) in SHORTCUTS.iter().skip(start).take(capacity).enumerate() {
                crate::ui::paint(
                    out,
                    size,
                    ((index + 3) as u16, 1),
                    size.cols,
                    text,
                    if matches!(
                        *text,
                        " NAVIGATION"
                            | " ACCOUNT & MACHINE"
                            | " MACHINES SCREEN (no prefix needed)"
                    ) {
                        crate::ui::Style::Heading
                    } else {
                        crate::ui::Style::Body
                    },
                );
            }
            crate::ui::paint(
                out,
                size,
                (size.rows, 1),
                size.cols,
                " Enter / Esc return · ↑/↓ scroll",
                crate::ui::Style::Bar,
            );
            out.extend_from_slice(crate::ui::END);
            return;
        }
        out.extend_from_slice(crate::ui::BEGIN);
        crate::ui::paint(
            out,
            size,
            (1, 1),
            size.cols,
            if self.is_url {
                " MERKUR / OPEN URL"
            } else {
                " MERKUR / ACCOUNT"
            },
            crate::ui::Style::Accent,
        );
        if let Stage::Url(_, request, scroll) = &self.stage {
            line(out, size, 2, &format!("Host: {}", request.host), false);
            let width = usize::from(size.cols.max(1));
            let capacity = usize::from(size.rows.saturating_sub(4));
            let count = request.url.len().div_ceil(width);
            let start = (*scroll).min(count.saturating_sub(capacity));
            for (index, chunk) in request
                .url
                .as_bytes()
                .chunks(width)
                .skip(start)
                .take(capacity)
                .enumerate()
            {
                // The wire and parsed target are ASCII; chunk boundaries are scalar boundaries.
                line(
                    out,
                    size,
                    (index + 4) as u16,
                    std::str::from_utf8(chunk).expect("ASCII URL"),
                    false,
                );
            }
            line(
                out,
                size,
                size.rows,
                "Enter open · d dismiss · ↑/↓ inspect URL · Esc return",
                false,
            );
            out.extend_from_slice(b"\x1b[?2026l\x1b[5n");
            return;
        }
        let lines = match &self.stage {
            Stage::Help(_) => unreachable!("shortcut guide was rendered above"),
            Stage::Url(_, _, _) => unreachable!("URL review was rendered above"),
            Stage::Field(Field::Name(device), value) => vec![
                format!("Rename {}", device.name),
                format!("New name: {}", **value),
                "Enter review · Esc cancel".into(),
            ],
            Stage::Field(Field::Code, value) => vec![
                "Approve a merkur link code".into(),
                format!("Code: {}", "•".repeat(value.chars().count())),
                "Enter inspect · Esc cancel".into(),
            ],
            Stage::Review(mutation) => {
                let mut lines = describe(mutation);
                lines.push("Enter continue to password · Esc cancel".into());
                lines
            }
            Stage::Password(mutation, value) => {
                let mut lines = describe(mutation);
                lines.push(format!("Password: {}", "•".repeat(value.chars().count())));
                lines.push("Enter authorize · Esc cancel".into());
                lines
            }
            Stage::Pending => vec!["Working…".into(), "Esc close screen".into()],
            Stage::Done(message) => vec![message.clone(), "Enter return · Esc close".into()],
            Stage::Sessions(sessions, selection) => {
                line(
                    out,
                    size,
                    2,
                    "Sessions · ↑/↓ select · Enter revoke · Esc cancel",
                    false,
                );
                let capacity = usize::from(size.rows.saturating_sub(4));
                let start = selection.saturating_sub(capacity.saturating_sub(1));
                for (index, session) in sessions
                    .sessions
                    .iter()
                    .enumerate()
                    .skip(start)
                    .take(capacity)
                {
                    line(
                        out,
                        size,
                        (index - start + 4) as u16,
                        &format!(
                            "{} · {}{}",
                            session_label(session),
                            session.delegation_id,
                            if session.revoked_at.is_some() {
                                " · revoked"
                            } else {
                                ""
                            }
                        ),
                        index == *selection,
                    );
                }
                Vec::new()
            }
        };
        if let Some((hint, body)) = lines.split_last() {
            for (index, text) in body.iter().enumerate() {
                crate::ui::paint(
                    out,
                    size,
                    ((index + 4) as u16, 1),
                    size.cols,
                    text,
                    if index == 0 {
                        crate::ui::Style::Heading
                    } else {
                        crate::ui::Style::Body
                    },
                );
            }
            crate::ui::paint(
                out,
                size,
                (size.rows, 1),
                size.cols,
                hint,
                crate::ui::Style::Bar,
            );
        }
        out.extend_from_slice(b"\x1b[?2026l\x1b[5n");
    }
}
const SHORTCUTS: &[&str] = &[
    " Press Ctrl-\\, release it, then",
    " press a command key.",
    "",
    " NAVIGATION",
    " l       Machines",
    " n / p   Next / previous tab",
    " 1–9     Select a tab",
    " f       Fit to this window",
    " ?       This guide",
    " x       Close selected terminal",
    " q       Quit Merkur",
    "",
    " ACCOUNT & MACHINE",
    " a       Approve a link code",
    " r       Rename machine",
    " u       Unlink machine",
    " v       Account sessions",
    " o       Review requested URLs",
    "",
    " MACHINES SCREEN (no prefix needed)",
    " ↑ / ↓   Select a machine",
    " j / k   Select a machine",
    " Enter   Connect",
    " ?       This guide",
    " a/r/u/v Manage the account",
    " q       Quit Merkur",
    "",
    " Press Ctrl-\\ twice to send it",
    " to the remote machine.",
    " Closing a terminal ends its",
    " connection; it stays linked.",
    " Quitting closes this client's",
    " terminal connections.",
];

fn session_label(session: &merkur_client_native::account::management::Session) -> String {
    format!(
        "{} ({}){}",
        session.client.browser.as_deref().unwrap_or("Client"),
        session
            .client
            .platform
            .as_deref()
            .unwrap_or("unknown platform"),
        if session.current {
            " · this client"
        } else {
            ""
        }
    )
}
fn describe(mutation: &Mutation) -> Vec<String> {
    match mutation {
        Mutation::Rename(device, name) => vec![
            format!("Rename {} to {}", device.name, name),
            format!("Machine: {}", device.id),
        ],
        Mutation::Unlink(device) => vec![
            format!("Unlink {} ({})", device.name, device.platform),
            format!("Machine: {}", device.id),
            "This removes the account link. For a box, it also deletes its container.".into(),
        ],
        Mutation::Revoke(target, label) => vec![
            format!("Revoke {label}"),
            format!("Device/session: {}", target.delegation_id),
            "This ends its sessions and removes its ability to connect.".into(),
        ],
        Mutation::Approve(link) => vec![
            format!("Approve {} ({})", link.claim.name, link.claim.platform),
            format!("Identity: {}", link.claim.identity_seal_backend.as_str()),
            format!("Machine: {}", link.claim.daemon_id),
            format!("Claim: {}", link.claim.link_claim_id),
            "The code authenticated this machine's identity.".into(),
        ],
    }
}
pub(super) async fn execute(state: Arc<AccountState>, job: Job) -> Result<Outcome, AccountError> {
    let account = &state.account;
    let credentials = &state.credentials;
    match job {
        Job::Inspect(code) => account
            .authorized(credentials, |token| {
                let code = code.clone();
                async move { account.inspect_link(&token, code).await }
            })
            .await
            .map(|link| Outcome::Link(Box::new(link))),
        Job::Sessions => account
            .authorized(credentials, |token| async move {
                account.sessions(&token).await
            })
            .await
            .map(Outcome::Sessions),
        Job::Commit(mutation, password) => {
            let root = account
                .unlock_root(&state.username, password, &state.delegation)
                .await?;
            match mutation {
                Mutation::Approve(link) => {
                    account
                        .approve_link(credentials, *link, root, &mut OsEntropy)
                        .await?
                }
                Mutation::Rename(device, name) => {
                    drop(root);
                    account
                        .authorized(credentials, |token| {
                            let device = &device;
                            let name = &name;
                            async move { account.rename(&token, &device.id, name).await }
                        })
                        .await?;
                }
                Mutation::Unlink(device) => {
                    drop(root);
                    account
                        .authorized(credentials, |token| {
                            let device = &device;
                            async move { account.unlink(&token, &device.id).await }
                        })
                        .await?;
                }
                Mutation::Revoke(target, _) => {
                    drop(root);
                    let sessions = account
                        .authorized(credentials, |token| async move {
                            account.sessions(&token).await
                        })
                        .await?;
                    if !sessions.sessions.iter().any(|session| {
                        session.delegation_id == target.delegation_id
                            && session.expires_at == target.expires_at
                            && session.revoked_at.is_none()
                    }) {
                        return Err(AccountError::Invalid("reviewed session no longer exists"));
                    }
                    // A hardware delegate signs for milliseconds: off this reactor.
                    let (delegation, delegate, targets) = (
                        Arc::clone(&state.delegation),
                        Arc::clone(&state.delegate),
                        vec![target.clone()],
                    );
                    let issued_at = sessions.server_time_ms;
                    let statement = tokio::task::spawn_blocking(move || {
                        Revocation::create(
                            &delegation,
                            &*delegate,
                            targets,
                            issued_at,
                            &mut OsEntropy,
                        )
                    })
                    .await
                    .map_err(|_| AccountError::Invalid("revocation signer"))??;
                    account
                        .authorized(credentials, |token| {
                            let statement = &statement;
                            let target = &target;
                            async move {
                                account
                                    .revoke(&token, &target.delegation_id, statement)
                                    .await
                            }
                        })
                        .await?;
                }
            }
            Ok(Outcome::Done)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_client_native::account::devices::{IdentityBackend, Status};
    use merkur_wire::input_record::build;
    fn enter() -> HostEvent {
        HostEvent::Record(build::functional(keys::ENTER, 0, 0))
    }
    #[test]
    fn shortcut_guide_scrolls_on_a_small_host_and_closes_without_an_operation() {
        let mut dialog = Dialog::help(Some(7));
        let small = HostSize {
            cols: 40,
            rows: 8,
            cell: None,
        };
        for _ in 0..18 {
            assert!(matches!(
                dialog.input(&HostEvent::Record(build::functional(
                    crate::host_input::functional::DOWN,
                    0,
                    0
                ))),
                Intent::None
            ));
        }
        let mut frame = Vec::new();
        dialog.frame(small, &mut frame);
        let screen = crate::ui::tests::screen(small, &frame);
        assert!(screen.last().unwrap().contains("Esc return"));
        assert!(screen.iter().any(|row| row.contains("MACHINES SCREEN")));
        assert!(matches!(dialog.input(&enter()), Intent::Close));
        assert_eq!(dialog.previous, Some(7));
        frame.clear();
        dialog = Dialog::help(None);
        let wide = HostSize {
            cols: 80,
            rows: 24,
            cell: None,
        };
        dialog.frame(wide, &mut frame);
        crate::ui::tests::preview("shortcuts", &frame);
    }
    #[test]
    fn unlink_requires_review_then_password_and_never_paints_the_secret() {
        let device = Device {
            id: "machine".into(),
            user_id: "user".into(),
            name: "box".into(),
            platform: "linux".into(),
            last_seen: None,
            status: Status::Online,
            version: None,
            identity_seal_backend: IdentityBackend::Software,
        };
        let mut dialog = Dialog::unlink(device, Some(1));
        assert!(matches!(dialog.input(&enter()), Intent::None));
        assert!(matches!(dialog.stage, Stage::Password(_, _)));
        dialog.input(&HostEvent::Record(build::paste("sensitive界")));
        let mut frame = Vec::new();
        dialog.frame(
            HostSize {
                cols: 100,
                rows: 24,
                cell: None,
            },
            &mut frame,
        );
        assert!(
            !frame
                .windows(b"sensitive".len())
                .any(|bytes| bytes == b"sensitive")
        );
        assert!(
            matches!(dialog.input(&enter()), Intent::Request(Job::Commit(Mutation::Unlink(_), password)) if password.as_str() == "sensitive界")
        );
        assert!(matches!(dialog.stage, Stage::Pending));
    }
    #[test]
    fn link_codes_are_masked_and_enter_only_requests_inspection() {
        let mut dialog = Dialog::link(None);
        dialog.input(&HostEvent::Record(build::paste("code-with-secret")));
        assert!(
            matches!(dialog.input(&enter()), Intent::Request(Job::Inspect(code)) if code.as_str() == "code-with-secret")
        );
        assert!(matches!(dialog.input(&enter()), Intent::None));
    }
    #[test]
    fn a_url_review_requires_enter_press_and_shows_its_actual_host() {
        let mut requests = open_url::Requests::default();
        let id = OpenUrlId { epoch: 7, seq: 1 };
        assert_eq!(
            requests.accept(id, "https://trusted.example@real.example/path".into()),
            Some(true)
        );
        let mut dialog = Dialog::url(4, requests.first().unwrap(), Some(4));
        assert!(matches!(
            dialog.input(&HostEvent::Record(build::paste("\n"))),
            Intent::None
        ));
        assert!(matches!(
            dialog.input(&HostEvent::Record(build::functional(keys::ENTER, 2, 0))),
            Intent::None
        ));
        let mut frame = Vec::new();
        dialog.frame(
            HostSize {
                cols: 80,
                rows: 24,
                cell: None,
            },
            &mut frame,
        );
        let frame = std::str::from_utf8(&frame).unwrap();
        assert!(frame.contains("Host: real.example"));
        assert!(frame.contains("https://trusted.example@real.example/path"));
        assert!(matches!(dialog.input(&enter()), Intent::OpenUrl(4, request) if request.id == id));
        assert!(matches!(dialog.input(&enter()), Intent::None));
    }
    #[test]
    fn closing_a_url_review_defers_and_dismissing_names_the_exact_request() {
        let mut requests = open_url::Requests::default();
        let id = OpenUrlId { epoch: 7, seq: 2 };
        requests.accept(id, "https://example.com/".into());
        let mut dialog = Dialog::url(8, requests.first().unwrap(), Some(8));
        assert!(matches!(
            dialog.input(&HostEvent::Record(build::functional(
                crate::host_input::functional::ESCAPE,
                0,
                0
            ))),
            Intent::Close
        ));
        assert_eq!(requests.len(), 1);
        assert!(
            matches!(dialog.input(&HostEvent::Record(build::press('d'))), Intent::DismissUrl(8, got) if got == id)
        );
    }
}
