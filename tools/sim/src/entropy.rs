//! Seeded entropy under every reader in the simulator binary.
//!
//! Like [`crate::clock`], this binary defines the C library's entropy entry
//! points, so `std`'s hash keys, ring, rustls and quinn draw from one seeded
//! stream while a run is active, and a seed replays the run. It is a
//! simulation generator, not a cryptographic one: nothing this binary
//! encrypts is secret. Outside a run every reader gets the system's entropy.

use std::sync::Mutex;
use std::sync::OnceLock;

/// SplitMix64: one 64-bit state, a full period, and good enough statistics for
/// handshake nonces and connection ids that only need to differ.
struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn fill(&mut self, bytes: &mut [u8]) {
        for chunk in bytes.chunks_mut(8) {
            let word = self.next().to_le_bytes();
            chunk.copy_from_slice(&word[..chunk.len()]);
        }
    }
}

static STREAM: Mutex<Option<SplitMix>> = Mutex::new(None);

/// The seeded stream for the guard's lifetime.
pub struct Entropy(());

impl Entropy {
    pub fn start(seed: u64) -> Self {
        let mut stream = STREAM.lock().expect("entropy lock");
        assert!(stream.is_none(), "one simulated run at a time");
        *stream = Some(SplitMix(seed));
        Self(())
    }
}

impl Drop for Entropy {
    fn drop(&mut self) {
        *STREAM.lock().expect("entropy lock") = None;
    }
}

/// Bytes from the run's stream; `false` outside a run.
pub fn fill(bytes: &mut [u8]) -> bool {
    match STREAM.lock().expect("entropy lock").as_mut() {
        Some(stream) => {
            stream.fill(bytes);
            true
        }
        None => false,
    }
}

type Getentropy = unsafe extern "C" fn(*mut libc::c_void, libc::size_t) -> libc::c_int;

fn system_getentropy() -> Getentropy {
    static SYSTEM: OnceLock<Getentropy> = OnceLock::new();
    *SYSTEM.get_or_init(|| {
        // SAFETY: RTLD_NEXT names the next image's definition, the C library's.
        let symbol = unsafe { libc::dlsym(libc::RTLD_NEXT, c"getentropy".as_ptr()) };
        assert!(!symbol.is_null(), "the C library defines getentropy");
        // SAFETY: the symbol is `getentropy`, whose signature this is.
        unsafe { std::mem::transmute::<*mut libc::c_void, Getentropy>(symbol) }
    })
}

/// # Safety
///
/// `buffer` must be valid for `length` bytes of writes.
#[unsafe(no_mangle)]
#[inline(never)]
pub unsafe extern "C" fn getentropy(
    buffer: *mut libc::c_void,
    length: libc::size_t,
) -> libc::c_int {
    if length > 256 {
        return -1;
    }
    // SAFETY: the caller's contract.
    let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.cast::<u8>(), length) };
    if fill(bytes) {
        return 0;
    }
    // SAFETY: the caller's contract, forwarded unchanged.
    unsafe { system_getentropy()(buffer, length) }
}

/// The Apple entry point `std` draws its hash keys from.
///
/// # Safety
///
/// `buffer` must be valid for `length` bytes of writes.
#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
#[inline(never)]
pub unsafe extern "C" fn CCRandomGenerateBytes(
    buffer: *mut libc::c_void,
    length: libc::size_t,
) -> libc::c_int {
    // SAFETY: the caller's contract.
    let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.cast::<u8>(), length) };
    if fill(bytes) {
        return 0;
    }
    for chunk in bytes.chunks_mut(256) {
        // SAFETY: `chunk` is valid for its own length.
        if unsafe { system_getentropy()(chunk.as_mut_ptr().cast(), chunk.len()) } != 0 {
            return -1;
        }
    }
    0
}

/// The Linux system call wrapper `std` and `getrandom` 0.3 and later find by
/// `dlsym`; the build script exports it so they find this one.
///
/// # Safety
///
/// `buffer` must be valid for `length` bytes of writes.
#[cfg(target_os = "linux")]
#[unsafe(no_mangle)]
#[inline(never)]
pub unsafe extern "C" fn getrandom(
    buffer: *mut libc::c_void,
    length: libc::size_t,
    flags: libc::c_uint,
) -> libc::ssize_t {
    if length == 0 {
        return 0;
    }
    // SAFETY: the caller's contract.
    let bytes = unsafe { std::slice::from_raw_parts_mut(buffer.cast::<u8>(), length) };
    if fill(bytes) {
        return libc::ssize_t::try_from(length).expect("a slice length");
    }
    // SAFETY: the caller's contract, forwarded to the kernel.
    unsafe {
        system_syscall()(
            libc::SYS_getrandom,
            buffer as libc::c_long,
            length as libc::c_long,
            libc::c_long::from(flags),
        ) as libc::ssize_t
    }
}

#[cfg(target_os = "linux")]
type Syscall = unsafe extern "C" fn(libc::c_long, ...) -> libc::c_long;

/// The C library's own `syscall`, which this binary's definition hides. Cached
/// without a lock: `std`'s locks make futex calls through `syscall` themselves.
#[cfg(target_os = "linux")]
fn system_syscall() -> Syscall {
    use std::sync::atomic::{AtomicPtr, Ordering};
    static SYSTEM: AtomicPtr<libc::c_void> = AtomicPtr::new(std::ptr::null_mut());
    let mut symbol = SYSTEM.load(Ordering::Acquire);
    if symbol.is_null() {
        // SAFETY: RTLD_NEXT names the next image's definition, the C library's.
        symbol = unsafe { libc::dlsym(libc::RTLD_NEXT, c"syscall".as_ptr()) };
        assert!(!symbol.is_null(), "the C library defines syscall");
        SYSTEM.store(symbol, Ordering::Release);
    }
    // SAFETY: the symbol is `syscall`, whose signature this is.
    unsafe { std::mem::transmute::<*mut libc::c_void, Syscall>(symbol) }
}

/// `getrandom` 0.2, which ring draws from, makes the system call itself. Every
/// other system call (`std`'s futex among them) passes through unchanged.
///
/// The C function is variadic; this definition takes the six arguments a
/// system call can have, which both Linux calling conventions this runs on
/// (x86-64 System V and AArch64) pass where a variadic callee reads them.
///
/// # Safety
///
/// The arguments must be what system call `number` requires.
#[cfg(target_os = "linux")]
#[unsafe(no_mangle)]
#[inline(never)]
pub unsafe extern "C" fn syscall(
    number: libc::c_long,
    a1: libc::c_long,
    a2: libc::c_long,
    a3: libc::c_long,
    a4: libc::c_long,
    a5: libc::c_long,
    a6: libc::c_long,
) -> libc::c_long {
    if number == libc::SYS_getrandom {
        let Ok(length) = usize::try_from(a2) else {
            return -1;
        };
        // SAFETY: getrandom(2)'s contract: `a1` is writable for `a2` bytes.
        return unsafe {
            getrandom(
                a1 as *mut libc::c_void,
                length,
                libc::c_uint::try_from(a3).unwrap_or(0),
            )
        } as libc::c_long;
    }
    // SAFETY: the caller's arguments, forwarded unchanged.
    unsafe { system_syscall()(number, a1, a2, a3, a4, a5, a6) }
}
