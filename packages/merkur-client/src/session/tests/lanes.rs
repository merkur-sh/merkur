//! Data attachments owned apart from the signaling attachment, as the
//! browser's `manageDataEdgeConnection` owns them: redialed on their own, and
//! paused and resumed with the relay.

use merkur_edge_protocol::SpliceControlEvent;

use super::*;

/// The data dials in `actions`.
fn data_dials(actions: &[Action]) -> Vec<(ConnId, EdgeLane)> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Dial {
                conn,
                lane,
                candidate: false,
                ..
            } => Some((*conn, *lane)),
            _ => None,
        })
        .collect()
}

fn statuses(actions: &[Action]) -> Vec<Status> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Status(status) => Some(*status),
            _ => None,
        })
        .collect()
}

/// `conn` attached and its HELLO was acknowledged; what the session did.
fn pair(harness: &mut Harness, now_ms: u64, conn: ConnId) -> Vec<Action> {
    harness
        .session
        .handle(now_ms, Event::Connected(conn), &mut harness.entropy);
    let nonce = drain(&mut harness.session)
        .iter()
        .find_map(|action| match action {
            Action::SendReliable {
                conn: sent_on,
                channel: CHANNEL_DATA_HELLO,
                payload,
            } if *sent_on == conn => Some(decode_data_handshake_frame(payload)?.1),
            _ => None,
        })
        .expect("the attachment says HELLO");
    let ack = encode_data_handshake_frame(DataHandshakeKind::Ack, &nonce);
    harness.session.handle(
        now_ms + 1,
        Event::Reliable {
            conn,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_DATA_HELLO,
            payload: &ack,
        },
        &mut harness.entropy,
    );
    drain(&mut harness.session)
}

fn relay_paused(harness: &mut Harness, now_ms: u64, paused: bool) -> Vec<Action> {
    harness.session.handle(
        now_ms,
        Event::Splice(
            harness.signaling,
            SpliceControlEvent::RelayDataPaused { paused },
        ),
        &mut harness.entropy,
    );
    drain(&mut harness.session)
}

#[test]
fn signaling_close_retires_dispatched_unconfirmed_data_and_ignores_late_connect() {
    for connected in [false, true] {
        let (mut harness, _) = ready();
        harness
            .session
            .handle(NOW + 50, closed(harness.bulk), &mut harness.entropy);
        // Removing the action models a dial already dispatched to the adapter.
        let [(bulk, EdgeLane::Bulk)] = data_dials(&drain(&mut harness.session))[..] else {
            panic!("a dispatched bulk redial");
        };
        if connected {
            harness
                .session
                .handle(NOW + 60, Event::Connected(bulk), &mut harness.entropy);
            assert!(drain(&mut harness.session).iter().any(|action| matches!(
                action,
                Action::SendReliable { conn, channel: CHANNEL_DATA_HELLO, .. } if *conn == bulk
            )));
        }
        harness
            .session
            .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
        let actions = drain(&mut harness.session);
        let retired: Vec<_> = actions
            .iter()
            .filter_map(|action| match action {
                Action::Close { conn } => Some(*conn),
                _ => None,
            })
            .collect();
        assert_eq!(retired, [bulk]);
        assert!(data_dials(&actions).is_empty());
        // The confirmed interactive lane remains useful while recovery runs.
        assert!(harness.session.is_ready());
        assert!(
            harness.session.lanes.as_ref().unwrap().data[0]
                .counterpart
                .is_some()
        );
        harness
            .session
            .handle(NOW + 110, Event::Connected(bulk), &mut harness.entropy);
        assert!(drain(&mut harness.session).is_empty());
        let lane = &harness.session.lanes.as_ref().unwrap().data[1];
        assert!(!lane.up);
        assert_eq!(lane.attempts, 0);
        assert!(lane.counterpart.is_none());
        assert!(lane.next_hello_ms.is_none());
        assert!(lane.redial_at_ms.is_none());
        assert!(lane.deadline_ms.is_none());
        // A second native close cannot repeat the retirement obligation.
        harness
            .session
            .handle(NOW + 120, closed(harness.signaling), &mut harness.entropy);
        assert!(drain(&mut harness.session).is_empty());
    }
}

