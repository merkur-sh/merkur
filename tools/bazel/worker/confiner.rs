//! Single-threaded compiler confinement. Never initialize the macOS sandbox after fork.
#[cfg(target_os = "linux")]
mod linux_confinement;
#[cfg(any(target_os = "linux", test))]
mod linux_policy;
use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;
fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 4 || args[0] != "--profile-file" || args[2] != "--" {
        return Err(io::Error::other(
            "confiner requires --profile-file <owned policy File> -- <compiler command>",
        ));
    }
    let profile = std::fs::read_to_string(&args[1])?;
    initialize(&profile)?;
    Err(Command::new(&args[3]).args(&args[4..]).exec())
}
#[cfg(target_os = "macos")]
fn initialize(profile: &str) -> io::Result<()> {
    use std::ffi::{CStr, CString};
    #[link(name = "sandbox")]
    unsafe extern "C" {
        fn sandbox_init(
            profile: *const std::ffi::c_char,
            flags: u64,
            error: *mut *mut std::ffi::c_char,
        ) -> std::ffi::c_int;
        fn sandbox_free_error(error: *mut std::ffi::c_char);
    }
    let profile = CString::new(profile).map_err(io::Error::other)?;
    let mut detail = std::ptr::null_mut();
    unsafe {
        if sandbox_init(profile.as_ptr(), 0, &mut detail) != 0 {
            let message = if detail.is_null() {
                "sandbox initialization failed".to_owned()
            } else {
                let message = CStr::from_ptr(detail).to_string_lossy().into_owned();
                sandbox_free_error(detail);
                message
            };
            return Err(io::Error::other(message));
        }
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn initialize(profile: &str) -> io::Result<()> {
    linux_confinement::initialize(profile)
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn initialize(_profile: &str) -> io::Result<()> {
    Err(io::Error::other(
        "no qualified compiler confinement for this platform",
    ))
}
