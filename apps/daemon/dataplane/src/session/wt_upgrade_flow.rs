//! WebTransport upgrade flow: pending upgrade tracking, init/proof
//! handshake over the temp peer, and manifest and punch-outcome emission.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{info, warn};

use merkur_wire::signaling::{WebtransportUpgradeInit, WebtransportUpgradeProof};

use crate::auth::DaemonIdentity;
use crate::connection::{PeerDisplayState, PeerMap};
use crate::network::peer::PeerMessage;
use crate::network::protocol::*;
use crate::network::NetworkState;
use crate::webtransport::{self, WebTransportState};
use crate::wt_upgrade;

pub(crate) const WT_UPGRADE_PENDING_TTL_MS: f64 = 30_000.0;
const WT_UPGRADE_PROOF_BYTES: usize = 64;

#[derive(Clone, Copy)]
pub(crate) struct WtUpgradeProofArrival {
    proof: [u8; WT_UPGRADE_PROOF_BYTES],
    rtt_ms: f64,
}

pub(crate) struct WtUpgradePending {
    pub(crate) browser_node_id: String,
    pub(crate) nonce_hex: String,
    pub(crate) issued_at_ms: f64,
    /// First arrival of the exact syntactically-valid proof bytes currently
    /// being retried. A retry while authentication publishes the upgrade key
    /// keeps its original network RTT; different bytes replace the sample, so
    /// an earlier bogus tag cannot poison a later valid proof's path estimate.
    pub(crate) proof_arrival: Option<WtUpgradeProofArrival>,
}

fn record_proof_arrival(
    pending: &mut WtUpgradePending,
    proof: [u8; WT_UPGRADE_PROOF_BYTES],
    now_ms: f64,
) -> f64 {
    let observed_rtt_ms = now_ms - pending.issued_at_ms;
    match pending.proof_arrival {
        Some(arrival) if arrival.proof == proof => arrival.rtt_ms,
        _ => {
            pending.proof_arrival = Some(WtUpgradeProofArrival {
                proof,
                rtt_ms: observed_rtt_ms,
            });
            observed_rtt_ms
        }
    }
}

pub(crate) async fn handle_wt_upgrade_init(
    raw_peer_id: &str,
    message: &WebtransportUpgradeInit,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    daemon_identity: &Option<DaemonIdentity>,
    peers: &PeerMap,
    wt_upgrade_pending: &mut HashMap<String, WtUpgradePending>,
    now_ms: f64,
) {
    let browser_node_id = message.browser_node_id.as_str();
    let Some(wt) = wt_state else {
        warn!("webtransport_upgrade_init with no WT state");
        return;
    };
    let Some(da) = daemon_identity else {
        warn!("webtransport_upgrade_init with no daemon_identity");
        return;
    };

    let is_authenticated = peers.get(browser_node_id).is_some_and(|p| p.authenticated);
    if !is_authenticated {
        static UNAUTHENTICATED_INITS: crate::WarningCount = crate::WarningCount::new(0);
        if crate::within_warning_budget(&UNAUTHENTICATED_INITS) {
            warn!("webtransport_upgrade_init from unauthenticated browser: {browser_node_id}");
        }
        let reject = serde_json::json!({
            "type": "webtransport_upgrade_rejected",
            "reason": "not_authenticated",
        });
        webtransport::send_to_peer(
            wt,
            raw_peer_id,
            CHANNEL_CTRL,
            reject.to_string().into_bytes(),
        )
        .await;
        return;
    }

    let nonce = match da.generate_random() {
        Ok(nonce) => nonce,
        Err(error) => {
            warn!(%error, "webtransport upgrade challenge randomness unavailable");
            let reject = serde_json::json!({
                "type": "webtransport_upgrade_rejected",
                "reason": "unavailable",
            });
            webtransport::send_to_peer(
                wt,
                raw_peer_id,
                CHANNEL_CTRL,
                reject.to_string().into_bytes(),
            )
            .await;
            return;
        }
    };
    let nonce_hex = wt_upgrade::hex_encode_nonce(&nonce);
    wt_upgrade_pending.insert(
        raw_peer_id.to_string(),
        WtUpgradePending {
            browser_node_id: browser_node_id.to_string(),
            nonce_hex: nonce_hex.clone(),
            issued_at_ms: now_ms,
            proof_arrival: None,
        },
    );

    let challenge = serde_json::json!({
        "type": "webtransport_upgrade_challenge",
        "nonce_hex": nonce_hex,
        "temp_peer_id": raw_peer_id,
    });
    webtransport::send_to_peer(
        wt,
        raw_peer_id,
        CHANNEL_CTRL,
        challenge.to_string().into_bytes(),
    )
    .await;
}

