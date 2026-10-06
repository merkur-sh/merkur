//! Presentation-bounded display delivery: the daemon's half of the grant loop.
//!
//! A peer's browser issues one display grant per animation frame it is shown,
//! and only while it has fewer grants outstanding than its measured delivery
//! loop covers. Output past its run's free window (below) is admitted as new
//! screen states (one capture of the peer-visible dirty rows and header,
//! however many datagrams it encodes to) only against an unconsumed grant.
//! Between grants the daemon keeps applying PTY output and the next admitted
//! state carries the screen as it is then, so a flood becomes at most one state
//! per presented frame instead of one per owner turn.
//!
//! There is no timer and no rate constant here. The browser's compositor is the
//! clock, and the grant it returns is the exact event the daemon waits on.
//!
//! Work that consumes no grant:
//!
//! * an output run until the browser has seen it: output that starts after at
//!   least one presentation period of silence, with no paced state of an
//!   earlier run still unacknowledged, is delivered as produced for at least
//!   one presented frame and until the browser acknowledges one of its
//!   datagrams. Before that acknowledgement no grant can reflect the run, so
//!   pacing it would only delay it: a burst that completes inside that window,
//!   and any output slower than the display, is delivered exactly as before.
//!   A free state still spends a banked grant when one is there, so the bank
//!   is spent while delivery is unpaced anyway and the browser's grant clock
//!   is already running when the window closes;
//! * input-caused urgent feedback (a lone cursor-row echo or a header-only
//!   advertisement) — typing latency is not a presentation question;
//! * a state with no rows: a header-only update is never the state a grant
//!   buys, and a lost one leaves no row to repair;
//! * the clipped remainder of an admitted state, restricted to rows that state
//!   has not carried — it is the same state, completed as carrier space
//!   returns;
//! * repair of a row whose newest admitted send is unconfirmed past its
//!   measured re-send deadline — that state was already paid for;
//! * snapshots, which begin a generation and with it a fresh grant sequence.
//!
//! Those frames carry the newest consumed serial rather than a new one, so they
//! never confuse the browser's window accounting.

/// Grants a browser may hold outstanding beyond the newest serial it has seen.
///
/// A resource bound every client's demand controller shares through
/// `merkur-wire`; its per-grant issue-time ring is one larger. A grant further
/// ahead of the consumed serial than this is malformed and is ignored rather
/// than banked.
pub(crate) use merkur_wire::protocol::DISPLAY_DEMAND_MAX_WINDOW;

/// The demand fields one datagram carries in its patch body header.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DemandStamp {
    pub(crate) serial: u32,
    pub(crate) limited: bool,
    pub(crate) prompt: bool,
    /// The run is paced and nothing is banked: no newer state can follow
    /// without a grant. A prediction for the send instant, which
    /// [`DisplayCredit::awaits_grant`] settles at physical admission.
    pub(crate) awaits_grant: bool,
}

/// What a flush may put on the wire for one peer, decided before capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisplayAdmission {
    /// A new screen state, admitted against a grant.
    State,
    /// Consumes no grant: input-caused urgent feedback, a flush with no rows,
    /// or a free output run with nothing banked.
    Exempt,
    /// The clipped remainder of the open state: only rows it has not carried.
    Continuation { state_first_seq: u32 },
    /// Only rows whose newest admitted send is unconfirmed past its deadline,
    /// plus the cursor row when it answers new input.
    Repair,
}

/// The terminal's current output run, as this peer has been shown it.
///
/// A run begins with output after at least one presentation period of silence,
/// once no paced state of the previous run is still unacknowledged: a flood
/// that pauses for a frame stays paced, while a redraw that was never paced
/// always opens a fresh run.
#[derive(Clone, Copy, Debug)]
struct OutputRun {
    started_at_ms: f64,
    last_output_ms: f64,
    /// First datagram sequence this peer was sent in the run.
    first_seq: Option<u32>,
    /// The browser has acknowledged a datagram at or past `first_seq`, so its
    /// grants can reflect the run.
    seen: bool,
    /// First datagram of the newest state admitted against a grant after the
    /// run's free window, until the browser acknowledges it.
    paced_seq: Option<u32>,
}

