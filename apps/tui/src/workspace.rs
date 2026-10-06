//! Live account workspace. Only its selected tab presents frames; every
//! transport remains independent of host writes and of the other tabs.

use std::{io, sync::Arc, thread};

use merkur_client::{
    auth::Delegation,
    session::{Config, Session, geometry::GeometryStatus},
    uuid_v4,
};
use merkur_client_native::{
    account::{
        Account, AccountError, Credentials,
        devices::{self, Device, List},
    },
    driver::{self, Command, OsEntropy, Output},
    issuer::AccountIssuer,
};
use merkur_wire::input_record::{InputRecord, KeyEvent, build, decode, keys, mods};

mod management;
mod open_url;
mod prefix;
mod terminal_ui;
use management::{Dialog, Intent, Job, Outcome};
use prefix::{Prefix, Route};
use tokio::{sync::mpsc, time::Instant};
use zeroize::Zeroize;

use crate::{
    account_store::Store,
    chrome::Chrome,
    host::{Host, HostRead, HostSize},
    host_input::{HostEvent, HostInput},
    interactive::{now, reply, wake},
    session_view::{HostFrames, SessionView},
};

pub struct AccountState {
    pub account: Arc<Account>,
    pub credentials: Arc<Credentials>,
    pub delegation: Arc<Delegation>,
    /// The delegation's key, in its custody: it signs every session proof and
    /// revocation, off the transport reactor.
    pub delegate: Arc<dyn merkur_identity_seal::KeyCustody>,
    pub store: Arc<Store>,
    pub username: String,
    pub edge_port: Option<u16>,
    pub relay_only: bool,
}

pub(crate) enum Exit {
    Quit(u8),
    Revoked(HostSize),
}

#[derive(Debug, PartialEq, Eq)]
enum MessageEffect {
    Quiet,
    Changed,
    Revoked,
}

