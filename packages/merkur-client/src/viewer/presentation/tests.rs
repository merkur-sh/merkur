//! The `presentation-coordinator.test.ts` suite, case for case. The one case
//! it leaves out drives the browser's refresh-rate estimator, which is the
//! host's clock rather than a presentation rule.

use super::*;

const GENERATION: u32 = 9;

/// Animation frames later than every apply instant in a case: frames a hold
/// actually collected through.
struct Frames(f64);

impl Frames {
    fn new() -> Self {
        Self(1_000_000.0)
    }

    fn next(&mut self) -> f64 {
        self.0 += 16.0;
        self.0
    }
}

/// `noteApplied`'s positional arguments, by name.
#[derive(Clone, Copy)]
struct A {
    at: f64,
    period: f64,
    id: u32,
    coherent: bool,
    end: bool,
    seq: u32,
    generation: u32,
    input: u32,
    horizon: u32,
    rows: u32,
    bytes: u64,
    queued: u32,
    index: u16,
    count: u16,
    predecessor: u32,
    serial: u32,
    awaits: bool,
}

impl Default for A {
    fn default() -> Self {
        Self {
            at: 0.0,
            period: 16.0,
            id: 0,
            coherent: false,
            end: false,
            seq: 0,
            generation: GENERATION,
            input: 0,
            horizon: 0,
            rows: 0,
            bytes: 0,
            queued: 0,
            index: 0,
            count: 0,
            predecessor: 0,
            serial: 0,
            awaits: false,
        }
    }
}

fn apply(c: &mut PresentationCoordinator, a: A) -> ApplyAction {
    c.note_applied(
        &Application {
            now_ms: a.at,
            refresh_period_ms: a.period,
            input_seq: a.input,
            echo_horizon: a.horizon,
            rows: a.rows,
            bytes: a.bytes,
            queued_frames: a.queued,
        },
        &Member {
            presentation_id: a.id,
            coherent: a.coherent,
            end: a.end,
            member_index: a.index,
            member_count: a.count,
            display_seq: a.seq,
            generation: a.generation,
            row_predecessor_presentation_id: a.predecessor,
            row_bearing: false,
            demand_serial: a.serial,
            awaits_grant: a.awaits,
        },
    )
}

/// `noteQueued` / `noteNonvisualApplied` metadata.
fn m(
    id: u32,
    coherent: bool,
    end: bool,
    index: u16,
    count: u16,
    seq: u32,
    generation: u32,
) -> Member {
    Member {
        presentation_id: id,
        coherent,
        end,
        member_index: index,
        member_count: count,
        display_seq: seq,
        generation,
        ..Member::default()
    }
}

fn linked(member: Member, predecessor: u32, row_bearing: bool) -> Member {
    Member {
        row_predecessor_presentation_id: predecessor,
        row_bearing,
        ..member
    }
}

fn note(
    c: &mut PresentationCoordinator,
    at: f64,
    id: u32,
    coherent: bool,
    end: bool,
    period: f64,
) -> ApplyAction {
    apply(
        c,
        A {
            at,
            period,
            id,
            coherent,
            end,
            seq: id,
            input: id,
            rows: 3,
            bytes: 100,
            queued: 2,
            ..A::default()
        },
    )
}

fn queue_member(
    c: &mut PresentationCoordinator,
    id: u32,
    index: u16,
    count: u16,
    end: bool,
    seq: u32,
) {
    c.note_queued(&m(id, true, end, index, count, seq, GENERATION));
}

#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript suite's applyVisualMember, so each case reads as the browser's"
)]
fn apply_visual(
    c: &mut PresentationCoordinator,
    at: f64,
    id: u32,
    index: u16,
    count: u16,
    end: bool,
    seq: u32,
    period: f64,
) -> ApplyAction {
    apply(
        c,
        A {
            at,
            period,
            id,
            coherent: true,
            end,
            seq,
            input: 1,
            rows: 1,
            bytes: 100,
            index,
            count,
            ..A::default()
        },
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript suite's queueLinkedMember, so each case reads as the browser's"
)]
fn queue_linked(
    c: &mut PresentationCoordinator,
    id: u32,
    index: u16,
    count: u16,
    end: bool,
    seq: u32,
    predecessor: u32,
    row_bearing: bool,
) {
    c.note_queued(&linked(
        m(id, true, end, index, count, seq, GENERATION),
        predecessor,
        row_bearing,
    ));
}

#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript suite's applyLinkedVisualMember, so each case reads as the browser's"
)]
fn apply_linked(
    c: &mut PresentationCoordinator,
    at: f64,
    id: u32,
    index: u16,
    count: u16,
    end: bool,
    seq: u32,
    predecessor: u32,
    rows: u32,
    coherent: bool,
    generation: u32,
) -> ApplyAction {
    apply(
        c,
        A {
            at,
            id,
            coherent,
            end,
            seq,
            generation,
            input: 1,
            rows,
            bytes: 100,
            index,
            count,
            predecessor,
            ..A::default()
        },
    )
}

/// The pump-end edge, then the frame: the two production release edges of
/// one presentation opportunity.
fn at_opportunity(c: &mut PresentationCoordinator, frames: &mut Frames) -> Release {
    match c.release_completed_at_pump() {
        Release::None => c.release_at_frame(frames.next()),
        released => released,
    }
}

/// Drive the frame rule to its bound and report what it released.
fn at_deadline(c: &mut PresentationCoordinator, frames: &mut Frames) -> Release {
    for _ in 1..HOLD_FRAMES {
        let early = c.release_at_frame(frames.next());
        if early != Release::None {
            return early;
        }
    }
    c.release_at_frame(frames.next())
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{actual} is not {expected}"
    );
}

#[test]
fn release_telemetry_retains_the_exact_frame_and_resets_on_consumption() {
    let mut c = PresentationCoordinator::new(9);
    apply_visual(&mut c, 100.0, 1, 0, 1, true, 1, 16.0);
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (0.0, 0)
    );
    assert_eq!(c.release_at_frame(99.0), Release::None);
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (0.0, 0)
    );
    assert_eq!(c.release_at_frame(108.0), Release::EndQuiet);
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (108.0, 1)
    );
    assert_eq!(c.release_at_frame(116.0), Release::None);
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (108.0, 1)
    );
    c.consume_committed();
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (0.0, 0)
    );
    apply_visual(&mut c, 117.0, 2, 0, 2, false, 1, 16.0);
    assert_eq!(c.release_at_frame(124.0), Release::None);
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (0.0, 1)
    );
    assert_eq!(c.release_at_frame(133.0), Release::Deadline);
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (133.0, 2)
    );
    c.reset();
    assert_eq!(
        (c.release_frame_time_ms(), c.release_frame_count()),
        (0.0, 0)
    );
}

#[test]
fn delayed_opportunities_are_counted_not_inferred_from_elapsed_periods() {
    let mut c = PresentationCoordinator::new(9);
    apply_visual(&mut c, 100.0, 1, 0, 2, false, 1, 8.0);
    assert_eq!(c.release_at_frame(150.0), Release::None);
    assert_eq!(c.release_frame_count(), 1);
    assert_eq!(c.release_at_frame(200.0), Release::Deadline);
    assert_eq!(c.release_frame_count(), 2);
}

#[test]
fn isolated_urgent_updates_take_the_earliest_opportunity() {
    let mut c = PresentationCoordinator::new(9);
    assert_eq!(note(&mut c, 10.0, 1, false, false, 16.0), ApplyAction::Now);
    assert!(!c.is_held());
    assert!(c.has_pending_transaction());
    assert_eq!(c.last_release_reason(), Release::Urgent);
    assert_eq!(c.transaction_deadline_at_ms(), 26.0);
}

#[test]
fn queued_urgent_work_and_coherent_probes_cannot_rehold_an_urgent_wait() {
    for coherent in [false, true] {
        let mut c = PresentationCoordinator::new(9);
        assert_eq!(note(&mut c, 100.0, 1, false, false, 16.0), ApplyAction::Now);
        c.note_queued(&m(2, coherent, false, 0, 0, 2, 9));
        assert!(!c.is_held());
        assert_eq!(c.last_release_reason(), Release::Urgent);
    }
}

#[test]
fn urgent_pixels_join_an_early_released_transaction_without_reopening_it() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_member(&mut c, 3, 0, 1, true, 3);
    assert_eq!(
        apply_visual(&mut c, 100.0, 3, 0, 1, true, 3, 16.0),
        ApplyAction::HoldStarted
    );
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    assert_eq!(note(&mut c, 101.0, 4, false, false, 16.0), ApplyAction::Now);
    assert!(!c.is_held());
    assert_eq!(c.applied_datagram_count(), 2);
    assert_eq!(c.last_release_reason(), Release::EndQuiet);
}

#[test]
fn anchors_a_coherent_hold_to_the_first_arrival_for_one_refresh_period() {
    let mut c = PresentationCoordinator::new(9);
    assert_eq!(
        note(&mut c, 100.0, 7, true, false, 8.25),
        ApplyAction::HoldStarted
    );
    assert_eq!(c.first_applied_at_ms(), 100.0);
    assert_eq!(c.transaction_deadline_at_ms(), 108.25);
    assert_eq!(c.first_presentation_id(), 7);
}

#[test]
fn merges_task_and_pump_slice_arrivals_without_rearming_the_deadline() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 41, true, false, 16.0);
    assert_eq!(
        note(&mut c, 104.0, 41, true, false, 16.0),
        ApplyAction::Held
    );
    assert_eq!(
        note(&mut c, 109.0, 42, true, false, 16.0),
        ApplyAction::Held
    );
    assert_eq!(c.transaction_deadline_at_ms(), 116.0);
    assert_eq!(
        (c.first_presentation_id(), c.latest_presentation_id()),
        (41, 42)
    );
    assert_eq!((c.first_display_seq(), c.last_display_seq()), (41, 42));
    assert_eq!(c.generation(), 9);
    assert_eq!(c.display_input_seq(), 42);
    assert_eq!(c.applied_datagram_count(), 3);
    assert_eq!((c.accumulated_rows(), c.accumulated_bytes()), (9, 300));
    assert_eq!(c.queue_high_water(), 2);
}

#[test]
fn urgent_state_joins_held_authority_without_exposing_a_partial_redraw() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    note(&mut c, 100.0, 1, true, false, 16.0);
    assert_eq!(
        note(&mut c, 101.0, 99, false, false, 16.0),
        ApplyAction::Held
    );
    assert!(c.is_held() && c.has_pending_transaction());
    assert_eq!(c.last_release_reason(), Release::None);
    assert!(c.coherent());
    assert_eq!(c.applied_datagram_count(), 2);
    assert_eq!((c.accumulated_rows(), c.accumulated_bytes()), (6, 200));
    assert_eq!((c.first_display_seq(), c.last_display_seq()), (1, 99));
    assert_eq!(c.latest_presentation_id(), 99);
    assert_eq!(c.transaction_deadline_at_ms(), 116.0);
    assert_eq!(c.release_at_frame(frames.next()), Release::None);
    assert_eq!(note(&mut c, 105.0, 1, true, true, 16.0), ApplyAction::Held);
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    assert_eq!(c.applied_datagram_count(), 3);
    c.consume_committed();
    assert!(!c.has_pending_transaction());
}