/// Per-peer grant accounting for one display generation.
///
/// Serials never wrap: every admitted state spends at least one datagram
/// sequence, and datagram sequence rollover is itself a snapshot boundary
/// (`arm_display_seq_rollover_snapshots`), which opens a new generation.
#[derive(Clone, Debug)]
struct GrantLedger {
    generation: u32,
    /// Cumulative grants received for `generation`. Every generation opens
    /// with one implicit grant, so the first delta after a snapshot never
    /// waits for a round trip the snapshot itself has not completed.
    granted: u32,
    /// Screen states admitted against those grants.
    consumed: u32,
    /// A grant reached this peer while it was waiting for one with work
    /// pending and nothing banked: the next admission is a pure delivery-loop
    /// sample.
    prompt_pending: bool,
    /// The newest admitted state lost its suffix to carrier capacity and still
    /// owes its presentation END.
    open_clipped: bool,
    /// First datagram sequence of the newest admitted state.
    state_first_seq: u32,
}

impl GrantLedger {
    fn new(generation: u32) -> Self {
        Self {
            generation,
            granted: 1,
            consumed: 0,
            prompt_pending: false,
            open_clipped: false,
            state_first_seq: 0,
        }
    }

    #[inline]
    fn banked(&self) -> bool {
        serial_is_newer(self.granted, self.consumed)
    }
}

/// A preparation the worker is encoding: how it was admitted and its stamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PreparedDemand {
    pub(crate) admission: DisplayAdmission,
    pub(crate) stamp: DemandStamp,
}

/// Per-peer display credit.
#[derive(Clone, Debug)]
pub(crate) struct DisplayCredit {
    ledger: GrantLedger,
    run: OutputRun,
    /// The preparation the worker holds, settled by its completion or
    /// cancellation.
    preparing: Option<PreparedDemand>,
    /// The stamp for every datagram the owner loop prepares in this flush.
    current: DemandStamp,
}

impl DisplayCredit {
    pub(crate) fn new(generation: u32) -> Self {
        Self {
            ledger: GrantLedger::new(generation),
            run: OutputRun {
                started_at_ms: f64::NEG_INFINITY,
                last_output_ms: f64::NEG_INFINITY,
                first_seq: None,
                seen: true,
                paced_seq: None,
            },
            preparing: None,
            current: DemandStamp::default(),
        }
    }

    /// Start a fresh grant sequence when the peer's generation moved. Every
    /// accessor calls this, so a generation assigned anywhere — a snapshot, a
    /// resume adopting the browser's generation — cannot leak old serials or
    /// the run's datagram sequences, which restart with the generation.
    #[inline]
    fn sync(&mut self, generation: u32) {
        if self.ledger.generation != generation {
            self.ledger = GrantLedger::new(generation);
            self.run.first_seq = None;
            self.run.paced_seq = None;
            self.run.seen = false;
        }
    }

    /// A new generation's grant sequence; output timing carries over. Datagram
    /// sequences restart with the generation, so the run's are forgotten: its
    /// delivery stays free until the browser sees a state of the new generation.
    /// An old-generation ACK cannot refill the restarted grant pipeline.
    pub(crate) fn reset_generation(&mut self, generation: u32) {
        self.ledger = GrantLedger::new(generation);
        self.preparing = None;
        self.run.first_seq = None;
        self.run.paced_seq = None;
        self.run.seen = false;
    }

    /// Terminal output was applied at `now_ms`. Output after at least one
    /// presentation period of silence starts a new run, unless a paced state
    /// of the current one is still unacknowledged.
    #[inline]
    pub(crate) fn note_output(&mut self, now_ms: f64, period_ms: f64) {
        if now_ms - self.run.last_output_ms >= period_ms && self.run.paced_seq.is_none() {
            self.run.started_at_ms = now_ms;
            self.run.first_seq = None;
            self.run.seen = false;
        }
        self.run.last_output_ms = now_ms;
    }

