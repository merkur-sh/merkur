//! Presentation-bounded delivery, closed loop: the real daemon send path, the
//! real WASM receiver, and a viewer that grants with the client core's own
//! controller (`merkur_client::viewer::demand`, the port of the browser's
//! `display-demand.ts`), reading every applied datagram's demand fields as a
//! client does. A lazy grant reaches the daemon only on the next
//! acknowledgement. The
//! invariants below are the ones the design has to keep:
//!
//! * a flood admits at most one state per grant, and a grant only when the
//!   browser shows a frame, so delivered states track the refresh rate;
//! * states land one per frame rather than in round-trip bursts (the failure
//!   of per-ACK credit, which the brief's original rule would have had);
//! * the newest screen is always the next one captured;
//! * a burst's final state is delivered at most one frame after unpaced
//!   delivery would have delivered it, and exactly when it would inside the
//!   run's free window;
//! * with the worker's release rule run over the viewer
//!   (`viewer::presentation`), a burst ends on screen no later than unpaced
//!   delivery shows it, sustained output is no staler on screen, a flood
//!   whose captures all stay open presents one paid state per frame, and a
//!   synchronized redraw is never shown in part;
//! * typing and repair never wait for a grant, and a blocked peer parks the
//!   owner loop instead of spinning.

use merkur_client::viewer::demand::{Demand, FrameGrant};

use super::credit::DISPLAY_DEMAND_MAX_WINDOW;
use super::sim::{DisplaySim, SimWake, sim_peer_id};
use super::viewer::SimViewers;


const COLS: u16 = 120;
const ROWS: u16 = 40;
/// A session's first flood runs on the bootstrap window until its first loop
/// sample, one round trip in; later floods start with the measured window.
const STEADY_AFTER_MS: f64 = 400.0;

/// The modelled browser on one path: its demand controller and the constants
/// of the path it grants over.
pub(super) struct LoopBrowser {
    demand: Demand,
    arrivals_seen: usize,
    applied_seen: usize,
    peer: String,
    period_ms: f64,
    one_way_ms: f64,
    /// Grants at all; without, the daemon runs on the simulator's unbounded
    /// credit, the pre-change behaviour.
    grants: bool,
}

impl LoopBrowser {
    pub(super) fn new(peer: &str, period_ms: f64, one_way_ms: f64, grants: bool) -> Self {
        Self {
            demand: Demand::default(),
            arrivals_seen: 0,
            applied_seen: 0,
            peer: peer.to_owned(),
            period_ms,
            one_way_ms,
            grants,
        }
    }

    /// One animation frame: fold in the states that arrived since the last
    /// frame, whose acknowledgement carried every grant issued so far, then
    /// issue this frame's grant, and run the worker's release rule for the
    /// frame. A lazy grant waits for the next acknowledgement; a posted one
    /// leaves now. Returns how many states arrived.
    pub(super) fn frame(
        &mut self,
        sim: &mut DisplaySim,
        viewers: &mut SimViewers,
        frame_ms: f64,
    ) -> usize {
        viewers.viewer(&self.peer).present_frame(frame_ms);
        let observation = viewers.viewer(&self.peer).demand().clone();
        let fresh = &observation.arrivals[self.arrivals_seen..];
        let applied = &observation.applied[self.applied_seen..];
        for datagram in applied {
            self.demand.note_applied(
                datagram.generation,
                datagram.serial,
                datagram.limited,
                datagram.prompt,
                datagram.at_ms,
            );
        }
        self.arrivals_seen = observation.arrivals.len();
        self.applied_seen = observation.applied.len();
        if !self.grants {
            return fresh.len();
        }
        let demand = &mut self.demand;
        let generation = demand.generation();
        if let Some(last) = applied.last()
            && demand.has_unsent()
        {
            let delay_ms = (last.at_ms + self.one_way_ms - sim.now_ms()).max(0.001);
            sim.enqueue_grant(&self.peer, generation, demand.grant(generation), delay_ms);
            demand.note_grant_sent(last.at_ms);
        }
        match demand.on_frame(frame_ms, self.period_ms, true, Some(2.0 * self.one_way_ms)) {
            FrameGrant::Post | FrameGrant::PostDurable => {
                let generation = demand.generation();
                sim.enqueue_grant(
                    &self.peer,
                    generation,
                    demand.grant(generation),
                    self.one_way_ms,
                );
                demand.note_grant_sent(frame_ms);
            }
            FrameGrant::Lazy | FrameGrant::None => {}
        }
        fresh.len()
    }
}

/// One distinct flood screen: every row repainted with content derived from
/// `seed`, as a scrolling build log changes every visible row.
fn flood_screen(seed: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(usize::from(ROWS) * (usize::from(COLS) + 12));
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    for row in 0..ROWS {
        out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        for _ in 0..COLS {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            out.push(b'a' + (state % 26) as u8);
        }
    }
    out
}

struct LoopRun {
    /// Distinct display states admitted to the wire.
    states: usize,
    /// Datagrams admitted to the wire, parity and repair included.
    datagrams: usize,
    wire_bytes: usize,
    /// Animation frames, after the first round trip, in which a new state
    /// had arrived since the previous frame.
    changed_frames: usize,
    frames: usize,
    /// The most states that arrived between two consecutive frames.
    max_states_per_frame: usize,
}

