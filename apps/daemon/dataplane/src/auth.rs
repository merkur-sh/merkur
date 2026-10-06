use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use libcrux_ml_dsa::ml_dsa_87::{self, MLDSA87Signature, MLDSA87VerificationKey};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;
#[cfg(test)]
use zeroize::Zeroizing;

use merkur_authorization::{
    DELEGATION_LIFETIME_MS as USER_DELEGATION_LIFETIME_MS, MAX_SAFE_INTEGER,
};
pub use merkur_authorization::{
    DaemonBinding, DelegationCertificate, RevocationStatement, RevocationTarget,
};

const SESSION_TOKEN_CONTEXT: &[u8] = b"merkur-session-authorization";
const SESSION_TOKEN_MAX_LIFETIME_MS: u64 = 300_000;
const SESSION_TOKEN_CLOCK_SKEW_MS: u64 = 30_000;
const SESSION_TOKEN_ID_MAX_BYTES: usize = 128;
const SESSION_TOKEN_MAX_BYTES: usize = 8 * 1024;
const ML_DSA_87_PUBLIC_KEY_BYTES: usize = merkur_e2e::DAEMON_IDENTITY_PUBLIC_KEY_BYTES;
const ML_DSA_87_SIGNATURE_BYTES: usize = merkur_e2e::DAEMON_IDENTITY_SIGNATURE_BYTES;
const COMMITMENT_BYTES: usize = merkur_e2e::SESSION_COMMITMENT_BYTES;
const NONCE_BYTES: usize = merkur_e2e::SESSION_NONCE_BYTES;
const REPLAY_CACHE_CAPACITY: usize = 1_024;
const MAX_REVOCATION_TARGETS: usize = 32;

/// User-root authorization pinned during permanent daemon enrollment. The
/// server can route these objects but cannot forge the root/delegate chain.
/// The records and their signed bytes are `merkur-authorization`'s; the rules
/// here are the daemon's own: its user, origin and epoch, local tombstones,
/// and bounded statement ages.
pub struct UserAuthorization {
    root_public_key: [u8; ML_DSA_87_PUBLIC_KEY_BYTES],
    root_key_commitment: [u8; COMMITMENT_BYTES],
    root_key_commitment_b64: String,
    user_id: String,
    server_origin: String,
    root_epoch: u64,
    revoked_delegations: HashMap<String, u64>,
}

impl UserAuthorization {
    pub(crate) fn user_id(&self) -> &str {
        &self.user_id
    }

    pub(crate) fn authorize_renewal(
        &self,
        certificate: &DelegationCertificate,
        delegation_id: &str,
        intent: &[u8],
        capability: &str,
        signature: &[u8; ML_DSA_87_SIGNATURE_BYTES],
    ) -> Result<(), AuthError> {
        let (key, canonical) = self.validate_certificate_at(
            certificate,
            &self.user_id,
            delegation_id,
            unix_time_ms()?,
            true,
        )?;
        let proof =
            merkur_e2e::build_session_renewal_delegation_proof(intent, capability, &canonical)
                .map_err(|_| AuthError::InvalidDelegationProof)?;
        merkur_e2e::verify_ml_dsa87(
            &key,
            merkur_e2e::SESSION_DELEGATION_SIGNATURE_CONTEXT,
            &proof,
            signature,
        )
        .map_err(|_| AuthError::InvalidDelegationProof)
    }

    pub fn new(
        root_public_key_b64: &str,
        root_epoch: u64,
        server_origin: &str,
        binding: &DaemonBinding,
        daemon_id: &str,
        daemon_identity_key_commitment: &[u8; COMMITMENT_BYTES],
        revoked_delegations: &[RevocationTarget],
    ) -> Result<Self, AuthError> {
        if root_epoch == 0
            || root_epoch > MAX_SAFE_INTEGER
            || !valid_protocol_id(daemon_id)
            || server_origin.is_empty()
        {
            return Err(AuthError::InvalidRootBinding);
        }
        let root_public_key =
            decode_canonical_array::<ML_DSA_87_PUBLIC_KEY_BYTES>(root_public_key_b64)
                .map_err(|_| AuthError::InvalidKey)?;
        let root_key_commitment_b64 = merkur_authorization::root_key_commitment(&root_public_key)
            .map_err(|_| AuthError::InvalidKey)?;
        let root_key_commitment =
            decode_canonical_array::<COMMITMENT_BYTES>(&root_key_commitment_b64)
                .map_err(|_| AuthError::InvalidKey)?;

        validate_daemon_binding(
            binding,
            &root_public_key,
            &root_key_commitment,
            daemon_id,
            daemon_identity_key_commitment,
            server_origin,
        )?;

        let mut tombstones = HashMap::with_capacity(revoked_delegations.len());
        for target in revoked_delegations {
            if !valid_protocol_id(&target.delegation_id)
                || target.expires_at > MAX_SAFE_INTEGER
                || tombstones
                    .insert(target.delegation_id.clone(), target.expires_at)
                    .is_some()
            {
                return Err(AuthError::InvalidRevocation);
            }
        }

        Ok(Self {
            root_public_key,
            root_key_commitment,
            root_key_commitment_b64,
            user_id: binding.user_id.clone(),
            server_origin: server_origin.to_string(),
            root_epoch,
            revoked_delegations: tombstones,
        })
    }

    pub fn authorize_session(
        &self,
        certificate: &DelegationCertificate,
        expected_user_id: &str,
        expected_delegation_id: &str,
        request_transcript: &[u8],
        delegation_signature_b64: &str,
    ) -> Result<[u8; COMMITMENT_BYTES], AuthError> {
        self.authorize_session_at(
            certificate,
            expected_user_id,
            expected_delegation_id,
            request_transcript,
            delegation_signature_b64,
            unix_time_ms()?,
        )
    }

