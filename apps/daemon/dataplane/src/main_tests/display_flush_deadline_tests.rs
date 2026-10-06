#[test]
fn control_only_prediction_sample_wakes_once_without_accelerating_redraws() {
    use super::include_prediction_sample_wake as delay;
    assert_eq!(delay(None, true, true), Some(0));
    assert_eq!(delay(None, false, true), None);
    assert_eq!(delay(None, true, false), None);
    assert_eq!(delay(Some(12), true, true), Some(12));
    assert_eq!(delay(Some(0), true, true), Some(0));
}

#[test]
fn synchronized_update_safety_deadline_is_anchored_until_an_explicit_end() {
    let start = std::time::Instant::now();
    let first = start + std::time::Duration::from_millis(150);
    let later = start + std::time::Duration::from_millis(290);
    let mut timer = super::SynchronizedUpdateDeadline::default();
    timer.update(Some(first), 0);
    timer.update(Some(later), 0);
    assert_eq!(timer.deadline, Some(first));
    // Complete the old block and start a new one in the same PTY read.
    timer.update(Some(later), 1);
    assert_eq!(timer.deadline, Some(later));
    // Eligibility may clear on a subsequent partial read; that is not an
    // explicit application boundary and cannot move the timer.
    timer.update(Some(later + std::time::Duration::from_secs(1)), 0);
    assert_eq!(timer.deadline, Some(later));
    timer.update(None, 2);
    assert_eq!(timer.deadline, None);
    timer.update(Some(first), 0);
    assert_eq!(timer.deadline, Some(first));
}

use super::*;

/// A dictionary worker completes about once per 1,024 display flushes. It
/// carries no new terminal mutation, so landing between the sparse TUI
/// writer's 0.8 ms PTY reads must not turn the already-anchored 10 ms tail
/// into another immediate send.
#[tokio::test(start_paused = true)]
async fn dictionary_completion_amid_sparse_reads_keeps_one_original_deadline() {
    let started_at = tokio::time::Instant::now();
    let original_deadline = started_at + Duration::from_millis(10);
    let mut flush_sleep = Box::pin(tokio::time::sleep(Duration::from_secs(60)));
    let mut flush_armed = false;
    arm_display_flush_no_later(flush_sleep.as_mut(), &mut flush_armed, original_deadline);

    // Seven later PTY reads and one dictionary completion all compute the
    // same 10 ms bounded tail from their own event time. Earlier-only
    // arming keeps the first event's absolute deadline.
    for event in 1..=8 {
        tokio::time::advance(Duration::from_micros(800)).await;
        let proposed = tokio::time::Instant::now() + Duration::from_millis(10);
        arm_display_flush_no_later(flush_sleep.as_mut(), &mut flush_armed, proposed);
        assert_eq!(
            flush_sleep.deadline(),
            original_deadline,
            "event {event} postponed or split the original redraw tail",
        );
    }

    tokio::time::advance(original_deadline - tokio::time::Instant::now()).await;
    flush_sleep.as_mut().await;
    let send_count = 1;
    assert_eq!(send_count, 1, "the anchored tail produces one timer send");
}