/// Flood for `flood_ms` and let a `hz` browser over a `one_way_ms` path pull
/// states. With `demand == false` the daemon gets a full window every flush:
/// delivery bounded by nothing but the carrier, the pre-change behaviour.
async fn run_flood(hz: f64, one_way_ms: f64, flood_ms: f64, demand: bool) -> LoopRun {
    let period_ms = 1_000.0 / hz;
    let mut sim = DisplaySim::new(COLS, ROWS);
    sim.set_downlink_delay_ms(one_way_ms);
    let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
    let peer = sim_peer_id(0);
    viewers.viewer(&peer).set_ack_delay_ms(one_way_ms);
    if demand {
        sim.use_explicit_demand();
    }
    // A producer far faster than any display: a new screen every 0.5 ms.
    let producer_step_ms = 0.5;
    let mut writes = 0u64;
    while (writes as f64) * producer_step_ms < flood_ms {
        sim.schedule_pty_write(writes as f64 * producer_step_ms, flood_screen(writes));
        writes += 1;
    }

    let mut browser = LoopBrowser::new(&peer, period_ms, one_way_ms, demand);
    let mut run = LoopRun {
        states: 0,
        datagrams: 0,
        wire_bytes: 0,
        changed_frames: 0,
        frames: 0,
        max_states_per_frame: 0,
    };
    let total_ms = flood_ms + 4.0 * one_way_ms + 10.0 * period_ms;
    let mut frame_ms = period_ms;
    while frame_ms <= total_ms {
        let budget = frame_ms - sim.now_ms();
        viewers.run_for_ms(&mut sim, budget, 1_000_000).await;
        let fresh = browser.frame(&mut sim, &mut viewers, frame_ms);
        // Steady state: after the first flood's window ramp (the loop sample
        // arrives one round trip in) and before the producer stops.
        if frame_ms > STEADY_AFTER_MS && frame_ms < flood_ms {
            run.frames += 1;
            if fresh > 0 {
                run.changed_frames += 1;
            }
            run.max_states_per_frame = run.max_states_per_frame.max(fresh);
        }
        frame_ms += period_ms;
    }
    let observation = viewers.viewer(&peer).demand().clone();
    run.states = observation.arrivals.len();
    run.datagrams = sim.wire().len();
    run.wire_bytes = sim.wire_bytes();
    // Convergence: the last screen the producer wrote is on the viewer.
    let mut daemon = Vec::new();
    sim.terminal_row_hashes(&mut daemon);
    viewers.settle(&mut sim, &peer, 2_000.0).await;
    assert!(
        viewers.diverged_rows(&peer, &daemon).is_empty(),
        "the viewer must end on the producer's final screen"
    );
    run
}

#[tokio::test(flavor = "current_thread")]
async fn a_flood_delivers_one_state_per_presented_frame() {
    // Round trips off exact frame multiples. The simulator has no processing
    // or network jitter, so a round trip of exactly k frames lands every
    // state on a frame boundary, where only floating-point rounding decides
    // which frame it joins; a real path always has some sub-frame phase.
    for (hz, one_way_ms) in [(60.0, 22.0), (60.0, 71.0), (120.0, 22.0), (120.0, 71.0)] {
        let flood_ms = 1_000.0;
        let paced = run_flood(hz, one_way_ms, flood_ms, true).await;
        let unbounded = run_flood(hz, one_way_ms, flood_ms, false).await;
        eprintln!(
            "credit loop {hz} Hz / {} ms RTT: paced states={} datagrams={} bytes={} \
             changed={}/{} max/frame={} | unbounded states={} datagrams={} bytes={} changed={}/{}",
            2.0 * one_way_ms,
            paced.states,
            paced.datagrams,
            paced.wire_bytes,
            paced.changed_frames,
            paced.frames,
            paced.max_states_per_frame,
            unbounded.states,
            unbounded.datagrams,
            unbounded.wire_bytes,
            unbounded.changed_frames,
            unbounded.frames,
        );
        // Every steady-state frame shows a new screen: the window covers the
        // whole round trip, so pacing never lowers the displayed cadence.
        assert_eq!(
            paced.changed_frames, paced.frames,
            "{hz} Hz / {one_way_ms} ms: every presented frame must carry a new state"
        );
        // One state per frame, never the per-round-trip burst per-ACK credit
        // collapses into.
        assert!(
            paced.max_states_per_frame <= 1,
            "{hz} Hz / {one_way_ms} ms: states arrived in bursts of {}",
            paced.max_states_per_frame
        );
        // Bounded by presentation: about one state per frame for the flood,
        // plus the ramp and the window's worth at the end.
        let frames_in_flood = (flood_ms / (1_000.0 / hz)).ceil() as usize;
        assert!(
            paced.states <= frames_in_flood + 2 * DISPLAY_DEMAND_MAX_WINDOW as usize,
            "{hz} Hz: {} states for {frames_in_flood} frames",
            paced.states
        );
        assert!(
            paced.wire_bytes * 4 < unbounded.wire_bytes,
            "{hz} Hz / {one_way_ms} ms: paced {} bytes vs unbounded {}",
            paced.wire_bytes,
            unbounded.wire_bytes
        );
    }
}

/// A producer writing a new screen every `step_ms` from now for `for_ms`.
fn schedule_flood(sim: &mut DisplaySim, first: u64, step_ms: f64, for_ms: f64) -> u64 {
    let mut step = 0u64;
    while (step as f64) * step_ms < for_ms {
        sim.schedule_pty_write(step as f64 * step_ms, flood_screen(first + step));
        step += 1;
    }
    first + step
}

fn explicit_session(one_way_ms: f64) -> (DisplaySim, SimViewers, String) {
    let mut sim = DisplaySim::new(COLS, ROWS);
    sim.set_downlink_delay_ms(one_way_ms);
    let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
    let peer = sim_peer_id(0);
    viewers.viewer(&peer).set_ack_delay_ms(one_way_ms);
    sim.use_explicit_demand();
    (sim, viewers, peer)
}