#[test]
fn a_reordered_coherent_k1_probe_closes_at_the_pump_with_its_complete_singleton() {
    let mut c = PresentationCoordinator::new(4);
    let mut frames = Frames::new();
    // A rowless probe may overtake its data datagram; its metadata opens a
    // hold rather than painting that header ahead of the causal row.
    let probe = A {
        at: 100.0,
        period: 1_000.0 / 120.0,
        id: 7,
        coherent: true,
        seq: 90,
        generation: 4,
        bytes: 27,
        queued: 1,
        ..A::default()
    };
    assert_eq!(apply(&mut c, probe), ApplyAction::HoldStarted);
    let original = A {
        at: 101.0,
        end: true,
        seq: 89,
        input: 42,
        rows: 1,
        bytes: 96,
        count: 1,
        ..probe
    };
    assert_eq!(apply(&mut c, original), ApplyAction::Held);
    assert!(c.is_held());
    assert_eq!(c.last_release_reason(), Release::None);
    assert_eq!((c.applied_datagram_count(), c.accumulated_rows()), (2, 1));
    assert_eq!(
        (c.first_presentation_id(), c.latest_presentation_id()),
        (7, 7)
    );
    assert_eq!(c.display_input_seq(), 42);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    assert!(!c.is_held());
}

#[test]
fn a_complete_k1_singleton_never_waits_for_its_optional_probe() {
    for probe_at in ["same-pump", "gpu-wait", "missing"] {
        let mut c = PresentationCoordinator::new(9);
        let mut frames = Frames::new();
        queue_member(&mut c, 7, 0, 1, true, 89);
        apply_visual(&mut c, 100.0, 7, 0, 1, true, 89, 16.0);
        let probe = |c: &mut PresentationCoordinator| {
            c.note_queued(&m(7, true, false, 0, 0, 90, 9));
            // The original already installed the identical cursor and header.
            c.note_nonvisual_applied(&m(7, true, false, 0, 0, 90, 9));
        };
        if probe_at == "same-pump" {
            probe(&mut c);
        }
        assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
        if probe_at == "gpu-wait" {
            probe(&mut c);
        }
        assert!(!c.is_held() && c.has_pending_transaction());
        assert_eq!(c.membership_group_count(), 1);
        c.consume_committed();
        assert_eq!(c.membership_group_count(), 0);
    }
}

#[test]
fn a_frame_right_after_the_first_packet_cannot_expose_it_alone() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 8, true, false, 16.0);
    assert_eq!(c.release_at_frame(Frames::new().next()), Release::None);
    assert!(c.is_held());
}

#[test]
fn end_alone_is_advisory_and_cannot_release_before_the_frame_bound() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    note(&mut c, 100.0, 8, true, true, 16.0);
    assert_eq!(c.release_at_frame(frames.next()), Release::None);
    assert_eq!(c.release_at_frame(frames.next()), Release::Deadline);
}

#[test]
fn end_first_reordering_cannot_commit_between_the_marker_and_its_rows() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    note(&mut c, 100.0, 8, true, true, 1_000.0 / 120.0);
    assert_eq!(c.release_at_frame(frames.next()), Release::None);
    note(&mut c, 106.0, 8, true, false, 16.0);
    assert_eq!(c.release_at_frame(frames.next()), Release::Deadline);
}

#[test]
fn end_is_scoped_to_the_newest_adjacent_presentation_across_reordering() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 10, true, true, 16.0);
    note(&mut c, 102.0, 11, true, false, 16.0);
    assert!(!c.end_seen());
    // A reordered END for 10 cannot close 11.
    note(&mut c, 103.0, 10, true, true, 16.0);
    assert!(!c.end_seen());
    assert_eq!(c.release_at_frame(Frames::new().next()), Release::None);
    note(&mut c, 111.0, 11, true, true, 16.0);
    assert!(c.end_seen());
    assert_eq!(c.transaction_deadline_at_ms(), 116.0);
}

#[test]
fn presentation_id_ordering_survives_the_skipped_zero_wrap() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 0xffff_ffff, true, true, 16.0);
    note(&mut c, 101.0, 1, true, false, 16.0);
    assert_eq!(c.latest_presentation_id(), 1);
    assert!(!c.end_seen());
}

/// An echo read before its own write was confirmed: the member's watermark is
/// the older input and its horizon the newer, and the commit states both.
#[test]
fn a_transaction_states_the_newest_input_its_pixels_could_answer_beside_its_watermark() {
    let mut c = PresentationCoordinator::new(9);
    apply(
        &mut c,
        A {
            at: 100.0,
            id: 1,
            seq: 1,
            input: 1428,
            horizon: 1429,
            rows: 1,
            ..A::default()
        },
    );
    assert_eq!(c.display_input_seq(), 1428);
    assert_eq!(c.display_echo_horizon(), 1429);
    // An older member cannot take the horizon back, and the next transaction
    // starts from none.
    apply(
        &mut c,
        A {
            at: 101.0,
            id: 2,
            seq: 2,
            input: 1428,
            horizon: 1427,
            rows: 1,
            ..A::default()
        },
    );
    assert_eq!(c.display_echo_horizon(), 1429);
    c.consume_committed();
    assert_eq!(c.display_echo_horizon(), 0);
}

#[test]
fn the_input_high_water_advances_across_wrap_without_accepting_stale_values() {
    let mut c = PresentationCoordinator::new(9);
    let mut with_input = |at: f64, seq: u32, input: u32| {
        apply(
            &mut c,
            A {
                at,
                id: seq,
                seq,
                input,
                bytes: 27,
                ..A::default()
            },
        );
    };
    with_input(100.0, 1, 0);
    with_input(101.0, 2, 0xffff_fffe);
    with_input(102.0, 3, 0xffff_ffff);
    with_input(103.0, 4, 0xffff_fffd);
    with_input(104.0, 5, 1);
    with_input(105.0, 6, 0xffff_ffff);
    assert_eq!(c.display_input_seq(), 1);
    let mut c = PresentationCoordinator::new(9);
    for (seq, input, expected) in [
        (1, 0, 0),
        (2, 0xffff_fffe, 0xffff_fffe),
        (3, 0xffff_ffff, 0xffff_ffff),
        (4, 0xffff_fffd, 0xffff_ffff),
    ] {
        apply(
            &mut c,
            A {
                at: 100.0,
                id: seq,
                seq,
                input,
                bytes: 27,
                ..A::default()
            },
        );
        assert_eq!(c.display_input_seq(), expected);
    }
}

#[test]
fn later_arrivals_never_extend_the_fixed_frame_budget() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    note(&mut c, 100.0, 8, true, true, 16.0);
    note(&mut c, 114.0, 8, true, false, 16.0);
    assert_eq!(c.transaction_deadline_at_ms(), 116.0);
    assert_eq!(c.release_at_frame(frames.next()), Release::None);
    assert_eq!(c.release_at_frame(frames.next()), Release::Deadline);
}

#[test]
fn the_frame_rule_releases_with_no_end_and_with_a_late_callback() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 5, true, false, 10.0);
    note(&mut c, 130.0, 5, true, false, 10.0);
    assert_eq!(c.transaction_deadline_at_ms(), 110.0);
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
    assert_eq!(c.last_release_reason(), Release::Deadline);
}

#[test]
fn a_suspended_frame_clock_holds_instead_of_guessing() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 5, true, true, 1_000.0 / 120.0);
    // No frames at all: the grid advanced, the pixels wait, and no timer
    // could release this.
    assert!(c.is_held());
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
}

#[test]
fn a_burst_across_a_pump_slice_stays_one_anchored_transaction() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    for index in 0..130u32 {
        let action = note(
            &mut c,
            100.0 + f64::from(index) * 0.01,
            77,
            true,
            index == 129,
            16.0,
        );
        let expected = if index == 0 {
            ApplyAction::HoldStarted
        } else {
            ApplyAction::Held
        };
        assert_eq!(action, expected);
    }
    assert_eq!(c.applied_datagram_count(), 130);
    assert_eq!(c.transaction_deadline_at_ms(), 116.0);
    assert_eq!(c.release_at_frame(frames.next()), Release::None);
    assert_eq!(c.release_at_frame(frames.next()), Release::Deadline);
}

#[test]
fn continuous_output_cannot_move_the_transaction_deadline() {
    let mut c = PresentationCoordinator::new(9);
    for at in 100..116u32 {
        note(&mut c, f64::from(at), at, true, false, 16.0);
        assert_eq!(c.transaction_deadline_at_ms(), 116.0);
    }
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
}

#[test]
fn released_coherent_provenance_survives_urgent_arrivals_until_consumed() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 20, true, true, 16.0);
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
    assert_eq!(
        note(&mut c, 117.0, 21, false, false, 16.0),
        ApplyAction::Now
    );
    assert_eq!(
        (c.first_presentation_id(), c.latest_presentation_id()),
        (20, 21)
    );
    assert_eq!((c.first_display_seq(), c.last_display_seq()), (20, 21));
    assert_eq!(c.applied_datagram_count(), 2);
    assert_eq!(c.last_release_reason(), Release::Deadline);
    c.consume_committed();
    assert!(!c.has_pending_transaction());
    assert_eq!(
        note(&mut c, 110.0, 22, false, false, 16.0),
        ApplyAction::Now
    );
    assert_eq!(c.first_display_seq(), 22);
}

#[test]
fn a_wait_before_coherent_work_cannot_consume_its_frame_budget() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    note(&mut c, 100.0, 20, false, false, 16.0);
    assert_eq!(
        note(&mut c, 115.9, 21, true, false, 16.0),
        ApplyAction::HoldStarted
    );
    assert_eq!(c.first_applied_at_ms(), 100.0);
    close(c.transaction_deadline_at_ms(), 131.9);
    assert_eq!(c.release_at_frame(frames.next()), Release::None);
    assert_eq!(note(&mut c, 120.0, 21, true, true, 16.0), ApplyAction::Held);
    close(c.transaction_deadline_at_ms(), 131.9);
    assert_eq!(c.release_at_frame(frames.next()), Release::Deadline);
}

#[test]
fn a_queued_newer_group_cannot_hold_an_older_complete_transaction() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_member(&mut c, 21, 0, 1, true, 201);
    let period = 1_000.0 / 120.0;
    assert_eq!(
        apply_visual(&mut c, 100.0, 21, 0, 1, true, 201, period),
        ApplyAction::HoldStarted
    );
    // The next transaction's work, decoded and queued behind this one.
    queue_member(&mut c, 22, 0, 1, true, 202);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    // Released: its own apply joins the same commit.
    assert_eq!(
        apply_visual(&mut c, 100.2, 22, 0, 1, true, 202, period),
        ApplyAction::Now
    );
    assert!(!c.is_held());
}

#[test]
fn a_second_coherent_group_behind_a_wait_joins_the_released_commit() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 100.0, 30, true, true, 16.0);
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
    assert_eq!(note(&mut c, 116.1, 31, true, true, 16.0), ApplyAction::Now);
    assert!(!c.is_held());
    assert_eq!(c.last_release_reason(), Release::Deadline);
}

