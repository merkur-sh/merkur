//! Per-path liveness: heartbeat ping/pong, RTT attribution, staleness
//! sweep, and auth-timeout eviction.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::auth::DaemonIdentity;
use crate::connection::{PeerDisplayState, PeerMap, PeerTransport};
use crate::display::policy::DisplayPolicy;
use crate::ipc::events::*;
use crate::network::NetworkState;
use crate::network::peer::{DeliveryMode, PeerMessage, ReliablePayload};
use crate::network::protocol::*;
use crate::session::policy::SessionPolicy;
use crate::session::resume::{ParkedPeers, park_disconnected_peer};
use crate::session::wt_upgrade_flow::{WT_UPGRADE_PENDING_TTL_MS, WtUpgradePending};
use crate::transport::{
    transport_send_datagram, transport_send_recoverable, transport_send_reliable_with_fallback,
};
use crate::{now_ms_since, send_json_event};

/// Whether one live row can be included in a display digest.
///
/// A row is coverable once the peer's copy of it has had time to settle:
/// asking the client to compare hashes for content still crossing the wire
/// would report a mismatch on every in-flight row. The bound is measured from
/// the FIRST send of this content, so a row that idempotent re-sending keeps
/// putting back on the wire still becomes coverable instead of being deferred
/// forever. The digest wire format carries explicit row indices, so stable rows
/// stay covered while another row changes continuously.
fn display_hash_digest_row_is_ready(
    peer: &PeerDisplayState,
    row: usize,
    current_hash: u64,
    now_ms: f64,
) -> bool {
    let Some(&sent_hash) = peer.display_cache.sent_row_hashes.get(row) else {
        return false;
    };
    if sent_hash != current_hash {
        return false;
    }
    let first_sent_at_ms = peer
        .display_cache
        .sent_row_first_sent_at_ms
        .get(row)
        .copied()
        .unwrap_or(f64::NEG_INFINITY);
    first_sent_at_ms.is_finite() && now_ms - first_sent_at_ms >= DisplayPolicy::DIGEST_ROW_SETTLE_MS
}

/// Tell the client its resume repair is complete, once every row it selected
/// has reached a transport.
///
/// The browser holds new pixels until this lands or its visual frame bound expires,
/// which is what turns a reconnect repaint from a row-by-row reveal into one
/// step. The marker names every display sequence that admitted at least one of
/// those rows. A largest-sequence watermark would lie in the presence of a
/// datagram hole. Sent on the reliable CTRL lane; the arming is retired only
/// after that lane accepts the marker, so immediate carrier refusal can retry.
pub(crate) async fn send_resume_repair_end_if_complete(
    peers: &mut PeerMap,
    peer_id: &str,
    now_ms: f64,
) {
    let Some(peer) = peers.get_mut(peer_id) else {
        return;
    };
    if !peer.authenticated {
        return;
    }
    if peer.display_cache.resume_repair_requires_snapshot() {
        warn!(
            "resume repair membership overflow, replacing with snapshot: peer={} generation={}",
            peer.peer_id, peer.generation,
        );
        peer.display_cache.abandon_resume_repair();
        peer.needs_snapshot = true;
        return;
    }
    let Some((repair_id, repair_members)) = peer.display_cache.completed_resume_repair() else {
        return;
    };
    let generation = peer.generation;
    const CTRL_PROTO_HEADER: usize = 4;
    const FIXED_BODY_BYTES: usize = 10;
    const MEMBER_BYTES: usize = 6;
    let body_len = FIXED_BODY_BYTES + repair_members.len().saturating_mul(MEMBER_BYTES);
    let mut payload: Vec<u8> = Vec::with_capacity(CTRL_PROTO_HEADER + body_len);
    payload.push(MSG_TYPE_DISPLAY_REPAIR_END);
    let body_len_u32 = u32::try_from(body_len).unwrap_or(0);
    payload.push(((body_len_u32 >> 16) & 0xff) as u8);
    payload.push(((body_len_u32 >> 8) & 0xff) as u8);
    payload.push((body_len_u32 & 0xff) as u8);
    payload.extend_from_slice(&generation.to_be_bytes());
    payload.extend_from_slice(&repair_id.to_be_bytes());
    payload.extend_from_slice(&(repair_members.len() as u16).to_be_bytes());
    for member in repair_members {
        payload.extend_from_slice(&member.row.to_be_bytes());
        payload.extend_from_slice(&member.minimum_seq.to_be_bytes());
    }
    let Some(payload) = peer.seal_stream(CHANNEL_CTRL, &payload) else {
        return;
    };
    let primary = peer.primary_path(now_ms);
    let edge = peer.edge_tunnel.clone();
    let sent_path = transport_send_reliable_with_fallback(
        &mut peer.paths,
        primary,
        CHANNEL_CTRL,
        ReliablePayload::Heap(payload),
        peer.direct_session.as_ref(),
        edge.as_ref(),
        now_ms,
    );
    if sent_path.is_some() {
        peer.display_cache.finish_resume_repair_marker();
    }
}

pub(crate) async fn send_heartbeat_if_due(
    peers: &mut PeerMap,
    peer_id: &str,
    current_row_hashes: &[u64],
    now_ms: f64,
) {
    let Some(peer) = peers.get_mut(peer_id) else {
        return;
    };
    if !peer.authenticated || !peer.display_cache.initialized {
        return;
    }
    if peer.needs_snapshot {
        return;
    }
    let due = peer.display_cache.heartbeat_frames_since_last
        >= DisplayPolicy::HEARTBEAT_FRAME_INTERVAL
        || (peer.display_cache.heartbeat_last_sent_ms > 0.0
            && now_ms - peer.display_cache.heartbeat_last_sent_ms
                >= DisplayPolicy::HEARTBEAT_TIME_INTERVAL_MS)
        || peer.display_cache.heartbeat_last_sent_ms == 0.0;
    if !due {
        return;
    }
    let row_limit = current_row_hashes
        .len()
        .min(peer.display_cache.sent_row_hashes.len())
        .min(peer.display_cache.sent_row_first_sent_at_ms.len());
    let rows = (0..row_limit)
        .filter(|&row| display_hash_digest_row_is_ready(peer, row, current_row_hashes[row], now_ms))
        .count();
    if rows == 0 {
        // Keep the heartbeat due. A send/ACK/expiry edge will make at least one
        // row coherent; identical resends cannot starve this forever because
        // readiness is bounded by the first-send timestamp.
        return;
    }
    let generation = peer.generation;
    // Advertise the highest seq actually handed to a transport, NOT
    // `next_datagram_seq - 1`: a failed send consumes a seq that will never
    // reach the client, and advertising it wedges the client's digest gate
    // (`upToSeq > maxApplied` forever) — disabling the divergence backstop
    // exactly when a loss just happened.
    let up_to_seq = peer.last_display_seq_sent;
    // CTRL frame layout matches @merkur/protocol: [msg_type:1, length_be24:3, body…]
    const CTRL_PROTO_HEADER: usize = 4;
    let body_len = 4 + 4 + 2 + rows.saturating_mul(2 + 8);
    let mut payload: Vec<u8> = Vec::with_capacity(CTRL_PROTO_HEADER + body_len);
    payload.push(MSG_TYPE_DISPLAY_HASH_DIGEST);
    let body_len_u32 = u32::try_from(body_len).unwrap_or(0);
    payload.push(((body_len_u32 >> 16) & 0xff) as u8);
    payload.push(((body_len_u32 >> 8) & 0xff) as u8);
    payload.push((body_len_u32 & 0xff) as u8);
    payload.extend_from_slice(&generation.to_be_bytes());
    payload.extend_from_slice(&up_to_seq.to_be_bytes());
    payload.extend_from_slice(&(rows as u16).to_be_bytes());
    for (row, &hash) in current_row_hashes.iter().take(row_limit).enumerate() {
        if !display_hash_digest_row_is_ready(peer, row, hash, now_ms) {
            continue;
        }
        payload.extend_from_slice(&(row as u16).to_be_bytes());
        payload.extend_from_slice(&hash.to_be_bytes());
    }
    debug_assert_eq!(payload.len(), CTRL_PROTO_HEADER + body_len);
    // Display hash-digest heartbeat is a post-E2E CTRL frame on the reliable
    // stream: seal on the CTRL stream lane. If E2E is not yet established the
    // seal returns None and we skip — an unsealed CTRL frame would be dropped by
    // the browser (it opens every terminal frame), so there is nothing to send.
    let Some(payload) = peer.seal_stream(CHANNEL_CTRL, &payload) else {
        return;
    };
    let primary = peer.primary_path(now_ms);
    let edge = peer.edge_tunnel.clone();

    // Display hash-digest heartbeat: reliable CTRL channel of the lower-RTT live
    // path. Small, infrequent; a single-path send is the right call. Routed through
    // the reliable selected-carrier helper so immediate queue rejection falls
    // through once without cloning or re-sealing the ciphertext.
    let sent = transport_send_reliable_with_fallback(
        &mut peer.paths,
        primary,
        CHANNEL_CTRL,
        ReliablePayload::Heap(payload),
        peer.direct_session.as_ref(),
        edge.as_ref(),
        now_ms,
    );
    if sent.is_some() {
        peer.display_cache.heartbeat_frames_since_last = 0;
        peer.display_cache.heartbeat_last_sent_ms = now_ms;
    }
}

