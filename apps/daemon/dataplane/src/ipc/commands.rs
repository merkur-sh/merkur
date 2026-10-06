pub use crate::identity_seal::IdentitySealWire;
use serde::Deserialize;

use crate::auth::{DaemonBinding, DelegationCertificate, RevocationStatement, RevocationTarget};

pub const CMD_CONFIGURE: u8 = 0x01;
pub const CMD_UPDATE_REVOCATION: u8 = 0x08;
/// Start or resume a browser session by dialing its edge rendezvous.
pub const CMD_START_SESSION: u8 = 0x09;
/// Terminally retract one exact browser/session tuple.
pub const CMD_CANCEL_SESSION: u8 = 0x0A;
/// Validate and apply one delegate-signed revocation statement.
pub const CMD_REVOKE_DELEGATION: u8 = 0x0B;
/// Replace the STUN credential used for NAT discovery.
///
/// Its own command rather than a field on `configure`: the credential is
/// replaced on every control heartbeat, and re-sending the whole configure
/// payload — daemon binding, revocation list and all — at that cadence would
/// be orders of magnitude more bytes for a 55-character ticket.
pub const CMD_UPDATE_STUN: u8 = 0x0C;
/// Close and emit the current positive transport-telemetry window immediately.
/// Used by the deterministic performance harness before daemon teardown.
pub const CMD_CAPTURE_TRANSPORT_STATS: u8 = 0x0D;
/// Export one bounded native profiling observation over diagnostic IPC.
pub const CMD_CAPTURE_PERF_TRACE: u8 = 0x0E;
pub const CMD_SHUTDOWN: u8 = 0x0F;
pub const CMD_SIGN_DAEMON_PROOF: u8 = 0x10;
/// Replace what every edge dial presents and pins: the attach ticket, and each
/// registered edge's certificate hashes.
///
/// Its own command for the reason `CMD_UPDATE_STUN` is: it is replaced on every
/// control lease, and a configure payload at that cadence would be orders of
/// magnitude more bytes.
pub const CMD_UPDATE_EDGE_ADMISSION: u8 = 0x11;

/// Payload of [`CMD_UPDATE_EDGE_ADMISSION`].
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateEdgeAdmissionCmd {
    /// Opaque, base64url; see `apps/edge/src/attach_ticket.rs`. The daemon never
    /// checks its expiry: the edge does.
    pub ticket: String,
    /// Every edge the server's registry holds, as the lease stated it.
    pub edges: Vec<EdgePinsCmd>,
}

/// One registered edge: its WebTransport URL and the standard-base64 SHA-256
/// hashes of the certificate it serves and the one it serves next.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EdgePinsCmd {
    pub url: String,
    pub cert_hashes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignDaemonProofCmd {
    pub command_id: String,
    pub purpose: crate::identity_signer::ManagementPurpose,
    pub transcript: String,
}

/// Payload of `CMD_UPDATE_STUN`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateStunCmd {
    /// `host:port` vantage points.
    pub servers: Vec<String>,
    /// Opaque credential, carried verbatim in the STUN USERNAME attribute.
    pub ticket: String,
    /// base64url of the 32-byte MESSAGE-INTEGRITY-SHA256 key for `ticket`.
    pub secret: String,
    /// Remaining validity when this command was written, in milliseconds.
    ///
    /// A duration rather than an instant so nothing compares the issuing
    /// server's clock against this process's. Stamped against the monotonic
    /// clock on arrival; see `StunCredential::expires_at`.
    pub lifetime_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigureCmd {
    pub session_token_verify_key: String,
    pub daemon_id: String,
    pub daemon_identity_seal: IdentitySealWire,
    pub server_origin: String,
    pub user_root_public_key: String,
    pub root_epoch: u64,
    pub daemon_binding: DaemonBinding,
    pub revoked_delegations: Vec<RevocationTarget>,
}

/// Payload of [`CMD_START_SESSION`]. `session_id` is the rendezvous key the
/// daemon stamps on its edge routing preface (the edge splices the daemon and
/// browser tunnels that share it). `browser_node_id` is the Noise prologue
/// identity label the daemon binds the per-session tunnel to — it is NOT a dial
/// target (the daemon dials the EDGE, never the browser).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartSessionCmd {
    pub command_id: String,
    pub user_id: String,
    pub delegation_id: String,
    pub session_id: String,
    pub browser_node_id: String,
    pub client_nonce: String,
    pub encapsulation_key: String,
    pub edge_wt_url: String,
    pub edge_cert_hashes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevokeDelegationCmd {
    pub command_id: String,
    pub actor_certificate: DelegationCertificate,
    pub revocation: RevocationStatement,
}