#[test]
fn two_separately_ended_groups_before_one_frame_fold_into_one_commit() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 60, 0, 1, true, 600);
    assert_eq!(
        apply_visual(&mut c, 100.0, 60, 0, 1, true, 600, 16.0),
        ApplyAction::HoldStarted
    );
    // Complete on its own, but coherent work owes a real opportunity.
    assert!(c.membership_early_eligible());
    assert_eq!(c.release_completed_at_pump(), Release::None);
    assert!(c.is_held());
    queue_member(&mut c, 61, 0, 1, true, 601);
    assert_eq!(
        apply_visual(&mut c, 101.5, 61, 0, 1, true, 601, 16.0),
        ApplyAction::Held
    );
    assert_eq!(c.release_completed_at_pump(), Release::None);
    assert_eq!(c.release_at_frame(Frames::new().next()), Release::EndQuiet);
    assert_eq!(c.applied_datagram_count(), 2);
    assert_eq!(
        (c.first_presentation_id(), c.latest_presentation_id()),
        (60, 61)
    );
}

#[test]
fn a_group_after_the_frame_straddles_the_vsync_and_commits_separately() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 70, 0, 1, true, 700);
    apply_visual(&mut c, 100.0, 70, 0, 1, true, 700, 16.0);
    assert_eq!(c.release_at_frame(Frames::new().next()), Release::EndQuiet);
    queue_member(&mut c, 71, 0, 1, true, 701);
    assert_eq!(
        apply_visual(&mut c, 117.0, 71, 0, 1, true, 701, 16.0),
        ApplyAction::Now
    );
}

#[test]
fn a_noncoherent_dependency_hold_owes_no_frame_and_releases_at_the_pump() {
    let mut c = PresentationCoordinator::new(9);
    // A header update depending on a row it has not seen: held, but with no
    // group to coalesce with.
    assert_eq!(
        apply_linked(
            &mut c, 100.0, 61, 0, 0, false, 601, 60, 1, false, GENERATION
        ),
        ApplyAction::HoldStarted
    );
    assert!(!c.coherent());
    assert_eq!(c.release_completed_at_pump(), Release::None);
    apply_linked(&mut c, 101.0, 60, 0, 0, false, 600, 0, 1, false, GENERATION);
    assert_eq!(c.release_completed_at_pump(), Release::MembershipComplete);
    assert_eq!(c.last_release_reason(), Release::MembershipComplete);
}

#[test]
fn a_frame_older_than_the_hold_neither_counts_nor_releases() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 50, 0, 2, false, 500);
    assert_eq!(
        apply_visual(&mut c, 4.78, 50, 0, 2, false, 500, 16.0),
        ApplyAction::HoldStarted
    );
    assert_eq!(c.release_at_frame(4.0), Release::None);
    assert!(c.is_held());
    assert_eq!(c.release_at_frame(6.07), Release::None);
    assert!(c.is_held());
    assert_eq!(c.release_at_frame(14.4), Release::Deadline);
}

#[test]
fn a_stale_frame_cannot_commit_complete_membership_either() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 51, 0, 1, true, 510);
    apply_visual(&mut c, 4.78, 51, 0, 1, true, 510, 16.0);
    assert!(c.membership_early_eligible());
    assert_eq!(c.release_at_frame(4.0), Release::None);
    assert!(c.is_held());
    assert_eq!(c.release_at_frame(6.07), Release::EndQuiet);
}

#[test]
fn a_clipped_redraw_whose_remainder_lands_before_the_next_frame_commits_once() {
    let mut c = PresentationCoordinator::new(9);
    for member in 0..8u16 {
        let at = 4.78 + f64::from(member) * 0.1;
        queue_member(&mut c, 52, member, 12, false, 520 + u32::from(member));
        apply_visual(
            &mut c,
            at,
            52,
            member,
            12,
            false,
            520 + u32::from(member),
            16.0,
        );
    }
    assert_eq!(c.release_at_frame(4.0), Release::None);
    assert_eq!(c.release_at_frame(6.07), Release::None);
    for member in 8..12u16 {
        queue_member(
            &mut c,
            52,
            member,
            12,
            member == 11,
            520 + u32::from(member),
        );
        apply_visual(
            &mut c,
            6.3,
            52,
            member,
            12,
            member == 11,
            520 + u32::from(member),
            16.0,
        );
    }
    assert_eq!(c.release_at_frame(14.4), Release::EndQuiet);
    assert_eq!(c.applied_datagram_count(), 12);
}

#[test]
fn membership_completed_between_frames_releases_at_the_frame() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_member(&mut c, 40, 0, 2, false, 400);
    assert_eq!(
        apply_visual(&mut c, 100.0, 40, 0, 2, false, 400, 16.0),
        ApplyAction::HoldStarted
    );
    assert_eq!(c.release_at_frame(frames.next()), Release::None);
    queue_member(&mut c, 40, 1, 2, true, 401);
    apply_visual(&mut c, 101.0, 40, 1, 2, true, 401, 16.0);
    assert_eq!(c.release_at_frame(frames.next()), Release::EndQuiet);
}

#[test]
fn the_frame_budget_is_identical_at_every_refresh_cadence() {
    for hz in [60u32, 90, 120, 144, 240, 480] {
        let period = 1_000.0 / f64::from(hz);
        let mut c = PresentationCoordinator::new(9);
        let mut frames = Frames::new();
        note(&mut c, 100.0, hz, true, true, period);
        close(c.transaction_deadline_at_ms(), 100.0 + period);
        assert_eq!(c.release_at_frame(frames.next()), Release::None);
        assert_eq!(c.release_at_frame(frames.next()), Release::Deadline);
    }
}

#[test]
fn resets_discard_stale_hold_state() {
    for _boundary in ["resync", "epoch", "teardown"] {
        let mut c = PresentationCoordinator::new(9);
        note(&mut c, 100.0, 12, true, true, 16.0);
        c.reset();
        assert!(!c.is_held());
        assert_eq!(c.first_applied_at_ms(), 0.0);
        assert_eq!(c.applied_datagram_count(), 0);
        assert!(!c.end_seen());
        assert_eq!(
            note(&mut c, 101.0, 13, false, false, 16.0),
            ApplyAction::Now
        );
    }
}

#[test]
fn a_missing_period_uses_the_fastest_supported_display() {
    let mut c = PresentationCoordinator::new(9);
    note(&mut c, 10.0, 1, true, false, f64::NAN);
    close(c.transaction_deadline_at_ms(), 10.0 + 1_000.0 / 480.0);
}

#[test]
fn releases_a_complete_data_first_group_at_its_first_frame() {
    let mut c = PresentationCoordinator::new(9);
    for index in 0..3u16 {
        queue_member(&mut c, 40, index, 3, index == 2, u32::from(index) + 1);
        let action = apply_visual(
            &mut c,
            100.0 + f64::from(index),
            40,
            index,
            3,
            index == 2,
            u32::from(index) + 1,
            16.0,
        );
        let expected = if index == 0 {
            ApplyAction::HoldStarted
        } else {
            ApplyAction::Held
        };
        assert_eq!(action, expected);
    }
    assert!(c.membership_early_eligible());
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
    assert_eq!(c.last_release_reason(), Release::EndQuiet);
}

#[test]
fn reordered_members_cannot_release_before_every_slot_applies() {
    let mut c = PresentationCoordinator::new(9);
    for (at, index) in [(100.0, 3u16), (101.0, 1), (102.0, 0)] {
        queue_member(&mut c, 44, index, 4, index == 3, u32::from(index) + 1);
        apply_visual(
            &mut c,
            at,
            44,
            index,
            4,
            index == 3,
            u32::from(index) + 1,
            16.0,
        );
        assert!(!c.membership_early_eligible());
    }
    queue_member(&mut c, 44, 2, 4, false, 3);
    apply_visual(&mut c, 103.0, 44, 2, 4, false, 3, 16.0);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn a_missing_member_falls_back_to_the_frame_bound() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 50, 0, 2, false, 10);
    apply_visual(&mut c, 100.0, 50, 0, 2, false, 10, 8.0);
    assert!(!c.membership_early_eligible());
    assert_eq!(c.transaction_deadline_at_ms(), 108.0);
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
}

#[test]
fn duplicates_count_once_and_conflicting_identity_disables_only_early_release() {
    let mut duplicate = PresentationCoordinator::new(9);
    queue_member(&mut duplicate, 60, 0, 2, false, 10);
    apply_visual(&mut duplicate, 100.0, 60, 0, 2, false, 10, 16.0);
    queue_member(&mut duplicate, 60, 0, 2, false, 10);
    apply_visual(&mut duplicate, 101.0, 60, 0, 2, false, 10, 16.0);
    assert!(!duplicate.membership_early_eligible());
    queue_member(&mut duplicate, 60, 1, 2, true, 11);
    apply_visual(&mut duplicate, 102.0, 60, 1, 2, true, 11, 16.0);
    assert_eq!(
        at_opportunity(&mut duplicate, &mut Frames::new()),
        Release::EndQuiet
    );

    let mut conflicting = PresentationCoordinator::new(9);
    queue_member(&mut conflicting, 61, 0, 1, true, 20);
    apply_visual(&mut conflicting, 100.0, 61, 0, 1, true, 20, 16.0);
    queue_member(&mut conflicting, 61, 0, 1, true, 21);
    assert!(!conflicting.membership_early_eligible());
    assert_eq!(
        at_deadline(&mut conflicting, &mut Frames::new()),
        Release::Deadline
    );
}

#[test]
fn poisoned_metadata_cannot_regain_early_eligibility_after_a_bound_commit() {
    let mut frames = Frames::new();
    let mut conflicting = PresentationCoordinator::new(9);
    queue_member(&mut conflicting, 62, 0, 2, false, 20);
    apply_visual(&mut conflicting, 100.0, 62, 0, 2, false, 20, 16.0);
    queue_member(&mut conflicting, 62, 0, 2, false, 21);
    assert_eq!(
        at_deadline(&mut conflicting, &mut frames),
        Release::Deadline
    );
    conflicting.consume_committed();
    queue_member(&mut conflicting, 62, 1, 2, true, 22);
    apply_visual(&mut conflicting, 120.0, 62, 1, 2, true, 22, 16.0);
    assert!(!conflicting.membership_early_eligible());
    assert_eq!(
        at_deadline(&mut conflicting, &mut frames),
        Release::Deadline
    );

    let mut malformed = PresentationCoordinator::new(9);
    malformed.note_queued(&m(63, true, true, 0, 257, 30, 9));
    apply(
        &mut malformed,
        A {
            at: 100.0,
            id: 63,
            coherent: true,
            end: true,
            seq: 30,
            rows: 1,
            bytes: 32,
            count: 257,
            ..A::default()
        },
    );
    assert_eq!(at_deadline(&mut malformed, &mut frames), Release::Deadline);
    malformed.consume_committed();
    queue_member(&mut malformed, 63, 0, 1, true, 31);
    apply_visual(&mut malformed, 120.0, 63, 0, 1, true, 31, 16.0);
    assert!(!malformed.membership_early_eligible());
    assert_eq!(at_deadline(&mut malformed, &mut frames), Release::Deadline);
}