    /// The current output run is delivered as produced: it is younger than
    /// one presented frame, or the browser has not yet acknowledged any of it.
    #[inline]
    pub(crate) fn run_is_free(&self, now_ms: f64, period_ms: f64) -> bool {
        now_ms - self.run.started_at_ms < period_ms || !self.run.seen
    }

    /// Datagrams starting at `first_seq` are about to carry this peer's next
    /// state; the first of a run is the one its acknowledgement is awaited on.
    #[inline]
    pub(crate) fn note_state_seq(&mut self, first_seq: u32) {
        if self.run.first_seq.is_none() {
            self.run.first_seq = Some(first_seq);
        }
    }

    /// The browser acknowledged datagrams through `largest_seq` of
    /// `generation`.
    pub(crate) fn note_acknowledged(&mut self, generation: u32, largest_seq: u32) {
        if self.ledger.generation != generation {
            return;
        }
        if let Some(first) = self.run.first_seq
            && !serial_is_newer(first, largest_seq)
        {
            self.run.seen = true;
        }
        if let Some(paced) = self.run.paced_seq
            && !serial_is_newer(paced, largest_seq)
        {
            self.run.paced_seq = None;
        }
    }

    /// An unconsumed grant is banked.
    #[cfg(test)]
    pub(crate) fn available(&mut self, generation: u32) -> bool {
        self.sync(generation);
        self.ledger.banked()
    }

    /// Decide what this flush may admit. `exempt` is input-caused urgent
    /// feedback or a flush with no rows; `free` is a free output run, which
    /// spends a banked grant when there is one; `end_owed` is the peer's
    /// presentation END obligation, the exact signal that a clipped state is
    /// still open.
    pub(crate) fn admission(
        &mut self,
        generation: u32,
        exempt: bool,
        free: bool,
        end_owed: bool,
    ) -> DisplayAdmission {
        self.sync(generation);
        if self.ledger.open_clipped {
            if end_owed {
                return DisplayAdmission::Continuation {
                    state_first_seq: self.ledger.state_first_seq,
                };
            }
            // Its END reached the browser some other way (FEC parity replay):
            // the state is complete.
            self.ledger.open_clipped = false;
        }
        if exempt {
            DisplayAdmission::Exempt
        } else if self.ledger.banked() {
            DisplayAdmission::State
        } else if free {
            DisplayAdmission::Exempt
        } else {
            DisplayAdmission::Repair
        }
    }

    /// The scheduler's reading, on a shared borrow: only grant-exempt work can
    /// leave this peer. A generation this record has not synced to yet opens
    /// with its implicit grant, so it never blocks.
    #[inline]
    pub(crate) fn is_blocked(&self, generation: u32, free: bool, end_owed: bool) -> bool {
        !(self.ledger.generation != generation
            || free
            || self.ledger.banked()
            || (self.ledger.open_clipped && end_owed))
    }

    /// Whether `grant` would raise the banked credit. Lets the ACK path skip
    /// its pending-work census for the common repeated grant.
    #[inline]
    pub(crate) fn grant_is_new(&mut self, generation: u32, grant: u32) -> bool {
        self.sync(generation);
        serial_is_newer(grant, self.ledger.granted)
    }

    /// Fold one ACK's cumulative grant in. Returns whether new credit arrived.
    ///
    /// `waiting` says the peer had display work pending when the grant arrived;
    /// with nothing banked and no open state to complete, the grant was the
    /// exact event that work waited on.
    pub(crate) fn observe_grant(&mut self, generation: u32, grant: u32, waiting: bool) -> bool {
        self.sync(generation);
        let ledger = &mut self.ledger;
        if !serial_is_newer(grant, ledger.granted)
            || grant.wrapping_sub(ledger.consumed) > DISPLAY_DEMAND_MAX_WINDOW
        {
            return false;
        }
        if waiting && !ledger.banked() && !ledger.open_clipped {
            ledger.prompt_pending = true;
        }
        ledger.granted = grant;
        true
    }

