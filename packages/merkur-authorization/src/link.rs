//! Linking a machine: the daemon's public claim, the out-of-band code that
//! authenticates it, and the root's approval MAC.
//!
//! The claim commits to the complete daemon identity under the link secret, so
//! a coordinator cannot put another machine's identity in front of the user
//! root; the approval is MACed with the same secret, so only the holder of the
//! code can complete it.

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::canonical::{
    decode_exact, decode_len, encode, require_display_field, require_id, require_positive,
};
use crate::records::{DaemonBinding, commitments_equal};
use crate::{
    AuthorizationError, HASH_BYTES, NONCE_BYTES, P256_PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES,
    SEED_BYTES, daemon_identity_key_commitment, parse_canonical, to_json,
};

const DAEMON_LINK_CLAIM_DOMAIN: &[u8] = b"merkur-link-claim\0";
const DAEMON_LINK_APPROVAL_DOMAIN: &[u8] = b"merkur-link-approval\0";

/// Where a key pair's custody lives: the host's key chip, whichever kind the
/// platform has, or locked memory by explicit choice. Self-reported and bound
/// by the claim commitment; not attestation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DaemonIdentitySealBackend {
    #[serde(rename = "hardware")]
    Hardware,
    #[serde(rename = "software")]
    Software,
}

impl DaemonIdentitySealBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hardware => "hardware",
            Self::Software => "software",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkClaimPayload {
    pub link_claim_id: String,
    pub daemon_id: String,
    pub daemon_identity_public_key: String,
    pub daemon_identity_p256_public_key: String,
    pub daemon_identity_key_commitment: String,
    pub name: String,
    pub platform: String,
    pub identity_seal_backend: DaemonIdentitySealBackend,
}

