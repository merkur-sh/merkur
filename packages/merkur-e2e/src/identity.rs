//! The mandatory P-256 half of the daemon identity. Hardware and software
//! sign exactly the same prehash; no backend identifier selects a verifier.

use hkdf::Hkdf;
use p256::ecdsa::{
    Signature, SigningKey, VerifyingKey,
    signature::hazmat::{PrehashSigner, PrehashVerifier},
};
use sha2::{Digest, Sha256, Sha512};
use zeroize::Zeroizing;

use crate::SessionCryptoError;

pub const DAEMON_IDENTITY_P256_PUBLIC_KEY_BYTES: usize = 65;
pub const DAEMON_IDENTITY_P256_SIGNATURE_BYTES: usize = 64;

/// ECDSA signs this digest directly, without another SHA-256. APIs that hash
/// internally must receive `context || u64le(transcript.len) || transcript`.
pub fn daemon_p256_digest(context: &[u8], transcript: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update(context)
        .chain_update((transcript.len() as u64).to_le_bytes())
        .chain_update(transcript)
        .finalize()
        .into()
}

pub fn validate_daemon_p256_public_key(bytes: &[u8]) -> Result<(), SessionCryptoError> {
    verifying_key(bytes).map(|_| ())
}

fn verifying_key(bytes: &[u8]) -> Result<VerifyingKey, SessionCryptoError> {
    if bytes.len() != DAEMON_IDENTITY_P256_PUBLIC_KEY_BYTES || bytes.first() != Some(&4) {
        return Err(SessionCryptoError::InvalidDaemonIdentitySignature);
    }
    VerifyingKey::from_sec1_bytes(bytes)
        .map_err(|_| SessionCryptoError::InvalidDaemonIdentitySignature)
}

pub fn verify_daemon_p256_signature(
    public_key: &[u8],
    digest: &[u8; 32],
    signature: &[u8],
) -> Result<(), SessionCryptoError> {
    let key = verifying_key(public_key)?;
    let signature = Signature::from_slice(signature)
        .map_err(|_| SessionCryptoError::InvalidDaemonIdentitySignature)?;
    if signature.normalize_s().is_some() {
        return Err(SessionCryptoError::InvalidDaemonIdentitySignature);
    }
    key.verify_prehash(digest, &signature)
        .map_err(|_| SessionCryptoError::InvalidDaemonIdentitySignature)
}

/// Hardware ECDSA implementations may produce high-S signatures. Normalize
/// once at the signing boundary; receivers only accept canonical low-S.
pub fn normalize_daemon_p256_signature(
    signature: &[u8],
) -> Result<[u8; DAEMON_IDENTITY_P256_SIGNATURE_BYTES], SessionCryptoError> {
    let signature = Signature::from_slice(signature).map_err(|_| SessionCryptoError::Signing)?;
    Ok(signature
        .normalize_s()
        .unwrap_or(signature)
        .to_bytes()
        .into())
}

/// Only the explicitly selected software backend derives this key. Rejection
/// sampling avoids modulo bias and defines every seed, including candidates
/// outside the P-256 scalar range. Counter zero is part of the wire vector.
pub struct SoftwareP256SigningKey(SigningKey);

impl SoftwareP256SigningKey {
    pub fn from_seed(seed: &[u8; 32]) -> Result<Self, SessionCryptoError> {
        let hkdf = Hkdf::<Sha512>::new(None, seed);
        let mut candidate = Zeroizing::new([0u8; 32]);
        for counter in 0u32..=u32::MAX {
            hkdf.expand_multi_info(
                &[b"merkur-daemon-identity-p256\0", &counter.to_be_bytes()],
                &mut *candidate,
            )
            .map_err(|_| SessionCryptoError::Kdf)?;
            if let Ok(key) = SigningKey::from_slice(&*candidate) {
                return Ok(Self(key));
            }
        }
        Err(SessionCryptoError::Kdf)
    }

    pub fn public_key(&self) -> [u8; DAEMON_IDENTITY_P256_PUBLIC_KEY_BYTES] {
        let encoded = self.0.verifying_key().to_encoded_point(false);
        let mut bytes = [0; DAEMON_IDENTITY_P256_PUBLIC_KEY_BYTES];
        bytes.copy_from_slice(encoded.as_bytes());
        bytes
    }

    pub fn sign_digest(
        &self,
        digest: &[u8; 32],
    ) -> Result<[u8; DAEMON_IDENTITY_P256_SIGNATURE_BYTES], SessionCryptoError> {
        let signature: Signature = self
            .0
            .sign_prehash(digest)
            .map_err(|_| SessionCryptoError::Signing)?;
        normalize_daemon_p256_signature(&signature.to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_composite_vector_uses_the_same_scalar_prehash_and_signatures() {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/test-vectors/daemon-identity-composite.json"
        ))
        .unwrap();
        let bytes = |field: &str| {
            URL_SAFE_NO_PAD
                .decode(vector[field].as_str().unwrap())
                .unwrap()
        };
        let p256 = SoftwareP256SigningKey::from_seed(&[0x22; 32]).unwrap();
        assert_eq!(p256.public_key().as_slice(), bytes("p256PublicKey"));
        let context = vector["context"].as_str().unwrap().as_bytes();
        let transcript = bytes("transcript");
        verify_daemon_p256_signature(
            &bytes("p256PublicKey"),
            &daemon_p256_digest(context, &transcript),
            &bytes("p256Signature"),
        )
        .unwrap();
        let pk = libcrux_ml_dsa::ml_dsa_87::MLDSA87VerificationKey::new(
            bytes("mldsaPublicKey").try_into().unwrap(),
        );
        let signature = libcrux_ml_dsa::ml_dsa_87::MLDSA87Signature::new(
            bytes("mldsaSignature").try_into().unwrap(),
        );
        libcrux_ml_dsa::ml_dsa_87::verify(&pk, &transcript, context, &signature).unwrap();
    }

    #[test]
    fn p256_prehash_is_canonical_and_domain_bound() {
        let key = SoftwareP256SigningKey::from_seed(&[7; 32]).unwrap();
        let digest = daemon_p256_digest(b"merkur-daemon-http", b"transcript");
        let signature = key.sign_digest(&digest).unwrap();
        verify_daemon_p256_signature(&key.public_key(), &digest, &signature).unwrap();
        assert!(
            verify_daemon_p256_signature(
                &key.public_key(),
                &Sha256::digest(digest).into(),
                &signature
            )
            .is_err()
        );
        assert!(
            verify_daemon_p256_signature(
                &key.public_key(),
                &daemon_p256_digest(b"merkur-daemon-control", b"transcript"),
                &signature
            )
            .is_err()
        );
        let parsed = Signature::from_slice(&signature).unwrap();
        let high =
            Signature::from_scalars(parsed.r().to_bytes(), (-parsed.s()).to_bytes()).unwrap();
        assert!(
            verify_daemon_p256_signature(&key.public_key(), &digest, &high.to_bytes()).is_err()
        );
        assert_eq!(
            normalize_daemon_p256_signature(&high.to_bytes()).unwrap(),
            signature
        );
    }

    #[test]
    fn p256_keys_require_canonical_uncompressed_points() {
        let key = SoftwareP256SigningKey::from_seed(&[1; 32]).unwrap();
        validate_daemon_p256_public_key(&key.public_key()).unwrap();
        assert!(
            validate_daemon_p256_public_key(
                key.0.verifying_key().to_encoded_point(true).as_bytes()
            )
            .is_err()
        );
        assert!(validate_daemon_p256_public_key(&[4; 65]).is_err());
    }
}