    /// Consume one grant for a new screen state whose first datagram will be
    /// `first_seq`. `paced` says the run's free window has closed, so the run
    /// stays open until the browser acknowledges this state. Refundable with
    /// [`Self::refund`] until a carrier admits it.
    pub(crate) fn admit_state(
        &mut self,
        generation: u32,
        first_seq: u32,
        paced: bool,
    ) -> DemandStamp {
        self.sync(generation);
        if paced {
            self.run.paced_seq = Some(first_seq);
        }
        let ledger = &mut self.ledger;
        debug_assert!(ledger.banked());
        ledger.consumed = ledger.consumed.wrapping_add(1);
        ledger.state_first_seq = first_seq;
        ledger.open_clipped = false;
        let limited = ledger.consumed == ledger.granted;
        DemandStamp {
            serial: ledger.consumed,
            limited,
            prompt: std::mem::take(&mut ledger.prompt_pending),
            awaits_grant: paced && limited,
        }
    }

    /// The stamp for work that consumes no grant, in a run that is `paced`.
    pub(crate) fn exempt_stamp(&mut self, generation: u32, paced: bool) -> DemandStamp {
        self.sync(generation);
        let limited = !self.ledger.banked();
        DemandStamp {
            serial: self.ledger.consumed,
            limited,
            prompt: false,
            awaits_grant: paced && limited,
        }
    }

    /// Whether a frame sent now may say no newer screen state follows it
    /// without a grant (`PATCH_FLAG_DEMAND_AWAITS_GRANT`): the run's free
    /// window has closed, so its next state must be admitted against a grant,
    /// and none is banked. Read on a shared borrow at the send instant; a
    /// generation this record has not synced to opens with its implicit grant,
    /// so it never awaits one.
    #[inline]
    pub(crate) fn awaits_grant(&self, generation: u32, now_ms: f64, period_ms: f64) -> bool {
        self.ledger.generation == generation
            && !self.run_is_free(now_ms, period_ms)
            && !self.ledger.banked()
    }

    /// Return the grant of a state no carrier admitted, with its loop sample.
    pub(crate) fn refund(&mut self, generation: u32, stamp: DemandStamp) {
        let ledger = &mut self.ledger;
        if ledger.generation == generation && ledger.consumed == stamp.serial && stamp.serial != 0 {
            ledger.consumed = stamp.serial.wrapping_sub(1);
            ledger.prompt_pending |= stamp.prompt;
        }
    }

    /// Stamp every datagram this flush prepares on the owner loop.
    #[inline]
    pub(crate) fn set_current(&mut self, stamp: DemandStamp) {
        self.current = stamp;
    }

    #[inline]
    pub(crate) fn current(&self) -> DemandStamp {
        self.current
    }

    /// The worker is encoding this admission.
    pub(crate) fn hold_for_prepare(&mut self, prepared: PreparedDemand) {
        self.preparing = Some(prepared);
    }

    /// The worker's preparation came back, or was cancelled.
    pub(crate) fn take_prepare(&mut self) -> Option<PreparedDemand> {
        self.preparing.take()
    }

    /// A flush that could have admitted a state found nothing to send: the
    /// peer is idle, and a later admission must not claim the earlier grant's
    /// arrival as prompt.
    pub(crate) fn note_idle(&mut self) {
        self.ledger.prompt_pending = false;
    }

    /// Record whether the newest state is still open after a burst. Only a new
    /// state or its continuation can open one; any burst can observe that its
    /// END obligation is gone.
    pub(crate) fn note_open_state(
        &mut self,
        generation: u32,
        admission: DisplayAdmission,
        clipped: bool,
        end_owed: bool,
    ) {
        self.sync(generation);
        match admission {
            DisplayAdmission::State | DisplayAdmission::Continuation { .. } => {
                self.ledger.open_clipped = clipped && end_owed;
            }
            DisplayAdmission::Exempt | DisplayAdmission::Repair => {
                self.ledger.open_clipped &= end_owed;
            }
        }
    }