    fn authorize_session_at(
        &self,
        certificate: &DelegationCertificate,
        expected_user_id: &str,
        expected_delegation_id: &str,
        request_transcript: &[u8],
        delegation_signature_b64: &str,
        now_ms: u64,
    ) -> Result<[u8; COMMITMENT_BYTES], AuthError> {
        let (delegate_public_key, canonical_certificate) = self.validate_certificate_at(
            certificate,
            expected_user_id,
            expected_delegation_id,
            now_ms,
            true,
        )?;
        let proof_transcript = merkur_e2e::build_session_delegation_proof_transcript(
            request_transcript,
            &canonical_certificate,
        )
        .map_err(|_| AuthError::InvalidDelegationProof)?;
        let delegation_signature =
            decode_canonical_array::<ML_DSA_87_SIGNATURE_BYTES>(delegation_signature_b64)
                .map_err(|_| AuthError::InvalidDelegationProof)?;
        if !merkur_authorization::verify_session_delegation_proof(
            &proof_transcript,
            &delegation_signature,
            &delegate_public_key,
        ) {
            return Err(AuthError::InvalidDelegationProof);
        }
        merkur_e2e::compute_session_delegation_authorization_digest(
            &proof_transcript,
            &delegation_signature,
        )
        .map_err(|_| AuthError::InvalidDelegationProof)
    }

    pub fn apply_revocation(
        &mut self,
        actor_certificate: &DelegationCertificate,
        statement: &RevocationStatement,
    ) -> Result<Vec<RevocationTarget>, AuthError> {
        self.apply_revocation_at(actor_certificate, statement, unix_time_ms()?)
    }

    fn apply_revocation_at(
        &mut self,
        actor_certificate: &DelegationCertificate,
        statement: &RevocationStatement,
        now_ms: u64,
    ) -> Result<Vec<RevocationTarget>, AuthError> {
        validate_revocation_statement(statement, self, now_ms)?;
        let is_idempotent_noop = statement.targets.iter().all(|target| {
            self.revoked_delegations
                .get(&target.delegation_id)
                .is_some_and(|expires_at| *expires_at >= target.expires_at)
        });
        if !is_idempotent_noop
            && self
                .revoked_delegations
                .get(&statement.actor_delegation_id)
                .is_some_and(|expires_at| now_ms < *expires_at)
        {
            return Err(AuthError::RevokedDelegation);
        }
        let (actor_public_key, _) = self.validate_certificate_at(
            actor_certificate,
            &statement.user_id,
            &statement.actor_delegation_id,
            statement.issued_at,
            false,
        )?;
        statement
            .verify(&actor_public_key)
            .map_err(|_| AuthError::InvalidRevocation)?;
        for target in &statement.targets {
            self.revoked_delegations
                .entry(target.delegation_id.clone())
                .and_modify(|expires_at| *expires_at = (*expires_at).max(target.expires_at))
                .or_insert(target.expires_at);
        }
        Ok(statement.targets.clone())
    }

    fn validate_certificate_at(
        &self,
        certificate: &DelegationCertificate,
        expected_user_id: &str,
        expected_delegation_id: &str,
        now_ms: u64,
        enforce_revocation: bool,
    ) -> Result<([u8; ML_DSA_87_PUBLIC_KEY_BYTES], Vec<u8>), AuthError> {
        // Fields, lengths, scopes and the fixed lifetime are the record's own
        // rules; everything after is what this daemon knows.
        certificate
            .validate()
            .map_err(|_| AuthError::InvalidDelegation)?;
        if !valid_protocol_id(expected_user_id)
            || !valid_protocol_id(expected_delegation_id)
            || certificate.issued_at > now_ms.saturating_add(SESSION_TOKEN_CLOCK_SKEW_MS)
            || now_ms >= certificate.expires_at
        {
            return Err(AuthError::InvalidDelegation);
        }
        if certificate.user_id != self.user_id || certificate.user_id != expected_user_id {
            return Err(AuthError::WrongUser);
        }
        if certificate.delegation_id != expected_delegation_id {
            return Err(AuthError::WrongDelegation);
        }
        if certificate.server_origin != self.server_origin
            || certificate.root_epoch != self.root_epoch
        {
            return Err(AuthError::InvalidDelegation);
        }
        let certificate_root =
            decode_canonical_array::<COMMITMENT_BYTES>(&certificate.root_key_commitment)
                .map_err(|_| AuthError::InvalidDelegation)?;
        if !bool::from(certificate_root.ct_eq(&self.root_key_commitment)) {
            return Err(AuthError::InvalidDelegation);
        }
        if enforce_revocation
            && self
                .revoked_delegations
                .get(&certificate.delegation_id)
                .is_some_and(|expires_at| now_ms < *expires_at)
        {
            return Err(AuthError::RevokedDelegation);
        }
        certificate
            .verify_signature(&self.root_public_key)
            .map_err(|_| AuthError::InvalidDelegation)?;
        let delegate_public_key = certificate
            .delegate_public_key_bytes()
            .map_err(|_| AuthError::InvalidDelegation)?;
        Ok((delegate_public_key, certificate.to_json().into_bytes()))
    }
}