#[test]
fn a_reordered_k1_probe_is_a_nonmember_and_the_original_owns_its_slot() {
    let mut c = PresentationCoordinator::new(9);
    c.note_queued(&m(70, true, false, 0, 0, 31, 9));
    c.note_nonvisual_applied(&m(70, true, false, 0, 0, 31, 9));
    queue_member(&mut c, 70, 0, 1, true, 30);
    assert_eq!(
        apply_visual(&mut c, 101.0, 70, 0, 1, true, 30, 16.0),
        ApplyAction::HoldStarted
    );
    assert_eq!(c.membership_group_count(), 1);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn a_complete_clipped_non_end_group_waits_while_the_newest_end_group_governs() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 80, 0, 1, false, 40);
    apply_visual(&mut c, 100.0, 80, 0, 1, false, 40, 16.0);
    assert!(!c.membership_early_eligible());
    queue_member(&mut c, 81, 0, 2, false, 41);
    apply_visual(&mut c, 101.0, 81, 0, 2, false, 41, 16.0);
    assert!(!c.membership_early_eligible());
    queue_member(&mut c, 81, 1, 2, true, 42);
    apply_visual(&mut c, 102.0, 81, 1, 2, true, 42, 16.0);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn a_nonvisual_member_applied_before_the_visual_one_still_proves_completeness() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 90, 0, 2, false, 50);
    c.note_nonvisual_applied(&m(90, true, false, 0, 2, 50, 9));
    assert!(!c.has_pending_transaction());
    queue_member(&mut c, 90, 1, 2, true, 51);
    apply_visual(&mut c, 101.0, 90, 1, 2, true, 51, 16.0);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
    assert_eq!(c.applied_datagram_count(), 1);
}

#[test]
fn a_newer_nonvisual_end_group_closes_an_older_visual_non_end_group() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_member(&mut c, 91, 0, 1, true, 61);
    c.note_nonvisual_applied(&m(91, true, true, 0, 1, 61, 9));
    // An unrelated render has no transaction to consume.
    c.consume_committed();
    assert_eq!(c.membership_group_count(), 1);
    queue_member(&mut c, 90, 0, 1, false, 60);
    assert_eq!(
        apply_visual(&mut c, 101.0, 90, 0, 1, false, 60, 16.0),
        ApplyAction::HoldStarted
    );
    assert!(c.membership_early_eligible());
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    c.consume_committed();
    queue_member(&mut c, 92, 0, 1, true, 62);
    apply_visual(&mut c, 120.0, 92, 0, 1, true, 62, 16.0);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

/// A non-coherent frame queued with row provenance and applied visually, then
/// a newer one applied as a no-op: the urgent-header preamble of three cases.
fn urgent_then_noop(c: &mut PresentationCoordinator, first: u32, first_seq: u32, noops: &[u32]) {
    c.note_queued(&linked(m(first, false, true, 0, 0, first_seq, 9), 0, true));
    apply(
        c,
        A {
            period: 8.0,
            id: first,
            end: true,
            seq: first_seq,
            input: 1,
            rows: 1,
            bytes: 100,
            ..A::default()
        },
    );
    for (offset, &id) in noops.iter().enumerate() {
        let seq = first_seq + 1 + offset as u32;
        c.note_queued(&linked(m(id, false, true, 0, 0, seq, 9), 0, false));
        c.note_nonvisual_applied(&linked(m(id, false, true, 0, 0, seq, 9), 0, false));
    }
}

#[test]
fn a_newer_urgent_noop_header_never_disables_later_complete_redraws() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    urgent_then_noop(&mut c, 1, 1, &[2]);
    c.consume_committed();
    for id in 3..103u32 {
        queue_member(&mut c, id, 0, 1, true, id);
        apply_visual(&mut c, f64::from(id) * 10.0, id, 0, 1, true, id, 8.0);
        assert!(c.membership_early_eligible());
        assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
        c.consume_committed();
    }
    assert_eq!(c.membership_capacity_reset_count(), 0);
}

#[test]
fn a_newer_queued_member_is_not_retired_by_an_older_visual_commit() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_member(&mut c, 10, 0, 1, true, 10);
    apply_visual(&mut c, 0.0, 10, 0, 1, true, 10, 8.0);
    queue_member(&mut c, 11, 0, 2, false, 11);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    c.consume_committed();
    apply_visual(&mut c, 10.0, 11, 0, 2, false, 11, 8.0);
    assert!(!c.membership_early_eligible());
    queue_member(&mut c, 11, 1, 2, true, 12);
    apply_visual(&mut c, 11.0, 11, 1, 2, true, 12, 8.0);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn nonvisual_retirement_crosses_max_to_one_without_poisoning() {
    let mut c = PresentationCoordinator::new(9);
    urgent_then_noop(&mut c, 0xffff_ffff, 20, &[1]);
    c.consume_committed();
    queue_member(&mut c, 2, 0, 1, true, 22);
    apply_visual(&mut c, 10.0, 2, 0, 1, true, 22, 8.0);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn applied_nonvisual_ambiguity_fails_retirement_closed_until_reset() {
    for ids in [vec![0x8000_0001u32], vec![0x6000_0001, 0xc000_0001]] {
        let mut c = PresentationCoordinator::new(9);
        let mut frames = Frames::new();
        urgent_then_noop(&mut c, 1, 20, &ids);
        c.consume_committed();
        queue_member(&mut c, 3, 0, 1, true, 30);
        apply_visual(&mut c, 10.0, 3, 0, 1, true, 30, 8.0);
        assert!(!c.membership_early_eligible());
        assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
        c.reset();
        queue_member(&mut c, 4, 0, 1, true, 31);
        apply_visual(&mut c, 20.0, 4, 0, 1, true, 31, 8.0);
        assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    }
}

#[test]
fn a_queued_only_ambiguous_id_fails_closed_when_it_finally_applies() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    urgent_then_noop(&mut c, 1, 20, &[]);
    c.note_queued(&linked(m(0x8000_0001, false, true, 0, 0, 21, 9), 0, false));
    c.consume_committed();
    c.note_nonvisual_applied(&linked(m(0x8000_0001, false, true, 0, 0, 21, 9), 0, false));
    queue_member(&mut c, 3, 0, 1, true, 30);
    apply_visual(&mut c, 10.0, 3, 0, 1, true, 30, 8.0);
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.reset();
    queue_member(&mut c, 4, 0, 1, true, 31);
    apply_visual(&mut c, 20.0, 4, 0, 1, true, 31, 8.0);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn a_bound_commit_keeps_membership_for_an_immediate_late_tail_commit() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    for index in 0..2u16 {
        queue_member(&mut c, 100, index, 3, false, 60 + u32::from(index));
        apply_visual(
            &mut c,
            100.0 + f64::from(index),
            100,
            index,
            3,
            false,
            60 + u32::from(index),
            8.0,
        );
    }
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.consume_committed();
    queue_member(&mut c, 100, 2, 3, true, 62);
    assert_eq!(
        apply_visual(&mut c, 112.0, 100, 2, 3, true, 62, 8.0),
        ApplyAction::HoldStarted
    );
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn ledger_overflow_and_malformed_metadata_disable_timing_but_not_application() {
    let mut frames = Frames::new();
    let mut overflow = PresentationCoordinator::new(9);
    for id in 1..=65u32 {
        queue_member(&mut overflow, id, 0, 1, true, 1_000 + id);
    }
    apply_visual(&mut overflow, 100.0, 65, 0, 1, true, 1_065, 16.0);
    assert_eq!(overflow.membership_capacity_reset_count(), 1);
    assert!(!overflow.membership_early_eligible());
    assert_eq!(at_deadline(&mut overflow, &mut frames), Release::Deadline);
    overflow.consume_committed();
    queue_member(&mut overflow, 66, 0, 1, true, 1_066);
    apply_visual(&mut overflow, 120.0, 66, 0, 1, true, 1_066, 16.0);
    assert_eq!(
        at_opportunity(&mut overflow, &mut frames),
        Release::EndQuiet
    );
    overflow.consume_committed();
    overflow.reset();
    queue_member(&mut overflow, 67, 0, 1, true, 1_067);
    apply_visual(&mut overflow, 140.0, 67, 0, 1, true, 1_067, 16.0);
    assert_eq!(
        at_opportunity(&mut overflow, &mut frames),
        Release::EndQuiet
    );

    for (index, count) in [(1u16, 0u16), (1, 1), (0, 257)] {
        let mut malformed = PresentationCoordinator::new(9);
        malformed.note_queued(&m(77, true, true, index, count, 5, 9));
        apply(
            &mut malformed,
            A {
                at: 100.0,
                id: 77,
                coherent: true,
                end: true,
                seq: 5,
                rows: 1,
                bytes: 64,
                index,
                count,
                ..A::default()
            },
        );
        assert!(!malformed.membership_early_eligible());
        assert_eq!(at_deadline(&mut malformed, &mut frames), Release::Deadline);
    }
}

#[test]
fn repeated_lossy_overflow_recovers_for_strictly_newer_presentations() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    let mut at = 100.0;
    let leave_incomplete =
        |c: &mut PresentationCoordinator, frames: &mut Frames, at: &mut f64, id: u32| {
            queue_member(c, id, 1, 2, true, 2_000 + id);
            apply_visual(c, *at, id, 1, 2, true, 2_000 + id, 16.0);
            assert_eq!(at_deadline(c, frames), Release::Deadline);
            c.consume_committed();
            *at += 20.0;
        };
    let expect_fresh_early =
        |c: &mut PresentationCoordinator, frames: &mut Frames, at: &mut f64, id: u32| {
            queue_member(c, id, 0, 1, true, 2_000 + id);
            apply_visual(c, *at, id, 0, 1, true, 2_000 + id, 16.0);
            assert_eq!(at_opportunity(c, frames), Release::EndQuiet);
            c.consume_committed();
            *at += 1.0;
        };
    for id in 1..=65 {
        leave_incomplete(&mut c, &mut frames, &mut at, id);
    }
    assert_eq!(c.membership_capacity_reset_count(), 1);
    expect_fresh_early(&mut c, &mut frames, &mut at, 66);

    // A delayed member from behind the retirement floor poisons only its
    // transaction; a strictly newer presentation recovers.
    queue_member(&mut c, 64, 0, 1, true, 3_064);
    apply_visual(&mut c, at, 64, 0, 1, true, 3_064, 16.0);
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.consume_committed();
    at += 20.0;
    expect_fresh_early(&mut c, &mut frames, &mut at, 67);

    for id in 68..=132 {
        leave_incomplete(&mut c, &mut frames, &mut at, id);
    }
    assert_eq!(c.membership_capacity_reset_count(), 2);
    expect_fresh_early(&mut c, &mut frames, &mut at, 133);
}

