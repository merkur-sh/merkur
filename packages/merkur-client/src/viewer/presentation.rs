//! Presentation transactions: when the terminal state a viewer applied may
//! reach the screen. The port of `presentation-coordinator.ts`.
//!
//! Application and the selective ACK happen before this is consulted; it
//! decides only when accumulated state is shown. The sender's member
//! index/count is advice: complete membership and its row-predecessor closure
//! may end a hold early, while missing, malformed or overflowed advice falls
//! back to the two-frame bound. Nothing here can reject a grid
//! transformation, delay its ACK, or ask for a resync.
//!
//! Membership lives in a small ledger apart from the transaction. A partial
//! group may commit at its bound and keep the slots it applied, so a late
//! final slot releases the unavoidable second commit at once instead of
//! buying another refresh period.
//!
//! A paced transaction closes on arrival: when the daemon sent its newest
//! state with no grant left to send another (the awaits-grant flag), nothing
//! newer leaves the daemon until a grant reaches it, and waiting only shows an
//! older state for longer. Whether an unsynchronized application finished its
//! redraw is not on the wire; synchronized output says so through closure.

use merkur_codec::MAX_TERMINAL_ROWS;

use super::display_serial_is_newer;

/// What an applied visual frame asks of the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyAction {
    /// Show it at the earliest opportunity.
    Now,
    /// A transaction started holding.
    HoldStarted,
    /// It joined the held transaction.
    Held,
}

/// Why a transaction reached the screen, or `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Release {
    None,
    EndQuiet,
    Deadline,
    Urgent,
    MembershipComplete,
    ClosureComplete,
    PacedComplete,
}

/// The newest applied frame's complete-screen claim, as last evaluated
/// against the grid. `Pending`: the daemon declared the newest state a complete
/// application frame and the grid does not digest to it yet, so nothing
/// releases, however long the missing rows take. `Met`: the grid is exactly
/// that frame; release at the first opportunity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Closure {
    None,
    Pending,
    Met,
}

/// Why membership could not release a transaction: stable bits shared with
/// the browser's `presentation_commit` telemetry.
pub const DISABLE_INCOMPLETE: u32 = 1 << 0;
pub const DISABLE_PREDECESSOR: u32 = 1 << 1;
pub const DISABLE_END: u32 = 1 << 2;
pub const DISABLE_POISONED: u32 = 1 << 3;
pub const DISABLE_CAPACITY: u32 = 1 << 4;
pub const DISABLE_RETIRED_VISUAL: u32 = 1 << 5;
pub const DISABLE_SERIAL: u32 = 1 << 6;
pub const DISABLE_INHERITED_SERIAL: u32 = 1 << 7;

/// Animation frames a hold may consume before it releases anyway. Two,
/// because the first can land microseconds after the hold started; only the
/// second guarantees one whole frame interval of collection. Counting
/// delivered frames rather than an estimated period is the point: a timer
/// cannot observe a frame the display never produced.
pub const HOLD_FRAMES: u32 = 2;

/// Mirrored from `FASTEST_SUPPORTED_REFRESH_PERIOD_MS`: the period a hold is
/// stamped with when the host reports none.
const FALLBACK_REFRESH_PERIOD_MS: f64 = 1_000.0 / 480.0;

/// Resource bound: fixed group slots, each owning a whole row's worth of
/// member identities, so two interleaved full-height redraws cannot evict one
/// another before either arrives. Allocated once per viewer.
const GROUP_CAPACITY: usize = 64;
const WORDS_PER_GROUP: usize = MAX_TERMINAL_ROWS.div_ceil(32);

const FLAG_ACTIVE: u16 = 1 << 0;
const FLAG_POISONED: u16 = 1 << 1;
const FLAG_END_APPLIED: u16 = 1 << 2;
/// The group received a frame since the last transaction was consumed. Not
/// the same as seen > applied: a complete header-only END group may apply
/// before the first visual member and must still close that transaction.
const FLAG_OBSERVED_SINCE_COMMIT: u16 = 1 << 3;
const FLAG_METADATA_OBSERVED: u16 = 1 << 4;
const FLAG_COHERENT: u16 = 1 << 5;
const FLAG_SINGLETON_APPLIED: u16 = 1 << 6;
const FLAG_VISUAL_PROBE: u16 = 1 << 7;
const FLAG_ROW_BEARING: u16 = 1 << 8;
const FLAG_DEPENDENCY_SPENT: u16 = 1 << 9;
const FLAG_ORIGINAL_OBSERVED: u16 = 1 << 10;
/// Demand was recorded from an applied member, and every applied member said,
/// under one serial, that nothing newer follows without a grant. Members that
/// disagree drop the flag: it fails closed.
const FLAG_DEMAND_OBSERVED: u16 = 1 << 11;
const FLAG_AWAITS_GRANT: u16 = 1 << 12;

/// One frame's presentation advice, from its authenticated header.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Member {
    pub presentation_id: u32,
    pub coherent: bool,
    pub end: bool,
    pub member_index: u16,
    pub member_count: u16,
    pub display_seq: u32,
    pub generation: u32,
    pub row_predecessor_presentation_id: u32,
    /// Whether the frame carries rows; an applied frame's own row count says.
    pub row_bearing: bool,
    /// The grant its state consumed, and whether nothing newer follows
    /// without another. Read from applied frames only.
    pub demand_serial: u32,
    pub awaits_grant: bool,
}

/// One visual application, as the host measured it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Application {
    pub now_ms: f64,
    pub refresh_period_ms: f64,
    pub input_seq: u32,
    /// The newest input these pixels could answer: the frame's echo horizon.
    pub echo_horizon: u32,
    pub rows: u32,
    pub bytes: u64,
    pub queued_frames: u32,
}

/// Where an observed member landed in the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Observed {
    Group(usize),
    Invalid,
    Retired,
    DependencyRetired,
    InvalidDependency,
}