fn validate_daemon_binding(
    binding: &DaemonBinding,
    root_public_key: &[u8; ML_DSA_87_PUBLIC_KEY_BYTES],
    root_key_commitment: &[u8; COMMITMENT_BYTES],
    daemon_id: &str,
    daemon_identity_key_commitment: &[u8; COMMITMENT_BYTES],
    server_origin: &str,
) -> Result<(), AuthError> {
    if !valid_protocol_id(&binding.user_id)
        || !valid_protocol_id(&binding.daemon_id)
        || !valid_protocol_id(&binding.link_claim_id)
        || binding.issued_at > MAX_SAFE_INTEGER
        || binding.daemon_id != daemon_id
        || binding.server_origin != server_origin
    {
        return Err(AuthError::InvalidRootBinding);
    }
    let binding_root = decode_canonical_array::<COMMITMENT_BYTES>(&binding.root_key_commitment)
        .map_err(|_| AuthError::InvalidRootBinding)?;
    let binding_daemon =
        decode_canonical_array::<COMMITMENT_BYTES>(&binding.daemon_identity_key_commitment)
            .map_err(|_| AuthError::InvalidRootBinding)?;
    if !bool::from(binding_root.ct_eq(root_key_commitment))
        || !bool::from(binding_daemon.ct_eq(daemon_identity_key_commitment))
    {
        return Err(AuthError::InvalidRootBinding);
    }
    binding
        .verify_signature(root_public_key)
        .map_err(|_| AuthError::InvalidRootBinding)
}

fn validate_revocation_statement(
    statement: &RevocationStatement,
    authorization: &UserAuthorization,
    now_ms: u64,
) -> Result<(), AuthError> {
    if statement.user_id != authorization.user_id
        || statement.root_key_commitment != authorization.root_key_commitment_b64
        || !valid_protocol_id(&statement.actor_delegation_id)
        || statement.targets.is_empty()
        || statement.targets.len() > MAX_REVOCATION_TARGETS
        || statement.issued_at > MAX_SAFE_INTEGER
        || statement.issued_at > now_ms.saturating_add(SESSION_TOKEN_CLOCK_SKEW_MS)
        || now_ms.saturating_sub(statement.issued_at)
            > USER_DELEGATION_LIFETIME_MS + SESSION_TOKEN_CLOCK_SKEW_MS
        || decode_canonical_array::<32>(&statement.nonce).is_err()
    {
        return Err(AuthError::InvalidRevocation);
    }
    let mut previous: Option<&str> = None;
    for target in &statement.targets {
        if !valid_protocol_id(&target.delegation_id)
            || target.expires_at > MAX_SAFE_INTEGER
            || target.expires_at <= statement.issued_at
            || target.expires_at
                > statement
                    .issued_at
                    .saturating_add(USER_DELEGATION_LIFETIME_MS)
            || previous.is_some_and(|value| value >= target.delegation_id.as_str())
        {
            return Err(AuthError::InvalidRevocation);
        }
        previous = Some(&target.delegation_id);
    }
    Ok(())
}

pub struct SessionAuthority {
    verify_key: MLDSA87VerificationKey,
    daemon_id: String,
}

#[derive(Debug)]
pub struct ValidatedSession {
    pub expires_at_ms: u64,
    pub delegation_id: String,
    pub browser_node_id: String,
    pub session_id: String,
    pub daemon_identity_key_hash: [u8; COMMITMENT_BYTES],
    pub request_commitment: [u8; COMMITMENT_BYTES],
}

/// Exact canonical payload signed by the application server. Field declaration
/// order is protocol order because reserialization must reproduce the signed
/// JSON bytes byte-for-byte: `{u,g,b,d,s,k,q,iat,e}`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SessionTokenPayload {
    u: String,
    g: String,
    b: String,
    d: String,
    s: String,
    k: String,
    q: String,
    iat: u64,
    e: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthError {
    MalformedToken,
    InvalidSignature,
    Expired,
    NotYetValid,
    WrongDaemon,
    WrongSession,
    WrongUser,
    WrongDelegation,
    PeerMismatch,
    InvalidKey,
    InvalidRootBinding,
    InvalidDelegation,
    RevokedDelegation,
    InvalidDelegationProof,
    InvalidRevocation,
    Random,
    #[cfg(test)]
    Signing,
    Clock,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::MalformedToken => write!(f, "malformed token"),
            AuthError::InvalidSignature => write!(f, "invalid signature"),
            AuthError::Expired => write!(f, "token expired"),
            AuthError::NotYetValid => write!(f, "token issued implausibly far in the future"),
            AuthError::WrongDaemon => write!(f, "wrong daemon id"),
            AuthError::WrongSession => write!(f, "wrong session id"),
            AuthError::WrongUser => write!(f, "wrong user id"),
            AuthError::WrongDelegation => write!(f, "wrong delegation id"),
            AuthError::PeerMismatch => write!(f, "peer id mismatch"),
            AuthError::InvalidKey => write!(f, "invalid key material"),
            AuthError::InvalidRootBinding => write!(f, "invalid daemon root binding"),
            AuthError::InvalidDelegation => write!(f, "invalid browser delegation"),
            AuthError::RevokedDelegation => write!(f, "revoked browser delegation"),
            AuthError::InvalidDelegationProof => write!(f, "invalid session delegation proof"),
            AuthError::InvalidRevocation => write!(f, "invalid delegation revocation"),
            AuthError::Random => write!(f, "secure random generation failed"),
            #[cfg(test)]
            AuthError::Signing => write!(f, "daemon identity signing failed"),
            AuthError::Clock => write!(f, "system clock is before the Unix epoch or out of range"),
        }
    }
}