#[test]
fn serial_retirement_crosses_max_and_old_interleaving_fails_only_its_commit() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    let mut at = 100.0;
    for id in [0xffff_fffeu32, 0xffff_ffff, 1, 2] {
        queue_member(&mut c, id, 0, 1, true, id);
        apply_visual(&mut c, at, id, 0, 1, true, id, 16.0);
        assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
        c.consume_committed();
        at += 1.0;
    }
    queue_member(&mut c, 3, 0, 1, true, 3);
    queue_member(&mut c, 0xffff_ffff, 0, 1, true, 4_000);
    apply_visual(&mut c, at, 3, 0, 1, true, 3, 16.0);
    apply_visual(&mut c, at, 0xffff_ffff, 0, 1, true, 4_000, 16.0);
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.consume_committed();
    at += 20.0;
    queue_member(&mut c, 4, 0, 1, true, 4);
    apply_visual(&mut c, at, 4, 0, 1, true, 4, 16.0);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn retired_nonvisual_duplicates_never_delay_a_fresh_complete_presentation() {
    for duplicate_at in ["before-queue", "after-queue", "after-apply"] {
        for (old, new) in [(1u32, 2u32), (0xffff_ffff, 1)] {
            let mut c = PresentationCoordinator::new(9);
            let mut frames = Frames::new();
            queue_member(&mut c, old, 0, 1, true, 10);
            apply_visual(&mut c, 100.0, old, 0, 1, true, 10, 16.0);
            assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
            c.consume_committed();
            let duplicate = |c: &mut PresentationCoordinator| {
                c.note_queued(&m(old, true, true, 0, 1, 10, 9));
                c.note_nonvisual_applied(&m(old, true, true, 0, 1, 10, 9));
            };
            if duplicate_at == "before-queue" {
                duplicate(&mut c);
            }
            queue_member(&mut c, new, 0, 1, true, 11);
            if duplicate_at == "after-queue" {
                duplicate(&mut c);
            }
            apply_visual(&mut c, 101.0, new, 0, 1, true, 11, 16.0);
            if duplicate_at == "after-apply" {
                duplicate(&mut c);
            }
            assert_eq!(c.membership_group_count(), 1);
            assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
        }
    }
}

#[test]
fn committed_complete_non_end_groups_cannot_be_reopened_by_a_late_noop() {
    for duplicate_at in ["before-queue", "after-queue", "after-apply", "gpu-wait"] {
        for old in [7u32, 0xffff_ffff] {
            let mut c = PresentationCoordinator::new(9);
            let mut frames = Frames::new();
            let next = match old.wrapping_add(1) {
                0 => 1,
                next => next,
            };
            for member in 0..3u16 {
                queue_member(&mut c, old, member, 3, false, 10 + u32::from(member));
                apply_visual(
                    &mut c,
                    100.0,
                    old,
                    member,
                    3,
                    false,
                    10 + u32::from(member),
                    16.0,
                );
            }
            assert!(!c.membership_early_eligible());
            assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
            c.consume_committed();
            assert_eq!(c.membership_group_count(), 0);
            let duplicate = |c: &mut PresentationCoordinator| {
                c.note_queued(&m(old, true, false, 1, 3, 11, 9));
                c.note_nonvisual_applied(&m(old, true, false, 1, 3, 11, 9));
            };
            if duplicate_at == "before-queue" {
                duplicate(&mut c);
            }
            queue_member(&mut c, next, 0, 1, true, 13);
            if duplicate_at == "after-queue" {
                duplicate(&mut c);
            }
            apply_visual(&mut c, 117.0, next, 0, 1, true, 13, 16.0);
            if duplicate_at == "after-apply" {
                duplicate(&mut c);
            }
            assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
            if duplicate_at == "gpu-wait" {
                duplicate(&mut c);
            }
            assert!(!c.is_held());
            assert_eq!(c.membership_group_count(), 1);
        }
    }
}

#[test]
fn an_older_incomplete_visual_tail_still_disables_early_release_after_retirement() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_member(&mut c, 6, 0, 2, false, 8);
    apply_visual(&mut c, 100.0, 6, 0, 2, false, 8, 16.0);
    for member in 0..2u16 {
        queue_member(&mut c, 7, member, 2, false, 10 + u32::from(member));
        apply_visual(
            &mut c,
            100.0,
            7,
            member,
            2,
            false,
            10 + u32::from(member),
            16.0,
        );
    }
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.consume_committed();
    queue_member(&mut c, 8, 0, 1, true, 12);
    apply_visual(&mut c, 117.0, 8, 0, 1, true, 12, 16.0);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    c.consume_committed();
    // The delayed old row still applies, but a real visual change from
    // retired history gains no timing authority.
    queue_member(&mut c, 6, 1, 2, true, 9);
    apply_visual(&mut c, 118.0, 6, 1, 2, true, 9, 16.0);
    assert!(c.is_held());
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
}

#[test]
fn successive_committed_non_end_groups_retire_without_capacity_resets() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    for id in 1..=600u32 {
        for member in 0..2u16 {
            queue_member(&mut c, id, member, 2, false, id * 2 + u32::from(member));
            apply_visual(
                &mut c,
                f64::from(id) * 20.0,
                id,
                member,
                2,
                false,
                id * 2 + u32::from(member),
                16.0,
            );
        }
        assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
        c.consume_committed();
        queue_member(&mut c, id, 0, 2, false, id * 2);
        c.note_nonvisual_applied(&m(id, true, false, 0, 2, id * 2, 9));
        assert_eq!(c.membership_group_count(), 0);
    }
    assert_eq!(c.membership_capacity_reset_count(), 0);
}

#[test]
fn ambiguous_groups_cannot_release_early_or_retire_into_arbitrary_authority() {
    for ids in [
        vec![1u32, 0x8000_0001],
        vec![0x8000_0001, 1],
        vec![1, 0x6000_0001, 0xc000_0001],
        vec![0xc000_0001, 0x6000_0001, 1],
    ] {
        for end in [false, true] {
            for nonvisual_first in [false, true] {
                let mut c = PresentationCoordinator::new(9);
                let mut frames = Frames::new();
                for (index, &id) in ids.iter().enumerate() {
                    let member_end = index == 0 || end;
                    let seq = index as u32 + 1;
                    queue_member(&mut c, id, 0, 1, member_end, seq);
                    if index == 0 && nonvisual_first {
                        c.note_nonvisual_applied(&m(id, true, member_end, 0, 1, seq, 9));
                    } else {
                        apply_visual(&mut c, 100.0, id, 0, 1, member_end, seq, 16.0);
                    }
                }
                assert!(!c.membership_early_eligible());
                // Every visual application stays accounted; the bound still
                // shows them.
                assert_eq!(
                    c.applied_datagram_count() as usize,
                    ids.len() - usize::from(nonvisual_first)
                );
                assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
                c.consume_committed();
                assert_eq!(c.membership_capacity_reset_count(), 0);
                queue_member(&mut c, 2, 0, 1, true, 10);
                apply_visual(&mut c, 120.0, 2, 0, 1, true, 10, 16.0);
                assert!(!c.membership_early_eligible());
                assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
                c.consume_committed();
                c.reset();
                queue_member(&mut c, 3, 0, 1, true, 11);
                apply_visual(&mut c, 140.0, 3, 0, 1, true, 11, 16.0);
                assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
            }
        }
    }
}

#[test]
fn half_range_observations_against_a_retirement_floor_are_unknown() {
    for retired in [1u32, 0x8000_0001, 0xffff_ffff, 0x7fff_ffff] {
        for visual in [false, true] {
            let mut c = PresentationCoordinator::new(9);
            let mut frames = Frames::new();
            queue_member(&mut c, retired, 0, 1, true, 1);
            apply_visual(&mut c, 100.0, retired, 0, 1, true, 1, 16.0);
            assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
            c.consume_committed();
            let ambiguous = retired.wrapping_add(0x8000_0000);
            queue_member(&mut c, ambiguous, 0, 1, false, 2);
            if visual {
                apply_visual(&mut c, 101.0, ambiguous, 0, 1, false, 2, 16.0);
            } else {
                c.note_nonvisual_applied(&m(ambiguous, true, false, 0, 1, 2, 9));
            }
            let next = match retired.wrapping_add(1) {
                0 => 1,
                next => next,
            };
            queue_member(&mut c, next, 0, 1, true, 3);
            apply_visual(&mut c, 102.0, next, 0, 1, true, 3, 16.0);
            assert!(!c.membership_early_eligible());
            assert_eq!(c.applied_datagram_count(), 1 + u32::from(visual));
            assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
            c.consume_committed();
            queue_member(&mut c, next, 0, 1, true, 4);
            apply_visual(&mut c, 120.0, next, 0, 1, true, 4, 16.0);
            assert!(!c.membership_early_eligible());
            c.reset();
            queue_member(&mut c, next, 0, 1, true, 5);
            apply_visual(&mut c, 140.0, next, 0, 1, true, 5, 16.0);
            assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
        }
    }
}

#[test]
fn a_half_range_ambiguous_overflow_stays_fail_closed_until_reset() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    let mut ids = vec![1u32, 0x8000_0001];
    ids.extend(3..=64);
    for &id in &ids {
        queue_member(&mut c, id, 0, 2, false, id);
    }
    queue_member(&mut c, 65, 0, 1, true, 65);
    apply_visual(&mut c, 101.0, 65, 0, 1, true, 65, 16.0);
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.consume_committed();
    queue_member(&mut c, 66, 0, 1, true, 66);
    apply_visual(&mut c, 120.0, 66, 0, 1, true, 66, 16.0);
    assert!(!c.membership_early_eligible());
    c.reset();
    queue_member(&mut c, 67, 0, 1, true, 67);
    apply_visual(&mut c, 140.0, 67, 0, 1, true, 67, 16.0);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn future_generation_observations_cannot_consume_capacity_or_serial_authority() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    for id in 1..=64u32 {
        let generation = if id == 32 { 10 } else { 9 };
        c.note_queued(&m(id, true, false, 0, 2, id, generation));
    }
    queue_member(&mut c, 65, 0, 1, true, 65);
    apply_visual(&mut c, 101.0, 65, 0, 1, true, 65, 16.0);
    assert!(c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::EndQuiet);
    c.consume_committed();
    queue_member(&mut c, 66, 0, 1, true, 66);
    apply_visual(&mut c, 120.0, 66, 0, 1, true, 66, 16.0);
    assert!(c.membership_early_eligible());
}

#[test]
fn membership_completion_is_refresh_rate_independent() {
    for hz in [60u32, 120, 240, 480] {
        let mut c = PresentationCoordinator::new(9);
        let period = 1_000.0 / f64::from(hz);
        queue_member(&mut c, hz, 0, 1, true, hz);
        apply_visual(&mut c, 100.0, hz, 0, 1, true, hz, period);
        close(c.transaction_deadline_at_ms(), 100.0 + period);
        assert_eq!(
            at_opportunity(&mut c, &mut Frames::new()),
            Release::EndQuiet
        );
    }
}

#[test]
fn reset_clears_old_membership_before_presentation_ids_wrap() {
    let mut c = PresentationCoordinator::new(9);
    queue_member(&mut c, 0xffff_ffff, 0, 2, false, 70);
    apply_visual(&mut c, 100.0, 0xffff_ffff, 0, 2, false, 70, 16.0);
    c.reset();
    queue_member(&mut c, 1, 1, 2, true, 72);
    apply_visual(&mut c, 101.0, 1, 1, 2, true, 72, 16.0);
    assert!(!c.membership_early_eligible());
}

