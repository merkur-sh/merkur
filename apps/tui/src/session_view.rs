//! The UI side of a session: the shared viewer, host input, geometry and the
//! ANSI composer. Transport stays on its own driver.

use merkur_client::input_delivery::{Budget, PASTE_CHUNK, REPORTS, reported_when};
use merkur_client::session::geometry::GeometryStatus;
use merkur_client::viewer::{self, Viewer};
use merkur_client_native::driver::{Command, Output};
use merkur_client_native::grid::NativeGrid;
use merkur_wire::input_record::{
    InputRecord, MouseAction, MouseButton, WheelDirection, build, decode,
};
use std::{collections::VecDeque, io};
use term_wasm::{DISPLAYED_WIDE, DisplayedCell, DisplayedCursor};
use zeroize::Zeroizing;

use crate::composer::{Composer, Presented, Revision};
use crate::host::HostSize;
use crate::host_input::HostEvent;

// Mode-word wire facts, as `encode_terminal_mode` names them.
const POINTER_CLICKS: u32 = 1;
const POINTER_DRAG: u32 = 1 << 1;
const POINTER_HOVER: u32 = 1 << 2;
const WHEEL: u32 = 1 << 3;

/// Maintenance cadence for grant-only refreshes and viewer release budgets.
/// Changed state uses host consumption credit without waiting for this clock.
pub const FRAME_PERIOD_MS: f64 = 1_000.0 / 60.0;

/// One host screen has one outstanding consumption fence, shared by every tab
/// and the account screens. Switching tabs cannot create a second frame.
#[derive(Default)]
pub struct HostFrames {
    awaiting: bool,
    answered: bool,
    last_tick: Option<u64>,
}

impl HostFrames {
    pub fn consumed(&mut self) {
        self.awaiting = false;
        self.answered = true;
    }

    /// The host has answered a frame's `CSI 5 n`. It answers in order, so every
    /// query written before that frame has its reply by now or never will.
    pub fn answered(&self) -> bool {
        self.answered
    }

    pub fn next_frame(&self, now_ms: f64, needed: bool, changed: bool) -> Option<f64> {
        if !needed || self.awaiting {
            return None;
        }
        let tick = (now_ms / FRAME_PERIOD_MS).floor() as u64;
        Some(if !changed && self.last_tick == Some(tick) {
            (tick + 1) as f64 * FRAME_PERIOD_MS
        } else {
            now_ms
        })
    }

    /// Reserve host consumption credit before committing or composing. The caller writes
    /// exactly one frame ending in `CSI 5 n` after a successful reservation.
    pub fn begin(&mut self, now_ms: f64, changed: bool) -> bool {
        let tick = (now_ms / FRAME_PERIOD_MS).floor() as u64;
        if self.awaiting || (!changed && self.last_tick == Some(tick)) {
            return false;
        }
        self.last_tick = Some(tick);
        self.awaiting = true;
        true
    }
}

pub struct SessionView {
    viewer: Viewer<NativeGrid>,
    graphics: crate::graphics::Graphics,
    composer: Composer,
    size: HostSize,
    status_rows: u16,
    owner: bool,
    budget: Budget,
    deferred: VecDeque<Command>,
    ready: VecDeque<Command>,
    routing_mode: u32,
    dirty: bool,
    mouse_mode: Option<u16>,
    title: String,
    last_refresh_tick: Option<u64>,
}

impl SessionView {
    pub fn new(size: HostSize, status_rows: u16) -> Self {
        let (cols, rows) = content_size(size, status_rows);
        let mut view = Self {
            viewer: Viewer::new(NativeGrid::new(cols.max(1), rows.max(1))),
            graphics: crate::graphics::Graphics::default(),
            composer: Composer::new(0),
            size,
            status_rows,
            owner: false,
            budget: Budget::default(),
            deferred: VecDeque::new(),
            ready: VecDeque::new(),
            routing_mode: 0,
            dirty: true,
            mouse_mode: None,
            title: String::new(),
            last_refresh_tick: None,
        };
        if let Some((width, height)) = size.cell {
            view.viewer.set_cell_size(0.0, width, height);
        }
        view
    }

    pub fn set_title(&mut self, title: String) {
        if merkur_wire::terminal_ui::safe_text(&title) { self.title = title; }
    }

    pub fn title(&self) -> &str {
        if self.title.is_empty() { "merkur" } else { &self.title }
    }

    pub fn viewer(&self) -> &Viewer<NativeGrid> {
        &self.viewer
    }

    pub fn viewer_mut(&mut self) -> &mut Viewer<NativeGrid> {
        &mut self.viewer
    }