pub(crate) async fn handle_wt_upgrade_proof(
    raw_peer_id: &str,
    message: &WebtransportUpgradeProof,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    daemon_identity: &Option<DaemonIdentity>,
    peers: &mut PeerMap,
    wt_temp_to_real: &mut HashMap<String, std::sync::Arc<str>>,
    wt_upgrade_pending: &mut HashMap<String, WtUpgradePending>,
    now_ms: f64,
) {
    let Some(wt) = wt_state else { return };
    let Some(da) = daemon_identity else {
        return;
    };

    // Inspect (don't consume yet) the pending challenge. A proof can legitimately
    // removing it before verification meant a valid retry within the TTL failed
    // with "no pending challenge" and the browser had to restart the whole
    // upgrade handshake.
    let Some(pending) = wt_upgrade_pending.get_mut(raw_peer_id) else {
        warn!("webtransport_upgrade_proof with no pending challenge: {raw_peer_id}");
        return;
    };
    if now_ms - pending.issued_at_ms > WT_UPGRADE_PENDING_TTL_MS {
        // Expired: consume it — a stale nonce must not be retryable.
        wt_upgrade_pending.remove(raw_peer_id);
        warn!("webtransport_upgrade_proof expired for {raw_peer_id}");
        let reject = serde_json::json!({
            "type": "webtransport_upgrade_rejected",
            "reason": "expired",
        });
        webtransport::send_to_peer(
            wt,
            raw_peer_id,
            CHANNEL_CTRL,
            reject.to_string().into_bytes(),
        )
        .await;
        return;
    }
    let proof_bytes = decode_wt_upgrade_proof(&message.proof_hex).expect("validated proof_hex");
    let browser_node_id = pending.browser_node_id.clone();
    // The challenge and these exact proof bytes crossed the direct carrier, so
    // their first arrival is a genuine round trip over the path about to come
    // online. Preserve it across same-proof auth-readiness retries; different
    // bytes replace it so an earlier bogus candidate cannot donate its timing.
    let challenge_rtt_ms = record_proof_arrival(pending, proof_bytes, now_ms);
    let nonce_hex = pending.nonce_hex.clone();

    // Peer preconditions are transient while authentication is still publishing
    // the fresh direct-upgrade key. Return without consuming the challenge so a
    // retry inside the TTL still finds it.
    let Some(peer) = peers.get(browser_node_id.as_str()) else {
        warn!(
            "webtransport_upgrade_proof peer missing (challenge retained for retry): {browser_node_id}"
        );
        return;
    };
    if !peer.authenticated || peer.upgrade_secret.is_none() {
        warn!(
            "webtransport_upgrade_proof peer not ready (challenge retained for retry): {browser_node_id}"
        );
        return;
    }
    let upgrade_secret = peer.upgrade_secret.as_ref().expect("checked above");
    let signal_session_id = peer.signal_session_id.clone();

    // Committed to verifying — consume the challenge now. A valid OR invalid proof
    // both retire this nonce; a fresh attempt re-issues a new challenge.
    wt_upgrade_pending.remove(raw_peer_id);

    let ok = wt_upgrade::verify_wt_upgrade_proof(
        upgrade_secret,
        &nonce_hex,
        &signal_session_id,
        &browser_node_id,
        da.daemon_id(),
        raw_peer_id,
        &proof_bytes,
    );
    if !ok {
        warn!("webtransport_upgrade_proof rejected for {browser_node_id}");
        let reject = serde_json::json!({
            "type": "webtransport_upgrade_rejected",
            "reason": "invalid_proof",
        });
        webtransport::send_to_peer(
            wt,
            raw_peer_id,
            CHANNEL_CTRL,
            reject.to_string().into_bytes(),
        )
        .await;
        return;
    }

    let Some((upgrade_outcome, direct_session)) =
        webtransport::upgrade_peer(wt, raw_peer_id, &browser_node_id).await
    else {
        warn!(
            "webtransport_upgrade_proof lost ownership race for {browser_node_id}: temp={raw_peer_id}"
        );
        return;
    };
    wt_temp_to_real.insert(raw_peer_id.to_string(), Arc::from(browser_node_id.as_str()));
    webtransport::note_direct_wt_admitted();

    let ack = encode_proto_frame(MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK, &[]);
    webtransport::send_to_peer(wt, &browser_node_id, CHANNEL_CTRL, ack).await;

    if let Some(peer) = peers.get_mut(browser_node_id.as_str()) {
        admit_direct_path(
            peer,
            now_ms,
            challenge_rtt_ms,
            upgrade_outcome == webtransport::UpgradePeerOutcome::Replaced,
        );
        peer.direct_session = Some(direct_session);
        info!(
            "peer direct WebTransport path online: {browser_node_id} (edge_available={}, primary_after_upgrade={:?})",
            peer.paths.edge.available,
            peer.primary_path(now_ms),
        );
    }
}