#[test]
fn completed_clean_groups_retire_without_capacity_reset_stutter() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    for id in 1..=600u32 {
        let base = id * 2;
        for member in 0..2u16 {
            queue_member(&mut c, id, member, 2, member == 1, base + u32::from(member));
            apply_visual(
                &mut c,
                f64::from(id),
                id,
                member,
                2,
                member == 1,
                base + u32::from(member),
                16.0,
            );
        }
        assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
        c.consume_committed();
        assert_eq!(c.membership_group_count(), 0);
    }
    assert_eq!(c.membership_capacity_reset_count(), 0);
}

#[test]
fn two_interleaved_full_height_groups_do_not_evict_each_other() {
    let mut c = PresentationCoordinator::new(9);
    for member in 0..256u16 {
        for id in [700u32, 701] {
            let seq = 10_000 + u32::from(member) * 2 + (id - 700);
            let end = member == 255;
            let at = 100.0 + f64::from(member) / 1_000.0;
            queue_member(&mut c, id, member, 256, end, seq);
            apply_visual(&mut c, at, id, member, 256, end, seq, 16.0);
        }
    }
    assert_eq!(c.membership_group_count(), 2);
    assert_eq!(c.membership_capacity_reset_count(), 0);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn a_wholly_reordered_row_predecessor_joins_its_header_successor() {
    for successor_first in [true, false] {
        let mut c = PresentationCoordinator::new(9);
        let predecessor = |c: &mut PresentationCoordinator, member: u16| {
            let seq = 400 + u32::from(member);
            queue_linked(c, 40, member, 2, member == 1, seq, 0, true);
            apply_linked(
                c,
                101.0 + f64::from(member),
                40,
                member,
                2,
                member == 1,
                seq,
                0,
                1,
                true,
                GENERATION,
            );
        };
        if !successor_first {
            predecessor(&mut c, 0);
        }
        queue_linked(&mut c, 41, 0, 1, true, 410, 40, false);
        let expected = if successor_first {
            ApplyAction::HoldStarted
        } else {
            ApplyAction::Held
        };
        assert_eq!(
            apply_linked(&mut c, 100.0, 41, 0, 1, true, 410, 40, 0, true, GENERATION),
            expected
        );
        assert!(!c.membership_early_eligible());
        if successor_first {
            predecessor(&mut c, 0);
        }
        assert!(!c.membership_early_eligible());
        predecessor(&mut c, 1);
        assert_eq!(
            at_opportunity(&mut c, &mut Frames::new()),
            Release::EndQuiet
        );
        assert_eq!(c.applied_datagram_count(), 3);
    }
}

#[test]
fn a_committed_row_predecessor_leaves_an_isolated_header_successor_urgent() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_linked(&mut c, 50, 0, 1, true, 500, 0, true);
    apply_linked(&mut c, 100.0, 50, 0, 1, true, 500, 0, 1, true, GENERATION);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    c.consume_committed();
    queue_linked(&mut c, 51, 0, 1, true, 501, 50, false);
    assert_eq!(
        apply_linked(&mut c, 101.0, 51, 0, 1, true, 501, 50, 0, true, GENERATION),
        ApplyAction::HoldStarted
    );
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn a_missing_predecessor_spends_only_the_bound_and_cannot_rehold_successors() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    queue_linked(&mut c, 61, 0, 1, true, 601, 60, false);
    assert_eq!(
        apply_linked(&mut c, 100.0, 61, 0, 1, true, 601, 60, 0, true, GENERATION),
        ApplyAction::HoldStarted
    );
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.consume_committed();
    queue_linked(&mut c, 62, 0, 1, true, 602, 60, false);
    apply_linked(&mut c, 117.0, 62, 0, 1, true, 602, 60, 0, true, GENERATION);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    c.consume_committed();
    // The delayed predecessor still applies, with spent timing authority.
    queue_linked(&mut c, 60, 0, 1, true, 600, 0, true);
    assert_eq!(
        apply_linked(&mut c, 118.0, 60, 0, 1, true, 600, 0, 1, true, GENERATION),
        ApplyAction::HoldStarted
    );
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
}

