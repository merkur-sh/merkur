//! Channel `0x00`: the plaintext signaling JSON between a client and the
//! dataplane. It carries the capability, the delegation proof, the ML-KEM
//! bootstrap, the signed daemon response, the Noise handshake messages and path
//! management. None of it unlocks anything on its own.
//!
//! Each message is a JSON object whose `type` names it and whose other keys are
//! exactly the message's fields. [`ClientSignal`] is what a client sends and the
//! dataplane admits; [`DaemonSignal`] the reverse. Every message validates its
//! own bounds, so a malformed envelope is refused before any auth or terminal
//! state is touched, on whichever side reads it.

use std::net::IpAddr;

use merkur_authorization::{DelegationCertificate, decode_len, encoded_len};
use serde::{Deserialize, Serialize};

pub const SESSION_NONCE_BYTES: usize = 32;
pub const ML_KEM_ENCAPSULATION_KEY_BYTES: usize = 1_568;
pub const ML_KEM_CIPHERTEXT_BYTES: usize = 1_568;
pub const ML_DSA_87_SIGNATURE_BYTES: usize = 4_627;
pub const P256_SIGNATURE_BYTES: usize = 64;
pub const SESSION_REBIND_MAC_BYTES: usize = 64;
/// A Noise `XXpsk3` handshake message is one ephemeral or static plus framing;
/// this bounds it rather than pinning it.
pub const MAX_NOISE_MESSAGE_BYTES: usize = 256;
pub const MAX_SESSION_TOKEN_BYTES: usize = 8 * 1024;
pub const MAX_SESSION_ID_BYTES: usize = 128;
pub const DATA_ATTACH_NONCE_HEX_CHARS: usize = crate::protocol::DATA_HANDSHAKE_NONCE_BYTES * 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataLane {
    Interactive,
    Bulk,
}

/// `Number.MAX_SAFE_INTEGER`: counters a browser holds as a JavaScript number.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Candidates one direct-path outcome report may list, mirrored from
/// `MAX_WEBTRANSPORT_OFFER_CANDIDATES` in `packages/shared`.
pub const MAX_REPORT_CANDIDATES: usize = 10;

/// What a client sends on channel `0x00`. Each message is its own struct so a
/// handler takes exactly the message it serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientSignal {
    SessionAuth(SessionAuth),
    NoiseFinal(NoiseFinal),
    SessionRebind(SessionRebind),
    RebindFinal(RebindFinal),
    SessionRenew(SessionRenew),
    SessionRebindReconcile(SessionRebindReconcile),
    WebtransportUpgradeInit(WebtransportUpgradeInit),
    WebtransportUpgradeProof(WebtransportUpgradeProof),
    WebtransportOutcome(WebtransportOutcome),
    NetworkChange(NetworkChange),
    SignalingPong {},
    DataAttach(DataClaim),
    DataReceived(DataClaim),
}

/// Flight 1: the capability, the one-use ML-KEM key and nonce, the root-signed
/// delegation, the delegate's signature over the request preamble and Noise
/// message 1, and message 1 itself. The certificate is only shaped here: an
/// invalid one is answered with `auth_failed` by the handler, not refused as a
/// malformed envelope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAuth {
    pub session_token: String,
    pub session_id: String,
    pub client_nonce: String,
    pub encapsulation_key: String,
    pub delegation_certificate: Box<DelegationCertificate>,
    pub delegation_signature: String,
    pub noise_msg1: String,
}

/// Flight 3: Noise message 3.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoiseFinal {
    pub data: String,
}

/// A carrier rebind's first flight, authenticated by the lineage MAC.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRebind {
    pub session_id: String,
    pub browser_node_id: String,
    pub rebind_counter: u64,
    pub client_nonce: String,
    pub encapsulation_key: String,
    pub mac: String,
    pub noise_msg1: String,
}

/// A rebind's Noise message 3 with its MAC under the successor secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RebindFinal {
    pub data: String,
    pub mac: String,
}

/// Renews reconnect authority for the current session and key chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRenew {
    pub session_id: String,
    pub browser_node_id: String,
    pub rebind_counter: u64,
    pub client_nonce: String,
    pub session_token: String,
    pub delegation_certificate: Box<DelegationCertificate>,
    pub delegation_signature: String,
    pub mac: String,
}

/// Asks which side of an uncertain rebind commit the daemon is on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRebindReconcile {
    pub session_id: String,
    pub browser_node_id: String,
    pub rebind_counter: u64,
    pub client_nonce: String,
    pub attempt_digest: String,
    pub mac: String,
    pub successor_mac: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebtransportUpgradeInit {
    pub browser_node_id: String,
}

/// 64 bytes in lowercase hex.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebtransportUpgradeProof {
    pub proof_hex: String,
}

/// How a direct-path attempt ended, for the daemon's log. Every field is a
/// closed vocabulary, so the report cannot carry anything else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebtransportOutcome {
    pub outcome: String,
    pub admission_stage: String,
    pub admission_reason: String,
    pub nat_type: String,
    /// Present on the wire as `null` when nothing won.
    #[serde(deserialize_with = "Option::deserialize")]
    pub winner_kind: Option<String>,
    pub candidates: Vec<CandidateOutcome>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateOutcome {
    pub kind: String,
    pub disposition: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkChange {
    pub browser_node_id: String,
}

/// One data connection's claim (`data_attach`), sent on signaling after Noise
/// beside the HELLO on that connection, or its delivery proof
/// (`data_received`). `nonce` is 16 bytes in hex.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DataClaim {
    pub lane: DataLane,
    pub nonce: String,
}

