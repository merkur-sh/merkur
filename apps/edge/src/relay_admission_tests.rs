//! A connection without a verified ticket holds only a pending place, never a
//! session task, and a full pending pool still lets a ticketed peer in.
use super::retirement_tests::endpoints;
use super::tests::{attach_test_peer, read_test_lifecycle};
use super::*;
use crate::admission::PendingPool;
use crate::splice::MAX_SPLICE_SESSION_TASKS;

#[tokio::test]
async fn a_full_pending_pool_retries_a_dial_that_then_displaces_an_unticketed_one() {
    let (server, client, url) = endpoints();
    let registry = SpliceRegistry::new();
    let accept = tokio::spawn(accept_loop_with(
        Arc::new(server),
        registry.clone(),
        crate::attach_ticket::test_key(),
        crate::egress_budget::test_open_budget(),
        PendingPool::with_capacity(1),
    ));

    // Completes its handshake and never sends a preface: the pool's only place.
    let stalled = client
        .connect(&url)
        .await
        .expect("unticketed peer connects");
    assert_eq!(
        registry.available_session_tasks(),
        MAX_SPLICE_SESSION_TASKS,
        "a peer without a verified ticket took a session task"
    );

    // Its first packet finds the pool full and unproven, so it is asked to
    // retry; proven, it takes the unticketed peer's place at once, well before
    // that peer's admission deadline could have freed it.
    let (_browser, _browser_control, mut browser_lifecycle, _) = tokio::time::timeout(
        ADMISSION_TIMEOUT / 4,
        attach_test_peer(&client, &url, "admitted", Role::Browser),
    )
    .await
    .expect("the ticketed peer waited for the pending place to expire");
    assert!(matches!(
        read_test_lifecycle(&mut browser_lifecycle).await,
        SpliceControlEvent::CounterpartPresent { present: false, .. }
    ));
    tokio::time::timeout(Duration::from_secs(5), stalled.closed())
        .await
        .expect("the displaced unticketed peer was not closed");

    let (_daemon, _daemon_control, _daemon_lifecycle, _quote) =
        attach_test_peer(&client, &url, "admitted", Role::Daemon).await;
    let event = read_test_lifecycle(&mut browser_lifecycle).await;
    assert!(
        matches!(event, SpliceControlEvent::CounterpartAttached { .. }),
        "{event:?}"
    );
    accept.abort();
}