/// Admit a direct path into the existing authenticated display session.
///
/// A first direct carrier is path addition, not a carrier boundary. A later
/// upgrade can instead replace an already-routed direct connection; only attempts owned
/// exclusively by that displaced carrier are retired then. In both cases the
/// edge remains live, so its in-flight acknowledgements, the display generation,
/// dictionary readiness, and pending preparation survive. The upgrade proof
/// supplies the new direct path's first RTT calibration.
pub(crate) fn admit_direct_path(
    peer: &mut PeerDisplayState,
    now_ms: f64,
    challenge_rtt_ms: f64,
    replacing_live_direct: bool,
) {
    if replacing_live_direct {
        peer.retire_display_attempts(crate::connection::PeerTransport::WebTransport);
    }
    // The proof admitted a new physical direct carrier even when this is the
    // first direct path in the display session. Evidence belongs to the old
    // carrier, not to the display generation shared with the edge, and so does
    // any block recorded for it.
    peer.reset_fec_evidence(crate::connection::PeerTransport::WebTransport);
    peer.carrier_blocks
        .replaced(crate::connection::PeerTransport::WebTransport);
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(now_ms);
    peer.paths.webtransport.seed_rtt(challenge_rtt_ms);
}

/// Repro affordance: with `MERKUR_DISABLE_WT_UPGRADE=1` the daemon never sends a
/// direct-WT manifest, pinning co-located browsers to the edge relay.
///
/// Read once. The environment cannot change under a running process, and
/// `env::var` allocates a `String` on every call — this one sat on the manifest
/// path, which runs per peer per session and again on every change.
fn wt_upgrade_disabled() -> bool {
    static DISABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DISABLED.get_or_init(|| {
        std::env::var_os("MERKUR_DISABLE_WT_UPGRADE").is_some_and(|value| value == "1")
    })
}

/// Decide whether this manifest warrants a pinhole punch, and toward what.
///
/// Returns the side-channel handle, the destination, and the port set, so the
/// caller can queue the send after releasing the WT lock.
///
/// Eligibility is per family, and gated on the manifest actually containing a
/// candidate the punch could help:
///
/// - **IPv4 browser** — only if the manifest carries an `Srflx` candidate.
///   Skipped entirely under an endpoint-dependent (symmetric) NAT: there the
///   advertised external port is not the one the browser would reach, so
///   opening filter state on our mapping achieves nothing. That failure is
///   silent, which is exactly why it is gated rather than attempted.
/// - **IPv6 browser** — only if the manifest carries a `Host6` candidate. Many
///   consumer v6 firewalls keep 3-tuple UDP state, so an outbound datagram
///   from the daemon's GUA opens precisely that pinhole.
/// - **Port-dependent filtering** — no punch. The filter admits only the exact
///   browser endpoint the daemon has sent to, and a browser dials each
///   candidate from an ephemeral port nothing can learn beforehand, so an
///   adjacent punch opens nothing it can hit. `srflx` is still offered: the
///   browser's own network may hold the mapping it needs. Such a daemon is
///   reachable through a lease or a global IPv6 address, or else the relay;
///   `docs/transport.md` states the class.
fn punch_plan(
    wt_guard: &webtransport::WebTransportState,
    browser_address: std::net::IpAddr,
    candidates: &[webtransport::AddressCandidate],
) -> Option<(
    Arc<webtransport::side_channel::SideChannel>,
    std::net::IpAddr,
    [u16; 2],
)> {
    if webtransport::side_channel::punch_disabled() {
        return None;
    }
    let channel = wt_guard.side_channel.clone()?;
    let wanted = if browser_address.is_ipv4() {
        if wt_guard.nat_mapping == webtransport::stun::NatMapping::EndpointDependent
            || wt_guard.discovery_evidence.nat_filtering == "port_dependent"
        {
            return None;
        }
        webtransport::CandidateFlavor::Srflx
    } else {
        webtransport::CandidateFlavor::Host6
    };
    if !candidates.iter().any(|c| c.kind == wanted) {
        return None;
    }
    Some((
        channel,
        browser_address,
        webtransport::side_channel::punch_ports(wt_guard.port),
    ))
}

