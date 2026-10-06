//! Presentation-bounded display delivery: the viewer's half of the grant loop.
//! The port of `display-demand.ts`.
//!
//! The daemon admits a new screen state only against a display grant, and this
//! controller issues grants at the rate the terminal is actually shown: at most
//! one per presented frame, one on becoming visible, none while hidden, and
//! never more than the delivery loop can hold in flight. A flood costs one
//! state per presented frame, and the newest screen is the next one captured.
//!
//! - The grant is a cumulative per-generation counter riding the display ACK;
//!   every generation opens with one implicit grant on both sides.
//! - Every datagram carries the serial of the grant its state consumed, so
//!   `granted - seen` is exactly the grants whose states have not arrived.
//! - The window is `ceil(max(loop, network RTT) / period) + 1`. The loop is
//!   measured on one clock, from a grant leaving to the arrival of the state
//!   that consumed it, and only when the daemon flags it was already waiting.
//!   The largest observed loop is kept for the carrier session.
//! - While the daemon waits on grants, each is posted at once until the window
//!   is full. A state that merely spent the last grant is owed exactly one
//!   post. Otherwise a grant tops up the daemon's bank on the next ACK.
//! - The grant that fills the window while waiting, and the one post a limited
//!   state is owed, also travel the reliable lane, so a lost grant cannot leave
//!   both sides waiting.
//!
//! There is no timer: the clock is the presented frame, and the loop is a
//! measured interval.

use merkur_wire::protocol::DISPLAY_DEMAND_MAX_WINDOW;

use super::ack_window::serial_is_newer;

/// Resource bound: one issue time per grant the window can hold.
const GRANT_RING_SIZE: usize = DISPLAY_DEMAND_MAX_WINDOW as usize + 1;
/// Before the first loop sample: one state in flight plus the grant issued on
/// the frame it lands.
const BOOTSTRAP_WINDOW: u32 = 2;

/// What a presented frame asks of the transport.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameGrant {
    None,
    /// A grant was issued; it rides the next display ACK.
    Lazy,
    /// A grant was issued for a waiting daemon; post it now.
    Post,
    /// Post now and on the reliable lane.
    PostDurable,
}

pub struct Demand {
    generation: u32,
    granted: u32,
    /// Highest grant an ACK has carried; issue times are stamped on sending.
    sent_through: u32,
    seen: u32,
    limited: bool,
    waiting: bool,
    post_owed: bool,
    durable: u32,
    last_frame_ms: Option<f64>,
    loop_ms: Option<f64>,
    issued_at: Box<[Option<f64>; GRANT_RING_SIZE]>,
    window: u32,
}

impl Default for Demand {
    fn default() -> Self {
        Self {
            generation: 0,
            granted: 0,
            sent_through: 0,
            seen: 0,
            limited: false,
            waiting: false,
            post_owed: false,
            durable: 0,
            last_frame_ms: None,
            loop_ms: None,
            issued_at: Box::new([None; GRANT_RING_SIZE]),
            window: BOOTSTRAP_WINDOW,
        }
    }
}

fn ring(serial: u32) -> usize {
    serial as usize % GRANT_RING_SIZE
}

impl Demand {
    fn outstanding(&self) -> u32 {
        self.granted.wrapping_sub(self.seen)
    }

    fn compute_window(&self, period_ms: f64, network_rtt_ms: Option<f64>) -> u32 {
        let measured = self
            .loop_ms
            .unwrap_or(0.0)
            .max(network_rtt_ms.filter(|rtt| rtt.is_finite()).unwrap_or(0.0));
        if measured <= 0.0 || period_ms <= 0.0 {
            return BOOTSTRAP_WINDOW;
        }
        let frames = (measured / period_ms).ceil() + 1.0;
        (frames.min(f64::from(DISPLAY_DEMAND_MAX_WINDOW)) as u32).max(BOOTSTRAP_WINDOW)
    }

    fn open_generation(&mut self, generation: u32) {
        self.generation = generation;
        self.granted = 1;
        // The implicit grant was never sent, so it is never a loop sample.
        self.sent_through = 1;
        self.seen = 0;
        self.limited = false;
        self.waiting = false;
        self.post_owed = false;
        self.durable = 0;
        self.issued_at.fill(None);
    }

    fn eager(&self) -> bool {
        self.limited && (self.waiting || self.post_owed)
    }

