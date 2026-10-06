//! Renew reconnect authority while retaining the current session and key chain.

use std::sync::Arc;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use merkur_wire::signaling::{DaemonSignal, SessionRenew};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;

use crate::auth::{DaemonIdentity, SessionAuthority, UserAuthorization, decode_canonical_array};
use crate::connection::PeerMap;
use crate::network::NetworkState;

pub(crate) async fn handle_session_renewal(
    peer_id: &str,
    request: &SessionRenew,
    peers: &mut PeerMap,
    identity: &Option<DaemonIdentity>,
    authority: &Option<SessionAuthority>,
    authorization: &Option<UserAuthorization>,
    network: &Arc<RwLock<NetworkState>>,
    control_link_fresh: bool,
    now_ms: f64,
    candidate: Option<&Arc<crate::edge_candidate::CandidateReply>>,
) {
    let (Some(identity), Some(authority), Some(authorization), Some(peer)) =
        (identity, authority, authorization, peers.get_mut(peer_id))
    else {
        return;
    };
    if !peer.authenticated
        || peer.noise.is_none()
        || peer.signal_session_id != request.session_id
        || peer_id != request.browser_node_id
    {
        return;
    }
    let Some(rebind) = peer.rebind.as_mut() else {
        return;
    };
    let prepared = (|| {
        let nonce = decode_canonical_array::<32>(&request.client_nonce).ok()?;
        let mac = decode_canonical_array::<64>(&request.mac).ok()?;
        let signature = decode_canonical_array::<4627>(&request.delegation_signature).ok()?;
        let certificate = serde_json::to_vec(&*request.delegation_certificate).ok()?;
        let intent = merkur_e2e::build_session_renewal_intent(
            &request.session_id,
            peer_id,
            identity.daemon_id(),
            &rebind.lineage_digest,
            &nonce,
        )
        .ok()?;
        let proof = merkur_e2e::build_session_renewal_delegation_proof(
            &intent,
            &request.session_token,
            &certificate,
        )
        .ok()?;
        let transcript = merkur_e2e::build_session_renewal_request_transcript(
            &proof,
            &signature,
            request.rebind_counter,
        )
        .ok()?;
        // Neither invalid proofs nor stale generations consume the lineage or
        // drive public-key verification. Only its current holder can renew it.
        merkur_e2e::verify_session_renewal_request_mac(&rebind.secret, &transcript, &mac).ok()?;
        Some((intent, transcript, signature))
    })();
    let Some((intent, transcript, signature)) = prepared else {
        return;
    };
    if request.rebind_counter != rebind.counter {
        return;
    }
    let validated = (|| {
        if !control_link_fresh {
            return None;
        }
        let capability = authority
            .validate(
                &request.session_token,
                peer_id,
                &request.session_id,
                authorization.user_id(),
                &peer.delegation_id,
            )
            .ok()?;
        let commitment = merkur_e2e::compute_session_renewal_commitment(&intent).ok()?;
        if !identity.key_hash_matches(&capability.daemon_identity_key_hash)
            || !bool::from(commitment.ct_eq(&capability.request_commitment))
        {
            return None;
        }
        authorization
            .authorize_renewal(
                &request.delegation_certificate,
                &peer.delegation_id,
                &intent,
                &request.session_token,
                &signature,
            )
            .ok()?;
        let wall_ms = crate::auth::unix_time_ms().ok()?;
        rebind
            .authorization
            .renew(
                capability.expires_at_ms,
                request.delegation_certificate.expires_at,
                commitment,
                rebind.counter,
                wall_ms,
                now_ms,
            )
            .then_some(())
    })();
    let accepted = validated.is_some();
    let (expires_at_ms, generation_base) = if accepted {
        (
            rebind.authorization.expires_at_ms,
            rebind.authorization.generation_base,
        )
    } else {
        (0, 0)
    };
    let Ok(mac) = merkur_e2e::compute_session_renewal_response_mac(
        &rebind.secret,
        &transcript,
        expires_at_ms,
        generation_base,
        accepted,
    ) else {
        return;
    };
    let response = DaemonSignal::SessionRenewed {
        client_nonce: request.client_nonce.clone(),
        rebind_counter: request.rebind_counter,
        accepted,
        expires_at_ms,
        generation_base,
        mac: URL_SAFE_NO_PAD.encode(mac),
    };
    // Repeating this exact capability returns the same epoch even after a key
    // cut. Lost replies therefore require no extra state or authorization grant.
    crate::edge_candidate::reply(
        network,
        peer_id,
        candidate,
        response.to_json().into_bytes(),
        false,
    )
    .await;
}