impl SessionAuthority {
    pub fn new(verify_key_b64: &str, daemon_id: &str) -> Result<Self, AuthError> {
        if !valid_protocol_id(daemon_id) {
            return Err(AuthError::InvalidKey);
        }
        let verify_key_bytes = decode_canonical_array::<ML_DSA_87_PUBLIC_KEY_BYTES>(verify_key_b64)
            .map_err(|_| AuthError::InvalidKey)?;
        let verify_key = MLDSA87VerificationKey::new(verify_key_bytes);
        Ok(Self {
            verify_key,
            daemon_id: daemon_id.to_string(),
        })
    }

    pub fn validate(
        &self,
        token: &str,
        peer_node_id: &str,
        session_id: &str,
        user_id: &str,
        delegation_id: &str,
    ) -> Result<ValidatedSession, AuthError> {
        self.validate_at(
            token,
            peer_node_id,
            session_id,
            user_id,
            delegation_id,
            unix_time_ms()?,
        )
    }

    fn validate_at(
        &self,
        token: &str,
        peer_node_id: &str,
        session_id: &str,
        user_id: &str,
        delegation_id: &str,
        now_ms: u64,
    ) -> Result<ValidatedSession, AuthError> {
        if token.len() > SESSION_TOKEN_MAX_BYTES
            || !valid_protocol_id(peer_node_id)
            || !valid_protocol_id(session_id)
            || !valid_protocol_id(user_id)
            || !valid_protocol_id(delegation_id)
        {
            return Err(AuthError::MalformedToken);
        }

        let mut segments = token.split('.');
        let payload_b64 = segments.next().filter(|value| !value.is_empty());
        let signature_b64 = segments.next().filter(|value| !value.is_empty());
        if payload_b64.is_none() || signature_b64.is_none() || segments.next().is_some() {
            return Err(AuthError::MalformedToken);
        }
        let payload_b64 = payload_b64.expect("checked above");
        let signature_b64 = signature_b64.expect("checked above");

        let payload_bytes = decode_canonical(payload_b64).map_err(|_| AuthError::MalformedToken)?;
        let payload: SessionTokenPayload =
            serde_json::from_slice(&payload_bytes).map_err(|_| AuthError::MalformedToken)?;
        if serde_json::to_vec(&payload).map_err(|_| AuthError::MalformedToken)? != payload_bytes {
            return Err(AuthError::MalformedToken);
        }
        let daemon_identity_key_hash = decode_canonical_array::<COMMITMENT_BYTES>(&payload.k)
            .map_err(|_| AuthError::MalformedToken)?;
        let request_commitment = decode_canonical_array::<COMMITMENT_BYTES>(&payload.q)
            .map_err(|_| AuthError::MalformedToken)?;
        if !valid_protocol_id(&payload.u)
            || !valid_protocol_id(&payload.g)
            || !valid_protocol_id(&payload.b)
            || !valid_protocol_id(&payload.d)
            || !valid_protocol_id(&payload.s)
            || payload.e <= payload.iat
            || payload.e - payload.iat > SESSION_TOKEN_MAX_LIFETIME_MS
        {
            return Err(AuthError::MalformedToken);
        }
        if payload.d != self.daemon_id {
            return Err(AuthError::WrongDaemon);
        }
        if payload.s != session_id {
            return Err(AuthError::WrongSession);
        }
        if payload.u != user_id {
            return Err(AuthError::WrongUser);
        }
        if payload.g != delegation_id {
            return Err(AuthError::WrongDelegation);
        }
        if payload.b != peer_node_id {
            return Err(AuthError::PeerMismatch);
        }
        if payload.iat > now_ms.saturating_add(SESSION_TOKEN_CLOCK_SKEW_MS) {
            return Err(AuthError::NotYetValid);
        }
        if now_ms >= payload.e {
            return Err(AuthError::Expired);
        }

        let signature = decode_canonical_array::<ML_DSA_87_SIGNATURE_BYTES>(signature_b64)
            .map_err(|_| AuthError::MalformedToken)?;
        let signature = MLDSA87Signature::new(signature);
        if ml_dsa_87::verify(
            &self.verify_key,
            payload_b64.as_bytes(),
            SESSION_TOKEN_CONTEXT,
            &signature,
        )
        .is_err()
        {
            return Err(AuthError::InvalidSignature);
        }

        Ok(ValidatedSession {
            expires_at_ms: payload.e,
            delegation_id: payload.g,
            browser_node_id: payload.b,
            session_id: payload.s,
            daemon_identity_key_hash,
            request_commitment,
        })
    }
}

/// The exact nonce/key tuple durably issued by the server and delivered over
/// the authenticated daemon control plane. Edge input must match it before any
/// ML-DSA verification or ML-KEM operation is allowed.
#[derive(Clone)]
pub struct PendingSessionRequest {
    user_id: String,
    delegation_id: String,
    session_id: String,
    client_nonce: [u8; NONCE_BYTES],
    encapsulation_key: [u8; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES],
}

