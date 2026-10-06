//! A session driven end to end against the in-process daemon: issuance, the
//! three dials, the three flights, the data attachment, then input the daemon
//! can open and parse, exactly as the dataplane would receive it.

use merkur_authorization::decode_len;
use merkur_e2e::{NoiseHandshake, NoiseTransport};
use merkur_edge_protocol::{Role, RoutingAttachment, RoutingPreface};
use merkur_wire::input_record::build;
use merkur_wire::protocol::{
    MSG_TYPE_GEOMETRY_CLAIM, MSG_TYPE_INPUT_RUN, MSG_TYPE_RESIZE, parse_input_run,
};
use merkur_wire::signaling::{ClientSignal, DaemonSignal, NoiseFinal};

use super::*;
use crate::test_support::{
    BROWSER_NODE_ID, Counter, DaemonLineage, NOW, account, answer, answer_signatures, delegate,
    issuance,
};

const DAEMON_ATTACHMENT: u64 = 42;

mod direct;
mod lanes;
mod recovery;

struct Harness {
    session: Session,
    entropy: Counter,
    signaling: ConnId,
    interactive: ConnId,
    bulk: ConnId,
    /// The daemon's answer to flight 1, before it is delivered, and the
    /// daemon's half of the handshake that flight 3 completes.
    ready: DaemonSignal,
    responder: Option<NoiseHandshake>,
    /// The daemon's rebind lineage for this session.
    lineage: DaemonLineage,
    delegate_public_key: Vec<u8>,
}

fn drain(session: &mut Session) -> Vec<Action> {
    std::iter::from_fn(|| session.poll_action()).collect()
}

/// A session at Ready (the first ping's deadline is `NOW + 1_030`) and the
/// daemon's transport for it.
fn ready() -> (Harness, NoiseTransport) {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (daemon, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    ack_hello(&mut harness, &nonce);
    (harness, daemon)
}

/// The attachment `conn` ended for any reason but the relay egress budget.
fn closed(conn: ConnId) -> Event<'static> {
    Event::Closed {
        conn,
        egress_budget: false,
    }
}

fn signal(action: &Action) -> ClientSignal {
    let Action::SendReliable {
        channel: CHANNEL_SIGNALING,
        payload,
        ..
    } = action
    else {
        panic!("expected a signaling record, got {action:?}");
    };
    ClientSignal::parse(payload).expect("a valid client signal")
}

fn preface(bytes: &[u8]) -> RoutingPreface {
    let (len, json) = bytes.split_at(4);
    assert_eq!(
        u32::from_be_bytes(len.try_into().unwrap()) as usize,
        json.len()
    );
    serde_json::from_slice(json).unwrap()
}

/// Issuance, the three dials, and flight 1 on the signaling attachment.
fn authenticating() -> Harness {
    let (delegation, daemon, binding) = account();
    let delegate_public_key = delegate().public_key().to_vec();
    let mut entropy = Counter(0);
    let mut session = Session::new(
        Config {
            browser_node_id: BROWSER_NODE_ID.into(),
            relay_only: false,
        },
        delegation,
    );

    session.connect(daemon.id, &mut entropy);
    let actions = drain(&mut session);
    assert_eq!(actions[0], Action::Status(Status::Connecting));
    let Action::RequestIssuance(request) = &actions[1] else {
        panic!("{actions:?}")
    };
    assert_eq!(request.daemon_id, daemon.id);
    assert_eq!(request.delegation_id, "delegation-1");
    assert_eq!(request.browser_node_id, BROWSER_NODE_ID);
    assert_eq!(request.issuance_id.len(), 36);
    assert_eq!(&request.issuance_id[14..15], "4", "a version-4 id");

    session.handle(
        NOW,
        Event::Issued(Some(issuance(&daemon, binding))),
        &mut entropy,
    );
    let dials = drain(&mut session);
    let conns: Vec<ConnId> = dials
        .iter()
        .zip(EdgeLane::ALL)
        .map(|(action, expected)| {
            let Action::Dial {
                conn,
                lane,
                url,
                cert_hashes,
                preface: bytes,
                candidate: false,
            } = action
            else {
                panic!("expected a dial, got {action:?}");
            };
            assert_eq!(*lane, expected);
            assert_eq!(url, "https://edge.merkur.example:4433");
            assert_eq!(cert_hashes.len(), 1);
            let preface = preface(bytes);
            assert_eq!(preface.session_id, expected.routing_id("session-1"));
            assert_eq!(preface.role, Role::Browser);
            assert_eq!(preface.version, PREFACE_VERSION);
            assert_eq!(preface.attachment, RoutingAttachment::Primary);
            assert_eq!(preface.daemon_id, daemon.id);
            *conn
        })
        .collect();
    assert_eq!(
        conns.len(),
        3,
        "all three dials start in one turn: {dials:?}"
    );
    let (signaling, interactive, bulk) = (conns[0], conns[1], conns[2]);
    // The delegate signs while the lanes dial; flight 1 waits for signaling.
    answer_signatures(&mut session, NOW + 1, &mut entropy);
    assert_eq!(drain(&mut session), [], "flight 1 waits for its lane");

    session.handle(NOW + 5, Event::Connected(signaling), &mut entropy);
    let actions = drain(&mut session);
    assert_eq!(actions.len(), 2, "{actions:?}");
    let flight = signal(&actions[0]);
    assert_eq!(actions[1], Action::Status(Status::Authenticating));
    let (ready, responder, lineage) = answer(&daemon, &flight, &delegate_public_key);
    Harness {
        session,
        entropy,
        signaling,
        interactive,
        bulk,
        ready,
        responder: Some(responder),
        lineage,
        delegate_public_key,
    }
}

#[test]
fn a_signature_the_delegate_did_not_make_fails_closed_before_flight_one() {
    let (delegation, daemon, binding) = account();
    let mut entropy = Counter(0);
    let mut session = Session::new(
        Config {
            browser_node_id: BROWSER_NODE_ID.into(),
            relay_only: false,
        },
        delegation,
    );
    session.connect(daemon.id, &mut entropy);
    drain(&mut session);
    session.handle(
        NOW,
        Event::Issued(Some(issuance(&daemon, binding))),
        &mut entropy,
    );
    let Action::Dial {
        conn: signaling, ..
    } = drain(&mut session)[0]
    else {
        panic!("signaling dials first");
    };
    session.handle(NOW + 5, Event::Connected(signaling), &mut entropy);
    assert_eq!(drain(&mut session), [], "nothing to send before the signature");
    let request = session.take_signature_request().expect("one proof to sign");
    assert!(session.take_signature_request().is_none());
    // Another key's signature over the right proof, as a faulty signer returns.
    let forged = merkur_authorization::sign_session_delegation_proof(
        &request.proof,
        &crate::test_support::key(0x23),
        [0x77; 32],
    )
    .unwrap();
    session.signed(NOW + 6, request.id, Some(&forged), &mut entropy);
    assert!(session.is_closed());
    let actions = drain(&mut session);
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::SendReliable { .. })),
        "flight 1 never leaves: {actions:?}"
    );
}

#[test]
fn a_signer_that_never_answers_ends_the_attempt_and_its_late_answer_is_dropped() {
    let (delegation, daemon, binding) = account();
    let mut entropy = Counter(0);
    let mut session = Session::new(
        Config {
            browser_node_id: BROWSER_NODE_ID.into(),
            relay_only: false,
        },
        delegation,
    );
    session.connect(daemon.id, &mut entropy);
    drain(&mut session);
    session.handle(
        NOW,
        Event::Issued(Some(issuance(&daemon, binding))),
        &mut entropy,
    );
    drain(&mut session);
    let request = session.take_signature_request().expect("one proof to sign");
    assert_eq!(session.next_deadline(), Some(NOW + AUTH_PHASE_WATCHDOG_MS));
    session.handle_timeout(NOW + AUTH_PHASE_WATCHDOG_MS, &mut entropy);
    let actions = drain(&mut session);
    assert!(
        actions.contains(&Action::Status(Status::Reconnecting)),
        "a wedged signer is an attempt failure, not a hang: {actions:?}"
    );
    assert!(!session.is_closed());
    let signature = merkur_authorization::sign_session_delegation_proof(
        &request.proof,
        &delegate(),
        [0x77; 32],
    )
    .unwrap();
    session.signed(
        NOW + AUTH_PHASE_WATCHDOG_MS + 1,
        request.id,
        Some(&signature),
        &mut entropy,
    );
    assert!(
        !drain(&mut session)
            .iter()
            .any(|action| matches!(action, Action::SendReliable { .. })),
        "the abandoned attempt's flight never leaves"
    );
}