    /// A display datagram of `generation` applied carrying these demand fields.
    pub fn note_applied(
        &mut self,
        generation: u32,
        serial: u32,
        limited: bool,
        prompt: bool,
        now_ms: f64,
    ) {
        if generation != self.generation {
            self.open_generation(generation);
        }
        // Snapshots and evidence probes carry no demand.
        if serial == 0 {
            return;
        }
        if serial == self.seen {
            self.limited = limited;
            self.post_owed |= limited;
            return;
        }
        if !serial_is_newer(serial, self.seen) {
            return;
        }
        self.seen = serial;
        self.limited = limited;
        if !limited {
            self.waiting = false;
        } else if prompt {
            self.waiting = true;
        }
        self.post_owed |= limited;
        if serial_is_newer(serial, self.granted) {
            // The daemon admitted a state past our grants (a boundary
            // bootstrap): adopt it. Serials we never issued are no sample.
            self.granted = serial;
            self.sent_through = serial;
            return;
        }
        if prompt
            && let Some(at) = self.issued_at[ring(serial)]
            && now_ms >= at
        {
            // A shorter sample does not prove slower flights are gone.
            self.loop_ms = Some(self.loop_ms.unwrap_or(0.0).max(now_ms - at));
        }
    }

    /// One presented frame. A repeated timestamp grants nothing.
    pub fn on_frame(
        &mut self,
        frame_ms: f64,
        period_ms: f64,
        visible: bool,
        network_rtt_ms: Option<f64>,
    ) -> FrameGrant {
        if !visible || self.generation == 0 || self.last_frame_ms == Some(frame_ms) {
            return FrameGrant::None;
        }
        self.last_frame_ms = Some(frame_ms);
        self.window = self.compute_window(period_ms, network_rtt_ms);
        if self.outstanding() >= self.window {
            // A full window still owes a waiting daemon one reliable copy of
            // its newest grant.
            if self.eager() && self.durable != self.granted {
                self.durable = self.granted;
                self.post_owed = false;
                return FrameGrant::PostDurable;
            }
            return FrameGrant::None;
        }
        self.granted = self.granted.wrapping_add(1);
        // Stamped when an ACK carries it: a lazy grant's wait for the next ACK
        // is not part of the delivery loop.
        self.issued_at[ring(self.granted)] = None;
        if !self.eager() {
            return FrameGrant::Lazy;
        }
        self.post_owed = false;
        if !self.waiting || self.outstanding() >= self.window {
            self.durable = self.granted;
            return FrameGrant::PostDurable;
        }
        FrameGrant::Post
    }

    /// Becoming visible requests fresh state at once.
    pub fn resume_visible(&mut self) -> FrameGrant {
        if self.generation == 0 || !self.limited {
            return FrameGrant::None;
        }
        self.waiting = true;
        if self.outstanding() < self.window {
            self.granted = self.granted.wrapping_add(1);
            self.issued_at[ring(self.granted)] = None;
        }
        self.durable = self.granted;
        self.post_owed = false;
        FrameGrant::PostDurable
    }

    /// An ACK carrying the current grant was handed to the transport.
    pub fn note_grant_sent(&mut self, now_ms: f64) {
        while serial_is_newer(self.granted, self.sent_through) {
            self.sent_through = self.sent_through.wrapping_add(1);
            self.issued_at[ring(self.sent_through)] = Some(now_ms);
        }
    }

    /// Posting failed: owe its durable copy again.
    pub fn note_post_failed(&mut self) {
        self.durable = 0;
        self.post_owed = true;
    }

    /// An applied snapshot opens a fresh grant sequence, whatever its number.
    pub fn reset_generation(&mut self, generation: u32) {
        self.open_generation(generation);
    }

    /// No generation is open.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// Whether the grant clock needs another presented frame.
    pub fn wants_frame(&self, visible: bool) -> bool {
        visible
            && self.generation != 0
            && self.eager()
            && (self.outstanding() < self.window || self.durable != self.granted)
    }

    /// The generation grants are open for; 0 before any state applied.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Whether a grant was issued that no ACK has carried yet.
    pub fn has_unsent(&self) -> bool {
        serial_is_newer(self.granted, self.sent_through)
    }

    /// The cumulative grant an ACK of `generation` carries; 0 grants nothing.
    pub fn grant(&self, generation: u32) -> u32 {
        if generation == self.generation {
            self.granted
        } else {
            0
        }
    }

    /// The carrier session was replaced: grants whose states were in flight
    /// are gone.
    pub fn reset_session(&mut self) {
        self.granted = self.seen;
        self.sent_through = self.seen;
        self.durable = 0;
        self.limited = false;
        self.waiting = false;
        self.post_owed = false;
        self.issued_at.fill(None);
        self.loop_ms = None;
        self.window = BOOTSTRAP_WINDOW;
    }

    pub fn window(&self) -> u32 {
        self.window
    }

    /// The largest measured delivery loop in this session.
    pub fn loop_ms(&self) -> Option<f64> {
        self.loop_ms
    }
}

#[cfg(test)]
mod tests;
