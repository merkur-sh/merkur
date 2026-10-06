//! Resolve a lost commit acknowledgement without retaining a spent secret.

use crate::{auth::decode_canonical_array, connection::PeerMap, network::NetworkState};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use merkur_wire::signaling::{DaemonSignal, SessionRebindReconcile};
use std::sync::Arc;
use tokio::sync::RwLock;

/// `request` passed the envelope check, so every encoded field has its exact
/// length.
pub(crate) async fn reconcile(
    peer_id: &str,
    daemon_id: &str,
    request: &SessionRebindReconcile,
    peers: &mut PeerMap,
    network: &Arc<RwLock<NetworkState>>,
    candidate: Option<&Arc<crate::edge_candidate::CandidateReply>>,
) {
    let Some(peer) = peers.get_mut(peer_id) else {
        return;
    };
    if !peer.authenticated
        || peer.noise.is_none()
        || peer_id != request.browser_node_id
        || peer.signal_session_id != request.session_id
    {
        return;
    }
    let Some(rebind) = peer.rebind.as_mut() else {
        return;
    };
    let attempt = decode_canonical_array::<64>(&request.attempt_digest).expect("validated attempt");
    let nonce = decode_canonical_array::<32>(&request.client_nonce).expect("validated nonce");
    let Ok(transcript) = merkur_e2e::build_rebind_reconciliation(
        &request.session_id,
        peer_id,
        daemon_id,
        &rebind.lineage_digest,
        request.rebind_counter,
        &attempt,
        &nonce,
    ) else {
        return;
    };
    let predecessor = rebind.counter == request.rebind_counter;
    let proof = if predecessor {
        &request.mac
    } else if rebind.counter == request.rebind_counter + 1 {
        &request.successor_mac
    } else {
        return;
    };
    let mac = decode_canonical_array::<64>(proof).expect("validated MAC");
    if merkur_e2e::verify_rebind_reconciliation_mac(&rebind.secret, &transcript, &mac).is_err() {
        return;
    }
    if predecessor {
        // The proof may cancel only its exact old attempt. A captured query
        // cannot displace a later attempt using the same current generation.
        if rebind
            .in_flight
            .as_ref()
            .is_some_and(|flight| flight.request_digest != attempt)
        {
            return;
        }
        rebind.in_flight = None;
        peer.noise_handshake = None;
    }
    let Ok(mac) = merkur_e2e::compute_rebind_reconciliation_response_mac(
        &rebind.secret,
        &transcript,
        rebind.counter,
    ) else {
        return;
    };
    let response = DaemonSignal::SessionRebindReconciled {
        client_nonce: request.client_nonce.clone(),
        rebind_counter: rebind.counter,
        mac: URL_SAFE_NO_PAD.encode(mac),
    };
    crate::edge_candidate::reply(
        network,
        peer_id,
        candidate,
        response.to_json().into_bytes(),
        !predecessor,
    )
    .await;
}