    /// Canonical geometry remains the daemon's for an observer. Its screen is
    /// cropped to this host, without reflowing it or overwriting the status row.
    pub fn resize(&mut self, now_ms: f64, size: HostSize) -> Option<Command> {
        self.size = size;
        if let Some((width, height)) = size.cell {
            self.viewer.set_cell_size(now_ms, width, height);
        }
        self.resize_owned();
        self.invalidate();
        self.viewport()
    }

    /// The host's content area, with one cell's pixels when the host states
    /// them. A host that states none still claims the machine's grid.
    pub fn viewport(&self) -> Option<Command> {
        let (cols, rows) = content_size(self.size, self.status_rows);
        (cols > 0 && rows > 0).then_some(Command::Viewport {
            cols,
            rows,
            cell: self.size.cell,
        })
    }

    fn resize_owned(&mut self) {
        let (cols, rows) = content_size(self.size, self.status_rows);
        let grid = self.viewer.grid().terminal();
        if self.owner && cols > 0 && rows > 0 && (cols, rows) != (grid.cols(), grid.rows()) {
            self.viewer.resize(cols, rows);
        }
    }

    pub fn set_visible(&mut self, now_ms: f64, visible: bool) {
        self.viewer.set_visible(now_ms, visible);
    }

    pub fn invalidate(&mut self) {
        self.composer.invalidate();
        self.dirty = true;
        self.mouse_mode = None;
    }

    /// Driver termination retires unsent records and speculative presentation.
    pub fn disconnected(&mut self) {
        self.deferred.clear();
        self.ready.clear();
        self.budget = Budget::default();
        self.owner = false;
        self.viewer.discard_input();
        self.invalidate();
    }

    /// Apply driver output. Account and path/status events are returned for
    /// the screen's chrome to consume.
    pub fn receive(&mut self, now_ms: f64, output: Output) -> Option<Output> {
        match output {
            Output::InputAcknowledged(sequence) => self.budget.acknowledged(sequence),
            Output::Terminal {
                channel,
                payload,
                input,
                datagram,
            } => {
                if datagram
                    && channel == merkur_wire::protocol::CHANNEL_CTRL
                    && matches!(
                        merkur_wire::protocol::decode_proto_frame(&payload),
                        Some((merkur_wire::protocol::MSG_TYPE_DISPLAY_LINK_TABLE, _))
                    )
                {
                    return None;
                }
                let links_revision = self.viewer.links().revision();
                self.viewer.receive(now_ms, channel, &payload, input);
                if links_revision != self.viewer.links().revision()
                    && merkur_wire::protocol::decode_proto_frame(&payload).is_some_and(
                        |(kind, body)| {
                            kind == merkur_wire::protocol::MSG_TYPE_DISPLAY_LINK_TABLE
                                && body.first().is_some_and(|flags| {
                                    flags & merkur_wire::protocol::DISPLAY_LINK_TABLE_FLAG_RESET
                                        != 0
                                })
                        },
                    )
                {
                    self.composer.invalidate();
                }
                self.dirty |= links_revision != self.viewer.links().revision();
            }
            Output::DisplayFence(fence) => {
                self.graphics.fence(fence.lineage);
                self.viewer.fence(now_ms, fence);
                self.composer.invalidate();
                self.owner = false;
                self.dirty = true;
            }
            Output::GeometryState(status) => {
                self.owner = status == GeometryStatus::Owner;
                if !self.owner {
                    self.viewer.release_geometry(now_ms);
                }
                self.resize_owned();
                return Some(Output::GeometryState(status));
            }
            Output::GraphicsClock {
                monotonic_us,
                rtt_ms,
            } => {
                self.viewer
                    .graphics_clock(now_ms, monotonic_us, rtt_ms as f64);
            }
            other => return Some(other),
        }
        None
    }

    /// Reconcile once after all currently queued output has drained.
    pub fn drained(&mut self, now_ms: f64) {
        self.dirty |= self.viewer.present_now(now_ms).is_some();
        let mode = self.viewer.grid().terminal().mouse_mode();
        self.dirty |= self.mouse_mode != Some(mouse_mode(mode));
        if (mode & !self.routing_mode) & REPORTS != 0 {
            self.ready.append(&mut self.deferred);
        }
        self.routing_mode = mode;
    }

    pub fn handle_timeout(&mut self, now_ms: f64) {
        self.viewer.handle_timeout(now_ms);
        self.drained(now_ms);
    }

    pub fn needs_paint(&self) -> bool {
        self.dirty
    }

    pub fn wants_frame(&self) -> bool {
        self.dirty || self.viewer.wants_frame(true)
    }