    /// One grant beyond the newest admitted state, after a boundary that may
    /// have destroyed states in flight (a carrier replaced, a Noise session
    /// re-established, rows disowned by a resync). The browser counts those
    /// states' grants as outstanding and stops granting once its window looks
    /// full; rows the boundary re-queued are no longer repairs, so without this
    /// neither side would move. The browser adopts the higher serial when it
    /// arrives.
    pub(crate) fn bootstrap(&mut self, generation: u32) {
        self.sync(generation);
        let next = self.ledger.consumed.wrapping_add(1);
        if serial_is_newer(next, self.ledger.granted) {
            self.ledger.granted = next;
        }
        self.ledger.open_clipped = false;
        // The old flight cannot refill the new delivery pipeline. Let the
        // browser observe this boundary before pacing its replacement flight.
        self.run.first_seq = None;
        self.run.paced_seq = None;
        self.run.seen = false;
    }

    #[cfg(test)]
    pub(crate) fn granted(&self) -> u32 {
        self.ledger.granted
    }

    #[cfg(test)]
    pub(crate) fn consumed(&self) -> u32 {
        self.ledger.consumed
    }

    /// Grant enough for `states` further admissions: a test standing in for a
    /// browser whose window never closes.
    #[cfg(test)]
    pub(crate) fn grant_for_test(&mut self, generation: u32, states: u32) {
        self.sync(generation);
        self.ledger.granted = self.ledger.consumed.wrapping_add(states);
    }
}

/// Wrapping serial order within half the range.
#[inline]
fn serial_is_newer(candidate: u32, reference: u32) -> bool {
    candidate != reference && candidate.wrapping_sub(reference) < 0x8000_0000
}

#[cfg(test)]
mod tests {
    use super::*;

    const PERIOD_MS: f64 = 1_000.0 / 60.0;

    #[test]
    fn a_generation_opens_with_one_implicit_grant() {
        let mut credit = DisplayCredit::new(3);
        assert_eq!(credit.admission(3, false, false, false), DisplayAdmission::State);
        let stamp = credit.admit_state(3, 10, false);
        assert_eq!(
            stamp,
            DemandStamp {
                serial: 1,
                limited: true,
                prompt: false,
                awaits_grant: false,
            }
        );
        assert_eq!(credit.admission(3, false, false, false), DisplayAdmission::Repair);
        assert!(credit.is_blocked(3, false, false));
    }

    #[test]
    fn exempt_work_never_spends_a_banked_grant() {
        let mut credit = DisplayCredit::new(1);
        // Urgent feedback and row-less flushes take the exempt path even with
        // credit banked, so a keystroke never drains the bank.
        assert_eq!(credit.admission(1, true, false, false), DisplayAdmission::Exempt);
        assert_eq!(credit.exempt_stamp(1, false).serial, 0);
        assert!(credit.available(1));
    }

    #[test]
    fn a_run_is_free_for_one_frame_and_until_the_browser_has_seen_it() {
        let mut credit = DisplayCredit::new(1);
        credit.note_output(1_000.0, PERIOD_MS);
        assert!(credit.run_is_free(1_000.0, PERIOD_MS));
        credit.note_state_seq(40);
        credit.note_state_seq(41);
        // A frame has passed, but nothing of the run has been acknowledged.
        let mut now = 1_000.0;
        while now < 1_100.0 {
            now += 1.0;
            credit.note_output(now, PERIOD_MS);
        }
        assert!(credit.run_is_free(now, PERIOD_MS));
        // An acknowledgement short of the run's first datagram is not it.
        credit.note_acknowledged(1, 39);
        assert!(credit.run_is_free(now, PERIOD_MS));
        credit.note_acknowledged(1, 45);
        assert!(!credit.run_is_free(now, PERIOD_MS));
        // Acknowledged inside the first frame: still free for that frame.
        credit.note_output(now + PERIOD_MS, PERIOD_MS);
        credit.note_state_seq(50);
        credit.note_acknowledged(1, 50);
        assert!(credit.run_is_free(now + PERIOD_MS + 1.0, PERIOD_MS));
        assert!(!credit.run_is_free(now + 2.0 * PERIOD_MS + 1.0, PERIOD_MS));
        // Output slower than the display opens a fresh run every time.
        let mut slow = 2_000.0;
        for _ in 0..10 {
            slow += PERIOD_MS * 1.5;
            credit.note_output(slow, PERIOD_MS);
            assert!(credit.run_is_free(slow, PERIOD_MS));
        }
    }

