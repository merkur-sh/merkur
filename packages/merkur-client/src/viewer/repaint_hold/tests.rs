//! `display-repaint-hold.test.ts` and `display-repair-marker.test.ts`, case
//! for case.

use super::super::{display_serial_is_newer, display_serial_reached};
use super::*;

/// Every apply and marker here is observed at this instant...
const OBSERVED_AT_MS: f64 = 100.0;
/// ...and every host frame is delivered after it.
const FRAME_AFTER_ANCHOR_MS: f64 = 1_000.0;

type Versions = [u32; 256];

fn versions() -> Versions {
    [0; 256]
}

fn applied_at(
    hold: &mut RepaintHold,
    versions: &mut Versions,
    generation: u32,
    seq: u32,
    rows: &[u16],
    visual: bool,
    observed_at_ms: f64,
) -> bool {
    for &row in rows {
        versions[usize::from(row)] = seq;
    }
    let versions = *versions;
    hold.note_applied(generation, seq, visual, observed_at_ms, |row| {
        versions[usize::from(row)]
    })
}

fn applied(
    hold: &mut RepaintHold,
    versions: &mut Versions,
    generation: u32,
    seq: u32,
    rows: &[u16],
) -> bool {
    applied_at(hold, versions, generation, seq, rows, true, OBSERVED_AT_MS)
}

fn repair_end_as(
    hold: &mut RepaintHold,
    versions: &Versions,
    generation: u32,
    members: &[(u16, u32)],
    repair_id: u32,
) -> bool {
    let marker = RepairEnd {
        generation,
        repair_id,
        members: members.to_vec(),
    };
    hold.note_repair_end(&marker, OBSERVED_AT_MS, |row| versions[usize::from(row)])
}

fn repair_end(
    hold: &mut RepaintHold,
    versions: &Versions,
    generation: u32,
    members: &[(u16, u32)],
) -> bool {
    repair_end_as(hold, versions, generation, members, 41)
}

/// Deliver the whole frame budget and report whether it released.
fn frame_budget(hold: &mut RepaintHold) -> bool {
    let mut released = false;
    for _ in 0..HOLD_FRAMES {
        released = hold.note_frame(FRAME_AFTER_ANCHOR_MS) || released;
    }
    released
}

fn armed() -> (RepaintHold, Versions) {
    let mut hold = RepaintHold::default();
    hold.arm(41);
    (hold, versions())
}

#[test]
fn a_fresh_hold_holds_nothing() {
    let mut hold = RepaintHold::default();
    let mut versions = versions();
    assert!(!hold.is_held());
    assert_eq!(hold.deadline_ms(), None);
    assert!(!applied(&mut hold, &mut versions, 7, 100, &[0]));
    assert!(!hold.expire(1_000_000.0));
    assert!(!hold.note_frame(FRAME_AFTER_ANCHOR_MS));
}

#[test]
fn the_paint_is_held_until_every_repaired_row_reaches_its_admitted_sequence() {
    let (mut hold, mut versions) = armed();
    assert!(!applied(&mut hold, &mut versions, 7, 101, &[0]));
    assert!(!repair_end(
        &mut hold,
        &versions,
        7,
        &[(0, 101), (1, 102), (2, 103), (3, 104)]
    ));
    assert!(!applied(&mut hold, &mut versions, 7, 102, &[1]));
    assert!(!applied(&mut hold, &mut versions, 7, 103, &[2]));
    assert!(hold.is_held());
    assert!(applied(&mut hold, &mut versions, 7, 104, &[3]));
    assert!(!hold.is_held());
}

#[test]
fn an_end_marker_arriving_first_cannot_hide_an_interior_datagram_hole() {
    let (mut hold, mut versions) = armed();
    assert!(!repair_end(
        &mut hold,
        &versions,
        7,
        &[(0, 101), (1, 102), (2, 103), (3, 104)]
    ));
    assert!(!applied(&mut hold, &mut versions, 7, 104, &[3]));
    assert!(!applied(&mut hold, &mut versions, 7, 101, &[0]));
    assert!(!applied(&mut hold, &mut versions, 7, 103, &[2]));
    assert!(hold.is_held());
    assert!(applied(&mut hold, &mut versions, 7, 102, &[1]));
}

