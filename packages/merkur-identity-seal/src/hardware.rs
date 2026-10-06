//! Hardware custody, written once over a per-platform [`Chip`].
//!
//! The P-256 key always lives in the chip. The ML-DSA-87 key does too when
//! the chip can hold one (*resident*); otherwise the chip seals a fresh seed
//! bound to the P-256 public key and the expanded key lives in locked memory
//! (*sealed seed*). The chip's own answer at creation decides, never an OS
//! version, and the material pins it:
//!
//! `chip u8 || variant u8 || field(P-256 key) || field(ML-DSA key | sealed seed)
//! || SHA-256(everything before)`, each field a 2-byte big-endian length and
//! its bytes. The digest is checked before any chip parses a blob: CryptoKit
//! traps on some corrupted enclave ML-DSA blobs instead of throwing (measured
//! on macOS 26.5), and a trap would restart the daemon forever where a refusal
//! exits 3. It detects corruption only; a writer of the stored material can
//! already stop the daemon.
//!
//! Platforms: the macOS Secure Enclave (`macos.rs`) and a Linux TPM 2.0
//! (`tpm/`). Windows maps onto the same five operations through the CNG
//! Platform Crypto Provider (an ECDSA P-256 key, and RSA or ECDH sealing of
//! the seed) and is not built: no Windows host runs Merkur.

use super::{Created, KeyCustody, SealError, memory::Locked, storage_key};
use merkur_e2e::{
    DAEMON_IDENTITY_PUBLIC_KEY_BYTES, DAEMON_IDENTITY_SIGNATURE_BYTES,
    DAEMON_IDENTITY_SIGNING_RANDOM_BYTES, DaemonIdentitySigningKey, MlDsa87Signer,
    SessionCryptoError,
};
use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};
use zeroize::{Zeroize, Zeroizing};

/// Wire facts of the material.
const VARIANT_RESIDENT: u8 = 1;
const VARIANT_SEALED_SEED: u8 = 2;
const DIGEST_BYTES: usize = 32;

pub(crate) type MlDsaPublicKey = Box<[u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES]>;
pub(crate) type MlDsaSignature = Box<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES]>;
/// A key a chip just made: its wrapped blob, its loaded handle, its public key.
pub(crate) type CreatedP256<K> = (Zeroizing<Vec<u8>>, K, [u8; 65]);
pub(crate) type CreatedMlDsa<K> = (Zeroizing<Vec<u8>>, K, MlDsaPublicKey);

/// One kind of key chip. Blobs are the chip's own wrapped keys and sealed
/// objects; only that chip opens them.
pub(crate) trait Chip: Send + Sync + Sized + 'static {
    /// Stored first in the material, so a material opens only on its own kind
    /// of chip.
    const TAG: u8;
    type P256: Send + Sync;
    type MlDsa: Send + Sync;

    fn connect() -> Result<Self, SealError>;
    fn create_p256(&self) -> Result<CreatedP256<Self::P256>, SealError>;
    fn open_p256(&self, blob: &[u8]) -> Result<(Self::P256, [u8; 65]), SealError>;
    /// A raw `r || s`; the composition normalizes and verifies it.
    fn sign_p256(&self, key: &Self::P256, digest: &[u8; 32]) -> Result<[u8; 64], SealError>;
    /// `None` when this chip cannot hold an ML-DSA-87 key.
    fn create_mldsa(&self) -> Result<Option<CreatedMlDsa<Self::MlDsa>>, SealError>;
    fn open_mldsa(&self, blob: &[u8]) -> Result<(Self::MlDsa, MlDsaPublicKey), SealError>;
    fn sign_mldsa(
        &self,
        key: &Self::MlDsa,
        context: &[u8],
        message: &[u8],
    ) -> Result<MlDsaSignature, SealError>;
    /// Seals `secret` so it opens only on this chip, and only under `binding`.
    fn seal(&self, secret: &[u8; 32], binding: &[u8; 65]) -> Result<Zeroizing<Vec<u8>>, SealError>;
    fn unseal(&self, blob: &[u8], binding: &[u8; 65]) -> Result<Zeroizing<[u8; 32]>, SealError>;
    /// Releases what creating or opening needed and signing does not.
    fn settle(&self) -> Result<(), SealError> {
        Ok(())
    }
}