impl LinkClaimPayload {
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        let public_key = decode_len(
            &self.daemon_identity_public_key,
            PUBLIC_KEY_BYTES,
            "daemon identity public key",
        )?;
        let p256 = decode_len(
            &self.daemon_identity_p256_public_key,
            P256_PUBLIC_KEY_BYTES,
            "daemon P-256 public key",
        )?;
        decode_len(
            &self.daemon_identity_key_commitment,
            HASH_BYTES,
            "daemon identity key commitment",
        )?;
        if !commitments_equal(
            &daemon_identity_key_commitment(&public_key, &p256)?,
            &self.daemon_identity_key_commitment,
        ) {
            return Err(AuthorizationError::message(
                "daemon identity key commitment does not match its public key",
            ));
        }
        require_id(&self.link_claim_id, "link claim id")?;
        require_id(&self.daemon_id, "daemon id")?;
        require_display_field(&self.name, "daemon name", 128)?;
        require_display_field(&self.platform, "daemon platform", 64)?;
        Ok(())
    }

    /// `base64url(SHA-512(domain || u64be(len(claim)) || claim || linkSecret))`.
    pub fn commitment(&self, link_secret: &[u8; SEED_BYTES]) -> Result<String, AuthorizationError> {
        self.validate()?;
        let claim = to_json(self);
        let mut message = zeroize::Zeroizing::new(Vec::with_capacity(
            DAEMON_LINK_CLAIM_DOMAIN.len() + 8 + claim.len() + SEED_BYTES,
        ));
        message.extend_from_slice(DAEMON_LINK_CLAIM_DOMAIN);
        message.extend_from_slice(&(claim.len() as u64).to_be_bytes());
        message.extend_from_slice(claim.as_bytes());
        message.extend_from_slice(link_secret);
        Ok(encode(&merkur_e2e::sha512(&message)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkPublicClaim {
    pub link_claim_id: String,
    pub daemon_id: String,
    pub daemon_identity_public_key: String,
    pub daemon_identity_p256_public_key: String,
    pub daemon_identity_key_commitment: String,
    pub name: String,
    pub platform: String,
    pub identity_seal_backend: DaemonIdentitySealBackend,
    pub claim_commitment: String,
}

impl LinkPublicClaim {
    pub fn parse(json: &str) -> Result<Self, AuthorizationError> {
        let claim: Self = parse_canonical(json, "daemon link claim")?;
        claim.payload().validate()?;
        decode_len(
            &claim.claim_commitment,
            HASH_BYTES,
            "daemon link claim commitment",
        )?;
        Ok(claim)
    }

    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn payload(&self) -> LinkClaimPayload {
        LinkClaimPayload {
            link_claim_id: self.link_claim_id.clone(),
            daemon_id: self.daemon_id.clone(),
            daemon_identity_public_key: self.daemon_identity_public_key.clone(),
            daemon_identity_p256_public_key: self.daemon_identity_p256_public_key.clone(),
            daemon_identity_key_commitment: self.daemon_identity_key_commitment.clone(),
            name: self.name.clone(),
            platform: self.platform.clone(),
            identity_seal_backend: self.identity_seal_backend,
        }
    }

    /// The claim is exactly what the holder of `link_secret` committed to.
    pub fn verify(&self, link_secret: &[u8; SEED_BYTES]) -> Result<(), AuthorizationError> {
        if !commitments_equal(
            &self.payload().commitment(link_secret)?,
            &self.claim_commitment,
        ) {
            return Err(AuthorizationError::message(
                "daemon link claim does not match its commitment",
            ));
        }
        Ok(())
    }
}

/// `<linkClaimId>.<base64url(linkSecret)>`: what the new machine prints and the
/// approving device reads.
pub fn format_link_code(
    link_claim_id: &str,
    link_secret: &[u8; SEED_BYTES],
) -> Result<String, AuthorizationError> {
    require_id(link_claim_id, "link claim id")?;
    Ok(format!("{link_claim_id}.{}", encode(link_secret)))
}

pub fn parse_link_code(code: &str) -> Result<(String, [u8; SEED_BYTES]), AuthorizationError> {
    let mut segments = code.split('.');
    let (Some(id), Some(secret), None) = (segments.next(), segments.next(), segments.next()) else {
        return Err(AuthorizationError::message("daemon link code is invalid"));
    };
    require_id(id, "link claim id")?;
    Ok((id.to_string(), decode_exact(secret, "daemon link secret")?))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkApprovalPayload {
    pub link_claim_id: String,
    pub claim_commitment: String,
    pub user_root_public_key: String,
    pub root_epoch: u64,
    pub daemon_binding: DaemonBinding,
}

impl LinkApprovalPayload {
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        require_id(&self.link_claim_id, "link claim id")?;
        decode_len(
            &self.claim_commitment,
            HASH_BYTES,
            "daemon link claim commitment",
        )?;
        decode_len(
            &self.user_root_public_key,
            PUBLIC_KEY_BYTES,
            "user root public key",
        )?;
        require_positive(self.root_epoch, "root epoch")?;
        self.daemon_binding.validate()
    }

    fn mac(
        &self,
        server_nonce: &[u8; NONCE_BYTES],
        link_secret: &[u8; SEED_BYTES],
    ) -> Result<[u8; HASH_BYTES], AuthorizationError> {
        self.validate()?;
        let digest = merkur_e2e::sha512(to_json(self).as_bytes());
        let mut message =
            Vec::with_capacity(DAEMON_LINK_APPROVAL_DOMAIN.len() + NONCE_BYTES + HASH_BYTES);
        message.extend_from_slice(DAEMON_LINK_APPROVAL_DOMAIN);
        message.extend_from_slice(server_nonce);
        message.extend_from_slice(&digest);
        merkur_e2e::hmac_sha512(link_secret, &message)
            .map_err(|_| AuthorizationError::message("daemon link approval MAC failed"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkApproval {
    pub link_claim_id: String,
    pub claim_commitment: String,
    pub user_root_public_key: String,
    pub root_epoch: u64,
    pub daemon_binding: DaemonBinding,
    pub approval_mac: String,
}

impl LinkApproval {
    pub fn create(
        payload: LinkApprovalPayload,
        server_nonce: &[u8; NONCE_BYTES],
        link_secret: &[u8; SEED_BYTES],
    ) -> Result<Self, AuthorizationError> {
        let mac = payload.mac(server_nonce, link_secret)?;
        Ok(Self {
            link_claim_id: payload.link_claim_id,
            claim_commitment: payload.claim_commitment,
            user_root_public_key: payload.user_root_public_key,
            root_epoch: payload.root_epoch,
            daemon_binding: payload.daemon_binding,
            approval_mac: encode(&mac),
        })
    }

    pub fn parse(json: &str) -> Result<Self, AuthorizationError> {
        let approval: Self = parse_canonical(json, "daemon link approval")?;
        approval.payload().validate()?;
        decode_len(
            &approval.approval_mac,
            HASH_BYTES,
            "daemon link approval MAC",
        )?;
        Ok(approval)
    }

    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn payload(&self) -> LinkApprovalPayload {
        LinkApprovalPayload {
            link_claim_id: self.link_claim_id.clone(),
            claim_commitment: self.claim_commitment.clone(),
            user_root_public_key: self.user_root_public_key.clone(),
            root_epoch: self.root_epoch,
            daemon_binding: self.daemon_binding.clone(),
        }
    }

    pub fn verify(
        &self,
        server_nonce: &[u8; NONCE_BYTES],
        link_secret: &[u8; SEED_BYTES],
    ) -> Result<(), AuthorizationError> {
        let expected = self.payload().mac(server_nonce, link_secret)?;
        let actual: [u8; HASH_BYTES] =
            decode_exact(&self.approval_mac, "daemon link approval MAC")?;
        if bool::from(actual.ct_eq(&expected)) {
            Ok(())
        } else {
            Err(AuthorizationError::message(
                "daemon link approval MAC does not verify",
            ))
        }
    }
}
