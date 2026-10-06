//! Complete-screen closure, end to end: the production sender, codec and
//! transport faults against the real term-wasm grid, with the worker's closure
//! rule (`ClosurePresentation`) deciding what is published.
//!
//! Every publication is compared with the rows the daemon actually held at an
//! explicit synchronized-update end, never with the digest that admitted it,
//! so a digest that could match a partial grid fails here. The causal control
//! is the rule the claim replaces: publish whatever the grid holds at each
//! animation frame, as the ordinary two-frame deadline eventually does. Under
//! loss and clipping it exposes screens the application never drew.

use super::*;
use crate::display::credit_loop::LoopBrowser;

/// Timer wakes one animation frame may take; more is the owner loop spinning.
const WAKE_CAP: usize = 4_096;
const FRAME_MS: f64 = 1_000.0 / 60.0;
const FOLLOW_ALONG_AFTER_MS: f64 = 500.0;

/// One application frame as a TUI emits it: BSU, every row repainted with
/// seed-derived truecolor text, the cursor parked on a seed-derived cell, ESU.
/// `noisy` rows are incompressible, which is what makes a large grid clip.
fn sync_frame(seed: u64, cols: u16, rows: u16, noisy: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(usize::from(rows) * (usize::from(cols) + 32));
    out.extend_from_slice(b"\x1b[?2026h");
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for row in 0..rows {
        let color = next();
        out.extend_from_slice(
            format!(
                "\x1b[{};1H\x1b[38;2;{};{};{}m\x1b[48;2;{};{};{}m",
                row + 1,
                color & 0xff,
                (color >> 8) & 0xff,
                (color >> 16) & 0xff,
                (color >> 24) & 0xff,
                (color >> 32) & 0xff,
                (color >> 40) & 0xff
            )
            .as_bytes(),
        );
        for col in 0..cols {
            out.push(if noisy {
                b'!' + (next() % 90) as u8
            } else {
                b'a' + ((seed as u16 + row + col) % 26) as u8
            });
        }
        out.extend_from_slice(b"\x1b[0m");
    }
    let cursor = next();
    out.extend_from_slice(
        format!(
            "\x1b[{};{}H\x1b[?2026l",
            1 + cursor % u64::from(rows),
            1 + (cursor >> 16) % u64::from(cols)
        )
        .as_bytes(),
    );
    out
}

/// A session with one viewer on a path of `one_way_ms` each way.
struct Session {
    sim: DisplaySim,
    viewers: SimViewers,
    peer: String,
    rows: u16,
    /// Row hashes of every screen the daemon held at an explicit ESU, plus
    /// the primed blank grid the viewer starts on.
    complete: Vec<Vec<u64>>,
    /// The causal control: the grid after every owner wake at which it
    /// changed — what any rule that publishes before its claim closes, the
    /// ordinary two-frame deadline included, can expose.
    deadline_published: Vec<Vec<u64>>,
    /// The next animation frame, counted rather than re-derived from the
    /// clock: `floor(now / period)` can round back onto the frame just run.
    next_frame_ms: f64,
}

