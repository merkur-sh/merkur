//! Where keyd's keys live: a private anonymous mapping of their own, locked so the kernel never
//! writes it to swap, left out of core files, and zeroed before it is released. Only these pages
//! are locked, so keyd fits the memory-lock limit a process gets by default and its heap (the
//! attempt budget) is never charged against it.

use std::io;
use std::mem::{align_of, size_of};
use std::ops::Deref;
use std::ptr::{self, NonNull};

use zeroize::Zeroize;

pub struct Locked<T> {
    value: NonNull<T>,
    length: usize,
}

// SAFETY: the mapping is owned by this value alone, so moving it between threads moves the `T`
// it holds, which is sound exactly when `T` is `Send`.
unsafe impl<T: Send> Send for Locked<T> {}
// SAFETY: a shared reference only hands out `&T`.
unsafe impl<T: Sync> Sync for Locked<T> {}

impl<T> Locked<T> {
    /// Moves `value` onto locked pages of its own. The caller's copy is the one transient copy.
    pub fn new(value: T) -> io::Result<Self> {
        let length = locked_length::<T>()?;
        // SAFETY: a fresh anonymous private mapping; no address, file or offset is named.
        let mapping = unsafe {
            libc::mmap(
                ptr::null_mut(),
                length,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANON,
                -1,
                0,
            )
        };
        if mapping == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        if let Err(error) = protect(mapping, length) {
            // SAFETY: the mapping above, which holds nothing yet and is referenced nowhere else.
            unsafe { libc::munmap(mapping, length) };
            return Err(error);
        }
        let Some(slot) = NonNull::new(mapping.cast::<T>()) else {
            return Err(io::Error::other("mmap answered a null mapping"));
        };
        // SAFETY: the mapping is page-aligned (so aligned for `T`, checked in `locked_length`),
        // at least `size_of::<T>()` bytes, writable, and holds no value to overwrite.
        unsafe { slot.as_ptr().write(value) };
        Ok(Self {
            value: slot,
            length,
        })
    }
}

/// The mapping's length: `T`, rounded up to whole pages.
fn locked_length<T>() -> io::Result<usize> {
    // SAFETY: sysconf reads a constant and takes no pointer.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    let page = usize::try_from(page).map_err(|error| io::Error::other(error.to_string()))?;
    if page == 0 || align_of::<T>() > page {
        return Err(io::Error::other("no page size that aligns the keys"));
    }
    Ok(size_of::<T>().max(1).div_ceil(page) * page)
}

/// Locks the mapping in memory and, on Linux, leaves it out of core files.
fn protect(mapping: *mut libc::c_void, length: usize) -> io::Result<()> {
    // SAFETY: `mapping` and `length` name one whole mapping this module just made.
    if unsafe { libc::mlock(mapping, length) } != 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the same page-aligned mapping; madvise only changes how it is dumped.
        if unsafe { libc::madvise(mapping, length, libc::MADV_DONTDUMP) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

impl<T> Deref for Locked<T> {
    type Target = T;

    fn deref(&self) -> &T {
        // SAFETY: `new` wrote a `T` there, and it lives until this owner drops.
        unsafe { self.value.as_ref() }
    }
}

impl<T> Drop for Locked<T> {
    fn drop(&mut self) {
        // SAFETY: the `T` `new` wrote is owned here alone and is dropped exactly this once.
        unsafe { ptr::drop_in_place(self.value.as_ptr()) };
        // SAFETY: the whole mapping, writable and owned here; its value is dropped, so these
        // bytes alias nothing live and are only written.
        let bytes =
            unsafe { std::slice::from_raw_parts_mut(self.value.as_ptr().cast::<u8>(), self.length) };
        bytes.zeroize();
        // SAFETY: the range `new` mapped; unmapping also unlocks it, and nothing refers to it after.
        unsafe { libc::munmap(self.value.as_ptr().cast(), self.length) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_reads_back_from_its_locked_pages() {
        let locked = Locked::new([7u8; 5000]).unwrap();
        assert_eq!(locked[4999], 7);
        assert_eq!(locked.length % 4096, 0);
        assert!(locked.length >= 5000);
    }
}