/// What a refused client envelope still says about itself. Nothing in it has
/// been authenticated: it is fit for a tally and a bounded log line only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefusedEnvelope {
    /// A `session_rebind` by its `type`. `session_id` is the id it named, and
    /// only when that id is one the validator itself admits ([`is_session_id`]):
    /// a missing, empty, non-string or over-long id is `None`.
    SessionRebind { session_id: Option<String> },
    /// Any other envelope, readable or not.
    Other,
}

impl RefusedEnvelope {
    /// Reads the two fields a refusal may report from an envelope that is no
    /// message in shape, ignoring every other key and value.
    fn of_unreadable(json: &[u8]) -> Self {
        struct Envelope;
        impl<'de> serde::de::Visitor<'de> for Envelope {
            type Value = RefusedEnvelope;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let (mut rebind, mut session_id) = (false, None);
                while let Some(key) = map.next_key::<Text<'de>>()? {
                    match key.0.as_deref() {
                        Some("type") => {
                            let kind = map.next_value::<Text<'de>>()?;
                            rebind = kind.0.as_deref() == Some("session_rebind");
                        }
                        Some("session_id") => session_id = map.next_value::<Text<'de>>()?.0,
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(if rebind {
                    RefusedEnvelope::SessionRebind {
                        session_id: session_id
                            .filter(|id| is_session_id(id))
                            .map(std::borrow::Cow::into_owned),
                    }
                } else {
                    RefusedEnvelope::Other
                })
            }
        }
        let mut deserializer = serde_json::Deserializer::from_slice(json);
        match serde::Deserializer::deserialize_map(&mut deserializer, Envelope) {
            Ok(refused) if deserializer.end().is_ok() => refused,
            _ => Self::Other,
        }
    }
}

/// The string at a JSON position, or nothing for a value of any other type.
struct Text<'a>(Option<std::borrow::Cow<'a, str>>);

impl<'de: 'a, 'a> Deserialize<'de> for Text<'a> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Option<std::borrow::Cow<'de, str>>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E> {
                Ok(Some(std::borrow::Cow::Borrowed(value)))
            }
            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(Some(std::borrow::Cow::Owned(value.to_owned())))
            }
            fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(None)
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                while map
                    .next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?
                    .is_some()
                {}
                Ok(None)
            }
        }
        deserializer.deserialize_any(Visitor).map(Self)
    }
}

/// The rule every message applies to a session or browser-node id: not empty,
/// and at most [`MAX_SESSION_ID_BYTES`].
pub fn is_session_id(value: &str) -> bool {
    bounded_nonempty(value, MAX_SESSION_ID_BYTES)
}

/// The bound on a rebind counter a client names, in `session_rebind`,
/// `session_renew` and `session_rebind_reconcile` alike. The counter is a
/// lineage generation whose successor the daemon forms when a rebind commits
/// (`counter + 1`) and reports to a JavaScript reader, so the named counter is
/// strictly below `Number.MAX_SAFE_INTEGER` and its successor still fits.
fn rebind_counter(value: u64) -> bool {
    value < MAX_SAFE_INTEGER
}

const NAT_TYPES: &[&str] = &["endpoint_independent", "endpoint_dependent", "none"];
const CANDIDATE_KINDS: &[&str] = &["srflx", "nat_map", "host4", "host6", "loopback"];
const DISPOSITIONS: &[&str] = &[
    "not_dialled",
    "no_settle",
    "refused",
    "tls_rejected",
    "closed_during_connect",
    "other",
    "ready_lost_race",
    "ready_upgrade_failed",
    "won",
];
const ADMISSION_STAGES: &[&str] = &[
    "channels",
    "init_write",
    "challenge",
    "proof_sign",
    "proof_write",
    "ack",
    "none",
];
const ADMISSION_REASONS: &[&str] = &["timeout", "invalid", "closed", "crypto", "none"];

impl ClientSignal {
    /// Every field is a string, an integer or a list of them, which
    /// `serde_json` cannot fail on. A message that did fail would become the
    /// empty string, which is not JSON and which [`Self::parse`] refuses.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Parses and validates one message, or `None` for anything malformed.
    pub fn parse(json: &[u8]) -> Option<Self> {
        Self::admit(json).ok()
    }

    /// [`Self::parse`], saying of a refused envelope what its reader may
    /// still report. An envelope that is a message in shape and fails only a
    /// bound is read once; any other is read a second time for its `type`.
    pub fn admit(json: &[u8]) -> Result<Self, RefusedEnvelope> {
        match serde_json::from_slice::<Self>(json) {
            Ok(message) if message.is_valid() => Ok(message),
            Ok(Self::SessionRebind(message)) => Err(RefusedEnvelope::SessionRebind {
                session_id: Some(message.session_id).filter(|id| is_session_id(id)),
            }),
            Ok(_) => Err(RefusedEnvelope::Other),
            Err(_) => Err(RefusedEnvelope::of_unreadable(json)),
        }
    }

