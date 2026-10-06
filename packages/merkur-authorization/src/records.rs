//! Root-signed delegations, daemon bindings, delegate-signed revocations,
//! root-signed account deletions, and the per-session delegate proof.

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::canonical::{
    decode_exact, decode_len, require_id, require_origin, require_positive, require_timestamp,
};
use crate::{
    ACCOUNT_DELETION_CONTEXT, AuthorizationError, CLOCK_SKEW_MS, DAEMON_BINDING_CONTEXT,
    DELEGATION_LIFETIME_MS, DELEGATION_REVOCATION_CONTEXT, DELEGATION_SCOPES, HASH_BYTES,
    NONCE_BYTES, PUBLIC_KEY_BYTES, SEED_BYTES, SESSION_DELEGATION_CONTEXT, SIGNATURE_BYTES,
    MlDsa87Signer, SigningKey, USER_DELEGATION_CONTEXT, parse_canonical, sign, to_json, verify,
};

const MAX_REVOCATION_TARGETS: usize = 32;

// ---------------------------------------------------------------------------
// Delegation

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationPayload {
    pub user_id: String,
    pub root_key_commitment: String,
    pub delegation_id: String,
    pub delegate_public_key: String,
    pub scopes: Vec<String>,
    pub server_origin: String,
    pub root_epoch: u64,
    pub issued_at: u64,
    pub expires_at: u64,
}

