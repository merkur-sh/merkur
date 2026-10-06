//! Ported from `apps/web/src/terminal/display-demand.test.ts`.

use super::*;

const PERIOD_MS: f64 = 1000.0 / 60.0;

fn frame(demand: &mut Demand, at: f64) -> FrameGrant {
    demand.on_frame(at, PERIOD_MS, true, None)
}

#[test]
fn a_generation_opens_with_the_implicit_grant() {
    let mut demand = Demand::default();
    assert_eq!(demand.grant(1), 0);
    assert_eq!(frame(&mut demand, 10.0), FrameGrant::None);
    demand.note_applied(4, 0, false, false, 20.0);
    assert_eq!(demand.grant(4), 1);
    assert_eq!(demand.grant(3), 0);
}

#[test]
fn a_waiting_daemon_is_granted_once_per_frame_until_the_window_fills() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, true, 0.0);
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::Post);
    assert_eq!(demand.grant(1), 2);
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::None);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 33.0), FrameGrant::PostDurable);
    assert_eq!(demand.grant(1), 3);
    assert!(!demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 50.0), FrameGrant::None);
    demand.note_applied(1, 2, true, true, 55.0);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 66.0), FrameGrant::PostDurable);
    assert_eq!(demand.grant(1), 4);
}

#[test]
fn a_state_that_only_spent_the_last_grant_is_owed_one_reliable_post() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, false, 0.0);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::PostDurable);
    assert_eq!(demand.grant(1), 2);
    assert!(!demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 33.0), FrameGrant::Lazy);
    assert_eq!(frame(&mut demand, 50.0), FrameGrant::None);
    demand.note_applied(1, 3, true, false, 60.0);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 66.0), FrameGrant::PostDurable);
    assert!(!demand.wants_frame(true));
    demand.note_applied(1, 4, true, true, 70.0);
    assert_eq!(frame(&mut demand, 83.0), FrameGrant::Post);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 100.0), FrameGrant::PostDurable);
    assert!(!demand.wants_frame(true));
}

#[test]
fn a_limited_exempt_frame_repeating_the_serial_is_owed_a_post() {
    let mut demand = Demand::default();
    demand.note_applied(1, 2, false, false, 0.0);
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::Lazy);
    demand.note_applied(1, 2, true, false, 20.0);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 33.0), FrameGrant::PostDurable);
    assert!(!demand.wants_frame(true));
}

#[test]
fn an_unlimited_daemon_is_topped_up_lazily() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, false, false, 0.0);
    assert!(!demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::Lazy);
    assert_eq!(demand.grant(1), 2);
    assert_eq!(frame(&mut demand, 33.0), FrameGrant::Lazy);
    assert_eq!(frame(&mut demand, 50.0), FrameGrant::None);
    assert_eq!(demand.grant(1), 3);
}

#[test]
fn a_hidden_view_grants_nothing_and_asks_for_no_frame() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, false, 0.0);
    assert!(!demand.wants_frame(false));
    assert_eq!(
        demand.on_frame(16.0, PERIOD_MS, false, None),
        FrameGrant::None
    );
    assert_eq!(demand.grant(1), 1);
    assert!(demand.wants_frame(true));
}

#[test]
fn showing_a_view_posts_at_once_without_a_second_round_trip() {
    let mut demand = Demand::default();
    assert_eq!(demand.resume_visible(), FrameGrant::None);
    demand.note_applied(1, 1, true, false, 0.0);
    assert_eq!(demand.resume_visible(), FrameGrant::PostDurable);
    assert_eq!(demand.grant(1), 2);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::PostDurable);
    assert_eq!(demand.grant(1), 3);
    assert!(!demand.wants_frame(true));
    assert_eq!(demand.resume_visible(), FrameGrant::PostDurable);
    assert_eq!(
        demand.grant(1),
        3,
        "a full window is re-posted, never over-issued"
    );
}

#[test]
fn measured_rtt_fills_the_cold_pipeline_before_a_prompt_sample() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, true, 0.0);
    demand.on_frame(16.0, PERIOD_MS, true, Some(150.0));
    assert_eq!(demand.window(), 10);
    assert_eq!(demand.loop_ms(), None);
}

#[test]
fn a_fast_sample_cannot_shrink_a_window_a_slower_flight_needed() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, true, 0.0);
    frame(&mut demand, 100.0);
    demand.note_grant_sent(100.0);
    demand.note_applied(1, 2, true, true, 200.0);
    frame(&mut demand, 210.0);
    demand.note_grant_sent(210.0);
    demand.note_applied(1, 3, true, true, 230.0);
    frame(&mut demand, 240.0);
    assert_eq!(demand.loop_ms(), Some(100.0));
    assert_eq!(demand.window(), 7);
    demand.reset_session();
    assert_eq!(demand.loop_ms(), None);
    demand.on_frame(250.0, PERIOD_MS, true, Some(150.0));
    assert_eq!(demand.window(), 10);
}

#[test]
fn a_prompt_state_measures_the_loop_and_sizes_the_window() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, true, 0.0);
    assert_eq!(frame(&mut demand, 100.0), FrameGrant::Post);
    demand.note_grant_sent(100.0);
    assert_eq!(demand.loop_ms(), None);
    demand.note_applied(1, 2, true, true, 150.0);
    assert_eq!(demand.loop_ms(), Some(50.0));
    frame(&mut demand, 166.0);
    assert_eq!(demand.window(), (50.0 / PERIOD_MS).ceil() as u32 + 1);
    demand.on_frame(175.0, 1000.0 / 120.0, true, None);
    assert_eq!(
        demand.window(),
        (50.0_f64 / (1000.0 / 120.0)).ceil() as u32 + 1
    );
}