/// Send `peer` its direct-path manifest for the address its committed
/// signaling carrier proved, punching toward that address when a candidate
/// needs it. Returns whether a manifest went out.
///
/// Nothing is sent before the edge has reported that address: the browser
/// would dial against a guess. Every caller is one side of a join whose other
/// side calls again: authentication and the address report, a rebind commit
/// and its candidate's address, and any later change to either the address or
/// the daemon's candidates.
///
/// The punch leaves from the traversal worker, never from here. The manifest
/// goes out at once with `punch: pending`, so candidates that need no punch are
/// dialable immediately, and `webtransport_punch` later names the outcome for
/// this manifest's generation.
pub(crate) async fn emit_webtransport_manifest(
    wt_state: &Option<Arc<RwLock<webtransport::WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    peer: &mut crate::connection::PeerDisplayState,
    candidate: Option<&Arc<crate::edge_candidate::CandidateReply>>,
) -> bool {
    let Some(browser_address) = peer.browser_address else {
        return false;
    };
    let Some(wt) = wt_state else {
        return false;
    };
    if wt_upgrade_disabled() {
        info!(
            "webtransport_manifest suppressed (MERKUR_DISABLE_WT_UPGRADE=1): peer={}",
            peer.peer_id
        );
        return false;
    }
    peer.manifest_generation += 1;
    let generation = peer.manifest_generation;
    let wt_guard = wt.read().await;
    let candidates = webtransport::pairing::manifest_candidates(
        &wt_guard.candidates,
        browser_address,
        wt_guard.port,
    );
    let punch = punch_plan(&wt_guard, browser_address, &candidates)
        .zip(wt_guard.traversal_requests.clone());
    let mut manifest = webtransport::manifest_json(
        &wt_guard,
        &candidates,
        browser_address,
        generation,
        punch.is_some(),
    );
    drop(wt_guard);

    // Queue only; the four-packet punch runs off the PTY owner, and the owner
    // reports its outcome for this exact generation.
    if let Some(((channel, browser_ip, ports), requests)) = punch
        && requests
            .try_send(webtransport::traversal::Request {
                peer: peer.peer_id.clone(),
                session: peer.signal_session_id.clone(),
                generation: peer.rebind.as_ref().map_or(0, |state| state.counter),
                manifest_generation: generation,
                channel,
                browser_ip,
                ports,
                created: tokio::time::Instant::now(),
            })
            .is_err()
    {
        manifest["punch"] = serde_json::json!("none");
    }
    webtransport::note_offered_browser(browser_address);
    info!(
        peer = %peer.peer_id,
        generation,
        %browser_address,
        candidates = candidates.len(),
        punch = manifest["punch"].as_str().unwrap_or("none"),
        "webtransport_manifest"
    );
    crate::edge_candidate::reply(
        network_state,
        &peer.peer_id,
        candidate,
        manifest.to_string().into_bytes(),
        false,
    )
    .await;
    true
}

/// Tell the browser what became of the punch queued for one manifest.
pub(crate) async fn send_punch_outcome(
    network_state: &Arc<RwLock<NetworkState>>,
    disposition: &webtransport::traversal::Disposition,
) {
    let message = serde_json::json!({
        "type": "webtransport_punch",
        "generation": disposition.manifest_generation,
        "outcome": disposition.outcome,
    });
    crate::network::send_signaling_to_peer(
        network_state,
        &disposition.peer,
        message.to_string().into_bytes(),
    )
    .await;
}

pub(crate) fn is_webtransport_upgrade_ctrl_message(
    msg: &PeerMessage,
    wt_temp_to_real: &HashMap<String, std::sync::Arc<str>>,
) -> bool {
    if msg.channel_id != CHANNEL_CTRL || wt_temp_to_real.contains_key(&*msg.peer_node_id) {
        return false;
    }

    let Ok(text) = std::str::from_utf8(&msg.payload) else {
        return false;
    };

    matches!(
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|json| json["type"].as_str().map(str::to_owned))
            .as_deref(),
        Some("webtransport_upgrade_init") | Some("webtransport_upgrade_proof")
    )
}