enum MlDsaKey<C: Chip> {
    Resident {
        key: C::MlDsa,
        public: MlDsaPublicKey,
    },
    SealedSeed {
        key: Locked<DaemonIdentitySigningKey>,
        seed: Locked<[u8; 32]>,
    },
}

struct HardwareCustody<C: Chip> {
    chip: C,
    p256: C::P256,
    p256_public: [u8; 65],
    mldsa: MlDsaKey<C>,
}

#[cfg_attr(
    all(not(target_os = "linux"), not(feature = "tpm-sim")),
    expect(
        clippy::unnecessary_wraps,
        reason = "probing a TPM, on Linux and under `tpm-sim`, can fail; every platform shares \
                  this signature"
    )
)]
pub(super) fn available() -> Result<bool, SealError> {
    #[cfg(feature = "tpm-sim")]
    if std::env::var_os("MERKUR_TPM_SIM_ADDR").is_some() {
        return super::tpm::available();
    }
    #[cfg(target_os = "macos")]
    {
        Ok(super::macos::available())
    }
    #[cfg(target_os = "linux")]
    {
        super::tpm::available()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Ok(false)
    }
}

pub(super) fn create() -> Result<Created, SealError> {
    #[cfg(feature = "tpm-sim")]
    if std::env::var_os("MERKUR_TPM_SIM_ADDR").is_some() {
        return create_on::<super::tpm::Tpm>();
    }
    #[cfg(target_os = "macos")]
    {
        create_on::<super::macos::Enclave>()
    }
    #[cfg(target_os = "linux")]
    {
        create_on::<super::tpm::Tpm>()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(SealError::Unavailable)
    }
}

pub(super) fn open(material: &[u8]) -> Result<Box<dyn KeyCustody>, SealError> {
    match material.first() {
        #[cfg(target_os = "macos")]
        Some(&super::macos::Enclave::TAG) => open_on::<super::macos::Enclave>(material),
        #[cfg(any(target_os = "linux", feature = "tpm-sim"))]
        Some(&super::tpm::Tpm::TAG) => open_on::<super::tpm::Tpm>(material),
        Some(_) => Err(SealError::Unavailable),
        None => Err(SealError::InvalidMaterial),
    }
}

pub(crate) fn create_on<C: Chip>() -> Result<Created, SealError> {
    let chip = C::connect()?;
    let (p256_blob, p256, p256_public) = chip.create_p256()?;
    let (variant, mldsa_blob, mldsa) = match chip.create_mldsa()? {
        Some((blob, key, public)) => (VARIANT_RESIDENT, blob, MlDsaKey::Resident { key, public }),
        None => {
            let mut seed = Zeroizing::new([0u8; 32]);
            SystemRandom::new()
                .fill(&mut *seed)
                .map_err(|_| SealError::Crypto)?;
            let sealed = chip.seal(&seed, &p256_public)?;
            (VARIANT_SEALED_SEED, sealed, sealed_seed(seed)?)
        }
    };
    chip.settle()?;
    let material = encode(C::TAG, variant, &p256_blob, &mldsa_blob)?;
    Ok((
        material,
        Box::new(HardwareCustody {
            chip,
            p256,
            p256_public,
            mldsa,
        }),
    ))
}

pub(crate) fn open_on<C: Chip>(material: &[u8]) -> Result<Box<dyn KeyCustody>, SealError> {
    let (variant, p256_blob, mldsa_blob) = decode(C::TAG, material)?;
    let chip = C::connect()?;
    let (p256, p256_public) = chip.open_p256(p256_blob)?;
    merkur_e2e::validate_daemon_p256_public_key(&p256_public)?;
    let mldsa = match variant {
        VARIANT_RESIDENT => {
            let (key, public) = chip.open_mldsa(mldsa_blob)?;
            MlDsaKey::Resident { key, public }
        }
        VARIANT_SEALED_SEED => sealed_seed(chip.unseal(mldsa_blob, &p256_public)?)?,
        _ => return Err(SealError::InvalidMaterial),
    };
    chip.settle()?;
    Ok(Box::new(HardwareCustody {
        chip,
        p256,
        p256_public,
        mldsa,
    }))
}

