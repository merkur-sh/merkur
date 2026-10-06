//! Path-aware transport send helpers shared by the display and session
//! layers: single-path sends, multipath (dual-send) routing, and send-outcome
//! bookkeeping feeding path health.
//!
//! Every helper admits synchronously. The direct carrier is the session the peer
//! owns (`PeerDisplayState::direct_session`) and the edge carrier is its tunnel;
//! neither send looks anything up, takes a lock or awaits.

use std::sync::Arc;

use crate::connection::PeerTransport;
#[cfg(test)]
use crate::connection::{PeerDisplayState, SendIntent, SentPaths};
use crate::edge_tunnel::EdgeTunnel;
use crate::network::peer::ReliablePayload;
use crate::network::protocol::*;
use crate::session::policy::SessionPolicy;
use crate::webtransport::DirectSession;

/// The per-peer edge tunnel handle passed to outbound send helpers. The edge is
/// an explicit carrier rather than an unconditional mirror. Frames are sealed
/// exactly once upstream.
pub(crate) type EdgeMirror<'a> = Option<&'a Arc<EdgeTunnel>>;

/// The peer's own direct session, when it has one.
pub(crate) type DirectCarrier<'a> = Option<&'a DirectSession>;

/// Enqueue an already-sealed reliable record onto the selected edge carrier.
/// This is non-blocking. Rejection returns the exact record — heap or inline —
/// so a fallback carrier can admit it without cloning or resealing.
fn send_reliable_via_edge(
    edge: EdgeMirror<'_>,
    channel_id: u8,
    payload: ReliablePayload,
) -> Result<(), ReliablePayload> {
    match edge {
        Some(tunnel) => tunnel.send_reliable(channel_id, payload),
        None => Err(payload),
    }
}

/// Exact-carrier reliable admission that preserves ownership of rejected bytes.
/// The input is already sealed; returning it is what lets callers fail over
/// without a ciphertext clone or a second Noise counter advance.
pub(crate) fn transport_send_recoverable(
    transport: PeerTransport,
    channel_id: u8,
    payload: ReliablePayload,
    direct: DirectCarrier<'_>,
    edge: EdgeMirror<'_>,
) -> Result<(), ReliablePayload> {
    match transport {
        PeerTransport::WebTransport => match direct {
            Some(session) => session.try_send_reliable(channel_id, payload),
            None => Err(payload),
        },
        PeerTransport::Edge => send_reliable_via_edge(edge, channel_id, payload),
    }
}

/// Admit one already-sealed reliable payload on the selected carrier, falling
/// through exactly once after immediate rejection. A successful primary send
/// performs no clone and no secondary lookup. Returns the carrier that actually
/// accepted the bytes so ACK bookkeeping never attributes fallback traffic to
/// the failed primary.
pub(crate) fn transport_send_reliable_with_fallback(
    paths: &mut crate::connection::PeerPaths,
    primary: PeerTransport,
    channel_id: u8,
    payload: ReliablePayload,
    direct: DirectCarrier<'_>,
    edge: EdgeMirror<'_>,
    now_ms: f64,
) -> Option<PeerTransport> {
    let payload = match transport_send_recoverable(primary, channel_id, payload, direct, edge) {
        Ok(()) => {
            record_send_outcome(paths, primary, true);
            return Some(primary);
        }
        Err(payload) => {
            record_send_outcome(paths, primary, false);
            payload
        }
    };

    let fallback = paths.fallback_for(primary, now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS)?;
    let sent = transport_send_recoverable(fallback, channel_id, payload, direct, edge).is_ok();
    record_send_outcome(paths, fallback, sent);
    sent.then_some(fallback)
}

/// Reliable admission for owner-loop maintenance. Unlike a data send, a
/// rejected profiling record does not count as path failure: a full
/// low-priority reliable queue is ordinary backpressure, and the exact payload
/// is refused for a later turn.
pub(crate) fn transport_try_send_maintenance_reliable_with_fallback(
    paths: &crate::connection::PeerPaths,
    primary: PeerTransport,
    channel_id: u8,
    payload: ReliablePayload,
    direct: DirectCarrier<'_>,
    edge: EdgeMirror<'_>,
    now_ms: f64,
) -> bool {
    let payload = match transport_send_recoverable(primary, channel_id, payload, direct, edge) {
        Ok(()) => return true,
        Err(payload) => payload,
    };
    paths
        .fallback_for(primary, now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS)
        .is_some_and(|fallback| {
            transport_send_recoverable(fallback, channel_id, payload, direct, edge).is_ok()
        })
}

