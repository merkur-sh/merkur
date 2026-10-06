//! The Secure Enclave as a [`Chip`]: P-256 signing keys on macOS 14 and newer,
//! ML-DSA-87 keys from macOS 26, and HPKE sealing to an enclave key-agreement
//! key. CryptoKit runs through the C ABI in `macos.swift`.

use super::SealError;
use super::hardware::{Chip, CreatedMlDsa, CreatedP256, MlDsaPublicKey, MlDsaSignature};
use merkur_e2e::{DAEMON_IDENTITY_PUBLIC_KEY_BYTES, DAEMON_IDENTITY_SIGNATURE_BYTES};
use std::{ffi::c_void, ptr::NonNull};
use zeroize::Zeroizing;

/// Resource bound on one wrapped key or sealed blob; the measured ML-DSA-87
/// blob is 2,857 bytes.
const BLOB_MAX_BYTES: usize = 4096;
/// The Swift bridge's "this enclave cannot hold an ML-DSA-87 key".
const UNSUPPORTED: i32 = 3;

unsafe extern "C" {
    fn merkur_enclave_available() -> i32;
    fn merkur_enclave_release(handle: *mut c_void);
    fn merkur_enclave_p256_create(
        output: *mut u8,
        capacity: isize,
        length: *mut isize,
        public_key: *mut u8,
        handle: *mut *mut c_void,
    ) -> i32;
    fn merkur_enclave_p256_open(
        input: *const u8,
        length: isize,
        public_key: *mut u8,
        handle: *mut *mut c_void,
    ) -> i32;
    fn merkur_enclave_p256_sign(handle: *mut c_void, digest: *const u8, signature: *mut u8)
    -> i32;
    fn merkur_enclave_mldsa_create(
        output: *mut u8,
        capacity: isize,
        length: *mut isize,
        public_key: *mut u8,
        handle: *mut *mut c_void,
    ) -> i32;
    fn merkur_enclave_mldsa_open(
        input: *const u8,
        length: isize,
        public_key: *mut u8,
        handle: *mut *mut c_void,
    ) -> i32;
    fn merkur_enclave_mldsa_sign(
        handle: *mut c_void,
        context: *const u8,
        context_length: isize,
        message: *const u8,
        message_length: isize,
        signature: *mut u8,
    ) -> i32;
    fn merkur_enclave_seal(
        secret: *const u8,
        binding: *const u8,
        output: *mut u8,
        capacity: isize,
        length: *mut isize,
    ) -> i32;
    fn merkur_enclave_unseal(
        input: *const u8,
        length: isize,
        binding: *const u8,
        secret: *mut u8,
    ) -> i32;
}

pub(super) fn available() -> bool {
    // SAFETY: no arguments; Swift guards availability before using CryptoKit.
    unsafe { merkur_enclave_available() == 1 }
}

/// One retained CryptoKit enclave key.
pub(crate) struct Handle(NonNull<c_void>);
// SAFETY: the handle owns one retained, immutable CryptoKit key, a type
// CryptoKit declares `Sendable`; signing with it from any thread, also
// concurrently, is what that conformance permits.
unsafe impl Send for Handle {}
// SAFETY: as above; `Handle` exposes no mutation.
unsafe impl Sync for Handle {}
impl Handle {
    fn new(raw: *mut c_void) -> Result<Self, SealError> {
        NonNull::new(raw).map(Self).ok_or(SealError::Hardware)
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: balances Swift's one passRetained; no other owner exists.
        unsafe { merkur_enclave_release(self.0.as_ptr()) }
    }
}

pub(crate) struct Enclave;

/// The fixed-capacity output of one create or seal call.
fn blob_out(
    call: impl FnOnce(*mut u8, isize, *mut isize) -> i32,
) -> Result<(i32, Zeroizing<Vec<u8>>), SealError> {
    let mut blob = Zeroizing::new(vec![0; BLOB_MAX_BYTES]);
    let mut length = 0isize;
    let rc = call(blob.as_mut_ptr(), BLOB_MAX_BYTES as isize, &mut length);
    if rc == 0 {
        if length <= 0 || length as usize > BLOB_MAX_BYTES {
            return Err(SealError::Hardware);
        }
        blob.truncate(length as usize);
    }
    Ok((rc, blob))
}

fn status(rc: i32) -> Result<(), SealError> {
    match rc {
        0 => Ok(()),
        1 => Err(SealError::Unavailable),
        _ => Err(SealError::Hardware),
    }
}