fn sealed_seed<C: Chip>(seed: Zeroizing<[u8; 32]>) -> Result<MlDsaKey<C>, SealError> {
    Ok(MlDsaKey::SealedSeed {
        key: Locked::new(DaemonIdentitySigningKey::from_seed(&mut *Zeroizing::new(
            *seed,
        ))?)?,
        seed: Locked::new(*seed)?,
    })
}

fn encode(
    chip: u8,
    variant: u8,
    p256: &[u8],
    mldsa: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let mut material = Zeroizing::new(Vec::with_capacity(
        6 + p256.len() + mldsa.len() + DIGEST_BYTES,
    ));
    material.extend_from_slice(&[chip, variant]);
    for field in [p256, mldsa] {
        let length = u16::try_from(field.len()).map_err(|_| SealError::InvalidMaterial)?;
        if length == 0 {
            return Err(SealError::InvalidMaterial);
        }
        material.extend_from_slice(&length.to_be_bytes());
        material.extend_from_slice(field);
    }
    let check = digest(&SHA256, &material);
    material.extend_from_slice(check.as_ref());
    Ok(material)
}

fn decode(chip: u8, material: &[u8]) -> Result<(u8, &[u8], &[u8]), SealError> {
    let (material, check) = material
        .split_at_checked(
            material
                .len()
                .checked_sub(DIGEST_BYTES)
                .ok_or(SealError::InvalidMaterial)?,
        )
        .ok_or(SealError::InvalidMaterial)?;
    if digest(&SHA256, material).as_ref() != check {
        return Err(SealError::InvalidMaterial);
    }
    let [tag, variant, rest @ ..] = material else {
        return Err(SealError::InvalidMaterial);
    };
    if *tag != chip || !matches!(*variant, VARIANT_RESIDENT | VARIANT_SEALED_SEED) {
        return Err(SealError::InvalidMaterial);
    }
    let (p256, rest) = field(rest)?;
    let (mldsa, rest) = field(rest)?;
    if !rest.is_empty() {
        return Err(SealError::InvalidMaterial);
    }
    Ok((*variant, p256, mldsa))
}

fn field(bytes: &[u8]) -> Result<(&[u8], &[u8]), SealError> {
    let [high, low, rest @ ..] = bytes else {
        return Err(SealError::InvalidMaterial);
    };
    let length = usize::from(u16::from_be_bytes([*high, *low]));
    if length == 0 || length > rest.len() {
        return Err(SealError::InvalidMaterial);
    }
    Ok(rest.split_at(length))
}

impl<C: Chip> MlDsa87Signer for HardwareCustody<C> {
    fn public_key(&self) -> &[u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES] {
        match &self.mldsa {
            MlDsaKey::Resident { public, .. } => public,
            MlDsaKey::SealedSeed { key, .. } => key.public_key(),
        }
    }

    fn sign_with_context(
        &self,
        context: &[u8],
        message: &[u8],
        mut randomness: [u8; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES],
    ) -> Result<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES], SessionCryptoError> {
        match &self.mldsa {
            MlDsaKey::SealedSeed { key, .. } => key.sign_with_context(context, message, randomness),
            MlDsaKey::Resident { key, public } => {
                // The chip hedges with its own generator.
                randomness.zeroize();
                let signature = self
                    .chip
                    .sign_mldsa(key, context, message)
                    .map_err(|_| SessionCryptoError::Signing)?;
                merkur_e2e::verify_ml_dsa87(&public[..], context, message, &signature[..])
                    .map_err(|_| SessionCryptoError::Signing)?;
                Ok(*signature)
            }
        }
    }
}