#[test]
fn signaling_close_removes_queued_data_dials_before_priority_retirement() {
    let (mut harness, _) = ready();
    harness
        .session
        .handle(NOW + 50, closed(harness.bulk), &mut harness.entropy);
    // Do not poll the redial: the adapter has not started it yet.
    let bulk = harness.session.lanes.as_ref().unwrap().bulk;
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    // Browser/native owners retire carriers ahead of their I/O action drain.
    assert_eq!(
        harness.session.poll_close_action(NOW + 100),
        Some(Action::Close { conn: bulk })
    );
    let actions = drain(&mut harness.session);
    assert!(data_dials(&actions).is_empty(), "{actions:?}");
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                Action::Dial {
                    candidate: true,
                    ..
                }
            ))
            .count(),
        1
    );
    assert!(harness.session.is_ready());
    harness
        .session
        .handle(NOW + 110, closed(harness.signaling), &mut harness.entropy);
    assert!(drain(&mut harness.session).is_empty());
}

#[test]
fn closed_signaling_leaves_data_redials_to_the_authenticated_successor() {
    let (mut harness, _) = ready();
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                Action::Dial {
                    candidate: true,
                    ..
                }
            ))
            .count(),
        1
    );
    assert!(data_dials(&actions).is_empty());
    // The incumbent data remains usable until it actually ends.
    assert!(harness.session.is_ready());
    for conn in [harness.interactive, harness.bulk] {
        harness
            .session
            .handle(NOW + 101, closed(conn), &mut harness.entropy);
        assert!(data_dials(&drain(&mut harness.session)).is_empty());
    }
    assert!(!harness.session.is_ready());
    // Backoff and repeated native close callbacks cannot resurrect old lanes.
    harness
        .session
        .handle_timeout(NOW + 100 + DATA_REDIAL_DELAY_MS, &mut harness.entropy);
    assert!(data_dials(&drain(&mut harness.session)).is_empty());
}