pub(crate) async fn handle_heartbeat_ping(msg: &PeerMessage, body: &[u8], peers: &mut PeerMap) {
    let timestamp = u64::from_be_bytes([
        body[0], body[1], body[2], body[3], body[4], body[5], body[6], body[7],
    ]);
    // The inbound PING was opened at the dispatch gate, so the peer is E2E-ready
    // here (a pre-E2E PING would have been dropped before this handler ran).
    // Fetch the peer mutably up front: the PONG echo must be sealed, and the
    // same borrow records the liveness evidence.
    let Some(peer) = peers.get_mut(&*msg.peer_node_id) else {
        return;
    };
    // Echo the PONG on the SAME path the PING arrived on — never a fanout. This
    // is how the originator attributes RTT to the correct path, and the browser
    // seals its own ping once per provider precisely so each path is measured by
    // its own round trip. The echo goes out twice on that one path, once per
    // Noise sub-lane, because the two lanes answer two different questions.
    send_pong_datagram(peer, msg, timestamp);
    send_pong_twin(peer, msg, timestamp);
    // The PING arrival proves the DOWNLINK only — it is the browser's frame,
    // not an answer to ours. The PONG we just echoed is what the browser will
    // credit; our own clock advances on `handle_heartbeat_pong`.
    peer.paths
        .get_mut(msg.via_transport)
        .record_inbound_activity();
}

/// The liveness probe an `input_run` carried, as its lane handler left it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InputProbe {
    pub(crate) token: u64,
    /// This emit's input ACK follows promptly: the PTY writer had nothing
    /// outstanding when the run arrived and took every entry of it. That ACK —
    /// datagram and reliable twin — proves the round trip whatever becomes of
    /// the pong. False for a reorder gap, a refusal, retained reliable input, or
    /// a writer still busy with earlier writes (a stopped foreground process
    /// holds them), where no ACK can be promised.
    pub(crate) ack_follows: bool,
}

/// Answer the liveness probe an `input_run` carried, on the carrier that
/// delivered it, after its entries were offered to the PTY.
///
/// The browser arms its pong deadline on the emit that carried the token, and
/// either the pong or the input ACK for that emit retracts it: the ladder is
/// session-level, so an ACK on any carrier is proof. What is sent therefore
/// depends on whether an ACK is coming:
///
/// - Datagram arrival: the PONG datagram, the per-path RTT sample. Its reliable
///   CTRL twin only when no ACK follows promptly (see `InputProbe::ack_follows`),
///   which is when nothing else would cover a lost datagram pong.
/// - Stream arrival: nothing when the ACK follows (it is the proof, and a
///   datagram copy may still arrive to be sampled); otherwise the reliable CTRL
///   pong alone, which is proof and never a sample.
///
/// One case stays uncovered: the writer was idle and took the run, but this
/// very write is the first to block on a full kernel input queue, and the pong
/// datagram is lost. The browser's deadline lapses once, its standby dial
/// starts, and the ladder's CTRL probe — never permit- or PTY-gated — answers
/// and retires it. No eviction: that needs two unanswered round trips.
///
/// Each carrier answers a token once, so a reliable copy behind an answered
/// datagram is silent. Tokens only grow within a Noise session.
pub(crate) fn answer_input_probe(msg: &PeerMessage, probe: InputProbe, peers: &mut PeerMap) {
    let Some(peer) = peers.get_mut(&*msg.peer_node_id) else {
        return;
    };
    if peer
        .paths
        .get(msg.via_transport)
        .answered_input_probe
        .is_some_and(|answered| probe.token <= answered)
    {
        return;
    }
    match msg.delivery {
        DeliveryMode::Datagram => {
            send_pong_datagram(peer, msg, probe.token);
            if !probe.ack_follows {
                send_pong_twin(peer, msg, probe.token);
            }
        }
        DeliveryMode::Stream => {
            if probe.ack_follows {
                return;
            }
            send_pong_twin(peer, msg, probe.token);
        }
    }
    peer.paths.get_mut(msg.via_transport).answered_input_probe = Some(probe.token);
}

/// `[type][len:u24][echoed timestamp:u64][monotonic µs:u64]`, the whole pong
/// frame, which is why it is built on the stack rather than through
/// [`encode_proto_frame`].
const PONG_FRAME_BYTES: usize = PROTO_HEADER_BYTES + 16;

fn pong_frame(timestamp: u64) -> [u8; PONG_FRAME_BYTES] {
    let mut frame = [0; PONG_FRAME_BYTES];
    frame[0] = MSG_TYPE_HEARTBEAT_PONG;
    frame[3] = 16;
    frame[4..12].copy_from_slice(&timestamp.to_be_bytes());
    frame[12..].copy_from_slice(&merkur_graphics::animation::monotonic_us().to_be_bytes());
    frame
}

/// The DATAGRAM echo is the RTT sample. Nothing retransmits it and no
/// application queue sits ahead of it, so it measures the network and nothing
/// else. The browser opens it by delivery mode (openDatagram on CTRL's datagram
/// sub-lane).
fn send_pong_datagram(peer: &mut PeerDisplayState, msg: &PeerMessage, timestamp: u64) {
    let Some(wire) = peer.seal_control_wire(CHANNEL_CTRL, &pong_frame(timestamp)) else {
        return;
    };
    transport_send_datagram(
        msg.via_transport,
        &wire,
        peer.direct_session.as_ref(),
        peer.edge_tunnel.as_ref(),
    );
}

/// The reliable CTRL twin is LIVENESS proof, not a sample. The browser arms a
/// one-RTO pong deadline, and a dropped datagram pong is indistinguishable there
/// from a dead uplink: a single lost echo escalated to the probe ladder and —
/// with a warm standby held — evicted a healthy carrier (187 lapsed deadlines a
/// day in production, on carriers still delivering input ACKs and display
/// frames). With the twin, a lost datagram pong becomes a LATE pong instead of a
/// missing one. Receiving both is harmless by construction: the browser calls
/// `recordPongProof` (idempotent probe cancellation) on every pong and
/// `resolvePongRtt` dedups per (timestamp, path), so the second copy contributes
/// no second RTT sample. Sealed separately because Noise nonces are per
/// sub-lane; the ciphertext cannot be shared.
///
/// Admitted on the EXACT arriving carrier, with no fallback: a refused queue
/// costs this one twin and nothing else. Falling through to the other path
/// would answer on a carrier that never carried this ping, and the browser
/// dedups its RTT sample per (timestamp, path) — so the echo would spend the
/// other path's slot for this timestamp on THIS path's latency, and the sample
/// that primary-path selection compares would be attributed to the wrong
/// carrier.
///
/// The admission outcome is deliberately NOT accounted against path health, in
/// either direction. `record_inbound_activity()` owns this path's health for a
/// ping: the PING itself is the evidence, and it just proved the downlink. A
/// refused twin is ordinary local backpressure on a shared reliable queue — the
/// same category `transport_try_send_maintenance_reliable_with_fallback`
/// documents as not-a-path-failure — so charging it toward
/// `PATH_SEND_FAILURE_THRESHOLD` would let a CTRL queue that is merely full
/// during bulk output mark a live carrier unavailable, and crediting the
/// success would zero a display path's genuine failure count with a probe that
/// proves nothing about it.
fn send_pong_twin(peer: &mut PeerDisplayState, msg: &PeerMessage, timestamp: u64) {
    let Some(sealed) = peer.seal_stream(CHANNEL_CTRL, &pong_frame(timestamp)) else {
        return;
    };
    let _ = transport_send_recoverable(
        msg.via_transport,
        CHANNEL_CTRL,
        ReliablePayload::Heap(sealed),
        peer.direct_session.as_ref(),
        peer.edge_tunnel.as_ref(),
    );
}

/// RTT of a heartbeat round-trip: the PONG echoes the PING's unix-epoch-ms
/// send timestamp, which this daemon stamped — same clock, no peer-clock
/// trust needed. Returns None for nonsense samples (clock stepped backwards,
/// or an echo so old the path was already considered stale).
pub(crate) fn pong_rtt_sample_ms(echoed_unix_ms: u64, now_unix_ms: u64) -> Option<f64> {
    if now_unix_ms < echoed_unix_ms {
        return None;
    }
    let rtt_ms = (now_unix_ms - echoed_unix_ms) as f64;
    if rtt_ms > SessionPolicy::PATH_STALE_THRESHOLD_MS {
        return None;
    }
    Some(rtt_ms.max(1.0))
}