#[test]
fn unrelated_visual_output_bounds_the_hold_without_satisfying_a_missing_row() {
    let (mut hold, mut versions) = armed();
    assert!(!repair_end(&mut hold, &versions, 7, &[(0, 104), (1, 108)]));
    assert!(!applied(&mut hold, &mut versions, 7, 130, &[10]));
    assert!(hold.awaiting_frames());
    assert!(!applied(&mut hold, &mut versions, 7, 104, &[0]));
    assert!(applied(&mut hold, &mut versions, 7, 108, &[1]));
}

#[test]
fn a_newer_retry_of_a_lost_repair_datagram_satisfies_the_same_row_target() {
    let (mut hold, mut versions) = armed();
    repair_end(&mut hold, &versions, 7, &[(2, 104)]);
    assert!(!applied(&mut hold, &mut versions, 7, 105, &[10]));
    assert!(hold.awaiting_frames());
    assert!(applied(&mut hold, &mut versions, 7, 106, &[2]));
}

#[test]
fn row_minimums_remain_correct_across_sequence_wrap() {
    let (mut hold, mut versions) = armed();
    repair_end(
        &mut hold,
        &versions,
        7,
        &[(0, 0xffff_fffe), (1, 0xffff_ffff), (2, 1)],
    );
    assert!(!applied(&mut hold, &mut versions, 7, 1, &[0, 1]));
    assert!(applied(&mut hold, &mut versions, 7, 1, &[2]));
}

#[test]
fn the_shared_display_serial_helpers_remain_wrap_correct() {
    assert!(display_serial_is_newer(0xffff_ffff, 0xffff_fffe));
    assert!(display_serial_is_newer(1, 0xffff_ffff));
    assert!(!display_serial_is_newer(0xffff_ffff, 1));
    assert!(!display_serial_is_newer(1, 1));
    assert!(!display_serial_is_newer(0, 0xffff_ffff));
    assert!(display_serial_reached(1, 0xffff_ffff));
    assert!(display_serial_reached(1, 0xffff_fffe));
    assert!(!display_serial_reached(0xffff_ffff, 1));
    assert!(!display_serial_reached(0xffff_fffe, 1));
    assert!(display_serial_reached(1, 1));
}

#[test]
fn a_newer_generation_supersedes_the_repair_and_releases() {
    let (mut hold, mut versions) = armed();
    repair_end(&mut hold, &versions, 7, &[(0, 104)]);
    assert!(applied(&mut hold, &mut versions, 8, 1, &[0]));
    assert!(!hold.is_held());
}

#[test]
fn generation_wrap_supersedes_repair_while_reordered_old_generations_cannot() {
    let (mut wrapped, mut wrapped_versions) = armed();
    repair_end(&mut wrapped, &wrapped_versions, 0xffff_ffff, &[(0, 9)]);
    assert!(applied(&mut wrapped, &mut wrapped_versions, 1, 1, &[0]));

    let (mut stale, mut stale_versions) = armed();
    repair_end(&mut stale, &stale_versions, 1, &[(0, 9)]);
    assert!(!applied(
        &mut stale,
        &mut stale_versions,
        0xffff_ffff,
        9,
        &[0]
    ));
    assert!(stale.is_held());
}

#[test]
fn a_delayed_marker_reads_authoritative_row_versions_rather_than_a_history() {
    let (mut hold, mut versions) = armed();
    applied(&mut hold, &mut versions, 7, 10, &[0]);
    applied(&mut hold, &mut versions, 7, 11, &[1]);
    for seq in 12..612 {
        applied_at(
            &mut hold,
            &mut versions,
            7,
            seq,
            &[10],
            false,
            OBSERVED_AT_MS,
        );
    }
    assert!(repair_end(&mut hold, &versions, 7, &[(0, 10), (1, 11)]));
}

#[test]
fn a_lost_target_releases_through_the_frame_counted_visual_bound() {
    let (mut hold, mut versions) = armed();
    repair_end(&mut hold, &versions, 7, &[(0, 101), (1, 102)]);
    assert!(!applied(&mut hold, &mut versions, 7, 102, &[1]));
    assert!(hold.awaiting_frames());
    for _ in 1..HOLD_FRAMES {
        assert!(!hold.note_frame(FRAME_AFTER_ANCHOR_MS));
    }
    assert!(hold.note_frame(FRAME_AFTER_ANCHOR_MS));
    assert!(!hold.is_held());
}

