//! One-response post-quantum session authentication: server ML-DSA capability,
//! composite daemon ML-DSA/P-256 identity, ephemeral browser ML-KEM-1024, resume splice,
//! and pre-Noise secret publication.

use std::sync::Arc;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use merkur_wire::signaling::{DaemonSignal, SessionAuth};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::auth::{
    DaemonIdentity, PendingSessionRequest, SessionAuthority, UserAuthorization,
    decode_canonical_array,
};
use crate::connection::{PeerDisplayState, PeerMap, PeerTransport};
use crate::ipc::events::*;
use crate::network::{self, NetworkState};
use crate::pty::TerminalState;
use crate::send_json_event;
use crate::session::policy::SessionPolicy;
use crate::session::resume::ParkedPeers;
use crate::session::wt_upgrade_flow::emit_webtransport_manifest;
use crate::webtransport::{self, WebTransportState};

const SESSION_NONCE_BYTES: usize = merkur_e2e::SESSION_NONCE_BYTES;
const ML_KEM_KEY_BYTES: usize = merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES;

pub(crate) async fn handle_session_auth(
    effective_peer_id: &Arc<str>,
    message: &SessionAuth,
    session_authority: &Option<SessionAuthority>,
    user_authorization: &Option<UserAuthorization>,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    _event_tx: &EventSink,
    peers: &mut PeerMap,
    terminal: &TerminalState,
    now_ms: f64,
    daemon_identity: &Option<DaemonIdentity>,
    pending_request: Option<&PendingSessionRequest>,
    parked: &mut ParkedPeers,
    daemon_static: &[u8],
    identity_completion_tx: &tokio::sync::mpsc::Sender<IdentitySignDone>,
) -> bool {
    // The peer map is keyed by this exact allocation, which the peer also
    // carries as `peer_id`; every other use below only reads the id.
    let peer_key = Arc::clone(effective_peer_id);
    let effective_peer_id: &str = effective_peer_id;
    let Some(authority) = session_authority.as_ref() else {
        warn!(
            peer = effective_peer_id,
            "session auth authority is not configured"
        );
        return false;
    };
    let Some(daemon_identity) = daemon_identity.as_ref() else {
        warn!(
            peer = effective_peer_id,
            "daemon identity is not configured"
        );
        return false;
    };
    let Some(user_authorization) = user_authorization.as_ref() else {
        warn!(
            peer = effective_peer_id,
            "user-root authorization is not configured"
        );
        return false;
    };
    let Some(pending_request) = pending_request else {
        warn!(peer = effective_peer_id, "no pending server session offer");
        return false;
    };

    // The envelope check admitted every field at its exact canonical length.
    let token = message.session_token.as_str();
    let session_id = message.session_id.as_str();
    let client_nonce = decode_canonical_array::<SESSION_NONCE_BYTES>(&message.client_nonce)
        .expect("validated client nonce");
    let encapsulation_key = decode_canonical_array::<ML_KEM_KEY_BYTES>(&message.encapsulation_key)
        .expect("validated encapsulation key");
    let certificate = &*message.delegation_certificate;
    let delegation_signature = message.delegation_signature.as_str();
    // The control-plane offer match is deliberately first. An edge peer cannot
    // force ML-DSA verification or ML-KEM work with a tuple the server did not
    // durably issue to this daemon.
    if !pending_request.matches(session_id, &client_nonce, &encapsulation_key) {
        return reject_session_auth(network_state, effective_peer_id, "session offer mismatch")
            .await;
    }

    let request_transcript = match merkur_e2e::build_session_request_transcript(
        token.as_bytes(),
        session_id,
        effective_peer_id,
        daemon_identity.daemon_id(),
        &client_nonce,
        &encapsulation_key,
    ) {
        Ok(transcript) => transcript,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "session request transcript rejected");
            return reject_session_auth(network_state, effective_peer_id, "invalid transcript")
                .await;
        }
    };

    // Noise message 1 rides this flight, so it must be inside what the delegate
    // signature covers. The PREAMBLE above is what the prologue binds — message
    // 1 cannot be written until the prologue exists, so the two digests are
    // necessarily distinct.
    let Ok(noise_msg1) = crate::auth::decode_canonical_bytes(&message.noise_msg1) else {
        warn!(peer = effective_peer_id, "session auth missing noise msg1");
        return reject_session_auth(network_state, effective_peer_id, "invalid transcript").await;
    };
    let bound_request_transcript =
        match merkur_e2e::bind_session_request_msg1(&request_transcript, &noise_msg1) {
            Ok(bound) => bound,
            Err(error) => {
                warn!(peer = effective_peer_id, %error, "session msg1 binding rejected");
                return reject_session_auth(network_state, effective_peer_id, "invalid transcript")
                    .await;
            }
        };

    let validated = match authority.validate(
        token,
        effective_peer_id,
        session_id,
        pending_request.user_id(),
        pending_request.delegation_id(),
    ) {
        Ok(validated) => validated,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "ML-DSA session token rejected");
            return reject_session_auth(network_state, effective_peer_id, "invalid session token")
                .await;
        }
    };

    let delegation_authorization_digest = match user_authorization.authorize_session(
        certificate,
        pending_request.user_id(),
        pending_request.delegation_id(),
        &bound_request_transcript,
        delegation_signature,
    ) {
        Ok(digest) => digest,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "browser delegation proof rejected");
            return reject_session_auth(
                network_state,
                effective_peer_id,
                "invalid delegation proof",
            )
            .await;
        }
    };

    let request_commitment =
        match merkur_e2e::compute_session_request_commitment(&client_nonce, &encapsulation_key) {
            Ok(commitment) => commitment,
            Err(error) => {
                warn!(peer = effective_peer_id, %error, "request commitment rejected");
                return reject_session_auth(network_state, effective_peer_id, "invalid session")
                    .await;
            }
        };
    if !daemon_identity.key_hash_matches(&validated.daemon_identity_key_hash)
        || !bool::from(request_commitment.ct_eq(&validated.request_commitment))
    {
        return reject_session_auth(
            network_state,
            effective_peer_id,
            "capability binding mismatch",
        )
        .await;
    }
    if !daemon_identity.claim_request_commitment(request_commitment) {
        return reject_session_auth(network_state, effective_peer_id, "replayed session request")
            .await;
    }

    // The public key now matches both the durable control offer and the signed
    // q claim. Encapsulate exactly once with fresh entropy.
    let encapsulation_randomness = match daemon_identity
        .generate_random::<{ merkur_e2e::ML_KEM_ENCAPS_RANDOM_BYTES }>()
    {
        Ok(randomness) => randomness,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "ML-KEM randomness unavailable");
            return reject_session_auth(network_state, effective_peer_id, "authentication failed")
                .await;
        }
    };
    let server_encapsulation = match merkur_e2e::SessionServerEncapsulation::new(
        &encapsulation_key,
        encapsulation_randomness,
    ) {
        Ok(encapsulation) => encapsulation,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "ML-KEM encapsulation rejected");
            return reject_session_auth(network_state, effective_peer_id, "invalid session key")
                .await;
        }
    };
    let ciphertext = *server_encapsulation.ciphertext();
    let daemon_nonce = match daemon_identity.generate_random::<SESSION_NONCE_BYTES>() {
        Ok(nonce) => nonce,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "daemon nonce randomness unavailable");
            return reject_session_auth(network_state, effective_peer_id, "authentication failed")
                .await;
        }
    };

    // A successor hybrid exchange is a hard carrier-lineage cut. Remove the
    // direct-WT registry owner before clearing/replacing the peer's Noise and
    // upgrade secrets; queued frames from that connection then fail the exact
    // connection-generation check in the run loop.
    if let Some(wt) = wt_state.as_ref() {
        webtransport::remove_peer(wt, effective_peer_id).await;
    }

    let preserved = peers.remove(&peer_key).or_else(|| parked.take(&peer_key));
    let had_preserved_state = preserved.is_some();
    let mut peer = splice_resumed_peer(
        preserved,
        &peer_key,
        effective_peer_id,
        validated.session_id.clone(),
        validated.delegation_id.clone(),
        terminal,
        now_ms,
    );
    // The address the edge proved on the browser's signaling connection, never
    // one a browser asserted. It decides where manifest punches are aimed, so a
    // session-token holder must not be able to choose it: the relay observes a
    // QUIC path the browser itself validated. When the edge has not reported it
    // yet, the manifest waits for that report rather than guessing.
    peer.browser_address =
        crate::network::signaling_browser_address(network_state, effective_peer_id).await;
    if !had_preserved_state {
        peer.has_receiver_ack = false;
    }
    let next_expected_input_seq = peer.keystroke_next_expected_seq;

    // Bound to the WHOLE request, message 1 included.
    let prologue_digest = match merkur_e2e::hash_session_request_transcript(&request_transcript) {
        Ok(hash) => hash,
        Err(_) => {
            crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
            return reject_session_auth(network_state, effective_peer_id, "invalid transcript")
                .await;
        }
    };
    let prologue =
        crate::e2e::derive_prologue(session_id, daemon_identity.daemon_id(), &prologue_digest);
    let (noise_pending, noise_msg2) =
        match merkur_e2e::PendingNoiseResponder::start(daemon_static, &prologue, &noise_msg1) {
            Ok(prepared) => prepared,
            Err(_) => {
                crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
                return reject_session_auth(network_state, effective_peer_id, "invalid handshake")
                    .await;
            }
        };
    let response_transcript = match merkur_e2e::build_session_response_transcript(
        &bound_request_transcript,
        &delegation_authorization_digest,
        &daemon_nonce,
        &ciphertext,
        next_expected_input_seq,
        &noise_msg2,
    ) {
        Ok(transcript) => transcript,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "session response transcript rejected");
            crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
            return reject_session_auth(network_state, effective_peer_id, "invalid transcript")
                .await;
        }
    };
    let receiver = match daemon_identity.request_signature(
        merkur_e2e::DAEMON_IDENTITY_SIGNATURE_CONTEXT,
        response_transcript.clone(),
    ) {
        Ok(receiver) => receiver,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "daemon response signing admission failed");
            crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
            return reject_session_auth(network_state, effective_peer_id, "authentication failed")
                .await;
        }
    };
    let token = Arc::new(());
    let completed_token = Arc::clone(&token);
    let completed_peer = Arc::clone(&peer_key);
    let completion_tx = identity_completion_tx.clone();
    let task = tokio::spawn(async move {
        let result = receiver
            .await
            .unwrap_or(Err(crate::identity_seal::SealError::Closed));
        let _ = completion_tx
            .send(IdentitySignDone {
                peer_id: completed_peer,
                token: completed_token,
                result,
            })
            .await;
    });
    peer.authenticated = false;
    peer.auth_timeout_at_ms = Some(now_ms + SessionPolicy::session_auth_timeout_ms());
    peer.pending_identity_signature = Some(Box::new(PendingIdentitySignature {
        token,
        task,
        ingress: None,
        draft: Some(ResponseDraft {
            authorization: crate::session::authorization_epoch::AuthorizationEpoch::new(
                validated.expires_at_ms.min(certificate.expires_at),
                validated.request_commitment,
                crate::auth::unix_time_ms().unwrap_or(u64::MAX),
                now_ms,
            ),
            response_transcript,
            noise_pending,
            server_encapsulation,
            daemon_nonce,
            ciphertext,
            next_expected_input_seq,
            noise_msg2,
            browser_node_id: validated.browser_node_id,
            session_id: validated.session_id,
        }),
    }));
    peers.insert(Arc::clone(&peer_key), peer);
    false
}

