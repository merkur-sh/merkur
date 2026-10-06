//! Host-bound key custody: one primitive, [`KeyCustody`], on every platform.
//!
//! A custody holds one composite key pair, ML-DSA-87 and P-256, for whatever
//! uses it: a daemon's permanent identity or a native client's delegate.
//! `hardware` keeps both keys in the host's key chip, or the ML-DSA seed sealed
//! by it when the chip cannot hold ML-DSA-87; `software` keeps a seed in locked
//! memory and exists only by explicit choice. Stored material is opaque, and
//! its label and variant are pinned at creation: opening never probes, never
//! asks the chip again what it could do, and never downgrades.

mod hardware;
#[cfg(target_os = "macos")]
pub mod keychain;
#[cfg(target_os = "macos")]
mod macos;
pub mod memory;
mod software;
#[cfg(any(target_os = "linux", feature = "tpm-sim"))]
mod tpm;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

pub use merkur_e2e::MlDsa87Signer;

/// Resource bound on stored material. The largest variant, an enclave-resident
/// pair, measured 2,857 + 324 bytes of key blobs plus 38 bytes of framing and
/// integrity digest.
pub const MATERIAL_MAX_BYTES: usize = 8192;
pub const IDENTITY_UNSEALABLE_EXIT_CODE: i32 = 3;

pub use merkur_authorization::DaemonIdentitySealBackend as Backend;

/// A fresh custody's stored material, and the custody.
type Created = (Zeroizing<Vec<u8>>, Box<dyn KeyCustody>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IdentitySealWire {
    pub backend: Backend,
    pub material: String,
}

impl std::fmt::Debug for IdentitySealWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdentitySealWire")
            .field("backend", &self.backend)
            .field("material", &"[REDACTED]")
            .finish()
    }
}

impl Drop for IdentitySealWire {
    fn drop(&mut self) {
        self.material.zeroize();
    }
}

#[derive(Debug)]
pub enum SealError {
    InvalidMaterial,
    Unavailable,
    SoftwareChoiceRequired,
    TpmAccessDenied,
    Hardware,
    Memory(std::io::Error),
    Io(std::io::Error),
    Crypto,
    Busy,
    Closed,
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidMaterial => "invalid key custody material",
            Self::SoftwareChoiceRequired => "software custody requires explicit selection",
            Self::Unavailable => "key custody hardware is unavailable",
            Self::TpmAccessDenied => "TPM access denied",
            Self::Hardware => "key custody hardware operation failed",
            Self::Memory(_) => "key custody memory protection failed",
            Self::Io(_) => "key custody transport failed",
            Self::Crypto => "key custody cryptography failed",
            Self::Busy => "key custody signing queue is full",
            Self::Closed => "key custody signer stopped",
        })
    }
}
impl std::error::Error for SealError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Memory(e) | Self::Io(e) => Some(e),
            _ => None,
        }
    }
}
impl From<merkur_e2e::SessionCryptoError> for SealError {
    fn from(_: merkur_e2e::SessionCryptoError) -> Self {
        Self::Crypto
    }
}
impl From<std::io::Error> for SealError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// One custody of the composite pair. The ML-DSA-87 half signs through
/// [`MlDsa87Signer`]; a hardware signature of either half is verified before
/// it is returned, so a chip fault fails closed instead of publishing.
pub trait KeyCustody: MlDsa87Signer {
    fn p256_public_key(&self) -> [u8; 65];

    /// Signs a 32-byte prehash as canonical low-S `r || s`.
    fn sign_p256(&self, digest: &[u8; 32]) -> Result<[u8; 64], SealError>;

    /// HKDF-SHA-512 over the custody's sealed secret. Only a custody that holds
    /// one (software, or hardware whose chip sealed the ML-DSA seed) can derive;
    /// a chip-resident pair has no secret outside the chip and answers
    /// [`SealError::Unavailable`].
    fn derive_storage_key(
        &self,
        salt: &[u8],
        info: &[&[u8]],
    ) -> Result<Zeroizing<[u8; 32]>, SealError>;
}

/// The custody this host can offer without an explicit choice: `hardware`
/// when a key chip answers, otherwise `software`, which callers refuse unless
/// software custody was explicitly selected.
pub fn probe() -> Result<Backend, SealError> {
    Ok(if hardware::available()? {
        Backend::Hardware
    } else {
        Backend::Software
    })
}

/// A fresh pair under `backend`, and its stored form.
pub fn create(backend: Backend) -> Result<(IdentitySealWire, Box<dyn KeyCustody>), SealError> {
    let (material, custody) = match backend {
        Backend::Software => software::create()?,
        Backend::Hardware => hardware::create()?,
    };
    if material.is_empty() || material.len() > MATERIAL_MAX_BYTES {
        return Err(SealError::InvalidMaterial);
    }
    Ok((
        IdentitySealWire {
            backend,
            material: URL_SAFE_NO_PAD.encode(&*material),
        },
        custody,
    ))
}

/// Opens a stored pair under its pinned label and variant.
pub fn open(seal: &IdentitySealWire) -> Result<Box<dyn KeyCustody>, SealError> {
    if seal.material.len() > MATERIAL_MAX_BYTES.div_ceil(3) * 4 {
        return Err(SealError::InvalidMaterial);
    }
    let material = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(&seal.material)
            .map_err(|_| SealError::InvalidMaterial)?,
    );
    if material.is_empty()
        || material.len() > MATERIAL_MAX_BYTES
        || URL_SAFE_NO_PAD.encode(&*material) != seal.material
    {
        return Err(SealError::InvalidMaterial);
    }
    match seal.backend {
        Backend::Software => software::open(&material),
        Backend::Hardware => hardware::open(&material),
    }
}

pub fn disable_core_dumps() -> Result<(), SealError> {
    memory::disable_core_dumps()
}

/// `HKDF-SHA-512(salt, secret)` expanded over `info` to 32 bytes.
fn storage_key(
    secret: &[u8; 32],
    salt: &[u8],
    info: &[&[u8]],
) -> Result<Zeroizing<[u8; 32]>, SealError> {
    struct Len32;
    impl ring::hkdf::KeyType for Len32 {
        fn len(&self) -> usize {
            32
        }
    }
    let prk = ring::hkdf::Salt::new(ring::hkdf::HKDF_SHA512, salt).extract(secret);
    let mut key = Zeroizing::new([0; 32]);
    prk.expand(info, Len32)
        .map_err(|_| SealError::Crypto)?
        .fill(&mut *key)
        .map_err(|_| SealError::Crypto)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn software_material_is_canonical() {
        let (seal, _) = create(Backend::Software).unwrap();
        assert!(open(&seal).is_ok());
        let noncanonical = IdentitySealWire {
            backend: Backend::Software,
            material: format!("{}=", seal.material),
        };
        assert!(matches!(
            open(&noncanonical),
            Err(SealError::InvalidMaterial)
        ));
    }

    #[test]
    fn stored_label_cannot_downgrade_to_software() {
        let (software, _) = create(Backend::Software).unwrap();
        let hardware = IdentitySealWire {
            backend: Backend::Hardware,
            material: software.material.clone(),
        };
        assert!(open(&hardware).is_err());
    }
}