impl PendingSessionRequest {
    pub fn from_encoded(
        user_id: &str,
        delegation_id: &str,
        session_id: &str,
        client_nonce: &str,
        encapsulation_key: &str,
    ) -> Result<Self, AuthError> {
        if !valid_protocol_id(user_id)
            || !valid_protocol_id(delegation_id)
            || !valid_protocol_id(session_id)
        {
            return Err(AuthError::MalformedToken);
        }
        Ok(Self {
            user_id: user_id.to_string(),
            delegation_id: delegation_id.to_string(),
            session_id: session_id.to_string(),
            client_nonce: decode_canonical_array(client_nonce)
                .map_err(|_| AuthError::MalformedToken)?,
            encapsulation_key: decode_canonical_array(encapsulation_key)
                .map_err(|_| AuthError::MalformedToken)?,
        })
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    pub fn delegation_id(&self) -> &str {
        &self.delegation_id
    }

    pub fn matches(
        &self,
        session_id: &str,
        client_nonce: &[u8; NONCE_BYTES],
        encapsulation_key: &[u8; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES],
    ) -> bool {
        let cryptographic_tuple_matches = self.client_nonce.ct_eq(client_nonce)
            & self
                .encapsulation_key
                .as_slice()
                .ct_eq(encapsulation_key.as_slice());
        self.session_id == session_id && bool::from(cryptographic_tuple_matches)
    }

    /// A repeated control command is idempotent only when its complete signed
    /// identity and PQ tuple are unchanged. Token refreshes use a fresh session
    /// id; re-binding an existing id would make two capabilities share one
    /// rendezvous owner.
    pub fn same_offer(&self, other: &Self) -> bool {
        let cryptographic_tuple_matches = self.client_nonce.ct_eq(&other.client_nonce)
            & self
                .encapsulation_key
                .as_slice()
                .ct_eq(other.encapsulation_key.as_slice());
        self.user_id == other.user_id
            && self.delegation_id == other.delegation_id
            && self.session_id == other.session_id
            && bool::from(cryptographic_tuple_matches)
    }
}

struct ReplayCache {
    order: VecDeque<([u8; COMMITMENT_BYTES], u64)>,
    seen: HashSet<[u8; COMMITMENT_BYTES]>,
}

/// Static daemon ML-DSA identity plus process-local replay and randomness
/// state. There is no browser-specific or pairing-root secret.
pub struct DaemonIdentity {
    signer: crate::identity_signer::IdentitySigner,
    #[cfg(test)]
    signing_key: merkur_e2e::DaemonIdentitySigningKey,
    public_key_hash: [u8; COMMITMENT_BYTES],
    daemon_id: String,
    revocation_generation: u32,
    rng: SystemRandom,
    replay_cache: Mutex<ReplayCache>,
}

impl DaemonIdentity {
    pub fn open(
        seal: &crate::identity_seal::IdentitySealWire,
        daemon_id: &str,
    ) -> Result<Self, crate::identity_seal::SealError> {
        use crate::identity_seal::SealError;
        use crate::identity_signer::IdentitySigner;
        if !valid_protocol_id(daemon_id) {
            return Err(SealError::InvalidMaterial);
        }
        let custody = crate::identity_seal::open(seal)?;
        // Tests open only software custody, whose material is the seed.
        #[cfg(test)]
        let signing_key = merkur_e2e::DaemonIdentitySigningKey::from_seed(&mut Zeroizing::new(
            base64::Engine::decode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                &seal.material,
            )
            .map_err(|_| SealError::InvalidMaterial)?,
        ))?;
        let signer = IdentitySigner::new(custody)?;
        let public_key_hash = merkur_e2e::compute_daemon_identity_key_hash(
            &signer.public_key,
            &signer.p256_public_key,
        )?;
        Ok(Self {
            signer,
            #[cfg(test)]
            signing_key,
            public_key_hash,
            daemon_id: daemon_id.to_string(),
            revocation_generation: 0,
            rng: SystemRandom::new(),
            replay_cache: Mutex::new(ReplayCache {
                order: VecDeque::with_capacity(REPLAY_CACHE_CAPACITY),
                seen: HashSet::with_capacity(REPLAY_CACHE_CAPACITY),
            }),
        })
    }

    #[cfg(test)]
    pub fn new(signing_seed_b64: &str, daemon_id: &str) -> Result<Self, AuthError> {
        Self::open(
            &crate::identity_seal::IdentitySealWire {
                backend: crate::identity_seal::Backend::Software,
                material: signing_seed_b64.to_string(),
            },
            daemon_id,
        )
        .map_err(|_| AuthError::InvalidKey)
    }

    pub fn request_signature(
        &self,
        context: &'static [u8],
        transcript: Vec<u8>,
    ) -> Result<
        tokio::sync::oneshot::Receiver<
            Result<crate::identity_signer::SignaturePair, crate::identity_seal::SealError>,
        >,
        crate::identity_seal::SealError,
    > {
        self.signer.sign(context, transcript)
    }

    pub fn daemon_id(&self) -> &str {
        &self.daemon_id
    }

    pub fn key_hash_matches(&self, candidate: &[u8; COMMITMENT_BYTES]) -> bool {
        bool::from(self.public_key_hash.ct_eq(candidate))
    }

    pub fn public_key_hash(&self) -> [u8; COMMITMENT_BYTES] {
        self.public_key_hash
    }

    pub fn set_revocation_generation(&mut self, generation: u32) -> bool {
        if generation <= self.revocation_generation {
            return false;
        }
        self.revocation_generation = generation;
        true
    }

    /// Produces fresh random bytes without a panic or deterministic fallback.
    pub fn generate_random<const N: usize>(&self) -> Result<[u8; N], AuthError> {
        let mut bytes = [0u8; N];
        if self.rng.fill(&mut bytes).is_err() {
            bytes.zeroize();
            return Err(AuthError::Random);
        }
        Ok(bytes)
    }

    #[cfg(test)]
    pub fn sign_response(
        &self,
        response_transcript: &[u8],
    ) -> Result<[u8; ML_DSA_87_SIGNATURE_BYTES], AuthError> {
        self.sign_response_with_rng(response_transcript, |bytes| {
            self.rng.fill(bytes).map_err(|_| ())
        })
    }