    /// Called only after `HostFrames::begin` reserves consumption credit. A background
    /// tab is never called here and therefore never grants a display frame.
    pub fn frame(&mut self, now_ms: f64, out: &mut Vec<u8>) -> io::Result<()> {
        let tick = (now_ms / FRAME_PERIOD_MS).floor() as u64;
        if self.last_refresh_tick != Some(tick) {
            self.last_refresh_tick = Some(tick);
            self.viewer.frame(now_ms, FRAME_PERIOD_MS, true, None);
        } else {
            // Consumption admits a paint, not another display refresh. Extra
            // paints must not spend redraw/repair frame bounds or issue grants.
            self.viewer.present_now(now_ms);
        }
        let (cols, rows) = content_size(self.size, self.status_rows);
        let source = Cropped {
            grid: self.viewer.grid(),
            links: self.viewer.links(),
            cols,
            rows,
        };
        let mouse = mouse_mode(self.viewer.grid().terminal().mouse_mode());
        if self.mouse_mode != Some(mouse) {
            out.extend_from_slice(b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
            if mouse != 0 {
                out.extend_from_slice(format!("\x1b[?{mouse}h\x1b[?1006h").as_bytes());
            }
            self.mouse_mode = Some(mouse);
        }
        if !self.composer.compose(&source, out) {
            // A grant-only refresh still obtains its own consumption evidence.
            out.extend_from_slice(b"\x1b[?2026h\x1b[?2026l\x1b[5n");
        }
        let end = b"\x1b[?2026l\x1b[5n";
        out.truncate(out.len() - end.len());
        self.graphics
            .compose(self.viewer.graphics_scene(), self.size, out)?;
        out.extend_from_slice(end);
        for (epoch, key) in self.graphics.retired() {
            self.viewer
                .set_graphics_resident(now_ms, epoch, &key, false);
        }
        self.dirty = false;
        Ok(())
    }

    pub fn graphics_asset(
        &mut self,
        now_ms: f64,
        epoch: u32,
        key: String,
        asset: merkur_client::session::graphics::GraphicsAsset,
        bytes: Vec<u8>,
    ) -> io::Result<()> {
        match asset {
            merkur_client::session::graphics::GraphicsAsset::Tile => {
                self.graphics.tile(epoch, key, bytes)?
            }
            merkur_client::session::graphics::GraphicsAsset::Animation => {
                self.viewer.graphics_manifest(now_ms, epoch, &key, bytes);
            }
        }
        self.dirty = true;
        Ok(())
    }

    pub fn graphics_reply(
        &mut self,
        now_ms: f64,
        reply: &crate::host_input::Reply,
    ) -> io::Result<()> {
        if let crate::host_input::Reply::Graphics {
            image,
            placement,
            result,
        } = reply
            && let Some((epoch, key)) = self.graphics.reply(
                *image,
                *placement,
                result.as_ref().map(|_| ()).map_err(String::as_str),
            )?
        {
            if let Some(key) = key {
                self.viewer.set_graphics_resident(now_ms, epoch, &key, true);
            }
            self.dirty = true;
        }
        Ok(())
    }

    pub fn graphics_completed(&mut self) -> io::Result<()> {
        self.dirty |= self.graphics.completed()?;
        Ok(())
    }

    pub fn destroy_graphics(&mut self, out: &mut Vec<u8>) {
        self.graphics.destroy(out);
    }

    pub fn hide_graphics(&mut self, out: &mut Vec<u8>) {
        self.graphics.hide(out);
    }

    /// Route one host input. Every admitted record is modelled before it
    /// crosses to transport, using this view's monotonically numbered input.
    pub fn input(
        &mut self,
        now_ms: f64,
        mut event: HostEvent,
        out: &mut Vec<Command>,
    ) -> io::Result<()> {
        let mode = self.viewer.grid().terminal().mouse_mode();
        let (cols, rows) = content_size(self.size, self.status_rows);
        let inside = |col: u32, row: u32| col < u32::from(cols) && row < u32::from(rows);
        let record = match &mut event {
            HostEvent::Record(record) => {
                if let Some(InputRecord::Focus(focused)) = decode(record) {
                    out.push(Command::Focused(focused));
                }
                std::mem::take(record)
            }
            HostEvent::Mouse(mouse) if inside(mouse.column, mouse.row) => {
                let reports = match mouse.action {
                    MouseAction::Press | MouseAction::Release => mode & POINTER_CLICKS != 0,
                    MouseAction::Motion if mouse.button == MouseButton::None => {
                        mode & POINTER_HOVER != 0
                    }
                    MouseAction::Motion => mode & POINTER_DRAG != 0,
                };
                if !reports {
                    return Ok(());
                }
                build::mouse(
                    mouse.action as u8,
                    mouse.button as u8,
                    mouse.mods,
                    mouse.column,
                    mouse.row,
                )
            }
            HostEvent::Wheel(wheel) if inside(wheel.column, wheel.row) && mode & WHEEL != 0 => {
                let direction = match wheel.direction {
                    WheelDirection::Up => 0,
                    WheelDirection::Down => 1,
                    WheelDirection::Left => 2,
                    WheelDirection::Right => 3,
                };
                build::wheel(direction, wheel.mods, wheel.count, wheel.column, wheel.row)
            }
            _ => return Ok(()),
        };
        let mut record = Zeroizing::new(record);
        if let Some(InputRecord::Paste(text)) = decode(&record) {
            let mut offset = 0;
            while offset < text.len() {
                let mut end = (offset + PASTE_CHUNK).min(text.len());
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                self.admit(now_ms, build::paste(&text[offset..end]), out)?;
                offset = end;
            }
            return Ok(());
        }
        self.admit(now_ms, std::mem::take(&mut *record), out)
    }

    fn admit(&mut self, now_ms: f64, record: Vec<u8>, out: &mut Vec<Command>) -> io::Result<()> {
        let mut record = Zeroizing::new(record);
        let sequence = self
            .budget
            .admit(record.len())
            .map_err(|error| io::Error::other(format!("input backlog exhausted: {error:?}")))?;
        let reported = reported_when(&record);
        let modelled = reported == 0 && self.viewer.input(now_ms, sequence, &record);
        let command = Command::Input {
            local_seq: sequence,
            record: std::mem::take(&mut *record),
            modelled,
        };
        if reported != 0 && self.routing_mode & reported != reported {
            self.deferred.push_back(command);
        } else {
            out.extend(self.ready.drain(..));
            out.extend(self.deferred.drain(..));
            out.push(command);
        }
        self.dirty |= reported == 0;
        Ok(())
    }

    pub fn poll_command(&mut self, now_ms: f64) -> Option<Command> {
        if let Some(command) = self.ready.pop_front() {
            return Some(command);
        }
        self.viewer.poll_output(now_ms).map(|output| match output {
            viewer::Output::Ack { payload, durable } => Command::DisplayAck { payload, durable },
            viewer::Output::SnapshotRequest => Command::SnapshotRequest,
            viewer::Output::ResyncRows { generation, rows } => {
                Command::ResyncRows { generation, rows }
            }
            viewer::Output::DictionaryReady(ready) => Command::DictionaryReady(ready),
            viewer::Output::DictionaryAck(id) => Command::DictionaryAck(id),
            viewer::Output::Resume(resume) => Command::DisplayResume(resume),
            viewer::Output::GraphicsDemand { epoch, demands } => {
                Command::GraphicsDemand { epoch, demands }
            }
        })
    }
}

fn content_size(size: HostSize, status_rows: u16) -> (u16, u16) {
    (size.cols, size.rows.saturating_sub(status_rows))
}

fn mouse_mode(word: u32) -> u16 {
    if word & POINTER_HOVER != 0 {
        1003
    } else if word & POINTER_DRAG != 0 {
        1002
    } else if word & (POINTER_CLICKS | WHEEL) != 0 {
        1000
    } else {
        0
    }
}

struct Cropped<'a> {
    grid: &'a NativeGrid,
    links: &'a merkur_client::viewer::links::Links,
    cols: u16,
    rows: u16,
}

impl Presented for Cropped<'_> {
    fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    fn row(&self, row: u16, out: &mut Vec<DisplayedCell>) {
        self.grid.row(row, out);
        out.resize(usize::from(self.cols), DisplayedCell::BLANK);
        // A wide glyph cut at the right edge must not wrap onto another row.
        if let Some(last) = out.last_mut()
            && last.attrs & DISPLAYED_WIDE != 0
        {
            *last = DisplayedCell::BLANK;
        }
    }

    fn links(&self, row: u16, out: &mut Vec<u32>) {
        self.grid.terminal().displayed_links(row, out);
        out.resize(usize::from(self.cols), 0);
    }
    fn link_uri(&self, id: u32) -> Option<&str> {
        self.links.uri(id)
    }

    /// A link's URI can land after the cells that carry it, so a row is also
    /// made from the table that resolves it.
    fn revision(&self, row: u16) -> Option<Revision> {
        let (commit, _) = self.grid.revision(row)?;
        Some((commit, self.links.revision()))
    }

    fn cursor(&self) -> Option<DisplayedCursor> {
        self.grid
            .cursor()
            .filter(|cursor| cursor.col < self.cols && cursor.row < self.rows)
    }
}

#[cfg(test)]
mod tests;
