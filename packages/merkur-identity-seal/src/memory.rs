use super::SealError;
use std::{io, marker::PhantomData, mem, ops::Deref, ptr::NonNull};
use zeroize::Zeroize;

/// A private mapping avoids sharing mlock/munlock pages with the allocator.
/// The value is dropped (and its key zeroized) before pages become pageable.
pub struct Locked<T> {
    pointer: NonNull<T>,
    bytes: usize,
    marker: PhantomData<T>,
}

// SAFETY: the mapping has one owner, and crossing a thread boundary is only
// allowed when its contained value is itself Send.
unsafe impl<T: Send> Send for Locked<T> {}
// SAFETY: a shared `Locked<T>` only hands out `&T`, so sharing it across
// threads is exactly as safe as sharing the contained value.
unsafe impl<T: Sync> Sync for Locked<T> {}

impl<T> Locked<T> {
    pub fn new(value: T) -> Result<Self, SealError> {
        // SAFETY: sysconf has no pointer arguments.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page <= 0 || mem::align_of::<T>() > page as usize {
            return Err(SealError::Memory(io::Error::last_os_error()));
        }
        let bytes = mem::size_of::<T>().max(1).div_ceil(page as usize) * page as usize;
        // SAFETY: allocate a fresh, page-aligned private mapping, with no file.
        let raw = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                bytes,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANON,
                -1,
                0,
            )
        };
        if raw == libc::MAP_FAILED {
            return Err(SealError::Memory(io::Error::last_os_error()));
        }
        // SAFETY: raw/bytes name the mapping just allocated.
        if unsafe { libc::mlock(raw, bytes) } != 0 {
            let error = io::Error::last_os_error();
            // SAFETY: release that mapping; no value has been written.
            unsafe {
                libc::munmap(raw, bytes);
            }
            return Err(SealError::Memory(error));
        }
        #[cfg(target_os = "linux")]
        // SAFETY: the mapping is page-aligned and exclusively owned.
        if unsafe { libc::madvise(raw, bytes, libc::MADV_DONTDUMP) } != 0 {
            let error = io::Error::last_os_error();
            // SAFETY: `raw` and `bytes` name the mapping locked above, still
            // exclusively this function's; no value has been written to it.
            unsafe {
                libc::munlock(raw, bytes);
            }
            // SAFETY: release that same exclusively owned mapping; nothing
            // refers to it afterwards.
            unsafe {
                libc::munmap(raw, bytes);
            }
            return Err(SealError::Memory(error));
        }
        let pointer = NonNull::new(raw.cast::<T>())
            .ok_or_else(|| SealError::Memory(io::Error::other("null mapping")))?;
        // SAFETY: mapping has sufficient size/alignment, locked before storing.
        unsafe {
            pointer.as_ptr().write(value);
        }
        Ok(Self {
            pointer,
            bytes,
            marker: PhantomData,
        })
    }
}
impl<T> Deref for Locked<T> {
    type Target = T;
    fn deref(&self) -> &T {
        // SAFETY: initialized T lives for exactly the mapping owner's lifetime.
        unsafe { self.pointer.as_ref() }
    }
}
impl<T> Drop for Locked<T> {
    fn drop(&mut self) {
        // SAFETY: `pointer` holds the value `new` wrote and nothing else owns
        // it; this owner is being dropped, so the value is dropped exactly once
        // and never read again.
        unsafe { std::ptr::drop_in_place(self.pointer.as_ptr()) };
        // SAFETY: the mapping is `bytes` long, writable and exclusively this
        // owner's, and its value is already dropped, so the byte view aliases
        // nothing live. It is only written, never read, so bytes the value left
        // as padding are not observed.
        let mapping = unsafe {
            std::slice::from_raw_parts_mut(self.pointer.as_ptr().cast::<u8>(), self.bytes)
        };
        mapping.zeroize();
        // SAFETY: `pointer` and `bytes` are the exact range `new` mapped and
        // locked; `munlock` takes the range by address and writes nothing.
        unsafe { libc::munlock(self.pointer.as_ptr().cast(), self.bytes) };
        // SAFETY: the same range, which nothing references once this drop
        // returns; this is its only unmapping.
        unsafe { libc::munmap(self.pointer.as_ptr().cast(), self.bytes) };
    }
}

pub(super) fn disable_core_dumps() -> Result<(), SealError> {
    let limits = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: limits points to one initialized rlimit.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limits) } == 0 {
        Ok(())
    } else {
        Err(SealError::Memory(io::Error::last_os_error()))
    }
}