/// Payload of [`CMD_CANCEL_SESSION`]. Both fields are required: cancellation
/// must never collapse to peer-id-only teardown because a newer session may
/// already own the same browser identity.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelSessionCmd {
    pub command_id: String,
    pub session_id: String,
    pub browser_node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureTransportStatsCmd {
    pub command_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapturePerfTraceCmd {
    pub command_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURRENT_CONFIG: &str = r#"{
        "session_token_verify_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "daemon_id":"daemon-1",
        "daemon_identity_seal":{"backend":"software","material":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
        "server_origin":"https://merkur.example",
        "user_root_public_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "root_epoch":1,
        "daemon_binding":{
            "userId":"user-1",
            "rootKeyCommitment":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "daemonId":"daemon-1",
            "daemonIdentityKeyCommitment":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "serverOrigin":"https://merkur.example",
            "linkClaimId":"claim-1",
            "issuedAt":1,
            "signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        "revoked_delegations":[]
    }"#;

    #[test]
    fn current_configure_shape_is_exact_and_complete() {
        assert!(serde_json::from_str::<ConfigureCmd>(CURRENT_CONFIG).is_ok());

        let mut missing_identity: serde_json::Value =
            serde_json::from_str(CURRENT_CONFIG).expect("valid fixture");
        missing_identity
            .as_object_mut()
            .expect("object fixture")
            .remove("daemon_id");
        assert!(serde_json::from_value::<ConfigureCmd>(missing_identity).is_err());

        let mut surplus: serde_json::Value =
            serde_json::from_str(CURRENT_CONFIG).expect("valid fixture");
        surplus
            .as_object_mut()
            .expect("object fixture")
            .insert("shell".to_string(), serde_json::json!("/bin/sh"));
        assert!(serde_json::from_value::<ConfigureCmd>(surplus).is_err());
    }

    #[test]
    fn session_commands_reject_surplus_fields() {
        assert!(
            serde_json::from_str::<StartSessionCmd>(
                r#"{
                    "command_id":"command-1",
                    "user_id":"user-1",
                    "delegation_id":"delegation-1",
                    "session_id":"session-1",
                    "browser_node_id":"browser-1",
                    "client_nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "encapsulation_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                    "edge_wt_url":"https://edge.example",
                    "edge_cert_hashes":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
                    "surplus":true
                }"#,
            )
            .is_err()
        );
        assert!(serde_json::from_str::<CancelSessionCmd>(
            r#"{"command_id":"command-1","session_id":"session-1","browser_node_id":"browser-1","peer_only":true}"#,
        )
        .is_err());
    }

    #[test]
    fn edge_admission_command_shape_is_exact() {
        let command = serde_json::from_str::<UpdateEdgeAdmissionCmd>(
            r#"{"ticket":"t","edges":[{"url":"https://edge.example:4433","cert_hashes":["a","b"]}]}"#,
        )
        .expect("exact edge admission command");
        assert_eq!(command.ticket, "t");
        assert_eq!(command.edges[0].url, "https://edge.example:4433");
        assert_eq!(command.edges[0].cert_hashes, ["a", "b"]);
        assert!(serde_json::from_str::<UpdateEdgeAdmissionCmd>(r#"{"ticket":"t"}"#).is_err());
        assert!(
            serde_json::from_str::<UpdateEdgeAdmissionCmd>(
                r#"{"ticket":"t","edges":[],"expiry":1}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<UpdateEdgeAdmissionCmd>(
                r#"{"ticket":"t","edges":[{"url":"u","certHashes":[]}]}"#
            )
            .is_err(),
            "a camelCase writer is refused whole"
        );
    }

    #[test]
    fn transport_capture_command_shape_is_exact() {
        let command = serde_json::from_str::<CaptureTransportStatsCmd>(
            r#"{"command_id":"transport-final-1"}"#,
        )
        .expect("exact capture command");
        assert_eq!(command.command_id, "transport-final-1");
        assert!(
            serde_json::from_str::<CaptureTransportStatsCmd>(r#"{}"#).is_err(),
            "command identity is required"
        );
        assert!(
            serde_json::from_str::<CaptureTransportStatsCmd>(
                r#"{"command_id":"transport-final-1","surplus":true}"#
            )
            .is_err(),
            "surplus fields must not silently change capture semantics"
        );
    }

    #[test]
    fn perf_trace_capture_command_shape_is_exact() {
        let command =
            serde_json::from_str::<CapturePerfTraceCmd>(r#"{"command_id":"perf-final-1"}"#)
                .expect("exact trace capture command");
        assert_eq!(command.command_id, "perf-final-1");
        assert!(serde_json::from_str::<CapturePerfTraceCmd>(r#"{}"#).is_err());
        assert!(
            serde_json::from_str::<CapturePerfTraceCmd>(
                r#"{"command_id":"perf-final-1","output_path":"/tmp/untrusted"}"#,
            )
            .is_err()
        );
    }
}