impl Chip for Enclave {
    const TAG: u8 = 1;
    type P256 = Handle;
    type MlDsa = Handle;

    fn connect() -> Result<Self, SealError> {
        if available() {
            Ok(Self)
        } else {
            Err(SealError::Unavailable)
        }
    }

    fn create_p256(&self) -> Result<CreatedP256<Handle>, SealError> {
        let mut pk = [0; 65];
        let mut handle = std::ptr::null_mut();
        // SAFETY: every buffer is exclusively borrowed and sized per the ABI;
        // Swift retains no pointer and returns one retained handle on success.
        let (rc, blob) = blob_out(|output, capacity, length| unsafe {
            merkur_enclave_p256_create(output, capacity, length, pk.as_mut_ptr(), &mut handle)
        })?;
        status(rc)?;
        Ok((blob, Handle::new(handle)?, pk))
    }

    fn open_p256(&self, blob: &[u8]) -> Result<(Handle, [u8; 65]), SealError> {
        let mut pk = [0; 65];
        let mut handle = std::ptr::null_mut();
        // SAFETY: input is read only for the call; outputs are sized per the ABI.
        status(unsafe {
            merkur_enclave_p256_open(
                blob.as_ptr(),
                blob.len() as isize,
                pk.as_mut_ptr(),
                &mut handle,
            )
        })?;
        Ok((Handle::new(handle)?, pk))
    }

    fn sign_p256(&self, key: &Handle, digest: &[u8; 32]) -> Result<[u8; 64], SealError> {
        let mut signature = [0; 64];
        // SAFETY: a live handle and exactly sized ABI buffers.
        status(unsafe {
            merkur_enclave_p256_sign(key.0.as_ptr(), digest.as_ptr(), signature.as_mut_ptr())
        })?;
        Ok(signature)
    }

    fn create_mldsa(&self) -> Result<Option<CreatedMlDsa<Handle>>, SealError> {
        let mut pk = Box::new([0; DAEMON_IDENTITY_PUBLIC_KEY_BYTES]);
        let mut handle = std::ptr::null_mut();
        // SAFETY: as for `create_p256`, with the 2,592-byte public key buffer.
        let (rc, blob) = blob_out(|output, capacity, length| unsafe {
            merkur_enclave_mldsa_create(output, capacity, length, pk.as_mut_ptr(), &mut handle)
        })?;
        if rc == UNSUPPORTED {
            return Ok(None);
        }
        status(rc)?;
        Ok(Some((blob, Handle::new(handle)?, pk)))
    }

    fn open_mldsa(&self, blob: &[u8]) -> Result<(Handle, MlDsaPublicKey), SealError> {
        let mut pk = Box::new([0; DAEMON_IDENTITY_PUBLIC_KEY_BYTES]);
        let mut handle = std::ptr::null_mut();
        // SAFETY: input is read only for the call; outputs are sized per the ABI.
        let rc = unsafe {
            merkur_enclave_mldsa_open(
                blob.as_ptr(),
                blob.len() as isize,
                pk.as_mut_ptr(),
                &mut handle,
            )
        };
        // A resident key on an OS that predates enclave ML-DSA cannot open.
        if rc == UNSUPPORTED {
            return Err(SealError::Unavailable);
        }
        status(rc)?;
        Ok((Handle::new(handle)?, pk))
    }

    fn sign_mldsa(
        &self,
        key: &Handle,
        context: &[u8],
        message: &[u8],
    ) -> Result<MlDsaSignature, SealError> {
        let mut signature = Box::new([0; DAEMON_IDENTITY_SIGNATURE_BYTES]);
        // SAFETY: a live handle; context and message are read only for the
        // call and the signature buffer is exactly 4,627 bytes.
        status(unsafe {
            merkur_enclave_mldsa_sign(
                key.0.as_ptr(),
                context.as_ptr(),
                context.len() as isize,
                message.as_ptr(),
                message.len() as isize,
                signature.as_mut_ptr(),
            )
        })?;
        Ok(signature)
    }

    fn seal(&self, secret: &[u8; 32], binding: &[u8; 65]) -> Result<Zeroizing<Vec<u8>>, SealError> {
        // SAFETY: fixed-size inputs read only for the call; output sized per the ABI.
        let (rc, blob) = blob_out(|output, capacity, length| unsafe {
            merkur_enclave_seal(secret.as_ptr(), binding.as_ptr(), output, capacity, length)
        })?;
        status(rc)?;
        Ok(blob)
    }