enum Message {
    Output(u64, Output),
    Delivery(u64, driver::Delivery),
    Ended(u64, bool),
    Machines(Vec<Device>, bool, String),
    Revoked,
    Failed(&'static str),
    Management(u64, Result<Outcome, String>),
    Opened(
        u64,
        u64,
        merkur_wire::protocol::OpenUrlId,
        Result<(), String>,
    ),
}

/// Also publishes retirement when a reactor unwinds before normal shutdown.
struct DriverLifetime(u64, mpsc::UnboundedSender<Message>);
impl Drop for DriverLifetime {
    fn drop(&mut self) {
        let _ = self.1.send(Message::Ended(self.0, thread::panicking()));
    }
}

struct OperationLifetime(mpsc::UnboundedSender<Message>, &'static str);
impl Drop for OperationLifetime {
    fn drop(&mut self) {
        if thread::panicking() {
            let _ = self.0.send(Message::Failed(self.1));
        }
    }
}

struct Tab {
    id: u64,
    machine: String,
    view: SessionView,
    commands: Option<driver::Commands>,
    driver: Option<thread::JoinHandle<()>>,
    status: String,
    path: String,
    rtt_ms: Option<u64>,
    /// Who holds the machine's terminal size, once the daemon has stated it.
    geometry: Option<GeometryStatus>,
    urls: open_url::Requests,
}
impl Tab {
    fn send(&mut self, command: Command) {
        if let Some(commands) = &self.commands
            && commands.send(command).is_err()
        {
            // The driver can finish between its last output and our command.
            // Its lifetime guard still delivers Ended; a closed tab cannot
            // take the account or other live sessions down with it.
            self.commands = None;
            self.view.disconnected();
            self.status = "Closed".into();
        }
    }
    fn focus(&mut self, at: f64, focused: bool) -> io::Result<()> {
        if self
            .commands
            .as_ref()
            .is_none_or(|sender| sender.is_closed())
        {
            return Ok(());
        }
        let mut commands = Vec::new();
        self.view
            .input(at, HostEvent::Record(build::focus(focused)), &mut commands)?;
        for command in commands {
            self.send(command);
        }
        if focused {
            self.view.invalidate();
        }
        Ok(())
    }
}

struct Workspace {
    tabs: Vec<Tab>,
    selected: Option<u64>,
    focused: bool,
    orb_frame: usize,
    machines: Vec<Device>,
    machine_selection: Option<String>,
    list_live: bool,
    list_status: String,
    next_id: u64,
    retired: Vec<thread::JoinHandle<()>>,
    jobs: Vec<tokio::task::JoinHandle<()>>,
    openers: Vec<tokio::task::JoinHandle<()>>,
    dialog: Option<Dialog>,
    next_request: u64,
    graphics_cleanup: Vec<u8>,
    terminal_ui: terminal_ui::Effects,
}
impl Default for Workspace {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            selected: None,
            focused: true,
            orb_frame: 0,
            machines: Vec::new(),
            machine_selection: None,
            list_live: false,
            list_status: "Loading machines…".into(),
            next_id: 1,
            retired: Vec::new(),
            jobs: Vec::new(),
            openers: Vec::new(),
            dialog: None,
            next_request: 1,
            graphics_cleanup: Vec::new(),
            terminal_ui: terminal_ui::Effects::default(),
        }
    }
}
impl Workspace {
    fn active(&mut self) -> Option<&mut Tab> {
        let id = self.selected?;
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }
    fn select(&mut self, at: f64, id: Option<u64>) -> io::Result<()> {
        if self.selected == id {
            return Ok(());
        }
        if let Some(tab) = self.active() {
            tab.view.set_visible(at, false);
            tab.focus(at, false)?;
        }
        self.selected = id;
        let focused = self.focused;
        if let Some(tab) = self.active() {
            tab.view.set_visible(at, true);
            tab.focus(at, focused)?;
        }
        Ok(())
    }
    fn close(&mut self, at: f64) -> io::Result<()> {
        let Some(id) = self.selected else {
            return Ok(());
        };
        let Some(at_tab) = self.tabs.iter().position(|tab| tab.id == id) else {
            return Ok(());
        };
        self.select(at, None)?;
        let mut tab = self.tabs.remove(at_tab);
        tab.view.destroy_graphics(&mut self.graphics_cleanup);
        drop(tab.commands.take());
        if let Some(driver) = tab.driver.take() {
            self.retired.push(driver);
        }
        let next = self
            .tabs
            .get(at_tab)
            .or_else(|| self.tabs.last())
            .map(|tab| tab.id);
        self.select(at, next)
    }
    fn open(
        &mut self,
        machine: String,
        size: HostSize,
        at: f64,
        state: &AccountState,
        messages: &mpsc::UnboundedSender<Message>,
    ) -> io::Result<()> {
        if let Some(tab) = self.tabs.iter().find(|tab| {
            tab.machine == machine
                && tab
                    .commands
                    .as_ref()
                    .is_some_and(|sender| !sender.is_closed())
        }) {
            return self.select(at, Some(tab.id));
        }
        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or_else(|| io::Error::other("session tab namespace exhausted"))?;
        let session = Session::new(
            Config {
                browser_node_id: uuid_v4(&mut OsEntropy),
                relay_only: state.relay_only,
            },
            Arc::clone(&state.delegation),
        );
        let (commands, incoming) = driver::Commands::channel();
        let account = Arc::clone(&state.account);
        let credentials = Arc::clone(&state.credentials);
        let delegate: Arc<dyn merkur_authorization::MlDsa87Signer> = state.delegate.clone();
        let edge_port = state.edge_port;
        let name = machine.clone();
        let messages = messages.clone();
        let driver = thread::Builder::new()
            .name(format!("merkur-transport-{id}"))
            .spawn(move || {
                let _lifetime = DriverLifetime(id, messages.clone());
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("transport reactor");
                runtime.block_on(async move {
                    let (outputs, mut output) = driver::Outputs::channel();
                    let forwarded = messages.clone();
                    let forwarding = tokio::spawn(async move {
                        while let Some(output) = output.recv().await {
                            if forwarded.send(Message::Delivery(id, output)).is_err() {
                                break;
                            }
                        }
                    });
                    driver::run(
                        session,
                        &name,
                        Arc::new(AccountIssuer {
                            account,
                            credentials,
                        }),
                        delegate,
                        edge_port,
                        incoming,
                        outputs,
                    )
                    .await;
                    let _ = forwarding.await;
                });
            })?;
        let mut tab = Tab {
            id,
            machine,
            view: SessionView::new(size, 1),
            commands: Some(commands),
            driver: Some(driver),
            status: "Connecting".into(),
            path: String::new(),
            rtt_ms: None,
            geometry: None,
            urls: open_url::Requests::default(),
        };
        if let Some(command) = tab.view.viewport() {
            tab.send(command);
        }
        self.publish_tab(at, tab)
    }
    fn publish_tab(&mut self, at: f64, tab: Tab) -> io::Result<()> {
        let id = tab.id;
        // Publish a replacement only after its reactor started. A fresh identity
        // fences late output from the retired session out of the new tab.
        if let Some(index) = self.tabs.iter().position(|old| old.machine == tab.machine) {
            if self.selected == Some(self.tabs[index].id) {
                self.select(at, None)?;
            }
            let mut old = std::mem::replace(&mut self.tabs[index], tab);
            old.view.destroy_graphics(&mut self.graphics_cleanup);
            drop(old.commands.take());
            if let Some(driver) = old.driver.take() {
                self.retired.push(driver);
            }
        } else {
            self.tabs.push(tab);
        }
        self.select(at, Some(id))
    }
    fn manage(
        &mut self,
        at: f64,
        action: char,
        state: &Arc<AccountState>,
        messages: &mpsc::UnboundedSender<Message>,
    ) -> io::Result<()> {
        let previous = self.selected;
        let machine = self
            .active()
            .map(|tab| tab.machine.clone())
            .or_else(|| self.machine_selection.clone());
        let device =
            machine.and_then(|id| self.machines.iter().find(|device| device.id == id).cloned());
        let dialog = match action {
            'a' => Dialog::link(previous),
            'v' => Dialog::sessions(previous),
            'r' if self.list_live => match device {
                Some(device) => Dialog::rename(device, previous),
                None => return Ok(()),
            },
            'u' if self.list_live => match device {
                Some(device) => Dialog::unlink(device, previous),
                None => return Ok(()),
            },
            _ => return Ok(()),
        };
        self.select(at, None)?;
        self.dialog = Some(dialog);
        if action == 'v' {
            self.job(Job::Sessions, state, messages)?;
        }
        Ok(())
    }
    /// Takes the machine's terminal size for this host's viewport, whoever
    /// holds it.
    fn fit(&mut self) {
        if let Some(tab) = self.active() {
            tab.send(Command::TakeGeometry);
        }
    }
    fn show_help(&mut self, at: f64) {
        let previous = self.selected;
        // A read-only overlay owns local input, while the focused terminal
        // retains its viewport. Hiding its pixels must not hand off geometry.
        if let Some(tab) = self.active() {
            tab.view.set_visible(at, false);
        }
        self.dialog = Some(Dialog::help(previous));
    }
    fn review_url(&mut self, at: f64) -> io::Result<()> {
        let previous = self.selected;
        let Some(tab) = self.active() else {
            return Ok(());
        };
        let Some(request) = tab.urls.first() else {
            return Ok(());
        };
        let dialog = Dialog::url(tab.id, request, previous);
        self.select(at, None)?;
        self.dialog = Some(dialog);
        Ok(())
    }
    fn open_url(
        &mut self,
        tab_id: u64,
        url: open_url::Request,
        messages: &mpsc::UnboundedSender<Message>,
    ) -> io::Result<()> {
        let request = self.next_request;
        self.next_request = request
            .checked_add(1)
            .ok_or_else(|| io::Error::other("operation namespace exhausted"))?;
        if !self
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .is_some_and(|tab| tab.urls.start(url.id))
        {
            if let Some(dialog) = &mut self.dialog {
                dialog.opened(Err("Request already opening or no longer retained".into()));
            }
            return Ok(());
        }
        if let Some(dialog) = &mut self.dialog {
            dialog.pending(request);
        }
        let messages = messages.clone();
        self.openers.push(tokio::spawn(async move {
            let _lifetime = OperationLifetime(messages.clone(), "URL opener task panicked");
            let result = open_url::open(&url)
                .await
                .map_err(|error| format!("Could not open URL: {error}"));
            let _ = messages.send(Message::Opened(request, tab_id, url.id, result));
        }));
        Ok(())
    }
    fn dismiss_url(
        &mut self,
        at: f64,
        tab_id: u64,
        id: merkur_wire::protocol::OpenUrlId,
    ) -> io::Result<()> {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.urls.remove(id);
        }
        self.close_dialog(at)
    }
    fn job(
        &mut self,
        job: Job,
        state: &Arc<AccountState>,
        messages: &mpsc::UnboundedSender<Message>,
    ) -> io::Result<()> {
        let request = self.next_request;
        self.next_request = request
            .checked_add(1)
            .ok_or_else(|| io::Error::other("account operation namespace exhausted"))?;
        if let Some(dialog) = &mut self.dialog {
            dialog.pending(request);
        }
        let state = Arc::clone(state);
        let messages = messages.clone();
        self.jobs.push(tokio::task::spawn_blocking(move || {
            let _lifetime = OperationLifetime(messages.clone(), "account operation panicked");
            let result = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime
                    .block_on(management::execute(state, job))
                    .map_err(|error| match error {
                        AccountError::WrongCredentials => {
                            "Password incorrect · Enter return and try again".into()
                        }
                        error => format!("Operation failed: {error:?}"),
                    }),
                Err(error) => Err(error.to_string()),
            };
            let _ = messages.send(Message::Management(request, result));
        }));
        Ok(())
    }
    fn close_dialog(&mut self, at: f64) -> io::Result<()> {
        if let Some(dialog) = self.dialog.take() {
            if dialog.is_help() {
                if let Some(tab) = self.active() {
                    tab.view.set_visible(at, true);
                    tab.view.invalidate();
                }
                return Ok(());
            }
            let previous = dialog
                .previous
                .filter(|id| self.tabs.iter().any(|tab| tab.id == *id));
            self.select(at, previous)?;
        }
        Ok(())
    }
    fn resolve_machine(&self, name: &str) -> io::Result<String> {
        if let Some(machine) = self.machines.iter().find(|machine| machine.id == name) {
            return Ok(machine.id.clone());
        }
        let mut matches = self.machines.iter().filter(|machine| machine.name == name);
        let first = matches
            .next()
            .ok_or_else(|| io::Error::other(format!("No machine named {name}")))?;
        if matches.next().is_some() {
            return Err(io::Error::other(format!(
                "Machine name {name} is ambiguous; use its ID"
            )));
        }
        Ok(first.id.clone())
    }
    fn move_machine(&mut self, direction: i32) {
        if self.machines.is_empty() {
            self.machine_selection = None;
            return;
        }
        let current = self
            .machines
            .iter()
            .position(|machine| Some(&machine.id) == self.machine_selection.as_ref())
            .unwrap_or(0);
        let index =
            (current as i64 + i64::from(direction)).rem_euclid(self.machines.len() as i64) as usize;
        self.machine_selection = Some(self.machines[index].id.clone());
    }
    fn flush(&mut self, at: f64) {
        for tab in &mut self.tabs {
            while let Some(command) = tab.view.poll_command(at) {
                if tab.commands.is_some() {
                    tab.send(command);
                }
            }
        }
    }
    async fn reap(&mut self) -> io::Result<()> {
        let mut index = 0;
        while index < self.jobs.len() {
            if self.jobs[index].is_finished() {
                self.jobs
                    .swap_remove(index)
                    .await
                    .map_err(io::Error::other)?;
            } else {
                index += 1;
            }
        }
        let mut index = 0;
        while index < self.openers.len() {
            if self.openers[index].is_finished() {
                self.openers
                    .swap_remove(index)
                    .await
                    .map_err(io::Error::other)?;
            } else {
                index += 1;
            }
        }
        let mut index = 0;
        while index < self.retired.len() {
            if self.retired[index].is_finished() {
                // Its lifetime guard already reported a panic to the tab.
                let _ = self.retired.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        Ok(())
    }
    fn message(&mut self, at: f64, message: Message) -> io::Result<MessageEffect> {
        let mut changed = false;
        match message {
            Message::Opened(request, tab_id, id, result) => {
                if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
                    tab.urls.finish(id, result.is_ok());
                    changed = self.selected == Some(tab_id);
                }
                if let Some(dialog) = &mut self.dialog
                    && dialog.request == request
                {
                    dialog.opened(result);
                    changed = true;
                }
            }
            Message::Management(request, result) => {
                if let Some(dialog) = &mut self.dialog
                    && dialog.request == request
                {
                    dialog.receive(result);
                    changed = true;
                }
            }
            Message::Machines(devices, live, status) => {
                changed = true;
                self.machines = devices;
                self.list_live = live;
                self.list_status = status;
                if !self
                    .machines
                    .iter()
                    .any(|machine| Some(&machine.id) == self.machine_selection.as_ref())
                {
                    self.machine_selection =
                        self.machines.first().map(|machine| machine.id.clone());
                }
            }
            Message::Revoked => return Ok(MessageEffect::Revoked),
            Message::Failed(reason) => return Err(io::Error::other(reason)),
            Message::Ended(id, panicked) => {
                if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) {
                    tab.commands = None;
                    tab.view.disconnected();
                    tab.geometry = None;
                    if let Some(driver) = tab.driver.take() {
                        self.retired.push(driver);
                    }
                    tab.status = if panicked {
                        "Transport failed"
                    } else {
                        "Closed"
                    }
                    .into();
                    changed = self.selected.is_none() || self.selected == Some(id);
                }
                // The global panic hook restored the host. Finish shutdown even
                // if the failed reactor belonged to an already closed tab.
                if panicked {
                    return Err(io::Error::other("transport reactor panicked"));
                }
            }
            Message::Delivery(id, delivery) => {
                let (output, _lease) = delivery.into_parts();
                return self.message(at, Message::Output(id, output));
            }
            Message::Output(id, output) => {
                if let Some(tab) = self
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.id == id && tab.commands.is_some())
                {
                    if let Output::TerminalUi(effect) = output {
                        if tab
                            .commands
                            .as_ref()
                            .is_none_or(|sender| sender.is_closed())
                        {
                            return Ok(MessageEffect::Quiet);
                        }
                        let visible = self.dialog.is_none() && self.selected == Some(id);
                        if let merkur_wire::terminal_ui::TerminalUi::Title(title) = effect {
                            tab.view.set_title(title);
                            return Ok(if visible {
                                MessageEffect::Changed
                            } else {
                                MessageEffect::Quiet
                            });
                        }
                        let clipboard = matches!(
                            effect,
                            merkur_wire::terminal_ui::TerminalUi::Clipboard { .. }
                        );
                        let accepted = (!clipboard || (visible && self.focused))
                            && self.terminal_ui.accept(id, effect);
                        return Ok(if accepted {
                            MessageEffect::Changed
                        } else {
                            MessageEffect::Quiet
                        });
                    }
                    if let Output::GraphicsClock { rtt_ms, .. } = &output {
                        changed |= tab.rtt_ms != Some(*rtt_ms);
                        tab.rtt_ms = Some(*rtt_ms);
                    }
                    let output = if let Output::GraphicsAsset {
                        epoch,
                        key,
                        asset,
                        bytes,
                    } = output
                    {
                        tab.view.graphics_asset(at, epoch, key, asset, bytes)?;
                        None
                    } else {
                        tab.view.receive(at, output)
                    };
                    if let Some(output) = output {
                        match output {
                            Output::OpenUrl { id, url } => {
                                if let Some(added) = tab.urls.accept(id, url) {
                                    tab.send(Command::OpenUrlAcknowledged(id));
                                    changed |= added;
                                }
                            }
                            Output::Status(status) => {
                                let next = format!("{status:?}");
                                changed |= tab.status != next;
                                tab.status = next;
                            }
                            Output::Path(path) => {
                                let next = format!("{path:?}");
                                changed |= tab.path != next;
                                tab.path = next;
                            }
                            Output::IssuanceRefused(error) => {
                                let next = format!("{error:?}");
                                changed |= tab.status != next;
                                tab.status = next;
                            }
                            Output::GeometryState(status) => {
                                changed |= tab.geometry != Some(status);
                                tab.geometry = Some(status);
                                if status != GeometryStatus::Owner {
                                    tab.send(Command::SnapshotRequest)
                                }
                            }
                            _ => {}
                        }
                    }
                    tab.view.drained(at);
                    changed &= self.selected.is_none() || self.selected == Some(id);
                }
            }
        }
        Ok(if changed {
            MessageEffect::Changed
        } else {
            MessageEffect::Quiet
        })
    }
    fn frame(
        &mut self,
        size: HostSize,
        at: f64,
        prefix: bool,
        chrome: &mut Chrome,
        out: &mut Vec<u8>,
    ) -> io::Result<()> {
        out.extend_from_slice(b"\x1b[?2026h");
        out.append(&mut self.graphics_cleanup);
        let active = self.tabs.iter().find(|tab| self.selected == Some(tab.id));
        let title = if self.dialog.is_none() {
            active
                .filter(|tab| {
                    tab.commands
                        .as_ref()
                        .is_some_and(|sender| !sender.is_closed())
                })
                .map(|tab| tab.view.title())
                .unwrap_or("merkur")
        } else {
            "merkur"
        };
        let clipboard_tab = if self.focused && self.dialog.is_none() {
            active
                .filter(|tab| {
                    tab.commands
                        .as_ref()
                        .is_some_and(|sender| !sender.is_closed())
                })
                .map(|tab| tab.id)
        } else {
            None
        };
        self.terminal_ui.frame(title, clipboard_tab, out);
        for tab in &mut self.tabs {
            if self.dialog.is_some() || self.selected != Some(tab.id) {
                tab.view.hide_graphics(out);
            }
        }
        if let Some(dialog) = &self.dialog {
            chrome.present(size, |screen| dialog.frame(size, screen), out);
            return Ok(());
        }
        let footer = self.footer(size, prefix);
        if !self.tabs.iter().any(|tab| self.selected == Some(tab.id)) {
            chrome.present(
                size,
                |screen| {
                    self.machine_frame(size, screen);
                    crate::ui::paint(
                        screen,
                        size,
                        (size.rows, 1),
                        size.cols,
                        &footer,
                        crate::ui::Style::Bar,
                    );
                    screen.extend_from_slice(crate::ui::END);
                },
                out,
            );
            return Ok(());
        }
        chrome.invalidate();
        if let Some(tab) = self.active() {
            tab.view.frame(at, out)?;
            let end = b"\x1b[?2026l\x1b[5n";
            if out.ends_with(end) {
                out.truncate(out.len() - end.len());
            }
        }
        crate::ui::paint(
            out,
            size,
            (size.rows, 1),
            size.cols,
            &footer,
            crate::ui::Style::Bar,
        );
        if let Some(tab) = self.active()
            && let Some(cursor) = tab.view.viewer().grid().terminal().displayed_cursor()
            && cursor.row < size.rows.saturating_sub(1)
            && cursor.col < size.cols
        {
            out.extend_from_slice(
                format!("\x1b[{};{}H", cursor.row + 1, cursor.col + 1).as_bytes(),
            );
        }
        out.extend_from_slice(b"\x1b[?2026l\x1b[5n");
        Ok(())
    }

    fn footer(&self, size: HostSize, prefix: bool) -> String {
        if prefix {
            " PREFIX │ ? help · l machines · n/p tabs · f fit · x close · q quit".into()
        } else if self.selected.is_none() {
            " ? help │ ↑/↓ select · Enter connect · q quit".into()
        } else {
            let index = self
                .tabs
                .iter()
                .position(|tab| Some(tab.id) == self.selected)
                .unwrap_or(0);
            let tab = &self.tabs[index];
            let name = self
                .machines
                .iter()
                .find(|machine| machine.id == tab.machine)
                .map(|machine| machine.name.as_str())
                .unwrap_or(&tab.machine);
            let status = crate::ui::clip(&tab.status, size.cols / 4);
            let name = crate::ui::clip(name, size.cols / 4);
            format!(
                " Ctrl-\\ ? help │ {status} │ {}/{} {name} │ {}{}{}{}",
                index + 1,
                self.tabs.len(),
                tab.path,
                tab.rtt_ms
                    .map(|rtt| format!(" · {rtt} ms"))
                    .unwrap_or_default(),
                // Another client holds the machine's size: this host shows its
                // screen cropped until it takes the size back.
                if tab
                    .geometry
                    .is_some_and(|status| status != GeometryStatus::Owner)
                {
                    " │ Ctrl-\\ f fit"
                } else {
                    ""
                },
                if tab.urls.len() == 0 {
                    String::new()
                } else {
                    format!(" │ {} URLs · Ctrl-\\ o", tab.urls.len())
                }
            )
        }
    }
    fn orb_placement(&self, size: HostSize) -> Option<((u16, u16), crate::ui::OrbSize)> {
        if self.selected.is_some() || self.dialog.is_some() {
            return None;
        }
        machine_hero(size).map(|(art, _, col)| ((2, col), art))
    }

    fn machine_frame(&self, size: HostSize, out: &mut Vec<u8>) {
        use crate::ui::{self, Style};
        out.extend_from_slice(ui::BEGIN);
        // The mark has rows of its own above the heading: no text shares a row
        // with it. Short hosts keep the list's capacity.
        let hero = machine_hero(size);
        let heading = hero.map_or(1, |(_, first, _)| first - 4);
        ui::paint(
            out,
            size,
            (heading, 1),
            size.cols,
            " MERKUR / MACHINES",
            Style::Accent,
        );
        let online = self
            .machines
            .iter()
            .filter(|device| device.status == devices::Status::Online)
            .count();
        let summary = format!(
            " {} machine{} · {online} online · {} tab{} · {}",
            self.machines.len(),
            if self.machines.len() == 1 { "" } else { "s" },
            self.tabs.len(),
            if self.tabs.len() == 1 { "" } else { "s" },
            self.list_status
        );
        ui::paint(
            out,
            size,
            (heading + 1, 1),
            size.cols,
            &summary,
            Style::Meta,
        );
        if let Some((art, _, col)) = hero {
            ui::orb(out, size, (2, col), art, self.orb_frame, None);
        }
        let details = size.rows >= 12;
        let first = hero.map_or(if details { 5u16 } else { 4u16 }, |(_, first, _)| first);
        let reserved = if details { 3u16 } else { 1u16 };
        let capacity = usize::from(size.rows.saturating_sub(first + reserved - 1));
        if self.machines.is_empty() {
            let message = if self.list_live {
                " No machines linked yet."
            } else {
                " Waiting for your machine list…"
            };
            ui::paint(out, size, (first, 1), size.cols, message, Style::Heading);
            if self.list_live {
                for (row, text) in [
                    (first + 2, " Add a machine from Merkur in your browser."),
                    (
                        first + 3,
                        " Run its link command on the machine you want to reach.",
                    ),
                    (
                        first + 5,
                        " Already have a link code? Press a to approve it.",
                    ),
                ] {
                    ui::paint(out, size, (row, 1), size.cols, text, Style::Meta);
                }
            }
        } else {
            let header = if size.cols >= 72 {
                format!(
                    "   {:<11}{:<width$} SESSION",
                    "STATE",
                    "MACHINE",
                    width = usize::from(size.cols - 40)
                )
            } else {
                "   STATE      MACHINE".into()
            };
            ui::paint(out, size, (first - 1, 1), size.cols, &header, Style::Meta);
            let selected = self
                .machines
                .iter()
                .position(|machine| Some(&machine.id) == self.machine_selection.as_ref())
                .unwrap_or(0);
            let start = selected.saturating_sub(capacity.saturating_sub(1));
            for (index, machine) in self.machines.iter().enumerate().skip(start).take(capacity) {
                let status = match machine.status {
                    devices::Status::Online => "Online",
                    devices::Status::Degraded => "Degraded",
                    devices::Status::Offline => "Offline",
                };
                let session = self
                    .tabs
                    .iter()
                    .enumerate()
                    .find(|(_, tab)| tab.machine == machine.id);
                let name = if size.cols >= 72 {
                    let width = size.cols - 40;
                    let clipped = ui::clip(&machine.name, width);
                    format!(
                        "{clipped}{}",
                        " ".repeat(usize::from(width) - ui::columns(&clipped))
                    )
                } else {
                    machine.name.clone()
                };
                let connection = if size.cols >= 72 {
                    session
                        .map(|(index, tab)| format!(" Tab {} · {}", index + 1, tab.status))
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let text = format!(
                    " {} ● {status:<9}{name}{connection}",
                    if index == selected { '›' } else { ' ' },
                );
                let row = first + (index - start) as u16;
                line(out, size, row, &text, index == selected);
                ui::state(out, size, (row, 4), status, index == selected);
            }
            if details {
                let machine = &self.machines[selected];
                let connected = self
                    .tabs
                    .iter()
                    .enumerate()
                    .find(|(_, tab)| tab.machine == machine.id)
                    .map(|(index, tab)| {
                        format!(
                            " · Tab {} · {} · {}{}",
                            index + 1,
                            tab.status,
                            tab.path,
                            tab.rtt_ms
                                .map(|rtt| format!(" · {rtt} ms"))
                                .unwrap_or_default()
                        )
                    })
                    .unwrap_or_default();
                let detail = format!(" {} · {}{connected}", machine.platform, machine.id);
                ui::paint(
                    out,
                    size,
                    (size.rows - 2, 1),
                    size.cols,
                    &detail,
                    Style::Meta,
                );
            }
        }
        if details {
            ui::paint(
                out,
                size,
                (size.rows - 1, 1),
                size.cols,
                " a approve · r rename · u unlink · v account sessions",
                Style::Meta,
            );
        }
    }
}