#[test]
fn closed_signaling_cancels_a_data_redial_wait_and_hello_retries() {
    let (mut harness, _) = ready();
    harness
        .session
        .handle(NOW + 50, closed(harness.bulk), &mut harness.entropy);
    let [(bulk, _)] = data_dials(&drain(&mut harness.session))[..] else {
        panic!("a bulk redial");
    };
    harness
        .session
        .handle(NOW + 60, Event::DialFailed(bulk), &mut harness.entropy);
    drain(&mut harness.session);
    assert!(
        harness.session.lanes.as_ref().unwrap().data[1]
            .redial_at_ms
            .is_some()
    );
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    drain(&mut harness.session);
    harness
        .session
        .handle_timeout(NOW + 60 + DATA_REDIAL_DELAY_MS, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(data_dials(&actions).is_empty());
    assert!(!actions.iter().any(|action| matches!(
        action,
        Action::SendReliable {
            channel: CHANNEL_DATA_HELLO,
            ..
        }
    )));
}

#[test]
fn a_late_data_ack_cannot_restore_closed_signaling_or_restart_its_heartbeat() {
    let (mut harness, _) = ready();
    harness
        .session
        .handle(NOW + 50, closed(harness.interactive), &mut harness.entropy);
    let [(interactive, _)] = data_dials(&drain(&mut harness.session))[..] else {
        panic!("an interactive redial");
    };
    harness.session.handle(
        NOW + 60,
        Event::Connected(interactive),
        &mut harness.entropy,
    );
    let nonce = drain(&mut harness.session)
        .iter()
        .find_map(|action| match action {
            Action::SendReliable {
                channel: CHANNEL_DATA_HELLO,
                payload,
                ..
            } => decode_data_handshake_frame(payload).map(|(_, nonce)| nonce),
            _ => None,
        })
        .expect("the data dial sent its HELLO");
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    drain(&mut harness.session);
    let ack = encode_data_handshake_frame(DataHandshakeKind::Ack, &nonce);
    harness.session.handle(
        NOW + 110,
        Event::Reliable {
            conn: interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_DATA_HELLO,
            payload: &ack,
        },
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    assert!(harness.session.incumbent_lost);
    assert!(!harness.session.is_ready());
}

#[test]
fn surviving_data_ack_releases_input_without_canceling_closed_signaling_recovery() {
    let (mut harness, mut daemon) = ready();
    harness
        .session
        .send_input(NOW + 50, 1, build::press('q'), false);
    drain(&mut harness.session);
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let candidate = actions
        .iter()
        .find_map(|action| match action {
            Action::Dial {
                conn,
                candidate: true,
                ..
            } => Some(*conn),
            _ => None,
        })
        .expect("signaling recovery starts its candidate");
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let sealed = daemon
        .seal_stream(
            lane,
            &encode_proto_frame(MSG_TYPE_INPUT_ACK, &1u32.to_be_bytes()),
        )
        .unwrap();
    harness.session.handle(
        NOW + 110,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert_eq!(harness.session.input_released_local(), 1);
    assert!(!drain(&mut harness.session).contains(&Action::Close { conn: candidate }));
    assert_eq!(harness.session.candidate.as_ref().unwrap().conn, candidate);
    assert!(harness.session.incumbent_lost);
}

#[test]
fn a_late_relay_resume_cannot_redial_data_on_closed_signaling() {
    let (mut harness, _) = ready();
    relay_paused(&mut harness, NOW + 50, true);
    harness
        .session
        .handle(NOW + 100, closed(harness.signaling), &mut harness.entropy);
    drain(&mut harness.session);
    assert!(relay_paused(&mut harness, NOW + 110, false).is_empty());
    assert!(harness.session.lanes.as_ref().unwrap().relay_paused);
}

#[test]
fn a_suspected_incumbent_still_repairs_its_data_lanes() {
    let (mut harness, _) = ready();
    harness
        .session
        .connectivity_hint(NOW + 100, &mut harness.entropy);
    drain(&mut harness.session);
    harness
        .session
        .handle(NOW + 101, closed(harness.bulk), &mut harness.entropy);
    assert!(matches!(
        data_dials(&drain(&mut harness.session))[..],
        [(_, EdgeLane::Bulk)]
    ));
}

#[test]
fn a_data_attachment_that_dies_is_redialed_alone_and_input_goes_out_again() {
    let (mut harness, mut daemon) = ready();
    harness
        .session
        .send_input(NOW + 50, 1, build::press('q'), false);
    drain(&mut harness.session);

    harness
        .session
        .handle(NOW + 100, closed(harness.interactive), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    let [(interactive, EdgeLane::Interactive)] = data_dials(&actions)[..] else {
        panic!("the interactive lane alone is redialed: {actions:?}");
    };
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::Close { .. } | Action::Status(_))),
        "signaling holds the session: {actions:?}"
    );
    assert!(!harness.session.is_ready());

    let actions = pair(&mut harness, NOW + 110, interactive);
    assert_eq!(statuses(&actions), [Status::Ready]);
    assert!(harness.session.is_ready());
    // What the dead stream carried is sent again on the fresh one.
    assert!(
        received_input(&mut daemon, &actions).contains(&(false, 1, vec![build::press('q')])),
        "{actions:?}"
    );
}

#[test]
fn failed_redials_wait_then_recover_the_connection_owner() {
    // Authenticating: no liveness ladder runs yet to recover on its own.
    let mut harness = authenticating();
    // The lane's first dial failing earns an immediate redial.
    harness.session.handle(
        NOW + 10,
        Event::DialFailed(harness.bulk),
        &mut harness.entropy,
    );
    let [(mut bulk, EdgeLane::Bulk)] = data_dials(&drain(&mut harness.session))[..] else {
        panic!("a bulk redial");
    };
    let mut now = NOW + 20;
    for _ in 1..DATA_REDIAL_ATTEMPTS {
        harness
            .session
            .handle(now, Event::DialFailed(bulk), &mut harness.entropy);
        assert!(data_dials(&drain(&mut harness.session)).is_empty());
        now += DATA_REDIAL_DELAY_MS;
        harness.session.handle_timeout(now, &mut harness.entropy);
        let [(redial, EdgeLane::Bulk)] = data_dials(&drain(&mut harness.session))[..] else {
            panic!("the bulk lane is redialed after the delay");
        };
        bulk = redial;
    }
    harness
        .session
        .handle(now + 10, Event::DialFailed(bulk), &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(data_dials(&actions).is_empty());
    assert_eq!(
        statuses(&actions),
        [Status::Reconnecting],
        "spent lane redials end the attempt, while its connection owner survives"
    );
    assert!(!harness.session.is_closed());
    for conn in [harness.signaling, harness.interactive, bulk] {
        assert!(actions.contains(&Action::Close { conn }), "{actions:?}");
    }
    let at = harness
        .session
        .next_deadline()
        .expect("one fresh issuance deadline");
    harness.session.handle_timeout(at, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(
        actions
            .iter()
            .any(|action| matches!(action, Action::RequestIssuance(_)))
    );
    assert!(
        data_dials(&actions).is_empty(),
        "issuance precedes replacement dials"
    );
}

#[test]
fn a_paused_relay_closes_the_data_attachments_until_it_resumes() {
    let (mut harness, _) = ready();
    let actions = relay_paused(&mut harness, NOW + 100, true);
    for conn in [harness.interactive, harness.bulk] {
        assert!(actions.contains(&Action::Close { conn }), "{actions:?}");
    }
    assert!(!actions.contains(&Action::Close {
        conn: harness.signaling
    }));
    assert_eq!(statuses(&actions), [Status::RelayPaused]);
    assert!(!harness.session.is_ready());
    assert!(relay_paused(&mut harness, NOW + 150, true).is_empty());

    let actions = relay_paused(&mut harness, NOW + 200, false);
    let dials = data_dials(&actions);
    assert_eq!(
        dials.iter().map(|(_, lane)| *lane).collect::<Vec<_>>(),
        [EdgeLane::Interactive, EdgeLane::Bulk]
    );
    assert_eq!(
        statuses(&pair(&mut harness, NOW + 210, dials[0].0)),
        [Status::Ready]
    );
}

#[test]
fn an_egress_budget_close_pauses_the_relay() {
    let (mut harness, _) = ready();
    harness.session.handle(
        NOW + 100,
        Event::Closed {
            conn: harness.bulk,
            egress_budget: true,
        },
        &mut harness.entropy,
    );
    let actions = drain(&mut harness.session);
    assert!(data_dials(&actions).is_empty());
    assert!(actions.contains(&Action::Close {
        conn: harness.interactive
    }));
    assert_eq!(statuses(&actions), [Status::RelayPaused]);
}

#[test]
fn an_attachment_nothing_acknowledges_is_dead_at_its_deadline() {
    let (mut harness, _) = ready();
    harness
        .session
        .handle(NOW + 100, closed(harness.bulk), &mut harness.entropy);
    let [(bulk, _)] = data_dials(&drain(&mut harness.session))[..] else {
        panic!("a bulk redial");
    };
    harness
        .session
        .handle(NOW + 110, Event::Connected(bulk), &mut harness.entropy);
    drain(&mut harness.session);
    let deadline = NOW + 110 + DATA_ATTACHMENT_TIMEOUT_MS;
    harness
        .session
        .handle_timeout(deadline - 1, &mut harness.entropy);
    assert!(!drain(&mut harness.session).contains(&Action::Close { conn: bulk }));
    harness
        .session
        .handle_timeout(deadline, &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(
        actions.contains(&Action::Close { conn: bulk }),
        "{actions:?}"
    );
    assert!(matches!(data_dials(&actions)[..], [(_, EdgeLane::Bulk)]));
}