#[test]
fn row_predecessors_close_transitively_across_three_reordered_groups() {
    let mut c = PresentationCoordinator::new(9);
    queue_linked(&mut c, 72, 0, 1, true, 702, 71, false);
    apply_linked(&mut c, 100.0, 72, 0, 1, true, 702, 71, 0, true, GENERATION);
    queue_linked(&mut c, 71, 0, 1, true, 701, 70, true);
    apply_linked(&mut c, 101.0, 71, 0, 1, true, 701, 70, 1, true, GENERATION);
    assert!(!c.membership_early_eligible());
    queue_linked(&mut c, 70, 0, 1, true, 700, 0, true);
    apply_linked(&mut c, 102.0, 70, 0, 1, true, 700, 0, 1, true, GENERATION);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn a_late_nonvisual_dependency_original_still_reveals_its_missing_ancestor() {
    let mut c = PresentationCoordinator::new(9);
    queue_linked(&mut c, 72, 0, 1, true, 702, 71, false);
    apply_linked(&mut c, 100.0, 72, 0, 1, true, 702, 71, 0, true, GENERATION);
    queue_linked(&mut c, 71, 0, 1, true, 701, 70, true);
    c.note_nonvisual_applied(&linked(m(71, true, true, 0, 1, 701, 9), 70, true));
    assert!(!c.membership_early_eligible());
    queue_linked(&mut c, 70, 0, 1, true, 700, 0, true);
    apply_linked(&mut c, 102.0, 70, 0, 1, true, 700, 0, 1, true, GENERATION);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn a_dependency_bearing_probe_never_fabricates_completeness() {
    let mut c = PresentationCoordinator::new(9);
    c.note_queued(&linked(m(81, true, false, 0, 0, 801, 9), 80, false));
    c.note_nonvisual_applied(&linked(m(81, true, false, 0, 0, 801, 9), 80, false));
    assert!(!c.has_pending_transaction());
    queue_linked(&mut c, 81, 0, 1, true, 800, 80, false);
    apply_linked(&mut c, 101.0, 81, 0, 1, true, 800, 80, 0, true, GENERATION);
    assert!(!c.membership_early_eligible());
    queue_linked(&mut c, 80, 0, 1, true, 799, 0, true);
    apply_linked(&mut c, 102.0, 80, 0, 1, true, 799, 0, 1, true, GENERATION);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn a_nonvisual_dependency_probe_cannot_rehold_a_later_full_cover_root() {
    let mut c = PresentationCoordinator::new(9);
    c.note_queued(&linked(m(81, true, false, 0, 0, 801, 9), 80, false));
    c.note_nonvisual_applied(&linked(m(81, true, false, 0, 0, 801, 9), 80, false));
    queue_linked(&mut c, 82, 0, 1, true, 802, 0, true);
    assert_eq!(
        apply_linked(&mut c, 101.0, 82, 0, 1, true, 802, 0, 1, true, GENERATION),
        ApplyAction::HoldStarted
    );
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
    c.consume_committed();
    // The probe upgrades into its original, whose unresolved predecessor is
    // authority for this later transaction.
    queue_linked(&mut c, 81, 0, 1, true, 800, 80, false);
    apply_linked(&mut c, 102.0, 81, 0, 1, true, 800, 80, 0, true, GENERATION);
    assert!(!c.membership_early_eligible());
}

#[test]
fn a_complete_nonvisual_successor_cannot_burden_a_later_full_cover_root() {
    let mut c = PresentationCoordinator::new(9);
    queue_linked(&mut c, 81, 0, 1, true, 801, 80, false);
    c.note_nonvisual_applied(&linked(m(81, true, true, 0, 1, 801, 9), 80, false));
    assert!(!c.has_pending_transaction());
    queue_linked(&mut c, 82, 0, 1, true, 802, 0, true);
    apply_linked(&mut c, 101.0, 82, 0, 1, true, 802, 0, 1, true, GENERATION);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn an_older_nonancestor_cannot_burden_a_successor_with_an_exact_predecessor() {
    let mut c = PresentationCoordinator::new(9);
    queue_linked(&mut c, 90, 0, 2, false, 900, 0, true);
    c.note_nonvisual_applied(&linked(m(90, true, false, 0, 2, 900, 9), 0, true));
    queue_linked(&mut c, 100, 0, 1, true, 1_000, 99, true);
    assert_eq!(
        apply_linked(
            &mut c, 101.0, 100, 0, 1, true, 1_000, 99, 1, true, GENERATION
        ),
        ApplyAction::HoldStarted
    );
    assert!(!c.membership_early_eligible());
    queue_linked(&mut c, 99, 0, 1, true, 990, 0, true);
    apply_linked(&mut c, 102.0, 99, 0, 1, true, 990, 0, 1, true, GENERATION);
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

fn urgent_row(c: &mut PresentationCoordinator) -> ApplyAction {
    apply(
        c,
        A {
            at: 100.0,
            id: 90,
            seq: 900,
            rows: 1,
            bytes: 16,
            ..A::default()
        },
    )
}

#[test]
fn a_queued_coherent_successor_never_reholds_a_released_urgent_transaction() {
    let mut c = PresentationCoordinator::new(9);
    assert_eq!(urgent_row(&mut c), ApplyAction::Now);
    c.note_queued(&linked(m(92, true, true, 0, 1, 902, 9), 91, false));
    assert!(!c.is_held());
    c.note_nonvisual_applied(&linked(m(92, true, true, 0, 1, 902, 9), 91, false));
    assert!(!c.is_held());
    assert_eq!(c.release_completed_at_pump(), Release::None);
    assert_eq!(c.release_at_frame(Frames::new().next()), Release::None);
    assert_eq!(c.last_release_reason(), Release::Urgent);
}

#[test]
fn a_queued_dependency_probe_cannot_rehold_applied_full_cover_pixels() {
    let mut c = PresentationCoordinator::new(9);
    assert_eq!(urgent_row(&mut c), ApplyAction::Now);
    c.note_queued(&linked(m(92, true, false, 0, 0, 902, 9), 91, false));
    assert!(!c.is_held());
}

#[test]
fn a_full_cover_root_cannot_bypass_an_active_incomplete_predecessor() {
    let mut c = PresentationCoordinator::new(9);
    queue_linked(&mut c, 100, 0, 2, false, 1_000, 0, true);
    apply_linked(
        &mut c, 100.0, 100, 0, 2, false, 1_000, 0, 1, true, GENERATION,
    );
    queue_linked(&mut c, 101, 0, 1, true, 1_001, 0, true);
    apply_linked(
        &mut c, 101.0, 101, 0, 1, true, 1_001, 0, 1, true, GENERATION,
    );
    assert!(!c.membership_early_eligible());
    queue_linked(&mut c, 100, 1, 2, true, 1_002, 0, true);
    apply_linked(
        &mut c, 102.0, 100, 1, 2, true, 1_002, 0, 1, true, GENERATION,
    );
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

#[test]
fn slot_reuse_clears_member_identity_before_a_probe_upgrades() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    for member in 0..2u16 {
        let seq = 100 + u32::from(member);
        queue_member(&mut c, 10, member, 2, member == 1, seq);
        apply_visual(
            &mut c,
            100.0 + f64::from(member),
            10,
            member,
            2,
            member == 1,
            seq,
            16.0,
        );
    }
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    c.consume_committed();
    c.note_queued(&m(20, true, false, 0, 0, 200, 9));
    c.note_nonvisual_applied(&m(20, true, false, 0, 0, 200, 9));
    for member in 0..2u16 {
        let seq = 210 + u32::from(member);
        queue_member(&mut c, 20, member, 2, member == 1, seq);
        apply_visual(
            &mut c,
            111.0 + f64::from(member),
            20,
            member,
            2,
            member == 1,
            seq,
            16.0,
        );
    }
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn dependency_overflow_recovers_after_its_bound_without_a_reset() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    for id in 1..=63u32 {
        queue_member(&mut c, id, 0, 2, false, id);
    }
    queue_linked(&mut c, 65, 0, 1, true, 650, 64, false);
    apply_linked(&mut c, 100.0, 65, 0, 1, true, 650, 64, 0, true, GENERATION);
    assert_eq!(c.membership_capacity_reset_count(), 1);
    assert!(!c.membership_early_eligible());
    assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
    c.consume_committed();
    queue_linked(&mut c, 66, 0, 1, true, 660, 65, false);
    apply_linked(&mut c, 120.0, 66, 0, 1, true, 660, 65, 0, true, GENERATION);
    assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
}

#[test]
fn reset_discards_predecessor_satisfaction_from_the_previous_lineage() {
    let mut c = PresentationCoordinator::new(9);
    queue_linked(&mut c, 110, 0, 1, true, 1_100, 0, true);
    apply_linked(
        &mut c, 100.0, 110, 0, 1, true, 1_100, 0, 1, true, GENERATION,
    );
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
    c.consume_committed();
    c.reset();
    queue_linked(&mut c, 111, 0, 1, true, 1_110, 110, false);
    apply_linked(
        &mut c, 101.0, 111, 0, 1, true, 1_110, 110, 0, true, GENERATION,
    );
    assert!(!c.membership_early_eligible());
}

#[test]
fn a_coherent_k1_probe_may_precede_its_urgent_noncoherent_original() {
    let mut c = PresentationCoordinator::new(9);
    c.note_queued(&m(30, true, false, 0, 0, 300, 9));
    c.note_nonvisual_applied(&m(30, true, false, 0, 0, 300, 9));
    let original = A {
        at: 101.0,
        id: 30,
        end: true,
        seq: 301,
        rows: 1,
        bytes: 16,
        ..A::default()
    };
    assert_eq!(apply(&mut c, original), ApplyAction::Now);
    assert!(c.membership_early_eligible());
}

#[test]
fn conflicting_self_and_half_range_predecessors_poison_only_their_group() {
    for invalid in [90u32, 0x8000_005a] {
        let mut c = PresentationCoordinator::new(9);
        let mut frames = Frames::new();
        queue_linked(&mut c, 90, 0, 1, true, 900, invalid, false);
        apply_linked(
            &mut c, 100.0, 90, 0, 1, true, 900, invalid, 0, true, GENERATION,
        );
        assert!(!c.membership_early_eligible());
        assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
        c.consume_committed();
        queue_linked(&mut c, 91, 0, 1, true, 901, 0, true);
        apply_linked(&mut c, 120.0, 91, 0, 1, true, 901, 0, 1, true, GENERATION);
        assert!(c.membership_early_eligible());
        c.reset();
        queue_linked(&mut c, 92, 0, 1, true, 902, 0, true);
        apply_linked(&mut c, 140.0, 92, 0, 1, true, 902, 0, 1, true, GENERATION);
        assert_eq!(at_opportunity(&mut c, &mut frames), Release::EndQuiet);
    }

    let mut conflicting = PresentationCoordinator::new(9);
    queue_linked(&mut conflicting, 101, 0, 1, true, 1_001, 99, false);
    queue_linked(&mut conflicting, 101, 0, 1, true, 1_001, 100, false);
    apply_linked(
        &mut conflicting,
        101.0,
        101,
        0,
        1,
        true,
        1_001,
        100,
        0,
        true,
        GENERATION,
    );
    assert!(!conflicting.membership_early_eligible());
    assert_eq!(
        at_deadline(&mut conflicting, &mut Frames::new()),
        Release::Deadline
    );
}

#[test]
fn row_predecessor_order_crosses_max_to_one() {
    let mut c = PresentationCoordinator::new(9);
    queue_linked(&mut c, 1, 0, 1, true, 1, 0xffff_ffff, false);
    apply_linked(
        &mut c,
        100.0,
        1,
        0,
        1,
        true,
        1,
        0xffff_ffff,
        0,
        true,
        GENERATION,
    );
    queue_linked(&mut c, 0xffff_ffff, 0, 1, true, 0xffff_ffff, 0, true);
    apply_linked(
        &mut c,
        101.0,
        0xffff_ffff,
        0,
        1,
        true,
        0xffff_ffff,
        0,
        1,
        true,
        GENERATION,
    );
    assert_eq!(
        at_opportunity(&mut c, &mut Frames::new()),
        Release::EndQuiet
    );
}

// Explicit generation adoption.

#[test]
fn old_queued_work_is_discarded_before_the_snapshot_and_every_later_echo() {
    for chained in [false, true] {
        let mut c = PresentationCoordinator::new(10);
        let echo = |c: &mut PresentationCoordinator, id: u32, generation: u32| {
            let predecessor = if chained { id - 1 } else { 0 };
            c.note_queued(&linked(
                m(id, true, true, 0, 1, id, generation),
                predecessor,
                true,
            ));
            apply(
                c,
                A {
                    at: 100.0,
                    id,
                    coherent: true,
                    end: true,
                    seq: id,
                    generation,
                    input: id,
                    rows: 1,
                    bytes: 64,
                    count: 1,
                    predecessor,
                    ..A::default()
                },
            );
            assert_eq!(c.release_at_frame(101.0), Release::EndQuiet);
            assert_eq!(c.release_frame_count(), 1);
            assert_eq!(c.membership_release_disable_bits(), 0);
            c.consume_committed();
        };
        for id in 1..=20 {
            echo(&mut c, id, 10);
        }
        c.note_queued(&linked(
            m(21, true, true, 0, 1, 21, 10),
            if chained { 20 } else { 0 },
            true,
        ));
        assert!(!c.has_pending_transaction());
        assert_eq!(c.membership_group_count(), 1);
        c.adopt_generation(11);
        assert_eq!(c.membership_group_count(), 0);
        for id in 1..=60 {
            echo(&mut c, id, 11);
        }
    }
}

#[test]
fn adoption_clears_partial_history_and_stale_malformed_observations_cannot_poison_it() {
    let mut c = PresentationCoordinator::new(8);
    apply_linked(&mut c, 100.0, 40, 0, 3, false, 40, 0, 1, true, 8);
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
    c.consume_committed();
    c.adopt_generation(9);
    for id in [0u32, 40, 0x8000_0001] {
        c.note_queued(&linked(m(id, true, true, 4, 1, 0, 8), id, true));
        c.note_nonvisual_applied(&linked(m(id, true, true, 4, 1, 0, 8), id, true));
    }
    assert_eq!(c.membership_group_count(), 0);
    apply_visual(&mut c, 120.0, 1, 0, 1, true, 1, 16.0);
    assert_eq!(c.release_at_frame(121.0), Release::EndQuiet);
    assert_eq!(c.membership_release_disable_bits(), 0);
}

#[test]
fn unadopted_and_future_observations_have_no_authority() {
    let mut c = PresentationCoordinator::new(0);
    c.note_queued(&m(1, true, true, 0, 1, 1, 9));
    assert_eq!(c.membership_group_count(), 0);
    c.adopt_generation(9);
    c.note_queued(&linked(m(1, true, true, 5, 1, 0, 10), 1, true));
    c.note_nonvisual_applied(&m(1, true, true, 0, 1, 1, 10));
    apply(
        &mut c,
        A {
            at: 100.0,
            id: 1,
            coherent: true,
            end: true,
            seq: 1,
            generation: 10,
            rows: 1,
            bytes: 64,
            count: 1,
            ..A::default()
        },
    );
    assert_eq!(c.generation(), 9);
    assert!(!c.has_pending_transaction());
    assert_eq!(c.membership_group_count(), 0);
    apply_visual(&mut c, 101.0, 1, 0, 1, true, 1, 16.0);
    assert_eq!(c.release_at_frame(102.0), Release::EndQuiet);
}

#[test]
fn membership_observed_ahead_is_observed_again_after_adoption() {
    let mut c = PresentationCoordinator::new(8);
    c.note_queued(&m(1, true, true, 0, 1, 1, 9));
    assert_eq!(c.membership_group_count(), 0);
    c.adopt_generation(9);
    apply_visual(&mut c, 101.0, 1, 0, 1, true, 1, 16.0);
    assert!(c.membership_early_eligible());
    assert_eq!(c.release_at_frame(102.0), Release::EndQuiet);
}

#[test]
fn generation_wrap_lower_roots_and_repeated_roots_discard_old_authority() {
    let mut c = PresentationCoordinator::new(0xffff_ffff);
    for generation in [1u32, 8, 2, 2] {
        let previous = c.generation();
        apply(
            &mut c,
            A {
                at: 100.0,
                id: 77,
                coherent: true,
                seq: 1,
                generation: previous,
                rows: 1,
                bytes: 64,
                count: 2,
                ..A::default()
            },
        );
        c.adopt_generation(generation);
        assert!(!c.has_pending_transaction());
        assert_eq!(c.membership_group_count(), 0);
        apply(
            &mut c,
            A {
                at: 101.0,
                id: 1,
                coherent: true,
                end: true,
                seq: 2,
                generation,
                rows: 1,
                bytes: 64,
                count: 1,
                ..A::default()
            },
        );
        assert_eq!(c.release_at_frame(102.0), Release::EndQuiet);
        assert_eq!(c.membership_release_disable_bits(), 0);
        c.consume_committed();
    }
}

#[test]
fn serial_ambiguity_persists_within_its_generation_and_clears_on_adoption() {
    for ids in [vec![1u32, 0x8000_0001], vec![1, 0x6000_0001, 0xc000_0001]] {
        let mut c = PresentationCoordinator::new(9);
        let mut frames = Frames::new();
        for &id in &ids {
            queue_member(&mut c, id, 0, 1, true, id);
        }
        apply_visual(&mut c, 100.0, 1, 0, 1, true, 1, 16.0);
        assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
        assert_ne!(c.membership_release_disable_bits() & DISABLE_SERIAL, 0);
        c.consume_committed();
        apply_visual(&mut c, 120.0, 2, 0, 1, true, 2, 16.0);
        assert_eq!(at_deadline(&mut c, &mut frames), Release::Deadline);
        assert_ne!(
            c.membership_release_disable_bits() & DISABLE_INHERITED_SERIAL,
            0
        );
        c.consume_committed();
        c.adopt_generation(10);
        apply_linked(&mut c, 140.0, 1, 0, 1, true, 1, 0, 1, true, 10);
        assert_eq!(c.release_at_frame(141.0), Release::EndQuiet);
        assert_eq!(c.membership_release_disable_bits(), 0);
    }
}

#[test]
fn release_bits_are_captured_before_the_wait_for_the_screen() {
    let mut c = PresentationCoordinator::new(9);
    apply_visual(&mut c, 100.0, 1, 0, 2, false, 1, 16.0);
    assert_eq!(at_deadline(&mut c, &mut Frames::new()), Release::Deadline);
    let bits = DISABLE_INCOMPLETE | DISABLE_END;
    assert_eq!(c.membership_release_disable_bits(), bits);
    c.note_nonvisual_applied(&m(1, true, true, 1, 2, 2, 9));
    assert!(c.membership_early_eligible());
    assert_eq!(c.membership_release_disable_bits(), bits);
}

#[test]
fn release_bits_name_missing_predecessors_poison_capacity_and_retired_writes() {
    let mut c = PresentationCoordinator::new(9);
    let mut frames = Frames::new();
    apply_linked(&mut c, 100.0, 2, 0, 1, true, 2, 1, 1, true, GENERATION);
    at_deadline(&mut c, &mut frames);
    assert_eq!(c.membership_release_disable_bits(), DISABLE_PREDECESSOR);
    c.adopt_generation(9);
    apply_linked(&mut c, 100.0, 2, 0, 1, true, 2, 2, 1, true, GENERATION);
    at_deadline(&mut c, &mut frames);
    assert_ne!(c.membership_release_disable_bits() & DISABLE_POISONED, 0);
    assert_eq!(c.membership_release_disable_bits() & DISABLE_SERIAL, 0);
    c.adopt_generation(9);
    for id in 1..=65u32 {
        queue_member(&mut c, id, 0, 1, true, id);
    }
    apply_visual(&mut c, 100.0, 65, 0, 1, true, 65, 16.0);
    at_deadline(&mut c, &mut frames);
    assert_eq!(c.membership_release_disable_bits(), DISABLE_CAPACITY);
    c.consume_committed();
    apply_visual(&mut c, 120.0, 65, 0, 1, true, 65, 16.0);
    at_deadline(&mut c, &mut frames);
    assert_ne!(
        c.membership_release_disable_bits() & DISABLE_RETIRED_VISUAL,
        0
    );
}

#[test]
fn malformed_metadata_on_another_queued_group_cannot_poison_a_complete_one() {
    let mut c = PresentationCoordinator::new(9);
    apply_visual(&mut c, 100.0, 1, 0, 1, true, 1, 16.0);
    c.note_queued(&linked(m(2, true, true, 5, 1, 2, 9), 2, true));
    assert_eq!(c.release_at_frame(101.0), Release::EndQuiet);
    assert_eq!(c.membership_release_disable_bits(), 0);
}

// A complete paced state releases as it lands.

/// One applied member of a paced state: the demand serial its grant
/// consumed, and whether the daemon could send nothing newer without another.
#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript suite's applyPacedMember, so each case reads as the browser's"
)]
fn paced(
    c: &mut PresentationCoordinator,
    at: f64,
    id: u32,
    end: bool,
    serial: u32,
    awaits: bool,
    index: u16,
    count: u16,
) -> ApplyAction {
    apply(
        c,
        A {
            at,
            id,
            coherent: true,
            end,
            seq: id * 8 + u32::from(index),
            input: 1,
            rows: 1,
            bytes: 100,
            index,
            count,
            serial,
            awaits,
            ..A::default()
        },
    )
}

#[test]
fn an_end_state_awaiting_a_grant_may_commit_before_the_next_frame() {
    let mut c = PresentationCoordinator::new(9);
    assert_eq!(
        paced(&mut c, 100.0, 1, true, 5, true, 0, 1),
        ApplyAction::HoldStarted
    );
    // The pump edge still refuses coherent pixels; the early path owns this.
    assert_eq!(c.release_completed_at_pump(), Release::None);
    assert!(c.early_release_eligible());
    assert!(c.with_early_release(|| true));
    assert!(!c.is_held());
    assert_eq!(c.last_release_reason(), Release::PacedComplete);
}

#[test]
fn a_continuing_state_awaiting_a_grant_releases_without_waiting_for_another() {
    let mut c = PresentationCoordinator::new(9);
    paced(&mut c, 100.0, 1, false, 5, true, 0, 1);
    assert!(c.early_release_eligible());
    assert!(c.with_early_release(|| true));
    assert_eq!(c.applied_datagram_count(), 1);
    assert_eq!(c.last_release_reason(), Release::PacedComplete);
}

#[test]
fn the_first_state_after_an_end_a_reset_a_generation_or_an_echo_releases() {
    for before in ["end", "reset", "adopt", "urgent"] {
        let mut c = PresentationCoordinator::new(9);
        match before {
            "end" => {
                paced(&mut c, 100.0, 1, true, 5, true, 0, 1);
                assert!(c.with_early_release(|| true));
                c.consume_committed();
            }
            "reset" => {
                paced(&mut c, 100.0, 1, false, 5, true, 0, 1);
                c.reset();
            }
            "adopt" => {
                paced(&mut c, 100.0, 1, false, 5, true, 0, 1);
                c.adopt_generation(9);
            }
            _ => {
                assert_eq!(note(&mut c, 100.0, 1, false, false, 16.0), ApplyAction::Now);
                c.consume_committed();
            }
        }
        paced(&mut c, 117.0, 2, false, 6, true, 0, 1);
        assert!(c.early_release_eligible(), "{before}");
    }
}

#[test]
fn a_newest_frame_without_the_awaits_fact_keeps_the_frame_rules() {
    let mut c = PresentationCoordinator::new(9);
    paced(&mut c, 100.0, 1, false, 5, true, 0, 1);
    paced(&mut c, 101.0, 2, false, 5, true, 0, 1);
    paced(&mut c, 102.0, 3, true, 5, false, 0, 1);
    assert!(!c.early_release_eligible());
    assert_ne!(c.release_at_frame(108.0), Release::PacedComplete);
}

#[test]
fn without_the_awaits_fact_the_frame_rules_are_unchanged() {
    let mut ended = PresentationCoordinator::new(9);
    paced(&mut ended, 100.0, 1, true, 5, false, 0, 1);
    assert!(!ended.early_release_eligible());
    assert!(!ended.with_early_release(|| true));
    assert_eq!(ended.release_at_frame(108.0), Release::EndQuiet);

    let mut continuing = PresentationCoordinator::new(9);
    paced(&mut continuing, 100.0, 1, false, 5, false, 0, 1);
    paced(&mut continuing, 101.0, 2, false, 6, false, 0, 1);
    assert!(!continuing.early_release_eligible());
    assert_eq!(continuing.release_at_frame(108.0), Release::None);
    assert_eq!(continuing.release_at_frame(124.0), Release::Deadline);
}

#[test]
fn a_missing_member_blocks_the_early_close_and_the_bound_still_holds() {
    let mut c = PresentationCoordinator::new(9);
    paced(&mut c, 100.0, 1, false, 5, true, 0, 2);
    paced(&mut c, 101.0, 2, true, 6, true, 0, 1);
    assert!(!c.early_release_eligible());
    assert_eq!(c.release_at_frame(108.0), Release::None);
    assert_eq!(c.release_at_frame(124.0), Release::Deadline);
    assert_ne!(c.membership_release_disable_bits() & DISABLE_INCOMPLETE, 0);
}

#[test]
fn a_queued_member_not_yet_applied_blocks_the_early_close() {
    let mut c = PresentationCoordinator::new(9);
    paced(&mut c, 100.0, 1, false, 5, true, 0, 2);
    queue_member(&mut c, 1, 1, 2, false, 9);
    assert!(!c.early_release_eligible());
}

#[test]
fn a_group_whose_members_disagree_on_the_fact_fails_closed() {
    let mut c = PresentationCoordinator::new(9);
    paced(&mut c, 100.0, 1, false, 5, true, 0, 2);
    paced(&mut c, 101.0, 1, true, 5, false, 1, 2);
    assert!(!c.early_release_eligible());
    let mut serials = PresentationCoordinator::new(9);
    paced(&mut serials, 100.0, 1, false, 5, true, 0, 2);
    paced(&mut serials, 101.0, 1, true, 6, true, 1, 2);
    assert!(!serials.early_release_eligible());
}

#[test]
fn a_claim_outranks_the_paced_rule() {
    let mut c = PresentationCoordinator::new(9);
    c.set_closure(Closure::Pending);
    paced(&mut c, 100.0, 1, true, 5, true, 0, 1);
    assert!(!c.early_release_eligible());
    assert_eq!(c.release_at_frame(108.0), Release::None);
    assert_eq!(c.release_at_frame(124.0), Release::None);
    c.set_closure(Closure::Met);
    assert!(c.with_early_release(|| true));
    assert_eq!(c.last_release_reason(), Release::ClosureComplete);
}

#[test]
fn refused_early_a_complete_paced_state_releases_on_its_first_frame() {
    let mut c = PresentationCoordinator::new(9);
    paced(&mut c, 100.0, 1, false, 5, true, 0, 1);
    assert!(!c.with_early_release(|| false));
    assert!(c.is_held());
    assert_eq!(c.last_release_reason(), Release::None);
    assert_eq!(c.release_at_frame(108.0), Release::PacedComplete);
    assert_eq!(c.release_frame_time_ms(), 108.0);
}

#[test]
fn a_paced_flood_commits_every_paid_state_as_it_lands() {
    // States arrive 1 ms after each frame, each paid by the grant that frame
    // issued. Without the flag the frame rule commits pairs; with it each
    // state commits alone.
    let run = |awaits: bool| -> Vec<(f64, u32)> {
        let mut c = PresentationCoordinator::new(9);
        let mut commits = Vec::new();
        for k in 0..14u32 {
            let frame = 1_000.0 + f64::from(k) * 16.0;
            if c.release_at_frame(frame) != Release::None {
                commits.push((frame, c.applied_datagram_count()));
                c.consume_committed();
            }
            if k >= 12 {
                continue;
            }
            paced(&mut c, frame + 1.0, k + 1, false, k + 1, awaits, 0, 1);
            if c.with_early_release(|| true) {
                commits.push((frame + 1.0, c.applied_datagram_count()));
                c.consume_committed();
            }
        }
        commits
    };
    let unpaced: Vec<u32> = run(false).iter().map(|&(_, states)| states).collect();
    assert_eq!(unpaced, [2; 6]);
    let paced_commits = run(true);
    assert!(paced_commits.iter().all(|&(_, states)| states == 1));
    let at: Vec<f64> = paced_commits.iter().map(|&(at, _)| at - 1_000.0).collect();
    let expected: Vec<f64> = (0..12).map(|k| f64::from(k) * 16.0 + 1.0).collect();
    assert_eq!(at, expected);
}