#[test]
fn a_state_that_did_not_find_the_daemon_waiting_is_no_sample() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, false, 0.0);
    frame(&mut demand, 100.0);
    demand.note_applied(1, 2, true, false, 5_000.0);
    assert_eq!(demand.loop_ms(), None);
}

#[test]
fn a_lazy_grant_is_timed_from_the_ack_that_carried_it() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, false, false, 0.0);
    assert_eq!(frame(&mut demand, 100.0), FrameGrant::Lazy);
    demand.note_applied(1, 1, true, false, 5_000.0);
    demand.note_grant_sent(5_000.0);
    demand.note_applied(1, 2, true, true, 5_050.0);
    assert_eq!(demand.loop_ms(), Some(50.0));
}

#[test]
fn the_implicit_and_adopted_serials_are_never_samples() {
    let mut demand = Demand::default();
    demand.note_applied(1, 0, false, false, 0.0);
    demand.note_grant_sent(10.0);
    demand.note_applied(1, 1, true, true, 60.0);
    assert_eq!(demand.loop_ms(), None);
    demand.note_applied(1, 9, true, false, 70.0);
    demand.note_grant_sent(80.0);
    demand.note_applied(1, 9, true, true, 90.0);
    assert_eq!(demand.loop_ms(), None);
}

#[test]
fn a_refused_post_owes_its_durable_copy_again() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, true, 0.0);
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::Post);
    assert_eq!(frame(&mut demand, 33.0), FrameGrant::PostDurable);
    demand.note_post_failed();
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 50.0), FrameGrant::PostDurable);
    assert!(!demand.wants_frame(true));
}

#[test]
fn a_snapshot_reusing_the_generation_still_restarts_the_serials() {
    let mut demand = Demand::default();
    demand.note_applied(4, 30, true, false, 0.0);
    frame(&mut demand, 16.0);
    assert_eq!(demand.grant(4), 31);
    demand.reset_generation(4);
    assert_eq!(demand.grant(4), 1);
    demand.clear();
    assert_eq!(demand.grant(4), 0);
    assert_eq!(frame(&mut demand, 33.0), FrameGrant::None);
}

#[test]
fn the_window_never_exceeds_the_daemon_bound() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, false, 0.0);
    frame(&mut demand, 1.0);
    demand.note_grant_sent(1.0);
    demand.note_applied(1, 2, true, true, 60_000.0);
    demand.on_frame(60_001.0, 1000.0 / 480.0, true, None);
    assert_eq!(demand.window(), DISPLAY_DEMAND_MAX_WINDOW);
}

#[test]
fn a_serial_past_our_grants_is_adopted() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, false, 0.0);
    demand.note_applied(1, 7, true, true, 10.0);
    assert_eq!(demand.grant(1), 7);
    assert_eq!(demand.loop_ms(), None);
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::Post);
    assert_eq!(demand.grant(1), 8);
}

#[test]
fn a_full_window_owes_a_waiting_daemon_one_durable_copy() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, false, false, 0.0);
    assert_eq!(frame(&mut demand, 16.0), FrameGrant::Lazy);
    assert_eq!(frame(&mut demand, 33.0), FrameGrant::Lazy);
    assert_eq!(frame(&mut demand, 50.0), FrameGrant::None);
    demand.note_applied(1, 1, true, false, 60.0);
    assert!(demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 66.0), FrameGrant::PostDurable);
    assert!(!demand.wants_frame(true));
    assert_eq!(frame(&mut demand, 83.0), FrameGrant::None);
}

#[test]
fn older_and_duplicate_serials_change_only_the_limited_flag() {
    let mut demand = Demand::default();
    demand.note_applied(1, 5, false, false, 0.0);
    demand.note_applied(1, 3, true, false, 1.0);
    assert!(!demand.wants_frame(true));
    demand.note_applied(1, 5, true, false, 2.0);
    assert!(demand.wants_frame(true));
    frame(&mut demand, 16.0);
    assert!(!demand.wants_frame(true));
}

#[test]
fn a_new_generation_restarts_the_serials_but_keeps_the_loop() {
    let mut demand = Demand::default();
    demand.note_applied(1, 1, true, false, 0.0);
    frame(&mut demand, 100.0);
    demand.note_grant_sent(100.0);
    demand.note_applied(1, 2, true, true, 140.0);
    assert_eq!(demand.loop_ms(), Some(40.0));
    demand.note_applied(2, 0, false, false, 200.0);
    assert_eq!(demand.grant(2), 1);
    assert_eq!(demand.grant(1), 0);
    assert_eq!(demand.loop_ms(), Some(40.0));
}

#[test]
fn a_replaced_session_forgets_grants_in_flight() {
    let mut demand = Demand::default();
    demand.note_applied(1, 3, true, false, 0.0);
    frame(&mut demand, 16.0);
    assert_eq!(demand.grant(1), 4);
    demand.reset_session();
    assert_eq!(demand.grant(1), 3);
    assert!(!demand.wants_frame(true));
    demand.note_applied(1, 4, true, false, 30.0);
    assert_eq!(demand.grant(1), 4);
    assert!(demand.wants_frame(true));
}