/// The daemon's transport once flight 3 has arrived, and the data-lane nonce
/// the client claimed for the interactive attachment.
fn deliver_ready(harness: &mut Harness, now_ms: u64) -> (NoiseTransport, [u8; 16], Vec<Action>) {
    let ready = harness.ready.to_json();
    harness.session.handle(
        now_ms,
        Event::Reliable {
            conn: harness.signaling,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_SIGNALING,
            payload: ready.as_bytes(),
        },
        &mut harness.entropy,
    );
    let mut actions = drain(&mut harness.session);
    let ClientSignal::NoiseFinal(NoiseFinal { data }) = signal(&actions[0]) else {
        panic!("flight 3 leaves first: {actions:?}");
    };
    let fence = actions
        .iter()
        .position(|action| matches!(action, Action::DisplayFence(DisplayFence { lineage }) if *lineage != 0))
        .expect("a new session fences the viewer's display lineage");
    actions.remove(fence);
    let mut responder = harness.responder.take().expect("flight 3 arrives once");
    responder
        .read_message(&decode_len(&data, data.len() * 3 / 4, "msg3").unwrap())
        .unwrap();
    let transport = responder.into_transport().unwrap();
    let nonce = actions
        .iter()
        .find_map(|action| match action {
            Action::SendReliable {
                conn,
                channel: CHANNEL_DATA_HELLO,
                payload,
            } if *conn == harness.interactive => {
                let (kind, nonce) = decode_data_handshake_frame(payload)?;
                (kind == DataHandshakeKind::Hello).then_some(nonce)
            }
            _ => None,
        })
        .unwrap_or([0; 16]);
    (transport, nonce, actions)
}

fn ack_hello(harness: &mut Harness, nonce: &[u8; 16]) -> Vec<Action> {
    let ack = encode_data_handshake_frame(DataHandshakeKind::Ack, nonce);
    harness.session.handle(
        NOW + 30,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_DATA_HELLO,
            payload: &ack,
        },
        &mut harness.entropy,
    );
    drain(&mut harness.session)
}

/// Every record of the input runs in `actions`, as the daemon opens them.
fn received_input(
    transport: &mut NoiseTransport,
    actions: &[Action],
) -> Vec<(bool, u32, Vec<Vec<u8>>)> {
    received_runs(transport, actions)
        .into_iter()
        .map(|(datagram, base, entries)| {
            (
                datagram,
                base,
                entries.into_iter().map(|(record, _)| record).collect(),
            )
        })
        .collect()
}

/// One input run as the daemon opens it: whether it rode a datagram, its
/// base sequence, and each record with its modelled bit.
type Run = (bool, u32, Vec<(Vec<u8>, bool)>);

/// The input runs in `actions` with each record's modelled bit.
fn received_runs(transport: &mut NoiseTransport, actions: &[Action]) -> Vec<Run> {
    let lane = merkur_e2e::lane_for_channel(CHANNEL_PTY).unwrap();
    actions
        .iter()
        .filter_map(|action| {
            let (datagram, plaintext) = match action {
                Action::SendDatagram { payload, .. }
                | Action::SendInputDatagram { payload, .. } => {
                    assert_eq!(payload[0], CHANNEL_PTY);
                    (true, transport.open_datagram(lane, &payload[1..]).unwrap())
                }
                Action::SendReliable {
                    channel: CHANNEL_PTY,
                    payload,
                    ..
                } => (false, transport.open_stream(lane, payload).unwrap()),
                _ => return None,
            };
            let (kind, body) = decode_proto_frame(&plaintext).unwrap();
            assert_eq!(kind, MSG_TYPE_INPUT_RUN);
            let (header, entries) = parse_input_run(body).expect("a canonical input run");
            Some((
                datagram,
                header.base_seq,
                entries
                    .map(|entry| (entry.payload.to_vec(), entry.shadow_modelled))
                    .collect(),
            ))
        })
        .collect()
}