#[test]
fn an_empty_repair_completes_when_its_marker_arrives() {
    let (mut hold, versions) = armed();
    assert!(repair_end(&mut hold, &versions, 7, &[]));
    assert!(!hold.is_held());
}

#[test]
fn a_lost_marker_cannot_suppress_visual_output_beyond_the_frame_budget() {
    let (mut hold, mut versions) = armed();
    applied(&mut hold, &mut versions, 7, 999, &[0]);
    assert!(hold.awaiting_frames());
    assert!(frame_budget(&mut hold));
}

#[test]
fn release_is_idempotent_and_reports_whether_it_did_anything() {
    let mut hold = RepaintHold::default();
    assert!(!hold.release());
    hold.arm(41);
    assert!(hold.release());
    assert!(!hold.release());
}

#[test]
fn an_end_marker_for_a_hold_that_is_not_held_is_ignored() {
    let mut hold = RepaintHold::default();
    assert!(!repair_end(&mut hold, &versions(), 7, &[(0, 104)]));
    assert!(!hold.is_held());
}

#[test]
fn a_delayed_marker_from_a_prior_same_generation_reconnect_is_ignored() {
    let mut hold = RepaintHold::default();
    let mut versions = versions();
    versions[0] = 200;
    hold.arm(42);
    assert!(!repair_end_as(&mut hold, &versions, 7, &[(0, 100)], 41));
    assert!(hold.is_held());
    assert!(repair_end_as(&mut hold, &versions, 7, &[(0, 200)], 42));
}

#[test]
fn re_arming_drops_the_previous_membership_and_its_anchored_frame_count() {
    let (mut hold, mut versions) = armed();
    applied(&mut hold, &mut versions, 7, 104, &[0]);
    repair_end(&mut hold, &versions, 7, &[(0, 104), (1, 105)]);
    hold.arm(41);
    assert!(!hold.awaiting_frames());
    assert!(!repair_end(&mut hold, &versions, 7, &[(1, 104)]));
    assert!(hold.is_held());
    assert_eq!(hold.deadline_ms(), None);
}

#[test]
fn resync_transfers_a_repair_hold_to_a_bounded_snapshot_wait() {
    let (mut hold, mut versions) = armed();
    repair_end(&mut hold, &versions, 7, &[(0, 104)]);
    hold.await_snapshot(1_500.0);
    assert!(!repair_end(&mut hold, &versions, 7, &[(0, 104)]));
    assert!(!applied(&mut hold, &mut versions, 7, 104, &[0]));
    assert!(hold.is_held());
    assert_eq!(hold.deadline_ms(), Some(1_500.0));
    hold.await_snapshot(2_000.0);
    assert_eq!(hold.deadline_ms(), Some(1_500.0));
    assert!(hold.release());
}

#[test]
fn a_snapshot_wait_suspends_the_frame_bound_and_keeps_only_the_hard_deadline() {
    let (mut hold, mut versions) = armed();
    repair_end(&mut hold, &versions, 7, &[(0, 104), (1, 105)]);
    assert!(!applied(&mut hold, &mut versions, 7, 104, &[0]));
    assert!(hold.awaiting_frames());
    hold.await_snapshot(250.0);
    assert_eq!(hold.deadline_ms(), Some(250.0));
    assert!(!hold.awaiting_frames());
    assert!(!frame_budget(&mut hold));
    assert!(!hold.expire(19.0));
    assert!(!applied(&mut hold, &mut versions, 7, 105, &[1]));
    assert!(hold.expire(250.0));
}

#[test]
fn first_visual_work_anchors_the_frame_count_and_later_arrivals_cannot_restart_it() {
    let (mut hold, mut versions) = armed();
    applied(&mut hold, &mut versions, 7, 99, &[9]);
    assert!(hold.awaiting_frames());
    repair_end(&mut hold, &versions, 7, &[(0, 104), (1, 105)]);
    for _ in 1..HOLD_FRAMES {
        assert!(!hold.note_frame(FRAME_AFTER_ANCHOR_MS));
    }
    // A later visual arrival re-anchors nothing: the next frame still
    // releases.
    assert!(!applied(&mut hold, &mut versions, 7, 104, &[0]));
    assert!(!applied(&mut hold, &mut versions, 7, 200, &[9]));
    assert!(hold.note_frame(FRAME_AFTER_ANCHOR_MS));
}

