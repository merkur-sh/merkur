//! Authenticate final-flight admission and reconcile an uncertain key cut.

use sha2::{Digest, Sha512};

use crate::hybrid::{BinaryTranscript, SessionCryptoError, has_domain, require_nonempty};
use crate::rebind::{rebind_mac, verify_rebind_mac};

const REQUEST: &[u8] = b"merkur-rebind-reconcile/request";
const REQUEST_MAC: &[u8] = b"merkur-rebind-reconcile/request-mac\0";
const RESPONSE_MAC: &[u8] = b"merkur-rebind-reconcile/response-mac\0";
const FINAL_MAC: &[u8] = b"merkur-rebind-final/mac\0";

/// Extract the exact attempt from the canonical reconciliation request. A
/// delayed, valid incumbent answer has no authority over a later attempt.
pub(crate) fn reconciliation_attempt(request: &[u8]) -> Option<[u8; 64]> {
    let mut fields = request.strip_prefix(REQUEST)?.strip_prefix(&[0])?;
    let mut attempt = None;
    for tag in 1..=7 {
        let (&actual, rest) = fields.split_first()?;
        if actual != tag || rest.len() < 8 {
            return None;
        }
        let len = usize::try_from(u64::from_be_bytes(rest[..8].try_into().ok()?)).ok()?;
        let body = rest.get(8..)?;
        let value = body.get(..len)?;
        fields = body.get(len..)?;
        if (tag <= 3 && value.is_empty())
            || (tag == 4 && len != 64)
            || (tag == 5 && len != 8)
            || (tag == 6 && len != 64)
            || (tag == 7 && len != 32)
        {
            return None;
        }
        if tag == 6 {
            attempt = Some(value.try_into().ok()?);
        }
    }
    if fields.is_empty() { attempt } else { None }
}

pub fn build_rebind_reconciliation(
    session: &str,
    browser: &str,
    daemon: &str,
    lineage: &[u8; 64],
    counter: u64,
    attempt: &[u8; 64],
    nonce: &[u8; 32],
) -> Result<Vec<u8>, SessionCryptoError> {
    require_nonempty("session", session.as_bytes())?;
    require_nonempty("browser", browser.as_bytes())?;
    require_nonempty("daemon", daemon.as_bytes())?;
    let mut t = BinaryTranscript::new(REQUEST);
    t.field(1, session.as_bytes());
    t.field(2, browser.as_bytes());
    t.field(3, daemon.as_bytes());
    t.field(4, lineage);
    t.field(5, &counter.to_be_bytes());
    t.field(6, attempt);
    t.field(7, nonce);
    Ok(t.finish())
}

pub fn compute_rebind_reconciliation_mac(
    secret: &[u8; 64],
    request: &[u8],
) -> Result<[u8; 64], SessionCryptoError> {
    if !has_domain(request, REQUEST) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    rebind_mac(secret, REQUEST_MAC, request)
}

pub fn verify_rebind_reconciliation_mac(
    secret: &[u8; 64],
    request: &[u8],
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    if !has_domain(request, REQUEST) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    verify_rebind_mac(secret, REQUEST_MAC, request, mac)
}

fn response(request: &[u8], counter: u64) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(request, REQUEST) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let mut t = BinaryTranscript::new(b"merkur-rebind-reconcile/response");
    t.field(1, &Sha512::digest(request));
    t.field(2, &counter.to_be_bytes());
    Ok(t.finish())
}

pub fn compute_rebind_reconciliation_response_mac(
    secret: &[u8; 64],
    request: &[u8],
    counter: u64,
) -> Result<[u8; 64], SessionCryptoError> {
    rebind_mac(secret, RESPONSE_MAC, &response(request, counter)?)
}

pub fn verify_rebind_reconciliation_response_mac(
    secret: &[u8; 64],
    request: &[u8],
    counter: u64,
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    verify_rebind_mac(secret, RESPONSE_MAC, &response(request, counter)?, mac)
}

fn final_transcript(attempt: &[u8; 64], message: &[u8]) -> Vec<u8> {
    let mut t = BinaryTranscript::new(b"merkur-rebind-final");
    t.field(1, attempt);
    t.field(2, message);
    t.finish()
}

pub fn compute_rebind_final_mac(
    secret: &[u8; 64],
    attempt: &[u8; 64],
    message: &[u8],
) -> Result<[u8; 64], SessionCryptoError> {
    rebind_mac(secret, FINAL_MAC, &final_transcript(attempt, message))
}

pub fn verify_rebind_final_mac(
    secret: &[u8; 64],
    attempt: &[u8; 64],
    message: &[u8],
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    verify_rebind_mac(secret, FINAL_MAC, &final_transcript(attempt, message), mac)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commit_proofs_bind_attempt_direction_nonce_and_generation() {
        let secret = [1; 64];
        let attempt = [2; 64];
        let request =
            build_rebind_reconciliation("s", "b", "d", &[3; 64], 7, &attempt, &[4; 32]).unwrap();
        let proof = compute_rebind_reconciliation_mac(&secret, &request).unwrap();
        verify_rebind_reconciliation_mac(&secret, &request, &proof).unwrap();
        assert!(verify_rebind_reconciliation_response_mac(&secret, &request, 7, &proof).is_err());
        let answer = compute_rebind_reconciliation_response_mac(&secret, &request, 8).unwrap();
        verify_rebind_reconciliation_response_mac(&secret, &request, 8, &answer).unwrap();
        assert!(verify_rebind_reconciliation_response_mac(&secret, &request, 7, &answer).is_err());
        let other =
            build_rebind_reconciliation("s", "b", "d", &[3; 64], 7, &attempt, &[5; 32]).unwrap();
        assert!(verify_rebind_reconciliation_response_mac(&secret, &other, 8, &answer).is_err());
        let final_mac = compute_rebind_final_mac(&secret, &attempt, b"msg3").unwrap();
        verify_rebind_final_mac(&secret, &attempt, b"msg3", &final_mac).unwrap();
        assert!(verify_rebind_final_mac(&secret, &[3; 64], b"msg3", &final_mac).is_err());
        assert!(verify_rebind_final_mac(&secret, &attempt, b"forged", &final_mac).is_err());
    }
}