    /// The envelope rules the dataplane admits by, before any auth or terminal
    /// state is touched.
    pub fn is_valid(&self) -> bool {
        match self {
            Self::SessionAuth(message) => {
                bounded_nonempty(&message.session_token, MAX_SESSION_TOKEN_BYTES)
                    && bounded_nonempty(&message.session_id, MAX_SESSION_ID_BYTES)
                    && exact(&message.client_nonce, SESSION_NONCE_BYTES)
                    && exact(&message.encapsulation_key, ML_KEM_ENCAPSULATION_KEY_BYTES)
                    && exact(&message.delegation_signature, ML_DSA_87_SIGNATURE_BYTES)
                    && noise_message(&message.noise_msg1)
            }
            Self::NoiseFinal(message) => noise_message(&message.data),
            Self::SessionRebind(message) => {
                is_session_id(&message.session_id)
                    && is_session_id(&message.browser_node_id)
                    && rebind_counter(message.rebind_counter)
                    && exact(&message.client_nonce, SESSION_NONCE_BYTES)
                    && exact(&message.encapsulation_key, ML_KEM_ENCAPSULATION_KEY_BYTES)
                    && exact(&message.mac, SESSION_REBIND_MAC_BYTES)
                    && noise_message(&message.noise_msg1)
            }
            Self::RebindFinal(message) => {
                noise_message(&message.data) && exact(&message.mac, SESSION_REBIND_MAC_BYTES)
            }
            Self::SessionRenew(message) => {
                is_session_id(&message.session_id)
                    && is_session_id(&message.browser_node_id)
                    && bounded_nonempty(&message.session_token, MAX_SESSION_TOKEN_BYTES)
                    && rebind_counter(message.rebind_counter)
                    && exact(&message.client_nonce, SESSION_NONCE_BYTES)
                    && exact(&message.mac, SESSION_REBIND_MAC_BYTES)
                    && exact(&message.delegation_signature, ML_DSA_87_SIGNATURE_BYTES)
            }
            Self::SessionRebindReconcile(message) => {
                is_session_id(&message.session_id)
                    && is_session_id(&message.browser_node_id)
                    && rebind_counter(message.rebind_counter)
                    && exact(&message.client_nonce, SESSION_NONCE_BYTES)
                    && exact(&message.attempt_digest, 64)
                    && exact(&message.mac, SESSION_REBIND_MAC_BYTES)
                    && exact(&message.successor_mac, SESSION_REBIND_MAC_BYTES)
            }
            Self::WebtransportUpgradeInit(message) => is_session_id(&message.browser_node_id),
            Self::WebtransportUpgradeProof(message) => {
                message.proof_hex.len() == 128
                    && message
                        .proof_hex
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }
            Self::WebtransportOutcome(report) => {
                let winner_matches = match report.outcome.as_str() {
                    // `lost` is a path that carried traffic and then died, so it
                    // names a winner exactly as `selected` does.
                    "selected" | "lost" => report
                        .winner_kind
                        .as_deref()
                        .is_some_and(|kind| CANDIDATE_KINDS.contains(&kind)),
                    "failed" => report.winner_kind.is_none(),
                    _ => false,
                };
                winner_matches
                    && NAT_TYPES.contains(&report.nat_type.as_str())
                    && ADMISSION_STAGES.contains(&report.admission_stage.as_str())
                    && ADMISSION_REASONS.contains(&report.admission_reason.as_str())
                    && report.candidates.len() <= MAX_REPORT_CANDIDATES
                    && report.candidates.iter().all(|candidate| {
                        CANDIDATE_KINDS.contains(&candidate.kind.as_str())
                            && DISPOSITIONS.contains(&candidate.disposition.as_str())
                    })
            }
            Self::NetworkChange(message) => is_session_id(&message.browser_node_id),
            Self::SignalingPong {} => true,
            Self::DataAttach(claim) | Self::DataReceived(claim) => {
                claim.nonce.len() == DATA_ATTACH_NONCE_HEX_CHARS
                    && claim.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            }
        }
    }
}

/// What the dataplane sends a client on channel `0x00`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DaemonSignal {
    /// Flight 2: the daemon nonce, the ML-KEM ciphertext, the next input
    /// sequence it expects, both identity signatures over the complete
    /// request/response transcript, and Noise message 2. The client verifies
    /// both signatures before it decapsulates or feeds message 2 to Noise.
    SessionReady {
        daemon_nonce: String,
        ciphertext: String,
        next_expected_input_seq: u64,
        daemon_signature: String,
        p256_signature: String,
        noise_msg2: String,
    },
    AuthFailed {
        reason: String,
    },
    SessionRebound {
        daemon_nonce: String,
        ciphertext: String,
        next_expected_input_seq: u64,
        mac: String,
        noise_msg2: String,
    },
    SessionRebindRefused {
        reason: String,
        mac: String,
    },
    /// Which side of an uncertain commit the daemon is on, MACed under that
    /// generation's secret. Answered under the successor, it is also the
    /// commit acknowledgement the edge selects a candidate on.
    SessionRebindReconciled {
        client_nonce: String,
        rebind_counter: u64,
        mac: String,
    },
    /// The daemon's verdict on a renewal, MACed under the current secret. A
    /// refusal carries a zero epoch.
    SessionRenewed {
        client_nonce: String,
        rebind_counter: u64,
        accepted: bool,
        expires_at_ms: u64,
        generation_base: u64,
        mac: String,
    },
    /// The daemon's whole direct-path candidate set for this client, pinned
    /// to one certificate (base64 SHA-256), and the client address the edge
    /// validated on its committed signaling attachment: the one the manifest
    /// was built for and its punch aimed at. `generation` orders a peer's
    /// manifests, and a punch outcome names the generation it belongs to.
    WebtransportManifest {
        generation: u64,
        cert_hash: String,
        candidates: Vec<DirectCandidate>,
        nat: NatSignature,
        browser_address: IpAddr,
        punch: PunchState,
    },
    /// What became of the punch a `pending` manifest promised.
    WebtransportPunch {
        generation: u64,
        outcome: PunchOutcome,
    },
    /// Leg two of the direct upgrade, on the direct attachment's control
    /// stream: the nonce the proof covers, and the provisional peer id the
    /// daemon holds the attachment under until the proof lands.
    WebtransportUpgradeChallenge {
        nonce_hex: String,
        temp_peer_id: String,
    },
}

const WT_UPGRADE_PROOF_TAG: &str = "merkur-webtransport-upgrade-proof";

