//! Renew the authorization of an existing lineage without rotating its keys.
//!
//! The intent and delegated signature survive a carrier change. Possession and
//! acknowledgement proofs belong to the current chaining-secret generation, so
//! a lost acknowledgement can be queried again after a successful key cut.

use sha2::{Digest, Sha512};

use crate::hybrid::{
    BinaryTranscript, SESSION_COMMITMENT_BYTES, SESSION_NONCE_BYTES, SESSION_REBIND_SECRET_BYTES,
    SessionCryptoError, has_domain, require_nonempty,
};
use crate::rebind::{SESSION_REBIND_MAC_BYTES, rebind_mac, verify_rebind_mac};

const INTENT_DOMAIN: &[u8] = b"merkur-session-renewal/intent";
const COMMITMENT_DOMAIN: &[u8] = b"merkur-session-renewal/commitment\0";
const DELEGATION_DOMAIN: &[u8] = b"merkur-session-renewal/delegation";
const REQUEST_DOMAIN: &[u8] = b"merkur-session-renewal/request";
const RESPONSE_DOMAIN: &[u8] = b"merkur-session-renewal/response";
const REQUEST_MAC_DOMAIN: &[u8] = b"merkur-session-renewal/request-mac\0";
const RESPONSE_MAC_DOMAIN: &[u8] = b"merkur-session-renewal/response-mac\0";

pub fn build_session_renewal_intent(
    session_id: &str,
    browser_node_id: &str,
    daemon_id: &str,
    lineage: &[u8; SESSION_COMMITMENT_BYTES],
    nonce: &[u8; SESSION_NONCE_BYTES],
) -> Result<Vec<u8>, SessionCryptoError> {
    require_nonempty("session_id", session_id.as_bytes())?;
    require_nonempty("browser_node_id", browser_node_id.as_bytes())?;
    require_nonempty("daemon_id", daemon_id.as_bytes())?;
    let mut transcript = BinaryTranscript::new(INTENT_DOMAIN);
    transcript.field(1, session_id.as_bytes());
    transcript.field(2, browser_node_id.as_bytes());
    transcript.field(3, daemon_id.as_bytes());
    transcript.field(4, lineage);
    transcript.field(5, nonce);
    Ok(transcript.finish())
}