    #[cfg(test)]
    fn sign_response_with_rng<F>(
        &self,
        response_transcript: &[u8],
        fill: F,
    ) -> Result<[u8; ML_DSA_87_SIGNATURE_BYTES], AuthError>
    where
        F: FnOnce(&mut [u8]) -> Result<(), ()>,
    {
        let mut randomness =
            Zeroizing::new([0u8; merkur_e2e::DAEMON_IDENTITY_SIGNING_RANDOM_BYTES]);
        if fill(&mut *randomness).is_err() {
            randomness.zeroize();
            return Err(AuthError::Random);
        }
        let result = self
            .signing_key
            .sign_response(response_transcript, *randomness)
            .map_err(|_| AuthError::Signing);
        randomness.zeroize();
        result
    }

    /// Claims a server-signed request commitment exactly once. This runs after
    /// ML-DSA verification and k/q comparison but before ML-KEM encapsulation,
    /// so unauthenticated traffic cannot fill the cache or force KEM work.
    pub fn claim_request_commitment(&self, commitment: [u8; COMMITMENT_BYTES]) -> bool {
        let Ok(now_ms) = unix_time_ms() else {
            return false;
        };
        self.claim_request_commitment_at(commitment, now_ms)
    }

    fn claim_request_commitment_at(&self, commitment: [u8; COMMITMENT_BYTES], now_ms: u64) -> bool {
        let Ok(mut cache) = self.replay_cache.lock() else {
            return false;
        };
        while cache
            .order
            .front()
            .is_some_and(|(_, expires_at_ms)| *expires_at_ms <= now_ms)
        {
            if let Some((expired_commitment, _)) = cache.order.pop_front() {
                cache.seen.remove(&expired_commitment);
            }
        }
        if cache.seen.contains(&commitment) || cache.order.len() >= REPLAY_CACHE_CAPACITY {
            return false;
        }
        let expires_at_ms =
            now_ms.saturating_add(SESSION_TOKEN_MAX_LIFETIME_MS + SESSION_TOKEN_CLOCK_SKEW_MS);
        cache.seen.insert(commitment);
        cache.order.push_back((commitment, expires_at_ms));
        true
    }
}

fn valid_protocol_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= SESSION_TOKEN_ID_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn decode_canonical(value: &str) -> Result<Vec<u8>, ()> {
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| ())?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(());
    }
    Ok(decoded)
}

/// Canonical decode of a variable-length field.
///
/// Same discipline as `decode_canonical_array`, for the fields whose length is
/// not fixed — a Noise message is one ephemeral plus framing, so it is bounded
/// rather than pinned. Non-canonical base64 is refused for the same reason it
/// is everywhere else here: two encodings of one value would let an attacker
/// vary the bytes a digest is taken over without changing what they decode to.
pub(crate) fn decode_canonical_bytes(value: &str) -> Result<Vec<u8>, ()> {
    decode_canonical(value)
}

pub(crate) fn decode_canonical_array<const N: usize>(value: &str) -> Result<[u8; N], ()> {
    let decoded = decode_canonical(value)?;
    decoded.try_into().map_err(|_| ())
}

pub(crate) fn unix_time_ms() -> Result<u64, AuthError> {
    unix_time_ms_at(SystemTime::now())
}

