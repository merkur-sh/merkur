//! Merkur's user-authorization records, in one implementation.
//!
//! The user root is an ML-DSA-87 key unwrapped only with the account password.
//! It signs fixed-30-day delegations to devices (a browser, the native client),
//! permanent bindings of daemon identities, and account deletion. A delegate
//! signs per-session proofs and revocations. Every record is a JSON object whose
//! fields appear in one fixed order; the signed bytes are the payload object
//! (every field but the signature) serialized exactly as `JSON.stringify` does.
//!
//! The daemon links this crate natively to verify, the native client to sign,
//! and the browser and the server reach it through `e2e-wasm`, so no second
//! encoder exists to drift.

mod canonical;
mod link;
mod records;
mod root_envelope;

pub use canonical::{
    MAX_SAFE_INTEGER, decode_exact, decode_len, encode, encoded_len, require_id, require_origin,
};
pub use link::{
    DaemonIdentitySealBackend, LinkApproval, LinkApprovalPayload, LinkClaimPayload,
    LinkPublicClaim, format_link_code, parse_link_code,
};
pub use merkur_e2e::DaemonIdentitySigningKey as SigningKey;
pub use merkur_e2e::MlDsa87Signer;
pub use records::{
    AccountDeletionPayload, AccountDeletionStatement, DaemonBinding, DaemonBindingPayload,
    DelegationCertificate, DelegationExpectation, DelegationPayload, RevocationPayload,
    RevocationStatement, RevocationTarget, session_delegation_authorization_digest,
    session_delegation_proof_transcript, sign_session_delegation_proof,
    verify_session_delegation_proof,
};
pub use root_envelope::{ROOT_ENVELOPE_NONCE_BYTES, RootEnvelope};

pub const SEED_BYTES: usize = 32;
pub const PUBLIC_KEY_BYTES: usize = merkur_e2e::DAEMON_IDENTITY_PUBLIC_KEY_BYTES;
pub const SIGNATURE_BYTES: usize = merkur_e2e::DAEMON_IDENTITY_SIGNATURE_BYTES;
pub const HASH_BYTES: usize = 64;
pub const NONCE_BYTES: usize = 32;
pub const P256_PUBLIC_KEY_BYTES: usize = 65;
pub const OPAQUE_EXPORT_KEY_BYTES: usize = 64;
pub const DELEGATION_LIFETIME_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
pub const ROOT_INITIAL_EPOCH: u64 = 1;
/// How far ahead of the verifier's clock an issuance time may be.
pub const CLOCK_SKEW_MS: u64 = 30_000;
pub const DELEGATION_SCOPES: [&str; 2] = ["terminal-session", "session-revoke"];

pub const USER_DELEGATION_CONTEXT: &[u8] = b"merkur-browser-delegation";
pub const SESSION_DELEGATION_CONTEXT: &[u8] = merkur_e2e::SESSION_DELEGATION_SIGNATURE_CONTEXT;
pub const DAEMON_BINDING_CONTEXT: &[u8] = b"merkur-daemon-binding";
pub const DELEGATION_REVOCATION_CONTEXT: &[u8] = b"merkur-delegation-revocation";
pub const ACCOUNT_DELETION_CONTEXT: &[u8] = b"merkur-account-deletion";
const ROOT_KEY_COMMITMENT_DOMAIN: &[u8] = b"merkur-user-root-key\0";

/// Why a record was refused. The text names the field and the rule, in the
/// same words the TypeScript callers have always matched on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizationError(String);

impl AuthorizationError {
    pub(crate) fn new(label: &str, rule: &str) -> Self {
        Self(format!("{label} {rule}"))
    }

    pub(crate) fn message(message: &str) -> Self {
        Self(message.to_string())
    }
}

impl std::fmt::Display for AuthorizationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AuthorizationError {}

/// `base64url(SHA-512("merkur-user-root-key\0" || rootPublicKey))`.
pub fn root_key_commitment(root_public_key: &[u8]) -> Result<String, AuthorizationError> {
    if root_public_key.len() != PUBLIC_KEY_BYTES {
        return Err(AuthorizationError::new(
            "user root public key",
            "must be exactly 2592 bytes",
        ));
    }
    let mut message = Vec::with_capacity(ROOT_KEY_COMMITMENT_DOMAIN.len() + PUBLIC_KEY_BYTES);
    message.extend_from_slice(ROOT_KEY_COMMITMENT_DOMAIN);
    message.extend_from_slice(root_public_key);
    Ok(encode(&merkur_e2e::sha512(&message)))
}

/// The composite daemon identity commitment over the ML-DSA-87 and P-256 keys.
pub fn daemon_identity_key_commitment(
    public_key: &[u8],
    p256_public_key: &[u8],
) -> Result<String, AuthorizationError> {
    if public_key.len() != PUBLIC_KEY_BYTES {
        return Err(AuthorizationError::new(
            "daemon identity public key",
            "must be exactly 2592 bytes",
        ));
    }
    if p256_public_key.len() != P256_PUBLIC_KEY_BYTES {
        return Err(AuthorizationError::new(
            "daemon P-256 public key",
            "must be exactly 65 bytes",
        ));
    }
    merkur_e2e::compute_daemon_identity_key_hash(public_key, p256_public_key)
        .map(|hash| encode(&hash))
        .map_err(|_| AuthorizationError::new("daemon identity key", "is invalid"))
}

pub(crate) fn sign(
    key: &dyn MlDsa87Signer,
    context: &[u8],
    message: &[u8],
    entropy: [u8; SEED_BYTES],
) -> Result<String, AuthorizationError> {
    key.sign_with_context(context, message, entropy)
        .map(|signature| encode(&signature))
        .map_err(|_| AuthorizationError::message("ML-DSA-87 signing failed"))
}

pub(crate) fn verify(
    public_key: &[u8],
    context: &[u8],
    message: &[u8],
    signature_b64: &str,
    label: &'static str,
) -> Result<(), AuthorizationError> {
    let signature = decode_len(signature_b64, SIGNATURE_BYTES, label)?;
    merkur_e2e::verify_ml_dsa87(public_key, context, message, &signature)
        .map_err(|_| AuthorizationError::new(label, "does not verify"))
}

/// Serializes a record exactly as `JSON.stringify` does for these field sets.
pub(crate) fn to_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("records hold only strings, integers, and arrays")
}

/// Reads a record that must already be in canonical form: the exact fields in
/// the exact order, and re-serializing to the same bytes. Payloads handed in
/// for signing are read the same way, so a caller cannot sign a reordering.
pub fn parse_canonical<T>(json: &str, label: &'static str) -> Result<T, AuthorizationError>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let value: T = serde_json::from_str(json)
        .map_err(|_| AuthorizationError::new(label, "must contain exact canonical fields"))?;
    if to_json(&value) != json {
        return Err(AuthorizationError::new(
            label,
            "must contain exact canonical fields",
        ));
    }
    Ok(value)
}