    #[test]
    fn a_paced_state_holds_its_run_open_until_acknowledged() {
        let mut credit = DisplayCredit::new(1);
        credit.observe_grant(1, 4, false);
        let mut now = 0.0;
        credit.note_output(now, PERIOD_MS);
        credit.note_state_seq(1);
        credit.note_acknowledged(1, 1);
        while now < 2.0 * PERIOD_MS {
            now += 1.0;
            credit.note_output(now, PERIOD_MS);
        }
        assert!(!credit.run_is_free(now, PERIOD_MS));
        credit.admit_state(1, 9, true);
        // A frame of silence while the paced state is in flight: the flood
        // paused, it did not end.
        now += 2.0 * PERIOD_MS;
        credit.note_output(now, PERIOD_MS);
        assert!(!credit.run_is_free(now, PERIOD_MS));
        credit.note_acknowledged(1, 9);
        now += 2.0 * PERIOD_MS;
        credit.note_output(now, PERIOD_MS);
        assert!(credit.run_is_free(now, PERIOD_MS));
        // A state admitted inside the free window never holds a run open.
        credit.admit_state(1, 12, false);
        now += 2.0 * PERIOD_MS;
        credit.note_output(now, PERIOD_MS);
        assert!(credit.run_is_free(now, PERIOD_MS));
    }

    #[test]
    fn a_free_run_spends_a_banked_grant_before_going_exempt() {
        let mut credit = DisplayCredit::new(1);
        credit.observe_grant(1, 2, false);
        assert_eq!(credit.admission(1, false, true, false), DisplayAdmission::State);
        credit.admit_state(1, 1, false);
        assert_eq!(credit.admission(1, false, true, false), DisplayAdmission::State);
        let stamp = credit.admit_state(1, 2, false);
        assert!(stamp.limited, "the bank is spent: the browser's clock runs");
        assert_eq!(credit.admission(1, false, true, false), DisplayAdmission::Exempt);
        assert!(credit.exempt_stamp(1, false).limited);
        // Outside the free window the same peer waits.
        assert_eq!(credit.admission(1, false, false, false), DisplayAdmission::Repair);
    }

    #[test]
    fn a_new_generation_forgets_the_runs_datagrams() {
        let mut credit = DisplayCredit::new(1);
        credit.observe_grant(1, 3, false);
        credit.note_output(0.0, PERIOD_MS);
        credit.note_state_seq(700);
        credit.note_acknowledged(1, 700);
        credit.admit_state(1, 800, true);
        credit.reset_generation(2);
        // Sequences restarted: a low acknowledgement of the new generation is
        // not the old run's first datagram, and no old paced state holds the
        // run open.
        credit.note_acknowledged(2, 5);
        assert!(credit.run_is_free(10.0 * PERIOD_MS, PERIOD_MS));
        credit.note_output(20.0 * PERIOD_MS, PERIOD_MS);
        assert!(credit.run_is_free(20.0 * PERIOD_MS, PERIOD_MS));
    }

    #[test]
    fn a_carrier_boundary_waits_for_new_flight_evidence_before_pacing() {
        let mut credit = DisplayCredit::new(1);
        credit.note_output(0.0, PERIOD_MS);
        credit.note_state_seq(40);
        credit.note_acknowledged(1, 40);
        assert!(!credit.run_is_free(100.0, PERIOD_MS));
        credit.admit_state(1, 41, true);
        credit.bootstrap(1);
        credit.note_state_seq(42);
        credit.note_acknowledged(1, 41);
        assert!(credit.run_is_free(100.0, PERIOD_MS));
        credit.note_acknowledged(1, 42);
        assert!(!credit.run_is_free(100.0, PERIOD_MS));
    }

    #[test]
    fn a_new_generation_forgets_every_old_serial_but_not_output_timing() {
        let mut credit = DisplayCredit::new(1);
        credit.note_output(10.0, PERIOD_MS);
        credit.observe_grant(1, 9, false);
        credit.admit_state(1, 1, false);
        credit.admit_state(1, 2, false);
        assert_eq!(credit.admission(2, false, false, false), DisplayAdmission::State);
        assert_eq!((credit.granted(), credit.consumed()), (1, 0));
        assert!(credit.run_is_free(12.0, PERIOD_MS));
        // A late ACK of the old generation carries a serial the new one has
        // not issued; it is folded into the new sequence only if plausible.
        assert!(!credit.observe_grant(2, 400, false));
    }