pub(crate) struct IdentitySignDone {
    pub peer_id: Arc<str>,
    token: Arc<()>,
    result: Result<crate::identity_signer::SignaturePair, crate::identity_seal::SealError>,
}

impl IdentitySignDone {
    pub(crate) fn matches(&self, pending: &PendingIdentitySignature) -> bool {
        Arc::ptr_eq(&pending.token, &self.token)
    }
}

struct ResponseDraft {
    authorization: crate::session::authorization_epoch::AuthorizationEpoch,
    response_transcript: Vec<u8>,
    noise_pending: merkur_e2e::AwaitingNoisePsk,
    server_encapsulation: merkur_e2e::SessionServerEncapsulation,
    daemon_nonce: [u8; SESSION_NONCE_BYTES],
    ciphertext: [u8; merkur_e2e::ML_KEM_CIPHERTEXT_BYTES],
    next_expected_input_seq: u32,
    noise_msg2: Vec<u8>,
    browser_node_id: String,
    session_id: String,
}

pub(crate) struct PendingIdentitySignature {
    token: Arc<()>,
    task: tokio::task::JoinHandle<()>,
    pub ingress: Option<crate::network::peer::EdgeIngressIdentity>,
    draft: Option<ResponseDraft>,
}
impl Drop for PendingIdentitySignature {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) async fn finish_identity_signature(
    completion: IdentitySignDone,
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    event_tx: &EventSink,
    peers: &mut PeerMap,
    parked: &mut ParkedPeers,
    now_ms: f64,
    _daemon_static: &[u8],
) -> bool {
    let peer_key = Arc::clone(&completion.peer_id);
    let effective_peer_id: &str = &peer_key;
    let Some(current) = peers.get(effective_peer_id) else {
        return false;
    };
    if !current
        .pending_identity_signature
        .as_ref()
        .is_some_and(|pending| completion.matches(pending))
    {
        return false;
    }
    let mut peer = peers
        .remove(effective_peer_id)
        .expect("pending peer is present");
    let mut pending = peer
        .pending_identity_signature
        .take()
        .expect("pending identity is present");
    if peer
        .auth_timeout_at_ms
        .is_none_or(|deadline| now_ms >= deadline)
    {
        crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
        return false;
    }
    let ResponseDraft {
        authorization,
        response_transcript,
        noise_pending,
        server_encapsulation,
        daemon_nonce,
        ciphertext,
        next_expected_input_seq,
        noise_msg2,
        browser_node_id,
        session_id,
    } = pending.draft.take().expect("one completion owns draft");
    let pair = match completion.result {
        Ok(pair) => pair,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "daemon response signing failed");
            crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
            return reject_session_auth(network_state, effective_peer_id, "authentication failed")
                .await;
        }
    };
    let daemon_signature = pair.mldsa;
    let session_secrets = match server_encapsulation
        .complete(&daemon_signature, &response_transcript)
    {
        Ok(secrets) => secrets,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "session secret combiner failed");
            crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
            return reject_session_auth(network_state, effective_peer_id, "authentication failed")
                .await;
        }
    };
    let session_secrets = match session_secrets
        .bind_noise(noise_pending.checkpoint(), &response_transcript)
    {
        Ok(secrets) => secrets,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "hybrid session combiner failed");
            crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
            return reject_session_auth(network_state, effective_peer_id, "authentication failed")
                .await;
        }
    };
    let handshake = match noise_pending.install_psk(session_secrets.noise_psk()) {
        Ok(handshake) => handshake,
        Err(error) => {
            warn!(peer = effective_peer_id, %error, "session PSK installation failed");
            crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
            return reject_session_auth(network_state, effective_peer_id, "authentication failed")
                .await;
        }
    };

    peer.authenticated = true;
    peer.clear_hybrid_secret_material();
    peer.upgrade_secret = Some(*session_secrets.direct_upgrade_secret());
    peer.noise = None;
    peer.noise_handshake = Some(crate::connection::PendingNoiseHandshake::new(handshake));
    peer.auth_timeout_at_ms = Some(now_ms + SessionPolicy::session_auth_timeout_ms());

    // Open a fresh rebind lineage. This authentication is its genesis, so the
    // generation counter starts at zero and the lineage digest — which every
    // later generation's transcript binds — commits to the exact ML-DSA-signed
    // response that authorized it.
    peer.clear_rebind_material();
    match crate::e2e::compute_rebind_lineage_digest(&response_transcript) {
        Ok(lineage_digest) => {
            peer.rebind = Some(crate::connection::RebindState {
                secret: *session_secrets.rebind_secret(),
                counter: 0,
                lineage_digest,
                genesis_at_ms: now_ms,
                authorization,
                in_flight: None,
                pending_refusal: None,
            });
        }
        Err(error) => {
            // Not fatal: the session is fully authenticated and usable. It
            // simply cannot take the fast reconnect path, and falls back to the
            // ordinary fresh-authentication reconnect it uses today.
            warn!(peer = effective_peer_id, %error, "rebind lineage unavailable");
        }
    }

    let ready = DaemonSignal::SessionReady {
        daemon_nonce: URL_SAFE_NO_PAD.encode(daemon_nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        next_expected_input_seq: next_expected_input_seq.into(),
        daemon_signature: URL_SAFE_NO_PAD.encode(daemon_signature),
        p256_signature: URL_SAFE_NO_PAD.encode(pair.p256),
        noise_msg2: URL_SAFE_NO_PAD.encode(&noise_msg2),
    };
    if !network::send_signaling_to_peer(
        network_state,
        effective_peer_id,
        ready.to_json().into_bytes(),
    )
    .await
    {
        warn!(
            peer = effective_peer_id,
            session_id, "session_ready reliable admission rejected"
        );
        crate::session::resume::park_disconnected_peer(parked, peer, now_ms);
        return false;
    }
    peers.insert(Arc::clone(&peer_key), peer);

    info!(
        peer = effective_peer_id,
        session_id, "peer authenticated by composite ML-DSA/P-256 identity and ML-KEM bootstrap"
    );
    send_json_event(
        event_tx,
        EVT_PEER_AUTHENTICATED,
        &PeerAuthenticatedEvt {
            peer_node_id: effective_peer_id.to_string(),
            browser_node_id,
            session_id,
        },
    );
    // One side of the manifest's join: authentication is complete. The edge's
    // report may have arrived while the signature was in flight; if it has not
    // arrived yet, the report's own arrival sends the manifest.
    let browser_address =
        crate::network::signaling_browser_address(network_state, effective_peer_id).await;
    if let Some(peer) = peers.get_mut(effective_peer_id) {
        if browser_address.is_some() {
            peer.browser_address = browser_address;
        }
        emit_webtransport_manifest(wt_state, network_state, peer, None).await;
    }
    true
}