/// Queue one sealed, channel-framed datagram on `transport`. The carrier
/// takes a reference to `wire`; nothing copies it into an envelope.
pub(crate) fn transport_send_datagram(
    transport: PeerTransport,
    wire: &bytes::Bytes,
    direct: DirectCarrier<'_>,
    edge: EdgeMirror<'_>,
) -> bool {
    match transport {
        PeerTransport::WebTransport => {
            direct.is_some_and(|session| session.send_datagram_owned(wire))
        }
        PeerTransport::Edge => edge.is_some_and(|tunnel| tunnel.send_framed_datagram(wire)),
    }
}

/// Mutate per-path `consecutive_send_failures` based on whether the send
/// succeeded. After `PATH_SEND_FAILURE_THRESHOLD` failures the path is
/// marked unavailable so subsequent `pick_path` calls route around it.
pub(crate) fn record_send_outcome(
    paths: &mut crate::connection::PeerPaths,
    transport: PeerTransport,
    sent: bool,
) {
    let path = paths.get_mut(transport);
    if sent {
        path.consecutive_send_failures = 0;
    } else {
        path.consecutive_send_failures = path.consecutive_send_failures.saturating_add(1);
        if path.consecutive_send_failures >= SessionPolicy::PATH_SEND_FAILURE_THRESHOLD {
            path.available = false;
        }
    }
}

/// Test harness for exercising carrier selection below the physical display
/// budget. Production display sends go through the budgeted group sender.
#[cfg(test)]
pub(crate) fn send_display_wire_with_intent(
    peer: &mut PeerDisplayState,
    wire: &bytes::Bytes,
    now_ms: f64,
    intent: SendIntent,
) -> SentPaths {
    // Display datagram send. `pick_path` selects the lower-RTT live path
    // and auto-promotes to dual-send for latency-sensitive intents when the
    // primary shows degradation signals. Redundant always races both paths,
    // while SinglePath/Bulk admit exactly one copy unless the selected carrier
    // immediately rejects it.
    //
    // Returns the path(s) that actually carried the datagram so the ACK
    // handler can attribute the RTT sample to the outbound leg.
    let targets = crate::connection::pick_path(
        &peer.paths,
        intent,
        now_ms,
        SessionPolicy::PATH_STALE_THRESHOLD_MS,
    );

    let mut sent_via = SentPaths::default();
    for target in targets.iter() {
        let sent = send_display_wire_on_transport(
            target,
            wire,
            peer.direct_session.as_ref(),
            peer.edge_tunnel.as_ref(),
        );
        record_send_outcome(&mut peer.paths, target, sent);
        if sent {
            sent_via.mark(target);
        }
    }

    // A single-route send only touches a second carrier after immediate
    // admission failure. This retains failover while avoiding permanent
    // duplicate traffic in the healthy steady state.
    if !sent_via.any() && !targets.is_dual() {
        let primary = targets.primary();
        if let Some(fallback) =
            peer.paths
                .fallback_for(primary, now_ms, SessionPolicy::PATH_STALE_THRESHOLD_MS)
        {
            let sent = send_display_wire_on_transport(
                fallback,
                wire,
                peer.direct_session.as_ref(),
                peer.edge_tunnel.as_ref(),
            );
            record_send_outcome(&mut peer.paths, fallback, sent);
            if sent {
                sent_via.mark(fallback);
            }
        }
    }
    sent_via
}