#[test]
fn a_session_reaches_ready_and_delivers_input_the_daemon_opens() {
    let mut harness = authenticating();
    // The interactive dial lands during authentication; its HELLO waits for flight 3.
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    // Typed before the session is ready: held, then sent at Ready.
    harness
        .session
        .send_input(NOW + 7, 1, build::press('a'), false);
    assert!(drain(&mut harness.session).is_empty());

    let (mut daemon, nonce, actions) = deliver_ready(&mut harness, NOW + 20);
    assert!(matches!(
        signal(&actions[1]),
        ClientSignal::DataAttach(DataClaim { lane: DataLane::Interactive, nonce: ref claimed }) if *claimed == hex(&nonce)
    ));
    assert_ne!(nonce, [0; 16]);
    assert_eq!(
        actions.len(),
        3,
        "noise_final, data_attach and the HELLO leave together: {actions:?}"
    );
    assert!(!harness.session.is_ready());

    let actions = ack_hello(&mut harness, &nonce);
    assert!(matches!(
        signal(&actions[0]),
        ClientSignal::DataReceived(DataClaim { lane: DataLane::Interactive, nonce: ref proved }) if *proved == hex(&nonce)
    ));
    assert_eq!(actions[1], Action::Path(PathKind::Relay));
    assert_eq!(actions[2], Action::Status(Status::Ready));
    assert!(harness.session.is_ready());
    // The held keystroke leaves once on each lane, numbered from the daemon's
    // next expected sequence.
    assert_eq!(
        received_input(&mut daemon, &actions[3..]),
        vec![
            (true, 1, vec![build::press('a')]),
            (false, 1, vec![build::press('a')])
        ]
    );

    // The next record: the datagram carries the whole unacknowledged run, the
    // reliable stream only what it has not carried yet.
    harness
        .session
        .send_input(NOW + 35, 2, build::press('b'), false);
    let actions = drain(&mut harness.session);
    assert_eq!(
        received_input(&mut daemon, &actions),
        vec![
            (true, 1, vec![build::press('a'), build::press('b')]),
            (false, 2, vec![build::press('b')]),
        ]
    );

    // The daemon acknowledges `a`; the next run starts after it.
    let ack = encode_proto_frame(MSG_TYPE_INPUT_ACK, &1u32.to_be_bytes());
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let sealed = daemon.seal_stream(lane, &ack).unwrap();
    harness.session.handle(
        NOW + 40,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert!(
        drain(&mut harness.session).is_empty(),
        "an input ACK is the session's own"
    );
    harness
        .session
        .send_input(NOW + 45, 3, build::press('c'), false);
    let actions = drain(&mut harness.session);
    assert_eq!(
        received_input(&mut daemon, &actions),
        vec![
            (true, 2, vec![build::press('b'), build::press('c')]),
            (false, 3, vec![build::press('c')]),
        ]
    );
}

#[test]
fn input_goes_out_under_the_daemons_numbering_and_frames_name_it_in_the_hosts() {
    let (mut harness, mut daemon) = ready();
    // The host counts from wherever it is; the daemon's count starts at 1.
    harness
        .session
        .send_input(NOW + 31, 500, build::press('a'), true);
    harness
        .session
        .send_input(NOW + 32, 501, build::press('b'), false);
    let runs = received_runs(&mut daemon, &drain(&mut harness.session));
    let last = runs.last().expect("the second record's run");
    assert_eq!(last.1, 2);
    let datagram = runs.iter().rev().find(|run| run.0).expect("a datagram run");
    assert_eq!(
        (datagram.1, datagram.2.clone()),
        (
            1,
            vec![(build::press('a'), true), (build::press('b'), false)]
        )
    );

    let lane = merkur_e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
    let mut frame = vec![CHANNEL_DISPLAY_DATAGRAM];
    frame.extend_from_slice(&daemon.seal_datagram(lane, b"display").unwrap());
    harness.session.handle(
        NOW + 40,
        Event::Datagram {
            conn: harness.interactive,
            payload: &frame,
        },
        &mut harness.entropy,
    );
    let [Action::Terminal { input, .. }] = &drain(&mut harness.session)[..] else {
        panic!("one terminal frame");
    };
    assert_eq!(
        (
            input.local_for_wire(1),
            input.local_for_wire(2),
            input.local_for_wire(3)
        ),
        (Some(500), Some(501), None)
    );
}

#[test]
fn terminal_frames_reach_the_viewer_opened() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (mut daemon, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    ack_hello(&mut harness, &nonce);

    let lane = merkur_e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
    let mut datagram = vec![CHANNEL_DISPLAY_DATAGRAM];
    datagram.extend_from_slice(&daemon.seal_datagram(lane, b"display").unwrap());
    harness.session.handle(
        NOW + 50,
        Event::Datagram {
            conn: harness.interactive,
            payload: &datagram,
        },
        &mut harness.entropy,
    );
    assert_eq!(
        drain(&mut harness.session),
        vec![Action::Terminal {
            channel: CHANNEL_DISPLAY_DATAGRAM,
            datagram: true,
            payload: b"display".to_vec(),
            // Genesis rotated the numbering, and no input maps under it yet.
            input: InputMapping {
                epoch: 2,
                ..InputMapping::default()
            },
        }]
    );

    // A frame that does not open under the session's keys is dropped.
    let last = datagram.len() - 1;
    datagram[last] ^= 1;
    harness.session.handle(
        NOW + 51,
        Event::Datagram {
            conn: harness.interactive,
            payload: &datagram,
        },
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
}

#[test]
fn a_frame_buffer_serves_the_frames_after_it() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (mut daemon, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    ack_hello(&mut harness, &nonce);
    harness.session.buffers.0.clear();

    let sealed = |daemon: &mut NoiseTransport, channel: u8, plaintext: &[u8]| {
        let lane = merkur_e2e::lane_for_channel(channel).unwrap();
        let mut frame = vec![channel];
        frame.extend_from_slice(&daemon.seal_datagram(lane, plaintext).unwrap());
        frame
    };
    let receive = |harness: &mut Harness, frame: &[u8]| {
        harness.session.handle(
            NOW + 50,
            Event::Datagram {
                conn: harness.interactive,
                payload: frame,
            },
            &mut harness.entropy,
        );
        drain(&mut harness.session)
    };

    // The viewer's frame leaves with its buffer, and the host hands it back.
    let frame = sealed(&mut daemon, CHANNEL_DISPLAY_DATAGRAM, &[7; 200]);
    let Some(Action::Terminal { payload, .. }) = receive(&mut harness, &frame).pop() else {
        panic!("one terminal frame");
    };
    assert!(harness.session.buffers.0.is_empty());
    let storage = payload.as_ptr();
    harness.session.recycle(payload);

    // The next frame opens into it.
    let frame = sealed(&mut daemon, CHANNEL_DISPLAY_DATAGRAM, &[8; 120]);
    let Some(Action::Terminal { payload, .. }) = receive(&mut harness, &frame).pop() else {
        panic!("one terminal frame");
    };
    assert_eq!(payload, [8; 120]);
    assert_eq!(payload.as_ptr(), storage);
    harness.session.recycle(payload);

    // A frame the session consumes itself keeps it, and so does one that
    // does not open.
    let ack = sealed(
        &mut daemon,
        CHANNEL_PTY,
        &encode_proto_frame(MSG_TYPE_INPUT_ACK, &0u32.to_be_bytes()),
    );
    assert!(receive(&mut harness, &ack).is_empty());
    let mut forged = sealed(&mut daemon, CHANNEL_DISPLAY_DATAGRAM, &[9; 64]);
    *forged.last_mut().unwrap() ^= 1;
    assert!(receive(&mut harness, &forged).is_empty());
    assert_eq!(harness.session.buffers.0.len(), 1);
    assert_eq!(harness.session.buffers.0[0].as_ptr(), storage);

    // A frame the session seals to send takes it too.
    harness
        .session
        .send_input(NOW + 60, 500, build::press('a'), true);
    assert!(drain(&mut harness.session).iter().any(|action| matches!(
        action,
        Action::SendInputDatagram { payload, .. } if payload.as_ptr() == storage
    )));
}

#[test]
fn display_acks_ride_the_ack_datagram_and_the_reliable_backstop_at_its_cadence() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (mut daemon, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    // What the viewer asks at the fence waits for the carrier, in order and
    // once each.
    harness.session.request_display_snapshot(NOW + 50);
    harness.session.send_display_dictionary_ready(true);
    harness.session.send_display_dictionary_ack(9);
    harness.session.request_display_snapshot(NOW + 50);
    assert!(drain(&mut harness.session).is_empty());
    let actions = ack_hello(&mut harness, &nonce);
    let ctrl = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let control: Vec<Vec<u8>> = actions
        .iter()
        .filter_map(|action| match action {
            Action::SendReliable {
                channel: CHANNEL_CTRL,
                payload,
                ..
            } => Some(daemon.open_stream(ctrl, payload).unwrap()),
            _ => None,
        })
        .collect();
    let owed: Vec<_> = control[control.len() - 3..]
        .iter()
        .map(|frame| decode_proto_frame(frame).expect("a control frame"))
        .collect();
    assert_eq!(
        owed,
        [
            (MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST, &[][..]),
            (MSG_TYPE_DISPLAY_DICT_READY, &[1][..]),
            (MSG_TYPE_DISPLAY_DICT_ACK, &9u32.to_be_bytes()[..]),
        ]
    );

    let ack = DisplayAckPayload {
        generation: 3,
        largest_seq: 9,
        received: [0b101, 0, 0, 0],
        recovered: [0; 4],
        grant: 2,
    };
    harness.session.send_display_ack(NOW + 40, &ack, false);
    let actions = drain(&mut harness.session);
    let [
        Action::SendDatagram { conn, payload },
        Action::SendReliable {
            channel: CHANNEL_CTRL,
            payload: reliable,
            ..
        },
    ] = &actions[..]
    else {
        panic!("a new generation's ACK takes both lanes: {actions:?}");
    };
    assert_eq!(*conn, harness.interactive);
    assert_eq!(payload[0], CHANNEL_DISPLAY_ACK);
    let lane = merkur_e2e::lane_for_channel(CHANNEL_DISPLAY_ACK).unwrap();
    let opened = daemon.open_datagram(lane, &payload[1..]).unwrap();
    assert_eq!(DisplayAckPayload::parse(&opened), Some(ack));
    let opened = daemon.open_stream(ctrl, reliable).unwrap();
    assert_eq!(
        decode_proto_frame(&opened),
        Some((MSG_TYPE_DISPLAY_ACK, &ack.encode()[..]))
    );

    // Inside the cadence a plain advance rides the datagram alone.
    let next = DisplayAckPayload {
        largest_seq: 10,
        ..ack
    };
    harness.session.send_display_ack(NOW + 50, &next, false);
    let actions = drain(&mut harness.session);
    assert!(
        matches!(
            &actions[..],
            [Action::SendDatagram { .. } | Action::SendInputDatagram { .. }]
        ),
        "{actions:?}"
    );

    // Rows a digest showed diverged, in the body the daemon parses.
    harness.session.send_display_resync_rows(3, &[1, 4]);
    let resync = ctrl_frame(
        &mut daemon,
        &drain(&mut harness.session),
        harness.interactive,
    );
    assert_eq!(
        decode_proto_frame(&resync),
        Some((
            MSG_TYPE_DISPLAY_RESYNC_ROWS,
            &[0, 0, 0, 3, 0, 2, 0, 1, 0, 4][..]
        ))
    );
}

#[test]
fn an_unanswered_hello_is_retried_three_times_then_left_to_recovery() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (_, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    assert_eq!(
        harness.session.next_deadline(),
        Some(NOW + 20 + HELLO_RETRY_MS)
    );

    let mut hellos = 1;
    while let Some(at) = harness
        .session
        .next_deadline()
        .filter(|at| *at < NOW + 20 + HEARTBEAT_INTERVAL_MS)
    {
        harness.session.handle_timeout(at, &mut harness.entropy);
        let actions = drain(&mut harness.session);
        assert_eq!(actions.len(), 2, "{actions:?}");
        assert!(matches!(
            signal(&actions[0]),
            ClientSignal::DataAttach { .. }
        ));
        assert_eq!(
            actions[1],
            Action::SendReliable {
                conn: harness.interactive,
                channel: CHANNEL_DATA_HELLO,
                payload: encode_data_handshake_frame(DataHandshakeKind::Hello, &nonce),
            }
        );
        hellos += 1;
    }
    assert_eq!(hellos, HELLO_ATTEMPTS);
    // Only the epoch's renewal, at half the issued 60 s lifetime, is left on
    // the clock: the heartbeat starts at Ready.
    assert_eq!(harness.session.next_deadline(), Some(NOW + 20 + 30_000));
}

/// The message types of every control frame in `actions`, as the daemon opens
/// them.
fn ctrl_types(daemon: &mut NoiseTransport, actions: &[Action]) -> Vec<(u8, Vec<u8>)> {
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    actions
        .iter()
        .filter_map(|action| match action {
            Action::SendReliable {
                channel: CHANNEL_CTRL,
                payload,
                ..
            } => {
                let frame = daemon.open_stream(lane, payload).unwrap();
                let (kind, body) = decode_proto_frame(&frame).expect("a control frame");
                Some((kind, body.to_vec()))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn a_resume_claim_waits_for_the_carrier_and_falls_back_to_a_snapshot_unanswered() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (mut daemon, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    let resume = DisplayResume {
        generation: 7,
        applied_seq: 12,
        repair_id: 1,
        cols: 80,
        rows: 2,
        row_hashes: Some(vec![0x0102_0304_0506_0708, 9]),
    };
    harness.session.send_display_resume(NOW + 21, &resume);
    assert!(drain(&mut harness.session).is_empty());
    let actions = ack_hello(&mut harness, &nonce);
    let resumes: Vec<_> = ctrl_types(&mut daemon, &actions)
        .into_iter()
        .filter(|(kind, _)| *kind == MSG_TYPE_DISPLAY_RESUME)
        .collect();
    // The body `handle_display_resume` parses, the row hashes big-endian.
    let mut body = vec![0, 0, 0, 7, 0, 0, 0, 12, 0, 0, 0, 1, 0, 80, 0, 2, 2, 0, 0, 2];
    body.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 9]);
    assert_eq!(resumes, [(MSG_TYPE_DISPLAY_RESUME, body)]);

    // Nothing answered it within the watchdog: a snapshot is asked for.
    assert!(harness.session.next_deadline() <= Some(NOW + 30 + DISPLAY_RESUME_WATCHDOG_MS));
    harness
        .session
        .handle_timeout(NOW + 30 + DISPLAY_RESUME_WATCHDOG_MS, &mut harness.entropy);
    let sent = ctrl_types(&mut daemon, &drain(&mut harness.session));
    assert!(
        sent.contains(&(MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST, Vec::new())),
        "{sent:?}"
    );

    // A claimless resume, answered by display: no snapshot request follows.
    let claimless = DisplayResume {
        row_hashes: None,
        ..resume
    };
    harness.session.send_display_resume(NOW + 1_100, &claimless);
    let sent = ctrl_types(&mut daemon, &drain(&mut harness.session));
    assert_eq!(
        sent,
        [(
            MSG_TYPE_DISPLAY_RESUME,
            vec![0, 0, 0, 7, 0, 0, 0, 12, 0, 0, 0, 1, 0, 80, 0, 2]
        )]
    );
    let lane = merkur_e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
    let mut datagram = vec![CHANNEL_DISPLAY_DATAGRAM];
    datagram.extend_from_slice(&daemon.seal_datagram(lane, b"display").unwrap());
    harness.session.handle(
        NOW + 1_150,
        Event::Datagram {
            conn: harness.interactive,
            payload: &datagram,
        },
        &mut harness.entropy,
    );
    drain(&mut harness.session);
    harness.session.handle_timeout(
        NOW + 1_100 + DISPLAY_RESUME_WATCHDOG_MS,
        &mut harness.entropy,
    );
    let sent = ctrl_types(&mut daemon, &drain(&mut harness.session));
    assert!(
        !sent.contains(&(MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST, Vec::new())),
        "{sent:?}"
    );
}

/// The one CTRL frame in `actions`, as the daemon opens it.
fn ctrl_frame(daemon: &mut NoiseTransport, actions: &[Action], conn: ConnId) -> Vec<u8> {
    let [
        Action::SendReliable {
            conn: sent_on,
            channel: CHANNEL_CTRL,
            payload,
        },
    ] = actions
    else {
        panic!("{actions:?}");
    };
    assert_eq!(*sent_on, conn);
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    daemon.open_stream(lane, payload).unwrap()
}

#[test]
fn the_heartbeat_pings_from_ready_and_a_pong_ends_its_deadline() {
    let mut harness = authenticating();
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (mut daemon, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    let actions = ack_hello(&mut harness, &nonce);
    // data_received, Ready, the geometry's acquire, then the first ping on
    // the interactive lane.
    let acquire = ctrl_frame(&mut daemon, &actions[3..4], harness.interactive);
    assert_eq!(acquire[0], MSG_TYPE_GEOMETRY_CLAIM);
    let ping = ctrl_frame(&mut daemon, &actions[4..], harness.interactive);
    let token = (NOW + 30) * 1_000;
    assert_eq!(
        decode_proto_frame(&ping),
        Some((MSG_TYPE_HEARTBEAT_PING, &token.to_be_bytes()[..]))
    );
    // Its pong deadline is one initial RTO.
    assert_eq!(harness.session.next_deadline(), Some(NOW + 30 + 1_000));

    // The daemon's datagram pong is proof, a sample, and a reading of its
    // animation clock within that round trip; the steady tick is left.
    let mut pong = token.to_be_bytes().to_vec();
    pong.extend_from_slice(&5u64.to_be_bytes());
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let mut datagram = vec![CHANNEL_CTRL];
    datagram.extend_from_slice(
        &daemon
            .seal_datagram(lane, &encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong))
            .unwrap(),
    );
    harness.session.handle(
        NOW + 70,
        Event::Datagram {
            conn: harness.interactive,
            payload: &datagram,
        },
        &mut harness.entropy,
    );
    assert_eq!(
        drain(&mut harness.session),
        [Action::GraphicsClock {
            monotonic_us: 5,
            rtt_ms: 40
        }]
    );
    assert_eq!(harness.session.heartbeat.srtt_ms(), Some(40.0));
    assert_eq!(
        harness.session.next_deadline(),
        Some(NOW + 30 + HEARTBEAT_INTERVAL_MS)
    );

    // A daemon ping is answered on the carrier it came by, echoing its token.
    let ping = encode_proto_frame(MSG_TYPE_HEARTBEAT_PING, &9u64.to_be_bytes());
    let sealed = daemon.seal_stream(lane, &ping).unwrap();
    harness.session.handle(
        NOW + 80,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    let actions = drain(&mut harness.session);
    let pong = ctrl_frame(&mut daemon, &actions, harness.interactive);
    let mut expected = 9u64.to_be_bytes().to_vec();
    expected.extend_from_slice(&((NOW + 80) * 1_000).to_be_bytes());
    assert_eq!(
        decode_proto_frame(&pong),
        Some((MSG_TYPE_HEARTBEAT_PONG, &expected[..]))
    );
}

#[test]
fn a_focused_host_acquires_the_geometry_with_its_viewport_at_ready() {
    let mut harness = authenticating();
    harness.session.set_focused(true);
    harness.session.set_viewport(80, 24, Some((10.0, 20.5)));
    harness.session.handle(
        NOW + 6,
        Event::Connected(harness.interactive),
        &mut harness.entropy,
    );
    let (mut daemon, nonce, _) = deliver_ready(&mut harness, NOW + 20);
    let viewport = |cols: u16, rows: u16, seq: u32| {
        let mut bytes = cols.to_be_bytes().to_vec();
        bytes.extend_from_slice(&rows.to_be_bytes());
        bytes.extend_from_slice(&seq.to_be_bytes());
        bytes.extend_from_slice(&(10u32 << 16).to_be_bytes());
        bytes.extend_from_slice(&((20u32 << 16) + (1 << 15)).to_be_bytes());
        bytes
    };
    // The epoch's acquire carries the viewport, so a vacant geometry is
    // granted and sized in one owner turn.
    let mut acquire = vec![1];
    acquire.extend_from_slice(&0u64.to_be_bytes());
    acquire.extend_from_slice(&viewport(80, 24, 1));
    let sent = ctrl_types(&mut daemon, &ack_hello(&mut harness, &nonce));
    assert_eq!(sent[0], (MSG_TYPE_GEOMETRY_CLAIM, acquire));

    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let mut state = vec![1];
    state.extend_from_slice(&1u64.to_be_bytes());
    state.extend_from_slice(&1u32.to_be_bytes());
    let frame = encode_proto_frame(MSG_TYPE_GEOMETRY_STATE, &state);
    let sealed = daemon.seal_stream(lane, &frame).unwrap();
    harness.session.handle(
        NOW + 40,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    // Granted with the acquire's own resize: nothing follows it.
    assert!(matches!(
        &drain(&mut harness.session)[..],
        [Action::GeometryState(geometry::GeometryStatus::Owner)]
    ));

    harness.session.set_viewport(100, 30, Some((10.0, 20.5)));
    let mut resize = viewport(100, 30, 2);
    resize.extend_from_slice(&1u64.to_be_bytes());
    assert_eq!(
        ctrl_types(&mut daemon, &drain(&mut harness.session)),
        [(MSG_TYPE_RESIZE, resize)]
    );

    // A host that knows no cell pixels states its grid with zero metrics.
    harness.session.set_viewport(90, 28, None);
    let mut resize = 90u16.to_be_bytes().to_vec();
    resize.extend_from_slice(&28u16.to_be_bytes());
    resize.extend_from_slice(&3u32.to_be_bytes());
    resize.extend_from_slice(&[0; 8]);
    resize.extend_from_slice(&1u64.to_be_bytes());
    assert_eq!(
        ctrl_types(&mut daemon, &drain(&mut harness.session)),
        [(MSG_TYPE_RESIZE, resize)]
    );
}

#[test]
fn a_refused_or_mismatched_issuance_closes_the_session() {
    let (delegation, daemon, binding) = account();
    let mut entropy = Counter(0);
    let mut session = Session::new(
        Config {
            browser_node_id: BROWSER_NODE_ID.into(),
            relay_only: false,
        },
        delegation,
    );
    session.connect("daemon-2", &mut entropy);
    drain(&mut session);
    session.handle(
        NOW,
        Event::Issued(Some(issuance(&daemon, binding))),
        &mut entropy,
    );
    assert_eq!(
        drain(&mut session),
        vec![Action::Status(Status::Closed(CloseReason::IssuanceFailed))]
    );

    session.connect("daemon-2", &mut entropy);
    drain(&mut session);
    session.handle(NOW, Event::Issued(None), &mut entropy);
    assert_eq!(
        drain(&mut session),
        vec![Action::Status(Status::Closed(CloseReason::IssuanceFailed))]
    );
}

#[test]
fn auth_failed_closes_every_attachment() {
    let mut harness = authenticating();
    let refusal = br#"{"type":"auth_failed","reason":"capability"}"#;
    harness.session.handle(
        NOW + 20,
        Event::Reliable {
            conn: harness.signaling,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_SIGNALING,
            payload: refusal,
        },
        &mut harness.entropy,
    );
    assert_eq!(
        drain(&mut harness.session),
        vec![
            Action::Close {
                conn: harness.signaling
            },
            Action::Close {
                conn: harness.interactive
            },
            Action::Close { conn: harness.bulk },
            Action::Status(Status::Closed(CloseReason::AuthRejected)),
        ]
    );
}

#[test]
fn link_definitions_reach_the_viewer_only_from_reliable_control() {
    let (mut harness, mut daemon) = ready();
    let frame = encode_proto_frame(MSG_TYPE_DISPLAY_LINK_TABLE, &[1]);
    for channel in [CHANNEL_CTRL, CHANNEL_PTY] {
        let lane = merkur_e2e::lane_for_channel(channel).unwrap();
        let mut datagram = vec![channel];
        datagram.extend_from_slice(&daemon.seal_datagram(lane, &frame).unwrap());
        harness.session.handle(
            NOW + 40,
            Event::Datagram {
                conn: harness.interactive,
                payload: &datagram,
            },
            &mut harness.entropy,
        );
        assert!(drain(&mut harness.session).is_empty());
        let sealed = daemon.seal_stream(lane, &frame).unwrap();
        harness.session.handle(
            NOW + 41,
            Event::Reliable {
                conn: harness.interactive,
                source: DAEMON_ATTACHMENT,
                channel,
                payload: &sealed,
            },
            &mut harness.entropy,
        );
        let actions = drain(&mut harness.session);
        if channel == CHANNEL_CTRL {
            assert!(matches!(&actions[..], [Action::Terminal {
                channel: CHANNEL_CTRL, datagram: false, payload, ..
            }] if *payload == frame));
        } else {
            assert!(actions.is_empty());
        }
    }
}

#[test]
fn program_urls_require_authenticated_reliable_ctrl_and_explicit_retention_receipts() {
    let (mut harness, mut daemon) = ready();
    let id = OpenUrlId { epoch: 7, seq: 3 };
    let mut body = id.encode().to_vec();
    body.extend_from_slice(b"https://example.com/a;b?q=1");
    let frame = encode_proto_frame(MSG_TYPE_OPEN_URL, &body);
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let sealed = daemon.seal_stream(lane, &frame).unwrap();
    harness.session.handle(
        NOW + 60,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert_eq!(
        drain(&mut harness.session),
        vec![Action::OpenUrl {
            id,
            url: "https://example.com/a;b?q=1".into(),
        }]
    );
    // Parsing alone cannot stop the daemon offering a request. The host first
    // retains it, then sends the receipt, which traverses the authenticated lane.
    harness.session.acknowledge_open_url(id);
    let ack = ctrl_frame(
        &mut daemon,
        &drain(&mut harness.session),
        harness.interactive,
    );
    assert_eq!(
        decode_proto_frame(&ack),
        Some((MSG_TYPE_OPEN_URL_ACK, id.encode().as_slice()))
    );
    for channel in [CHANNEL_CTRL, CHANNEL_PTY] {
        let lane = merkur_e2e::lane_for_channel(channel).unwrap();
        let mut datagram = vec![channel];
        datagram.extend_from_slice(&daemon.seal_datagram(lane, &frame).unwrap());
        harness.session.handle(
            NOW + 61,
            Event::Datagram {
                conn: harness.interactive,
                payload: &datagram,
            },
            &mut harness.entropy,
        );
        assert!(drain(&mut harness.session).is_empty());
    }
    let lane = merkur_e2e::lane_for_channel(CHANNEL_PTY).unwrap();
    let sealed = daemon.seal_stream(lane, &frame).unwrap();
    harness.session.handle(
        NOW + 62,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_PTY,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    body.truncate(8);
    body.extend_from_slice(b"file:///etc/passwd");
    let sealed = daemon
        .seal_stream(
            merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
            &encode_proto_frame(MSG_TYPE_OPEN_URL, &body),
        )
        .unwrap();
    harness.session.handle(
        NOW + 63,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
}

#[test]
fn terminal_ui_requires_an_authenticated_reliable_ctrl_and_rejects_forged_effects() {
    let (mut harness, mut daemon) = ready();
    let effect = merkur_wire::terminal_ui::TerminalUi::Notification {
        title: "ready".into(),
        body: "a;b".into(),
    };
    let frame = effect.encode().unwrap();
    for channel in [CHANNEL_CTRL, CHANNEL_PTY, CHANNEL_DISPLAY_DATAGRAM] {
        let lane = merkur_e2e::lane_for_channel(channel).unwrap();
        let mut datagram = vec![channel];
        datagram.extend_from_slice(&daemon.seal_datagram(lane, &frame).unwrap());
        harness.session.handle(
            NOW + 70,
            Event::Datagram {
                conn: harness.interactive,
                payload: &datagram,
            },
            &mut harness.entropy,
        );
        assert!(drain(&mut harness.session).is_empty());
        let sealed = daemon.seal_stream(lane, &frame).unwrap();
        harness.session.handle(
            NOW + 71,
            Event::Reliable {
                conn: harness.interactive,
                source: DAEMON_ATTACHMENT,
                channel,
                payload: &sealed,
            },
            &mut harness.entropy,
        );
        let actions = drain(&mut harness.session);
        if channel == CHANNEL_CTRL {
            assert_eq!(actions, [Action::TerminalUi(effect.clone())]);
        } else {
            assert!(actions.is_empty());
        }
    }
    let mut truncated = frame.to_vec();
    truncated.pop();
    let sealed = daemon
        .seal_stream(
            merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
            &truncated,
        )
        .unwrap();
    harness.session.handle(
        NOW + 72,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
    let malformed = encode_proto_frame(MSG_TYPE_TERMINAL_UI, b"\x00x\x1b]52;c;bad");
    let sealed = daemon
        .seal_stream(
            merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
            &malformed,
        )
        .unwrap();
    harness.session.handle(
        NOW + 72,
        Event::Reliable {
            conn: harness.interactive,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_CTRL,
            payload: &sealed,
        },
        &mut harness.entropy,
    );
    assert!(drain(&mut harness.session).is_empty());
}

#[test]
fn a_full_host_queue_does_not_fence_input_or_ack_io_and_keeps_host_fifo() {
    let (mut harness, _daemon) = ready();
    drain(&mut harness.session);
    harness
        .session
        .actions
        .push_back(Action::DisplayFence(DisplayFence { lineage: 9 }));
    harness
        .session
        .actions
        .push_back(Action::TerminalUi(TerminalUi::Title("remote".into())));
    harness
        .session
        .send_input(NOW + 21, 1, build::press('x'), false);
    assert!(matches!(
        harness.session.poll_io_action(),
        Some(Action::SendDatagram { .. } | Action::SendInputDatagram { .. })
    ));
    harness.session.send_display_dictionary_ready(true);
    assert!(matches!(
        harness.session.poll_io_action(),
        Some(Action::SendReliable { .. })
    ));
    let remaining: Vec<_> = std::iter::from_fn(|| harness.session.poll_io_action()).collect();
    assert!(remaining.iter().all(|action| matches!(
        action,
        Action::SendReliable { .. }
            | Action::SendDatagram { .. }
            | Action::SendInputDatagram { .. }
    )));
    assert!(matches!(
        harness.session.peek_host_action(),
        Some(Action::DisplayFence(DisplayFence { lineage: 9 }))
    ));
    assert!(matches!(
        harness.session.poll_host_action(),
        Some(Action::DisplayFence(DisplayFence { lineage: 9 }))
    ));
    assert!(
        matches!(harness.session.poll_host_action(), Some(Action::TerminalUi(TerminalUi::Title(title))) if title == "remote")
    );
    assert!(harness.session.poll_host_action().is_none());
}

#[test]
fn closed_sessions_discard_input_and_never_accumulate_failures_or_recovery_work() {
    let (mut harness, _daemon) = ready();
    drain(&mut harness.session);
    harness
        .session
        .send_input(NOW + 21, 1, build::press('x'), true);
    assert!(!harness.session.outbox.is_empty());
    harness.session.fail(CloseReason::AuthRejected);
    assert!(harness.session.is_closed());
    assert!(harness.session.outbox.is_empty());
    let host_before: Vec<_> = harness
        .session
        .actions
        .iter()
        .filter(|action| action.is_host_output())
        .cloned()
        .collect();
    for sequence in 2..1000 {
        harness.session.send_input(
            NOW + sequence,
            sequence as u32,
            build::paste("private input"),
            true,
        );
        harness
            .session
            .handle_timeout(NOW + sequence, &mut harness.entropy);
        harness
            .session
            .connectivity_hint(NOW + sequence, &mut harness.entropy);
        harness
            .session
            .handle(NOW + sequence, Event::Issued(None), &mut harness.entropy);
    }
    assert!(harness.session.is_closed());
    assert!(harness.session.outbox.is_empty());
    assert!(harness.session.next_deadline().is_none());
    let host_after: Vec<_> = harness
        .session
        .actions
        .iter()
        .filter(|action| action.is_host_output())
        .cloned()
        .collect();
    assert_eq!(host_after, host_before);
    assert!(matches!(
        host_after.as_slice(),
        [Action::Status(Status::Closed(CloseReason::AuthRejected))]
    ));
}

#[test]
fn suspend_retires_carriers_and_work_but_keeps_unacknowledged_input() {
    let (mut harness, _) = ready();
    harness
        .session
        .send_input(NOW + 30, 1, build::press('s'), true);
    assert_eq!(harness.session.outbox.len(), 1);
    assert!(harness.session.next_deadline().is_some());
    harness.session.suspend();
    assert!(!harness.session.is_ready());
    assert_eq!(harness.session.next_deadline(), None);
    assert!(drain(&mut harness.session).is_empty());
    assert_eq!(
        harness.session.outbox.run(0, 1).collect::<Vec<_>>(),
        vec![(&build::press('s')[..], false)]
    );
    assert!(harness.session.issued.is_none());
    harness.session.connect("daemon", &mut harness.entropy);
    let actions = drain(&mut harness.session);
    assert!(
        actions
            .iter()
            .any(|a| matches!(a, Action::RequestIssuance { .. }))
    );
    assert_eq!(harness.session.outbox.len(), 1);
}

#[test]
fn carrier_retirement_bypasses_blocked_io_without_reordering_other_actions() {
    let (mut h, _daemon) = ready();
    let conn = h.interactive;
    h.session.actions.clear();
    h.session
        .actions
        .push_back(Action::DisplayFence(DisplayFence { lineage: 91 }));
    h.session.actions.push_back(Action::SendReliable {
        conn,
        channel: CHANNEL_CTRL,
        payload: vec![1],
    });
    h.session.actions.push_back(Action::Close { conn });
    h.session.actions.push_back(Action::TerminalUi(
        merkur_wire::terminal_ui::TerminalUi::Title("queued".into()),
    ));
    assert_eq!(
        h.session.poll_close_action(NOW + 202),
        Some(Action::Close { conn })
    );
    assert!(h.session.poll_close_action(NOW + 202).is_none());
    assert!(
        h.session.poll_io_action().is_none(),
        "retired ciphertext cannot leave its owner"
    );
    assert!(matches!(
        h.session.poll_host_action(),
        Some(Action::DisplayFence(_))
    ));
    assert!(matches!(
        h.session.poll_host_action(),
        Some(Action::TerminalUi(_))
    ));
}

#[test]
fn stalled_reliable_input_keeps_datagram_ack_progress_and_flushes_only_the_unsent_suffix() {
    let (mut h, mut daemon) = ready();
    drain(&mut h.session);
    h.session
        .set_reliable_blocked(NOW + 30, h.interactive, CHANNEL_PTY, true);
    h.session.send_input(NOW + 31, 1, build::press('a'), true);
    let sent: Vec<_> = std::iter::from_fn(|| h.session.poll_available_io_action()).collect();
    assert_eq!(
        received_input(&mut daemon, &sent),
        vec![(true, 1, vec![build::press('a')])]
    );
    assert_eq!(h.session.outbox.reliable_sent, 0);
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let ack = encode_proto_frame(MSG_TYPE_INPUT_ACK, &1u32.to_be_bytes());
    let mut packet = vec![CHANNEL_CTRL];
    packet.extend(daemon.seal_datagram(lane, &ack).unwrap());
    h.session.handle(
        NOW + 32,
        Event::Datagram {
            conn: h.interactive,
            payload: &packet,
        },
        &mut h.entropy,
    );
    assert!(h.session.outbox.is_empty());
    h.session.send_input(NOW + 33, 2, build::press('b'), false);
    let sent: Vec<_> = std::iter::from_fn(|| h.session.poll_available_io_action()).collect();
    assert_eq!(
        received_input(&mut daemon, &sent),
        vec![(true, 2, vec![build::press('b')])]
    );
    h.session
        .set_reliable_blocked(NOW + 34, h.interactive, CHANNEL_PTY, false);
    let sent: Vec<_> = std::iter::from_fn(|| h.session.poll_available_io_action()).collect();
    assert_eq!(
        received_input(&mut daemon, &sent),
        vec![
            (true, 2, vec![build::press('b')]),
            (false, 2, vec![build::press('b')])
        ]
    );
    assert_eq!(h.session.outbox.reliable_sent, 1);
}

#[test]
fn stalled_control_keeps_latest_reliable_display_ack_and_datagrams_flowing() {
    let (mut h, mut daemon) = ready();
    drain(&mut h.session);
    h.session
        .set_reliable_blocked(NOW + 30, h.interactive, CHANNEL_CTRL, true);
    for seq in 1..1000 {
        let ack = DisplayAckPayload {
            generation: 3,
            largest_seq: seq,
            received: [1, 0, 0, 0],
            recovered: [0; 4],
            grant: 2,
        };
        h.session.send_display_ack(NOW + seq as u64, &ack, true);
        let actions: Vec<_> = std::iter::from_fn(|| h.session.poll_available_io_action()).collect();
        assert!(matches!(actions.as_slice(), [Action::SendDatagram { .. }]));
        assert!(h.session.actions.is_empty());
        assert_eq!(
            h.session.display_ack_owed.as_ref().unwrap().0.largest_seq,
            seq
        );
    }
    h.session
        .set_reliable_blocked(NOW + 2000, h.interactive, CHANNEL_CTRL, false);
    let actions: Vec<_> = std::iter::from_fn(|| h.session.poll_available_io_action()).collect();
    let reliable: Vec<_> = actions
        .iter()
        .filter_map(|action| match action {
            Action::SendReliable {
                channel: CHANNEL_CTRL,
                payload,
                ..
            } => Some(payload),
            _ => None,
        })
        .collect();
    assert_eq!(reliable.len(), 1);
    let opened = daemon
        .open_stream(
            merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
            reliable[0],
        )
        .unwrap();
    let (_, body) = decode_proto_frame(&opened).unwrap();
    assert_eq!(DisplayAckPayload::parse(body).unwrap().largest_seq, 999);
    assert!(h.session.display_ack_owed.is_none());
}

#[test]
fn a_blocked_writer_preserves_its_fifo_without_holding_other_writers_or_datagrams() {
    let (mut h, _) = ready();
    h.session.actions.clear();
    h.session
        .set_reliable_blocked(NOW + 30, h.interactive, CHANNEL_CTRL, true);
    h.session.actions.extend([
        Action::SendReliable {
            conn: h.interactive,
            channel: CHANNEL_CTRL,
            payload: vec![1],
        },
        Action::SendInputDatagram {
            conn: h.interactive,
            payload: vec![2],
            top_seq: 1,
        },
        Action::SendReliable {
            conn: h.interactive,
            channel: CHANNEL_PTY,
            payload: vec![3],
        },
        Action::SendReliable {
            conn: h.interactive,
            channel: CHANNEL_CTRL,
            payload: vec![4],
        },
    ]);
    assert!(matches!(
        h.session.poll_available_io_action(),
        Some(Action::SendInputDatagram { .. })
    ));
    assert!(matches!(
        h.session.poll_available_io_action(),
        Some(Action::SendReliable {
            channel: CHANNEL_PTY,
            ..
        })
    ));
    assert!(h.session.poll_available_io_action().is_none());
    h.session
        .set_reliable_blocked(NOW + 31, h.interactive, CHANNEL_CTRL, false);
    assert!(
        matches!(h.session.poll_available_io_action(), Some(Action::SendReliable { payload, .. }) if payload == vec![1])
    );
    assert!(
        matches!(h.session.poll_available_io_action(), Some(Action::SendReliable { payload, .. }) if payload == vec![4])
    );
}

#[test]
fn datagram_pings_keep_one_latest_plaintext_reply_per_stalled_provider() {
    let (mut h, mut daemon) = ready();
    drain(&mut h.session);
    h.session
        .set_reliable_blocked(NOW + 30, h.interactive, CHANNEL_CTRL, true);
    let lane = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    for token in 1u64..1000 {
        let ping = encode_proto_frame(MSG_TYPE_HEARTBEAT_PING, &token.to_be_bytes());
        let mut packet = vec![CHANNEL_CTRL];
        packet.extend(daemon.seal_datagram(lane, &ping).unwrap());
        h.session.handle(
            NOW + 30,
            Event::Datagram {
                conn: h.interactive,
                payload: &packet,
            },
            &mut h.entropy,
        );
        assert!(h.session.actions.is_empty());
        assert_eq!(h.session.pong_owed.len(), 1);
    }
    h.session
        .set_reliable_blocked(NOW + 31, h.interactive, CHANNEL_CTRL, false);
    let Some(Action::SendReliable {
        conn,
        channel: CHANNEL_CTRL,
        payload,
    }) = h.session.poll_available_io_action()
    else {
        panic!("one retained reply");
    };
    assert_eq!(conn, h.interactive);
    let opened = daemon.open_stream(lane, &payload).unwrap();
    let (kind, body) = decode_proto_frame(&opened).unwrap();
    assert_eq!(kind, MSG_TYPE_HEARTBEAT_PONG);
    assert_eq!(&body[..8], &999u64.to_be_bytes());
    assert!(h.session.pong_owed.is_empty());
    assert!(h.session.poll_available_io_action().is_none());
}

#[test]
fn blocked_control_retains_bounded_host_facts_and_the_exact_union_of_repair_rows() {
    let (mut h, mut daemon) = ready();
    drain(&mut h.session);
    h.session
        .set_reliable_blocked(NOW + 30, h.interactive, CHANNEL_CTRL, true);
    for seq in 0u16..1000 {
        h.session.send_display_resync_rows(9, &[seq, seq]);
        let mut hint = [0u8; 11];
        hint[1..3].copy_from_slice(&seq.to_be_bytes());
        assert!(h.session.send_host_observation(&encode_proto_frame(
            merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT,
            &hint
        )));
        assert!(h.session.actions.is_empty());
        assert_eq!(h.session.host_observation_owed.iter().flatten().count(), 1);
    }
    assert!(!h.session.send_host_observation(&encode_proto_frame(
        merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT,
        &[0; 12]
    )));
    h.session
        .set_reliable_blocked(NOW + 31, h.interactive, CHANNEL_CTRL, false);
    let actions: Vec<_> = std::iter::from_fn(|| h.session.poll_available_io_action()).collect();
    assert_eq!(actions.len(), 2);
    let ctrl = merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let mut repair = false;
    let mut hint = false;
    for action in actions {
        let Action::SendReliable { payload, .. } = action else {
            panic!("reliable retained intent");
        };
        let opened = daemon.open_stream(ctrl, &payload).unwrap();
        let (kind, body) = decode_proto_frame(&opened).unwrap();
        if kind == MSG_TYPE_DISPLAY_RESYNC_ROWS {
            assert_eq!(&body[..4], &9u32.to_be_bytes());
            assert_eq!(&body[4..6], &1000u16.to_be_bytes());
            let rows: Vec<_> = body[6..]
                .chunks_exact(2)
                .map(|bytes| u16::from_be_bytes(bytes.try_into().unwrap()))
                .collect();
            assert_eq!(rows, (0u16..1000).collect::<Vec<_>>());
            repair = true;
        } else {
            assert_eq!(kind, merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT);
            assert_eq!(&body[1..3], &999u16.to_be_bytes());
            hint = true;
        }
    }
    assert!(repair && hint);
}

#[test]
fn stale_writer_admission_cannot_grow_state_or_flush_a_live_blocked_suffix() {
    let (mut h, _) = ready();
    drain(&mut h.session);
    h.session
        .set_reliable_blocked(NOW + 30, h.interactive, CHANNEL_PTY, true);
    h.session.send_input(NOW + 31, 1, build::press('a'), false);
    while h.session.poll_available_io_action().is_some() {}
    for unknown in 1000..2000 {
        h.session
            .set_reliable_blocked(NOW + 32, ConnId(unknown), CHANNEL_PTY, true);
        h.session
            .set_reliable_blocked(NOW + 32, ConnId(unknown), CHANNEL_PTY, false);
    }
    assert_eq!(
        h.session.reliable_blocked,
        vec![(h.interactive, CHANNEL_PTY)]
    );
    assert_eq!(h.session.outbox.reliable_sent, 0);
    assert!(h.session.poll_available_io_action().is_none());
}

#[test]
fn closing_another_carrier_cannot_release_an_unfinished_live_crypto_lane() {
    let (mut h, _) = ready();
    drain(&mut h.session);
    h.session
        .set_reliable_blocked(NOW + 30, h.interactive, CHANNEL_CTRL, true);
    let hint = encode_proto_frame(merkur_wire::protocol::MSG_TYPE_TRANSPORT_HINT, &[0; 11]);
    assert!(h.session.send_host_observation(&hint));
    let retired = h.bulk;
    h.session.actions.push_back(Action::Close { conn: retired });
    assert_eq!(
        h.session.poll_close_action(NOW + 31),
        Some(Action::Close { conn: retired })
    );
    assert!(!h.session.has_reliable_capacity(CHANNEL_CTRL));
    assert!(h.session.poll_available_io_action().is_none());
    assert_eq!(h.session.host_observation_owed.iter().flatten().count(), 1);
}

#[test]
fn an_unsigned_auth_failed_cannot_end_an_authenticated_session_and_the_servers_denial_does() {
    let (mut h, _) = ready();
    drain(&mut h.session);
    h.session.send_input(NOW + 30, 1, build::press('s'), false);
    drain(&mut h.session);
    h.session.start_candidate(NOW + 31, &mut h.entropy);
    drain(&mut h.session);
    let candidate = h.session.candidate.as_ref().unwrap().conn;
    let failure = DaemonSignal::AuthFailed {
        reason: "session_rejected".into(),
    };
    let signaling = h.signaling;
    let json = failure.to_json();
    h.session.handle(
        NOW + 32,
        Event::Reliable {
            conn: signaling,
            source: DAEMON_ATTACHMENT,
            channel: CHANNEL_SIGNALING,
            payload: json.as_bytes(),
        },
        &mut h.entropy,
    );
    // The record carries no proof: the session, its candidate and its held
    // input stand as they were.
    assert_eq!(drain(&mut h.session), []);
    assert!(!h.session.is_closed());
    assert!(h.session.candidate.is_some());
    assert_eq!(h.session.outbox.len(), 1);

    h.session
        .handle(NOW + 32, Event::AuthorizationDenied, &mut h.entropy);
    let actions = drain(&mut h.session);
    assert!(h.session.is_closed());
    assert!(h.session.candidate.is_none());
    assert_eq!(h.session.outbox.len(), 0);
    assert!(actions.contains(&Action::Close { conn: candidate }));
    assert!(actions.contains(&Action::Close { conn: signaling }));
    assert_eq!(
        actions
            .iter()
            .filter(|action| matches!(
                action,
                Action::Status(Status::Closed(CloseReason::AuthRejected))
            ))
            .count(),
        1
    );
    h.session.handle(
        NOW + 33,
        Event::Closed {
            conn: signaling,
            egress_budget: false,
        },
        &mut h.entropy,
    );
    h.session.handle_timeout(NOW + 100_000, &mut h.entropy);
    assert!(drain(&mut h.session).is_empty());
    assert!(h.session.next_deadline().is_none());
}

#[test]
fn authoritative_account_denial_terminates_while_transient_issuance_failure_retries() {
    let (mut h, _) = ready();
    drain(&mut h.session);
    h.session
        .handle(NOW + 31, Event::AuthorizationDenied, &mut h.entropy);
    assert!(h.session.is_closed());
    assert!(
        drain(&mut h.session).contains(&Action::Status(Status::Closed(CloseReason::AuthRejected)))
    );
    let (mut h, _) = ready();
    h.session.recovering = true;
    h.session.issue(&mut h.entropy);
    drain(&mut h.session);
    h.session
        .handle(NOW + 31, Event::IssuanceFailed, &mut h.entropy);
    assert!(!h.session.is_closed());
    assert!(h.session.next_deadline().is_some());

    let (mut h, _) = ready();
    h.session.recovering = true;
    h.session.issue(&mut h.entropy);
    drain(&mut h.session);
    h.session
        .handle(NOW + 31, Event::Issued(None), &mut h.entropy);
    assert!(
        h.session.is_closed(),
        "invalid successful responses are definitive"
    );
    assert!(
        drain(&mut h.session)
            .contains(&Action::Status(Status::Closed(CloseReason::IssuanceFailed)))
    );
    assert_eq!(h.session.next_deadline(), None);
}

#[test]
fn terminal_authorization_denial_discards_unstarted_account_and_wire_work() {
    let (mut h, _) = ready();
    drain(&mut h.session);
    h.session.issue(&mut h.entropy);
    assert!(
        h.session
            .actions
            .iter()
            .any(|action| matches!(action, Action::RequestIssuance(_)))
    );
    h.session
        .handle(NOW + 40, Event::AuthorizationDenied, &mut h.entropy);
    assert!(h.session.is_closed());
    while let Some(action) = h.session.poll_available_io_action() {
        assert!(
            matches!(action, Action::Close { .. }),
            "terminal state admits only retirement"
        );
    }
}

#[test]
fn a_graphics_job_is_told_to_a_recording_host_as_io_and_to_no_other() {
    let (mut h, _) = ready();
    drain(&mut h.session);
    let tile = |key: &str| graphics::GraphicsDemand {
        asset: graphics::GraphicsAsset::Tile,
        authority: [0x11; 32],
        frame: 0,
        key: key.into(),
        source: [0x11; 32],
        level: 0,
        x: 0,
        y: 0,
        width: 258,
        height: 258,
    };
    let lineage = h.session.display_lineage();
    let job = |action: &Action| matches!(action, Action::GraphicsJob { .. });

    // A host that records nothing is told nothing.
    h.session.graphics_demand(lineage, vec![tile("a")]);
    assert!(!drain(&mut h.session).iter().any(job));

    let enable = |on: u8| {
        encode_proto_frame(
            merkur_wire::protocol::MSG_TYPE_PERF_ENABLE,
            &[on, 0, 0, 0, 7],
        )
    };
    assert!(h.session.send_host_observation(&enable(1)));
    h.session.graphics_demand(lineage, vec![tile("a"), tile("b")]);
    // The transitions are I/O: no host output stands in front of them.
    assert!(
        std::iter::from_fn(|| h.session.poll_host_action()).all(|action| !job(&action)),
        "a transition waited behind host output"
    );
    let told: Vec<Action> = std::iter::from_fn(|| h.session.poll_available_io_action())
        .filter(job)
        .collect();
    assert_eq!(
        told,
        [
            Action::GraphicsJob {
                phase: graphics::GraphicsPhase::Demanded,
                job: 2,
                bytes: 0,
                failed: false
            },
            Action::GraphicsJob {
                phase: graphics::GraphicsPhase::Requested,
                job: 2,
                bytes: 0,
                failed: false
            }
        ]
    );

    // The host stops recording, and the next job is told to nobody.
    assert!(h.session.send_host_observation(&enable(0)));
    h.session
        .graphics_demand(lineage, vec![tile("a"), tile("b"), tile("c")]);
    assert!(!drain(&mut h.session).iter().any(job));
}
