//! The level-1 libdeflate context lives entirely in one caller-admitted arena.
//! No process-global allocator override, unchecked workspace estimate or C heap
//! allocation is used. The pinned constructor asks its allocator once; any larger
//! or repeated request fails closed. Compression itself does not allocate.

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::NonNull;
use zeroize::Zeroize;

/// Resource bound, enforced by the allocation callback including libdeflate's
/// alignment overhead. A dependency whose context exceeds it cannot initialize.
pub(crate) const ARENA_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy)]
struct Allocation {
    pointer: *mut c_void,
    bytes: usize,
    used: usize,
}

thread_local! {
    // Only the synchronous constructor installs this scoped allocation target.
    // Independent threads can construct contexts without sharing allocator state.
    static ALLOCATION: Cell<Option<Allocation>> = const { Cell::new(None) };
}

unsafe extern "C" fn allocate(bytes: usize) -> *mut c_void {
    ALLOCATION
        .try_with(|slot| {
            let Some(mut allocation) = slot.get() else {
                return std::ptr::null_mut();
            };
            if allocation.used != 0 || bytes == 0 || bytes > allocation.bytes {
                return std::ptr::null_mut();
            }
            allocation.used = bytes;
            slot.set(Some(allocation));
            allocation.pointer
        })
        .unwrap_or(std::ptr::null_mut())
}

unsafe extern "C" fn release(_pointer: *mut c_void) {
    // The arena owner releases the original allocation after C destruction.
}

pub(crate) struct Compressor {
    context: NonNull<libdeflate_sys::libdeflate_compressor>,
    arena: Box<[u128]>,
}

// SAFETY: the context and its sole backing allocation move together. The C
// library retains no thread-local allocator state; it keeps only `release`.
// Compression requires &mut self. No shared (Sync) access is provided.
unsafe impl Send for Compressor {}

impl Compressor {
    pub(crate) fn new() -> Option<Self> {
        Self::with_arena_bytes(ARENA_BYTES)
    }

    fn with_arena_bytes(bytes: usize) -> Option<Self> {
        // u128 supplies malloc-compatible fundamental alignment. libdeflate then
        // aligns its context within this region, charging that padding itself.
        let mut arena = vec![0u128; bytes / size_of::<u128>()].into_boxed_slice();
        let allocation = Allocation {
            pointer: arena.as_mut_ptr().cast(),
            bytes: size_of_val(&*arena),
            used: 0,
        };
        let context = ALLOCATION.with(|slot| {
            if slot.get().is_some() {
                return None;
            }
            slot.set(Some(allocation));
            let options = libdeflate_sys::libdeflate_options {
                sizeof_options: size_of::<libdeflate_sys::libdeflate_options>(),
                malloc_func: Some(allocate),
                free_func: Some(release),
            };
            // SAFETY: options has the exact FFI layout and outlives this call.
            // The allocator returns at most one valid region of the requested
            // size. The retained context remains backed by `arena` until Drop.
            let context = unsafe { libdeflate_sys::libdeflate_alloc_compressor_ex(1, &options) };
            slot.set(None);
            NonNull::new(context)
        })?;
        Some(Self { context, arena })
    }

    pub(crate) fn compress(&mut self, input: &[u8], output: &mut [u8]) -> Option<usize> {
        // SAFETY: both slices expose their exact lengths, do not alias, and
        // remain borrowed for the call. The uniquely owned context is live.
        let count = unsafe {
            libdeflate_sys::libdeflate_zlib_compress(
                self.context.as_ptr(),
                input.as_ptr().cast(),
                input.len(),
                output.as_mut_ptr().cast(),
                output.len(),
            )
        };
        (count != 0).then_some(count)
    }

    #[cfg(test)]
    pub(crate) fn bound(&mut self, bytes: usize) -> usize {
        // SAFETY: bound reads a live context and does not retain its pointer.
        unsafe { libdeflate_sys::libdeflate_zlib_compress_bound(self.context.as_ptr(), bytes) }
    }
}

impl Drop for Compressor {
    fn drop(&mut self) {
        // SAFETY: context belongs to this arena and has not been freed. C calls
        // the no-op `release`; Rust wipes and drops its backing allocation next.
        unsafe { libdeflate_sys::libdeflate_free_compressor(self.context.as_ptr()) };
        self.arena.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_constructor_refuses_small_arena_and_preserves_the_pinned_codec() {
        assert!(Compressor::with_arena_bytes(16).is_none());
        let mut compressor = Compressor::new().unwrap();
        let mut reference =
            libdeflater::Compressor::new(libdeflater::CompressionLvl::new(1).unwrap());
        let input: Vec<u8> = (0..266514).map(|i| (i * 7 + i / 89) as u8).collect();
        let mut out = vec![0; compressor.bound(input.len())];
        let mut expected = vec![0; reference.zlib_compress_bound(input.len())];
        for _ in 0..8 {
            let count = compressor.compress(&input, &mut out).unwrap();
            let expected_count = reference.zlib_compress(&input, &mut expected).unwrap();
            assert_eq!(&out[..count], &expected[..expected_count]);
            assert!(compressor.compress(&input, &mut []).is_none());
        }
        std::thread::spawn(move || {
            assert!(compressor.compress(&input, &mut out).is_some());
        })
        .join()
        .unwrap();
    }
}