    #[test]
    fn grants_are_cumulative_and_duplicates_mint_nothing() {
        let mut credit = DisplayCredit::new(1);
        assert!(credit.observe_grant(1, 4, false));
        assert!(!credit.observe_grant(1, 4, false));
        assert!(!credit.observe_grant(1, 3, false));
        for expected in 1..=4 {
            let stamp = credit.admit_state(1, expected, false);
            assert_eq!(stamp.serial, expected);
            assert_eq!(stamp.limited, expected == 4);
        }
        assert!(!credit.available(1));
    }

    #[test]
    fn a_grant_beyond_the_window_is_malformed() {
        let mut credit = DisplayCredit::new(1);
        assert!(!credit.observe_grant(1, DISPLAY_DEMAND_MAX_WINDOW + 1, false));
        assert!(credit.observe_grant(1, DISPLAY_DEMAND_MAX_WINDOW, false));
    }

    #[test]
    fn only_a_grant_that_found_the_peer_waiting_is_prompt() {
        let mut credit = DisplayCredit::new(1);
        credit.admit_state(1, 1, false);
        // Waiting with nothing banked: the next state measures the loop.
        credit.observe_grant(1, 2, true);
        assert!(credit.admit_state(1, 2, false).prompt);
        // Banked credit when the grant lands: the state that later consumes
        // the older banked grant must not claim this arrival.
        credit.observe_grant(1, 4, false);
        credit.observe_grant(1, 5, true);
        assert!(!credit.admit_state(1, 3, false).prompt);
        // An idle flush clears a pending sample.
        credit.admit_state(1, 4, false);
        credit.admit_state(1, 5, false);
        credit.observe_grant(1, 6, true);
        credit.note_idle();
        assert!(!credit.admit_state(1, 6, false).prompt);
        // A peer completing an open clipped state was not waiting on a grant.
        credit.note_open_state(1, DisplayAdmission::State, true, true);
        credit.observe_grant(1, 7, true);
        assert_eq!(
            credit.admission(1, false, false, false),
            DisplayAdmission::State,
            "a closed END clears the open state"
        );
        assert!(!credit.admit_state(1, 7, false).prompt);
    }

    #[test]
    fn a_refused_state_returns_its_grant_and_its_sample_once() {
        let mut credit = DisplayCredit::new(1);
        credit.admit_state(1, 1, false);
        credit.observe_grant(1, 2, true);
        let stamp = credit.admit_state(1, 2, false);
        assert!(stamp.prompt);
        credit.refund(1, stamp);
        assert!(credit.available(1));
        credit.refund(1, stamp);
        assert_eq!(credit.consumed(), 1);
        assert!(credit.admit_state(1, 2, false).prompt, "the sample survives the refund");
        // A refund from a fenced generation is ignored.
        credit.observe_grant(1, 3, false);
        let stamp = credit.admit_state(1, 3, false);
        credit.refund(2, stamp);
        assert_eq!(credit.consumed(), 3);
    }

    #[test]
    fn a_clipped_state_continues_without_a_grant_until_its_end() {
        let mut credit = DisplayCredit::new(1);
        credit.admit_state(1, 40, false);
        credit.note_open_state(1, DisplayAdmission::State, true, true);
        assert_eq!(
            credit.admission(1, false, false, true),
            DisplayAdmission::Continuation {
                state_first_seq: 40
            }
        );
        assert!(!credit.is_blocked(1, false, true));
        credit.note_open_state(
            1,
            DisplayAdmission::Continuation {
                state_first_seq: 40,
            },
            false,
            false,
        );
        assert_eq!(credit.admission(1, false, false, false), DisplayAdmission::Repair);
    }

