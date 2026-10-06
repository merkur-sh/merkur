//! Credential storage in the current user's macOS login Keychain.
//! Values never pass through a command line, environment variable or log.

use std::ffi::{CString, c_void};
use zeroize::Zeroizing;

#[derive(Debug)]
pub struct Error(pub i32);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Keychain operation failed ({})", self.0)
    }
}
impl std::error::Error for Error {}

unsafe extern "C" {
    fn merkur_keychain_put(
        service: *const i8,
        account: *const i8,
        bytes: *const u8,
        length: isize,
    ) -> i32;
    fn merkur_keychain_get(
        service: *const i8,
        account: *const i8,
        handle: *mut *mut c_void,
        bytes: *mut *const u8,
        length: *mut isize,
    ) -> i32;
    fn merkur_keychain_delete(service: *const i8, account: *const i8) -> i32;
    fn merkur_keychain_release(handle: *mut c_void);
}

fn names(service: &str, account: &str) -> Result<(CString, CString), Error> {
    if service.is_empty() || account.is_empty() {
        return Err(Error(-50));
    }
    Ok((
        CString::new(service).map_err(|_| Error(-50))?,
        CString::new(account).map_err(|_| Error(-50))?,
    ))
}

pub fn put(service: &str, account: &str, secret: &[u8]) -> Result<(), Error> {
    let (service, account) = names(service, account)?;
    let length = isize::try_from(secret.len()).map_err(|_| Error(-50))?;
    // SAFETY: both names are NUL-terminated; the borrowed bytes remain live
    // until Swift's synchronous Keychain call returns. No pointer is retained.
    let status =
        unsafe { merkur_keychain_put(service.as_ptr(), account.as_ptr(), secret.as_ptr(), length) };
    if status == 0 {
        Ok(())
    } else {
        Err(Error(status))
    }
}

pub fn get(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
    let (service, account) = names(service, account)?;
    let mut handle = std::ptr::null_mut();
    let mut bytes = std::ptr::null();
    let mut length = 0;
    // SAFETY: initialized writable out pointers; Swift retains exactly one
    // byte buffer on success, which the guard below owns until release.
    let status = unsafe {
        merkur_keychain_get(
            service.as_ptr(),
            account.as_ptr(),
            &mut handle,
            &mut bytes,
            &mut length,
        )
    };
    if status == -25300 {
        return Ok(None);
    }
    if status != 0 {
        return Err(Error(status));
    }
    struct Buffer(*mut c_void);
    impl Drop for Buffer {
        fn drop(&mut self) {
            // SAFETY: balances the successful C ABI call's retained buffer.
            unsafe {
                merkur_keychain_release(self.0);
            }
        }
    }
    if handle.is_null() {
        return Err(Error(-50));
    }
    let _buffer = Buffer(handle);
    if length < 0 || (length > 0 && bytes.is_null()) {
        return Err(Error(-50));
    }
    let value = if length == 0 {
        Vec::new()
    } else {
        // SAFETY: `length > 0` and `bytes` is non-null, both checked above.
        // `merkur_keychain_get` reported `length` initialized bytes at `bytes`
        // inside the buffer `_buffer` retains, which is released only when
        // this function returns, after the copy.
        unsafe { std::slice::from_raw_parts(bytes, length as usize) }.to_vec()
    };
    Ok(Some(Zeroizing::new(value)))
}

pub fn delete(service: &str, account: &str) -> Result<(), Error> {
    let (service, account) = names(service, account)?;
    // SAFETY: NUL-terminated names borrowed for a synchronous call.
    let status = unsafe { merkur_keychain_delete(service.as_ptr(), account.as_ptr()) };
    if status == 0 || status == -25300 {
        Ok(())
    } else {
        Err(Error(status))
    }
}