fn unix_time_ms_at(now: SystemTime) -> Result<u64, AuthError> {
    let millis = now
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AuthError::Clock)?
        .as_millis();
    u64::try_from(millis).map_err(|_| AuthError::Clock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionAuthorizationVector {
        verify_key_base64_url: String,
        token: String,
        payload: SessionTokenPayload,
        verify_at_ms: u64,
        context: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct UserAuthorizationVector {
        root_public_key: String,
        root_key_commitment: String,
        root_epoch: u64,
        server_origin: String,
        user_id: String,
        delegation_id: String,
        daemon_identity_seed_base64_url: String,
        daemon_identity_key_commitment: String,
        daemon_binding: DaemonBinding,
        certificate: DelegationCertificate,
        request_transcript_base64_url: String,
        proof_transcript_base64_url: String,
        delegation_signature: String,
        authorization_digest: String,
        revocation: RevocationStatement,
        verify_at_ms: u64,
    }

    fn daemon_identity() -> DaemonIdentity {
        DaemonIdentity::new(
            &URL_SAFE_NO_PAD.encode([9u8; merkur_e2e::DAEMON_IDENTITY_SEED_BYTES]),
            "daemon-a",
        )
        .expect("daemon identity")
    }

    #[test]
    fn pending_tuple_is_canonical_and_compared_in_constant_time() {
        let nonce = [3u8; NONCE_BYTES];
        let key = [5u8; merkur_e2e::ML_KEM_ENCAPSULATION_KEY_BYTES];
        let pending = PendingSessionRequest::from_encoded(
            "user-a",
            "delegation-a",
            "session-a",
            &URL_SAFE_NO_PAD.encode(nonce),
            &URL_SAFE_NO_PAD.encode(key),
        )
        .unwrap();
        assert!(pending.matches("session-a", &nonce, &key));
        let mut changed_nonce = nonce;
        changed_nonce[0] ^= 1;
        let mut changed_key = key;
        changed_key[0] ^= 1;
        assert!(!pending.matches("wrong-session", &nonce, &key));
        assert!(!pending.matches("session-a", &changed_nonce, &key));
        assert!(!pending.matches("session-a", &nonce, &changed_key));
        let exact_retry = PendingSessionRequest::from_encoded(
            "user-a",
            "delegation-a",
            "session-a",
            &URL_SAFE_NO_PAD.encode(nonce),
            &URL_SAFE_NO_PAD.encode(key),
        )
        .unwrap();
        let changed_user = PendingSessionRequest::from_encoded(
            "user-b",
            "delegation-a",
            "session-a",
            &URL_SAFE_NO_PAD.encode(nonce),
            &URL_SAFE_NO_PAD.encode(key),
        )
        .unwrap();
        let changed_delegation = PendingSessionRequest::from_encoded(
            "user-a",
            "delegation-b",
            "session-a",
            &URL_SAFE_NO_PAD.encode(nonce),
            &URL_SAFE_NO_PAD.encode(key),
        )
        .unwrap();
        assert!(pending.same_offer(&exact_retry));
        assert!(!pending.same_offer(&changed_user));
        assert!(!pending.same_offer(&changed_delegation));
        assert!(
            PendingSessionRequest::from_encoded(
                "user-a",
                "delegation-a",
                "session-a",
                &format!("{}=", URL_SAFE_NO_PAD.encode(nonce)),
                &URL_SAFE_NO_PAD.encode(key),
            )
            .is_err()
        );
    }

    #[test]
    fn request_commitment_replay_claims_are_one_use_and_bounded() {
        let identity = daemon_identity();
        let now_ms = 10_000;
        for index in 0..REPLAY_CACHE_CAPACITY {
            let mut commitment = [0u8; COMMITMENT_BYTES];
            commitment[..8].copy_from_slice(&(index as u64).to_be_bytes());
            assert!(identity.claim_request_commitment_at(commitment, now_ms));
        }
        let mut overflow = [0u8; COMMITMENT_BYTES];
        overflow[..8].copy_from_slice(&(REPLAY_CACHE_CAPACITY as u64).to_be_bytes());
        assert!(!identity.claim_request_commitment_at(overflow, now_ms));
        assert!(!identity.claim_request_commitment_at([0; COMMITMENT_BYTES], now_ms));

        let expired_at = now_ms + SESSION_TOKEN_MAX_LIFETIME_MS + SESSION_TOKEN_CLOCK_SKEW_MS;
        assert!(identity.claim_request_commitment_at([0; COMMITMENT_BYTES], expired_at));
    }

    #[test]
    fn identity_signing_rng_failure_fails_closed_without_fallback() {
        let identity = daemon_identity();
        let client =
            merkur_e2e::SessionClientBootstrap::new([1; merkur_e2e::ML_KEM_KEYGEN_SEED_BYTES]);
        let request = merkur_e2e::build_session_request_transcript(
            b"token",
            "session-a",
            "browser-a",
            "daemon-a",
            &[2; NONCE_BYTES],
            client.encapsulation_key(),
        )
        .unwrap();
        let encapsulation = merkur_e2e::SessionServerEncapsulation::new(
            client.encapsulation_key(),
            [3; merkur_e2e::ML_KEM_ENCAPS_RANDOM_BYTES],
        )
        .unwrap();
        let response = merkur_e2e::build_session_response_transcript(
            &request,
            &[8; COMMITMENT_BYTES],
            &[4; NONCE_BYTES],
            encapsulation.ciphertext(),
            0,
            &[0x96; 96],
        )
        .unwrap();
        assert_eq!(
            identity.sign_response_with_rng(&response, |_| Err(())),
            Err(AuthError::Random)
        );
    }

    #[test]
    fn typescript_user_root_vector_verifies_and_revokes_with_rust() {
        let vector: UserAuthorizationVector = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/shared/test-vectors/user-authorization-mldsa87.json"
        )))
        .expect("user authorization vector must be valid JSON");
        let identity = DaemonIdentity::new(
            &vector.daemon_identity_seed_base64_url,
            &vector.daemon_binding.daemon_id,
        )
        .expect("vector daemon identity");
        assert_eq!(
            identity.public_key_hash(),
            decode_canonical_array::<COMMITMENT_BYTES>(&vector.daemon_identity_key_commitment)
                .expect("vector daemon key commitment")
        );

        let mut authorization = UserAuthorization::new(
            &vector.root_public_key,
            vector.root_epoch,
            &vector.server_origin,
            &vector.daemon_binding,
            &vector.daemon_binding.daemon_id,
            &identity.public_key_hash(),
            &[],
        )
        .expect("root-signed daemon binding");
        assert_eq!(authorization.user_id, vector.user_id);
        assert_eq!(
            authorization.root_key_commitment_b64,
            vector.root_key_commitment
        );

        let request_transcript = decode_canonical(&vector.request_transcript_base64_url)
            .expect("canonical request transcript");
        let canonical_certificate =
            serde_json::to_vec(&vector.certificate).expect("canonical certificate JSON");
        let proof_transcript = merkur_e2e::build_session_delegation_proof_transcript(
            &request_transcript,
            &canonical_certificate,
        )
        .expect("delegation proof transcript");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&proof_transcript),
            vector.proof_transcript_base64_url
        );
        let authorization_digest = authorization
            .authorize_session_at(
                &vector.certificate,
                &vector.user_id,
                &vector.delegation_id,
                &request_transcript,
                &vector.delegation_signature,
                vector.verify_at_ms,
            )
            .expect("root certificate and exact-session delegate proof");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(authorization_digest),
            vector.authorization_digest
        );

        let expected_targets = vector.revocation.targets.clone();
        assert_eq!(
            authorization
                .apply_revocation_at(&vector.certificate, &vector.revocation, vector.verify_at_ms,)
                .expect("delegate-signed revocation"),
            expected_targets
        );
        assert_eq!(
            authorization
                .apply_revocation_at(&vector.certificate, &vector.revocation, vector.verify_at_ms,)
                .expect("exact repeated revocation is idempotent"),
            expected_targets
        );
        let mut delegate_seed: [u8; 32] = std::array::from_fn(|index| 0x20 + index as u8);
        let delegate_key =
            merkur_authorization::SigningKey::from_seed(&mut delegate_seed).expect("delegate seed");
        let revoked_actor_statement = RevocationStatement::create(
            merkur_authorization::RevocationPayload {
                user_id: vector.user_id.clone(),
                root_key_commitment: vector.root_key_commitment.clone(),
                actor_delegation_id: vector.delegation_id.clone(),
                targets: vec![RevocationTarget {
                    delegation_id: "another-delegation".to_string(),
                    expires_at: vector.verify_at_ms + USER_DELEGATION_LIFETIME_MS,
                }],
                issued_at: vector.verify_at_ms,
                nonce: URL_SAFE_NO_PAD.encode([0x77; 32]),
            },
            &delegate_key,
            [0x78; 32],
        )
        .expect("revoked actor statement");
        assert_eq!(
            authorization.apply_revocation_at(
                &vector.certificate,
                &revoked_actor_statement,
                vector.verify_at_ms,
            ),
            Err(AuthError::RevokedDelegation)
        );
        assert_eq!(
            authorization.authorize_session_at(
                &vector.certificate,
                &vector.user_id,
                &vector.delegation_id,
                &request_transcript,
                &vector.delegation_signature,
                vector.verify_at_ms,
            ),
            Err(AuthError::RevokedDelegation)
        );
    }

    #[test]
    fn token_time_window_rejects_invalid_bounds() {
        assert!(unix_time_ms_at(UNIX_EPOCH).is_ok());
        assert!(unix_time_ms_at(UNIX_EPOCH - std::time::Duration::from_millis(1)).is_err());
    }

    #[test]
    fn noble_session_token_vector_verifies_with_libcrux_and_is_context_bound() {
        let vector: SessionAuthorizationVector = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/shared/test-vectors/session-authorization-mldsa87.json"
        )))
        .expect("session authorization vector must be valid JSON");
        assert_eq!(vector.context.as_bytes(), SESSION_TOKEN_CONTEXT);
        let authority = SessionAuthority::new(&vector.verify_key_base64_url, &vector.payload.d)
            .expect("vector verification key");

        let validated = authority
            .validate_at(
                &vector.token,
                &vector.payload.b,
                &vector.payload.s,
                &vector.payload.u,
                &vector.payload.g,
                vector.verify_at_ms,
            )
            .expect("noble ML-DSA-87 signature must verify with libcrux");
        assert_eq!(validated.browser_node_id, vector.payload.b);
        assert_eq!(validated.delegation_id, vector.payload.g);
        assert_eq!(validated.session_id, vector.payload.s);
        assert_eq!(
            validated.daemon_identity_key_hash,
            decode_canonical_array::<COMMITMENT_BYTES>(&vector.payload.k).unwrap()
        );
        assert_eq!(
            validated.request_commitment,
            decode_canonical_array::<COMMITMENT_BYTES>(&vector.payload.q).unwrap()
        );
        assert!(matches!(
            authority.validate_at(
                &vector.token,
                "wrong-browser",
                &vector.payload.s,
                &vector.payload.u,
                &vector.payload.g,
                vector.verify_at_ms,
            ),
            Err(AuthError::PeerMismatch)
        ));
        assert!(matches!(
            authority.validate_at(
                &vector.token,
                &vector.payload.b,
                "wrong-session",
                &vector.payload.u,
                &vector.payload.g,
                vector.verify_at_ms,
            ),
            Err(AuthError::WrongSession)
        ));
        assert!(matches!(
            authority.validate_at(
                &vector.token,
                &vector.payload.b,
                &vector.payload.s,
                "wrong-user",
                &vector.payload.g,
                vector.verify_at_ms,
            ),
            Err(AuthError::WrongUser)
        ));
        assert!(matches!(
            authority.validate_at(
                &vector.token,
                &vector.payload.b,
                &vector.payload.s,
                &vector.payload.u,
                "wrong-delegation",
                vector.verify_at_ms,
            ),
            Err(AuthError::WrongDelegation)
        ));
        let wrong_daemon = SessionAuthority::new(&vector.verify_key_base64_url, "wrong-daemon")
            .expect("verification key");
        assert!(matches!(
            wrong_daemon.validate_at(
                &vector.token,
                &vector.payload.b,
                &vector.payload.s,
                &vector.payload.u,
                &vector.payload.g,
                vector.verify_at_ms,
            ),
            Err(AuthError::WrongDaemon)
        ));
        assert!(matches!(
            authority.validate_at(
                &vector.token,
                &vector.payload.b,
                &vector.payload.s,
                &vector.payload.u,
                &vector.payload.g,
                vector.payload.e,
            ),
            Err(AuthError::Expired)
        ));
        assert!(matches!(
            authority.validate_at(
                &vector.token,
                &vector.payload.b,
                &vector.payload.s,
                &vector.payload.u,
                &vector.payload.g,
                vector.payload.iat - SESSION_TOKEN_CLOCK_SKEW_MS - 1,
            ),
            Err(AuthError::NotYetValid)
        ));

        let mut tampered = vector.token.into_bytes();
        let signature_start = tampered
            .iter()
            .position(|byte| *byte == b'.')
            .expect("token separator")
            + 1;
        tampered[signature_start] = if tampered[signature_start] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let tampered = String::from_utf8(tampered).expect("ASCII token");
        assert!(matches!(
            authority.validate_at(
                &tampered,
                &vector.payload.b,
                &vector.payload.s,
                &vector.payload.u,
                &vector.payload.g,
                vector.verify_at_ms,
            ),
            Err(AuthError::InvalidSignature)
        ));
    }
}