pub(crate) fn send_display_wire_on_transport(
    transport: PeerTransport,
    wire: &bytes::Bytes,
    direct: DirectCarrier<'_>,
    edge: EdgeMirror<'_>,
) -> bool {
    if wire.first() != Some(&CHANNEL_DISPLAY_DATAGRAM) {
        return false;
    }
    transport_send_datagram(transport, wire, direct, edge)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::PeerPaths;
    use tokio::sync::mpsc;

    fn direct_capture(
        peer_id: &str,
        capture: mpsc::UnboundedSender<(String, Vec<u8>)>,
    ) -> DirectSession {
        DirectSession::new_capture(peer_id.into(), capture, None)
    }

    fn test_display_wire() -> bytes::Bytes {
        bytes::Bytes::from_static(&[
            CHANNEL_DISPLAY_DATAGRAM,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            7,
            0xaa,
            0xbb,
            0xcc,
        ])
    }

    fn captured_edge_wire((channel_id, payload): (u8, Vec<u8>)) -> Vec<u8> {
        let mut wire = Vec::with_capacity(1 + payload.len());
        wire.push(channel_id);
        wire.extend_from_slice(&payload);
        wire
    }

    fn established_display_peer(
        initial: PeerTransport,
    ) -> (PeerDisplayState, crate::e2e::NoiseTransport) {
        let psk = [0x31u8; 32];
        let prologue =
            crate::e2e::derive_prologue("display-wire-test", "browser-test", &[0x42; 64]);
        let (browser_static, _) = crate::e2e::generate_static_keypair().expect("browser key");
        let (daemon_static, _) = crate::e2e::generate_static_keypair().expect("daemon key");
        let mut initiator =
            crate::e2e::NoiseHandshake::new_initiator(&browser_static, &psk, &prologue)
                .expect("initiator");
        let mut responder =
            crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue)
                .expect("responder");
        responder
            .read_message(&initiator.write_message(b"").expect("message 1"))
            .expect("read message 1");
        initiator
            .read_message(&responder.write_message(b"").expect("message 2"))
            .expect("read message 2");
        responder
            .read_message(&initiator.write_message(b"").expect("message 3"))
            .expect("read message 3");
        let mut peer = PeerDisplayState::new("browser-test".into(), initial);
        peer.authenticated = true;
        peer.noise = Some(responder.into_transport().expect("daemon transport"));
        (peer, initiator.into_transport().expect("browser transport"))
    }

    #[tokio::test]
    async fn framed_display_wire_reaches_direct_byte_exact() {
        let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
        let mut peer = PeerDisplayState::new("browser-direct".into(), PeerTransport::WebTransport);
        peer.direct_session = Some(direct_capture("browser-direct", capture_tx));
        let wire = test_display_wire();

        let sent = send_display_wire_with_intent(&mut peer, &wire, 100.0, SendIntent::SinglePath);

        assert_eq!(sent, SentPaths::single(PeerTransport::WebTransport));
        assert_eq!(
            capture_rx.try_recv().unwrap(),
            ("browser-direct".to_owned(), wire.to_vec())
        );
        assert!(capture_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn framed_display_wire_reaches_edge_byte_exact() {
        let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
        let edge = Arc::new(EdgeTunnel::new_capture(capture_tx));
        let mut peer = PeerDisplayState::new("browser-edge".into(), PeerTransport::Edge);
        peer.edge_tunnel = Some(edge);
        let wire = test_display_wire();

        let sent = send_display_wire_with_intent(&mut peer, &wire, 100.0, SendIntent::SinglePath);

        assert_eq!(sent, SentPaths::single(PeerTransport::Edge));
        assert_eq!(captured_edge_wire(capture_rx.try_recv().unwrap()), wire);
        assert!(capture_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn redundant_display_send_reuses_one_exact_wire_on_both_carriers() {
        let (direct_tx, mut direct_rx) = mpsc::unbounded_channel();
        let (edge_tx, mut edge_rx) = mpsc::unbounded_channel();
        let edge = Arc::new(EdgeTunnel::new_capture(edge_tx));
        let mut peer =
            PeerDisplayState::new("browser-redundant".into(), PeerTransport::WebTransport);
        peer.direct_session = Some(direct_capture("browser-redundant", direct_tx));
        peer.paths.edge = crate::connection::PathHealth::fresh_available(0.0);
        peer.edge_tunnel = Some(edge);
        let wire = test_display_wire();

        let sent = send_display_wire_with_intent(&mut peer, &wire, 100.0, SendIntent::Redundant);

        assert_eq!(
            sent,
            SentPaths {
                webtransport: true,
                edge: true,
            }
        );
        assert_eq!(
            direct_rx.try_recv().unwrap(),
            ("browser-redundant".to_owned(), wire.to_vec())
        );
        assert_eq!(captured_edge_wire(edge_rx.try_recv().unwrap()), wire);
        assert!(direct_rx.try_recv().is_err());
        assert!(edge_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn rejected_direct_admission_falls_back_with_no_second_noise_counter() {
        let (rejected_tx, rejected_rx) = mpsc::unbounded_channel();
        drop(rejected_rx);
        let (edge_tx, mut edge_rx) = mpsc::unbounded_channel();
        let edge = Arc::new(EdgeTunnel::new_capture(edge_tx));
        let (mut peer, mut browser) = established_display_peer(PeerTransport::WebTransport);
        peer.direct_session = Some(direct_capture("browser-test", rejected_tx));
        peer.paths.webtransport.rtt_ewma_ms = 5.0;
        peer.paths.edge = crate::connection::PathHealth::fresh_available(0.0);
        peer.paths.edge.rtt_ewma_ms = 20.0;
        peer.edge_tunnel = Some(edge);

        let first = peer
            .seal_display_wire(b"fallback")
            .expect("established transport");
        assert_eq!(u64::from_be_bytes(first[1..9].try_into().unwrap()), 0);
        let sent = send_display_wire_with_intent(&mut peer, &first, 100.0, SendIntent::SinglePath);

        assert_eq!(sent, SentPaths::single(PeerTransport::Edge));
        assert_eq!(captured_edge_wire(edge_rx.try_recv().unwrap()), first);
        assert_eq!(peer.paths.webtransport.consecutive_send_failures, 1);
        assert_eq!(peer.paths.edge.consecutive_send_failures, 0);

        let second = peer
            .seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, b"next")
            .expect("established transport");
        assert_eq!(u64::from_be_bytes(second[1..9].try_into().unwrap()), 1);
        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
        assert_eq!(
            browser.open_datagram(lane, &first[1..]).unwrap(),
            b"fallback"
        );
        assert_eq!(browser.open_datagram(lane, &second[1..]).unwrap(), b"next");
        assert!(edge_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn rejected_primary_reuses_exact_reliable_bytes_on_edge_fallback() {
        let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
        let edge = Arc::new(EdgeTunnel::new_capture(capture_tx));
        let mut paths = PeerPaths::new(PeerTransport::WebTransport, 0.0);
        paths.edge = crate::connection::PathHealth::fresh_available(0.0);
        paths.webtransport.rtt_ewma_ms = 5.0;
        paths.edge.rtt_ewma_ms = 20.0;
        let ciphertext = vec![0x91, 0x82, 0x73, 0x64];

        let accepted = transport_send_reliable_with_fallback(
            &mut paths,
            PeerTransport::WebTransport,
            CHANNEL_CTRL,
            ReliablePayload::Heap(ciphertext.clone()),
            None,
            Some(&edge),
            100.0,
        );

        assert_eq!(accepted, Some(PeerTransport::Edge));
        assert_eq!(
            capture_rx.try_recv().unwrap(),
            (CHANNEL_CTRL, ciphertext),
            "fallback must carry the exact already-sealed payload"
        );
        assert!(capture_rx.try_recv().is_err());
        assert_eq!(paths.webtransport.consecutive_send_failures, 1);
        assert_eq!(paths.edge.consecutive_send_failures, 0);

        let second = vec![0xaa, 0xbb];
        let accepted_second = transport_send_reliable_with_fallback(
            &mut paths,
            accepted.unwrap(),
            CHANNEL_CTRL,
            ReliablePayload::Heap(second.clone()),
            None,
            Some(&edge),
            100.0,
        );
        assert_eq!(accepted_second, Some(PeerTransport::Edge));
        assert_eq!(capture_rx.try_recv().unwrap(), (CHANNEL_CTRL, second));
        assert_eq!(
            paths.webtransport.consecutive_send_failures, 1,
            "pinning continuation chunks to the accepted fallback avoids re-probing the failed queue"
        );
    }

    #[tokio::test]
    async fn accepted_edge_primary_does_not_emit_a_fallback_copy() {
        let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
        let edge = Arc::new(EdgeTunnel::new_capture(capture_tx));
        let mut paths = PeerPaths::new(PeerTransport::Edge, 0.0);
        paths.webtransport = crate::connection::PathHealth::fresh_available(0.0);

        let accepted = transport_send_reliable_with_fallback(
            &mut paths,
            PeerTransport::Edge,
            CHANNEL_CTRL,
            ReliablePayload::Heap(vec![1, 2, 3]),
            None,
            Some(&edge),
            100.0,
        );

        assert_eq!(accepted, Some(PeerTransport::Edge));
        assert_eq!(capture_rx.try_recv().unwrap().1, vec![1, 2, 3]);
        assert!(capture_rx.try_recv().is_err());
        assert_eq!(paths.webtransport.consecutive_send_failures, 0);
    }

    #[tokio::test]
    async fn rejection_on_every_live_carrier_reports_both_outcomes() {
        let mut paths = PeerPaths::new(PeerTransport::WebTransport, 0.0);
        paths.edge = crate::connection::PathHealth::fresh_available(0.0);

        let accepted = transport_send_reliable_with_fallback(
            &mut paths,
            PeerTransport::WebTransport,
            CHANNEL_CTRL,
            ReliablePayload::Heap(vec![4, 5, 6]),
            None,
            None,
            100.0,
        );

        assert_eq!(accepted, None);
        assert_eq!(paths.webtransport.consecutive_send_failures, 1);
        assert_eq!(paths.edge.consecutive_send_failures, 1);
    }
}