pub(crate) fn handle_heartbeat_pong(
    msg: &PeerMessage,
    body: &[u8],
    peers: &mut PeerMap,
    start_instant: Instant,
) {
    if let Some(peer) = peers.get_mut(&*msg.peer_node_id) {
        let path = peer.paths.get_mut(msg.via_transport);
        path.record_authenticated_activity(now_ms_since(start_instant));
        // The client replies on the same path the PING arrived, so this is
        // a correctly-attributed per-path RTT sample. It keeps a path's
        // EWMA honest even when it carries no display traffic (and hence
        // gets no ACK-driven samples), so primary-path selection compares real numbers
        // instead of a frozen baseline.
        let echoed_unix_ms = u64::from_be_bytes([
            body[0], body[1], body[2], body[3], body[4], body[5], body[6], body[7],
        ]);
        let now_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if let Some(rtt_sample_ms) = pong_rtt_sample_ms(echoed_unix_ms, now_unix_ms) {
            path.record_rtt_sample(rtt_sample_ms);
            // Heartbeat PONG = pure network round-trip (no frame apply latency).
            // Feed the network-only EWMA that the datagram rate-limiter reads.
            path.record_network_rtt_sample(rtt_sample_ms);
        }
    }
}

/// One tick of the daemon heartbeat: prune stale pending WT upgrades,
/// send per-path pings, sweep stale paths, evict dead peers, and enforce
/// auth timeouts. Extracted verbatim from the run-loop select arm.
fn path_heartbeat_due(path: &crate::connection::PathHealth, now_ms: f64) -> bool {
    if path.heartbeat_probe_requested {
        return true;
    }
    if !path.available {
        return false;
    }
    let since_ping = now_ms - path.last_heartbeat_sent_ms;
    if since_ping >= SessionPolicy::PATH_HEARTBEAT_INTERVAL_MS {
        return true;
    }
    let rto = SessionPolicy::rto_ms(path.rtt_ewma_ms, path.jitter_ewma_ms);
    let suspect = path.last_ack_at_ms > 0.0
        && (now_ms - path.last_ack_at_ms)
            > SessionPolicy::path_suspect_after_ms(rto, now_ms, path.oldest_unanswered_send_ms);
    suspect && since_ping >= SessionPolicy::HEARTBEAT_TICK_MS as f64
}

/// What to do about a peer whose browser has left the splice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CounterpartDetachAction {
    /// A direct WebTransport carrier still owns this peer; the edge is a
    /// redundant path and nothing changes.
    Ignore,
    /// Hold the edge tunnel and the peer's state for a returning browser.
    Rebind,
    /// Preserve display state for a full fresh authentication, but give up the
    /// tunnel. This is the behaviour every reconnect had before rebind existed,
    /// and every abandoned rebind lands back on it.
    Park,
    /// Nothing worth preserving: no authenticated session or no display cache.
    Retire,
}

/// Decide how a browser departure should be handled for one peer.
pub(crate) fn classify_counterpart_detach(
    peer: &PeerDisplayState,
    _now_ms: f64,
) -> CounterpartDetachAction {
    if peer.paths.webtransport.available {
        return CounterpartDetachAction::Ignore;
    }
    if !peer.authenticated || !peer.display_cache.initialized {
        return CounterpartDetachAction::Retire;
    }
    if peer.rebind.is_none() {
        return CounterpartDetachAction::Park;
    }
    // Retention is a resource window, independent of authorization. An expired
    // epoch may be renewed on this signaling lane; it still cannot admit a rebind.
    CounterpartDetachAction::Rebind
}

/// Converge each peer's rebind window against what the edge reports about its
/// browser half.
///
/// Reconciliation rather than event delivery is deliberate. The pairing signal
/// is a latest-value cell on the tunnel, so a lost or delayed notification
/// degrades to a tick of latency instead of a peer stuck in a window nobody
/// disarms — or worse, one holding a tunnel forever because the arming event
/// never landed. Arming late is harmless: the browser is already gone, the
/// tunnel is quiesced, and it is the browser's own rebind request that drives
/// recovery.
fn reconcile_rebind_windows(peers: &mut PeerMap, now_ms: f64) {
    for (peer_id, peer) in peers.iter_mut() {
        let Some(tunnel) = peer.edge_tunnel.as_ref() else {
            // No tunnel to reconcile against — but an armed window is NOT
            // stale here. `handle_edge_lane_closed` arms one when the daemon
            // loses its own tunnel, and that window is satisfied by the redial
            // re-attaching under the same routing label, not by a tunnel we
            // already hold. Clearing it was what made the park guard below
            // unreachable on exactly the path it exists for: both paths go
            // unavailable, the peer parks, and the Noise session and rebind
            // lineage are destroyed for a gap the redial was about to close.
            // Only the deadline closes a window.
            continue;
        };
        match tunnel.counterpart_state() {
            // Still waiting for its first browser. Nothing to reconcile.
            crate::edge_tunnel::CounterpartState::Pending => {}
            crate::edge_tunnel::CounterpartState::Attached { .. } => {
                // Deliberately does NOT disarm the window. A peer attaching at
                // the edge is unauthenticated — the edge is a routing layer,
                // not an authentication boundary, and anyone who learns a
                // session id can produce this signal. Disarming here would also
                // race the legitimate browser: its rebind request arrives on
                // the very carrier that produced this event, and admission
                // requires the window to still be armed. Only a proven rebind
                // or the deadline closes it.
            }
            crate::edge_tunnel::CounterpartState::Detached {
                rebind_window_remaining_ms,
            } => {
                if peer.is_rebinding() {
                    continue;
                }
                if classify_counterpart_detach(peer, now_ms) != CounterpartDetachAction::Rebind {
                    // Park and Retire are driven by the ordinary lane-close and
                    // liveness paths; nothing to arm here.
                    continue;
                }
                // Land inside the edge's own half-paired expiry so the daemon
                // gives up first and the slot empties cleanly, rather than
                // racing the edge's prune. One tick of slack covers the up-to-a-
                // tick delay in observing the transition.
                let window_ms = (rebind_window_remaining_ms as f64)
                    .min(SessionPolicy::REBIND_WINDOW_MS as f64)
                    - SessionPolicy::HEARTBEAT_TICK_MS as f64;
                let rebinds_used = peer
                    .edge_rebind
                    .map_or(peer.rebind.as_ref().map_or(0, |state| state.counter), |w| {
                        w.rebinds_used
                    });
                peer.paths.edge.available = false;
                peer.edge_rebind = Some(crate::connection::EdgeRebindWindow {
                    deadline_ms: now_ms + window_ms.max(0.0),
                    rebinds_used,
                });
                info!(
                    peer = &**peer_id,
                    "browser detached; holding edge tunnel for rebind"
                );
            }
        }
    }
}

