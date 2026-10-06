//! A TPM 2.0 as a [`Chip`]: P-256 signing children and KEYEDHASH sealed
//! objects under a deterministic owner-hierarchy primary, over raw commands.
//! TPM 2.0 holds no ML-DSA-87 key, so every TPM pair is the sealed-seed variant.

mod commands;
mod transport;
#[cfg(target_os = "linux")]
mod transport_linux;
#[cfg(feature = "tpm-sim")]
mod transport_swtpm;

use super::SealError;
use super::hardware::{Chip, CreatedMlDsa, CreatedP256, MlDsaPublicKey, MlDsaSignature};
use commands::{Cursor, Device};
use ring::digest::{SHA256, digest};
use std::{convert::Infallible, sync::Mutex};
use zeroize::Zeroizing;

fn device() -> Result<Device, SealError> {
    #[cfg(feature = "tpm-sim")]
    if let Ok(address) = std::env::var("MERKUR_TPM_SIM_ADDR") {
        return Ok(Device::new(Box::new(
            transport_swtpm::SimulatorTransport::open(&address)?,
        )));
    }
    #[cfg(target_os = "linux")]
    {
        Ok(Device::new(Box::new(
            transport_linux::LinuxTransport::open().map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    SealError::TpmAccessDenied
                } else {
                    SealError::Io(e)
                }
            })?,
        )))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(SealError::Unavailable)
    }
}

/// Whether a TPM answers. An absent device is "no", not an error.
pub(super) fn available() -> Result<bool, SealError> {
    let mut device = match device() {
        Ok(device) => device,
        Err(SealError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    device.primary()?;
    Ok(true)
}

/// The device, and the primary that creating or opening loads once and
/// [`Chip::settle`] flushes; signing needs only the loaded child.
pub(crate) struct Tpm(Mutex<State>);
struct State {
    device: Device,
    primary: Option<u32>,
}
impl State {
    fn primary(&mut self) -> Result<u32, SealError> {
        if let Some(primary) = self.primary {
            return Ok(primary);
        }
        let primary = self.device.primary()?;
        self.primary = Some(primary);
        Ok(primary)
    }
}
impl Tpm {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// `secret || SHA-256(binding)`: the sealed object opens only under its binding.
fn sealed_data(secret: &[u8; 32], binding: &[u8; 65]) -> Zeroizing<[u8; 64]> {
    let mut data = Zeroizing::new([0; 64]);
    data[..32].copy_from_slice(secret);
    data[32..].copy_from_slice(digest(&SHA256, binding).as_ref());
    data
}

impl Chip for Tpm {
    const TAG: u8 = 2;
    type P256 = u32;
    type MlDsa = Infallible;

    fn connect() -> Result<Self, SealError> {
        Ok(Self(Mutex::new(State {
            device: device()?,
            primary: None,
        })))
    }

    fn create_p256(&self) -> Result<CreatedP256<u32>, SealError> {
        let blob = {
            let mut state = self.state();
            let primary = state.primary()?;
            state.device.create(primary, None)?
        };
        let (handle, pk) = self.open_p256(&blob)?;
        Ok((blob, handle, pk))
    }

    fn open_p256(&self, blob: &[u8]) -> Result<(u32, [u8; 65]), SealError> {
        let mut cursor = Cursor::new(blob);
        let public = cursor.blob()?;
        let private = cursor.blob()?;
        cursor.finish()?;
        let pk = commands::validate_ecc(public, false)?;
        let mut state = self.state();
        let primary = state.primary()?;
        Ok((state.device.load(primary, public, private)?, pk))
    }

    fn sign_p256(&self, key: &u32, digest: &[u8; 32]) -> Result<[u8; 64], SealError> {
        self.state().device.sign(*key, digest)
    }

    fn create_mldsa(&self) -> Result<Option<CreatedMlDsa<Infallible>>, SealError> {
        Ok(None)
    }

    fn open_mldsa(&self, _: &[u8]) -> Result<(Infallible, MlDsaPublicKey), SealError> {
        Err(SealError::InvalidMaterial)
    }

    fn sign_mldsa(&self, key: &Infallible, _: &[u8], _: &[u8]) -> Result<MlDsaSignature, SealError> {
        match *key {}
    }

    fn seal(&self, secret: &[u8; 32], binding: &[u8; 65]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        let mut state = self.state();
        let primary = state.primary()?;
        state
            .device
            .create(primary, Some(&*sealed_data(secret, binding)))
    }

    fn unseal(&self, blob: &[u8], binding: &[u8; 65]) -> Result<Zeroizing<[u8; 32]>, SealError> {
        let mut cursor = Cursor::new(blob);
        let public = cursor.blob()?;
        let private = cursor.blob()?;
        cursor.finish()?;
        commands::validate_sealed(public)?;
        let mut state = self.state();
        let primary = state.primary()?;
        let sealed = state.device.load(primary, public, private)?;
        let data = state.device.unseal(sealed);
        state.device.flush(sealed)?;
        let data = data?;
        let mut secret = Zeroizing::new([0; 32]);
        let expected = digest(&SHA256, binding);
        if data.len() != 64 || data[32..] != *expected.as_ref() {
            return Err(SealError::InvalidMaterial);
        }
        secret.copy_from_slice(&data[..32]);
        Ok(secret)
    }

    fn settle(&self) -> Result<(), SealError> {
        let mut state = self.state();
        if let Some(primary) = state.primary.take() {
            state.device.flush(primary)?;
        }
        Ok(())
    }
}

#[cfg(all(test, feature = "tpm-sim"))]
mod tests {
    use super::*;
    use crate::hardware;

    /// One test, one simulator connection at a time: swtpm serves one client.
    #[test]
    fn tpm_sim_round_trip_sign_tamper_binding_and_context_cleanup() {
        if std::env::var_os("MERKUR_TPM_SIM_ADDR").is_none() {
            return;
        }
        for _ in 0..8 {
            let (material, created) = hardware::create_on::<Tpm>().unwrap();
            assert_eq!(material[..2], [Tpm::TAG, 2], "sealed-seed variant");
            let expected = hardware::tests::Expected::of(created);
            hardware::tests::exercise::<Tpm>(&material, &expected);
        }
        let tpm = Tpm::connect().unwrap();
        let blob = tpm.seal(&[7; 32], &[4; 65]).unwrap();
        assert_eq!(*tpm.unseal(&blob, &[4; 65]).unwrap(), [7; 32]);
        assert!(tpm.unseal(&blob, &[5; 65]).is_err(), "another binding");
        tpm.settle().unwrap();
    }
}