impl Observed {
    fn group(self) -> Option<usize> {
        match self {
            Self::Group(group) => Some(group),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Disposition {
    Nonmember,
    Member,
    Invalid,
}

/// `classifyDisplayPresentationMember`: `0/0` is the deliberate nonmember
/// sentinel of urgent frames, snapshots, FEC parity and evidence probes.
fn classify_member(index: u16, count: u16) -> Disposition {
    if index == 0 && count == 0 {
        Disposition::Nonmember
    } else if count == 0 || usize::from(count) > MAX_TERMINAL_ROWS || index >= count {
        Disposition::Invalid
    } else {
        Disposition::Member
    }
}

fn normalized_refresh_period(period_ms: f64) -> f64 {
    if period_ms.is_finite() && period_ms > 0.0 {
        period_ms
    } else {
        FALLBACK_REFRESH_PERIOD_MS
    }
}

pub struct PresentationCoordinator {
    active_generation: u32,
    group_presentation_id: [u32; GROUP_CAPACITY],
    group_member_count: [u16; GROUP_CAPACITY],
    group_seen_count: [u16; GROUP_CAPACITY],
    group_applied_count: [u16; GROUP_CAPACITY],
    group_flags: [u16; GROUP_CAPACITY],
    group_row_predecessor: [u32; GROUP_CAPACITY],
    group_transaction_epoch: [u32; GROUP_CAPACITY],
    group_dependency_epoch: [u32; GROUP_CAPACITY],
    group_predecessor_linked_epoch: [u32; GROUP_CAPACITY],
    group_serial_audit_epoch: [u32; GROUP_CAPACITY],
    group_demand_serial: [u32; GROUP_CAPACITY],
    member_display_seq: Box<[u32]>,
    member_applied_bits: Box<[u32]>,
    member_end_bits: Box<[u32]>,
    ledger_group_count: usize,
    capacity_reset_count: u32,
    /// Bounded serial tombstone: a late frame at or behind it can never
    /// recreate a complete group; strictly newer ids stay eligible.
    retired_through: u32,
    retirement_fail_closed: bool,
    /// Advances only when a transaction commits, or its bound spends a
    /// missing row dependency. Capacity eviction alone never turns unknown
    /// predecessor state into presentation authority.
    dependency_satisfied_through: u32,

    pending: bool,
    held: bool,
    held_frames: u32,
    last_counted_frame_ms: f64,
    /// When the hold began, on the frame clock: an older frame is one this
    /// transaction never collected through.
    held_since_ms: f64,
    /// A released transaction never re-holds; a later member joins the commit
    /// in flight.
    released_for_commit: bool,
    deadline: f64,
    closure: Closure,
    period: f64,
    first_applied: f64,
    last_applied: f64,
    first_id: u32,
    latest_id: u32,
    newest_coherent_id: u32,
    first_seq: u32,
    last_seq: u32,
    input_high_water: u32,
    echo_high_water: u32,
    count: u32,
    row_count: u64,
    byte_count: u64,
    includes_coherent: bool,
    saw_newest_end: bool,
    queued_high_water: u32,
    release_reason: Release,
    release_frame_time: f64,
    transaction_epoch: u32,
    transaction_group_count: usize,
    newest_transaction_group: Option<usize>,
    transaction_disable_bits: u32,
    release_disable_bits: u32,
    serial_failure_owner: u32,
    unattached_disable_bits: u32,
}

impl PresentationCoordinator {
    pub fn new(initial_generation: u32) -> Self {
        Self {
            active_generation: initial_generation,
            group_presentation_id: [0; GROUP_CAPACITY],
            group_member_count: [0; GROUP_CAPACITY],
            group_seen_count: [0; GROUP_CAPACITY],
            group_applied_count: [0; GROUP_CAPACITY],
            group_flags: [0; GROUP_CAPACITY],
            group_row_predecessor: [0; GROUP_CAPACITY],
            group_transaction_epoch: [0; GROUP_CAPACITY],
            group_dependency_epoch: [0; GROUP_CAPACITY],
            group_predecessor_linked_epoch: [0; GROUP_CAPACITY],
            group_serial_audit_epoch: [0; GROUP_CAPACITY],
            group_demand_serial: [0; GROUP_CAPACITY],
            member_display_seq: vec![0; GROUP_CAPACITY * MAX_TERMINAL_ROWS].into_boxed_slice(),
            member_applied_bits: vec![0; GROUP_CAPACITY * WORDS_PER_GROUP].into_boxed_slice(),
            member_end_bits: vec![0; GROUP_CAPACITY * WORDS_PER_GROUP].into_boxed_slice(),
            ledger_group_count: 0,
            capacity_reset_count: 0,
            retired_through: 0,
            retirement_fail_closed: false,
            dependency_satisfied_through: 0,
            pending: false,
            held: false,
            held_frames: 0,
            last_counted_frame_ms: f64::NEG_INFINITY,
            held_since_ms: 0.0,
            released_for_commit: false,
            deadline: 0.0,
            closure: Closure::None,
            period: FALLBACK_REFRESH_PERIOD_MS,
            first_applied: 0.0,
            last_applied: 0.0,
            first_id: 0,
            latest_id: 0,
            newest_coherent_id: 0,
            first_seq: 0,
            last_seq: 0,
            input_high_water: 0,
            echo_high_water: 0,
            count: 0,
            row_count: 0,
            byte_count: 0,
            includes_coherent: false,
            saw_newest_end: false,
            queued_high_water: 0,
            release_reason: Release::None,
            release_frame_time: 0.0,
            transaction_epoch: 0,
            transaction_group_count: 0,
            newest_transaction_group: None,
            transaction_disable_bits: 0,
            release_disable_bits: 0,
            serial_failure_owner: 0,
            unattached_disable_bits: 0,
        }
    }

    fn next_transaction_epoch(&mut self) {
        self.transaction_epoch = self.transaction_epoch.wrapping_add(1);
        if self.transaction_epoch == 0 {
            self.group_transaction_epoch.fill(0);
            self.group_dependency_epoch.fill(0);
            self.group_predecessor_linked_epoch.fill(0);
            self.group_serial_audit_epoch.fill(0);
            self.transaction_epoch = 1;
        }
    }

    fn clear_transaction(&mut self) {
        self.pending = false;
        self.held = false;
        self.held_frames = 0;
        self.last_counted_frame_ms = f64::NEG_INFINITY;
        self.held_since_ms = 0.0;
        self.released_for_commit = false;
        self.deadline = 0.0;
        self.period = FALLBACK_REFRESH_PERIOD_MS;
        self.first_applied = 0.0;
        self.last_applied = 0.0;
        self.first_id = 0;
        self.latest_id = 0;
        self.newest_coherent_id = 0;
        self.first_seq = 0;
        self.last_seq = 0;
        self.input_high_water = 0;
        self.echo_high_water = 0;
        self.count = 0;
        self.row_count = 0;
        self.byte_count = 0;
        self.includes_coherent = false;
        self.saw_newest_end = false;
        self.queued_high_water = 0;
        self.release_reason = Release::None;
        self.release_frame_time = 0.0;
        self.transaction_group_count = 0;
        self.newest_transaction_group = None;
        self.transaction_disable_bits = 0;
        self.release_disable_bits = 0;
    }

    fn clear_ledger(&mut self) {
        self.group_flags.fill(0);
        self.group_transaction_epoch.fill(0);
        self.group_dependency_epoch.fill(0);
        self.group_predecessor_linked_epoch.fill(0);
        self.group_serial_audit_epoch.fill(0);
        self.ledger_group_count = 0;
        self.retired_through = 0;
        self.retirement_fail_closed = false;
        self.serial_failure_owner = 0;
        self.dependency_satisfied_through = 0;
        self.unattached_disable_bits = 0;
    }

    fn mark_serial_failure(&mut self) {
        if !self.retirement_fail_closed {
            self.serial_failure_owner = if self.pending {
                self.transaction_epoch
            } else {
                match self.transaction_epoch.wrapping_add(1) {
                    0 => 1,
                    next => next,
                }
            };
        }
        self.retirement_fail_closed = true;
    }

    fn advance_retired_through(&mut self, presentation_id: u32) {
        if presentation_id == 0 {
            return;
        }
        if self.retired_through == 0
            || display_serial_is_newer(presentation_id, self.retired_through)
        {
            self.retired_through = presentation_id;
        }
    }

    fn was_serially_retired(&self, presentation_id: u32) -> bool {
        presentation_id != 0
            && self.retired_through != 0
            && !display_serial_is_newer(presentation_id, self.retired_through)
    }

    fn advance_dependency_satisfied_through(&mut self, presentation_id: u32) {
        if presentation_id == 0 {
            return;
        }
        if self.dependency_satisfied_through == 0
            || display_serial_is_newer(presentation_id, self.dependency_satisfied_through)
        {
            self.dependency_satisfied_through = presentation_id;
        }
    }

    fn dependency_was_satisfied(&self, presentation_id: u32) -> bool {
        if presentation_id.wrapping_sub(self.dependency_satisfied_through) == 0x8000_0000 {
            return false;
        }
        presentation_id != 0
            && self.dependency_satisfied_through != 0
            && !display_serial_is_newer(presentation_id, self.dependency_satisfied_through)
    }

    fn deactivate_group(&mut self, group: usize) {
        self.group_flags[group] = 0;
        self.group_row_predecessor[group] = 0;
        self.group_transaction_epoch[group] = 0;
        self.group_dependency_epoch[group] = 0;
        self.group_predecessor_linked_epoch[group] = 0;
        self.group_serial_audit_epoch[group] = 0;
        self.ledger_group_count -= 1;
    }

    /// Once the screen took a transaction, every fully applied, unpoisoned
    /// group in it is shown, clipped non-END prefixes included. Tombstone them
    /// so late no-op replicas cannot recreate partial groups and hold the next
    /// redraw. A greedy serial maximum is not an ordering proof, so a
    /// half-range or cyclic set retires nothing.
    fn retire_committed_ledger_groups(&mut self) {
        let commit_order_valid = self.transaction_serial_order_valid();
        if !commit_order_valid {
            self.mark_serial_failure();
        }
        if commit_order_valid && self.latest_id != 0 && self.find_group(self.latest_id).is_none() {
            // The state this commit showed, whose advisory slot a capacity
            // reset discarded. A retained partial group keeps its late-tail
            // optimization and is not spent here.
            self.advance_dependency_satisfied_through(self.latest_id);
        }
        for group in 0..GROUP_CAPACITY {
            let flags = self.group_flags[group];
            let live = flags & (FLAG_ACTIVE | FLAG_POISONED) == FLAG_ACTIVE;
            if commit_order_valid
                && live
                && self.group_transaction_epoch[group] == self.transaction_epoch
                && self.group_own_applied_complete(group)
            {
                self.advance_retired_through(self.group_presentation_id[group]);
                self.advance_dependency_satisfied_through(self.group_presentation_id[group]);
            }
            if commit_order_valid
                && live
                && self.group_dependency_epoch[group] == self.transaction_epoch
            {
                // The transaction's bound is also the missing-predecessor
                // bound: once shown, later successors must not pay forever for
                // the same absent row lineage. A delayed predecessor stays
                // state-valid but never regains early timing authority.
                self.group_flags[group] = flags | FLAG_DEPENDENCY_SPENT;
                self.advance_dependency_satisfied_through(self.group_presentation_id[group]);
            }
        }
        for group in 0..GROUP_CAPACITY {
            let flags = self.group_flags[group];
            if flags & FLAG_ACTIVE == 0 {
                continue;
            }
            let id = self.group_presentation_id[group];
            if self.was_serially_retired(id)
                || (flags & FLAG_DEPENDENCY_SPENT != 0 && self.dependency_was_satisfied(id))
            {
                self.deactivate_group(group);
            } else {
                self.group_flags[group] = flags & !FLAG_OBSERVED_SINCE_COMMIT;
                self.group_transaction_epoch[group] = 0;
                self.group_dependency_epoch[group] = 0;
            }
        }
    }

    fn disable_eligibility(&mut self, group: Option<usize>) {
        if let Some(group) = group {
            self.group_flags[group] |= FLAG_POISONED | FLAG_OBSERVED_SINCE_COMMIT;
        }
    }

    /// Capacity loss disables only the transaction whose evidence was lost.
    fn reset_ledger_for_capacity(&mut self) {
        if self.pending {
            self.transaction_disable_bits |= DISABLE_CAPACITY;
        } else {
            self.unattached_disable_bits |= DISABLE_CAPACITY;
        }
        let mut newest = 0u32;
        for group in 0..GROUP_CAPACITY {
            if self.group_flags[group] & FLAG_ACTIVE == 0 {
                continue;
            }
            let id = self.group_presentation_id[group];
            if newest == 0 || display_serial_is_newer(id, newest) {
                newest = id;
            }
        }
        let serial_set_valid = (0..GROUP_CAPACITY).all(|group| {
            let id = self.group_presentation_id[group];
            self.group_flags[group] & FLAG_ACTIVE == 0
                || id == newest
                || display_serial_is_newer(newest, id)
        });
        if serial_set_valid {
            self.advance_retired_through(newest);
        } else {
            self.mark_serial_failure();
        }
        self.group_flags.fill(0);
        self.group_transaction_epoch.fill(0);
        self.group_dependency_epoch.fill(0);
        self.group_predecessor_linked_epoch.fill(0);
        self.group_serial_audit_epoch.fill(0);
        self.ledger_group_count = 0;
        self.capacity_reset_count += 1;
        self.transaction_group_count = 0;
        self.newest_transaction_group = None;
    }

    fn find_group(&self, presentation_id: u32) -> Option<usize> {
        (0..GROUP_CAPACITY).rev().find(|&group| {
            self.group_flags[group] & FLAG_ACTIVE != 0
                && self.group_presentation_id[group] == presentation_id
        })
    }

    fn allocate_group(&mut self, presentation_id: u32, member_count: u16) -> usize {
        if self.ledger_group_count >= GROUP_CAPACITY {
            self.reset_ledger_for_capacity();
        }
        let group =
            match (0..GROUP_CAPACITY).find(|&group| self.group_flags[group] & FLAG_ACTIVE == 0) {
                Some(group) => group,
                // A reset above always frees a slot; this keeps a future bound
                // change failing closed.
                None => {
                    self.reset_ledger_for_capacity();
                    0
                }
            };
        let member_base = group * MAX_TERMINAL_ROWS;
        let word_base = group * WORDS_PER_GROUP;
        self.ledger_group_count += 1;
        self.group_presentation_id[group] = presentation_id;
        self.group_member_count[group] = member_count;
        self.group_seen_count[group] = 0;
        self.group_applied_count[group] = 0;
        self.group_flags[group] = FLAG_ACTIVE;
        self.group_row_predecessor[group] = 0;
        self.group_transaction_epoch[group] = 0;
        self.group_dependency_epoch[group] = 0;
        self.group_predecessor_linked_epoch[group] = 0;
        self.group_serial_audit_epoch[group] = 0;
        self.group_demand_serial[group] = 0;
        // A reused slot must not keep its previous occupant's identities: a
        // placeholder upgraded to real membership would inherit them.
        self.member_display_seq[member_base..member_base + MAX_TERMINAL_ROWS].fill(0);
        self.member_applied_bits[word_base..word_base + WORDS_PER_GROUP].fill(0);
        self.member_end_bits[word_base..word_base + WORDS_PER_GROUP].fill(0);
        group
    }

    fn group_own_applied_complete(&self, group: usize) -> bool {
        let flags = self.group_flags[group];
        if flags & FLAG_METADATA_OBSERVED == 0 {
            return false;
        }
        let member_count = self.group_member_count[group];
        if member_count > 0 {
            return self.group_applied_count[group] == member_count;
        }
        flags & FLAG_COHERENT == 0 && flags & FLAG_SINGLETON_APPLIED != 0
    }

    /// Observe one authenticated frame's advisory metadata.
    fn observe_member(
        &mut self,
        member: &Member,
        applied: bool,
        visually_changed: bool,
    ) -> Observed {
        // Generation authority precedes even malformed metadata; frames ahead
        // are observed again once their snapshot adopts the generation.
        if member.generation != self.active_generation || self.active_generation == 0 {
            return Observed::Retired;
        }
        let disposition = classify_member(member.member_index, member.member_count);
        let id = member.presentation_id;
        let predecessor = member.row_predecessor_presentation_id;
        // RFC 1982 leaves exactly half the range unordered. It is not an old
        // no-op: retiring it silently could let a later END forget a group.
        if self.retired_through != 0 && id.wrapping_sub(self.retired_through) == 0x8000_0000 {
            self.mark_serial_failure();
        }
        if self.dependency_satisfied_through != 0
            && id.wrapping_sub(self.dependency_satisfied_through) == 0x8000_0000
        {
            self.mark_serial_failure();
        }
        if self.retirement_fail_closed {
            return Observed::Invalid;
        }
        // A delayed duplicate or FEC original of a committed group can neither
        // recreate membership nor, as a no-op, poison the next redraw.
        if self.was_serially_retired(id) {
            return Observed::Retired;
        }
        if self.dependency_was_satisfied(id) {
            return Observed::DependencyRetired;
        }

        let valid_shape = if member.coherent {
            disposition != Disposition::Invalid
        } else {
            disposition == Disposition::Nonmember
        };
        let valid_dependency =
            predecessor == 0 || (predecessor != id && display_serial_is_newer(id, predecessor));
        let coherent_probe = member.coherent && disposition == Disposition::Nonmember;
        if !valid_shape || id == 0 || member.display_seq == 0 {
            // Keep a keyed poison tombstone for authenticated coherent
            // metadata, so later frames of the same id cannot allocate a fresh
            // group and regain early eligibility.
            let mut invalid = self.find_group(id);
            if invalid.is_none() && id != 0 {
                invalid = Some(self.allocate_group(id, 0));
            }
            self.disable_eligibility(invalid);
            return Observed::Invalid;
        }

        let group = match self.find_group(id) {
            Some(group) => group,
            None => self.allocate_group(
                id,
                if member.coherent && disposition == Disposition::Member {
                    member.member_count
                } else {
                    0
                },
            ),
        };

        let flags_before = self.group_flags[group];
        let observed_flags = (if coherent_probe {
            0
        } else {
            FLAG_ORIGINAL_OBSERVED
        }) | (if !coherent_probe && member.coherent {
            FLAG_COHERENT
        } else {
            0
        }) | (if member.row_bearing {
            FLAG_ROW_BEARING
        } else {
            0
        });
        if flags_before & FLAG_METADATA_OBSERVED == 0 {
            self.group_row_predecessor[group] = predecessor;
            // A placeholder already in the transaction may reveal another
            // ancestor with its metadata: link it once more.
            self.group_predecessor_linked_epoch[group] = 0;
            self.group_flags[group] = flags_before | FLAG_METADATA_OBSERVED | observed_flags;
        } else if self.group_row_predecessor[group] != predecessor {
            self.disable_eligibility(Some(group));
            return Observed::InvalidDependency;
        } else {
            if !coherent_probe
                && flags_before & FLAG_ORIGINAL_OBSERVED != 0
                && (flags_before & FLAG_COHERENT != 0) != member.coherent
            {
                self.disable_eligibility(Some(group));
                return Observed::InvalidDependency;
            }
            self.group_flags[group] = flags_before | observed_flags;
        }

        if !valid_dependency {
            self.disable_eligibility(Some(group));
            return Observed::InvalidDependency;
        }

        // Coherent single-shard evidence probes carry the protected id with
        // 0/0: dependency metadata, but neither a missing member nor proof of
        // the original's completeness.
        if coherent_probe {
            self.group_flags[group] |= FLAG_OBSERVED_SINCE_COMMIT;
            if applied && visually_changed {
                self.group_flags[group] |= FLAG_VISUAL_PROBE;
            }
            return Observed::Group(group);
        }

        if member.coherent && disposition == Disposition::Member {
            let expected = self.group_member_count[group];
            if expected == 0 {
                self.group_member_count[group] = member.member_count;
            } else if expected != member.member_count {
                self.disable_eligibility(Some(group));
                return Observed::Invalid;
            }
        }

        if !member.coherent {
            self.group_flags[group] |= FLAG_OBSERVED_SINCE_COMMIT;
            if applied {
                self.group_flags[group] |= FLAG_SINGLETON_APPLIED;
            }
            return Observed::Group(group);
        }

        let index = usize::from(member.member_index);
        let slot = group * MAX_TERMINAL_ROWS + index;
        let word = group * WORDS_PER_GROUP + (index >> 5);
        let mask = 1u32 << (index & 31);
        let previous_seq = self.member_display_seq[slot];
        let previous_end = self.member_end_bits[word] & mask != 0;
        if previous_seq == 0 {
            self.member_display_seq[slot] = member.display_seq;
            if member.end {
                self.member_end_bits[word] |= mask;
            }
            self.group_seen_count[group] += 1;
        } else if previous_seq != member.display_seq || previous_end != member.end {
            self.disable_eligibility(Some(group));
            return Observed::Invalid;
        }
        self.group_flags[group] |= FLAG_OBSERVED_SINCE_COMMIT;

        if applied && self.member_applied_bits[word] & mask == 0 {
            self.member_applied_bits[word] |= mask;
            self.group_applied_count[group] += 1;
            if member.end {
                self.group_flags[group] |= FLAG_END_APPLIED;
            }
        }
        Observed::Group(group)
    }

    fn assign_group_to_transaction(
        &mut self,
        group: usize,
        as_dependency: bool,
        link_predecessor: bool,
    ) {
        if group >= GROUP_CAPACITY || self.group_flags[group] & FLAG_ACTIVE == 0 {
            return;
        }
        if as_dependency {
            self.group_dependency_epoch[group] = self.transaction_epoch;
        }
        if self.group_transaction_epoch[group] != self.transaction_epoch {
            self.group_transaction_epoch[group] = self.transaction_epoch;
            self.transaction_group_count += 1;
        }
        if self.newest_transaction_group.is_none_or(|newest| {
            display_serial_is_newer(
                self.group_presentation_id[group],
                self.group_presentation_id[newest],
            )
        }) {
            self.newest_transaction_group = Some(group);
        }
        if self.group_flags[group] & FLAG_POISONED != 0 {
            return;
        }
        // Queue provenance cannot know whether application will change the
        // grid; only a visual application turns predecessor advice into
        // authority, so a completed no-op cannot drag a missing ancestor into
        // an unrelated transaction.
        if !link_predecessor || self.group_predecessor_linked_epoch[group] == self.transaction_epoch
        {
            return;
        }
        self.group_predecessor_linked_epoch[group] = self.transaction_epoch;

        let predecessor = self.group_row_predecessor[group];
        if predecessor == 0 {
            return;
        }
        if self.dependency_satisfied_through != 0
            && predecessor.wrapping_sub(self.dependency_satisfied_through) == 0x8000_0000
        {
            self.mark_serial_failure();
            self.transaction_disable_bits |= DISABLE_PREDECESSOR;
            return;
        }
        if self.dependency_was_satisfied(predecessor) {
            return;
        }
        if self.was_serially_retired(predecessor) {
            // Capacity retirement is not presentation proof: the state still
            // applies and ACKs, but a forgotten dependency cannot authorize an
            // early release.
            self.transaction_disable_bits |= DISABLE_PREDECESSOR;
            return;
        }
        let predecessor_group = match self.find_group(predecessor) {
            Some(found) => found,
            None => self.allocate_group(predecessor, 0),
        };
        self.assign_group_to_transaction(predecessor_group, true, true);
    }

    fn attach_queued_groups_to_transaction(&mut self, root: u32) {
        for group in 0..GROUP_CAPACITY {
            let flags = self.group_flags[group];
            if flags & FLAG_ACTIVE == 0 {
                continue;
            }
            let id = self.group_presentation_id[group];
            if id != root && display_serial_is_newer(root, id) {
                // An older group off the root's predecessor chain cannot govern
                // this presentation, but its serial still joins the ordering
                // audit, so a half-range or cyclic set cannot become eligible
                // by rooting its newest-looking member.
                self.group_serial_audit_epoch[group] = self.transaction_epoch;
                continue;
            }
            let evidence = flags & FLAG_ORIGINAL_OBSERVED != 0
                && (self.group_member_count[group] > 0
                    || self.group_row_predecessor[group] != 0
                    || flags & FLAG_ROW_BEARING != 0);
            if flags & FLAG_OBSERVED_SINCE_COMMIT != 0
                && (evidence || flags & FLAG_VISUAL_PROBE != 0)
            {
                self.assign_group_to_transaction(group, false, false);
            }
        }
    }

    /// The union of this transaction's serials has one newest member. The
    /// newest visual state need not be the newest observed member: a later
    /// no-op can close the same transaction.
    fn transaction_serial_order_valid(&self) -> bool {
        if self.transaction_group_count == 0 {
            return true;
        }
        let Some(newest_group) = self.newest_transaction_group else {
            return false;
        };
        let mut newest = self.group_presentation_id[newest_group];
        if self.latest_id != 0 {
            if display_serial_is_newer(self.latest_id, newest) {
                newest = self.latest_id;
            }
            if self.latest_id != newest && !display_serial_is_newer(newest, self.latest_id) {
                return false;
            }
        }
        (0..GROUP_CAPACITY).all(|group| {
            let attached = self.group_transaction_epoch[group] == self.transaction_epoch
                || self.group_serial_audit_epoch[group] == self.transaction_epoch;
            let id = self.group_presentation_id[group];
            !attached || id == newest || display_serial_is_newer(newest, id)
        })
    }

    /// Completion is scoped to this transaction: every attached group applied
    /// through, and the newest membership-bearing group of it carried END.
    /// A ledger-wide newest group moved with every arrival, and a continuous
    /// stream kept pushing the goalpost onto the timing rule.
    fn membership_disable_bits(&self) -> u32 {
        let mut bits = self.transaction_disable_bits;
        if self.retirement_fail_closed {
            bits |= if self.serial_failure_owner == self.transaction_epoch {
                DISABLE_SERIAL
            } else {
                DISABLE_INHERITED_SERIAL
            };
        }
        if !self.transaction_serial_order_valid() {
            bits |= DISABLE_SERIAL;
        }
        if self.transaction_group_count == 0 {
            bits |= DISABLE_INCOMPLETE;
        }
        let mut newest_member_group: Option<usize> = None;
        for group in 0..GROUP_CAPACITY {
            if self.group_transaction_epoch[group] != self.transaction_epoch {
                continue;
            }
            let flags = self.group_flags[group];
            if flags & FLAG_POISONED != 0 {
                bits |= DISABLE_POISONED;
            }
            let complete = self.group_own_applied_complete(group);
            if self.group_dependency_epoch[group] == self.transaction_epoch && !complete {
                bits |= DISABLE_PREDECESSOR;
            }
            if self.group_member_count[group] > 0 {
                if !complete {
                    bits |= DISABLE_INCOMPLETE;
                }
                if newest_member_group.is_none_or(|newest| {
                    display_serial_is_newer(
                        self.group_presentation_id[group],
                        self.group_presentation_id[newest],
                    )
                }) {
                    newest_member_group = Some(group);
                }
            } else if flags & FLAG_VISUAL_PROBE != 0
                || (flags & FLAG_COHERENT == 0
                    && self.group_row_predecessor[group] != 0
                    && !complete)
            {
                bits |= DISABLE_INCOMPLETE;
            }
        }
        if newest_member_group.is_some_and(|group| self.group_flags[group] & FLAG_END_APPLIED == 0)
        {
            bits |= DISABLE_END;
        }
        bits
    }

    fn transaction_membership_complete(&self) -> bool {
        self.pending && self.membership_disable_bits() == 0
    }

    fn note_group_demand(&mut self, group: Option<usize>, demand_serial: u32, awaits_grant: bool) {
        let Some(group) = group else {
            return;
        };
        let flags = self.group_flags[group];
        if flags & FLAG_DEMAND_OBSERVED == 0 {
            self.group_demand_serial[group] = demand_serial;
            self.group_flags[group] =
                flags | FLAG_DEMAND_OBSERVED | if awaits_grant { FLAG_AWAITS_GRANT } else { 0 };
        } else if !awaits_grant || self.group_demand_serial[group] != demand_serial {
            self.group_flags[group] = flags & !FLAG_AWAITS_GRANT;
        }
    }

    /// The newest membership-bearing group attached to this transaction.
    fn newest_transaction_member_group(&self) -> Option<usize> {
        let mut newest: Option<usize> = None;
        for group in 0..GROUP_CAPACITY {
            if self.group_transaction_epoch[group] != self.transaction_epoch
                || self.group_member_count[group] == 0
            {
                continue;
            }
            if newest.is_none_or(|current| {
                display_serial_is_newer(
                    self.group_presentation_id[group],
                    self.group_presentation_id[current],
                )
            }) {
                newest = Some(group);
            }
        }
        newest
    }

    /// A complete paced state landed, and nothing newer can follow it without
    /// a grant reaching the daemon: release at the first opportunity.
    fn paced_closed(&self) -> bool {
        if !self.pending || self.closure != Closure::None {
            return false;
        }
        if self.membership_disable_bits() & !DISABLE_END != 0 {
            return false;
        }
        self.newest_transaction_member_group()
            .is_some_and(|group| self.group_flags[group] & FLAG_AWAITS_GRANT != 0)
    }

    fn start_transaction(&mut self, now_ms: f64, refresh_period_ms: f64, root: u32) {
        self.pending = true;
        self.next_transaction_epoch();
        self.period = normalized_refresh_period(refresh_period_ms);
        self.first_applied = now_ms;
        self.deadline = self.first_applied + self.period;
        self.transaction_disable_bits = self.unattached_disable_bits;
        self.unattached_disable_bits = 0;
        self.attach_queued_groups_to_transaction(root);
    }

    fn release(&mut self, reason: Release, disable_bits: u32) -> Release {
        self.release_disable_bits = disable_bits;
        self.held = false;
        self.released_for_commit = true;
        self.release_reason = reason;
        reason
    }

    /// A snapshot that applied (or a retained epoch) roots the ledger.
    pub fn adopt_generation(&mut self, generation: u32) {
        self.clear_transaction();
        self.clear_ledger();
        self.closure = Closure::None;
        self.active_generation = generation;
    }

    /// Frozen at release, before any wait for the screen.
    pub fn membership_release_disable_bits(&self) -> u32 {
        self.release_disable_bits
    }

    /// A frame entered the apply queue. Membership only: it never enlists a
    /// new group, and never re-holds a released transaction; a stream of newer
    /// groups would otherwise move the goalpost forever.
    pub fn note_queued(&mut self, member: &Member) {
        let observed = self.observe_member(member, false, false);
        if !self.pending {
            return;
        }
        if let Some(group) = observed.group()
            && self.group_transaction_epoch[group] == self.transaction_epoch
        {
            self.assign_group_to_transaction(group, false, false);
        }
    }

    /// A member applied without changing authoritative pixels.
    pub fn note_nonvisual_applied(&mut self, member: &Member) {
        let observed = self.observe_member(member, true, false);
        self.note_group_demand(observed.group(), member.demand_serial, member.awaits_grant);
        if self.pending
            && let Some(group) = observed.group()
        {
            // A no-op off the named chain carries no authority; a placeholder
            // already reached from the root can reveal another ancestor.
            let reveals_ancestor = self.group_dependency_epoch[group] == self.transaction_epoch;
            self.assign_group_to_transaction(group, false, reveals_ancestor);
        }
    }

    /// A frame applied that changed authoritative pixels. `member.row_bearing`
    /// is read from `application.rows`.
    pub fn note_applied(&mut self, application: &Application, member: &Member) -> ApplyAction {
        if member.generation != self.active_generation || self.active_generation == 0 {
            return ApplyAction::Now;
        }
        let member = Member {
            row_bearing: application.rows > 0,
            ..*member
        };
        let observed = self.observe_member(&member, true, true);
        self.note_group_demand(observed.group(), member.demand_serial, member.awaits_grant);
        let id = member.presentation_id;
        let had_coherent = self.includes_coherent;
        if !self.pending {
            self.start_transaction(application.now_ms, application.refresh_period_ms, id);
            self.first_id = id;
            self.latest_id = id;
            self.first_seq = member.display_seq;
        } else if display_serial_is_newer(id, self.latest_id) {
            self.latest_id = id;
        }
        match observed {
            Observed::Group(group) => self.assign_group_to_transaction(group, false, true),
            Observed::Retired | Observed::DependencyRetired => {
                self.transaction_disable_bits |= DISABLE_RETIRED_VISUAL;
            }
            Observed::Invalid | Observed::InvalidDependency if !self.retirement_fail_closed => {
                self.transaction_disable_bits |= DISABLE_POISONED;
            }
            _ => {}
        }

        self.last_applied = application.now_ms;
        self.last_seq = member.display_seq;
        if display_serial_is_newer(application.input_seq, self.input_high_water) {
            self.input_high_water = application.input_seq;
        }
        if display_serial_is_newer(application.echo_horizon, self.echo_high_water) {
            self.echo_high_water = application.echo_horizon;
        }
        self.count += 1;
        self.row_count += u64::from(application.rows);
        self.byte_count += application.bytes;
        self.queued_high_water = self.queued_high_water.max(application.queued_frames);

        if member.coherent {
            self.includes_coherent = true;
            if display_serial_is_newer(id, self.newest_coherent_id) {
                self.newest_coherent_id = id;
                self.saw_newest_end = member.end;
            } else if id == self.newest_coherent_id {
                self.saw_newest_end |= member.end;
            }
            // Telemetry anchor, taken once at the first coherent apply.
            if !had_coherent {
                self.period = normalized_refresh_period(application.refresh_period_ms);
                self.deadline = application.now_ms + self.period;
            }
        }

        if self.held {
            return ApplyAction::Held;
        }
        let closure_pending = self.closure == Closure::Pending;
        // Already released: a late member joins the commit in flight, unless
        // it leaves a claimed complete screen unmet.
        if self.released_for_commit && !closure_pending {
            return ApplyAction::Now;
        }
        let predecessor = member.row_predecessor_presentation_id;
        let predecessor_requires_hold =
            predecessor != 0 && !self.dependency_was_satisfied(predecessor);
        let timing_authority_invalid = matches!(
            observed,
            Observed::InvalidDependency | Observed::Retired | Observed::DependencyRetired
        );
        if !closure_pending
            && !member.coherent
            && !predecessor_requires_hold
            && !timing_authority_invalid
        {
            if self.release_reason == Release::None {
                self.release_disable_bits = self.membership_disable_bits();
                self.release_reason = Release::Urgent;
            }
            return ApplyAction::Now;
        }

        self.released_for_commit = false;
        self.held = true;
        self.held_frames = 0;
        self.last_counted_frame_ms = f64::NEG_INFINITY;
        self.held_since_ms = application.now_ms;
        self.release_reason = Release::None;
        ApplyAction::HoldStarted
    }

    /// Record the newest claim evaluation, before `note_applied` for the frame
    /// that produced it. Leaving `Pending` restarts the frame count: frames
    /// spent waiting for missing rows were not collection frames.
    pub fn set_closure(&mut self, state: Closure) {
        if state == self.closure {
            return;
        }
        let left_pending = self.closure == Closure::Pending;
        self.closure = state;
        if left_pending && self.held {
            self.held_frames = 0;
            self.last_counted_frame_ms = f64::NEG_INFINITY;
        }
    }

    pub fn closure(&self) -> Closure {
        self.closure
    }

    /// The held transaction may commit before the next frame: a met closure,
    /// or a complete paced transaction whose newest state awaited a grant.
    pub fn early_release_eligible(&self) -> bool {
        self.held && (self.closure == Closure::Met || self.paced_closed())
    }

    /// Release an early-eligible transaction only inside this `submit`, which
    /// shows it; the hold is restored if it did not.
    pub fn with_early_release(&mut self, submit: impl FnOnce() -> bool) -> bool {
        if !self.held {
            return false;
        }
        let (reason, disable_bits) = if self.closure == Closure::Met {
            (Release::ClosureComplete, 0)
        } else if self.paced_closed() {
            (Release::PacedComplete, self.membership_disable_bits())
        } else {
            return false;
        };
        let previous_reason = self.release_reason;
        let previous_disable_bits = self.release_disable_bits;
        let epoch = self.transaction_epoch;
        self.release(reason, disable_bits);
        let submitted = submit();
        if !submitted && self.pending && self.transaction_epoch == epoch {
            self.held = true;
            self.released_for_commit = false;
            self.release_reason = previous_reason;
            self.release_disable_bits = previous_disable_bits;
        }
        submitted
    }

    /// Release complete known membership that owes no presentation
    /// opportunity. A transaction with coherent pixels waits for a frame:
    /// one logical redraw arrives as several separately END'd groups, and only
    /// the vsync folds them into one commit.
    pub fn release_completed_at_pump(&mut self) -> Release {
        if !self.held || self.closure == Closure::Pending || self.includes_coherent {
            return Release::None;
        }
        if self.closure == Closure::Met {
            return self.release(Release::ClosureComplete, 0);
        }
        let disable_bits = self.membership_disable_bits();
        if disable_bits != 0 {
            return Release::None;
        }
        self.release(Release::MembershipComplete, disable_bits)
    }

    /// One animation frame the display delivered, by its frame time on the
    /// same clock as `note_applied`. A met closure or a closed paced
    /// transaction releases at the first; complete membership releases as
    /// `EndQuiet`; otherwise the hold ends at the second frame after the first
    /// coherent apply. A frame older than the hold is the one it interrupted,
    /// not one it collected through, and counts for nothing.
    pub fn release_at_frame(&mut self, frame_time_ms: f64) -> Release {
        if !self.held || frame_time_ms < self.held_since_ms || self.closure == Closure::Pending {
            return Release::None;
        }
        if self.closure == Closure::Met {
            self.release_frame_time = frame_time_ms;
            return self.release(Release::ClosureComplete, 0);
        }
        let finite = frame_time_ms.is_finite();
        if self.held_frames == 0 || !finite || frame_time_ms > self.last_counted_frame_ms {
            self.held_frames += 1;
            if finite {
                self.last_counted_frame_ms = frame_time_ms;
            }
        }
        let disable_bits = self.membership_disable_bits();
        if self.paced_closed() {
            self.release_frame_time = frame_time_ms;
            return self.release(Release::PacedComplete, disable_bits);
        }
        if disable_bits == 0 {
            self.release_frame_time = frame_time_ms;
            return self.release(Release::EndQuiet, disable_bits);
        }
        if self.held_frames < HOLD_FRAMES {
            return Release::None;
        }
        self.release_frame_time = frame_time_ms;
        self.release(Release::Deadline, disable_bits)
    }

    /// The screen took the transaction; the next visual mutation starts
    /// another. The ledger stays: a late final member after a bound commit
    /// completes its group, and fully applied committed groups retire older
    /// timing authority.
    pub fn consume_committed(&mut self) {
        if !self.pending {
            return;
        }
        self.retire_committed_ledger_groups();
        // A later transaction inherits this failure even across epoch wrap.
        if self.retirement_fail_closed {
            self.serial_failure_owner = 0;
        }
        self.clear_transaction();
    }

    /// A lineage replacement clears the transaction and the ledger.
    pub fn reset(&mut self) {
        self.clear_transaction();
        self.clear_ledger();
        self.closure = Closure::None;
    }

    pub fn is_held(&self) -> bool {
        self.held
    }

    pub fn has_pending_transaction(&self) -> bool {
        self.pending
    }

    pub fn first_applied_at_ms(&self) -> f64 {
        self.first_applied
    }

    pub fn last_applied_at_ms(&self) -> f64 {
        self.last_applied
    }

    pub fn first_presentation_id(&self) -> u32 {
        self.first_id
    }

    pub fn latest_presentation_id(&self) -> u32 {
        self.latest_id
    }

    pub fn first_display_seq(&self) -> u32 {
        self.first_seq
    }

    pub fn last_display_seq(&self) -> u32 {
        self.last_seq
    }

    pub fn generation(&self) -> u32 {
        self.active_generation
    }

    pub fn display_input_seq(&self) -> u32 {
        self.input_high_water
    }

    /// The newest input the transaction's pixels could answer. The input
    /// watermark above records only writes the daemon had confirmed when each
    /// member was captured, and an echo can be read before its own write is
    /// confirmed: its frame then carries the older watermark, and a header-only
    /// frame raises it afterwards. A host that times an input's answer needs
    /// both: this bound on the commit, and the watermark reaching the input.
    pub fn display_echo_horizon(&self) -> u32 {
        self.echo_high_water
    }

    pub fn applied_datagram_count(&self) -> u32 {
        self.count
    }

    pub fn accumulated_rows(&self) -> u64 {
        self.row_count
    }

    pub fn accumulated_bytes(&self) -> u64 {
        self.byte_count
    }

    pub fn coherent(&self) -> bool {
        self.includes_coherent
    }

    pub fn end_seen(&self) -> bool {
        self.saw_newest_end
    }

    pub fn queue_high_water(&self) -> u32 {
        self.queued_high_water
    }

    /// Telemetry only: the first coherent apply plus the host's period.
    /// Nothing gates on it; the release rule counts frames.
    pub fn transaction_deadline_at_ms(&self) -> f64 {
        self.deadline
    }

    pub fn transaction_refresh_period_ms(&self) -> f64 {
        self.period
    }

    /// The frame time that released this transaction; zero outside a frame.
    pub fn release_frame_time_ms(&self) -> f64 {
        self.release_frame_time
    }

    /// Frames this hold consumed, kept until the commit.
    pub fn release_frame_count(&self) -> u32 {
        self.held_frames
    }

    pub fn last_release_reason(&self) -> Release {
        self.release_reason
    }

    pub fn membership_group_count(&self) -> usize {
        self.ledger_group_count
    }

    pub fn membership_capacity_reset_count(&self) -> u32 {
        self.capacity_reset_count
    }

    pub fn membership_early_eligible(&self) -> bool {
        self.transaction_membership_complete()
    }
}

#[cfg(test)]
mod tests;