fn decode_wt_upgrade_proof(hex: &str) -> Option<[u8; WT_UPGRADE_PROOF_BYTES]> {
    if hex.len() != 128
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut bytes = [0u8; WT_UPGRADE_PROOF_BYTES];
    for (index, slot) in bytes.iter_mut().enumerate() {
        let offset = index * 2;
        *slot = u8::from_str_radix(&hex[offset..offset + 2], 16).ok()?;
    }
    Some(bytes)
}

#[cfg(test)]
mod punch_plan_tests {
    use super::*;
    use crate::webtransport::side_channel::SideChannel;
    use crate::webtransport::{AddressCandidate, CandidateFlavor, CertState, WebTransportState};
    use std::time::{Duration, Instant};

    fn state(
        nat_mapping: crate::webtransport::stun::NatMapping,
        filtering: &'static str,
    ) -> WebTransportState {
        let mut state = WebTransportState::new(
            CertState {
                cert_hash: [0; 32],
                created_at: Instant::now(),
                valid_for: Duration::from_secs(60),
            },
            44_433,
            Vec::new(),
            crate::webtransport::pairing::NatSignature {
                public_ip: None,
                nat_type: crate::webtransport::pairing::NatTypeLabel::from(nat_mapping),
                hairpin: false,
            },
            nat_mapping,
            None,
        );
        state.discovery_evidence.nat_filtering = filtering;
        let socket = std::net::UdpSocket::bind("[::]:0").expect("bind");
        state.side_channel = Some(Arc::new(SideChannel::new(socket).expect("side channel")));
        state
    }

    fn candidate(addr: &str, kind: CandidateFlavor) -> AddressCandidate {
        AddressCandidate {
            addr: addr.into(),
            port: 44_433,
            kind,
        }
    }

    /// Only a filter the punch can open gets one: port-dependent filtering
    /// admits the exact browser endpoint alone, and symmetric mapping aims
    /// nowhere the browser can reach.
    #[test]
    fn only_a_filter_the_punch_can_open_is_punched() {
        use crate::webtransport::side_channel::punch_ports;
        use crate::webtransport::stun::NatMapping;
        let browser: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        let srflx = [candidate("198.51.100.7", CandidateFlavor::Srflx)];
        let plan =
            |s: &WebTransportState| punch_plan(s, browser, &srflx).map(|(_, _, ports)| ports);

        for mapping in [NatMapping::EndpointIndependent, NatMapping::Unknown] {
            for filtering in ["port_independent", "unknown"] {
                let s = state(mapping, filtering);
                assert_eq!(
                    plan(&s),
                    Some(punch_ports(44_433)),
                    "{mapping:?} {filtering}"
                );
            }
            let s = state(mapping, "port_dependent");
            assert_eq!(
                plan(&s),
                None,
                "{mapping:?}: no punch opens a port-dependent filter"
            );
        }
        let s = state(NatMapping::EndpointDependent, "port_independent");
        assert_eq!(plan(&s), None, "symmetric mapping refuses every punch");
    }

