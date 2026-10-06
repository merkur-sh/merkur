//! The terminal worker's presentation release rule, run by the client core's
//! own [`PresentationCoordinator`]: when does the applied grid reach the
//! renderer.
//!
//! The harness feeds the coordinator what `Viewer::apply_owned` feeds it:
//! every applied frame as a member, visual or not, the release a completed
//! member allows at once, and one early commit per animation frame for a held
//! transaction that may close before it. The GPU is taken as idle, so an early
//! commit is refused only by a frame whose opportunity is already spent.
//! Closure claims are not fed here; the harness runs its own closure oracle
//! beside this rule.

use std::collections::BTreeSet;

use merkur_client::viewer::presentation::{
    Application, ApplyAction, Member, PresentationCoordinator, Release,
};
use merkur_codec::FrameHeader;

/// The refresh period of the display the harness presents to. The
/// coordinator's hold counts animation frames; the period only anchors the
/// transaction's telemetry deadline.
const REFRESH_PERIOD_MS: f64 = 1000.0 / 60.0;

/// One renderer commit and the grid it showed.
#[derive(Clone, Debug)]
pub(crate) struct SimCommit {
    pub(crate) at_ms: f64,
    /// Committed inside the task that applied it rather than at a frame.
    pub(crate) early: bool,
    pub(crate) reason: Release,
    /// Distinct demand serials of the visual states this commit carried.
    pub(crate) states: usize,
    pub(crate) screen: Vec<u64>,
}

pub(crate) struct SimPresentation {
    /// Honour `PATCH_FLAG_DEMAND_AWAITS_GRANT`. Off, members reach the
    /// coordinator without it, which leaves the frame rule alone: the test
    /// control.
    pub(crate) paced: bool,
    coordinator: PresentationCoordinator,
    /// Demand serials of the visual states applied since the last commit.
    serials: BTreeSet<u32>,
    /// No early commit yet since this frame began; the frame's own commit
    /// does not spend it.
    opportunity: bool,
    pub(crate) commits: Vec<SimCommit>,
}

impl SimPresentation {
    /// A viewer already holding `generation`'s grid.
    pub(crate) fn new(generation: u32) -> Self {
        Self {
            paced: true,
            coordinator: PresentationCoordinator::new(generation),
            serials: BTreeSet::new(),
            opportunity: true,
            commits: Vec::new(),
        }
    }

    /// A snapshot of `generation` applied: it roots the ledger and closes the
    /// transaction it replaced, before it joins one of its own.
    pub(crate) fn root(&mut self, generation: u32) {
        self.coordinator.adopt_generation(generation);
        self.serials.clear();
    }

    /// One applied frame of `generation`, its newest sequence `seq` carrying
    /// `rows` rows. Returns the release it causes now; the caller then records
    /// the grid with [`Self::commit`].
    pub(crate) fn applied(
        &mut self,
        header: &FrameHeader,
        generation: u32,
        seq: u32,
        rows: u32,
        visual: bool,
        now_ms: f64,
    ) -> Option<Release> {
        let member = Member {
            presentation_id: header.presentation_id,
            coherent: header.presentation_coherent,
            end: header.presentation_end,
            member_index: header.presentation_member_index,
            member_count: header.presentation_member_count,
            display_seq: seq,
            generation,
            row_predecessor_presentation_id: header.row_predecessor_presentation_id,
            row_bearing: rows > 0,
            demand_serial: header.demand_serial,
            awaits_grant: self.paced && header.demand_awaits_grant,
        };
        if !visual {
            self.coordinator.note_nonvisual_applied(&member);
            return None;
        }
        self.serials.insert(header.demand_serial);
        // Input coverage, bytes and queue depth are transaction telemetry the
        // release rule never reads.
        let application = Application {
            now_ms,
            refresh_period_ms: REFRESH_PERIOD_MS,
            input_seq: 0,
            echo_horizon: 0,
            rows,
            bytes: 0,
            queued_frames: 0,
        };
        if self.coordinator.note_applied(&application, &member) == ApplyAction::Now {
            return Some(self.coordinator.last_release_reason());
        }
        let completed = self.coordinator.release_completed_at_pump();
        if completed != Release::None {
            return Some(completed);
        }
        if self.opportunity
            && self.coordinator.early_release_eligible()
            && self.coordinator.with_early_release(|| true)
        {
            self.opportunity = false;
            return Some(self.coordinator.last_release_reason());
        }
        None
    }

    /// One animation frame at `frame_ms`.
    pub(crate) fn frame(&mut self, frame_ms: f64) -> Option<Release> {
        self.opportunity = true;
        if !self.coordinator.is_held() {
            return None;
        }
        match self.coordinator.release_at_frame(frame_ms) {
            Release::None => None,
            reason => Some(reason),
        }
    }

    /// The renderer took the grid `screen` at `at_ms`.
    pub(crate) fn commit(&mut self, at_ms: f64, reason: Release, early: bool, screen: Vec<u64>) {
        self.commits.push(SimCommit {
            at_ms,
            early,
            reason,
            states: self.serials.len().max(1),
            screen,
        });
        self.coordinator.consume_committed();
        self.serials.clear();
    }
}
