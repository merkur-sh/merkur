//! Software custody, by explicit choice only: the material is the 32-byte
//! seed, so copying it copies the pair. ML-DSA-87 expands from the seed and
//! P-256 derives from it (`SoftwareP256SigningKey`'s pinned vector); every
//! secret lives in locked memory.

use super::{Created, KeyCustody, SealError, memory::Locked, storage_key};
use merkur_e2e::{
    DAEMON_IDENTITY_PUBLIC_KEY_BYTES, DAEMON_IDENTITY_SIGNATURE_BYTES,
    DAEMON_IDENTITY_SIGNING_RANDOM_BYTES, DaemonIdentitySigningKey, MlDsa87Signer,
    SessionCryptoError, SoftwareP256SigningKey,
};
use ring::rand::{SecureRandom, SystemRandom};
use zeroize::Zeroizing;

pub(super) struct SoftwareCustody {
    seed: Locked<[u8; 32]>,
    mldsa: Locked<DaemonIdentitySigningKey>,
    p256: Locked<SoftwareP256SigningKey>,
}

pub(super) fn create() -> Result<Created, SealError> {
    let mut seed = Zeroizing::new([0u8; 32]);
    SystemRandom::new()
        .fill(&mut *seed)
        .map_err(|_| SealError::Crypto)?;
    let material = Zeroizing::new(seed.to_vec());
    Ok((material, custody(seed)?))
}

pub(super) fn open(material: &[u8]) -> Result<Box<dyn KeyCustody>, SealError> {
    custody(Zeroizing::new(
        material
            .try_into()
            .map_err(|_| SealError::InvalidMaterial)?,
    ))
}

fn custody(seed: Zeroizing<[u8; 32]>) -> Result<Box<dyn KeyCustody>, SealError> {
    let mldsa = Locked::new(DaemonIdentitySigningKey::from_seed(&mut *Zeroizing::new(
        *seed,
    ))?)?;
    let p256 = Locked::new(SoftwareP256SigningKey::from_seed(&seed)?)?;
    Ok(Box::new(SoftwareCustody {
        seed: Locked::new(*seed)?,
        mldsa,
        p256,
    }))
}

impl MlDsa87Signer for SoftwareCustody {
    fn public_key(&self) -> &[u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES] {
        self.mldsa.public_key()
    }

    fn sign_with_context(
        &self,
        context: &[u8],
        message: &[u8],
        randomness: [u8; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES],
    ) -> Result<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES], SessionCryptoError> {
        self.mldsa.sign_with_context(context, message, randomness)
    }
}

impl KeyCustody for SoftwareCustody {
    fn p256_public_key(&self) -> [u8; 65] {
        self.p256.public_key()
    }

    fn sign_p256(&self, digest: &[u8; 32]) -> Result<[u8; 64], SealError> {
        Ok(self.p256.sign_digest(digest)?)
    }

    fn derive_storage_key(
        &self,
        salt: &[u8],
        info: &[&[u8]],
    ) -> Result<Zeroizing<[u8; 32]>, SealError> {
        storage_key(&self.seed, salt, info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_signs_both_halves_and_refuses_other_lengths() {
        let (material, created) = create().unwrap();
        let opened = open(&material).unwrap();
        assert_eq!(created.public_key(), opened.public_key());
        assert_eq!(created.p256_public_key(), opened.p256_public_key());
        let signature = opened.sign_p256(&[3; 32]).unwrap();
        merkur_e2e::verify_daemon_p256_signature(&opened.p256_public_key(), &[3; 32], &signature)
            .unwrap();
        let mldsa = opened
            .sign_with_context(b"merkur-daemon-http", b"transcript", [5; 32])
            .unwrap();
        merkur_e2e::verify_ml_dsa87(
            opened.public_key(),
            b"merkur-daemon-http",
            b"transcript",
            &mldsa,
        )
        .unwrap();
        assert_eq!(
            *opened.derive_storage_key(b"salt", &[b"info"]).unwrap(),
            *created.derive_storage_key(b"salt", &[b"info"]).unwrap()
        );
        for length in [0, 31, 33, 8192] {
            assert!(open(&vec![0; length]).is_err());
        }
    }
}
