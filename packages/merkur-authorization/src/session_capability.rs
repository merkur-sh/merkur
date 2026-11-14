//! The server's session capability: a short-lived ML-DSA-87 statement that one
//! browser node may open one session with one daemon. The key service signs it
//! and the daemon verifies it; both read the payload here, so neither can
//! accept a shape the other would refuse.

use serde::{Deserialize, Serialize};

use crate::{AuthorizationError, HASH_BYTES, decode_exact, require_id};

/// FIPS 204 context of the capability signature.
pub const SESSION_CAPABILITY_CONTEXT: &[u8] = b"merkur-session-authorization";
/// The longest a capability may live, issue to expiry.
pub const SESSION_CAPABILITY_MAX_LIFETIME_MS: u64 = 300_000;

/// Exact canonical payload. Field declaration order is protocol order, because
/// reserialization must reproduce the signed JSON bytes: `{u,g,b,d,s,k,q,iat,e}`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCapabilityPayload {
    /// User.
    pub u: String,
    /// Browser delegation.
    pub g: String,
    /// Browser node.
    pub b: String,
    /// Daemon.
    pub d: String,
    /// Session.
    pub s: String,
    /// SHA-512 commitment to the linked daemon identity.
    pub k: String,
    /// SHA-512 commitment to the browser's nonce and ML-KEM key.
    pub q: String,
    pub iat: u64,
    pub e: u64,
}

/// A payload read from its transported segment, with its two commitments decoded.
#[derive(Debug)]
pub struct SessionCapability {
    pub payload: SessionCapabilityPayload,
    pub daemon_identity_key_hash: [u8; HASH_BYTES],
    pub request_commitment: [u8; HASH_BYTES],
}

/// Reads the payload segment exactly as signed: canonical unpadded base64url of
/// canonical JSON, every id in the protocol alphabet, and a lifetime within
/// bounds. Clock checks are the caller's: the signer and the verifier hold
/// different clocks to different rules.
pub fn parse_session_capability(segment: &str) -> Result<SessionCapability, AuthorizationError> {
    let malformed = || AuthorizationError::new("session capability", "is malformed");
    let bytes = canonical_segment(segment).ok_or_else(malformed)?;
    let payload: SessionCapabilityPayload =
        serde_json::from_slice(&bytes).map_err(|_| malformed())?;
    if serde_json::to_vec(&payload).map_err(|_| malformed())? != bytes {
        return Err(malformed());
    }
    let daemon_identity_key_hash = decode_exact::<HASH_BYTES>(&payload.k, "session capability")?;
    let request_commitment = decode_exact::<HASH_BYTES>(&payload.q, "session capability")?;
    for id in [&payload.u, &payload.g, &payload.b, &payload.d, &payload.s] {
        require_id(id, "session capability id")?;
    }
    if payload.e <= payload.iat || payload.e - payload.iat > SESSION_CAPABILITY_MAX_LIFETIME_MS {
        return Err(AuthorizationError::new(
            "session capability lifetime",
            "is invalid",
        ));
    }
    Ok(SessionCapability {
        payload,
        daemon_identity_key_hash,
        request_commitment,
    })
}

fn canonical_segment(segment: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let decoded = URL_SAFE_NO_PAD.decode(segment).ok()?;
    (URL_SAFE_NO_PAD.encode(&decoded) == segment).then_some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode;

    fn segment(json: &str) -> String {
        encode(json.as_bytes())
    }

    fn json(iat: u64, e: u64) -> String {
        let hash = encode(&[7u8; HASH_BYTES]);
        format!(
            r#"{{"u":"user-1","g":"del-1","b":"node-1","d":"daemon-1","s":"session-1","k":"{hash}","q":"{hash}","iat":{iat},"e":{e}}}"#
        )
    }

    #[test]
    fn a_canonical_payload_reads_with_its_commitments() {
        let capability = parse_session_capability(&segment(&json(1_000, 61_000))).unwrap();
        assert_eq!(capability.payload.d, "daemon-1");
        assert_eq!(capability.request_commitment, [7u8; HASH_BYTES]);
    }

    #[test]
    fn a_reordered_or_extended_payload_is_refused() {
        let hash = encode(&[7u8; HASH_BYTES]);
        let reordered = format!(
            r#"{{"g":"del-1","u":"user-1","b":"node-1","d":"daemon-1","s":"session-1","k":"{hash}","q":"{hash}","iat":1,"e":2}}"#
        );
        assert!(parse_session_capability(&segment(&reordered)).is_err());
        let extended = json(1, 2).replace("}", r#","x":1}"#);
        assert!(parse_session_capability(&segment(&extended)).is_err());
    }

    #[test]
    fn a_lifetime_outside_bounds_is_refused() {
        assert!(parse_session_capability(&segment(&json(5, 5))).is_err());
        assert!(
            parse_session_capability(&segment(&json(0, SESSION_CAPABILITY_MAX_LIFETIME_MS + 1)))
                .is_err()
        );
    }

    #[test]
    fn a_padded_segment_is_refused() {
        let padded = format!("{}=", segment(&json(1, 2)));
        assert!(parse_session_capability(&padded).is_err());
    }
}