impl DelegationPayload {
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        require_id(&self.user_id, "user id")?;
        decode_len(&self.root_key_commitment, HASH_BYTES, "root key commitment")?;
        require_id(&self.delegation_id, "delegation id")?;
        decode_len(
            &self.delegate_public_key,
            PUBLIC_KEY_BYTES,
            "delegate public key",
        )?;
        if self.scopes.len() != 2
            || self.scopes[0] != DELEGATION_SCOPES[0]
            || self.scopes[1] != DELEGATION_SCOPES[1]
        {
            return Err(AuthorizationError::message(
                "delegation scopes are not the fixed canonical scopes",
            ));
        }
        require_origin(&self.server_origin)?;
        require_positive(self.root_epoch, "root epoch")?;
        require_timestamp(self.issued_at, "delegation issued-at")?;
        require_timestamp(self.expires_at, "delegation expiry")?;
        if self.expires_at.checked_sub(self.issued_at) != Some(DELEGATION_LIFETIME_MS) {
            return Err(AuthorizationError::message(
                "delegation lifetime must be exactly 30 days",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationCertificate {
    pub user_id: String,
    pub root_key_commitment: String,
    pub delegation_id: String,
    pub delegate_public_key: String,
    pub scopes: Vec<String>,
    pub server_origin: String,
    pub root_epoch: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub signature: String,
}

/// What a verifier already knows about the delegation it expects.
pub struct DelegationExpectation<'a> {
    pub user_id: &'a str,
    pub root_key_commitment: &'a str,
    /// `None` accepts any delegation id of this user.
    pub delegation_id: Option<&'a str>,
    pub server_origin: &'a str,
    pub root_epoch: u64,
    pub now_ms: u64,
}

impl DelegationCertificate {
    pub fn create(
        payload: DelegationPayload,
        root_key: &SigningKey,
        entropy: [u8; SEED_BYTES],
    ) -> Result<Self, AuthorizationError> {
        payload.validate()?;
        let signature = sign(
            root_key,
            USER_DELEGATION_CONTEXT,
            to_json(&payload).as_bytes(),
            entropy,
        )?;
        Ok(Self::with_signature(payload, signature))
    }

    pub fn parse(json: &str) -> Result<Self, AuthorizationError> {
        let certificate: Self = parse_canonical(json, "delegation certificate")?;
        certificate.validate()?;
        Ok(certificate)
    }

    /// Structural rules only: fields, lengths and the fixed lifetime.
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        self.payload().validate()?;
        decode_len(&self.signature, SIGNATURE_BYTES, "delegation signature")?;
        Ok(())
    }

    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn payload(&self) -> DelegationPayload {
        DelegationPayload {
            user_id: self.user_id.clone(),
            root_key_commitment: self.root_key_commitment.clone(),
            delegation_id: self.delegation_id.clone(),
            delegate_public_key: self.delegate_public_key.clone(),
            scopes: self.scopes.clone(),
            server_origin: self.server_origin.clone(),
            root_epoch: self.root_epoch,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
        }
    }

    pub fn delegate_public_key_bytes(&self) -> Result<[u8; PUBLIC_KEY_BYTES], AuthorizationError> {
        decode_exact(&self.delegate_public_key, "delegate public key")
    }

    /// The root's signature over the payload, with no claim about who or when.
    pub fn verify_signature(&self, root_public_key: &[u8]) -> Result<(), AuthorizationError> {
        self.validate()?;
        verify(
            root_public_key,
            USER_DELEGATION_CONTEXT,
            to_json(&self.payload()).as_bytes(),
            &self.signature,
            "delegation signature",
        )
    }

    /// The signature plus every expectation, with the issuance time allowed to
    /// run `CLOCK_SKEW_MS` ahead of `now_ms` and the expiry exclusive.
    pub fn verify(
        &self,
        root_public_key: &[u8],
        expected: &DelegationExpectation<'_>,
    ) -> Result<(), AuthorizationError> {
        self.validate()?;
        if self.user_id != expected.user_id
            || self.root_key_commitment != expected.root_key_commitment
            || expected
                .delegation_id
                .is_some_and(|id| id != self.delegation_id)
            || self.server_origin != expected.server_origin
            || self.root_epoch != expected.root_epoch
            || expected.now_ms.saturating_add(CLOCK_SKEW_MS) < self.issued_at
            || expected.now_ms >= self.expires_at
        {
            return Err(AuthorizationError::message(
                "delegation does not match its expected user, root, origin or validity",
            ));
        }
        self.verify_signature(root_public_key)
    }

    fn with_signature(payload: DelegationPayload, signature: String) -> Self {
        Self {
            user_id: payload.user_id,
            root_key_commitment: payload.root_key_commitment,
            delegation_id: payload.delegation_id,
            delegate_public_key: payload.delegate_public_key,
            scopes: payload.scopes,
            server_origin: payload.server_origin,
            root_epoch: payload.root_epoch,
            issued_at: payload.issued_at,
            expires_at: payload.expires_at,
            signature,
        }
    }
}

/// The exact bytes a delegate signs for one session request:
/// the request transcript bound to the canonical certificate.
pub fn session_delegation_proof_transcript(
    request_transcript: &[u8],
    certificate: &DelegationCertificate,
) -> Result<Vec<u8>, AuthorizationError> {
    certificate.validate()?;
    merkur_e2e::build_session_delegation_proof_transcript(
        request_transcript,
        certificate.to_json().as_bytes(),
    )
    .map_err(|_| AuthorizationError::message("session request transcript is invalid"))
}

pub fn sign_session_delegation_proof(
    proof_transcript: &[u8],
    delegate_key: &dyn MlDsa87Signer,
    entropy: [u8; SEED_BYTES],
) -> Result<[u8; SIGNATURE_BYTES], AuthorizationError> {
    delegate_key
        .sign_with_context(SESSION_DELEGATION_CONTEXT, proof_transcript, entropy)
        .map_err(|_| AuthorizationError::message("ML-DSA-87 signing failed"))
}

pub fn verify_session_delegation_proof(
    proof_transcript: &[u8],
    signature: &[u8],
    delegate_public_key: &[u8],
) -> bool {
    merkur_e2e::verify_ml_dsa87(
        delegate_public_key,
        SESSION_DELEGATION_CONTEXT,
        proof_transcript,
        signature,
    )
    .is_ok()
}

pub fn session_delegation_authorization_digest(
    proof_transcript: &[u8],
    delegate_signature: &[u8],
) -> Result<[u8; HASH_BYTES], AuthorizationError> {
    merkur_e2e::compute_session_delegation_authorization_digest(
        proof_transcript,
        delegate_signature,
    )
    .map_err(|_| AuthorizationError::message("session delegation proof is invalid"))
}

// ---------------------------------------------------------------------------
// Daemon binding

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonBindingPayload {
    pub user_id: String,
    pub root_key_commitment: String,
    pub daemon_id: String,
    pub daemon_identity_key_commitment: String,
    pub server_origin: String,
    pub link_claim_id: String,
    pub issued_at: u64,
}

impl DaemonBindingPayload {
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        require_id(&self.user_id, "user id")?;
        decode_len(&self.root_key_commitment, HASH_BYTES, "root key commitment")?;
        require_id(&self.daemon_id, "daemon id")?;
        decode_len(
            &self.daemon_identity_key_commitment,
            HASH_BYTES,
            "daemon identity key commitment",
        )?;
        require_origin(&self.server_origin)?;
        require_id(&self.link_claim_id, "link claim id")?;
        require_timestamp(self.issued_at, "daemon binding issued-at")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonBinding {
    pub user_id: String,
    pub root_key_commitment: String,
    pub daemon_id: String,
    pub daemon_identity_key_commitment: String,
    pub server_origin: String,
    pub link_claim_id: String,
    pub issued_at: u64,
    pub signature: String,
}

impl DaemonBinding {
    pub fn create(
        payload: DaemonBindingPayload,
        root_key: &SigningKey,
        entropy: [u8; SEED_BYTES],
    ) -> Result<Self, AuthorizationError> {
        payload.validate()?;
        let signature = sign(
            root_key,
            DAEMON_BINDING_CONTEXT,
            to_json(&payload).as_bytes(),
            entropy,
        )?;
        Ok(Self {
            user_id: payload.user_id,
            root_key_commitment: payload.root_key_commitment,
            daemon_id: payload.daemon_id,
            daemon_identity_key_commitment: payload.daemon_identity_key_commitment,
            server_origin: payload.server_origin,
            link_claim_id: payload.link_claim_id,
            issued_at: payload.issued_at,
            signature,
        })
    }

    pub fn parse(json: &str) -> Result<Self, AuthorizationError> {
        let binding: Self = parse_canonical(json, "daemon binding")?;
        binding.validate()?;
        Ok(binding)
    }

    pub fn validate(&self) -> Result<(), AuthorizationError> {
        self.payload().validate()?;
        decode_len(&self.signature, SIGNATURE_BYTES, "daemon binding signature")?;
        Ok(())
    }

    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn payload(&self) -> DaemonBindingPayload {
        DaemonBindingPayload {
            user_id: self.user_id.clone(),
            root_key_commitment: self.root_key_commitment.clone(),
            daemon_id: self.daemon_id.clone(),
            daemon_identity_key_commitment: self.daemon_identity_key_commitment.clone(),
            server_origin: self.server_origin.clone(),
            link_claim_id: self.link_claim_id.clone(),
            issued_at: self.issued_at,
        }
    }

    /// The root signed exactly `expected`.
    pub fn verify(
        &self,
        root_public_key: &[u8],
        expected: &DaemonBindingPayload,
    ) -> Result<(), AuthorizationError> {
        expected.validate()?;
        if to_json(&self.payload()) != to_json(expected) {
            return Err(AuthorizationError::message(
                "daemon binding does not match its expected payload",
            ));
        }
        self.verify_signature(root_public_key)
    }

    /// The root's signature over the payload, for a verifier that checks the
    /// fields against its own facts.
    pub fn verify_signature(&self, root_public_key: &[u8]) -> Result<(), AuthorizationError> {
        self.validate()?;
        verify(
            root_public_key,
            DAEMON_BINDING_CONTEXT,
            to_json(&self.payload()).as_bytes(),
            &self.signature,
            "daemon binding signature",
        )
    }
}

// ---------------------------------------------------------------------------
// Delegation revocation

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevocationTarget {
    pub delegation_id: String,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevocationPayload {
    pub user_id: String,
    pub root_key_commitment: String,
    pub actor_delegation_id: String,
    pub targets: Vec<RevocationTarget>,
    pub issued_at: u64,
    pub nonce: String,
}

impl RevocationPayload {
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        if self.targets.is_empty() || self.targets.len() > MAX_REVOCATION_TARGETS {
            return Err(AuthorizationError::message(
                "delegation revocation targets must contain 1 to 32 entries",
            ));
        }
        for target in &self.targets {
            require_id(&target.delegation_id, "target delegation id")?;
            require_timestamp(target.expires_at, "target delegation expiry")?;
        }
        // Delegation ids are ASCII, so byte order is JavaScript's string order.
        if self
            .targets
            .windows(2)
            .any(|pair| pair[0].delegation_id > pair[1].delegation_id)
        {
            return Err(AuthorizationError::message(
                "delegation revocation targets must be sorted",
            ));
        }
        if self
            .targets
            .windows(2)
            .any(|pair| pair[0].delegation_id == pair[1].delegation_id)
        {
            return Err(AuthorizationError::message(
                "delegation revocation targets must be unique",
            ));
        }
        require_id(&self.user_id, "user id")?;
        decode_len(&self.root_key_commitment, HASH_BYTES, "root key commitment")?;
        require_id(&self.actor_delegation_id, "actor delegation id")?;
        require_timestamp(self.issued_at, "revocation issued-at")?;
        decode_len(&self.nonce, NONCE_BYTES, "revocation nonce")?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevocationStatement {
    pub user_id: String,
    pub root_key_commitment: String,
    pub actor_delegation_id: String,
    pub targets: Vec<RevocationTarget>,
    pub issued_at: u64,
    pub nonce: String,
    pub signature: String,
}

impl RevocationStatement {
    /// Signed by the acting delegate, never the root.
    pub fn create(
        payload: RevocationPayload,
        actor_key: &dyn MlDsa87Signer,
        entropy: [u8; SEED_BYTES],
    ) -> Result<Self, AuthorizationError> {
        payload.validate()?;
        let signature = sign(
            actor_key,
            DELEGATION_REVOCATION_CONTEXT,
            to_json(&payload).as_bytes(),
            entropy,
        )?;
        Ok(Self {
            user_id: payload.user_id,
            root_key_commitment: payload.root_key_commitment,
            actor_delegation_id: payload.actor_delegation_id,
            targets: payload.targets,
            issued_at: payload.issued_at,
            nonce: payload.nonce,
            signature,
        })
    }

    pub fn parse(json: &str) -> Result<Self, AuthorizationError> {
        let statement: Self = parse_canonical(json, "delegation revocation")?;
        statement.validate()?;
        Ok(statement)
    }

    pub fn validate(&self) -> Result<(), AuthorizationError> {
        self.payload().validate()?;
        decode_len(
            &self.signature,
            SIGNATURE_BYTES,
            "delegation revocation signature",
        )?;
        Ok(())
    }

    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn payload(&self) -> RevocationPayload {
        RevocationPayload {
            user_id: self.user_id.clone(),
            root_key_commitment: self.root_key_commitment.clone(),
            actor_delegation_id: self.actor_delegation_id.clone(),
            targets: self.targets.clone(),
            issued_at: self.issued_at,
            nonce: self.nonce.clone(),
        }
    }

    pub fn verify(&self, actor_public_key: &[u8]) -> Result<(), AuthorizationError> {
        self.validate()?;
        verify(
            actor_public_key,
            DELEGATION_REVOCATION_CONTEXT,
            to_json(&self.payload()).as_bytes(),
            &self.signature,
            "delegation revocation signature",
        )
    }
}

// ---------------------------------------------------------------------------
// Account deletion

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountDeletionPayload {
    pub user_id: String,
    pub root_key_commitment: String,
    pub root_epoch: u64,
    pub issued_at: u64,
    pub nonce: String,
}

impl AccountDeletionPayload {
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        require_id(&self.user_id, "user id")?;
        decode_len(&self.root_key_commitment, HASH_BYTES, "root key commitment")?;
        require_positive(self.root_epoch, "root epoch")?;
        require_timestamp(self.issued_at, "account deletion issued-at")?;
        decode_len(&self.nonce, NONCE_BYTES, "account deletion nonce")?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountDeletionStatement {
    pub user_id: String,
    pub root_key_commitment: String,
    pub root_epoch: u64,
    pub issued_at: u64,
    pub nonce: String,
    pub signature: String,
}

impl AccountDeletionStatement {
    pub fn create(
        payload: AccountDeletionPayload,
        root_key: &SigningKey,
        entropy: [u8; SEED_BYTES],
    ) -> Result<Self, AuthorizationError> {
        payload.validate()?;
        let signature = sign(
            root_key,
            ACCOUNT_DELETION_CONTEXT,
            to_json(&payload).as_bytes(),
            entropy,
        )?;
        Ok(Self {
            user_id: payload.user_id,
            root_key_commitment: payload.root_key_commitment,
            root_epoch: payload.root_epoch,
            issued_at: payload.issued_at,
            nonce: payload.nonce,
            signature,
        })
    }

    pub fn parse(json: &str) -> Result<Self, AuthorizationError> {
        let statement: Self = parse_canonical(json, "account deletion")?;
        statement.validate()?;
        Ok(statement)
    }

    pub fn validate(&self) -> Result<(), AuthorizationError> {
        self.payload().validate()?;
        decode_len(
            &self.signature,
            SIGNATURE_BYTES,
            "account deletion signature",
        )?;
        Ok(())
    }

    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn payload(&self) -> AccountDeletionPayload {
        AccountDeletionPayload {
            user_id: self.user_id.clone(),
            root_key_commitment: self.root_key_commitment.clone(),
            root_epoch: self.root_epoch,
            issued_at: self.issued_at,
            nonce: self.nonce.clone(),
        }
    }

    pub fn verify(&self, root_public_key: &[u8]) -> Result<(), AuthorizationError> {
        self.validate()?;
        verify(
            root_public_key,
            ACCOUNT_DELETION_CONTEXT,
            to_json(&self.payload()).as_bytes(),
            &self.signature,
            "account deletion signature",
        )
    }
}

/// Compares two commitments without leaking where they differ.
pub(crate) fn commitments_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}