#[tokio::test(flavor = "current_thread")]
async fn a_burst_inside_one_frame_needs_no_grant() {
    let (mut sim, mut viewers, peer) = explicit_session(20.0);
    // Spend the implicit grant on sustained output, then fall silent.
    schedule_flood(&mut sim, 0, 1.0, 60.0);
    viewers.run_for_ms(&mut sim, 200.0, 256).await;
    assert_eq!(sim.peer_credit(&peer), (1, 1), "nothing banked");
    // A command's burst of several screens, all inside one presented frame,
    // after a quiet frame: delivered as produced, exactly as before pacing.
    let wire_before = sim.wire().len();
    for step in 0..5u64 {
        sim.schedule_pty_write(step as f64 * 0.5, flood_screen(1_000 + step));
    }
    viewers.run_for_ms(&mut sim, 100.0, 256).await;
    assert!(sim.wire().len() > wire_before, "the burst left without a grant");
    assert_eq!(sim.peer_credit(&peer), (1, 1), "a free run consumes nothing");
    let mut daemon = Vec::new();
    sim.terminal_row_hashes(&mut daemon);
    assert!(
        viewers.diverged_rows(&peer, &daemon).is_empty(),
        "the burst's final screen arrived without waiting for the browser"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn without_grants_sustained_output_stops_after_its_free_window() {
    let (mut sim, mut viewers, peer) = explicit_session(20.0);
    schedule_flood(&mut sim, 0, 0.5, 300.0);
    viewers.run_for_ms(&mut sim, 150.0, 256).await;
    let wire_at_150 = sim.wire().len();
    viewers.run_for_ms(&mut sim, 150.0, 256).await;
    let demand = viewers.viewer(&peer).demand().clone();
    assert_eq!(demand.arrivals.len(), 1, "one implicit grant, one paid state");
    assert_eq!(demand.arrivals[0].serial, 1);
    assert!(demand.arrivals[0].limited, "the implicit grant leaves nothing banked");
    assert_eq!(sim.peer_credit(&peer), (1, 1));
    assert_eq!(
        sim.wire().len(),
        wire_at_150,
        "a waiting peer puts nothing more on the wire"
    );
    // Waiting on the browser, the owner parks rather than spinning.
    assert_eq!(sim.next_flush_delay_ms(), None);
}

#[tokio::test(flavor = "current_thread")]
async fn a_grant_captures_the_newest_screen_not_a_backlog() {
    let (mut sim, mut viewers, peer) = explicit_session(20.0);
    schedule_flood(&mut sim, 0, 0.5, 100.0);
    viewers.run_for_ms(&mut sim, 200.0, 256).await;
    let generation = sim.peer_generation(&peer);
    let datagrams_before = sim.wire().len();
    sim.enqueue_grant(&peer, generation, 2, 20.0);
    viewers.run_for_ms(&mut sim, 100.0, 256).await;
    let demand = viewers.viewer(&peer).demand().clone();
    assert_eq!(demand.arrivals.len(), 2, "one grant, one more state");
    let mut daemon = Vec::new();
    sim.terminal_row_hashes(&mut daemon);
    assert!(
        viewers.diverged_rows(&peer, &daemon).is_empty(),
        "the granted state is the final screen, not the next one in line"
    );
    assert!(sim.wire().len() > datagrams_before);
}

#[tokio::test(flavor = "current_thread")]
async fn a_grant_that_finds_the_daemon_waiting_is_a_prompt_loop_sample() {
    let (mut sim, mut viewers, peer) = explicit_session(20.0);
    schedule_flood(&mut sim, 0, 1.0, 400.0);
    viewers.run_for_ms(&mut sim, 100.0, 256).await;
    assert_eq!(sim.peer_credit(&peer), (1, 1));
    let generation = sim.peer_generation(&peer);
    sim.enqueue_grant(&peer, generation, 3, 20.0);
    viewers.run_for_ms(&mut sim, 80.0, 256).await;
    let arrivals = viewers.viewer(&peer).demand().arrivals.clone();
    assert!(arrivals.len() >= 3, "{arrivals:?}");
    assert!(!arrivals[0].prompt, "the implicit grant was banked, not awaited");
    assert!(arrivals[1].prompt, "the grant found the daemon waiting");
    assert!(!arrivals[1].limited, "grant 3 banked one more");
    assert!(!arrivals[2].prompt, "the second grant of that ACK was banked");
    assert!(arrivals[2].limited);
}

#[tokio::test(flavor = "current_thread")]
async fn an_echo_needs_no_grant_while_sustained_output_waits_for_one() {
    let (mut sim, mut viewers, peer) = explicit_session(20.0);
    // A clock rewriting one top row every millisecond: sustained output that
    // leaves the cursor on the prompt row below.
    let mut setup = flood_screen(1);
    setup.extend_from_slice(format!("\x1b[{ROWS};1H\x1b[K").as_bytes());
    sim.schedule_pty_write(0.0, setup);
    for tick in 1..400u64 {
        sim.schedule_pty_write(
            tick as f64,
            format!("\x1b7\x1b[1;1Hclock {tick:08}\x1b8").into_bytes(),
        );
    }
    viewers.run_for_ms(&mut sim, 100.0, 256).await;
    assert_eq!(sim.peer_credit(&peer), (1, 1), "the clock waits for grants");
    let before = sim.wire().len();
    // A keystroke echoed on the cursor row while the clock is blocked.
    sim.schedule_input_echo(0.0, 5.0, &peer, 1, b"x".to_vec(), b"x".to_vec());
    let started = sim.now_ms();
    let mut echo_at_ms = None;
    for _ in 0..64 {
        let Some(wake) = sim.step().await else { break };
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);
        if wake != SimWake::Delivery && sim.wire().len() > before {
            echo_at_ms = Some(sim.now_ms());
            break;
        }
    }
    let echo_at_ms = echo_at_ms.expect("the echo left without a grant");
    assert!(
        echo_at_ms <= started + 5.0 + 1.0,
        "the echo waited: {} ms",
        echo_at_ms - started
    );
    // Exempt: it consumed nothing and stamped the newest serial.
    assert_eq!(sim.peer_credit(&peer), (1, 1));
}

#[tokio::test(flavor = "current_thread")]
async fn input_coverage_and_delayed_echo_do_not_wait_for_background_output_credit() {
    let (mut sim, mut viewers, peer) = explicit_session(1.0);
    let mut setup = flood_screen(1);
    setup.extend_from_slice(format!("\x1b[{ROWS};1H\x1b[K").as_bytes());
    sim.schedule_pty_write(0.0, setup);
    for tick in 1..400u64 {
        sim.schedule_pty_write(
            tick as f64,
            format!("\x1b7\x1b[1;1Hclock {tick:08}\x1b8").into_bytes(),
        );
    }
    viewers.run_for_ms(&mut sim, 100.0, 1_000).await;
    assert_eq!(sim.peer_credit(&peer), (1, 1));

    // The write completes before the shell answers. A transport admission is
    // not evidence that the echo reached the viewer.
    sim.write_pty(b"before-input");
    sim.write_input(&peer, 1, b"x", false);
    viewers.run_for_ms(&mut sim, 5.0, 1_000).await;
    assert_eq!(
        viewers.viewer(&peer).authoritative_input_seq,
        1,
        "background rows must not suppress the input watermark"
    );
    // A grant sends the clock row while the shell is still thinking. That is
    // unrelated output, not proof that the input's cursor-row echo was sent.
    let generation = sim.peer_generation(&peer);
    sim.enqueue_grant(&peer, generation, 2, 1.0);
    viewers.run_for_ms(&mut sim, 5.0, 1_000).await;
    assert_eq!(sim.peer_credit(&peer), (2, 2));
    sim.write_pty(b"x");
    viewers.run_for_ms(&mut sim, 5.0, 1_000).await;
    let mut daemon = Vec::new();
    sim.terminal_row_hashes(&mut daemon);
    assert!(
        !viewers.diverged_rows(&peer, &daemon).contains(&(ROWS - 1)),
        "the real echo must arrive after a separate pre-echo input flush"
    );
    assert_eq!(sim.peer_credit(&peer), (2, 2));
}

#[tokio::test(flavor = "current_thread")]
async fn a_lost_paid_state_is_repaired_without_a_grant() {
    let (mut sim, mut viewers, peer) = explicit_session(20.0);
    // Lose every datagram from the start: the run's first capture spends the
    // implicit grant, and that paid state never reaches the browser, which
    // then has nothing to grant against.
    sim.set_loss(100, 7);
    schedule_flood(&mut sim, 0, 1.0, 40.0);
    viewers.run_for_ms(&mut sim, 60.0, 256).await;
    assert_eq!(sim.peer_credit(&peer), (1, 1));
    assert!(viewers.viewer(&peer).demand().arrivals.is_empty());
    sim.set_loss(0, 7);
    // The row re-send deadline is the wakeup; the repair carries serial 1.
    viewers.run_for_ms(&mut sim, 1_000.0, 256).await;
    let arrivals = viewers.viewer(&peer).demand().arrivals.clone();
    assert_eq!(arrivals.len(), 1, "the repair lands serial 1");
    assert_eq!(arrivals[0].serial, 1);
    assert!(arrivals[0].limited);
    assert_eq!(sim.peer_credit(&peer), (1, 1), "a repair consumes no grant");
    let mut daemon = Vec::new();
    sim.terminal_row_hashes(&mut daemon);
    assert!(viewers.diverged_rows(&peer, &daemon).is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn a_resize_opens_a_fresh_grant_sequence() {
    let (mut sim, mut viewers, peer) = explicit_session(10.0);
    schedule_flood(&mut sim, 0, 1.0, 60.0);
    viewers.run_for_ms(&mut sim, 80.0, 256).await;
    let generation = sim.peer_generation(&peer);
    assert_eq!(sim.peer_credit(&peer), (1, 1));
    sim.request_snapshot(&peer);
    viewers.run_for_ms(&mut sim, 40.0, 256).await;
    assert_ne!(sim.peer_generation(&peer), generation);
    assert_eq!(sim.peer_credit(&peer), (1, 0), "a new generation opens with one grant");
}

/// Frame time at which the viewer first shows a burst's final screen, in ms
/// after the burst's last write. The burst follows a warm flood (the browser
/// has measured its loop) and a quiet interval (its window has refilled).
async fn burst_final_latency_ms(hz: f64, one_way_ms: f64, burst_ms: f64, demand: bool) -> f64 {
    let period_ms = 1_000.0 / hz;
    let mut sim = DisplaySim::new(COLS, ROWS);
    sim.set_downlink_delay_ms(one_way_ms);
    let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
    let peer = sim_peer_id(0);
    viewers.viewer(&peer).set_ack_delay_ms(one_way_ms);
    if demand {
        sim.use_explicit_demand();
    }
    // Long enough for the first loop sample, which lands one round trip in.
    let warm_ms = 4.0 * one_way_ms + 10.0 * period_ms;
    let next = schedule_flood(&mut sim, 0, 0.5, warm_ms);
    let burst_start_ms = warm_ms + 4.0 * one_way_ms + 20.0 * period_ms;
    let mut step = 0u64;
    while (step as f64) * 0.5 < burst_ms {
        sim.schedule_pty_write(burst_start_ms + step as f64 * 0.5, flood_screen(next + step));
        step += 1;
    }
    let last_write_ms = burst_start_ms + (step - 1) as f64 * 0.5;

    let mut browser = LoopBrowser::new(&peer, period_ms, one_way_ms, demand);
    let mut daemon = Vec::new();
    // Off the producer's 0.5 ms grid, as a real display phase is.
    let mut frame_ms = period_ms * 0.37;
    let deadline_ms = last_write_ms + 4.0 * one_way_ms + 20.0 * period_ms;
    while frame_ms <= deadline_ms {
        let budget = frame_ms - sim.now_ms();
        viewers.run_for_ms(&mut sim, budget, 1_000_000).await;
        if frame_ms > last_write_ms {
            if daemon.is_empty() {
                sim.terminal_row_hashes(&mut daemon);
            }
            if viewers.diverged_rows(&peer, &daemon).is_empty() {
                return frame_ms - last_write_ms;
            }
        }
        browser.frame(&mut sim, &mut viewers, frame_ms);
        frame_ms += period_ms;
    }
    f64::INFINITY
}

#[tokio::test(flavor = "current_thread")]
async fn a_burst_ends_on_screen_within_one_frame_of_unpaced_delivery() {
    // A burst shorter than one frame and one delivery loop is never paced:
    // the browser cannot have granted against it yet. A longer one is paced
    // one state per frame with the browser's grant clock already running, so
    // its final screen is at most the one frame a grant-timed capture costs,
    // never a round trip spent waiting for the first grants of the run.
    for (hz, one_way_ms) in [(120.0, 0.5), (120.0, 25.0), (60.0, 25.0), (120.0, 60.0)] {
        let period_ms = 1_000.0 / hz;
        for burst_ms in [4.0, 24.0, 96.0] {
            let paced = burst_final_latency_ms(hz, one_way_ms, burst_ms, true).await;
            let unbounded = burst_final_latency_ms(hz, one_way_ms, burst_ms, false).await;
            eprintln!(
                "burst tail {hz} Hz / {} ms RTT / {burst_ms} ms burst: paced {paced:.1} ms, \
                 unbounded {unbounded:.1} ms",
                2.0 * one_way_ms,
            );
            assert!(
                paced <= unbounded + period_ms + 0.5,
                "{hz} Hz / {one_way_ms} ms / {burst_ms} ms: paced {paced} vs unbounded {unbounded}"
            );
            if burst_ms < period_ms.max(2.0 * one_way_ms) {
                assert_eq!(
                    paced, unbounded,
                    "{hz} Hz / {one_way_ms} ms / {burst_ms} ms: an unpaced window was paced"
                );
            }
        }
    }
}

/// The compositor's aggregation deadline, as a fraction of the frame after an
/// animation frame begins: a commit at or before `F + DEADLINE · P` is on
/// screen at the vsync `F + P`, and a later one a frame after. An assumption
/// about the browser this simulator cannot observe; the live measurement owns
/// the real answer.
const COMPOSITOR_DEADLINE: f64 = 0.5;

/// A session whose viewer runs the worker's release rule, and an oracle
/// terminal that records every whole screen the producer wrote.
struct Presenting {
    sim: DisplaySim,
    viewers: SimViewers,
    peer: String,
    browser: LoopBrowser,
    period_ms: f64,
    oracle: DisplaySim,
    /// `(write time, row hashes)` of every screen the application finished.
    screens: Vec<(f64, Vec<u64>)>,
    /// Animation frame times the browser ran.
    frames: Vec<f64>,
    next_frame_ms: f64,
}

impl Presenting {
    /// `demand` paces delivery by grants; `paced_rule` lets the release rule
    /// honour the awaits-grant flag. `prepare_ms` is the modelled encode time.
    fn new(
        cols: u16,
        rows: u16,
        hz: f64,
        one_way_ms: f64,
        demand: bool,
        paced_rule: bool,
        prepare_ms: f64,
    ) -> Self {
        let period_ms = 1_000.0 / hz;
        let mut sim = DisplaySim::new(cols, rows);
        sim.set_downlink_delay_ms(one_way_ms);
        sim.set_prepare_time_ms(prepare_ms);
        let mut viewers = SimViewers::attach(&mut sim, cols, rows);
        let peer = sim_peer_id(0);
        viewers.viewer(&peer).set_ack_delay_ms(one_way_ms);
        viewers.viewer(&peer).presentation.paced = paced_rule;
        if demand {
            sim.use_explicit_demand();
        }
        let browser = LoopBrowser::new(&peer, period_ms, one_way_ms, demand);
        Self {
            sim,
            viewers,
            peer,
            browser,
            period_ms,
            oracle: DisplaySim::new(cols, rows),
            screens: Vec::new(),
            frames: Vec::new(),
            // Off the producer's 0.5 ms grid, as a real display phase is.
            next_frame_ms: period_ms * 0.37,
        }
    }

    /// Write `bytes` at `at_ms`; `whole` says the application's screen is
    /// complete once it lands.
    fn write(&mut self, at_ms: f64, bytes: Vec<u8>, whole: bool) {
        self.oracle.write_pty(&bytes);
        if whole {
            let mut hashes = Vec::new();
            self.oracle.terminal_row_hashes(&mut hashes);
            self.screens.push((at_ms, hashes));
        }
        self.sim.schedule_pty_write(at_ms - self.sim.now_ms(), bytes);
    }

    /// A whole-screen producer from `start_ms`, one screen every `step_ms`
    /// for `for_ms`, seeded from `first`. Returns the next seed.
    fn flood(&mut self, first: u64, start_ms: f64, step_ms: f64, for_ms: f64) -> u64 {
        let mut step = 0u64;
        while (step as f64) * step_ms < for_ms {
            self.write(start_ms + step as f64 * step_ms, flood_screen(first + step), true);
            step += 1;
        }
        first + step
    }

    /// Run animation frames through `end_ms`.
    async fn run_until(&mut self, end_ms: f64) {
        while self.next_frame_ms <= end_ms {
            let budget = self.next_frame_ms - self.sim.now_ms();
            self.viewers
                .run_for_ms(&mut self.sim, budget, 1_000_000)
                .await;
            self.browser
                .frame(&mut self.sim, &mut self.viewers, self.next_frame_ms);
            self.frames.push(self.next_frame_ms);
            self.next_frame_ms += self.period_ms;
        }
    }

    fn commits(&mut self) -> Vec<SimCommit> {
        self.viewers.viewer(&self.peer).presentation.commits.clone()
    }

    /// The commit on screen at the vsync that ends the frame begun at
    /// `frame_ms`.
    fn displayed(commits: &[SimCommit], frame_ms: f64, period_ms: f64) -> Option<&SimCommit> {
        let deadline = frame_ms + COMPOSITOR_DEADLINE * period_ms;
        commits.iter().rev().find(|commit| commit.at_ms <= deadline)
    }

    /// The write time of the newest complete screen `screen` is.
    fn written_at(&self, screen: &[u64]) -> Option<f64> {
        self.screens
            .iter()
            .rev()
            .find(|(_, hashes)| hashes.as_slice() == screen)
            .map(|(at_ms, _)| *at_ms)
    }
}

use merkur_client::viewer::presentation::Release;

use super::viewer::presentation::SimCommit;

/// Vsync after a burst's last write that first shows its final screen, in ms.
/// The burst follows a warm flood and a quiet interval, as in
/// [`burst_final_latency_ms`].
async fn burst_final_on_screen_ms(
    hz: f64,
    one_way_ms: f64,
    burst_ms: f64,
    demand: bool,
    paced_rule: bool,
) -> f64 {
    let mut s = Box::new(Presenting::new(COLS, ROWS, hz, one_way_ms, demand, paced_rule, 0.0));
    let period_ms = s.period_ms;
    let warm_ms = 4.0 * one_way_ms + 10.0 * period_ms;
    let next = s.flood(0, 0.0, 0.5, warm_ms);
    let burst_start_ms = warm_ms + 4.0 * one_way_ms + 20.0 * period_ms;
    s.flood(next, burst_start_ms, 0.5, burst_ms);
    let (last_write_ms, last_screen) = s.screens.last().cloned().expect("a burst");
    Box::pin(s.run_until(last_write_ms + 4.0 * one_way_ms + 20.0 * period_ms)).await;
    let commits = s.commits();
    s.frames
        .iter()
        .map(|&frame_ms| (frame_ms, Presenting::displayed(&commits, frame_ms, period_ms)))
        .find(|(frame_ms, commit)| {
            *frame_ms + period_ms > last_write_ms
                && commit.is_some_and(|commit| commit.screen == last_screen)
        })
        .map_or(f64::INFINITY, |(frame_ms, _)| frame_ms + period_ms - last_write_ms)
}

#[tokio::test(flavor = "current_thread")]
async fn a_paced_burst_is_on_screen_no_later_than_unpaced_delivery() {
    // The capture a grant times costs up to a frame after the last write; the
    // paced close gives it back by committing the final state as it lands,
    // not at the next animation frame. Without it (the control) a burst that
    // outlasts its free window ends a frame late.
    let mut control_later = 0;
    for (hz, one_way_ms) in [(120.0, 0.5), (60.0, 0.5), (120.0, 25.0), (60.0, 25.0), (120.0, 60.0)]
    {
        for burst_ms in [24.0, 96.0] {
            let paced = Box::pin(burst_final_on_screen_ms(
                hz,
                one_way_ms,
                burst_ms,
                true,
                true,
            ))
            .await;
            let control =
                Box::pin(burst_final_on_screen_ms(hz, one_way_ms, burst_ms, true, false))
                    .await;
            let unbounded = Box::pin(burst_final_on_screen_ms(
                hz,
                one_way_ms,
                burst_ms,
                false,
                true,
            ))
            .await;
            eprintln!(
                "burst on screen {hz} Hz / {} ms RTT / {burst_ms} ms: paced {paced:.1} ms, \
                 without the paced close {control:.1} ms, unbounded {unbounded:.1} ms",
                2.0 * one_way_ms
            );
            assert!(
                paced <= unbounded + 0.5,
                "{hz} Hz / {one_way_ms} ms / {burst_ms} ms: paced {paced} vs unbounded {unbounded}"
            );
            assert!(paced <= control, "the paced close never delays a commit");
            control_later += usize::from(control > unbounded + 0.5);
        }
    }
    assert!(control_later > 0, "the control must show the regression this closes");
}

/// Steady state of a whole-screen producer writing every `step_ms`, with
/// `prepare_ms` of modelled encode time.
struct Sustained {
    /// At each vsync, how long ago the screen on display was written.
    mean_ms: f64,
    p95_ms: f64,
    /// Frames that took two commits.
    doubled: usize,
    /// Screens on display the producer never wrote.
    never_written: usize,
    /// Commits per animation frame.
    cadence: f64,
    /// Commits carrying more than one paid state.
    folded: usize,
    /// Commits the paced close released, and how many of them inside the
    /// task that closed them rather than at a frame.
    paced: usize,
    early: usize,
    commits: usize,
}

async fn sustained(
    hz: f64,
    one_way_ms: f64,
    step_ms: f64,
    prepare_ms: f64,
    demand: bool,
    paced_rule: bool,
) -> Sustained {
    let mut s = Box::new(Presenting::new(COLS, ROWS, hz, one_way_ms, demand, paced_rule, prepare_ms));
    let period_ms = s.period_ms;
    let steady_from_ms = 8.0 * one_way_ms + 40.0 * period_ms;
    let end_ms = steady_from_ms + 250.0;
    s.flood(0, 0.0, step_ms, end_ms);
    // Past the producer's end, so the last measured frame has its commit.
    Box::pin(s.run_until(end_ms + 4.0 * period_ms)).await;
    let commits = s.commits();
    let steady = |at_ms: f64| at_ms >= steady_from_ms && at_ms < end_ms - period_ms;
    let mut ages = Vec::new();
    let mut never_written = 0;
    let mut doubled = 0;
    let mut frames = 0;
    for &frame_ms in s.frames.iter().filter(|&&at| steady(at)) {
        frames += 1;
        let per_frame = commits
            .iter()
            .filter(|commit| commit.at_ms >= frame_ms && commit.at_ms < frame_ms + period_ms)
            .count();
        // The frame's own commit and at most one early one.
        assert!(per_frame <= 2, "{per_frame} commits in the frame at {frame_ms}");
        doubled += usize::from(per_frame == 2);
        let Some(commit) = Presenting::displayed(&commits, frame_ms, period_ms) else {
            continue;
        };
        match s.written_at(&commit.screen) {
            Some(at_ms) => ages.push(frame_ms + period_ms - at_ms),
            None => never_written += 1,
        }
    }
    ages.sort_by(f64::total_cmp);
    let steady_commits: Vec<&SimCommit> = commits.iter().filter(|c| steady(c.at_ms)).collect();
    Sustained {
        mean_ms: ages.iter().sum::<f64>() / ages.len().max(1) as f64,
        p95_ms: ages[((ages.len() as f64) * 0.95) as usize],
        doubled,
        never_written,
        cadence: steady_commits.len() as f64 / f64::from(frames.max(1)),
        folded: steady_commits.iter().filter(|c| c.states > 1).count(),
        paced: steady_commits
            .iter()
            .filter(|c| c.reason == Release::PacedComplete)
            .count(),
        early: steady_commits
            .iter()
            .filter(|c| c.reason == Release::PacedComplete && c.early)
            .count(),
        commits: steady_commits.len(),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn sustained_paced_output_is_no_staler_on_screen_than_unpaced_delivery() {
    let mut control_staler = 0;
    for (hz, one_way_ms) in [(120.0, 0.5), (60.0, 0.5), (60.0, 25.0), (120.0, 60.0)] {
        let paced =
            Box::pin(sustained(hz, one_way_ms, 0.5, 0.0, true, true)).await;
        let control = Box::pin(sustained(hz, one_way_ms, 0.5, 0.0, true, false)).await;
        let unbounded =
            Box::pin(sustained(hz, one_way_ms, 0.5, 0.0, false, true)).await;
        eprintln!(
            "sustained age {hz} Hz / {} ms RTT (mean/p95): paced {:.1}/{:.1} ({} frames with a \
             second commit), without the paced close {:.1}/{:.1}, unbounded {:.1}/{:.1}",
            2.0 * one_way_ms,
            paced.mean_ms,
            paced.p95_ms,
            paced.doubled,
            control.mean_ms,
            control.p95_ms,
            unbounded.mean_ms,
            unbounded.p95_ms
        );
        assert_eq!(paced.never_written, 0, "every screen on display is one the producer wrote");
        // A second commit in a frame happens only where a frame-released
        // state hands over to states that close on arrival.
        assert!(paced.doubled <= 2, "a frame takes two commits only at a hand-over");
        assert!(
            paced.mean_ms <= unbounded.mean_ms + 0.5,
            "{hz} Hz / {one_way_ms} ms: paced mean {} vs unbounded {}",
            paced.mean_ms,
            unbounded.mean_ms
        );
        control_staler += usize::from(control.mean_ms > unbounded.mean_ms + 0.5);
    }
    assert!(control_staler > 0, "the control must show the regression this closes");
}

#[tokio::test(flavor = "current_thread")]
async fn a_flood_that_outruns_preparation_presents_every_paid_state() {
    // With encode time modelled every flood capture sees the terminal move on
    // and stays open. The frame rule (the control) holds each for its deadline
    // and folds in its successor: one commit every two frames. The paced
    // close commits every paid state as it lands, one per frame.
    for (hz, one_way_ms) in [(120.0, 0.5), (60.0, 0.5), (120.0, 25.0), (60.0, 25.0)] {
        let period_ms = 1_000.0 / hz;
        let paced = Box::pin(sustained(hz, one_way_ms, 0.25, 0.4, true, true)).await;
        let control = Box::pin(sustained(hz, one_way_ms, 0.25, 0.4, true, false)).await;
        let unbounded = Box::pin(sustained(hz, one_way_ms, 0.25, 0.4, false, true)).await;
        eprintln!(
            "flood with encode time {hz} Hz / {} ms RTT (age mean/p95, commits per frame): \
             paced {:.1}/{:.1} {:.2} ({} of {} early), frame rule {:.1}/{:.1} {:.2}, \
             unbounded {:.1}/{:.1} {:.2}",
            2.0 * one_way_ms,
            paced.mean_ms,
            paced.p95_ms,
            paced.cadence,
            paced.early,
            paced.commits,
            control.mean_ms,
            control.p95_ms,
            control.cadence,
            unbounded.mean_ms,
            unbounded.p95_ms,
            unbounded.cadence,
        );
        assert_eq!(
            (paced.never_written, control.never_written),
            (0, 0),
            "every screen on display is one the producer wrote"
        );
        assert_eq!(paced.folded, 0, "each paid state commits on its own");
        assert_eq!(paced.paced, paced.commits, "each commits by the paced close");
        assert!(paced.cadence > 0.95, "one commit per frame: {}", paced.cadence);
        assert_eq!(control.folded, control.commits, "control: the frame rule commits pairs");
        assert!(control.cadence < 0.55, "control: one commit per two frames: {}", control.cadence);
        assert!(
            paced.mean_ms <= control.mean_ms - period_ms / 4.0,
            "{hz} Hz / {one_way_ms} ms: paced mean {} vs frame rule {}",
            paced.mean_ms,
            control.mean_ms
        );
        assert!(paced.p95_ms < control.p95_ms);
        assert!(
            paced.mean_ms <= unbounded.mean_ms + 0.5,
            "{hz} Hz / {one_way_ms} ms: paced mean {} vs unbounded {}",
            paced.mean_ms,
            unbounded.mean_ms
        );
    }
}

/// One flood screen written as `chunks` consecutive writes of whole rows, so
/// the cursor ends each write on a different row: what a PTY read sees of a
/// large write.
fn screen_in_chunks(seed: u64, chunks: usize) -> Vec<Vec<u8>> {
    let screen = flood_screen(seed);
    let starts: Vec<usize> = screen
        .windows(2)
        .enumerate()
        .filter(|(_, pair)| pair == b"\x1b[")
        .map(|(index, _)| index)
        .collect();
    let per_chunk = starts.len().div_ceil(chunks);
    starts
        .chunks(per_chunk)
        .map(|rows| {
            let end = starts
                .iter()
                .find(|&&start| start > *rows.last().expect("a chunk has rows"))
                .copied()
                .unwrap_or(screen.len());
            screen[rows[0]..end].to_vec()
        })
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn a_paced_flood_moving_the_cursor_sends_it_with_its_paid_states() {
    // Each screen lands in four PTY reads, the cursor ending each on another
    // row. While the rows wait for a grant, a header change that answers no
    // input waits with them: the paid state carries it. Sent alone it put a
    // header-only datagram on the wire for every read (1,600 a second at
    // 120 Hz in a live flood) and showed the cursor over rows not yet there.
    let mut s = Box::new(Presenting::new(COLS, ROWS, 120.0, 0.5, true, true, 0.4));
    let period_ms = s.period_ms;
    let end_ms = 400.0;
    let mut at_ms = 0.0;
    let mut seed = 0;
    while at_ms < end_ms {
        let chunks = screen_in_chunks(seed, 4);
        let last = chunks.len() - 1;
        for (index, chunk) in chunks.into_iter().enumerate() {
            s.write(at_ms + 0.1 * index as f64, chunk, index == last);
        }
        at_ms += 0.5;
        seed += 1;
    }
    let steady_from_ms = 100.0;
    Box::pin(s.run_until(steady_from_ms)).await;
    let header_only_before = s.viewers.viewer(&s.peer).header_only_applied;
    let commits_before = s.commits().len();
    Box::pin(s.run_until(end_ms)).await;
    let header_only = s.viewers.viewer(&s.peer).header_only_applied - header_only_before;
    let commits = s.commits().len() - commits_before;
    let frames = ((end_ms - steady_from_ms) / period_ms).floor();
    eprintln!(
        "cursor-moving flood: {header_only} header-only frames and {commits} commits in {frames} \
         frames"
    );
    assert!(
        (header_only as f64) <= 0.05 * frames,
        "{header_only} header-only frames in {frames} frames"
    );
    assert!(commits as f64 >= 0.9 * frames, "{commits} commits in {frames} frames");
}

/// The two halves of one application redraw of every row but the last, with
/// no synchronized output: the top, then the bottom. Both leave the cursor
/// home, so neither changes the header and no header-only frame can close the
/// presentation between them.
fn split_redraw(seed: u64) -> (Vec<u8>, Vec<u8>) {
    let screen = flood_screen(seed);
    let row_start = |row: u16| {
        screen
            .windows(2)
            .enumerate()
            .filter(|(_, pair)| pair == b"\x1b[")
            .nth(usize::from(row))
            .map(|(index, _)| index)
            .expect("a screen has a row every escape")
    };
    let half = row_start(ROWS / 2);
    let last = row_start(ROWS - 1);
    let mut top = screen[..half].to_vec();
    let mut bottom = screen[half..last].to_vec();
    top.extend_from_slice(b"\x1b[1;1H");
    bottom.extend_from_slice(b"\x1b[1;1H");
    (top, bottom)
}

/// Rows the redraw owns: every row but the clock on the last.
fn redraw_rows(screen: &[u64]) -> &[u64] {
    &screen[..usize::from(ROWS - 1)]
}

/// A paced run whose capture lands inside every second-frame redraw: the top
/// half just before the grant arrives, the bottom half while the capture is
/// being encoded. A clock on the last row, written away from the capture,
/// keeps the run paced. `synchronized` wraps each redraw in BSU/ESU. Returns
/// the commits, and for each commit showing a redraw's top over an older
/// bottom, how long until a commit showed that redraw whole.
async fn straddled_redraws(paced_rule: bool, synchronized: bool) -> (Vec<SimCommit>, Vec<f64>) {
    let one_way_ms = 0.5;
    let mut s = Box::new(Presenting::new(COLS, ROWS, 120.0, one_way_ms, true, paced_rule, 0.4));
    let period_ms = s.period_ms;
    let first_frame_ms = s.next_frame_ms;
    let end_ms = 500.0;
    let mut whole = Vec::new();
    let mut frame = 0u64;
    loop {
        let frame_ms = first_frame_ms + frame as f64 * period_ms;
        if frame_ms > end_ms {
            break;
        }
        for (offset, tick) in [(2.0, 2 * frame), (4.5, 2 * frame + 1)] {
            let clock = format!("\x1b7\x1b[{ROWS};1Hclock {tick:08}\x1b8").into_bytes();
            s.write(frame_ms + offset, clock, false);
        }
        if frame.is_multiple_of(2) {
            let (mut top, mut bottom) = split_redraw(frame);
            if synchronized {
                top.splice(0..0, b"\x1b[?2026h".iter().copied());
                bottom.extend_from_slice(b"\x1b[?2026l");
            }
            s.write(frame_ms + 0.25, top, false);
            s.write(frame_ms + 0.75, bottom, true);
            let (_, screen) = s.screens.last().cloned().expect("the redraw was recorded");
            whole.push(redraw_rows(&screen).to_vec());
        }
        frame += 1;
    }
    Box::pin(s.run_until(end_ms + 10.0 * period_ms)).await;
    let commits: Vec<SimCommit> = s
        .commits()
        .into_iter()
        .filter(|commit| commit.at_ms >= 100.0 && commit.at_ms <= end_ms)
        .collect();
    let is_whole = |commit: &SimCommit| {
        whole
            .iter()
            .any(|rows| rows.as_slice() == redraw_rows(&commit.screen))
    };
    let exposures = commits
        .iter()
        .enumerate()
        .filter(|(_, commit)| !is_whole(commit))
        .map(|(index, commit)| {
            commits[index + 1..]
                .iter()
                .find(|later| is_whole(later))
                .map_or(f64::INFINITY, |later| later.at_ms - commit.at_ms)
        })
        .collect();
    (commits, exposures)
}

#[tokio::test(flavor = "current_thread")]
async fn an_unsynchronized_redraw_caught_mid_write_shows_until_the_next_paid_state() {
    // Without synchronized output nothing on the wire says where a redraw
    // ends: a capture inside one is shown as it is, as a local terminal shows
    // the grid at vsync, and the next paid state, one frame later, shows the
    // redraw whole. The frame rule (the control) held such a capture for its
    // successor, a bet that this one would complete it.
    let period_ms = 1_000.0 / 120.0;
    let (commits, exposures) = Box::pin(straddled_redraws(true, false)).await;
    let (control, control_exposures) = Box::pin(straddled_redraws(false, false)).await;
    eprintln!(
        "unsynchronized straddled redraws: paced {} commits, {} caught mid-write, exposure max \
         {:.1} ms; frame rule {} commits, {} caught mid-write",
        commits.len(),
        exposures.len(),
        exposures.iter().copied().fold(0.0, f64::max),
        control.len(),
        control_exposures.len(),
    );
    assert!(!exposures.is_empty(), "control: captures really landed inside redraws");
    assert!(
        exposures.iter().all(|&ms| ms <= period_ms + 1.0),
        "a redraw caught mid-write is whole on screen by the next paid state: {exposures:?}"
    );
    assert!(commits.len() > control.len(), "every paid state is shown");
}

#[tokio::test(flavor = "current_thread")]
async fn a_synchronized_redraw_is_never_shown_in_part() {
    // The same redraws inside BSU/ESU: the terminal applies each one whole at
    // its ESU, so no capture, paced or not, can hold half of one.
    let (commits, exposures) = Box::pin(straddled_redraws(true, true)).await;
    eprintln!(
        "synchronized straddled redraws: {} commits, {} partial",
        commits.len(),
        exposures.len()
    );
    assert!(!commits.is_empty());
    assert!(exposures.is_empty(), "a synchronized redraw shown in part");
}

/// Incompressible full screens too large for one send turn, one every 5 ms
/// at 60 Hz: carrying flushes, commits, paced commits, and commits showing a
/// screen the application never wrote.
async fn clipped_screens(paced_rule: bool) -> (usize, usize, usize, usize) {
    const WIDE: u16 = 480;
    const TALL: u16 = 160;
    let mut s = Box::new(Presenting::new(WIDE, TALL, 60.0, 0.5, true, paced_rule, 0.0));
    let period_ms = s.period_ms;
    let mut state = 0x5eed_u64;
    let mut noisy = |seed: u64| {
        let mut out = Vec::new();
        for row in 0..TALL {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            for _ in 0..WIDE {
                state ^= state << 13 ^ seed;
                state ^= state >> 7;
                state ^= state << 17;
                out.push(b'!' + (state % 90) as u8);
            }
        }
        out
    };
    let end_ms = 600.0;
    let mut at_ms = 0.0;
    let mut seed = 1;
    while at_ms < end_ms {
        let bytes = noisy(seed);
        s.write(at_ms, bytes, true);
        at_ms += 5.0;
        seed += 1;
    }
    let flushes_before = s.sim.flushes().len();
    Box::pin(s.run_until(end_ms + 30.0 * period_ms)).await;
    let carrying = s.sim.flushes()[flushes_before..]
        .iter()
        .filter(|flush| flush.datagrams > 0)
        .count();
    let commits = s.commits();
    let torn = commits
        .iter()
        .filter(|commit| commit.reason != Release::Urgent)
        .filter(|commit| s.written_at(&commit.screen).is_none())
        .count();
    let paced = commits
        .iter()
        .filter(|commit| commit.reason == Release::PacedComplete)
        .count();
    (carrying, commits.len(), paced, torn)
}

#[tokio::test(flavor = "current_thread")]
async fn a_clipped_paced_state_is_never_committed_before_its_remainder() {
    // The admitted prefix of each capture goes out first and its remainder
    // follows without a grant, so the prefix never carries the awaits-grant
    // flag and nothing commits it alone. A remainder carries its rows as they
    // are when it is sent, so either rule can show a mixture of two written
    // screens; the paced close must never show more of them than the frame
    // rule it replaces.
    let (carrying, commits, paced, torn) = Box::pin(clipped_screens(true)).await;
    let (_, control_commits, _, control_torn) = Box::pin(clipped_screens(false)).await;
    eprintln!(
        "clipped screens: {carrying} carrying flushes; paced {commits} commits ({paced} paced), \
         {torn} mixed; frame rule {control_commits} commits, {control_torn} mixed"
    );
    assert!(carrying > commits, "control: captures crossed several send turns");
    assert!(paced > 0, "the paced close ran");
    assert!(torn <= control_torn, "the paced close shows no mixture the frame rule would not");
}