pub(crate) async fn heartbeat_tick(
    peers: &mut PeerMap,
    wt_upgrade_pending: &mut HashMap<String, WtUpgradePending>,
    parked: &mut ParkedPeers,
    _daemon_identity: &Option<DaemonIdentity>,
    network_state: &Arc<RwLock<NetworkState>>,
    event_tx: &EventSink,
    rebind_telemetry: &mut crate::session::rebind_flow::RebindTelemetry,
    current_row_hashes: &[u64],
    start_instant: Instant,
) -> Vec<Arc<str>> {
    let now_ms = now_ms_since(start_instant);
    {
        let network = network_state.read().await;
        const PING: &[u8] = br#"{"type":"signaling_ping"}"#;
        let mut ping = [0; crate::network::peer::INLINE_RELIABLE_PAYLOAD_BYTES];
        ping[..PING.len()].copy_from_slice(PING);
        for tunnel in network.edge_signaling.values() {
            // The QUIC PING keeps the durable daemon leg alive even while its
            // browser counterpart is absent. The signaling record covers the
            // separate edge/browser leg without a browser keepalive timer.
            tunnel.heartbeat_signaling();
            let _ = tunnel.send_reliable(
                crate::network::protocol::CHANNEL_SIGNALING,
                ReliablePayload::inline(PING.len(), ping),
            );
        }
    }
    wt_upgrade_pending.retain(|_, p| now_ms - p.issued_at_ms <= WT_UPGRADE_PENDING_TTL_MS);
    reconcile_rebind_windows(peers, now_ms);
    // Refill before expiring, so an expiry storm inside one tick is bounded by
    // this tick's budget rather than the previous one's remainder.
    rebind_telemetry.refill();
    crate::session::rebind_flow::expire_stale_rebind_attempts(peers, rebind_telemetry, now_ms);
    // The run-loop drains ParkedPeers' removal notifications before selecting
    // another event and retires every carrier owned by the expired identities.
    let _expired_peer_ids = parked.prune(now_ms);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    // One plaintext PING template per tick, `[type][len:u24][timestamp:u64]`;
    // sealed per-peer below (each peer's Noise transport owns its own nonce
    // counters, so the ciphertext differs per peer).
    let mut ping = [0; PROTO_HEADER_BYTES + 8];
    ping[0] = MSG_TYPE_HEARTBEAT_PING;
    ping[3] = 8;
    ping[4..].copy_from_slice(&timestamp.to_be_bytes());

    // Per-path heartbeat: each available path on each peer gets its
    // own ping cadence. PONG attribution (via PeerMessage.via_transport)
    // updates `path.last_ack_at_ms`, which gates `is_live()`.
    //
    // A path is pinged on its steady cadence — or, once suspect (quiet past
    // one heartbeat + one RTO), on every tick, which is the probe escalation:
    // probes at max(RTO, tick) spacing until the path answers or the dead
    // threshold (suspect point + full probe budget) passes.
    for peer in peers.values_mut().filter(|peer| peer.authenticated) {
        // Both verdicts come from the state the tick found, before either send.
        let wt_due = path_heartbeat_due(&peer.paths.webtransport, now_ms);
        let edge_due = path_heartbeat_due(&peer.paths.edge, now_ms);
        if wt_due {
            // Direct-WT heartbeats ride the CTRL DATAGRAM lane, like the
            // datagram half of the PONG echo in handle_heartbeat_ping.
            // Persistent reliable channels are stream-isolated, but the datagram
            // still avoids reliable retransmission and application-queue delay.
            // A dropped 16-byte ping is covered by the next one — deliberately
            // NOT the reliable twin the browser's PING gets, because losing this
            // one costs the daemon a sample, while losing that one costs the
            // browser a carrier. (The earlier rationale for using the stream
            // lane — iOS Safari datagram shallowness — does not apply to a tiny
            // periodic probe; display deltas already ride datagrams.)
            peer.paths.webtransport.heartbeat_probe_requested = false;
            if let Some(wire) = peer.seal_control_wire(CHANNEL_CTRL, &ping) {
                transport_send_datagram(
                    PeerTransport::WebTransport,
                    &wire,
                    peer.direct_session.as_ref(),
                    None,
                );
                peer.paths.webtransport.last_heartbeat_sent_ms = now_ms;
                peer.paths.webtransport.note_unanswered_send(now_ms);
            }
        }
        if edge_due {
            peer.paths.edge.heartbeat_probe_requested = false;
            if let Some(wire) = peer.seal_control_wire(CHANNEL_CTRL, &ping) {
                transport_send_datagram(
                    PeerTransport::Edge,
                    &wire,
                    peer.direct_session.as_ref(),
                    peer.edge_tunnel.as_ref(),
                );
                peer.paths.edge.last_heartbeat_sent_ms = now_ms;
                peer.paths.edge.note_unanswered_send(now_ms);
            }
        }
    }

    // Liveness sweep: a path quiet past its derived dead threshold
    // (suspect point + full probe budget at probe spacing) is marked
    // unavailable. Peers with all paths down are PARKED, not dropped —
    // their display cache and sequence state remain available for a bounded
    // fresh-auth reconnect window.
    let path_dead = |path: &crate::connection::PathHealth| -> bool {
        let rto = SessionPolicy::rto_ms(path.rtt_ewma_ms, path.jitter_ewma_ms);
        path.available
            && path.last_ack_at_ms > 0.0
            && (now_ms - path.last_ack_at_ms)
                > SessionPolicy::path_dead_after_ms(rto, now_ms, path.oldest_unanswered_send_ms)
    };
    let mut timed_out_peers: Vec<Arc<str>> = Vec::new();
    for (peer_id, peer) in peers.iter_mut() {
        if !peer.authenticated {
            continue;
        }
        // A peer holding its edge tunnel for a returning browser has both paths
        // unavailable by construction, which is exactly the predicate below.
        // Without this guard the very next tick would park it and destroy the
        // rebind lineage — silently turning every fast reconnect back into a
        // full one. The window's own deadline is this peer's liveness clock
        // while it is armed.
        if let Some(window) = peer.edge_rebind {
            if now_ms >= window.deadline_ms {
                warn!("rebind window elapsed, parking for resume: {peer_id}");
                timed_out_peers.push(Arc::clone(peer_id));
            }
            continue;
        }
        if path_dead(&peer.paths.webtransport) {
            warn!(
                "path dead: peer={} transport=WebTransport last_ack_age_ms={:.1}",
                peer_id,
                now_ms - peer.paths.webtransport.last_ack_at_ms
            );
            peer.paths.webtransport.available = false;
        }
        if path_dead(&peer.paths.edge) {
            warn!(
                "path dead: peer={} transport=Edge last_ack_age_ms={:.1}",
                peer_id,
                now_ms - peer.paths.edge.last_ack_at_ms
            );
            peer.paths.edge.available = false;
        }
        let network = network_state.read().await;
        let signaling = network.edge_signaling.get(peer_id.as_ref());
        let relay_paused = signaling.is_some_and(|tunnel| tunnel.relay_data_is_paused());
        // The final flight retires the predecessor data paths before the
        // successor's HELLO. Until that rendezvous completes, signaling owns
        // the attachment. Its registry retirement is the failure signal; the
        // predecessor's detached pairing can still be visible during promotion.
        peer.data_rendezvous_pending &= signaling.is_some();
        let rendezvous_pending = peer.data_rendezvous_pending;
        drop(network);
        if rendezvous_pending {
            continue;
        }
        if !peer.paths.webtransport.available && !peer.paths.edge.available && !relay_paused {
            // Both paths quiet is not the end of the session. A peer whose
            // browser is still out there and whose lineage is still valid is
            // precisely the case a carrier gap exists for — and parking it here
            // runs `clear_rebind_material`, destroying the chaining secret and
            // the Noise session SECONDS BEFORE quinn's idle timer would have
            // closed the tunnel and triggered the redial that repairs it.
            //
            // Nothing else arms the window on this path. `handle_edge_lane_closed`
            // needs a tunnel that has actually closed, and `reconcile_rebind_windows`
            // needs the edge to report `CounterpartDetached` — neither happens
            // when the daemon's own leg is silently blackholed. So this sweep was
            // the one place the lineage died and the one place that never asked
            // whether it was worth keeping.
            match classify_counterpart_detach(peer, now_ms) {
                CounterpartDetachAction::Rebind => {
                    warn!("peer all paths down, holding carrier gap for rebind: {peer_id}");
                    peer.edge_rebind = Some(crate::connection::EdgeRebindWindow {
                        deadline_ms: now_ms + SessionPolicy::carrier_gap_window_ms(),
                        rebinds_used: peer.rebind.as_ref().map_or(0, |state| state.counter),
                    });
                    // Closed, NOT taken: the tunnel's bridge task is awaiting
                    // exactly this, and the `EdgeLaneClosed` it publishes is what
                    // drives the redial and the rest of the lane-close accounting.
                    // Taking the Arc here would leave `handle_edge_lane_closed`
                    // with no owning peer, so it would request no dial at all.
                    if let Some(tunnel) = peer.edge_tunnel.as_ref() {
                        tunnel.close();
                    }
                }
                // `Ignore` is unreachable here — it requires an available direct
                // path, and this branch is the negation of that — but it belongs
                // with the outcomes that keep today's behaviour rather than with
                // the one that changes it.
                CounterpartDetachAction::Ignore
                | CounterpartDetachAction::Park
                | CounterpartDetachAction::Retire => {
                    warn!("peer all paths down, parking for resume: {peer_id}");
                    timed_out_peers.push(Arc::clone(peer_id));
                }
            }
        }
    }
    let mut evicted_peer_ids: Vec<Arc<str>> = Vec::new();
    for peer_id in timed_out_peers {
        if let Some(state) = peers.remove(&peer_id) {
            park_disconnected_peer(parked, state, now_ms);
        }
        crate::network::remove_edge_connections(network_state, &peer_id).await;
        send_json_event(
            event_tx,
            EVT_PEER_DISCONNECTED,
            &PeerDisconnectedEvt {
                peer_node_id: peer_id.to_string(),
                reason: "heartbeat timeout".to_string(),
            },
        );
        evicted_peer_ids.push(peer_id);
    }

    // Auth timeout check
    let timed_out: Vec<Arc<str>> = peers
        .iter()
        .filter(|(_, p)| {
            if let Some(timeout) = p.auth_timeout_at_ms {
                p.noise.is_none() && now_ms > timeout
            } else {
                false
            }
        })
        .map(|(id, _)| Arc::clone(id))
        .collect();
    for peer_id in timed_out {
        warn!("auth timeout for peer: {peer_id}");
        if let Some(mut peer) = peers.remove(&peer_id) {
            if let Some(tunnel) = peer.edge_tunnel.take() {
                tunnel.close();
            }
            if let Some(tunnel) = peer.edge_tunnel_bulk.take() {
                tunnel.close();
            }
        }
        crate::network::remove_edge_connections(network_state, &peer_id).await;
        evicted_peer_ids.push(peer_id);
    }

    // The display hash digest is otherwise emitted only from the tail of the
    // per-peer loop inside `flush_display`. A quiet, fully acknowledged peer
    // leaves both display-scheduling predicates false, so the owner loop parks
    // its flush timer and that call site is never reached again — leaving the
    // divergence backstop unreachable in exactly the state it exists to
    // protect. Riding the tick that is already running gives it a wake path
    // without adding a timer to a loop that deliberately has three, and
    // `current_row_hashes` is the vector `update_hashes_for_dirty_rows` keeps
    // current, so a quiet terminal pays no re-hash either.
    //
    // This runs last: the sweeps above have already removed every peer that was
    // parked or timed out this tick, so a digest is never sealed for a peer the
    // same tick decided to retire. Everything else that must not fire is
    // already gated inside `send_heartbeat_if_due` — the `rows == 0` return
    // there is what keeps a settled session emitting nothing at all.
    let digest_peer_ids: Vec<Arc<str>> = peers.keys().cloned().collect();
    for peer_id in digest_peer_ids {
        send_heartbeat_if_due(peers, &peer_id, current_row_hashes, now_ms).await;
    }

    evicted_peer_ids
}

