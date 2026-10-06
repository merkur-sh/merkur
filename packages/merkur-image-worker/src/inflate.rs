//! One-shot zlib inflation of a Kitty `o=z` payload whose exact inflated size the
//! request already declares. libdeflate decodes straight into that span, which
//! measured 3.2x faster than a streaming miniz_oxide inflate on a 2400x1360 RGBA
//! screenshot. Its one context allocation comes from a caller-owned arena, as the
//! tile compressor's does, so no C heap allocation reaches the fixed worker heap.

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::NonNull;

/// Resource bound on the decompressor context, enforced by the allocation
/// callback including libdeflate's alignment padding. The context is its fixed
/// Huffman decode tables: a measured 11,568-byte request on aarch64-apple-darwin.
const ARENA_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy)]
struct Allocation {
    pointer: *mut c_void,
    bytes: usize,
    used: bool,
}

thread_local! {
    static ALLOCATION: Cell<Option<Allocation>> = const { Cell::new(None) };
}

unsafe extern "C" fn allocate(bytes: usize) -> *mut c_void {
    ALLOCATION
        .try_with(|slot| {
            let Some(mut allocation) = slot.get() else {
                return std::ptr::null_mut();
            };
            if allocation.used || bytes == 0 || bytes > allocation.bytes {
                return std::ptr::null_mut();
            }
            allocation.used = true;
            slot.set(Some(allocation));
            allocation.pointer
        })
        .unwrap_or(std::ptr::null_mut())
}

unsafe extern "C" fn release(_pointer: *mut c_void) {
    // The arena owner releases the original allocation after C destruction.
}

struct Decompressor {
    context: NonNull<libdeflate_sys::libdeflate_decompressor>,
    _arena: Box<[u128]>,
}

impl Decompressor {
    fn new() -> Option<Self> {
        // u128 supplies malloc-compatible fundamental alignment.
        let mut arena = vec![0u128; ARENA_BYTES / size_of::<u128>()].into_boxed_slice();
        let allocation = Allocation {
            pointer: arena.as_mut_ptr().cast(),
            bytes: size_of_val(&*arena),
            used: false,
        };
        let context = ALLOCATION.with(|slot| {
            slot.set(Some(allocation));
            let options = libdeflate_sys::libdeflate_options {
                sizeof_options: size_of::<libdeflate_sys::libdeflate_options>(),
                malloc_func: Some(allocate),
                free_func: Some(release),
            };
            // SAFETY: options has the exact FFI layout and outlives this call.
            // The allocator returns at most one region of the requested size,
            // which stays backed by `arena` until Drop frees the context.
            let context = unsafe { libdeflate_sys::libdeflate_alloc_decompressor_ex(&options) };
            slot.set(None);
            NonNull::new(context)
        })?;
        Some(Self {
            context,
            _arena: arena,
        })
    }
}

impl Drop for Decompressor {
    fn drop(&mut self) {
        // SAFETY: context belongs to this arena and has not been freed. C calls
        // the no-op `release`; Rust drops the backing allocation next.
        unsafe { libdeflate_sys::libdeflate_free_decompressor(self.context.as_ptr()) };
    }
}

/// Inflate one complete zlib stream into exactly `output.len()` bytes. A stream
/// that is corrupt, fails its Adler-32, inflates to any other length, or is
/// followed by trailing input is refused.
pub fn zlib_exact(input: &[u8], output: &mut [u8]) -> Option<()> {
    let decompressor = Decompressor::new()?;
    let mut consumed = 0usize;
    let mut produced = 0usize;
    // SAFETY: both slices expose their exact lengths, do not alias, and stay
    // borrowed for the call; the counters are valid for writes. The context
    // is live and uniquely owned.
    let result = unsafe {
        libdeflate_sys::libdeflate_zlib_decompress_ex(
            decompressor.context.as_ptr(),
            input.as_ptr().cast(),
            input.len(),
            output.as_mut_ptr().cast(),
            output.len(),
            &mut consumed,
            &mut produced,
        )
    };
    (result == libdeflate_sys::libdeflate_result_LIBDEFLATE_SUCCESS
        && consumed == input.len()
        && produced == output.len())
    .then_some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zlib(input: &[u8]) -> Vec<u8> {
        let mut compressor =
            libdeflater::Compressor::new(libdeflater::CompressionLvl::new(6).unwrap());
        let mut out = vec![0; compressor.zlib_compress_bound(input.len())];
        let n = compressor.zlib_compress(input, &mut out).unwrap();
        out.truncate(n);
        out
    }

    #[test]
    fn inflates_exactly_the_declared_extent_and_nothing_else() {
        let input: Vec<u8> = (0..266_514).map(|i| (i * 7 + i / 89) as u8).collect();
        let stream = zlib(&input);
        let mut out = vec![0; input.len()];
        assert!(zlib_exact(&stream, &mut out).is_some());
        assert_eq!(out, input);

        // Declared extent one short, one long, trailing input, corruption.
        assert!(zlib_exact(&stream, &mut vec![0; input.len() - 1]).is_none());
        assert!(zlib_exact(&stream, &mut vec![0; input.len() + 1]).is_none());
        let mut trailing = stream.clone();
        trailing.write_all(&[0]).unwrap();
        assert!(zlib_exact(&trailing, &mut out).is_none());
        let mut corrupt = stream;
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(zlib_exact(&corrupt, &mut out).is_none());
    }

    #[test]
    fn decompressor_context_fits_its_arena_bound() {
        assert!(Decompressor::new().is_some());
    }
}
