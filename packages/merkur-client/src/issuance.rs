//! Session issuance: `POST /api/sessions/request` with the account access
//! token. The server checks the delegation and the daemon binding, has the
//! daemon admit a control offer bound to this client's nonce and one-use
//! ML-KEM key, and answers with the edge coordinates and a short-lived
//! capability.

use merkur_authorization::{DaemonBinding, decode_len};
use serde::{Deserialize, Serialize};

pub const ISSUANCE_PATH: &str = "/api/sessions/request";
/// `TICKET_LEN` in `apps/edge/src/attach_ticket.rs`; the ticket is opaque here.
const EDGE_ATTACH_TICKET_BYTES: usize = 26;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuanceRequest {
    pub delegation_id: String,
    pub daemon_id: String,
    pub browser_node_id: String,
    pub issuance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_issuance_id: Option<String>,
    pub client_nonce: String,
    pub encapsulation_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Issuance {
    pub daemon_id: String,
    pub daemon_identity_public_key: String,
    pub daemon_identity_p256_public_key: String,
    pub daemon_binding: DaemonBinding,
    pub session_token: String,
    pub session_token_expires_at_ms: u64,
    /// Server-clock lifetime, converted to a monotonic deadline on receipt so
    /// the client's own wall clock is never trusted.
    pub session_token_expires_in_ms: u64,
    pub session_id: String,
    pub edge_wt_url: String,
    /// Base64 SHA-256 certificate hashes; two during a rotation overlap.
    pub edge_cert_hashes: Vec<String>,
    /// Presented by every edge attachment of this session, rebinds included.
    pub edge_attach_ticket: String,
}

impl Issuance {
    /// Parses and validates the server's answer exactly as the browser does.
    pub fn parse(json: &[u8]) -> Option<Self> {
        let issuance: Self = serde_json::from_slice(json).ok()?;
        issuance.is_valid().then_some(issuance)
    }

    fn is_valid(&self) -> bool {
        !self.daemon_id.is_empty()
            && decode_len(&self.daemon_identity_public_key, 2_592, "daemon identity").is_ok()
            && decode_len(&self.daemon_identity_p256_public_key, 65, "daemon P-256").is_ok()
            && self.daemon_binding.validate().is_ok()
            && !self.session_token.is_empty()
            && self.session_token_expires_at_ms > 0
            && !self.session_id.is_empty()
            && is_edge_url(&self.edge_wt_url)
            && is_pin_set(&self.edge_cert_hashes)
            && decode_len(
                &self.edge_attach_ticket,
                EDGE_ATTACH_TICKET_BYTES,
                "attach ticket",
            )
            .is_ok()
    }

    /// The SHA-256 certificate hashes the edge's TLS certificate must match.
    pub fn cert_hashes(&self) -> Vec<[u8; 32]> {
        self.edge_cert_hashes
            .iter()
            .filter_map(|hash| standard_base64_decode(hash))
            .filter_map(|bytes| bytes.try_into().ok())
            .collect()
    }
}

/// `POST` with the account access token: a fresh capability for an existing
/// session's renewal, and the current certificate hashes of the edge it names.
/// The capability grants nothing alone; the daemon also verifies the lineage
/// MAC and the delegate's signature.
pub const RENEWAL_PATH: &str = "/api/sessions/renew";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewalRequest {
    pub daemon_id: String,
    pub browser_node_id: String,
    pub session_id: String,
    pub delegation_id: String,
    /// The renewal intent's commitment, bound into the capability.
    pub commitment: String,
    /// The edge this session's attachments dial, whose hashes the answer states.
    pub edge_wt_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenewalCapability {
    pub session_token: String,
    pub session_token_expires_in_ms: u64,
    /// The named edge's certificate hashes as its registration states them
    /// now, or `None` while the registry holds no live registration for it.
    pub edge_cert_hashes: Option<Vec<String>>,
}

impl RenewalCapability {
    pub fn parse(json: &[u8]) -> Option<Self> {
        let capability: Self = serde_json::from_slice(json).ok()?;
        (!capability.session_token.is_empty()
            && capability.session_token_expires_in_ms > 0
            && capability
                .edge_cert_hashes
                .as_deref()
                .is_none_or(is_pin_set))
        .then_some(capability)
    }
}

/// One or two distinct standard-base64 SHA-256 hashes: an edge's served
/// certificate and the one it serves next.
fn is_pin_set(hashes: &[String]) -> bool {
    (1..=2).contains(&hashes.len())
        && hashes.iter().all(|hash| is_sha256_base64(hash))
        && (hashes.len() < 2 || hashes[0] != hashes[1])
}

fn is_edge_url(value: &str) -> bool {
    value.starts_with("https://") && !value.contains(char::is_whitespace)
}

fn is_sha256_base64(value: &str) -> bool {
    standard_base64_decode(value).is_some_and(|bytes| bytes.len() == 32)
}

/// Canonical padded standard base64, the certificate-hash spelling: the
/// engine refuses non-zero trailing bits, so each value has one spelling.
fn standard_base64_decode(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certificate_hashes_have_one_spelling() {
        use base64::Engine;
        let hash = base64::engine::general_purpose::STANDARD.encode([0xab; 32]);
        assert_eq!(standard_base64_decode(&hash), Some(vec![0xab; 32]));
        assert!(!is_sha256_base64(&hash.replace('=', "")));
        assert!(!is_sha256_base64(
            &base64::engine::general_purpose::STANDARD.encode([0xab; 31])
        ));
    }

    #[test]
    fn a_renewal_names_its_edge_and_answers_with_its_hashes() {
        use base64::Engine;
        let request = RenewalRequest {
            daemon_id: "d".into(),
            browser_node_id: "b".into(),
            session_id: "s".into(),
            delegation_id: "g".into(),
            commitment: "c".into(),
            edge_wt_url: "https://edge.example:4433".into(),
        };
        assert_eq!(
            serde_json::to_string(&request).unwrap(),
            r#"{"daemonId":"d","browserNodeId":"b","sessionId":"s","delegationId":"g","commitment":"c","edgeWtUrl":"https://edge.example:4433"}"#
        );
        let served = base64::engine::general_purpose::STANDARD.encode([1; 32]);
        let next = base64::engine::general_purpose::STANDARD.encode([2; 32]);
        let pinned = RenewalCapability::parse(
            format!(
                r#"{{"sessionToken":"t","sessionTokenExpiresInMs":1,"edgeCertHashes":["{served}","{next}"]}}"#
            )
            .as_bytes(),
        )
        .expect("a renewal with the edge's hashes");
        assert_eq!(pinned.edge_cert_hashes, Some(vec![served.clone(), next]));
        let unregistered = RenewalCapability::parse(
            br#"{"sessionToken":"t","sessionTokenExpiresInMs":1,"edgeCertHashes":null}"#,
        )
        .expect("a renewal for an edge the registry no longer holds");
        assert_eq!(unregistered.edge_cert_hashes, None);
        assert!(
            RenewalCapability::parse(
                format!(
                    r#"{{"sessionToken":"t","sessionTokenExpiresInMs":1,"edgeCertHashes":["{served}","{served}"]}}"#
                )
                .as_bytes(),
            )
            .is_none(),
            "a repeated hash is no pin set"
        );
    }

    #[test]
    fn the_request_body_is_what_the_server_route_reads() {
        let request = IssuanceRequest {
            delegation_id: "g".into(),
            daemon_id: "d".into(),
            browser_node_id: "b".into(),
            issuance_id: "i".into(),
            supersedes_issuance_id: None,
            client_nonce: "n".into(),
            encapsulation_key: "k".into(),
        };
        assert_eq!(
            serde_json::to_string(&request).unwrap(),
            r#"{"delegationId":"g","daemonId":"d","browserNodeId":"b","issuanceId":"i","clientNonce":"n","encapsulationKey":"k"}"#
        );
    }
}