#[cfg(test)]
pub(crate) fn reconcile_rebind_windows_for_test(peers: &mut PeerMap, now_ms: f64) {
    reconcile_rebind_windows(peers, now_ms);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{PathHealth, SentRow};
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn resume_repair_marker_retries_seal_and_carrier_refusal_then_sends_exact_membership() {
        const PEER_ID: &str = "repair-browser";
        const REPAIR_SEQ: u32 = 0xffff_fffe;
        let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.needs_snapshot = false;
        peer.display_cache.resize(1, 1);
        peer.display_cache.initialized = true;
        const REPAIR_ID: u32 = 19;
        assert!(peer.display_cache.begin_resume_repair(REPAIR_ID, &[0]));
        let row = SentRow {
            graphics: None,
            row: 0,
            hash: 0xfeed,
            cells: Arc::from(vec![merkur_codec::CellRepr::BLANK]),
        };
        peer.display_cache.record_sent_rows(
            REPAIR_SEQ,
            std::slice::from_ref(&row),
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);

        // No Noise transport yet: sealing fails, and completion must remain
        // armed rather than being consumed before the bytes exist.
        send_resume_repair_end_if_complete(&mut peers, PEER_ID, 1.0).await;
        assert_eq!(
            peers[PEER_ID].display_cache.completed_resume_repair(),
            Some((
                REPAIR_ID,
                &[crate::connection::ResumeRepairMember {
                    row: 0,
                    minimum_seq: REPAIR_SEQ,
                }][..]
            ))
        );

        let psk = [0x11u8; 32];
        let prologue = crate::e2e::derive_prologue("repair-marker-test", PEER_ID, &[0x42; 64]);
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
        let mut browser = initiator.into_transport().expect("browser transport");
        peers.get_mut(PEER_ID).expect("peer").noise =
            Some(responder.into_transport().expect("daemon transport"));

        // Sealing now succeeds, but neither carrier admits the record. The
        // exact same completion remains pending for a later healthy carrier.
        send_resume_repair_end_if_complete(&mut peers, PEER_ID, 2.0).await;
        assert_eq!(
            peers[PEER_ID].display_cache.completed_resume_repair(),
            Some((
                REPAIR_ID,
                &[crate::connection::ResumeRepairMember {
                    row: 0,
                    minimum_seq: REPAIR_SEQ,
                }][..]
            ))
        );

        let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
        let peer = peers.get_mut(PEER_ID).expect("peer");
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
            capture_tx,
        )));
        peer.paths.edge = PathHealth::fresh_available(3.0);
        send_resume_repair_end_if_complete(&mut peers, PEER_ID, 3.0).await;
        assert!(
            peers[PEER_ID]
                .display_cache
                .completed_resume_repair()
                .is_none(),
            "only reliable carrier admission may retire marker ownership"
        );

        let (channel, sealed) = capture_rx.recv().await.expect("captured repair marker");
        assert_eq!(channel, CHANNEL_CTRL);
        let lane = crate::e2e::lane_for_channel(CHANNEL_CTRL).expect("ctrl lane");
        let plain = browser
            .open_stream(lane, &sealed)
            .expect("open repair marker");
        assert_eq!(plain[0], MSG_TYPE_DISPLAY_REPAIR_END);
        assert_eq!(&plain[1..4], &[0, 0, 16]);
        assert_eq!(u32::from_be_bytes(plain[4..8].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_be_bytes(plain[8..12].try_into().unwrap()),
            REPAIR_ID
        );
        assert_eq!(u16::from_be_bytes(plain[12..14].try_into().unwrap()), 1);
        assert_eq!(u16::from_be_bytes(plain[14..16].try_into().unwrap()), 0);
        assert_eq!(
            u32::from_be_bytes(plain[16..20].try_into().unwrap()),
            REPAIR_SEQ
        );
    }

    /// A quiet, fully acknowledged peer is still sent a hash digest.
    ///
    /// `send_heartbeat_if_due` used to have exactly one call site: the tail of
    /// the per-peer loop inside `flush_display`. That made the digest — which
    /// `display/recv.rs` calls "the ONLY loss signal that needs handling" —
    /// unreachable in the one state it exists to protect. Once a screen is quiet
    /// and every row is exactly acknowledged, `peer_has_runnable_display_work`
    /// goes false and `compute_next_flush_delay_ms` returns `None` (pinned by
    /// `an_unacked_row_stays_schedulable_and_becomes_runnable_at_its_deadline`),
    /// so the owner loop parks its flush timer and no flush ever runs again.
    ///
    /// This test drives the production `heartbeat_tick` rather than
    /// `send_heartbeat_if_due`, so deleting the call the tick makes fails it.
    /// The peer here has NO unacknowledged rows and no terminal damage: nothing
    /// but the tick can produce this frame.
    #[tokio::test(flavor = "current_thread")]
    async fn a_quiet_acknowledged_peer_is_sent_a_digest_by_the_heartbeat_tick() {
        const PEER_ID: &str = "quiet-browser";
        const ROW_HASH: u64 = 0xFEED_FACE_CAFE_BEEF;
        // The tick reads the clock as `now_ms_since(start_instant)`, so backdating
        // the epoch is how the row settles past DIGEST_ROW_SETTLE_MS without a
        // sleep. Everything below is expressed against this same origin.
        let now_ms = 5_000.0;
        assert!(
            now_ms > DisplayPolicy::DIGEST_ROW_SETTLE_MS,
            "the row must be able to settle, or this test proves nothing"
        );
        let start_instant = Instant::now() - Duration::from_millis(now_ms as u64);

        let psk = [0x11u8; 32];
        let prologue = crate::e2e::derive_prologue("liveness-test", PEER_ID, &[0x42; 64]);
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
        let mut browser = initiator.into_transport().expect("browser transport");

        let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(responder.into_transport().expect("daemon transport"));
        peer.needs_snapshot = false;
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
            capture_tx,
        )));
        // A live carrier that is neither due for a ping nor stale enough to be
        // swept: the only frame this tick may produce is the digest.
        peer.paths.edge = PathHealth::fresh_available(now_ms);
        peer.paths.edge.last_heartbeat_sent_ms = now_ms;
        peer.paths.edge.note_unanswered_send(now_ms);

        peer.display_cache.resize(1, 1);
        peer.display_cache.initialized = true;
        // The steady state after a settled flush: sent, acknowledged exactly,
        // and first sent long enough ago to be coverable.
        peer.display_cache.sent_row_hashes[0] = ROW_HASH;
        peer.display_cache.acked_row_hashes[0] = ROW_HASH;
        peer.display_cache.acked_row_exact[0] = true;
        peer.display_cache.sent_row_confirmed[0] = true;
        peer.display_cache.sent_row_first_sent_at_ms[0] = 0.0;
        assert!(
            !peer.display_cache.has_unacked_rows(),
            "a peer with an unconfirmed row is still scheduled, so it would be \
             woken by its re-send deadline and this test would not be about the \
             parked state at all"
        );

        let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);
        let mut wt_upgrade_pending = HashMap::new();
        let mut parked = ParkedPeers::new();
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let (event_tx, _event_output) = crate::ipc::events::test_event_sink();
        let mut rebind_telemetry =
            crate::session::rebind_flow::RebindTelemetry::new(event_tx.clone());

        let evicted = heartbeat_tick(
            &mut peers,
            &mut wt_upgrade_pending,
            &mut parked,
            &None,
            &network_state,
            &event_tx,
            &mut rebind_telemetry,
            &[ROW_HASH],
            start_instant,
        )
        .await;
        assert!(
            evicted.is_empty(),
            "the tick retired the peer instead of serving it"
        );

        // Open what actually reached the carrier. Anything the tick emits is
        // CHANNEL_CTRL, so identifying the digest means decrypting it: the
        // stream lane opens the digest and rejects a datagram-sealed ping.
        let lane = crate::e2e::lane_for_channel(CHANNEL_CTRL).expect("ctrl lane");
        let mut digests = 0usize;
        while let Ok((channel_id, bytes)) = capture_rx.try_recv() {
            if channel_id != CHANNEL_CTRL {
                continue;
            }
            if let Ok(plain) = browser.open_stream(lane, &bytes)
                && plain.first().copied() == Some(MSG_TYPE_DISPLAY_HASH_DIGEST)
            {
                digests += 1;
            }
        }
        assert_eq!(
            digests, 1,
            "the heartbeat tick sent no hash digest to a quiet acknowledged peer, \
             so the divergence backstop is unreachable in exactly the state it \
             exists to protect"
        );
    }

    /// One browser PING is answered on BOTH lanes of the arriving path, and on
    /// nothing else.
    ///
    /// The datagram echo is the RTT sample: nothing retransmits it and no
    /// application queue sits ahead of it, so it measures the network. The
    /// reliable CTRL twin is the liveness proof — the browser arms a one-RTO
    /// pong deadline it cannot distinguish from a dead uplink, so a single
    /// dropped datagram pong escalated to the probe ladder and evicted a healthy
    /// carrier. Deleting either send fails this test.
    ///
    /// The later phases pin the other half of the contract: the echo is
    /// path-scoped, never a fanout and never a fallback. The browser seals its
    /// own ping once per provider so each path is measured by its own round
    /// trip; answering a ping on a carrier that never delivered it would consume
    /// that ping's per-path dedup slot with another path's latency, and the
    /// sample primary-path selection compares would name the wrong carrier. A
    /// refused reliable queue therefore costs the twin and nothing more.
    #[tokio::test(flavor = "current_thread")]
    async fn a_ping_is_answered_on_both_lanes_of_the_arriving_path_and_no_other() {
        const PEER_ID: &str = "pinging-browser";
        let now_ms = 5_000.0;

        let psk = [0x11u8; 32];
        let prologue = crate::e2e::derive_prologue("ping-echo-test", PEER_ID, &[0x42; 64]);
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
        let mut browser = initiator.into_transport().expect("browser transport");

        let (edge_tx, mut edge_rx) = tokio::sync::mpsc::unbounded_channel();
        let (wt_datagram_tx, mut wt_datagram_rx) = tokio::sync::mpsc::unbounded_channel();
        let (wt_reliable_tx, mut wt_reliable_rx) = tokio::sync::mpsc::unbounded_channel();
        // BOTH carriers are live AND observable, so a fanout — or a reliable
        // record re-offered to the other path — has somewhere to land that this
        // test can see. Without the direct-WT captures, "nothing on the other
        // path" would be true of a fallback that simply had nowhere to go.
        let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(responder.into_transport().expect("daemon transport"));
        peer.direct_session = Some(direct_capture(PEER_ID, wt_datagram_tx, wt_reliable_tx));
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
            edge_tx,
        )));
        peer.paths.edge = PathHealth::fresh_available(now_ms);
        peer.paths.webtransport = PathHealth::fresh_available(now_ms);
        let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);

        let body = PING_TIMESTAMP.to_be_bytes();
        handle_heartbeat_ping(
            &ping_message(PEER_ID, PeerTransport::Edge),
            &body,
            &mut peers,
        )
        .await;

        let (datagram_pongs, stream_pongs) = count_pongs(&mut browser, drain_edge(&mut edge_rx));
        assert_eq!(
            datagram_pongs, 1,
            "the datagram echo is the RTT sample — exactly one, on the arriving path"
        );
        assert_eq!(
            stream_pongs, 1,
            "no reliable CTRL twin: a dropped datagram pong is once again \
             indistinguishable from a dead uplink, and one loss evicts the carrier"
        );
        assert_eq!(
            count_pongs(
                &mut browser,
                drain_direct(&mut wt_datagram_rx, &mut wt_reliable_rx)
            ),
            (0, 0),
            "an edge-delivered ping was also answered on the direct path"
        );

        // The mirror image: a ping that arrived on direct WT is answered there,
        // and the edge — equally live — stays silent.
        handle_heartbeat_ping(
            &ping_message(PEER_ID, PeerTransport::WebTransport),
            &body,
            &mut peers,
        )
        .await;

        assert_eq!(
            count_pongs(
                &mut browser,
                drain_direct(&mut wt_datagram_rx, &mut wt_reliable_rx)
            ),
            (1, 1),
            "a direct-WT ping must get both echoes on the direct path"
        );
        assert_eq!(
            count_pongs(&mut browser, drain_edge(&mut edge_rx)),
            (0, 0),
            "the edge carrier answered a ping that arrived on the direct WT path"
        );

        // The arriving carrier's reliable queue refuses. That costs the twin and
        // nothing else: the datagram echo is unaffected, and the refused record
        // is NOT re-offered to the live direct path, whose captures would show it.
        let (refusing_tx, mut refusing_rx) = tokio::sync::mpsc::unbounded_channel();
        let peer = peers.get_mut(PEER_ID).expect("peer");
        peer.edge_tunnel = Some(Arc::new(
            crate::edge_tunnel::EdgeTunnel::new_capture_with_reliable_limit(refusing_tx, 0),
        ));
        peer.paths.edge = PathHealth::fresh_available(now_ms);
        peer.paths.webtransport = PathHealth::fresh_available(now_ms);
        handle_heartbeat_ping(
            &ping_message(PEER_ID, PeerTransport::Edge),
            &body,
            &mut peers,
        )
        .await;

        let (datagram_pongs, stream_pongs) =
            count_pongs(&mut browser, drain_edge(&mut refusing_rx));
        assert_eq!(
            datagram_pongs, 1,
            "a refused reliable queue must not cost the datagram RTT sample"
        );
        assert_eq!(
            stream_pongs, 0,
            "the refused twin came back on the same carrier that just refused it"
        );
        assert_eq!(
            count_pongs(
                &mut browser,
                drain_direct(&mut wt_datagram_rx, &mut wt_reliable_rx)
            ),
            (0, 0),
            "the refused twin was re-offered to the other path, which would spend \
             this timestamp's per-path dedup slot on the wrong path's latency"
        );
        assert_eq!(
            count_pongs(&mut browser, drain_edge(&mut edge_rx)),
            (0, 0),
            "the refused twin reached the peer's previous carrier"
        );
    }

    /// A peer on both carriers, each captured, for the input-probe cases.
    struct ProbingPeer {
        browser: crate::e2e::NoiseTransport,
        peers: PeerMap,
        edge_rx: tokio::sync::mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
        wt_datagram_rx: tokio::sync::mpsc::UnboundedReceiver<(String, Vec<u8>)>,
        wt_reliable_rx: tokio::sync::mpsc::UnboundedReceiver<(u8, String, Vec<u8>)>,
    }

    fn probing_peer() -> ProbingPeer {
        const PEER_ID: &str = "probing-browser";
        let psk = [0x22u8; 32];
        let prologue = crate::e2e::derive_prologue("input-probe-test", PEER_ID, &[0x42; 64]);
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
        let browser = initiator.into_transport().expect("browser transport");
        let (edge_tx, edge_rx) = tokio::sync::mpsc::unbounded_channel();
        let (wt_datagram_tx, wt_datagram_rx) = tokio::sync::mpsc::unbounded_channel();
        let (wt_reliable_tx, wt_reliable_rx) = tokio::sync::mpsc::unbounded_channel();
        let now_ms = 5_000.0;
        let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(responder.into_transport().expect("daemon transport"));
        peer.direct_session = Some(direct_capture(PEER_ID, wt_datagram_tx, wt_reliable_tx));
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
            edge_tx,
        )));
        peer.paths.edge = PathHealth::fresh_available(now_ms);
        peer.paths.webtransport = PathHealth::fresh_available(now_ms);
        ProbingPeer {
            browser,
            peers: PeerMap::from([(PEER_ID.into(), peer)]),
            edge_rx,
            wt_datagram_rx,
            wt_reliable_rx,
        }
    }

    fn input_message(via: PeerTransport, delivery: DeliveryMode) -> PeerMessage {
        PeerMessage {
            channel_id: CHANNEL_PTY,
            delivery,
            ..ping_message("probing-browser", via)
        }
    }

    /// The pong for an input probe depends on whether an input ACK follows: that
    /// ACK covers a lost datagram pong, so such a run gets the datagram alone;
    /// any other run gets the reliable twin as well.
    #[tokio::test(flavor = "current_thread")]
    async fn a_datagram_probe_gets_its_twin_only_when_no_ack_is_coming() {
        let ProbingPeer {
            mut browser,
            mut peers,
            mut edge_rx,
            ..
        } = probing_peer();
        let datagram = input_message(PeerTransport::Edge, DeliveryMode::Datagram);

        let queued = InputProbe {
            token: PING_TIMESTAMP,
            ack_follows: true,
        };
        answer_input_probe(&datagram, queued, &mut peers);
        assert_eq!(
            count_pongs(&mut browser, drain_edge(&mut edge_rx)),
            (1, 0),
            "a queued run's ACK is the proof: the datagram pong is the sample and no twin"
        );

        let retained = InputProbe {
            token: PING_TIMESTAMP + 1,
            ack_follows: false,
        };
        answer_input_probe(&datagram, retained, &mut peers);
        assert_eq!(
            count_pongs_echoing(&mut browser, drain_edge(&mut edge_rx), PING_TIMESTAMP + 1),
            (1, 1),
            "no ACK is coming for a run the PTY did not take, so the twin rides too"
        );
    }

    /// A probe that rides the reliable copy is answered only when no ACK is
    /// coming, and then only reliably: a stream-delivered pong is proof and
    /// never an RTT sample, and a queued copy leaves the token for a datagram
    /// copy still in flight to be sampled.
    #[tokio::test(flavor = "current_thread")]
    async fn a_stream_probe_is_answered_reliably_and_only_when_no_ack_is_coming() {
        let ProbingPeer {
            mut browser,
            mut peers,
            mut edge_rx,
            ..
        } = probing_peer();
        let stream = input_message(PeerTransport::Edge, DeliveryMode::Stream);
        let datagram = input_message(PeerTransport::Edge, DeliveryMode::Datagram);
        let probe = |ack_follows| InputProbe {
            token: PING_TIMESTAMP,
            ack_follows,
        };

        answer_input_probe(&stream, probe(true), &mut peers);
        assert_eq!(count_pongs(&mut browser, drain_edge(&mut edge_rx)), (0, 0));
        answer_input_probe(&datagram, probe(true), &mut peers);
        assert_eq!(
            count_pongs(&mut browser, drain_edge(&mut edge_rx)),
            (1, 0),
            "the silent stream copy left the datagram copy its sample"
        );

        let retained = InputProbe {
            token: PING_TIMESTAMP + 1,
            ack_follows: false,
        };
        answer_input_probe(&stream, retained, &mut peers);
        assert_eq!(
            count_pongs_echoing(&mut browser, drain_edge(&mut edge_rx), PING_TIMESTAMP + 1),
            (0, 1)
        );
    }

    /// Each carrier answers a token once: the reliable copy behind an answered
    /// datagram is silent, a stale token is silent, the other carrier answers
    /// its own copy, and a new Noise session starts the marks over.
    #[tokio::test(flavor = "current_thread")]
    async fn each_carrier_answers_an_input_probe_once_per_noise_session() {
        let ProbingPeer {
            mut browser,
            mut peers,
            mut edge_rx,
            mut wt_datagram_rx,
            mut wt_reliable_rx,
        } = probing_peer();
        let edge_datagram = input_message(PeerTransport::Edge, DeliveryMode::Datagram);
        let edge_stream = input_message(PeerTransport::Edge, DeliveryMode::Stream);
        let direct_datagram = input_message(PeerTransport::WebTransport, DeliveryMode::Datagram);
        let retained = |token| InputProbe {
            token,
            ack_follows: false,
        };

        answer_input_probe(&edge_datagram, retained(PING_TIMESTAMP), &mut peers);
        assert_eq!(count_pongs(&mut browser, drain_edge(&mut edge_rx)), (1, 1));
        answer_input_probe(&edge_stream, retained(PING_TIMESTAMP), &mut peers);
        answer_input_probe(&edge_datagram, retained(PING_TIMESTAMP - 1), &mut peers);
        assert!(
            drain_edge(&mut edge_rx).is_empty(),
            "an answered or older token was answered again"
        );

        answer_input_probe(&direct_datagram, retained(PING_TIMESTAMP), &mut peers);
        assert_eq!(
            count_pongs(
                &mut browser,
                drain_direct(&mut wt_datagram_rx, &mut wt_reliable_rx)
            ),
            (1, 1),
            "the direct carrier's copy of the same token measures the direct path"
        );

        peers
            .get_mut("probing-browser")
            .expect("peer")
            .paths
            .forget_input_probes();
        answer_input_probe(&edge_datagram, retained(PING_TIMESTAMP), &mut peers);
        assert_eq!(
            count_pongs(&mut browser, drain_edge(&mut edge_rx)),
            (1, 1),
            "a new Noise session restarts the browser's tokens"
        );
    }

    /// A refused PONG twin costs that one copy and never the carrier.
    ///
    /// The twin's admission outcome is deliberately not accounted against path
    /// health. A refused CTRL queue is ordinary local backpressure on a shared
    /// queue — the not-a-path-failure category
    /// `transport_try_send_maintenance_reliable_with_fallback` already
    /// documents — and the PING that triggered the echo has itself just proved
    /// the downlink, which is what `record_inbound_activity()` records. Charge
    /// the refusal instead and a CTRL queue that is merely full during bulk
    /// output marks a live carrier unavailable after
    /// `PATH_SEND_FAILURE_THRESHOLD` pings, evicting the exact carrier the twin
    /// exists to keep.
    ///
    /// Both directions are pinned here: refusals never accumulate, and a path
    /// already carrying real display-send failures is neither pushed over the
    /// threshold by a refused twin nor left counting once the ping proves the
    /// downlink.
    #[tokio::test(flavor = "current_thread")]
    async fn a_refused_pong_twin_never_reaches_the_send_failure_counter() {
        const PEER_ID: &str = "refusing-browser";
        let now_ms = 5_000.0;

        let psk = [0x22u8; 32];
        let prologue = crate::e2e::derive_prologue("ping-refuse-test", PEER_ID, &[0x43; 64]);
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
        let mut browser = initiator.into_transport().expect("browser transport");

        // Well past PATH_SEND_FAILURE_THRESHOLD (3), so an accounted refusal
        // could not stay under it by accident.
        let pings = SessionPolicy::PATH_SEND_FAILURE_THRESHOLD + 2;

        let (edge_tx, mut edge_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(responder.into_transport().expect("daemon transport"));
        // Refuses every reliable record, admits every datagram.
        peer.edge_tunnel = Some(Arc::new(
            crate::edge_tunnel::EdgeTunnel::new_capture_with_reliable_limit(edge_tx, 0),
        ));
        peer.paths.edge = PathHealth::fresh_available(now_ms);
        let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);

        let body = PING_TIMESTAMP.to_be_bytes();
        for _ in 0..pings {
            handle_heartbeat_ping(
                &ping_message(PEER_ID, PeerTransport::Edge),
                &body,
                &mut peers,
            )
            .await;
        }

        let (datagram_pongs, stream_pongs) = count_pongs(&mut browser, drain_edge(&mut edge_rx));
        assert_eq!(
            datagram_pongs as u32, pings,
            "every ping must still get its datagram RTT sample while the \
             reliable queue refuses"
        );
        assert_eq!(stream_pongs, 0, "the refusing queue admitted a twin anyway");

        let paths = peers.get(PEER_ID).expect("peer").paths;
        assert_eq!(
            paths.edge.consecutive_send_failures, 0,
            "a refused twin is local backpressure on a shared CTRL queue, not a \
             path failure — the PING it answers has just proved the downlink"
        );
        assert!(
            paths.edge.available,
            "{pings} refused twins marked a carrier unavailable that is \
             delivering the browser's pings"
        );

        // The mirror image: real display sends have already left this path one
        // failure short of the threshold. A refused twin must not be the send
        // that tips it over. It cannot: the ping proves the downlink, so
        // `record_inbound_activity()` clears the count outright — which is why
        // the twin must not be charged in the other direction either, since
        // crediting it would make a probe that proves nothing about display
        // sends look like the recovery of one.
        let peer = peers.get_mut(PEER_ID).expect("peer");
        peer.paths.edge.consecutive_send_failures = SessionPolicy::PATH_SEND_FAILURE_THRESHOLD - 1;
        handle_heartbeat_ping(
            &ping_message(PEER_ID, PeerTransport::Edge),
            &body,
            &mut peers,
        )
        .await;

        let paths = peers.get(PEER_ID).expect("peer").paths;
        assert!(
            paths.edge.consecutive_send_failures < SessionPolicy::PATH_SEND_FAILURE_THRESHOLD,
            "a refused twin tipped a path that real display sends had left one \
             failure short of the threshold"
        );
        assert!(
            paths.edge.available,
            "the path was evicted by a refused twin on top of real send failures"
        );
    }

    /// A direct session that owns no socket and hands every send to a capture
    /// instead, so the direct path is observable beside the edge one.
    fn direct_capture(
        peer_id: &str,
        datagram_capture: tokio::sync::mpsc::UnboundedSender<(String, Vec<u8>)>,
        reliable_capture: tokio::sync::mpsc::UnboundedSender<(u8, String, Vec<u8>)>,
    ) -> crate::webtransport::DirectSession {
        crate::webtransport::DirectSession::new_capture(
            peer_id.into(),
            datagram_capture,
            Some(reliable_capture),
        )
    }

    /// Normalize an edge capture to `(channel, sealed)`. Both lanes land in one
    /// queue there, already stripped of the datagram's channel prefix.
    fn drain_edge(
        capture_rx: &mut tokio::sync::mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
    ) -> Vec<(u8, Vec<u8>)> {
        let mut frames = Vec::new();
        while let Ok(frame) = capture_rx.try_recv() {
            frames.push(frame);
        }
        frames
    }

    /// Normalize the two direct-WT captures to the same `(channel, sealed)`
    /// shape. The datagram capture keeps its channel prefix inside the payload;
    /// the reliable one carries the channel beside it.
    fn drain_direct(
        datagram_rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, Vec<u8>)>,
        reliable_rx: &mut tokio::sync::mpsc::UnboundedReceiver<(u8, String, Vec<u8>)>,
    ) -> Vec<(u8, Vec<u8>)> {
        let mut frames = Vec::new();
        while let Ok((_, wire)) = datagram_rx.try_recv() {
            let (&channel_id, sealed) = wire.split_first().expect("framed direct datagram");
            frames.push((channel_id, sealed.to_vec()));
        }
        while let Ok((channel_id, _, sealed)) = reliable_rx.try_recv() {
            frames.push((channel_id, sealed));
        }
        frames
    }

    /// Count the pongs a carrier received, by the sub-lane that opens each one.
    /// Everything the ping handler emits is CHANNEL_CTRL, so the seal is what
    /// names the frame: opening a datagram-sealed pong with the stream lane
    /// fails authentication and vice versa. A failed open never disturbs lane
    /// state, so trying both is free.
    fn count_pongs(
        browser: &mut crate::e2e::NoiseTransport,
        frames: Vec<(u8, Vec<u8>)>,
    ) -> (usize, usize) {
        count_pongs_echoing(browser, frames, PING_TIMESTAMP)
    }

    fn count_pongs_echoing(
        browser: &mut crate::e2e::NoiseTransport,
        frames: Vec<(u8, Vec<u8>)>,
        token: u64,
    ) -> (usize, usize) {
        let lane = crate::e2e::lane_for_channel(CHANNEL_CTRL).expect("ctrl lane");
        let mut datagram_pongs = 0usize;
        let mut stream_pongs = 0usize;
        for (channel_id, bytes) in frames {
            assert_eq!(channel_id, CHANNEL_CTRL, "the echo left the CTRL channel");
            if let Ok(plain) = browser.open_datagram(lane, &bytes) {
                assert_pong_echoes(&plain, token);
                datagram_pongs += 1;
            } else if let Ok(plain) = browser.open_stream(lane, &bytes) {
                assert_pong_echoes(&plain, token);
                stream_pongs += 1;
            } else {
                panic!("an unopenable frame reached the carrier");
            }
        }
        (datagram_pongs, stream_pongs)
    }

    /// The opaque echo token the ping-echo test's browser stamps into its PING.
    const PING_TIMESTAMP: u64 = 0x0102_0304_0506_0708;

    fn ping_message(peer_id: &str, via: PeerTransport) -> PeerMessage {
        PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from(peer_id),
            channel_id: CHANNEL_CTRL,
            payload: bytes::Bytes::new(),
            via_transport: via,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        }
    }

    fn assert_pong_echoes(plain: &[u8], timestamp: u64) {
        assert_eq!(
            plain.len(),
            20,
            "pong frame is a 4-byte header plus echo and monotonic clock"
        );
        assert_eq!(plain[0], MSG_TYPE_HEARTBEAT_PONG);
        assert_eq!(&plain[1..4], &[0, 0, 16]);
        assert_eq!(
            u64::from_be_bytes(plain[4..12].try_into().expect("echoed timestamp")),
            timestamp,
            "the echo must carry the browser's exact ping token"
        );
    }

    /// A blackholed carrier HOLDS the rebind lineage instead of destroying it.
    ///
    /// The sweep's all-paths-down branch used to park unconditionally, and
    /// `park_disconnected_peer` runs `clear_rebind_material` — so the chaining
    /// secret and the Noise session died at this threshold, seconds before
    /// quinn's idle timer would have closed the tunnel and triggered the redial
    /// that repairs the gap. Every rebind the browser sent afterwards was
    /// refused as an unknown peer, which on the wire is silence.
    ///
    /// Nothing else arms the window on this path, which is why the existing
    /// guard above could not save it: `handle_edge_lane_closed` needs a tunnel
    /// that has actually closed, and `reconcile_rebind_windows` needs the edge
    /// to report `CounterpartDetached`. A silent blackhole produces neither —
    /// the tunnel is dead but not closed, and the edge still reports the
    /// counterpart attached, which is what `new_capture` models here.
    ///
    /// Drives the production `heartbeat_tick`, so deleting the classification
    /// fails this test rather than silently restoring the cascade.
    #[tokio::test(flavor = "current_thread")]
    async fn a_blackholed_carrier_holds_the_rebind_lineage_instead_of_parking() {
        const PEER_ID: &str = "rebindable-browser";
        let now_ms = 60_000.0;
        let start_instant = Instant::now() - Duration::from_millis(now_ms as u64);

        let (capture_tx, _capture_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut peer = PeerDisplayState::new(PEER_ID.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.display_cache.resize(1, 1);
        peer.display_cache.initialized = true;
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
            capture_tx,
        )));
        // A live lineage: inside TEST_AUTHORIZATION_LIFETIME_MS and well inside the generation
        // budget, so `classify_counterpart_detach` has every reason to keep it.
        peer.rebind = Some(crate::connection::RebindState {
            secret: [0x5a; 64],
            counter: 0,
            lineage_digest: [0x5b; 64],
            genesis_at_ms: now_ms - 1_000.0,
            authorization: crate::session::authorization_epoch::AuthorizationEpoch::new(
                u64::MAX,
                [0; 64],
                0,
                now_ms,
            ),
            in_flight: None,
            pending_refusal: None,
        });
        // No direct path, and an edge path that answered once and has said
        // nothing since. That silence IS the blackhole.
        peer.paths.webtransport.available = false;
        peer.paths.edge = PathHealth::fresh_available(0.0);
        peer.paths.edge.last_ack_at_ms = 1.0;
        assert!(
            now_ms - peer.paths.edge.last_ack_at_ms
                > SessionPolicy::path_dead_after_ms(SessionPolicy::RTO_FLOOR_MS, now_ms, 0.0),
            "the edge path must actually be past its dead threshold, or the \
             sweep never reaches the branch under test"
        );
        assert!(
            peer.edge_rebind.is_none(),
            "the window must start unarmed, or the guard above short-circuits \
             the branch this test is about"
        );

        let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);
        let mut wt_upgrade_pending = HashMap::new();
        let mut parked = ParkedPeers::new();
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let (event_tx, _event_output) = crate::ipc::events::test_event_sink();
        let mut rebind_telemetry =
            crate::session::rebind_flow::RebindTelemetry::new(event_tx.clone());

        let evicted = heartbeat_tick(
            &mut peers,
            &mut wt_upgrade_pending,
            &mut parked,
            &None,
            &network_state,
            &event_tx,
            &mut rebind_telemetry,
            &[0u64],
            start_instant,
        )
        .await;

        assert!(
            evicted.is_empty(),
            "the tick evicted a peer whose lineage was still valid"
        );
        let peer = peers.get(PEER_ID).expect(
            "the peer was parked, which runs clear_rebind_material and destroys \
             the chaining secret the browser is about to prove possession of",
        );
        let window = peer
            .edge_rebind
            .expect("all paths went down and no carrier gap was armed");
        // Bounds, not an identity: the tick reads its own `now_ms_since`, which
        // is a fraction past the nominal origin this test set up. The invariant
        // is the one the window exists for — a full carrier gap that still
        // expires before the edge's own half-paired prune.
        let gap_ms = window.deadline_ms - now_ms;
        assert!(
            gap_ms >= SessionPolicy::carrier_gap_window_ms()
                && gap_ms < SessionPolicy::REBIND_WINDOW_MS as f64,
            "the gap window must be one carrier gap long and expire strictly \
             inside the edge's half-paired expiry; got {gap_ms} ms"
        );
        assert!(
            peer.rebind.is_some(),
            "the lineage was cleared, so the fast path is gone even though the \
             peer survived"
        );
    }
}