    async fn capture_network(
        peer: &str,
    ) -> (
        Arc<RwLock<NetworkState>>,
        tokio::sync::mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
    ) {
        let network = Arc::new(RwLock::new(NetworkState::new()));
        let (capture_tx, capture_rx) = tokio::sync::mpsc::unbounded_channel();
        crate::network::register_edge_signaling(
            &network,
            peer,
            Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(capture_tx)),
        )
        .await;
        (network, capture_rx)
    }

    async fn next_json(
        capture: &mut tokio::sync::mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
    ) -> serde_json::Value {
        let (_, bytes) = capture.recv().await.expect("a signaling message");
        serde_json::from_slice(&bytes).expect("signaling json")
    }

    /// No manifest goes out before the edge has proven the browser's address.
    /// Once it has, every manifest names that address, the daemon's whole
    /// candidate set with each candidate's scope, and a new generation.
    #[tokio::test]
    async fn a_manifest_waits_for_the_address_and_each_one_advances_the_generation() {
        use crate::connection::{PeerDisplayState, PeerTransport};
        use crate::webtransport::stun::NatMapping;
        let mut initial = state(NatMapping::EndpointIndependent, "port_independent");
        initial.candidates = vec![
            candidate("198.51.100.7", CandidateFlavor::Srflx),
            candidate("192.168.1.10", CandidateFlavor::Host4),
        ];
        let wt = Some(Arc::new(RwLock::new(initial)));
        let (network, mut capture) = capture_network("browser-1").await;
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);

        assert!(
            !emit_webtransport_manifest(&wt, &network, &mut peer, None).await,
            "no proven address, no manifest"
        );
        assert_eq!(peer.manifest_generation, 0);

        peer.browser_address = Some("203.0.113.9".parse().unwrap());
        assert!(emit_webtransport_manifest(&wt, &network, &mut peer, None).await);
        let manifest = next_json(&mut capture).await;
        assert_eq!(manifest["type"], "webtransport_manifest");
        assert_eq!(manifest["generation"], 1);
        assert_eq!(manifest["browser_address"], "203.0.113.9");
        let candidates = manifest["candidates"].as_array().expect("candidates");
        assert_eq!(
            candidates.len(),
            2,
            "the whole set, whatever the browser's network"
        );
        assert_eq!(candidates[0]["scope"], "public");
        assert_eq!(candidates[1]["scope"], "local");
        assert_eq!(
            manifest["punch"], "none",
            "no traversal worker in this fixture, so no punch can be promised"
        );
        assert!(manifest.get("strategy").is_none());

        peer.browser_address = Some("198.51.100.44".parse().unwrap());
        assert!(emit_webtransport_manifest(&wt, &network, &mut peer, None).await);
        let manifest = next_json(&mut capture).await;
        assert_eq!(manifest["generation"], 2);
        assert_eq!(manifest["browser_address"], "198.51.100.44");
    }

    /// A manifest with a punched candidate promises a punch outcome for its own
    /// generation, and queues the punch toward the address it was built for.
    #[tokio::test]
    async fn a_punched_manifest_queues_its_punch_under_its_own_generation() {
        use crate::connection::{PeerDisplayState, PeerTransport};
        use crate::webtransport::stun::NatMapping;
        let mut initial = state(NatMapping::EndpointIndependent, "port_independent");
        initial.candidates = vec![candidate("198.51.100.7", CandidateFlavor::Srflx)];
        let (requests, mut queued) = crate::webtransport::traversal::channel();
        initial.traversal_requests = Some(requests);
        let wt = Some(Arc::new(RwLock::new(initial)));
        let (network, mut capture) = capture_network("browser-1").await;
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.browser_address = Some("203.0.113.9".parse().unwrap());

        assert!(emit_webtransport_manifest(&wt, &network, &mut peer, None).await);
        let manifest = next_json(&mut capture).await;
        assert_eq!(manifest["punch"], "pending");
        let request = queued.try_recv().expect("a queued punch");
        assert_eq!(request.manifest_generation, 1);
        assert_eq!(
            request.browser_ip,
            "203.0.113.9".parse::<std::net::IpAddr>().unwrap()
        );
    }

    #[tokio::test]
    async fn a_punch_outcome_names_the_manifest_it_belongs_to() {
        let (network, mut capture) = capture_network("browser-1").await;
        send_punch_outcome(
            &network,
            &crate::webtransport::traversal::Disposition {
                peer: "browser-1".into(),
                manifest_generation: 3,
                outcome: crate::webtransport::traversal::PunchOutcome::Dispatched,
            },
        )
        .await;
        assert_eq!(
            next_json(&mut capture).await,
            serde_json::json!({ "type": "webtransport_punch", "generation": 3, "outcome": "dispatched" })
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{PeerTransport, SentDatagram, SentPaths, SentRows};

    #[test]
    fn webtransport_upgrade_ctrl_message_is_routed_before_auth_gate() {
        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from("wt-pending-1"),
            channel_id: CHANNEL_CTRL,
            payload: bytes::Bytes::from_static(
                br#"{"type":"webtransport_upgrade_init","browser_node_id":"browser-1"}"#,
            ),
            via_transport: PeerTransport::WebTransport,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 1,
            edge_ingress: None,
        };
        let wt_temp_to_real: HashMap<String, Arc<str>> = HashMap::new();

        assert!(is_webtransport_upgrade_ctrl_message(&msg, &wt_temp_to_real));
    }

    #[test]
    fn upgraded_webtransport_ctrl_messages_use_authenticated_path() {
        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from("wt-pending-1"),
            channel_id: CHANNEL_CTRL,
            payload: bytes::Bytes::from_static(
                br#"{"type":"webtransport_upgrade_init","browser_node_id":"browser-1"}"#,
            ),
            via_transport: PeerTransport::WebTransport,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 1,
            edge_ingress: None,
        };
        let wt_temp_to_real = HashMap::from([("wt-pending-1".to_string(), Arc::from("browser-1"))]);

        assert!(!is_webtransport_upgrade_ctrl_message(
            &msg,
            &wt_temp_to_real
        ));
    }

    #[test]
    fn direct_admission_preserves_the_live_display_session() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.needs_snapshot = false;
        peer.generation = 17;
        peer.last_display_seq_sent = 41;
        peer.display_dictionary_ready = true;
        peer.display_cache.resize(2, 1);
        peer.display_cache.sent_datagrams.insert(
            41,
            SentDatagram {
                sent_at_ms: 90.0,
                rows: SentRows::default(),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: true,
                reliable: false,
                protection: crate::connection::DisplayDatagramProtection::Unprotected,
            },
        );
        for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
            peer.display_cache.fec_evidence.get_mut(path).observe(
                crate::connection::DisplayDatagramProtection::Unprotected,
                crate::connection::DisplayDatagramOutcome::Lost,
            );
        }

        admit_direct_path(&mut peer, 100.0, 73.0, false);

        assert!(peer.paths.webtransport.available);
        assert_eq!(peer.paths.webtransport.rtt_ewma_ms, 73.0);
        assert_eq!(peer.paths.webtransport.network_rtt_ewma_ms, 73.0);
        assert!(
            !peer
                .display_cache
                .fec_evidence
                .get(PeerTransport::WebTransport)
                .replication_enabled()
        );
        assert!(
            peer.display_cache
                .fec_evidence
                .get(PeerTransport::Edge)
                .replication_enabled()
        );
        assert_eq!(
            peer.generation, 17,
            "path addition must not roll display lineage"
        );
        assert_eq!(peer.last_display_seq_sent, 41);
        assert!(peer.display_cache.sent_datagrams.contains_key(&41));
        assert!(peer.display_dictionary_ready);
        assert!(!peer.needs_snapshot, "the browser already holds this grid");
    }

    /// A direct connection that filled and then died leaves its block on the
    /// record. The successor it admits is its own connection and holds nothing;
    /// the edge's record is a different carrier's and stays.
    #[test]
    fn a_readmitted_direct_carrier_inherits_no_block() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        for carrier in [PeerTransport::WebTransport, PeerTransport::Edge] {
            peer.carrier_blocks.observe(carrier, true);
            peer.carrier_blocks.admitted(carrier);
        }

        admit_direct_path(&mut peer, 100.0, 20.0, true);

        assert!(!peer.carrier_blocks.is_blocked(PeerTransport::WebTransport));
        assert!(!peer.carrier_blocks.is_closed(PeerTransport::WebTransport));
        assert!(peer.carrier_blocks.is_closed(PeerTransport::Edge));
    }

    #[test]
    fn upgrade_retry_preserves_the_first_matching_proof_round_trip() {
        let mut pending = WtUpgradePending {
            browser_node_id: "browser-1".to_string(),
            nonce_hex: "00".repeat(32),
            issued_at_ms: 100.0,
            proof_arrival: None,
        };
        let proof = [7; WT_UPGRADE_PROOF_BYTES];

        let first = record_proof_arrival(&mut pending, proof, 173.0);
        let retry = record_proof_arrival(&mut pending, proof, 900.0);

        assert_eq!(first, 73.0);
        assert_eq!(retry, first, "local retry wait is not network RTT");
    }

    #[test]
    fn a_different_bogus_proof_cannot_poison_the_valid_proof_rtt() {
        let mut pending = WtUpgradePending {
            browser_node_id: "browser-1".to_string(),
            nonce_hex: "00".repeat(32),
            issued_at_ms: 100.0,
            proof_arrival: None,
        };

        assert_eq!(
            record_proof_arrival(&mut pending, [3; WT_UPGRADE_PROOF_BYTES], 125.0),
            25.0
        );
        assert_eq!(
            record_proof_arrival(&mut pending, [9; WT_UPGRADE_PROOF_BYTES], 180.0),
            80.0,
            "different proof bytes start their own network sample"
        );
        assert_eq!(
            record_proof_arrival(&mut pending, [9; WT_UPGRADE_PROOF_BYTES], 700.0),
            80.0,
            "the eventual valid proof's retry keeps its first arrival"
        );
    }

    #[test]
    fn live_direct_replacement_requeues_only_direct_only_attempts() {
        use merkur_codec::CellRepr;

        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.paths.webtransport = crate::connection::PathHealth::fresh_available(1.0);
        peer.needs_snapshot = false;
        peer.generation = 17;
        peer.display_dictionary_ready = true;
        peer.last_admitted_critical_header_signal = 0xfeed;
        peer.display_cache.resize(1, 3);
        peer.display_cache
            .prime_from_snapshot(&[CellRepr::BLANK; 3], &[1, 2, 3], &[]);

        let direct_row = crate::connection::SentRow {
            graphics: None,
            row: 0,
            hash: 101,
            cells: vec![CellRepr::BLANK].into(),
        };
        peer.display_cache.record_reliable_sent_rows_on_path(
            10,
            std::slice::from_ref(&direct_row),
            10.0,
            PeerTransport::WebTransport,
            25.0,
        );
        peer.display_cache.insert_sent_datagram(
            10,
            SentDatagram {
                sent_at_ms: 10.0,
                rows: SentRows::from_iter([direct_row]),
                sent_via: SentPaths::single(PeerTransport::WebTransport),
                header_only: false,
                reliable: true,
                protection: crate::connection::DisplayDatagramProtection::Unprotected,
            },
        );

        let edge_row = crate::connection::SentRow {
            graphics: None,
            row: 1,
            hash: 202,
            cells: vec![CellRepr::BLANK].into(),
        };
        let edge_paths = SentPaths::single(PeerTransport::Edge);
        peer.display_cache.record_sent_rows_on_paths(
            11,
            std::slice::from_ref(&edge_row),
            11.0,
            edge_paths,
            25.0,
        );
        peer.display_cache.insert_sent_datagram(
            11,
            SentDatagram {
                sent_at_ms: 11.0,
                rows: SentRows::from_iter([edge_row]),
                sent_via: edge_paths,
                header_only: false,
                reliable: false,
                protection: crate::connection::DisplayDatagramProtection::Unprotected,
            },
        );

        let dual_row = crate::connection::SentRow {
            graphics: None,
            row: 2,
            hash: 303,
            cells: vec![CellRepr::BLANK].into(),
        };
        let dual_paths = SentPaths {
            webtransport: true,
            edge: true,
        };
        peer.display_cache.record_sent_rows_on_paths(
            12,
            std::slice::from_ref(&dual_row),
            12.0,
            dual_paths,
            25.0,
        );
        peer.display_cache.insert_sent_datagram(
            12,
            SentDatagram {
                sent_at_ms: 12.0,
                rows: SentRows::from_iter([dual_row]),
                sent_via: dual_paths,
                header_only: false,
                reliable: false,
                protection: crate::connection::DisplayDatagramProtection::Unprotected,
            },
        );

        admit_direct_path(&mut peer, 100.0, 20.0, true);

        assert_eq!(peer.generation, 17);
        assert!(peer.display_dictionary_ready);
        assert!(!peer.needs_snapshot);
        assert!(peer.needs_full_diff);
        assert_eq!(peer.last_admitted_critical_header_signal, 0xfeed);
        assert!(!peer.display_cache.sent_datagrams.contains_key(&10));
        assert!(peer.display_cache.sent_datagrams.contains_key(&11));
        let dual = peer
            .display_cache
            .sent_datagrams
            .get(&12)
            .expect("dual evidence survives on edge");
        assert_eq!(
            dual.sent_via, dual_paths,
            "the already-delivered copy remains ambiguous for attribution"
        );
        assert_eq!(peer.display_cache.acked_row_hashes, vec![1, 2, 3]);
        assert!(
            peer.display_cache
                .acked_row_exact
                .iter()
                .all(|exact| *exact)
        );
        assert_eq!(peer.display_cache.sent_row_latest_seq, vec![0, 11, 12]);
        assert!(!peer.display_cache.sent_row_has_reliable_attempt[0]);
        assert!(peer.display_cache.sent_row_force_full_until_confirmed[0]);
        assert!(
            peer.display_cache
                .has_selectable_rows(&[101, 202, 303], 100.0)
        );
    }

    #[test]
    fn live_direct_replacement_reissues_a_direct_only_critical_header() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
        peer.needs_snapshot = false;
        peer.needs_full_diff = false;
        peer.last_admitted_critical_header_signal = 0xbeef;
        peer.display_cache.insert_sent_datagram(
            7,
            SentDatagram {
                sent_at_ms: 7.0,
                rows: SentRows::default(),
                sent_via: SentPaths::single(PeerTransport::WebTransport),
                header_only: true,
                reliable: false,
                protection: crate::connection::DisplayDatagramProtection::Unprotected,
            },
        );

        admit_direct_path(&mut peer, 100.0, 20.0, true);

        assert_eq!(peer.last_admitted_critical_header_signal, 0);
        assert!(peer.needs_full_diff);
        assert!(peer.display_cache.sent_datagrams.is_empty());
    }
}