/// What the direct-upgrade proof MACs, with HMAC-SHA-512 under the session's
/// direct-upgrade secret: the daemon's challenge nonce and every identity the
/// attachment binds, so a proof answers one challenge on one attachment of
/// one session. Pinned by `session-auth.json`'s `webtransport_upgrade` vector.
pub fn webtransport_upgrade_proof_payload(
    nonce_hex: &str,
    signal_session_id: &str,
    browser_node_id: &str,
    daemon_id: &str,
    wt_temp_peer_id: &str,
) -> String {
    format!(
        "{WT_UPGRADE_PROOF_TAG}\n{nonce_hex}\n{signal_session_id}\n{browser_node_id}\n{daemon_id}\n{wt_temp_peer_id}"
    )
}

/// The most candidates one manifest may carry, mirrored from
/// `MAX_WEBTRANSPORT_OFFER_CANDIDATES`. A bound on what a parser accepts, held
/// above what a daemon emits: a manifest over it is refused whole.
pub const MAX_WEBTRANSPORT_OFFER_CANDIDATES: usize = 10;
const DIRECT_CERT_HASH_BASE64_CHARS: usize = 44;
const UPGRADE_NONCE_HEX_CHARS: usize = 64;
const TEMP_PEER_ID_PREFIX: &str = "wt-pending-";

/// One address the daemon's direct WebTransport server may be dialled at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectCandidate {
    pub addr: IpAddr,
    pub port: u16,
    pub kind: CandidateKind,
    pub scope: CandidateScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    Srflx,
    NatMap,
    Host4,
    Host6,
    Loopback,
}

/// Whether dialling a candidate leaves the local network, as the daemon's
/// address classifier decides it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateScope {
    Public,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NatSignature {
    pub public_ip: Option<String>,
    pub nat_type: NatType,
    pub hairpin: bool,
    pub nat_filtering: NatFiltering,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NatType {
    EndpointIndependent,
    EndpointDependent,
    None,
}

/// RFC 5780 filtering verdict for the daemon's live socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NatFiltering {
    EndpointIndependent,
    PortIndependent,
    PortDependent,
    Unknown,
}

/// Whether a punch was queued for a manifest's punched candidates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PunchState {
    Pending,
    None,
}

/// `dispatched`: the datagrams left. `refused` and `expired`: none will.
/// `superseded`: a newer manifest or carrier replaced the one it served.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PunchOutcome {
    Dispatched,
    Refused,
    Superseded,
    Expired,
}

impl DaemonSignal {
    /// Every field is a string, an integer, a boolean, an address or a list of
    /// them, which `serde_json` cannot fail on. A message that did fail would
    /// become the empty string, which is not JSON and which [`Self::parse`]
    /// refuses.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn parse(json: &[u8]) -> Option<Self> {
        let message: Self = serde_json::from_slice(json).ok()?;
        message.is_valid().then_some(message)
    }

    pub fn is_valid(&self) -> bool {
        match self {
            Self::SessionReady {
                daemon_nonce,
                ciphertext,
                next_expected_input_seq,
                daemon_signature,
                p256_signature,
                noise_msg2,
            } => {
                exact(daemon_nonce, SESSION_NONCE_BYTES)
                    && exact(ciphertext, ML_KEM_CIPHERTEXT_BYTES)
                    && input_sequence(*next_expected_input_seq)
                    && exact(daemon_signature, ML_DSA_87_SIGNATURE_BYTES)
                    && exact(p256_signature, P256_SIGNATURE_BYTES)
                    && noise_message(noise_msg2)
            }
            Self::AuthFailed { reason } => !reason.is_empty(),
            Self::SessionRebound {
                daemon_nonce,
                ciphertext,
                next_expected_input_seq,
                mac,
                noise_msg2,
            } => {
                exact(daemon_nonce, SESSION_NONCE_BYTES)
                    && exact(ciphertext, ML_KEM_CIPHERTEXT_BYTES)
                    && input_sequence(*next_expected_input_seq)
                    && exact(mac, SESSION_REBIND_MAC_BYTES)
                    && noise_message(noise_msg2)
            }
            Self::SessionRebindRefused { reason, mac } => {
                !reason.is_empty() && reason.len() <= 96 && exact(mac, SESSION_REBIND_MAC_BYTES)
            }
            Self::SessionRebindReconciled {
                client_nonce,
                rebind_counter,
                mac,
            } => {
                exact(client_nonce, SESSION_NONCE_BYTES)
                    && *rebind_counter <= MAX_SAFE_INTEGER
                    && exact(mac, SESSION_REBIND_MAC_BYTES)
            }
            Self::SessionRenewed {
                client_nonce,
                rebind_counter,
                expires_at_ms,
                generation_base,
                mac,
                ..
            } => {
                exact(client_nonce, SESSION_NONCE_BYTES)
                    && *rebind_counter <= MAX_SAFE_INTEGER
                    && *expires_at_ms <= MAX_SAFE_INTEGER
                    && *generation_base <= *rebind_counter
                    && exact(mac, SESSION_REBIND_MAC_BYTES)
            }
            Self::WebtransportManifest {
                generation,
                cert_hash,
                candidates,
                ..
            } => {
                *generation <= MAX_SAFE_INTEGER
                    && cert_hash.len() == DIRECT_CERT_HASH_BASE64_CHARS
                    && cert_hash.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
                    })
                    && candidates.len() <= MAX_WEBTRANSPORT_OFFER_CANDIDATES
                    && candidates.iter().all(|candidate| candidate.port != 0)
            }
            Self::WebtransportPunch { generation, .. } => *generation <= MAX_SAFE_INTEGER,
            Self::WebtransportUpgradeChallenge {
                nonce_hex,
                temp_peer_id,
            } => {
                nonce_hex.len() == UPGRADE_NONCE_HEX_CHARS
                    && nonce_hex
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    && temp_peer_id
                        .strip_prefix(TEMP_PEER_ID_PREFIX)
                        .is_some_and(|serial| {
                            (serial == "0" || !serial.starts_with('0'))
                                && serial.bytes().all(|byte| byte.is_ascii_digit())
                                && serial.parse::<u64>().is_ok()
                        })
            }
        }
    }
}