    #[test]
    fn an_end_recovered_elsewhere_closes_the_open_state() {
        let mut credit = DisplayCredit::new(1);
        credit.admit_state(1, 40, false);
        credit.note_open_state(1, DisplayAdmission::State, true, true);
        // The END obligation cleared without an END burst of this peer's own.
        assert_eq!(credit.admission(1, false, false, false), DisplayAdmission::Repair);
        assert!(credit.is_blocked(1, false, false));
    }

    #[test]
    fn exempt_and_repair_bursts_never_open_a_state() {
        let mut credit = DisplayCredit::new(1);
        credit.admit_state(1, 40, false);
        credit.note_open_state(1, DisplayAdmission::Repair, true, true);
        assert_eq!(credit.admission(1, false, false, true), DisplayAdmission::Repair);
        credit.note_open_state(1, DisplayAdmission::Exempt, true, true);
        assert_eq!(credit.admission(1, false, false, true), DisplayAdmission::Repair);
    }

    #[test]
    fn exempt_frames_repeat_the_newest_serial() {
        let mut credit = DisplayCredit::new(1);
        credit.observe_grant(1, 3, false);
        credit.admit_state(1, 1, false);
        assert_eq!(
            credit.exempt_stamp(1, false),
            DemandStamp {
                serial: 1,
                limited: false,
                prompt: false,
                awaits_grant: false,
            }
        );
        credit.admit_state(1, 2, false);
        credit.admit_state(1, 3, false);
        assert_eq!(credit.exempt_stamp(1, false).serial, 3);
        assert!(credit.exempt_stamp(1, false).limited);
    }

    #[test]
    fn bootstrap_grants_exactly_one_state_past_the_newest_admission() {
        let mut credit = DisplayCredit::new(1);
        credit.observe_grant(1, 2, false);
        credit.admit_state(1, 1, false);
        credit.admit_state(1, 2, false);
        credit.bootstrap(1);
        assert_eq!(credit.admit_state(1, 3, false).serial, 3);
        assert!(!credit.available(1));
        // Bootstrap never lowers credit the browser already granted.
        credit.observe_grant(1, 9, false);
        credit.bootstrap(1);
        assert_eq!(credit.granted(), 9);
    }

    #[test]
    fn only_a_paced_run_with_nothing_banked_awaits_a_grant() {
        let mut credit = DisplayCredit::new(1);
        credit.observe_grant(1, 3, false);
        let mut now = 0.0;
        credit.note_output(now, PERIOD_MS);
        credit.note_state_seq(1);
        // Free: the run is younger than a frame and nothing of it was seen.
        assert!(!credit.awaits_grant(1, now, PERIOD_MS));
        let free = credit.admit_state(1, 1, false);
        assert!(!free.awaits_grant, "a free state is followed as produced");
        credit.note_acknowledged(1, 1);
        while now < 2.0 * PERIOD_MS {
            now += 1.0;
            credit.note_output(now, PERIOD_MS);
        }
        assert!(!credit.run_is_free(now, PERIOD_MS));
        // Paced, but a grant is still banked: the next state may leave at once.
        assert!(!credit.awaits_grant(1, now, PERIOD_MS));
        let banked = credit.admit_state(1, 2, true);
        assert!(!banked.limited && !banked.awaits_grant);
        let last = credit.admit_state(1, 3, true);
        assert!(last.limited && last.awaits_grant);
        assert!(credit.awaits_grant(1, now, PERIOD_MS));
        // Grant-exempt work in the same run carries the same fact.
        assert!(credit.exempt_stamp(1, true).awaits_grant);
        assert!(!credit.exempt_stamp(1, false).awaits_grant);
        // A grant landing before the send settles it the other way.
        credit.observe_grant(1, 4, true);
        assert!(!credit.awaits_grant(1, now, PERIOD_MS));
        // A generation this record has not synced to opens with its implicit
        // grant, and a bootstrap banks one: neither awaits.
        assert!(!credit.awaits_grant(2, now, PERIOD_MS));
        credit.admit_state(1, 4, true);
        assert!(credit.awaits_grant(1, now, PERIOD_MS));
        credit.bootstrap(1);
        assert!(!credit.awaits_grant(1, now, PERIOD_MS));
    }
}