#[test]
fn nonvisual_traffic_before_a_delayed_marker_does_not_manufacture_visual_work() {
    let (mut hold, mut versions) = armed();
    applied_at(&mut hold, &mut versions, 7, 99, &[], false, OBSERVED_AT_MS);
    assert!(!hold.awaiting_frames());
    assert_eq!(hold.deadline_ms(), None);
    assert!(!frame_budget(&mut hold));
    assert!(!hold.expire(499.0));
}

#[test]
fn a_frame_older_than_the_visual_anchor_suppressed_nothing_and_does_not_count() {
    let (mut hold, mut versions) = armed();
    // Anchored by a visual mutation at 100; the frame whose time was 90 is the
    // one this hold interrupted.
    applied_at(&mut hold, &mut versions, 7, 999, &[0], true, 100.0);
    assert!(hold.awaiting_frames());
    assert!(!hold.note_frame(90.0));
    assert!(!hold.note_frame(101.0));
    assert!(hold.is_held());
    assert!(hold.note_frame(110.0));
}

#[test]
fn a_delayed_data_attachment_cannot_consume_the_visual_frame_budget_before_arrival() {
    for delay in [50.0, 1_000.0, 30_000.0] {
        let (mut hold, mut versions) = armed();
        assert!(!hold.expire(delay));
        assert!(!hold.note_frame(delay));
        assert_eq!(hold.deadline_ms(), None);
        applied(&mut hold, &mut versions, 7, 99, &[9]);
        for _ in 1..HOLD_FRAMES {
            assert!(!hold.note_frame(FRAME_AFTER_ANCHOR_MS));
        }
        assert!(hold.note_frame(FRAME_AFTER_ANCHOR_MS));
        assert!(!repair_end(&mut hold, &versions, 7, &[(0, 104)]));
    }
}

#[test]
fn only_snapshot_suppression_has_a_wall_clock_deadline_scaled_with_the_link() {
    assert_eq!(snapshot_deadline_ms(None), 144.0);
    assert_eq!(snapshot_deadline_ms(Some(5.0)), 34.0);
    assert_eq!(snapshot_deadline_ms(Some(0.0)), 144.0);
    assert_eq!(snapshot_deadline_ms(Some(-1.0)), 144.0);
    assert_eq!(snapshot_deadline_ms(Some(f64::NAN)), 144.0);
    assert_eq!(snapshot_deadline_ms(Some(1.0)), 32.0);
    assert_eq!(snapshot_deadline_ms(Some(400.0)), 250.0);

    // Snapshot suppression may retain earlier unsubmitted pixels.
    let mut hold = RepaintHold::default();
    hold.await_snapshot(snapshot_deadline_ms(Some(60.0)));
    assert_eq!(hold.deadline_ms(), Some(144.0));
    assert!(!hold.expire(143.0));
    assert!(hold.expire(144.0));
}

fn marker(generation: u32, repair_id: u32, members: &[(u16, u32)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&generation.to_be_bytes());
    bytes.extend_from_slice(&repair_id.to_be_bytes());
    bytes.extend_from_slice(&(members.len() as u16).to_be_bytes());
    for (row, minimum_seq) in members {
        bytes.extend_from_slice(&row.to_be_bytes());
        bytes.extend_from_slice(&minimum_seq.to_be_bytes());
    }
    bytes
}

#[test]
fn the_daemon_marker_parses_whole() {
    let members = [(0, 104), (12, 106), (255, 0xffff_ffff)];
    let parsed = RepairEnd::parse(&marker(7, 41, &members)).expect("a well-formed marker");
    assert_eq!(
        (parsed.generation, parsed.repair_id, parsed.members),
        (7, 41, members.to_vec())
    );
}

#[test]
fn malformed_membership_fails_closed() {
    assert!(RepairEnd::parse(&marker(7, 41, &[(2, 10), (2, 11)])).is_none());
    assert!(RepairEnd::parse(&marker(7, 41, &[(2, 0)])).is_none());
    assert!(RepairEnd::parse(&marker(7, 41, &[(256, 10)])).is_none());
    let valid = marker(7, 41, &[(2, 10)]);
    assert!(RepairEnd::parse(&valid[..valid.len() - 1]).is_none());
    let too_many: Vec<(u16, u32)> = (0..=128).map(|row| (row, 1)).collect();
    assert!(RepairEnd::parse(&marker(7, 41, &too_many)).is_none());
}