impl Session {
    fn new(cols: u16, rows: u16, one_way_ms: f64) -> Self {
        let mut sim = DisplaySim::new(cols, rows);
        if one_way_ms > 0.0 {
            sim.set_downlink_delay_ms(one_way_ms);
        }
        let mut viewers = SimViewers::attach(&mut sim, cols, rows);
        let peer = sim_peer_id(0);
        if one_way_ms > 0.0 {
            viewers.viewer(&peer).set_ack_delay_ms(one_way_ms);
        }
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);
        let mut blank = Vec::new();
        sim.terminal_row_hashes(&mut blank);
        let next_frame_ms = sim.now_ms() + FRAME_MS;
        Self {
            sim,
            viewers,
            peer,
            rows,
            complete: vec![blank],
            deadline_published: Vec::new(),
            next_frame_ms,
        }
    }

    /// Write one synchronized redraw and remember the complete screen it is.
    fn redraw(&mut self, seed: u64, noisy: bool) {
        let (cols, rows) = self.sim.terminal_dimensions();
        self.sim.write_pty(&sync_frame(seed, cols, rows, noisy));
        assert_ne!(
            self.sim.completed_sync_update_epoch(),
            0,
            "the fixture must end exactly at ESU"
        );
        let mut screen = Vec::new();
        self.sim.terminal_row_hashes(&mut screen);
        self.complete.push(screen);
    }

    fn model(&mut self) -> &mut ClosurePresentation {
        &mut self.viewers.viewer(&self.peer).closure
    }

    /// Advance to the next animation frame, pumping and acknowledging at every
    /// owner wake as a browser draining its socket does, and sample the control.
    async fn frame(&mut self, browser: Option<&mut LoopBrowser>) {
        while self.next_frame_ms <= self.sim.now_ms() {
            self.next_frame_ms += FRAME_MS;
        }
        let target = self.next_frame_ms;
        self.next_frame_ms += FRAME_MS;
        let budget = target - self.sim.now_ms();
        let rows = self.rows;
        let peer = self.peer.clone();
        let viewers = &mut self.viewers;
        let control = &mut self.deadline_published;
        self.sim
            .run_for_ms(budget, WAKE_CAP, |sim, _wake| {
                viewers.pump(sim);
                viewers.acknowledge(sim);
                let screen = viewers.viewer(&peer).row_hashes(rows);
                if control.last() != Some(&screen) {
                    control.push(screen);
                }
            })
            .await;
        if let Some(browser) = browser {
            browser.frame(&mut self.sim, &mut self.viewers, target);
        }
    }

    /// Frames until the viewer holds the daemon's grid with nothing in flight.
    async fn settle(&mut self, budget_ms: f64, mut browser: Option<&mut LoopBrowser>) {
        let started = self.sim.now_ms();
        let mut daemon = Vec::new();
        loop {
            self.frame(browser.as_deref_mut()).await;
            self.sim.terminal_row_hashes(&mut daemon);
            if self.viewers.diverged_rows(&self.peer, &daemon).is_empty()
                && !self.sim.peer_has_unacked_rows(&self.peer)
                && !self.sim.has_pending_acks()
                && !self.sim.has_pending_deliveries()
            {
                return;
            }
            assert!(
                self.sim.now_ms() - started <= budget_ms,
                "the session did not settle inside {budget_ms} ms"
            );
        }
    }

    /// Every closure publication is a screen the daemon held at an ESU.
    fn assert_publications_complete(&mut self, context: &str) {
        let complete = self.complete.clone();
        let model = self.model();
        for (index, (claim, screen)) in model.published.iter().enumerate() {
            assert!(
                complete.contains(screen),
                "{context}: publication {index} (claim {claim:#018x}) is not a complete frame"
            );
        }
    }

    /// Screens the deadline control exposed that the application never drew.
    fn partial_deadline_exposures(&self) -> usize {
        self.deadline_published
            .iter()
            .filter(|screen| !self.complete.contains(screen))
            .count()
    }

    fn assert_final_published(&mut self, context: &str) {
        let last = self.complete.last().cloned().expect("a complete frame");
        let model = self.model();
        assert!(!model.pending, "{context}: a claim is still unmet after settling");
        assert_eq!(
            model.published.last().map(|(_, screen)| screen),
            Some(&last),
            "{context}: the final complete frame was never published"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn each_clean_synchronized_redraw_publishes_exactly_once() {
    let mut s = Session::new(80, 24, 0.0);
    for seed in 1..=4 {
        let before = s.model().published.len();
        s.redraw(seed, false);
        s.settle(5_000.0, None).await;
        assert_eq!(s.model().published.len(), before + 1, "redraw {seed}");
        s.assert_final_published(&format!("redraw {seed}"));
    }
    s.assert_publications_complete("clean");
    assert_eq!(s.model().claims_seen, 4, "every redraw carried its own claim");
    assert_eq!(s.partial_deadline_exposures(), 0, "a clean link has nothing to expose");
}

#[tokio::test(flavor = "current_thread")]
async fn a_clipped_redraw_is_held_across_turns_and_published_once() {
    let mut s = Session::new(480, 160, 0.0);
    for seed in 1..=2 {
        let before_flushes = s.sim.flushes().len();
        let before = s.model().published.len();
        s.redraw(seed, true);
        s.settle(10_000.0, None).await;
        let carrying = s.sim.flushes()[before_flushes..]
            .iter()
            .filter(|flush| flush.datagrams > 0)
            .count();
        // Control: the redraw really crossed several physical send turns.
        assert!(carrying > 1, "redraw {seed} fit one turn; nothing was clipped");
        assert_eq!(s.model().published.len(), before + 1, "redraw {seed}");
        s.assert_final_published(&format!("clipped redraw {seed}"));
    }
    assert!(s.model().held_applies > 0, "clipped remainders were held offscreen");
    s.assert_publications_complete("clipped");
    // Causal control: frame-rule publication showed the clipped prefix alone.
    assert!(s.partial_deadline_exposures() > 0);
}

/// Drop a run of admitted datagrams long enough that FEC parity cannot
/// rebuild it, so the lost rows come back only as a re-diffed repair: a new
/// presentation and new sequences one round trip later.
fn drop_run_after_next_admission(s: &mut Session, len: u64) {
    let base = (s.sim.wire().len() + s.sim.dropped_wire().len()) as u64;
    let run: Vec<u64> = (base + 1..=base + len).collect();
    s.sim.set_drop_indices(&run);
}

#[tokio::test(flavor = "current_thread")]
async fn lost_members_repaired_under_new_presentations_publish_once() {
    // A 120 ms application round trip, as the impaired browser profile.
    let mut s = Session::new(100, 32, 60.0);
    for seed in 1..=3 {
        drop_run_after_next_admission(&mut s, 8);
        let before = s.model().published.len();
        let acks_before = s.model().acks_while_pending;
        let dropped_before = s.sim.dropped_count();
        s.redraw(seed, false);
        s.settle(10_000.0, None).await;
        assert!(s.sim.dropped_count() > dropped_before, "redraw {seed} lost nothing");
        assert_eq!(s.model().published.len(), before + 1, "redraw {seed}");
        // The held screen waited a repair round trip, and selective ACKs kept
        // flowing to the daemon the whole time.
        assert!(
            s.model().acks_while_pending > acks_before,
            "redraw {seed}: ACKs must keep flowing while the screen is held"
        );
        s.assert_final_published(&format!("repaired redraw {seed}"));
    }
    s.assert_publications_complete("repaired");
    assert!(s.partial_deadline_exposures() > 0);
}

#[tokio::test(flavor = "current_thread")]
async fn a_lost_final_member_is_repaired_and_published_once() {
    let mut s = Session::new(100, 32, 60.0);
    for seed in 1..=3 {
        s.viewers.viewer(&s.peer.clone()).closure.lose_next_claimed_end = true;
        let before = s.model().published.len();
        s.redraw(seed, false);
        s.settle(10_000.0, None).await;
        assert_eq!(s.model().claimed_ends_lost, seed as usize, "redraw {seed} lost its END");
        assert_eq!(s.model().published.len(), before + 1, "redraw {seed}");
        s.assert_final_published(&format!("END-lost redraw {seed}"));
    }
    s.assert_publications_complete("END lost");
}

#[tokio::test(flavor = "current_thread")]
async fn a_daemon_resize_retires_the_claim_and_the_next_redraw_publishes_once() {
    let mut s = Session::new(80, 24, 20.0);
    s.redraw(1, false);
    s.settle(10_000.0, None).await;
    // The step `main.rs` takes after the resize ioctl, which owes every viewer
    // the geometry snapshot; the browser has already reflowed its own grid.
    let cell = merkur_graphics::geometry::CellMetrics::new(8 << 16, 16 << 16);
    s.sim.commit_viewport(crate::pty::Viewport {
        cols: 90,
        rows: 30,
        seq: 1,
        geometry_generation: 1,
        cell,
        pixel_width: 90 * 8,
        pixel_height: 30 * 16,
    });
    s.viewers.resize(90, 30);
    s.rows = 30;
    assert_eq!(s.sim.completed_sync_update_epoch(), 0, "a resize ends the declared frame");
    s.settle(10_000.0, None).await;
    assert!(!s.model().pending, "the snapshot claims nothing");
    let before = s.model().published.len();
    s.redraw(2, false);
    s.settle(10_000.0, None).await;
    assert_eq!(s.model().published.len(), before + 1);
    s.assert_final_published("after resize");
    s.assert_publications_complete("resize");
}

#[tokio::test(flavor = "current_thread")]
async fn reordered_and_duplicated_members_publish_once() {
    let mut s = Session::new(100, 32, 30.0);
    s.viewers.disturb_display_units(UnitDisturbance {
        seed: 0x5eed_c105,
        loss_pct: 0,
        duplicate_pct: 30,
        reorder_pct: 50,
    });
    for seed in 1..=4 {
        let before = s.model().published.len();
        s.redraw(seed, false);
        s.settle(10_000.0, None).await;
        assert_eq!(s.model().published.len(), before + 1, "redraw {seed}");
        s.assert_final_published(&format!("reordered redraw {seed}"));
    }
    let disturbed = &s.viewers.viewer(&s.peer.clone()).disturbed;
    assert!(disturbed.reordered.units > 0 && disturbed.duplicated.units > 0);
    s.assert_publications_complete("reordered");
}

#[tokio::test(flavor = "current_thread")]
async fn a_superseded_redraw_never_publishes_a_mixture() {
    let mut s = Session::new(100, 32, 20.0);
    // Superseded before any of it was captured.
    s.redraw(1, false);
    s.redraw(2, false);
    s.settle(10_000.0, None).await;
    s.assert_final_published("superseded before capture");
    // Superseded after it reached the carrier and lost members: its repair
    // is a round trip away when the next complete frame is written.
    drop_run_after_next_admission(&mut s, 8);
    s.redraw(3, false);
    let interrupted = s.complete.last().cloned().expect("redraw 3");
    s.frame(None).await;
    s.redraw(4, false);
    s.settle(10_000.0, None).await;
    s.assert_final_published("superseded mid transmission");
    s.assert_publications_complete("superseded");
    assert!(
        !s.model().published.iter().any(|(_, screen)| screen == &interrupted),
        "the interrupted redraw never completed, so it is never shown"
    );
    // Control: its received prefix mixed with the old screen was on the grid.
    assert!(s.partial_deadline_exposures() > 0);
}

#[tokio::test(flavor = "current_thread")]
async fn output_after_the_end_claims_nothing() {
    let mut s = Session::new(80, 24, 0.0);
    s.redraw(1, false);
    s.settle(5_000.0, None).await;
    let published = s.model().published.len();
    // Ordinary output after ESU: no application declared this state final.
    let (cols, rows) = s.sim.terminal_dimensions();
    let mut bytes = sync_frame(2, cols, rows, false);
    bytes.extend_from_slice(b"ordinary");
    s.sim.write_pty(&bytes);
    assert_eq!(s.sim.completed_sync_update_epoch(), 0);
    let unclaimed = s.model().unclaimed_applies;
    s.settle(5_000.0, None).await;
    assert!(s.model().unclaimed_applies > unclaimed);
    assert!(!s.model().pending);
    assert_eq!(s.model().published.len(), published, "an unclaimed state is not a closure");
}

#[tokio::test(flavor = "current_thread")]
async fn grants_on_the_frame_clock_finish_a_held_redraw() {
    // Presentation-bounded delivery: every new state needs a browser grant,
    // and the browser issues grants on animation frames, not on commits.
    let mut s = Session::new(100, 32, 60.0);
    s.sim.use_explicit_demand();
    s.sim.set_loss(10, 0x9a17_0001);
    let mut browser = LoopBrowser::new(&s.peer, FRAME_MS, 60.0, true);
    for seed in 1..=6 {
        s.redraw(seed, false);
        s.settle(20_000.0, Some(&mut browser)).await;
        s.assert_final_published(&format!("granted redraw {seed}"));
    }
    s.assert_publications_complete("granted");
    assert!(s.sim.dropped_count() > 0);
    assert!(s.model().held_applies > 0);
}

/// Continuous synchronized animation over lossy paths: every screen shown is
/// one the application drew, and the last one is always shown.
#[tokio::test(flavor = "current_thread")]
async fn lossy_animation_never_publishes_a_partial_screen() {
    let mut totals = (0usize, 0usize, 0usize, 0usize);
    for loss in [3u32, 10, 30] {
        for seed in 0..6u64 {
            let mut s = Session::new(100, 32, 60.0);
            s.sim.set_loss(loss, 0xc105_0000 + seed);
            for frame in 0..24u64 {
                s.redraw(seed * 1_000 + frame, false);
                for _ in 0..2 {
                    s.frame(None).await;
                }
            }
            s.settle(30_000.0, None).await;
            let context = format!("loss={loss}% seed={seed}");
            s.assert_publications_complete(&context);
            s.assert_final_published(&context);
            totals.0 += s.model().published.len();
            totals.1 += 24;
            totals.2 += s.partial_deadline_exposures();
            totals.3 += s.sim.dropped_count();
        }
    }
    eprintln!(
        "CLOSURE_ANIMATION published={} redraws={} control_partial={} dropped={}",
        totals.0, totals.1, totals.2, totals.3
    );
    assert!(totals.3 > 0, "the loss model dropped nothing");
    assert!(totals.2 > 0, "the control exposed no partial screen; the faults are vacuous");
}

/// Mutation control for the oracle itself: a claim that names a different
/// screen is never satisfied, and a publication that is not a drawn screen is
/// caught by the assertion every scenario above relies on.
#[tokio::test(flavor = "current_thread")]
async fn the_oracle_rejects_a_wrong_claim_and_a_partial_publication() {
    let mut s = Session::new(80, 24, 0.0);
    s.redraw(1, false);
    s.settle(5_000.0, None).await;
    let (claim, _) = s.model().published.last().cloned().expect("published");
    let viewer = s.viewers.viewer(&s.peer.clone());
    assert!(
        viewer
            .terminal
            .closure_digest_matches((claim >> 32) as u32, claim as u32)
    );
    let flipped = claim ^ 1;
    assert!(
        !viewer
            .terminal
            .closure_digest_matches((flipped >> 32) as u32, flipped as u32)
    );
    assert!(!viewer.terminal.closure_digest_matches(0, 0));
    let partial = vec![0u64; 24];
    s.model().published.push((claim, partial));
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        s.assert_publications_complete("mutated");
    }));
    assert!(caught.is_err(), "a partial publication must fail the oracle");
}