impl<C: Chip> KeyCustody for HardwareCustody<C> {
    fn p256_public_key(&self) -> [u8; 65] {
        self.p256_public
    }

    fn sign_p256(&self, digest: &[u8; 32]) -> Result<[u8; 64], SealError> {
        let raw = self.chip.sign_p256(&self.p256, digest)?;
        let signature = merkur_e2e::normalize_daemon_p256_signature(&raw)?;
        merkur_e2e::verify_daemon_p256_signature(&self.p256_public, digest, &signature)?;
        Ok(signature)
    }

    fn derive_storage_key(
        &self,
        salt: &[u8],
        info: &[&[u8]],
    ) -> Result<Zeroizing<[u8; 32]>, SealError> {
        match &self.mldsa {
            MlDsaKey::SealedSeed { seed, .. } => storage_key(seed, salt, info),
            MlDsaKey::Resident { .. } => Err(SealError::Unavailable),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The public keys a created custody reported, kept so the custody (and
    /// its chip connection) can be dropped before the material is reopened:
    /// a TPM simulator serves one client at a time.
    pub(crate) struct Expected {
        mldsa: MlDsaPublicKey,
        p256: [u8; 65],
    }
    impl Expected {
        pub(crate) fn of(created: Box<dyn KeyCustody>) -> Self {
            Self {
                mldsa: Box::new(*created.public_key()),
                p256: created.p256_public_key(),
            }
        }
    }

    /// Reopens `material`, signs and verifies both halves, then proves a
    /// flipped byte in either key field refuses to open. One chip connection
    /// at a time; the material digest refuses the tampered copies before any
    /// chip sees them.
    pub(crate) fn exercise<C: Chip>(material: &[u8], expected: &Expected) {
        let opened = open_on::<C>(material).unwrap();
        assert_eq!(opened.public_key(), &*expected.mldsa);
        assert_eq!(opened.p256_public_key(), expected.p256);
        let digest = merkur_e2e::daemon_p256_digest(b"merkur-daemon-http", b"transcript");
        let p256 = opened.sign_p256(&digest).unwrap();
        merkur_e2e::verify_daemon_p256_signature(&expected.p256, &digest, &p256).unwrap();
        let mldsa = opened
            .sign_with_context(b"merkur-daemon-http", b"transcript", [9; 32])
            .unwrap();
        merkur_e2e::verify_ml_dsa87(
            &expected.mldsa[..],
            b"merkur-daemon-http",
            b"transcript",
            &mldsa,
        )
        .unwrap();
        drop(opened);
        for index in [material.len() - 1, 6] {
            let mut tampered = material.to_vec();
            tampered[index] ^= 1;
            assert!(open_on::<C>(&tampered).is_err(), "byte {index} tampered");
        }
    }

    #[test]
    fn material_framing_is_exact() {
        let material = encode(7, VARIANT_SEALED_SEED, b"p", b"mm").unwrap();
        let body = [7, 2, 0, 1, b'p', 0, 2, b'm', b'm'];
        assert_eq!(&material[..body.len()], &body);
        assert_eq!(&material[body.len()..], digest(&SHA256, &body).as_ref());
        assert_eq!(
            decode(7, &material).unwrap(),
            (VARIANT_SEALED_SEED, &b"p"[..], &b"mm"[..])
        );
        assert!(decode(8, &material).is_err(), "another chip's material");
        // Every single-bit corruption is refused before a chip sees a blob.
        for index in 0..material.len() {
            let mut corrupted = material.to_vec();
            corrupted[index] ^= 1;
            assert!(decode(7, &corrupted).is_err(), "byte {index}");
        }
        let mut trailing = material.to_vec();
        trailing.push(0);
        assert!(decode(7, &trailing).is_err());
        assert!(decode(7, &material[..material.len() - 1]).is_err());
        assert!(decode(7, &[]).is_err());
        assert!(encode(7, VARIANT_RESIDENT, b"", b"m").is_err());
    }
}