/// Revive display/input state after a fresh hybrid exchange. Every
/// connection-specific key, transcript, tunnel, reorder buffer, and dictionary
/// capability is reset; only terminal-view state and input sequence continuity
/// may cross the reconnect boundary.
///
/// Every carrier the preserved peer held is dead, exactly as on a rebind, and
/// the peer may come straight from the live map: the daemon holds a peer whose
/// paths all went down for a rebind rather than parking it. So it crosses the
/// same carrier boundary as `splice_rebound_peer`. Without it, a preparation
/// whose reply the dead carrier could never deliver, a repair armed against
/// it, rows in flight on it, and its recorded block all survived into the new
/// session, and a phone back from the background got no snapshot, or kept a
/// row it had lost, for as long as those lasted.
pub(crate) fn splice_resumed_peer(
    preserved: Option<PeerDisplayState>,
    peer_key: &Arc<str>,
    effective_peer_id: &str,
    session_id: String,
    delegation_id: String,
    terminal: &TerminalState,
    now_ms: f64,
) -> PeerDisplayState {
    let preserved_input_seq = preserved.as_ref().map(|p| p.keystroke_next_expected_seq);
    let preserved_queued_input_seq = preserved.as_ref().map(|p| p.keystroke_next_queued_seq);
    let mut disowned_rows = 0;
    let mut peer = match preserved {
        Some(mut p)
            if p.display_cache.initialized
                && p.display_cache.cols == terminal.cols
                && p.display_cache.rows == terminal.rows =>
        {
            if p.cancel_display_prepare() {
                p.needs_full_diff = true;
            }
            disowned_rows = p.carrier_boundary();
            p
        }
        _ => PeerDisplayState::new(Arc::clone(peer_key), PeerTransport::Edge),
    };
    let cache_usable = peer.display_cache.initialized
        && peer.display_cache.cols == terminal.cols
        && peer.display_cache.rows == terminal.rows;

    peer.authenticated = true;
    peer.signal_session_id = session_id;
    peer.delegation_id = delegation_id;
    peer.auth_timeout_at_ms = None;
    peer.backpressure_score = 0;
    peer.noise = None;
    peer.noise_handshake = None;
    peer.clear_hybrid_secret_material();
    if let Some(tunnel) = peer.edge_tunnel.take() {
        tunnel.close();
    }
    peer.reset_fec_evidence(PeerTransport::Edge);
    peer.reset_fec_evidence(PeerTransport::WebTransport);
    if let Some(tunnel) = peer.edge_tunnel_bulk.take() {
        tunnel.close();
    }
    peer.bulk_delivery_confirmed = false;
    peer.data_attachment_nonces = [None; 2];
    // A successor hybrid exchange mints its own lineage a few lines later; a
    // preserved peer must not carry the predecessor's into it.
    peer.clear_rebind_material();
    if let Some(seq) = preserved_input_seq {
        peer.keystroke_next_expected_seq = seq;
    }
    if let Some(seq) = preserved_queued_input_seq {
        peer.keystroke_next_queued_seq = seq;
    }
    peer.keystroke_reorder_buf.clear();
    peer.reliable_inputs.clear();
    peer.keystroke_reorder_bytes = 0;
    // A successor session opens a fresh input-sequence domain, so the confirmed
    // high-water starts over even when the display cache is spliced back.
    // `last_advertised_input_seq` is deliberately left alone: the mismatch it
    // now has against zero is what makes the first post-resume flush emit the
    // header-only frame that releases the browser's prediction barrier.
    peer.latest_input_seq = 0;
    // A fresh authenticated session may come from a replacement browser worker.
    // Its viewport serial starts independently; carrier rebind does not splice.
    peer.last_resize_seq = 0;
    // An ack queued this turn names a seq from the domain that just ended; the
    // flush at the bottom of the turn must not send it into the new one.
    peer.pending_input_ack = None;
    peer.snapshot_retry_at_ms = 0.0;
    peer.snapshot_consecutive_failures = 0;
    peer.display_dictionary_ready = false;
    peer.dictionary.reset();

    let prior_edge_rtt = peer.paths.edge.rtt_ewma_ms;
    let prior_edge_network_rtt = peer.paths.edge.network_rtt_ewma_ms;
    let prior_edge_network_jitter = peer.paths.edge.network_jitter_ewma_ms;
    let prior_edge_jitter = peer.paths.edge.jitter_ewma_ms;
    peer.paths.edge = crate::connection::PathHealth::fresh_available(now_ms);
    peer.paths.edge.rtt_ewma_ms = prior_edge_rtt;
    peer.paths.edge.network_rtt_ewma_ms = prior_edge_network_rtt;
    peer.paths.edge.network_jitter_ewma_ms = prior_edge_network_jitter;
    peer.paths.edge.jitter_ewma_ms = prior_edge_jitter;
    peer.paths.webtransport = crate::connection::PathHealth::dormant();

    if cache_usable {
        peer.needs_snapshot = false;
        peer.awaiting_resume_until_ms = Some(
            now_ms + SessionPolicy::awaiting_resume_timeout_ms(prior_edge_rtt, prior_edge_jitter),
        );
        info!(
            peer = effective_peer_id,
            generation = peer.generation,
            cols = peer.display_cache.cols,
            rows = peer.display_cache.rows,
            disowned_rows,
            "hybrid-authenticated peer resumed display cache"
        );
    } else {
        peer.display_cache.reset_for_snapshot();
        peer.needs_snapshot = true;
        peer.awaiting_resume_until_ms = None;
        info!(
            peer = effective_peer_id,
            "hybrid-authenticated peer requires snapshot"
        );
    }
    peer
}

pub(crate) fn is_authenticated_peer(peers: &PeerMap, peer_id: &str) -> bool {
    peers.get(peer_id).is_some_and(|peer| peer.authenticated)
}