fn bounded_nonempty(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes
}

fn exact(value: &str, bytes: usize) -> bool {
    decode_len(value, bytes, "signaling field").is_ok()
}

/// Canonical base64url of a non-empty Noise message within the bound.
fn noise_message(value: &str) -> bool {
    // Refused by its character count, before anything is decoded: a message
    // of the bound's length has this many characters and none has more.
    if value.len() > encoded_len(MAX_NOISE_MESSAGE_BYTES) {
        return false;
    }
    let Ok(decoded) = merkur_authorization::decode_len(value, value.len() * 3 / 4, "noise") else {
        return false;
    };
    !decoded.is_empty() && decoded.len() <= MAX_NOISE_MESSAGE_BYTES
}

fn input_sequence(value: u64) -> bool {
    (1..=u64::from(u32::MAX)).contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_authorization::encode;

    fn noise() -> String {
        encode(&[7u8; 48])
    }

    #[test]
    fn session_ready_is_refused_unless_every_field_is_exact() {
        let ready = DaemonSignal::SessionReady {
            daemon_nonce: encode(&[1; 32]),
            ciphertext: encode(&[2; 1_568]),
            next_expected_input_seq: 1,
            daemon_signature: encode(&[3; 4_627]),
            p256_signature: encode(&[4; 64]),
            noise_msg2: noise(),
        };
        let json = ready.to_json();
        assert!(json.starts_with(r#"{"type":"session_ready","daemon_nonce":"#));
        assert_eq!(DaemonSignal::parse(json.as_bytes()), Some(ready.clone()));

        let DaemonSignal::SessionReady {
            daemon_nonce,
            ciphertext,
            daemon_signature,
            p256_signature,
            noise_msg2,
            ..
        } = ready
        else {
            panic!("the signal built above is a session_ready")
        };
        let zero_sequence = DaemonSignal::SessionReady {
            daemon_nonce,
            ciphertext,
            next_expected_input_seq: 0,
            daemon_signature,
            p256_signature,
            noise_msg2,
        };
        assert!(DaemonSignal::parse(zero_sequence.to_json().as_bytes()).is_none());
        assert!(DaemonSignal::parse(br#"{"type":"auth_failed","reason":"x","extra":1}"#).is_none());
        assert_eq!(
            DaemonSignal::parse(br#"{"type":"auth_failed","reason":"expired"}"#),
            Some(DaemonSignal::AuthFailed {
                reason: "expired".into()
            })
        );
    }

    fn admits(value: serde_json::Value) -> bool {
        ClientSignal::parse(value.to_string().as_bytes()).is_some()
    }

    fn session_auth() -> serde_json::Value {
        serde_json::json!({
            "type": "session_auth",
            "session_token": "signed-token",
            "session_id": "session-1",
            "client_nonce": encode(&[1u8; SESSION_NONCE_BYTES]),
            "encapsulation_key": encode(&[2u8; ML_KEM_ENCAPSULATION_KEY_BYTES]),
            "delegation_certificate": {
                "userId": "user-1",
                "rootKeyCommitment": encode(&[3u8; 64]),
                "delegationId": "delegation-1",
                "delegatePublicKey": encode(&[4u8; 2_592]),
                "scopes": ["terminal-session", "session-revoke"],
                "serverOrigin": "https://merkur.example",
                "rootEpoch": 1,
                "issuedAt": 1,
                "expiresAt": 2_592_000_001_u64,
                "signature": encode(&[5u8; ML_DSA_87_SIGNATURE_BYTES]),
            },
            "delegation_signature": encode(&[6u8; ML_DSA_87_SIGNATURE_BYTES]),
            // Noise message 1 is fused into this flight; the delegate signature
            // covers `preamble || msg1`.
            "noise_msg1": encode(&[7u8; 48]),
        })
    }

    #[test]
    fn session_auth_requires_exact_nonempty_identity() {
        assert!(admits(session_auth()));
        let mut empty_session = session_auth();
        empty_session["session_id"] = serde_json::Value::String(String::new());
        let mut extended = session_auth();
        extended["unknown"] = serde_json::Value::Bool(true);
        let mut partial = session_auth();
        partial
            .as_object_mut()
            .expect("session auth object")
            .remove("encapsulation_key");
        for malformed in [empty_session, extended, partial] {
            assert!(!admits(malformed));
        }
    }

    #[test]
    fn auth_noise_and_control_envelopes_reject_surplus_or_partial_shapes() {
        for current in [
            // No `noise_init`: message 1 is fused into `session_auth` /
            // `session_rebind`, so only message 3 still needs a frame.
            serde_json::json!({"type": "noise_final", "data": "AA"}),
            serde_json::json!({"type": "network_change", "browser_node_id": "browser-1"}),
            serde_json::json!({"type": "webtransport_upgrade_init", "browser_node_id": "browser-1"}),
            serde_json::json!({"type": "webtransport_upgrade_proof", "proof_hex": "00".repeat(64)}),
            serde_json::json!({
                "type": "data_attach",
                "lane": "bulk",
                "nonce": "00112233445566778899aabbccddeeff",
            }),
            serde_json::json!({"type": "signaling_pong"}),
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "failed",
                "admission_stage": "none",
                "admission_reason": "none",
                "nat_type": "endpoint_dependent",
                "winner_kind": null,
                "candidates": [
                    {"kind": "host6", "disposition": "no_settle"},
                    {"kind": "nat_map", "disposition": "not_dialled"},
                ],
            }),
            // `lost` names a winner exactly as `selected` does.
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "lost",
                "admission_stage": "none",
                "admission_reason": "none",
                "nat_type": "endpoint_independent",
                "winner_kind": "host6",
                "candidates": [{"kind": "host6", "disposition": "won"}],
            }),
            // A connected candidate whose admission failed carries the leg.
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "failed",
                "admission_stage": "proof_write",
                "admission_reason": "timeout",
                "nat_type": "endpoint_independent",
                "winner_kind": null,
                "candidates": [{"kind": "host4", "disposition": "ready_upgrade_failed"}],
            }),
        ] {
            assert!(admits(current.clone()), "{current}");
        }

        for malformed in [
            // A retired frame type must be refused outright, not tolerated.
            serde_json::json!({"type": "noise_init", "data": "AA=="}),
            serde_json::json!({"type": "noise_final", "data": "", "extra": 1}),
            // Padded standard base64 is NOT the signaling encoding. Both ends
            // speak canonical base64url; accepting this shape is how a decoder
            // starts disagreeing with the validator about a frame's bytes.
            serde_json::json!({"type": "noise_final", "data": "AA=="}),
            serde_json::json!({"type": "noise_final", "data": "++__"}),
            serde_json::json!({"type": "noise_final", "data": encode(&[1; 300])}),
            serde_json::json!({"type": "network_change"}),
            serde_json::json!({"type": "signaling_pong", "extra": 1}),
            serde_json::json!({"type": "data_attach", "lane": "bulk", "nonce": "00"}),
            serde_json::json!({"type": "webtransport_upgrade_proof", "proof_hex": "00"}),
            serde_json::json!({"type": "webtransport_upgrade_proof", "proof_hex": "AA".repeat(64)}),
            serde_json::json!({"type": "conn2_confirmed", "bulk_nonce": "00"}),
            // The manifest names every candidate, so there is nothing to ask for.
            serde_json::json!({"type": "webtransport_reoffer_request", "exhausted": true}),
            // Unknown disposition.
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "failed",
                "admission_stage": "none",
                "admission_reason": "none",
                "nat_type": "endpoint_dependent",
                "winner_kind": null,
                "candidates": [{"kind": "host6", "disposition": "not_a_disposition"}],
            }),
            // A retired field is refused like any other surplus key.
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "failed",
                "attempt": 1,
                "admission_stage": "none",
                "admission_reason": "none",
                "nat_type": "endpoint_dependent",
                "winner_kind": null,
                "candidates": [{"kind": "host6", "disposition": "no_settle"}],
            }),
            // A candidate entry carrying a surplus key.
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "failed",
                "admission_stage": "none",
                "admission_reason": "none",
                "nat_type": "endpoint_dependent",
                "winner_kind": null,
                "candidates": [{"kind": "host6", "disposition": "no_settle", "addr": "2001:db8::1"}],
            }),
            // `winner_kind` is required even when it is null.
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "failed",
                "admission_stage": "none",
                "admission_reason": "none",
                "nat_type": "endpoint_dependent",
                "candidates": [],
            }),
            // `lost` without a winner.
            serde_json::json!({
                "type": "webtransport_outcome",
                "outcome": "lost",
                "admission_stage": "none",
                "admission_reason": "none",
                "nat_type": "endpoint_dependent",
                "winner_kind": null,
                "candidates": [{"kind": "host6", "disposition": "won"}],
            }),
            serde_json::json!({"type": "unknown", "data": "AA=="}),
        ] {
            assert!(!admits(malformed.clone()), "{malformed}");
        }
    }

    #[test]
    fn rebind_renewal_and_reconcile_carry_their_bounds() {
        let rebind = serde_json::json!({
            "type": "session_rebind",
            "session_id": "session-1",
            "browser_node_id": "browser-1",
            "rebind_counter": 3,
            "client_nonce": encode(&[1u8; SESSION_NONCE_BYTES]),
            "encapsulation_key": encode(&[2u8; ML_KEM_ENCAPSULATION_KEY_BYTES]),
            "mac": encode(&[3u8; SESSION_REBIND_MAC_BYTES]),
            "noise_msg1": encode(&[4u8; 48]),
        });
        assert!(admits(rebind.clone()));
        let mut long_session = rebind;
        long_session["session_id"] = serde_json::Value::String("s".repeat(129));
        assert!(!admits(long_session));

        let rebind_final = serde_json::json!({
            "type": "rebind_final",
            "data": encode(&[5u8; 96]),
            "mac": encode(&[6u8; SESSION_REBIND_MAC_BYTES]),
        });
        assert!(admits(rebind_final));

        let mut renew = session_auth();
        let object = renew.as_object_mut().expect("object");
        object.remove("encapsulation_key");
        object.remove("noise_msg1");
        object.insert("type".into(), "session_renew".into());
        object.insert("browser_node_id".into(), "browser-1".into());
        object.insert("rebind_counter".into(), 2.into());
        object.insert(
            "mac".into(),
            encode(&[7u8; SESSION_REBIND_MAC_BYTES]).into(),
        );
        assert!(admits(renew.clone()));
        renew["rebind_counter"] = serde_json::json!(MAX_SAFE_INTEGER + 1);
        assert!(!admits(renew));

        let reconcile = serde_json::json!({
            "type": "session_rebind_reconcile",
            "session_id": "session-1",
            "browser_node_id": "browser-1",
            "rebind_counter": 4,
            "client_nonce": encode(&[1u8; SESSION_NONCE_BYTES]),
            "attempt_digest": encode(&[2u8; 64]),
            "mac": encode(&[3u8; SESSION_REBIND_MAC_BYTES]),
            "successor_mac": encode(&[4u8; SESSION_REBIND_MAC_BYTES]),
        });
        assert!(admits(reconcile.clone()));
        let mut spent = reconcile;
        spent["rebind_counter"] = serde_json::json!(MAX_SAFE_INTEGER);
        assert!(
            !admits(spent),
            "the counter a reconcile names has a successor"
        );
    }

    fn session_rebind() -> serde_json::Value {
        serde_json::json!({
            "type": "session_rebind",
            "session_id": "session-1",
            "browser_node_id": "browser-1",
            "rebind_counter": 3,
            "client_nonce": encode(&[1u8; SESSION_NONCE_BYTES]),
            "encapsulation_key": encode(&[2u8; ML_KEM_ENCAPSULATION_KEY_BYTES]),
            "mac": encode(&[3u8; SESSION_REBIND_MAC_BYTES]),
            "noise_msg1": encode(&[4u8; 48]),
        })
    }

    fn session_renew() -> serde_json::Value {
        let mut renew = session_auth();
        let object = renew.as_object_mut().expect("object");
        object.remove("encapsulation_key");
        object.remove("noise_msg1");
        object.insert("type".into(), "session_renew".into());
        object.insert("browser_node_id".into(), "browser-1".into());
        object.insert("rebind_counter".into(), 2.into());
        object.insert(
            "mac".into(),
            encode(&[7u8; SESSION_REBIND_MAC_BYTES]).into(),
        );
        renew
    }

    fn session_rebind_reconcile() -> serde_json::Value {
        serde_json::json!({
            "type": "session_rebind_reconcile",
            "session_id": "session-1",
            "browser_node_id": "browser-1",
            "rebind_counter": 4,
            "client_nonce": encode(&[1u8; SESSION_NONCE_BYTES]),
            "attempt_digest": encode(&[2u8; 64]),
            "mac": encode(&[3u8; SESSION_REBIND_MAC_BYTES]),
            "successor_mac": encode(&[4u8; SESSION_REBIND_MAC_BYTES]),
        })
    }

    /// The daemon forms `counter + 1` when a rebind commits and reports it to
    /// a JavaScript reader, so no message may name the last safe integer.
    #[test]
    fn a_named_rebind_counter_leaves_room_for_its_successor_in_every_message() {
        for message in [
            session_rebind(),
            session_renew(),
            session_rebind_reconcile(),
        ] {
            assert!(admits(message.clone()), "{message}");
            let mut last = message.clone();
            last["rebind_counter"] = serde_json::json!(MAX_SAFE_INTEGER - 1);
            assert!(admits(last), "{} at the last counter", message["type"]);
            // 9007199254740991 and 9007199254740992.
            for counter in [MAX_SAFE_INTEGER, MAX_SAFE_INTEGER + 1] {
                let mut spent = message.clone();
                spent["rebind_counter"] = serde_json::json!(counter);
                assert!(!admits(spent), "{} naming {counter}", message["type"]);
            }
        }
    }

    #[test]
    fn a_browser_node_id_is_bounded_in_every_message_that_names_one() {
        for message in [
            session_rebind(),
            session_renew(),
            session_rebind_reconcile(),
            serde_json::json!({"type": "webtransport_upgrade_init", "browser_node_id": "browser-1"}),
            serde_json::json!({"type": "network_change", "browser_node_id": "browser-1"}),
        ] {
            let mut longest = message.clone();
            longest["browser_node_id"] = "b".repeat(MAX_SESSION_ID_BYTES).into();
            assert!(admits(longest), "{} at the bound", message["type"]);
            for refused in [String::new(), "b".repeat(MAX_SESSION_ID_BYTES + 1)] {
                let mut named = message.clone();
                let length = refused.len();
                named["browser_node_id"] = refused.into();
                assert!(!admits(named), "{} naming {length} bytes", message["type"]);
            }
        }
    }

    #[test]
    fn a_refused_rebind_envelope_reports_only_an_id_the_validator_admits() {
        let refused = |json: &str| ClientSignal::admit(json.as_bytes()).unwrap_err();
        let rebind = |session_id: Option<&str>| RefusedEnvelope::SessionRebind {
            session_id: session_id.map(str::to_owned),
        };
        // No message in shape: the type alone still names it, and an id is
        // reported only when it is one a session id may be.
        assert_eq!(refused(r#"{"type":"session_rebind"}"#), rebind(None));
        assert_eq!(
            refused(r#"{"type":"session_rebind","session_id":""}"#),
            rebind(None)
        );
        assert_eq!(
            refused(r#"{"type":"session_rebind","session_id":7}"#),
            rebind(None)
        );
        assert_eq!(
            refused(r#"{"mac":{"a":[null,1.5]},"session_id":["x"],"type":"session_rebind"}"#),
            rebind(None)
        );
        assert_eq!(
            refused(&format!(
                r#"{{"type":"session_rebind","session_id":"{}"}}"#,
                "s".repeat(MAX_SESSION_ID_BYTES + 1)
            )),
            rebind(None)
        );
        assert_eq!(
            refused(r#"{"session_id":"session-1","type":"session_rebind"}"#),
            rebind(Some("session-1"))
        );
        // A whole rebind that fails only a bound reports the id it carried.
        let mut spent = session_rebind();
        spent["rebind_counter"] = serde_json::json!(MAX_SAFE_INTEGER);
        assert_eq!(refused(&spent.to_string()), rebind(Some("session-1")));
        let mut unnamed = session_rebind();
        unnamed["session_id"] = "s".repeat(MAX_SESSION_ID_BYTES + 1).into();
        assert_eq!(refused(&unnamed.to_string()), rebind(None));
        // Anything else says nothing about itself.
        for other in [
            r#"{"type":"noise_final"}"#,
            r#"{"type":"session_rebind_reconcile","session_id":"session-1"}"#,
            r#"{"session_id":"session-1"}"#,
            r#"["session_rebind"]"#,
            "not json",
            "",
        ] {
            assert_eq!(refused(other), RefusedEnvelope::Other, "{other}");
        }
        assert!(ClientSignal::admit(session_rebind().to_string().as_bytes()).is_ok());
    }

    #[test]
    fn an_oversized_base64_field_is_refused() {
        let mut nonce = session_rebind();
        nonce["client_nonce"] = encode(&vec![1u8; 1 << 20]).into();
        assert!(!admits(nonce));
        let mut noise = session_rebind();
        noise["noise_msg1"] = encode(&vec![4u8; 1 << 20]).into();
        assert!(!admits(noise));
        let mut over = session_rebind();
        over["noise_msg1"] = encode(&[4u8; MAX_NOISE_MESSAGE_BYTES + 1]).into();
        assert!(!admits(over));
        let mut bound = session_rebind();
        bound["noise_msg1"] = encode(&[4u8; MAX_NOISE_MESSAGE_BYTES]).into();
        assert!(admits(bound));
    }

    #[test]
    fn a_handler_gets_exactly_its_message() {
        let attach = ClientSignal::DataAttach(DataClaim {
            lane: DataLane::Bulk,
            nonce: "00112233445566778899aabbccddeeff".into(),
        });
        assert_eq!(
            attach.to_json(),
            r#"{"type":"data_attach","lane":"bulk","nonce":"00112233445566778899aabbccddeeff"}"#
        );
        assert_eq!(
            ClientSignal::parse(attach.to_json().as_bytes()),
            Some(attach)
        );
        assert_eq!(
            ClientSignal::parse(br#"{"type":"signaling_pong"}"#),
            Some(ClientSignal::SignalingPong {})
        );
    }

    /// A manifest as the dataplane's `manifest_json` writes it.
    fn manifest() -> serde_json::Value {
        serde_json::json!({
            "type": "webtransport_manifest",
            "generation": 3,
            "cert_hash": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=",
            "candidates": [
                {"addr": "203.0.113.5", "port": 4433, "kind": "srflx", "scope": "public"},
                {"addr": "192.168.1.10", "port": 4433, "kind": "host4", "scope": "local"},
                {"addr": "2001:db8::10", "port": 4433, "kind": "host6", "scope": "public"},
            ],
            "nat": {
                "public_ip": "203.0.113.5",
                "nat_type": "endpoint_independent",
                "hairpin": false,
                "nat_filtering": "port_dependent",
            },
            "browser_address": "198.51.100.7",
            "punch": "pending",
        })
    }

    fn daemon(value: serde_json::Value) -> Option<DaemonSignal> {
        DaemonSignal::parse(value.to_string().as_bytes())
    }

    #[test]
    fn a_direct_path_manifest_names_every_candidate_and_its_certificate() {
        let Some(DaemonSignal::WebtransportManifest {
            generation,
            candidates,
            nat,
            browser_address,
            punch,
            ..
        }) = daemon(manifest())
        else {
            panic!("a manifest parses");
        };
        assert_eq!(generation, 3);
        assert_eq!(
            candidates[0],
            DirectCandidate {
                addr: "203.0.113.5".parse().unwrap(),
                port: 4433,
                kind: CandidateKind::Srflx,
                scope: CandidateScope::Public,
            }
        );
        assert_eq!(candidates[2].kind, CandidateKind::Host6);
        assert_eq!(nat.nat_filtering, NatFiltering::PortDependent);
        assert_eq!(browser_address, "198.51.100.7".parse::<IpAddr>().unwrap());
        assert_eq!(punch, PunchState::Pending);

        // Refused whole: more candidates than a parser accepts, a hash that is
        // not 32 bytes of base64, a port of zero, an unknown field.
        let mut over = manifest();
        over["candidates"] = serde_json::json!(vec![
            manifest()["candidates"][0].clone();
            MAX_WEBTRANSPORT_OFFER_CANDIDATES + 1
        ]);
        let mut short = manifest();
        short["cert_hash"] = serde_json::json!("q83vEjRWeJCrze8SNFZ4kA==");
        let mut zero = manifest();
        zero["candidates"][0]["port"] = serde_json::json!(0);
        let mut extra = manifest();
        extra["candidates"][1]["label"] = serde_json::json!("lan");
        for refused in [over, short, zero, extra] {
            assert_eq!(daemon(refused), None);
        }
    }

    #[test]
    fn a_punch_outcome_and_an_upgrade_challenge_parse_exactly() {
        assert_eq!(
            daemon(serde_json::json!({
                "type": "webtransport_punch",
                "generation": 3,
                "outcome": "superseded",
            })),
            Some(DaemonSignal::WebtransportPunch {
                generation: 3,
                outcome: PunchOutcome::Superseded,
            })
        );
        let challenge = |nonce: &str, temp: &str| {
            daemon(serde_json::json!({
                "type": "webtransport_upgrade_challenge",
                "nonce_hex": nonce,
                "temp_peer_id": temp,
            }))
        };
        let nonce = "ab".repeat(32);
        assert!(challenge(&nonce, "wt-pending-7").is_some());
        assert!(challenge(&nonce, "wt-pending-0").is_some());
        assert!(challenge(&nonce, "wt-pending-18446744073709551615").is_some());
        for (nonce, temp) in [
            (nonce.as_str(), "wt-pending-18446744073709551616"),
            (nonce.as_str(), "wt-pending-07"),
            (nonce.as_str(), "wt-pending-"),
            (nonce.as_str(), "peer-7"),
            ("AB".repeat(32).as_str(), "wt-pending-7"),
            ("ab".repeat(31).as_str(), "wt-pending-7"),
        ] {
            assert_eq!(challenge(nonce, temp), None, "{nonce} {temp}");
        }
    }
}