/// The mark's size, the list's first row, and the mark's column. The mark
/// takes rows 2 to 7; the heading, the summary and the list's header follow.
fn machine_hero(size: HostSize) -> Option<(crate::ui::OrbSize, u16, u16)> {
    use crate::ui;
    if size.cols >= 48 && size.rows >= 20 {
        Some((ui::OrbSize::Small, 13, 2))
    } else {
        None
    }
}

/// Local chrome always resets its pen before returning to remote presentation.
fn line(out: &mut Vec<u8>, size: HostSize, row: u16, text: &str, selected: bool) {
    crate::ui::paint(
        out,
        size,
        (row, 1),
        size.cols,
        text,
        if selected {
            crate::ui::Style::Selected
        } else {
            crate::ui::Style::Body
        },
    );
}

async fn machines(state: Arc<AccountState>, messages: mpsc::UnboundedSender<Message>) {
    let _lifetime = OperationLifetime(messages.clone(), "device subscription panicked");
    let mut list = List::default();
    let mut failures = 0u32;
    loop {
        let mut stream = match state
            .account
            .devices(&state.credentials, list.cursor.as_ref())
            .await
        {
            Ok(stream) => stream,
            Err(error) => {
                if matches!(error, AccountError::Refused { status: 401, .. }) {
                    let _ = messages.send(Message::Revoked);
                    return;
                }
                if messages
                    .send(Message::Machines(
                        list.devices.clone(),
                        false,
                        format!("Reconnecting · {error:?}"),
                    ))
                    .is_err()
                {
                    return;
                }
                failures = failures.saturating_add(1);
                reconnect(failures).await;
                continue;
            }
        };
        loop {
            match stream.next().await {
                Ok(Some(devices::Event::SessionEnded)) => {
                    let _ = messages.send(Message::Revoked);
                    return;
                }
                Ok(Some(event)) => {
                    let synchronized = matches!(
                        event,
                        devices::Event::Snapshot(_) | devices::Event::Resume(_)
                    );
                    match list.apply(event) {
                        Ok(changed) => {
                            if synchronized {
                                failures = 0;
                            }
                            if (changed || synchronized)
                                && messages
                                    .send(Message::Machines(
                                        list.devices.clone(),
                                        true,
                                        "Live · account machines".into(),
                                    ))
                                    .is_err()
                            {
                                return;
                            }
                        }
                        Err(_) => {
                            // A gap has an exact repair: discard the cursor and
                            // request a full authoritative snapshot.
                            list.cursor = None;
                            break;
                        }
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
        if messages
            .send(Message::Machines(
                list.devices.clone(),
                false,
                "Reconnecting…".into(),
            ))
            .is_err()
        {
            return;
        }
        failures = failures.saturating_add(1);
        reconnect(failures).await;
    }
}
async fn reconnect(failures: u32) {
    // Browser device-events schedule: first recovery immediate, then full
    // jitter with a 250 ms base and a 5 s ceiling. This schedules requests;
    // only a snapshot/resume marks the list current.
    if failures <= 1 {
        return;
    }
    use merkur_client::Entropy;
    let exponent = (failures - 2).min(5);
    let ceiling = (250u64 << exponent).min(5_000);
    let mut random = [0u8; 8];
    OsEntropy.fill(&mut random);
    let delay = ((u128::from(u64::from_le_bytes(random)) * u128::from(ceiling + 1)) >> 64) as u64;
    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
}

#[expect(
    clippy::too_many_arguments,
    reason = "shared host state and account workspace"
)]
pub(crate) async fn run(
    host: &mut Host,
    parser: &mut HostInput,
    frames: &mut HostFrames,
    chrome: &mut Chrome,
    orb: &mut crate::ui::OrbAnimation,
    mut size: HostSize,
    epoch: Instant,
    state: AccountState,
    mut initial: Option<String>,
) -> io::Result<Exit> {
    let state = Arc::new(state);
    let mut workspace = Workspace {
        focused: orb.focused(),
        ..Workspace::default()
    };
    let (messages, mut incoming) = mpsc::unbounded_channel();
    let events = tokio::spawn(machines(Arc::clone(&state), messages.clone()));
    let mut paint = zeroize::Zeroizing::new(Vec::new());
    let mut written = 0;
    let result = async {

        let mut read = [0; 4096];
        let mut records = Vec::new();
        let mut commands = Vec::new();
        let mut prefix = Prefix::default();
        let mut dirty = true;

        loop {
            let at = now(epoch);
            orb.set_focused(at, workspace.focused);
            orb.set_visible(at, workspace.orb_placement(size).is_some());
            let needed = dirty || workspace.active().is_some_and(|tab| tab.view.wants_frame());
            let changed = dirty || workspace.active().is_some_and(|tab| tab.view.needs_paint());
            let frame = frames.next_frame(at, needed && written == paint.len(), changed);
            let animation = orb.next_frame(at, written == paint.len() && frames.next_frame(at, true, true).is_some());
            let frame = frame.into_iter().chain(animation).reduce(f64::min);
            let deadline = workspace.tabs.iter().filter_map(|tab| tab.view.viewer().next_deadline()).fold(frame, |old, next| Some(old.map_or(next, |old| old.min(next))));
            tokio::select! {
                count = host.write_chunk(&paint[written..]), if written < paint.len() => { written += count?; },
                _ = crate::graphics::completed() => {
                    for tab in &mut workspace.tabs { tab.view.graphics_completed()?; }
                },
                message = incoming.recv() => {
                    if let Some(message) = message {
                        match workspace.message(now(epoch), message)? {
                            MessageEffect::Revoked => return Ok(Exit::Revoked(size)),
                            MessageEffect::Changed => dirty = true,
                            MessageEffect::Quiet => {},
                        }
                        if workspace.list_live && let Some(name) = initial.take() {
                            let machine = workspace.resolve_machine(&name)?;
                            workspace.open(machine, size, now(epoch), &state, &messages)?;
                            dirty = true;
                        }
                    }
                },
                event = host.read_event(&mut read) => match event? {
                    HostRead::Exit(code) => return Ok(Exit::Quit(code as u8)),
                    HostRead::Bytes(0) => return Ok(Exit::Quit(0)),
                    HostRead::Resize => {
                        size = host.resized(size)?;
                        paint.extend_from_slice(b"\x1b[16t");
                        for tab in &mut workspace.tabs {
                            if let Some(command) = tab.view.resize(now(epoch), size) { tab.send(command); }
                        }
                        dirty = true;
                    }
                    HostRead::Bytes(count) => {
                        parser.feed(&read[..count], &mut records);
                        read.zeroize();
                        for mut event in records.drain(..) {
                            let old = size;
                            reply(&event, frames, &mut size);
                            if let HostEvent::Reply(reply) = &event {
                                for tab in &mut workspace.tabs {
                                    tab.view.graphics_reply(now(epoch), reply)?;
                                }
                            }
                            if old != size {
                                for tab in &mut workspace.tabs {
                                    if let Some(command) = tab.view.resize(now(epoch), size) { tab.send(command); }
                                }
                            }
                            if workspace.dialog.is_some() {
                                if let HostEvent::Record(record) = &event
                                    && let Some(InputRecord::Focus(focused)) = decode(record)
                                {
                                    workspace.focused = focused;
                                    if let Some(tab) = workspace.active() {
                                        tab.focus(now(epoch), focused)?;
                                        for command in commands.drain(..) { tab.send(command); }
                                    }
                                    continue;
                                }
                                let route = prefix.dialog_route(&event);
                                if let Route::Forward(Some(id)) = route {
                                    if let Some(tab) = workspace.tabs.iter_mut().find(|tab| tab.id == id) {
                                        tab.view.input(now(epoch), event, &mut commands)?;
                                        for command in commands.drain(..) { tab.send(command); }
                                    }
                                    continue;
                                }
                                let intent = workspace.dialog.as_mut().map(|dialog| dialog.input(&event)).unwrap_or(Intent::None);
                                dirty |= matches!(&event, HostEvent::Record(_));
                                crate::interactive::erase(&mut event);
                                match intent {
                                    Intent::None => {},
                                    Intent::Close => workspace.close_dialog(now(epoch))?,
                                    Intent::DismissUrl(tab, id) => workspace.dismiss_url(now(epoch), tab, id)?,
                                    Intent::OpenUrl(tab, url) => workspace.open_url(tab, url, &messages)?,
                                    Intent::Request(job) => { parser.clear_typed(); workspace.job(job, &state, &messages)?; },
                                }
                                continue;
                            }
                            let was_prefix = prefix.active;
                            let route = prefix.route(&event, workspace.selected);
                            dirty |= was_prefix != prefix.active;
                            let target = match route {
                                Route::Discard => continue,
                                Route::Command(character) => {
                                    match character {
                                        Some('?') => workspace.show_help(now(epoch)),
                                        Some('q') => return Ok(Exit::Quit(0)),
                                        Some('l') => workspace.select(now(epoch), None)?,
                                        Some('f') => workspace.fit(),
                                        Some('x') => workspace.close(now(epoch))?,
                                        Some('o') => workspace.review_url(now(epoch))?,
                                        Some(action @ ('a' | 'r' | 'u' | 'v')) => workspace.manage(now(epoch), action, &state, &messages)?,
                                        Some('n' | 'p') if !workspace.tabs.is_empty() => {
                                            let index = workspace.tabs.iter().position(|tab| Some(tab.id) == workspace.selected).unwrap_or(0);
                                            let next = if character == Some('n') { (index+1) % workspace.tabs.len() } else { (index+workspace.tabs.len()-1) % workspace.tabs.len() };
                                            let id = workspace.tabs[next].id;
                                            workspace.select(now(epoch), Some(id))?;
                                        }
                                        Some(c @ '1'..='9') => {
                                            if let Some(tab) = workspace.tabs.get((c as u8 - b'1') as usize) { let id = tab.id; workspace.select(now(epoch), Some(id))?; }
                                        }
                                        _ => {},
                                    }
                                    dirty = true;
                                    continue;
                                }
                                Route::Forward(target) => target,
                            };
                            let (key_code, character) = if let HostEvent::Record(record) = &event {
                                match decode(record) {
                                    Some(InputRecord::Key(key)) if key.event != KeyEvent::Release && key.mods & !(mods::LOCKS | mods::SHIFT) == 0 => (Some(key.key), prefix::key_character(key)),
                                    Some(InputRecord::Text(text)) if text.chars().count() == 1 => (None, text.chars().next()),
                                    Some(InputRecord::Focus(focused)) => { workspace.focused = focused; (None, None) },
                                    _ => (None, None),
                                }
                            } else { (None, None) };
                            if let Some(tab) = target.and_then(|id| workspace.tabs.iter_mut().find(|tab| tab.id == id)) {
                                if tab.commands.is_some() {
                                    if let Err(error) = tab.view.input(now(epoch), event, &mut commands) {
                                        drop(tab.commands.take());
                                        tab.status = error.to_string();
                                        commands.clear();
                                        dirty = true;
                                        continue;
                                    }
                                    for command in commands.drain(..) { tab.send(command); }
                                }
                            } else {
                                match (key_code, character) {
                                    (_, Some('?')) => workspace.show_help(now(epoch)),
                                    (_, Some('q')) => return Ok(Exit::Quit(0)),
                                    (_, Some(action @ ('a' | 'r' | 'u' | 'v'))) => workspace.manage(now(epoch), action, &state, &messages)?,
                                    (Some(crate::host_input::functional::UP), _) | (_, Some('k')) => workspace.move_machine(-1),
                                    (Some(crate::host_input::functional::DOWN), _) | (_, Some('j')) => workspace.move_machine(1),
                                    (Some(keys::ENTER), _) if workspace.list_live => {
                                        if let Some(machine) = workspace.machine_selection.clone() { workspace.open(machine, size, now(epoch), &state, &messages)?; }
                                    }
                                    _ => {},
                                }
                                dirty = true;
                            }
                        }
                    }
                },
                _ = wake(epoch, deadline) => {
                    for tab in &mut workspace.tabs { tab.view.handle_timeout(now(epoch)); }
                    let at = now(epoch);
                    let needed = dirty || workspace.active().is_some_and(|tab| tab.view.wants_frame());
                    let changed = dirty || workspace.active().is_some_and(|tab| tab.view.needs_paint());
                    if written == paint.len() && (needed || orb.due(at)) && frames.begin(at, changed || orb.due(at)) {
                        paint.zeroize(); written = 0;
                        if needed {
                            workspace.orb_frame = orb.frame(at);
                            workspace.frame(size, at, prefix.active, chrome, &mut paint)?;
                        } else if let Some(placement) = workspace.orb_placement(size) {
                            chrome.present(size, |screen| orb.patch(screen, size, placement, at), &mut paint);
                        }
                        orb.painted(at);
                        dirty = false;
                    }
                }
            }
            workspace.flush(now(epoch));
            workspace.reap().await?;
        }
    }.await;
    events.abort();
    let _ = events.await;
    // Closing command channels stops every driver. Join only after all have
    // received that stop, so exit cannot leak transports or signing material.
    for tab in &mut workspace.tabs {
        drop(tab.commands.take());
        if let Some(driver) = tab.driver.take() {
            workspace.retired.push(driver);
        }
    }
    // Every committed account operation finishes before the old credential
    // store is removed. A closed dialog can ignore its reply, not its lifetime.
    let mut cleanup_error = None;
    // A launcher has no account mutation to commit. Cancel its owned child on
    // exit so a browser that keeps its launcher alive cannot hold raw mode open.
    for opener in &workspace.openers {
        opener.abort();
    }
    for opener in workspace.openers {
        if let Err(error) = opener.await
            && !error.is_cancelled()
        {
            cleanup_error.get_or_insert_with(|| io::Error::other(error));
        }
    }

    for job in workspace.jobs {
        if let Err(error) = job.await {
            cleanup_error.get_or_insert_with(|| io::Error::other(error));
        }
    }
    for driver in workspace.retired {
        if driver.join().is_err() {
            cleanup_error.get_or_insert_with(|| io::Error::other("transport reactor panicked"));
        }
    }
    if matches!(result, Ok(Exit::Revoked(_))) {
        state.store.remove().await?;
        // Finish the reserved host frame before changing screens. Otherwise a
        // partial upload could swallow the password screen or lose its fence.
        host.write_all(&paint[written..]).await?;
        for tab in &mut workspace.tabs {
            tab.view.destroy_graphics(&mut workspace.graphics_cleanup);
        }
        let mut cleanup = b"\x18\x1b\\\x1b[?2026l".to_vec();
        cleanup.append(&mut workspace.graphics_cleanup);
        host.write_all(&cleanup).await?;
        parser.clear_sensitive();
    }
    if let Some(error) = cleanup_error {
        return Err(error);
    }
    result
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[test]
fn machine_animation_preserves_the_list_and_has_no_placement_in_remote_tabs() {
    let mut workspace = Workspace::default();
    for (cols, rows) in [(80, 24), (48, 20)] {
        let size = HostSize {
            cols,
            rows,
            cell: None,
        };
        let placement = workspace.orb_placement(size).unwrap();
        let mut chrome = Chrome::default();
        let mut displayed = Vec::new();
        workspace.orb_frame = 0;
        workspace
            .frame(size, 0.0, false, &mut chrome, &mut displayed)
            .unwrap();
        let mut clock = crate::ui::OrbAnimation::default();
        clock.set_visible(0.0, true);
        clock.painted(0.0);
        crate::ui::tests::preview(&format!("animation-machines-{cols}-00"), &displayed);
        for frame in 1..crate::orb::FRAME_COUNT {
            let at = frame as f64 * 1_000.0 / 12.0 + 0.001;
            chrome.present(
                size,
                |screen| clock.patch(screen, size, placement, at),
                &mut displayed,
            );
            clock.painted(at);
            workspace.orb_frame = frame;
            let mut full = Vec::new();
            workspace
                .frame(size, at, false, &mut Chrome::default(), &mut full)
                .unwrap();
            assert_eq!(
                crate::ui::tests::screen(size, &displayed),
                crate::ui::tests::screen(size, &full)
            );
            crate::ui::tests::preview(&format!("animation-machines-{cols}-{frame:02}"), &displayed);
        }
        workspace.selected = Some(1);
        assert!(workspace.orb_placement(size).is_none());
        workspace.selected = None;
    }
    assert!(
        workspace
            .orb_placement(HostSize {
                cols: 36,
                rows: 10,
                cell: None
            })
            .is_none()
    );
}