    fn unseal(&self, blob: &[u8], binding: &[u8; 65]) -> Result<Zeroizing<[u8; 32]>, SealError> {
        let mut secret = Zeroizing::new([0; 32]);
        // SAFETY: inputs read only for the call; the secret buffer is 32 bytes.
        status(unsafe {
            merkur_enclave_unseal(
                blob.as_ptr(),
                blob.len() as isize,
                binding.as_ptr(),
                secret.as_mut_ptr(),
            )
        })?;
        Ok(secret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware;

    #[test]
    fn enclave_resident_pair_round_trips_signs_and_refuses_tampering() {
        if !available() {
            return;
        }
        let (material, created) = hardware::create().unwrap();
        // macOS 26 holds the ML-DSA key itself: the resident variant.
        if Enclave.create_mldsa().unwrap().is_some() {
            assert_eq!(material[1], 1, "resident variant");
            assert!(
                created.derive_storage_key(b"salt", &[b"info"]).is_err(),
                "no secret exists outside the chip"
            );
        }
        let expected = hardware::tests::Expected::of(created);
        hardware::tests::exercise::<Enclave>(&material, &expected);
    }

    /// The enclave as a chip that cannot hold ML-DSA-87, as on macOS 14-25.
    struct WithoutMlDsa;
    impl Chip for WithoutMlDsa {
        const TAG: u8 = Enclave::TAG;
        type P256 = Handle;
        type MlDsa = Handle;
        fn connect() -> Result<Self, SealError> {
            Enclave::connect().map(|_| Self)
        }
        fn create_p256(&self) -> Result<CreatedP256<Handle>, SealError> {
            Enclave.create_p256()
        }
        fn open_p256(&self, blob: &[u8]) -> Result<(Handle, [u8; 65]), SealError> {
            Enclave.open_p256(blob)
        }
        fn sign_p256(&self, key: &Handle, digest: &[u8; 32]) -> Result<[u8; 64], SealError> {
            Enclave.sign_p256(key, digest)
        }
        fn create_mldsa(&self) -> Result<Option<CreatedMlDsa<Handle>>, SealError> {
            Ok(None)
        }
        fn open_mldsa(&self, _: &[u8]) -> Result<(Handle, MlDsaPublicKey), SealError> {
            Err(SealError::Unavailable)
        }
        fn sign_mldsa(&self, _: &Handle, _: &[u8], _: &[u8]) -> Result<MlDsaSignature, SealError> {
            Err(SealError::Unavailable)
        }
        fn seal(
            &self,
            secret: &[u8; 32],
            binding: &[u8; 65],
        ) -> Result<Zeroizing<Vec<u8>>, SealError> {
            Enclave.seal(secret, binding)
        }
        fn unseal(
            &self,
            blob: &[u8],
            binding: &[u8; 65],
        ) -> Result<Zeroizing<[u8; 32]>, SealError> {
            Enclave.unseal(blob, binding)
        }
    }

    #[test]
    fn enclave_sealed_seed_pair_round_trips_through_the_same_composition() {
        if !available() {
            return;
        }
        let (material, created) = hardware::create_on::<WithoutMlDsa>().unwrap();
        assert_eq!(material[..2], [Enclave::TAG, 2], "sealed-seed variant");
        assert_eq!(
            *created.derive_storage_key(b"salt", &[b"info"]).unwrap(),
            *hardware::open_on::<WithoutMlDsa>(&material)
                .unwrap()
                .derive_storage_key(b"salt", &[b"info"])
                .unwrap()
        );
        let expected = hardware::tests::Expected::of(created);
        hardware::tests::exercise::<WithoutMlDsa>(&material, &expected);
        // The real enclave opens it too: the variant is the material's, not the chip's.
        hardware::tests::exercise::<Enclave>(&material, &expected);
    }

    #[test]
    fn enclave_sealed_seed_binds_the_p256_key() {
        if !available() {
            return;
        }
        let (_, _, p256) = Enclave.create_p256().unwrap();
        let blob = Enclave.seal(&[7; 32], &p256).unwrap();
        assert_eq!(*Enclave.unseal(&blob, &p256).unwrap(), [7; 32]);
        let mut other = p256;
        other[64] ^= 1;
        assert!(Enclave.unseal(&blob, &other).is_err(), "another binding");
    }
}