/// The commitment placed in the server-signed capability's `q` field.
pub fn compute_session_renewal_commitment(
    intent: &[u8],
) -> Result<[u8; SESSION_COMMITMENT_BYTES], SessionCryptoError> {
    if !has_domain(intent, INTENT_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let mut digest = Sha512::new();
    digest.update(COMMITMENT_DOMAIN);
    digest.update(intent);
    Ok(digest.finalize().into())
}

/// Signed under the existing browser delegation signature context. The distinct
/// transcript domain prevents a renewal signature from authorizing genesis.
pub fn build_session_renewal_delegation_proof(
    intent: &[u8],
    capability: &str,
    canonical_certificate: &[u8],
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(intent, INTENT_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    require_nonempty("capability", capability.as_bytes())?;
    require_nonempty("delegation_certificate", canonical_certificate)?;
    let certificate_digest: [u8; 64] = Sha512::digest(canonical_certificate).into();
    let mut transcript = BinaryTranscript::new(DELEGATION_DOMAIN);
    transcript.field(1, intent);
    transcript.field(2, capability.as_bytes());
    transcript.field(3, &certificate_digest);
    Ok(transcript.finish())
}

pub fn build_session_renewal_request_transcript(
    delegation_proof: &[u8],
    delegation_signature: &[u8],
    counter: u64,
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(delegation_proof, DELEGATION_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    require_nonempty("delegation_signature", delegation_signature)?;
    let mut transcript = BinaryTranscript::new(REQUEST_DOMAIN);
    transcript.field(1, delegation_proof);
    transcript.field(2, delegation_signature);
    transcript.field(3, &counter.to_be_bytes());
    Ok(transcript.finish())
}

pub fn compute_session_renewal_request_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request: &[u8],
) -> Result<[u8; SESSION_REBIND_MAC_BYTES], SessionCryptoError> {
    if !has_domain(request, REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    rebind_mac(secret, REQUEST_MAC_DOMAIN, request)
}

pub fn verify_session_renewal_request_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request: &[u8],
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    if !has_domain(request, REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    verify_rebind_mac(secret, REQUEST_MAC_DOMAIN, request, mac)
}

fn response_transcript(
    request: &[u8],
    expires_at_ms: u64,
    generation_base: u64,
    accepted: bool,
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(request, REQUEST_DOMAIN)
        || (!accepted && (expires_at_ms != 0 || generation_base != 0))
    {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let request_digest: [u8; 64] = Sha512::digest(request).into();
    let mut transcript = BinaryTranscript::new(RESPONSE_DOMAIN);
    transcript.field(1, &request_digest);
    transcript.field(2, &[u8::from(accepted)]);
    transcript.field(3, &expires_at_ms.to_be_bytes());
    transcript.field(4, &generation_base.to_be_bytes());
    Ok(transcript.finish())
}

pub fn compute_session_renewal_response_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request: &[u8],
    expires_at_ms: u64,
    generation_base: u64,
    accepted: bool,
) -> Result<[u8; SESSION_REBIND_MAC_BYTES], SessionCryptoError> {
    let response = response_transcript(request, expires_at_ms, generation_base, accepted)?;
    rebind_mac(secret, RESPONSE_MAC_DOMAIN, &response)
}

pub fn verify_session_renewal_response_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request: &[u8],
    expires_at_ms: u64,
    generation_base: u64,
    accepted: bool,
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    let response = response_transcript(request, expires_at_ms, generation_base, accepted)?;
    verify_rebind_mac(secret, RESPONSE_MAC_DOMAIN, &response, mac)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renewal_binds_identity_capability_certificate_and_current_generation() {
        let intent = build_session_renewal_intent("s", "b", "d", &[1; 64], &[2; 32]).unwrap();
        let proof =
            build_session_renewal_delegation_proof(&intent, "capability", b"certificate").unwrap();
        let request = build_session_renewal_request_transcript(&proof, b"signature", 7).unwrap();
        let secret = [3; 64];
        let mac = compute_session_renewal_request_mac(&secret, &request).unwrap();
        verify_session_renewal_request_mac(&secret, &request, &mac).unwrap();
        for (session, browser, daemon, lineage, nonce, capability, certificate, counter) in [
            (
                "other",
                "b",
                "d",
                [1; 64],
                [2; 32],
                "capability",
                &b"certificate"[..],
                7,
            ),
            (
                "s",
                "other",
                "d",
                [1; 64],
                [2; 32],
                "capability",
                &b"certificate"[..],
                7,
            ),
            (
                "s",
                "b",
                "other",
                [1; 64],
                [2; 32],
                "capability",
                &b"certificate"[..],
                7,
            ),
            (
                "s",
                "b",
                "d",
                [9; 64],
                [2; 32],
                "capability",
                &b"certificate"[..],
                7,
            ),
            (
                "s",
                "b",
                "d",
                [1; 64],
                [9; 32],
                "capability",
                &b"certificate"[..],
                7,
            ),
            (
                "s",
                "b",
                "d",
                [1; 64],
                [2; 32],
                "other",
                &b"certificate"[..],
                7,
            ),
            (
                "s",
                "b",
                "d",
                [1; 64],
                [2; 32],
                "capability",
                &b"other"[..],
                7,
            ),
            (
                "s",
                "b",
                "d",
                [1; 64],
                [2; 32],
                "capability",
                &b"certificate"[..],
                8,
            ),
        ] {
            let changed =
                build_session_renewal_intent(session, browser, daemon, &lineage, &nonce).unwrap();
            let changed =
                build_session_renewal_delegation_proof(&changed, capability, certificate).unwrap();
            let changed =
                build_session_renewal_request_transcript(&changed, b"signature", counter).unwrap();
            assert!(verify_session_renewal_request_mac(&secret, &changed, &mac).is_err());
        }
        assert!(verify_session_renewal_request_mac(&[4; 64], &request, &mac).is_err());
        let answer =
            compute_session_renewal_response_mac(&secret, &request, 1000, 7, true).unwrap();
        verify_session_renewal_response_mac(&secret, &request, 1000, 7, true, &answer).unwrap();
        assert!(
            verify_session_renewal_response_mac(&secret, &request, 1001, 7, true, &answer).is_err()
        );
        assert!(
            verify_session_renewal_response_mac(&secret, &request, 1000, 8, true, &answer).is_err()
        );
        assert!(
            verify_session_renewal_response_mac(&secret, &request, 0, 0, false, &answer).is_err()
        );
        assert!(
            verify_session_renewal_response_mac(&secret, &request, 1000, 7, true, &mac).is_err()
        );
    }
}