async fn reject_session_auth(
    network_state: &Arc<RwLock<NetworkState>>,
    peer_id: &str,
    diagnostic: &str,
) -> bool {
    warn!(
        peer = peer_id,
        reason = diagnostic,
        "hybrid session authentication rejected"
    );
    let reject = DaemonSignal::AuthFailed {
        reason: "session_rejected".into(),
    };
    network::send_signaling_to_peer(network_state, peer_id, reject.to_json().into_bytes()).await;
    false
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::auth::{DaemonBinding, DelegationCertificate};
    use crate::edge_tunnel::{EdgeConfig, EdgeTunnel};
    use crate::ipc::events::test_capturing_event_sink;
    use crate::network::peer::{ChannelPeerConnection, ChannelSenders, EdgeIngressIdentity};
    use crate::webtransport::{CertState, pairing, stun};
    use libcrux_ml_dsa::ml_dsa_87;
    use merkur_wire::signaling::{ClientSignal, SessionRenew};
    use sha2::{Digest, Sha512};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const USER_ID: &str = "auth-queue-user";
    const DELEGATION_ID: &str = "auth-queue-delegation";
    const BROWSER_ID: &str = "auth-queue-browser";
    const DAEMON_ID: &str = "auth-queue-daemon";
    const SESSION_ID: &str = "auth-queue-session";
    const SERVER_ORIGIN: &str = "https://merkur.example";
    const DELEGATION_LIFETIME_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TestDaemonBindingPayload<'a> {
        user_id: &'a str,
        root_key_commitment: &'a str,
        daemon_id: &'a str,
        daemon_identity_key_commitment: &'a str,
        server_origin: &'a str,
        link_claim_id: &'a str,
        issued_at: u64,
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TestDelegationPayload<'a> {
        user_id: &'a str,
        root_key_commitment: &'a str,
        delegation_id: &'a str,
        delegate_public_key: &'a str,
        scopes: &'a [String; 2],
        server_origin: &'a str,
        root_epoch: u64,
        issued_at: u64,
        expires_at: u64,
    }

    /// A BSD-derived range, so a test reading the union by mistake would fail.

    #[derive(serde::Serialize)]
    struct TestSessionTokenPayload<'a> {
        u: &'a str,
        g: &'a str,
        b: &'a str,
        d: &'a str,
        s: &'a str,
        k: &'a str,
        q: &'a str,
        iat: u64,
        e: u64,
    }

    struct SessionAuthFixture {
        message: SessionAuth,
        authority: SessionAuthority,
        authorization: UserAuthorization,
        identity: DaemonIdentity,
        pending: PendingSessionRequest,
        request_commitment: [u8; merkur_e2e::SESSION_COMMITMENT_BYTES],
    }

    fn direct_wt_state(peer_id: &str) -> Arc<RwLock<WebTransportState>> {
        let mut state = WebTransportState::new(
            CertState {
                cert_hash: [0; 32],
                created_at: Instant::now(),
                valid_for: Duration::from_secs(60),
            },
            443,
            Vec::new(),
            pairing::NatSignature {
                public_ip: None,
                nat_type: pairing::NatTypeLabel::None,
                hairpin: false,
            },
            stun::NatMapping::Unknown,
            None,
        );
        let (ctrl, _) = tokio::sync::mpsc::channel(1);
        let (pty, _) = tokio::sync::mpsc::channel(1);
        let (display_commit, _) = tokio::sync::mpsc::channel(1);
        state.peer_connections.insert(
            peer_id.to_string(),
            ChannelPeerConnection {
                senders: ChannelSenders {
                    ctrl,
                    pty,
                    display_commit,
                    signaling: None,
                },
                connection_id: 41,
            },
        );
        Arc::new(RwLock::new(state))
    }

    /// A real X25519 static for the daemon's responder, which the fused
    /// `session_ready` now builds.
    fn test_static() -> Vec<u8> {
        merkur_e2e::generate_static_keypair()
            .expect("static keypair")
            .0
    }

    fn session_auth_fixture() -> SessionAuthFixture {
        session_auth_fixture_with_policy(false, false)
    }

    fn session_auth_fixture_with_policy(revoked: bool, expired: bool) -> SessionAuthFixture {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock after Unix epoch")
            .as_millis() as u64;
        let issued_at = now_ms.saturating_sub(1_000);

        let root = ml_dsa_87::generate_key_pair([0x11; 32]);
        let delegate = ml_dsa_87::generate_key_pair([0x22; 32]);
        let root_public_key = *root.verification_key.as_ref();
        let delegate_public_key = *delegate.verification_key.as_ref();
        let root_public_key_b64 = URL_SAFE_NO_PAD.encode(root_public_key);
        let delegate_public_key_b64 = URL_SAFE_NO_PAD.encode(delegate_public_key);

        let mut root_commitment_hash = Sha512::new();
        root_commitment_hash.update(b"merkur-user-root-key\0");
        root_commitment_hash.update(root_public_key);
        let root_commitment: [u8; merkur_e2e::SESSION_COMMITMENT_BYTES] =
            root_commitment_hash.finalize().into();
        let root_commitment_b64 = URL_SAFE_NO_PAD.encode(root_commitment);

        let identity = DaemonIdentity::new(
            &URL_SAFE_NO_PAD.encode([0x33; merkur_e2e::DAEMON_IDENTITY_SEED_BYTES]),
            DAEMON_ID,
        )
        .expect("daemon identity fixture");
        let daemon_commitment_b64 = URL_SAFE_NO_PAD.encode(identity.public_key_hash());

        let binding_payload = TestDaemonBindingPayload {
            user_id: USER_ID,
            root_key_commitment: &root_commitment_b64,
            daemon_id: DAEMON_ID,
            daemon_identity_key_commitment: &daemon_commitment_b64,
            server_origin: SERVER_ORIGIN,
            link_claim_id: "auth-queue-link",
            issued_at,
        };
        let binding_tbs = serde_json::to_vec(&binding_payload).expect("binding payload");
        let binding_signature = ml_dsa_87::sign(
            &root.signing_key,
            &binding_tbs,
            b"merkur-daemon-binding",
            [0x44; 32],
        )
        .expect("binding signature");
        let binding: DaemonBinding = serde_json::from_value(serde_json::json!({
            "userId": USER_ID,
            "rootKeyCommitment": root_commitment_b64,
            "daemonId": DAEMON_ID,
            "daemonIdentityKeyCommitment": daemon_commitment_b64,
            "serverOrigin": SERVER_ORIGIN,
            "linkClaimId": "auth-queue-link",
            "issuedAt": issued_at,
            "signature": URL_SAFE_NO_PAD.encode(binding_signature.as_ref()),
        }))
        .expect("binding fixture");
        let revoked_delegations = if revoked {
            vec![crate::auth::RevocationTarget {
                delegation_id: DELEGATION_ID.to_string(),
                expires_at: issued_at + DELEGATION_LIFETIME_MS,
            }]
        } else {
            Vec::new()
        };
        let authorization = UserAuthorization::new(
            &root_public_key_b64,
            1,
            SERVER_ORIGIN,
            &binding,
            DAEMON_ID,
            &identity.public_key_hash(),
            &revoked_delegations,
        )
        .expect("user authorization fixture");

        let issued_at = if expired {
            now_ms - DELEGATION_LIFETIME_MS - 1_000
        } else {
            issued_at
        };
        let scopes = ["terminal-session".to_string(), "session-revoke".to_string()];
        let delegation_payload = TestDelegationPayload {
            user_id: USER_ID,
            root_key_commitment: &root_commitment_b64,
            delegation_id: DELEGATION_ID,
            delegate_public_key: &delegate_public_key_b64,
            scopes: &scopes,
            server_origin: SERVER_ORIGIN,
            root_epoch: 1,
            issued_at,
            expires_at: issued_at + DELEGATION_LIFETIME_MS,
        };
        let delegation_tbs = serde_json::to_vec(&delegation_payload).expect("delegation payload");
        let certificate_signature = ml_dsa_87::sign(
            &root.signing_key,
            &delegation_tbs,
            b"merkur-browser-delegation",
            [0x55; 32],
        )
        .expect("certificate signature");
        let certificate: DelegationCertificate = serde_json::from_value(serde_json::json!({
            "userId": USER_ID,
            "rootKeyCommitment": root_commitment_b64,
            "delegationId": DELEGATION_ID,
            "delegatePublicKey": delegate_public_key_b64,
            "scopes": scopes,
            "serverOrigin": SERVER_ORIGIN,
            "rootEpoch": 1,
            "issuedAt": issued_at,
            "expiresAt": issued_at + DELEGATION_LIFETIME_MS,
            "signature": URL_SAFE_NO_PAD.encode(certificate_signature.as_ref()),
        }))
        .expect("delegation certificate fixture");

        let client =
            merkur_e2e::SessionClientBootstrap::new([0x66; merkur_e2e::ML_KEM_KEYGEN_SEED_BYTES]);
        let client_nonce = [0x77; merkur_e2e::SESSION_NONCE_BYTES];
        let encapsulation_key = *client.encapsulation_key();
        let request_commitment =
            merkur_e2e::compute_session_request_commitment(&client_nonce, &encapsulation_key)
                .expect("request commitment");
        let request_commitment_b64 = URL_SAFE_NO_PAD.encode(request_commitment);
        let token_payload = TestSessionTokenPayload {
            u: USER_ID,
            g: DELEGATION_ID,
            b: BROWSER_ID,
            d: DAEMON_ID,
            s: SESSION_ID,
            k: &daemon_commitment_b64,
            q: &request_commitment_b64,
            iat: issued_at,
            e: now_ms + 60_000,
        };
        let token_payload_bytes = serde_json::to_vec(&token_payload).expect("token payload");
        let token_payload_b64 = URL_SAFE_NO_PAD.encode(token_payload_bytes);
        let token_signature = ml_dsa_87::sign(
            &root.signing_key,
            token_payload_b64.as_bytes(),
            b"merkur-session-authorization",
            [0x88; 32],
        )
        .expect("session token signature");
        let token = format!(
            "{token_payload_b64}.{}",
            URL_SAFE_NO_PAD.encode(token_signature.as_ref())
        );
        let authority = SessionAuthority::new(&root_public_key_b64, DAEMON_ID)
            .expect("session authority fixture");
        let pending = PendingSessionRequest::from_encoded(
            USER_ID,
            DELEGATION_ID,
            SESSION_ID,
            &URL_SAFE_NO_PAD.encode(client_nonce),
            &URL_SAFE_NO_PAD.encode(encapsulation_key),
        )
        .expect("pending request fixture");

        let request_transcript = merkur_e2e::build_session_request_transcript(
            token.as_bytes(),
            SESSION_ID,
            BROWSER_ID,
            DAEMON_ID,
            &client_nonce,
            &encapsulation_key,
        )
        .expect("request transcript");
        // A REAL message 1, written against the preamble prologue exactly as the
        // browser does — the daemon now reads it inside the fused flight, so
        // arbitrary bytes would fail the responder rather than the property
        // under test.
        let prologue_digest = merkur_e2e::hash_session_request_transcript(&request_transcript)
            .expect("prologue digest");
        let prologue = merkur_e2e::derive_prologue(SESSION_ID, DAEMON_ID, &prologue_digest);
        let (browser_static, _) =
            merkur_e2e::generate_static_keypair().expect("browser static keypair");
        let (_pending_initiator, noise_msg1) =
            merkur_e2e::PendingNoiseInitiator::start(&browser_static, &prologue)
                .expect("pending initiator");
        // The delegate signature covers `preamble || msg1`, because message 1
        // rides the same flight as the signature over it.
        let bound_request_transcript =
            merkur_e2e::bind_session_request_msg1(&request_transcript, &noise_msg1)
                .expect("bound request transcript");
        let certificate_json = serde_json::to_vec(&certificate).expect("canonical certificate");
        let proof_transcript = merkur_e2e::build_session_delegation_proof_transcript(
            &bound_request_transcript,
            &certificate_json,
        )
        .expect("delegation proof transcript");
        let delegation_signature = ml_dsa_87::sign(
            &delegate.signing_key,
            &proof_transcript,
            merkur_e2e::SESSION_DELEGATION_SIGNATURE_CONTEXT,
            [0x99; 32],
        )
        .expect("delegation proof signature");

        SessionAuthFixture {
            message: SessionAuth {
                session_token: token,
                session_id: SESSION_ID.into(),
                client_nonce: URL_SAFE_NO_PAD.encode(client_nonce),
                encapsulation_key: URL_SAFE_NO_PAD.encode(encapsulation_key),
                delegation_certificate: Box::new(certificate),
                delegation_signature: URL_SAFE_NO_PAD.encode(delegation_signature.as_ref()),
                noise_msg1: URL_SAFE_NO_PAD.encode(&noise_msg1),
            },
            authority,
            authorization,
            identity,
            pending,
            request_commitment,
        }
    }

    fn renewal_envelope(
        certificate: &DelegationCertificate,
        identity: &DaemonIdentity,
        secret: &[u8; 64],
        counter: u64,
        expiry: u64,
    ) -> (SessionRenew, Vec<u8>) {
        let intent = merkur_e2e::build_session_renewal_intent(
            SESSION_ID,
            BROWSER_ID,
            DAEMON_ID,
            &[0x41; 64],
            &[0x42; 32],
        )
        .unwrap();
        let commitment = merkur_e2e::compute_session_renewal_commitment(&intent).unwrap();
        let token_payload = TestSessionTokenPayload {
            u: USER_ID,
            g: DELEGATION_ID,
            b: BROWSER_ID,
            d: DAEMON_ID,
            s: SESSION_ID,
            k: &URL_SAFE_NO_PAD.encode(identity.public_key_hash()),
            q: &URL_SAFE_NO_PAD.encode(commitment),
            iat: expiry - 60_000,
            e: expiry,
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&token_payload).unwrap());
        let root = ml_dsa_87::generate_key_pair([0x11; 32]);
        let token_signature = ml_dsa_87::sign(
            &root.signing_key,
            encoded.as_bytes(),
            b"merkur-session-authorization",
            [0x81; 32],
        )
        .unwrap();
        let token = format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(token_signature.as_ref())
        );
        let proof = merkur_e2e::build_session_renewal_delegation_proof(
            &intent,
            &token,
            &serde_json::to_vec(certificate).unwrap(),
        )
        .unwrap();
        let delegate = ml_dsa_87::generate_key_pair([0x22; 32]);
        let signature = ml_dsa_87::sign(
            &delegate.signing_key,
            &proof,
            merkur_e2e::SESSION_DELEGATION_SIGNATURE_CONTEXT,
            [0x82; 32],
        )
        .unwrap();
        let transcript = merkur_e2e::build_session_renewal_request_transcript(
            &proof,
            signature.as_ref(),
            counter,
        )
        .unwrap();
        let mac = merkur_e2e::compute_session_renewal_request_mac(secret, &transcript).unwrap();
        let renew = SessionRenew {
            session_id: SESSION_ID.into(),
            browser_node_id: BROWSER_ID.into(),
            rebind_counter: counter,
            client_nonce: URL_SAFE_NO_PAD.encode([0x42; 32]),
            session_token: token,
            delegation_certificate: Box::new(certificate.clone()),
            delegation_signature: URL_SAFE_NO_PAD.encode(signature.as_ref()),
            mac: URL_SAFE_NO_PAD.encode(mac),
        };
        assert!(ClientSignal::SessionRenew(renew.clone()).is_valid());
        (renew, transcript)
    }

    #[tokio::test]
    async fn renewal_requires_both_authorities_and_replays_the_original_epoch_after_a_key_cut() {
        use crate::session::renewal_flow::handle_session_renewal;
        let fixture = session_auth_fixture();
        let certificate = *fixture.message.delegation_certificate;
        let authority = Some(fixture.authority);
        let authorization = Some(fixture.authorization);
        let identity = Some(fixture.identity);
        let now = crate::auth::unix_time_ms().unwrap();
        let expiry = now + 60_000;
        let (mut peer, _browser) = crate::e2e_dispatch_tests::authenticated_e2e_peer(BROWSER_ID);
        peer.signal_session_id = SESSION_ID.to_string();
        peer.delegation_id = DELEGATION_ID.to_string();
        peer.rebind = Some(crate::connection::RebindState {
            secret: [0x43; 64],
            counter: 7,
            lineage_digest: [0x41; 64],
            genesis_at_ms: 0.0,
            authorization: crate::session::authorization_epoch::AuthorizationEpoch::new(
                now - 1,
                [0; 64],
                now,
                0.0,
            ),
            in_flight: None,
            pending_refusal: None,
        });
        let mut peers = PeerMap::from([(BROWSER_ID.into(), peer)]);
        let network = Arc::new(RwLock::new(NetworkState::new()));
        let (tx, mut captured) = tokio::sync::mpsc::unbounded_channel();
        crate::network::register_edge_signaling(
            &network,
            BROWSER_ID,
            Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)),
        )
        .await;
        let expired_fixture = session_auth_fixture_with_policy(false, true);
        let expired_certificate = *expired_fixture.message.delegation_certificate;
        let revoked_authorization =
            Some(session_auth_fixture_with_policy(true, false).authorization);
        for failure in ["server", "delegate", "expired", "revoked"] {
            let certificate = if failure == "expired" {
                &expired_certificate
            } else {
                &certificate
            };
            let (mut renew, _) = renewal_envelope(
                certificate,
                identity.as_ref().unwrap(),
                &[0x43; 64],
                7,
                expiry,
            );
            if failure == "server" {
                let (payload, signature) = renew.session_token.split_once('.').unwrap();
                let mut signature = URL_SAFE_NO_PAD.decode(signature).unwrap();
                signature[0] ^= 1;
                renew.session_token = format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature));
            }
            let intent = merkur_e2e::build_session_renewal_intent(
                SESSION_ID,
                BROWSER_ID,
                DAEMON_ID,
                &[0x41; 64],
                &[0x42; 32],
            )
            .unwrap();
            let proof = merkur_e2e::build_session_renewal_delegation_proof(
                &intent,
                &renew.session_token,
                &serde_json::to_vec(certificate).unwrap(),
            )
            .unwrap();
            let delegate = ml_dsa_87::generate_key_pair([0x22; 32]);
            let signature = ml_dsa_87::sign(
                &delegate.signing_key,
                &proof,
                merkur_e2e::SESSION_DELEGATION_SIGNATURE_CONTEXT,
                [0x82; 32],
            )
            .unwrap();
            let mut signature = signature.as_ref().to_vec();
            if failure == "delegate" {
                signature[0] ^= 1;
            }
            let transcript =
                merkur_e2e::build_session_renewal_request_transcript(&proof, &signature, 7)
                    .unwrap();
            renew.delegation_signature = URL_SAFE_NO_PAD.encode(&signature);
            renew.mac = URL_SAFE_NO_PAD.encode(
                merkur_e2e::compute_session_renewal_request_mac(&[0x43; 64], &transcript).unwrap(),
            );
            handle_session_renewal(
                BROWSER_ID,
                &renew,
                &mut peers,
                &identity,
                &authority,
                if failure == "revoked" {
                    &revoked_authorization
                } else {
                    &authorization
                },
                &network,
                true,
                10.0,
                None,
            )
            .await;
            let (_, bytes) = captured
                .try_recv()
                .expect("a valid possession proof receives a refusal");
            let answer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(answer["accepted"], false, "{failure}");
            let rebind = peers.get(BROWSER_ID).unwrap().rebind.as_ref().unwrap();
            assert_eq!(rebind.authorization.expires_at_ms, now - 1, "{failure}");
            assert_eq!(rebind.counter, 7);
        }
        for (counter, secret, fresh, expected) in [
            (7, [0x99; 64], true, None), // A forged possession proof is silent.
            (7, [0x43; 64], false, Some(false)), // A stale revocation link cannot renew.
            (7, [0x43; 64], true, Some(true)),
            (8, [0x44; 64], true, Some(true)), // Lost ACK, retried after the key cut.
        ] {
            if counter == 8 {
                let rebind = peers.get_mut(BROWSER_ID).unwrap().rebind.as_mut().unwrap();
                rebind.counter = counter;
                rebind.secret = secret;
            }
            let (renew, transcript) = renewal_envelope(
                &certificate,
                identity.as_ref().unwrap(),
                &secret,
                counter,
                expiry,
            );
            handle_session_renewal(
                BROWSER_ID,
                &renew,
                &mut peers,
                &identity,
                &authority,
                &authorization,
                &network,
                fresh,
                20.0,
                None,
            )
            .await;
            match expected {
                None => assert!(captured.try_recv().is_err()),
                Some(accepted) => {
                    let (_, bytes) = captured.try_recv().unwrap();
                    let answer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(answer["accepted"], accepted);
                    let base = answer["generation_base"].as_u64().unwrap();
                    assert_eq!(base, if accepted { 7 } else { 0 });
                    merkur_e2e::verify_session_renewal_response_mac(
                        &secret,
                        &transcript,
                        answer["expires_at_ms"].as_u64().unwrap(),
                        base,
                        accepted,
                        &crate::auth::decode_canonical_array::<64>(answer["mac"].as_str().unwrap())
                            .unwrap(),
                    )
                    .unwrap();
                }
            }
            assert!(peers.get(BROWSER_ID).unwrap().noise.is_some());
        }
        let rebind = peers.get(BROWSER_ID).unwrap().rebind.as_ref().unwrap();
        assert_eq!(rebind.counter, 8);
        assert_eq!(rebind.authorization.generation_base, 7);
        assert_eq!(rebind.authorization.expires_at_ms, expiry);
    }

    #[tokio::test]
    async fn rejected_session_ready_does_not_commit_emit_or_release_preauth() {
        let fixture = session_auth_fixture();
        let authority = Some(fixture.authority);
        let authorization = Some(fixture.authorization);
        let identity = Some(fixture.identity);
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let (capture_tx, capture_rx) = tokio::sync::mpsc::unbounded_channel();
        drop(capture_rx);
        let closed_tunnel = Arc::new(EdgeTunnel::new_capture(capture_tx));
        closed_tunnel.close();
        assert!(
            network::register_edge_signaling(
                &network_state,
                BROWSER_ID,
                Arc::clone(&closed_tunnel),
            )
            .await
            .is_none()
        );

        let (event_tx, mut event_output, captured_events) = test_capturing_event_sink();
        let (terminal_event_tx, _terminal_event_rx) = crossbeam_channel::unbounded();
        let terminal = TerminalState::new(80, 24, terminal_event_tx);
        let mut peers = HashMap::new();
        let mut parked = ParkedPeers::new();
        let (completion_tx, mut completion_rx) = tokio::sync::mpsc::channel(1);
        let authenticated = handle_session_auth(
            &Arc::from(BROWSER_ID),
            &fixture.message,
            &authority,
            &authorization,
            &None,
            &network_state,
            &event_tx,
            &mut peers,
            &terminal,
            1.0,
            &identity,
            Some(&fixture.pending),
            &mut parked,
            &test_static(),
            &completion_tx,
        )
        .await;

        assert!(!authenticated);
        assert!(!peers[BROWSER_ID].authenticated);
        let completion = completion_rx.recv().await.expect("signature completion");
        let authenticated = finish_identity_signature(
            completion,
            &None,
            &network_state,
            &event_tx,
            &mut peers,
            &mut parked,
            2.0,
            &test_static(),
        )
        .await;
        assert!(!authenticated);
        assert!(
            peers.is_empty(),
            "rejected response cannot publish an active peer"
        );
        assert!(
            !identity
                .as_ref()
                .unwrap()
                .claim_request_commitment(fixture.request_commitment),
            "fixture must reach and consume the one-use request before response admission"
        );
        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
        assert!(
            captured_events.lock().unwrap().is_empty(),
            "rejected response cannot emit peer_authenticated"
        );

        let config = EdgeConfig::from_hashes(
            "https://edge.example:4433",
            &[base64::engine::general_purpose::STANDARD.encode([0xAA; 32])],
            &crate::edge_tunnel::EdgeAdmission::for_test(),
        )
        .expect("edge config fixture");
        let mut edge_dials = HashMap::new();
        let mut next_generation = 0;
        let plan = crate::begin_edge_dial(
            &mut edge_dials,
            BROWSER_ID,
            SESSION_ID,
            &fixture.pending,
            &config,
            &mut next_generation,
        );
        let signaling_generation = plan.signaling.expect("signaling generation");
        let state = edge_dials.get_mut(BROWSER_ID).expect("edge dial owner");
        state.signaling.state = crate::EdgeDialLaneState::Succeeded;
        state.lifecycle.preauth_lease = Some(crate::EdgePreauthLease {
            generation: signaling_generation,
            expires_at_ms: 1_000.0,
        });
        let ingress = EdgeIngressIdentity {
            session_id: Arc::from(SESSION_ID),
            generation: signaling_generation,
            lane: crate::network::protocol::EdgeLane::Signaling,
        };
        assert!(!crate::release_edge_preauth_lease(
            &mut edge_dials,
            BROWSER_ID,
            Some(&ingress),
            authenticated,
        ));
        assert!(edge_dials[BROWSER_ID].lifecycle.preauth_lease.is_some());
    }

    #[tokio::test]
    async fn successor_auth_retires_predecessor_direct_wt_owner() {
        let fixture = session_auth_fixture();
        let authority = Some(fixture.authority);
        let authorization = Some(fixture.authorization);
        let identity = Some(fixture.identity);
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let (capture_tx, _capture_rx) = tokio::sync::mpsc::unbounded_channel();
        let edge_tunnel = Arc::new(EdgeTunnel::new_capture(capture_tx));
        assert!(
            network::register_edge_signaling(&network_state, BROWSER_ID, Arc::clone(&edge_tunnel),)
                .await
                .is_none()
        );
        let wt_state = direct_wt_state(BROWSER_ID);

        let (event_tx, mut event_output, _captured_events) = test_capturing_event_sink();
        let (terminal_event_tx, _terminal_event_rx) = crossbeam_channel::unbounded();
        let terminal = TerminalState::new(80, 24, terminal_event_tx);
        let mut predecessor = PeerDisplayState::new(BROWSER_ID.into(), PeerTransport::Edge);
        predecessor.authenticated = true;
        predecessor.paths.webtransport = crate::connection::PathHealth::fresh_available(0.0);
        let mut peers = PeerMap::from([(BROWSER_ID.into(), predecessor)]);
        let mut parked = ParkedPeers::new();
        let (completion_tx, mut completion_rx) = tokio::sync::mpsc::channel(1);

        assert!(
            !handle_session_auth(
                &Arc::from(BROWSER_ID),
                &fixture.message,
                &authority,
                &authorization,
                &Some(Arc::clone(&wt_state)),
                &network_state,
                &event_tx,
                &mut peers,
                &terminal,
                1.0,
                &identity,
                Some(&fixture.pending),
                &mut parked,
                &test_static(),
                &completion_tx,
            )
            .await
        );
        assert!(!peers[BROWSER_ID].authenticated);
        let completion = completion_rx.recv().await.expect("signature completion");
        assert!(
            finish_identity_signature(
                completion,
                &Some(Arc::clone(&wt_state)),
                &network_state,
                &event_tx,
                &mut peers,
                &mut parked,
                2.0,
                &test_static()
            )
            .await
        );

        let wt = wt_state.read().await;
        assert!(
            !wt.peer_connections.contains_key(BROWSER_ID),
            "the predecessor direct generation must be fenced before successor publication"
        );
        drop(wt);
        assert!(!peers[BROWSER_ID].paths.webtransport.available);
        assert!(peers[BROWSER_ID].upgrade_secret.is_some());
        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
    }

    /// The daemon takes the browser address from the edge's report of the
    /// path the browser's own signaling connection validated, never from
    /// anything the browser sends.
    ///
    /// This is a security property, not a preference: `peer.browser_address`
    /// decides where the daemon's outbound pinhole packets go. If a value the
    /// browser asserts were trusted, any holder of a valid session token could
    /// aim the daemon at an arbitrary victim address.
    #[tokio::test]
    async fn the_browser_address_comes_from_the_edges_path_report() {
        let fixture = session_auth_fixture();

        let authority = Some(fixture.authority);
        let authorization = Some(fixture.authorization);
        let identity = Some(fixture.identity);
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let (capture_tx, _capture_rx) = tokio::sync::mpsc::unbounded_channel();
        let edge_tunnel = Arc::new(EdgeTunnel::new_capture(capture_tx));
        let observed: std::net::IpAddr = "198.51.100.23".parse().expect("fixture address");
        edge_tunnel.set_browser_path_for_test(Some(crate::edge_tunnel::EdgeBrowserPath {
            attachment_id: 1,
            address: observed,
        }));
        assert!(
            network::register_edge_signaling(&network_state, BROWSER_ID, Arc::clone(&edge_tunnel),)
                .await
                .is_none()
        );
        let wt_state = direct_wt_state(BROWSER_ID);

        let (event_tx, mut event_output, _captured_events) = test_capturing_event_sink();
        let (terminal_event_tx, _terminal_event_rx) = crossbeam_channel::unbounded();
        let terminal = TerminalState::new(80, 24, terminal_event_tx);
        let mut peers = HashMap::new();
        let mut parked = ParkedPeers::new();
        let (completion_tx, mut completion_rx) = tokio::sync::mpsc::channel(1);

        assert!(
            !handle_session_auth(
                &Arc::from(BROWSER_ID),
                &fixture.message,
                &authority,
                &authorization,
                &Some(Arc::clone(&wt_state)),
                &network_state,
                &event_tx,
                &mut peers,
                &terminal,
                1.0,
                &identity,
                Some(&fixture.pending),
                &mut parked,
                &test_static(),
                &completion_tx,
            )
            .await
        );
        assert!(!peers[BROWSER_ID].authenticated);
        let completion = completion_rx.recv().await.expect("signature completion");
        assert!(
            finish_identity_signature(
                completion,
                &Some(Arc::clone(&wt_state)),
                &network_state,
                &event_tx,
                &mut peers,
                &mut parked,
                2.0,
                &test_static()
            )
            .await
        );

        assert_eq!(
            peers[BROWSER_ID].browser_address,
            Some(observed),
            "the browser address must be the edge-validated path"
        );
        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
    }

    #[tokio::test]
    async fn deferred_signature_cannot_authorize_removed_expired_or_replaced_peer() {
        for state in ["removed", "expired", "replaced", "failed"] {
            let fixture = session_auth_fixture();
            let authority = Some(fixture.authority);
            let authorization = Some(fixture.authorization);
            let identity = Some(fixture.identity);
            let network_state = Arc::new(RwLock::new(NetworkState::new()));
            let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
            let tunnel = Arc::new(EdgeTunnel::new_capture(capture_tx));
            network::register_edge_signaling(&network_state, BROWSER_ID, tunnel).await;
            let (event_tx, mut event_output, _) = test_capturing_event_sink();
            let (terminal_tx, _terminal_rx) = crossbeam_channel::unbounded();
            let terminal = TerminalState::new(80, 24, terminal_tx);
            let mut peers = PeerMap::new();
            let mut parked = ParkedPeers::new();
            let (completion_tx, mut completion_rx) = tokio::sync::mpsc::channel(1);
            assert!(
                !handle_session_auth(
                    &Arc::from(BROWSER_ID),
                    &fixture.message,
                    &authority,
                    &authorization,
                    &None,
                    &network_state,
                    &event_tx,
                    &mut peers,
                    &terminal,
                    1.0,
                    &identity,
                    Some(&fixture.pending),
                    &mut parked,
                    &test_static(),
                    &completion_tx
                )
                .await
            );
            assert!(!peers[BROWSER_ID].authenticated);
            let mut completion = completion_rx.recv().await.unwrap();
            match state {
                "removed" => {
                    peers.remove(BROWSER_ID);
                }
                "expired" => {
                    peers.get_mut(BROWSER_ID).unwrap().auth_timeout_at_ms = Some(2.0);
                }
                "replaced" => {
                    peers
                        .get_mut(BROWSER_ID)
                        .unwrap()
                        .pending_identity_signature
                        .as_mut()
                        .unwrap()
                        .token = Arc::new(());
                }
                "failed" => {
                    completion.result = Err(crate::identity_seal::SealError::Hardware);
                }
                _ => unreachable!(),
            }
            assert!(
                !finish_identity_signature(
                    completion,
                    &None,
                    &network_state,
                    &event_tx,
                    &mut peers,
                    &mut parked,
                    2.0,
                    &test_static()
                )
                .await
            );
            assert!(
                peers
                    .values()
                    .all(|peer| !peer.authenticated && peer.noise_handshake.is_none())
            );
            if state == "replaced" {
                assert!(peers[BROWSER_ID].pending_identity_signature.is_some());
            }
            while let Ok(message) = capture_rx.try_recv() {
                assert!(!String::from_utf8_lossy(&message.1).contains("session_ready"));
            }
            event_output.shutdown().await.unwrap();
        }
    }

    /// How long `handle_session_auth` owns the run loop, stage by stage.
    ///
    /// Every stage below runs inline on the single owner task that also holds
    /// the display-flush timer, the PTY drain, and input ACK flushing. A peer
    /// connecting or reconnecting therefore delays an *existing* peer's
    /// keystroke-to-paint by whatever this costs. The stage split matters as
    /// much as the total: if one signature verify dominates, moving that one
    /// call off-loop is a small change, whereas a flat profile across nine
    /// stages would argue for moving the whole block.
    ///
    /// `BENCH_SAMPLES` controls sample count. Run with:
    /// `cargo test --release -p merkur-dataplane
    ///  session::auth_flow::tests::production_session_auth_owner_loop_benchmark
    ///  -- --ignored --exact --nocapture`
    #[test]
    #[ignore = "benchmark"]
    fn production_session_auth_owner_loop_benchmark() {
        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(200);

        let fixture = session_auth_fixture();
        let token = fixture.message.session_token.clone();
        let certificate = (*fixture.message.delegation_certificate).clone();
        let delegation_signature = fixture.message.delegation_signature.clone();
        let client_nonce: [u8; SESSION_NONCE_BYTES] =
            decode_canonical_array(&fixture.message.client_nonce).expect("nonce");
        let encapsulation_key: [u8; ML_KEM_KEY_BYTES] =
            decode_canonical_array(&fixture.message.encapsulation_key).expect("encapsulation key");

        let daemon_static = merkur_e2e::generate_static_keypair().unwrap().0;
        let noise_msg1 = crate::auth::decode_canonical_bytes(&fixture.message.noise_msg1).unwrap();
        let mut transcript_samples = Vec::with_capacity(samples);
        let mut capability_samples = Vec::with_capacity(samples);
        let mut delegation_samples = Vec::with_capacity(samples);
        let mut encapsulate_samples = Vec::with_capacity(samples);
        let mut sign_samples = Vec::with_capacity(samples);
        let mut derive_samples = Vec::with_capacity(samples);
        let mut total_samples = Vec::with_capacity(samples);
        let mut checksum = 0u64;

        for sample in 0..samples {
            let overall = Instant::now();

            let started = Instant::now();
            let request_transcript = merkur_e2e::build_session_request_transcript(
                token.as_bytes(),
                SESSION_ID,
                BROWSER_ID,
                DAEMON_ID,
                &client_nonce,
                &encapsulation_key,
            )
            .expect("request transcript");
            transcript_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            // One ML-DSA-87 verify: the server capability.
            let started = Instant::now();
            let validated = fixture
                .authority
                .validate(&token, BROWSER_ID, SESSION_ID, USER_ID, DELEGATION_ID)
                .expect("capability validates");
            capability_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
            checksum = checksum.wrapping_add(validated.request_commitment[0] as u64);

            // Two ML-DSA-87 verifies: the root-signed certificate and the
            // delegate's signature over the exact request transcript.
            let started = Instant::now();
            let bound_request =
                merkur_e2e::bind_session_request_msg1(&request_transcript, &noise_msg1).unwrap();
            let digest = fixture
                .authorization
                .authorize_session(
                    &certificate,
                    USER_ID,
                    DELEGATION_ID,
                    &bound_request,
                    &delegation_signature,
                )
                .expect("delegation proof validates");
            delegation_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            // ML-KEM-1024 encapsulation. Randomness varies per sample so no
            // arm can be constant-folded across iterations.
            let mut randomness = [0u8; merkur_e2e::ML_KEM_ENCAPS_RANDOM_BYTES];
            randomness[0] = sample as u8;
            randomness[1] = (sample >> 8) as u8;
            let started = Instant::now();
            let encapsulation = merkur_e2e::SessionServerEncapsulation::new(
                &encapsulation_key,
                std::hint::black_box(randomness),
            )
            .expect("encapsulation");
            encapsulate_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
            let ciphertext = *encapsulation.ciphertext();

            let prologue = merkur_e2e::derive_prologue(
                SESSION_ID,
                DAEMON_ID,
                &merkur_e2e::hash_session_request_transcript(&request_transcript).unwrap(),
            );
            let (noise, noise_msg2) =
                merkur_e2e::PendingNoiseResponder::start(&daemon_static, &prologue, &noise_msg1)
                    .unwrap();
            let daemon_nonce = [sample as u8; SESSION_NONCE_BYTES];
            let response_transcript = merkur_e2e::build_session_response_transcript(
                &bound_request,
                &digest,
                &daemon_nonce,
                &ciphertext,
                1,
                &noise_msg2,
            )
            .expect("response transcript");

            // One ML-DSA-87 sign: the daemon identity over the response.
            let started = Instant::now();
            let daemon_signature = fixture
                .identity
                .sign_response(&response_transcript)
                .expect("daemon signs response");
            sign_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            let started = Instant::now();
            let secrets = encapsulation
                .complete(&daemon_signature, &response_transcript)
                .expect("session secrets")
                .bind_noise(noise.checkpoint(), &response_transcript)
                .unwrap();
            derive_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            total_samples.push(overall.elapsed().as_secs_f64() * 1_000.0);
            checksum = checksum.wrapping_add(secrets.noise_psk()[0] as u64);
        }

        for (name, values) in [
            ("session-auth-request-transcript", &mut transcript_samples),
            ("session-auth-capability-verify", &mut capability_samples),
            ("session-auth-delegation-verify", &mut delegation_samples),
            ("session-auth-mlkem-encapsulate", &mut encapsulate_samples),
            ("session-auth-identity-sign", &mut sign_samples),
            ("session-auth-secret-derive", &mut derive_samples),
            ("session-auth-owner-loop-total", &mut total_samples),
        ] {
            emit_auth_benchmark_metric(name, values, samples);
        }
        std::hint::black_box(checksum);
    }

    fn emit_auth_benchmark_metric(name: &str, samples: &mut [f64], sample_size: usize) {
        samples.sort_by(f64::total_cmp);
        let percentile = |ratio: f64| {
            let index = ((samples.len() as f64 * ratio).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len().saturating_sub(1));
            samples[index]
        };
        for ratio in [0.50, 0.95, 0.99] {
            let value = percentile(ratio);
            println!(
                "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value},\"unit\":\"ms/op\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{sample_size}}}"
            );
        }
    }

    #[test]
    fn resumed_edge_preserves_paired_network_estimates() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let terminal = TerminalState::new(80, 24, event_tx);
        let mut preserved = PeerDisplayState::new(BROWSER_ID.into(), PeerTransport::Edge);
        preserved.display_cache.resize(terminal.cols, terminal.rows);
        preserved.display_cache.initialized = true;
        preserved.paths.edge.network_rtt_ewma_ms = 50.0;
        preserved.paths.edge.network_jitter_ewma_ms = 7.0;
        preserved.paths.edge.rtt_ewma_ms = 90.0;
        preserved.paths.edge.jitter_ewma_ms = 23.0;
        preserved.paths.webtransport.network_rtt_ewma_ms = 25.0;
        preserved.paths.webtransport.network_jitter_ewma_ms = 4.0;
        let spliced = splice_resumed_peer(
            Some(preserved),
            &Arc::from(BROWSER_ID),
            BROWSER_ID,
            "successor-session".to_string(),
            DELEGATION_ID.to_string(),
            &terminal,
            1_000.0,
        );
        assert_eq!(spliced.paths.edge.network_rtt_ewma_ms, 50.0);
        assert_eq!(spliced.paths.edge.network_jitter_ewma_ms, 7.0);
        assert_eq!(spliced.paths.edge.rtt_ewma_ms, 90.0);
        assert_eq!(spliced.paths.edge.jitter_ewma_ms, 23.0);
        assert!(spliced.paths.edge.available);
        assert_eq!(spliced.paths.edge.last_ack_at_ms, 1_000.0);
        let dormant = crate::connection::PathHealth::dormant();
        assert!(!spliced.paths.webtransport.available);
        assert_eq!(
            spliced.paths.webtransport.network_rtt_ewma_ms,
            dormant.network_rtt_ewma_ms
        );
        assert_eq!(spliced.paths.webtransport.network_jitter_ewma_ms, 0.0);
    }

    /// The confirmed input high-water lives on `PeerDisplayState`, so a splice
    /// that carries the display cache forward would carry it too unless the
    /// successor explicitly resets it. A successor session opens a fresh input
    /// sequence domain, so a preserved value would make the daemon advertise a
    /// high-water the new browser never sent.
    #[test]
    fn a_resumed_peer_starts_a_fresh_input_sequence_domain() {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let terminal = TerminalState::new(80, 24, event_tx);

        let mut preserved = PeerDisplayState::new(BROWSER_ID.into(), PeerTransport::Edge);
        preserved.display_cache.resize(terminal.cols, terminal.rows);
        preserved.display_cache.initialized = true;
        preserved.latest_input_seq = 41;
        preserved.last_resize_seq = 19;
        preserved.last_advertised_input_seq = 41;
        preserved.queue_input_ack(41, PeerTransport::Edge);

        let spliced = splice_resumed_peer(
            Some(preserved),
            &Arc::from(BROWSER_ID),
            BROWSER_ID,
            "successor-session".to_string(),
            DELEGATION_ID.to_string(),
            &terminal,
            1_000.0,
        );

        assert_eq!(
            spliced.latest_input_seq, 0,
            "a successor session must not inherit the predecessor's confirmed input high-water"
        );
        assert_eq!(
            spliced.last_resize_seq, 0,
            "fresh auth resets viewport intent order"
        );
        assert_eq!(
            spliced.last_advertised_input_seq, 41,
            "the stale advertisement is retained so the first post-resume flush is forced to emit"
        );
        assert_eq!(
            spliced.pending_input_ack, None,
            "an ack queued in the old sequence domain must not be flushed into the new one"
        );
        assert!(
            spliced.display_cache.initialized,
            "the resume splice must still preserve the display cache"
        );
    }

    /// A fresh authentication replaces every carrier, exactly as a rebind does.
    /// This is the peer the daemon held live through a phone's suspension: its
    /// old direct connection recorded as blocked and holding its one frame, a
    /// preparation whose reply the dead carrier could never deliver, a repair
    /// armed against it, and a row still in flight on it.
    #[test]
    fn a_resumed_peer_crosses_a_carrier_boundary() {
        use crate::connection::SentRow;
        use crate::display::policy::DisplayPolicy;
        use merkur_codec::CellRepr;

        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let terminal = TerminalState::new(80, 24, event_tx);
        let mut preserved = PeerDisplayState::new(BROWSER_ID.into(), PeerTransport::Edge);
        preserved.display_cache.resize(terminal.cols, terminal.rows);
        preserved.display_cache.initialized = true;
        preserved.display_cache.record_sent_rows(
            1,
            std::slice::from_ref(&SentRow {
                graphics: None,
                row: 0,
                hash: 0xfeed,
                cells: Arc::from(vec![CellRepr::BLANK; usize::from(terminal.cols)]),
            }),
            500.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        preserved.display_prepare_in_flight = Some(7);
        assert!(preserved.display_cache.begin_resume_repair(3, &[0]));
        for carrier in [PeerTransport::Edge, PeerTransport::WebTransport] {
            preserved.carrier_blocks.observe(carrier, true);
            preserved.carrier_blocks.admitted(carrier);
        }

        let mut spliced = splice_resumed_peer(
            Some(preserved),
            &Arc::from(BROWSER_ID),
            BROWSER_ID,
            "successor-session".to_string(),
            DELEGATION_ID.to_string(),
            &terminal,
            1_000.0,
        );

        assert_eq!(
            spliced.display_prepare_in_flight, None,
            "a reply for the dead carrier can never arrive to clear its token"
        );
        assert!(
            !spliced.display_cache.repair_armed,
            "a repair armed against the dead carrier can never complete"
        );
        for carrier in [PeerTransport::Edge, PeerTransport::WebTransport] {
            assert!(
                !spliced.carrier_blocks.is_closed(carrier),
                "a block recorded for a dead {carrier:?} carrier must not hold the successor's display"
            );
        }
        assert_eq!(
            spliced.display_cache.disown_outstanding_rows(),
            0,
            "the row in flight on the dead carrier was already disowned"
        );
        assert!(spliced.display_cache.initialized);
    }
}
