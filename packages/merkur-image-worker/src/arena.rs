//! One statically mapped heap. No allocator operation can ask the kernel for memory.
use std::alloc::{GlobalAlloc, Layout};
use std::cell::UnsafeCell;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};

/// Heap resource bound: compressed input, inflated input, decoder workspace and
/// RGBA output share this arena. Unused pages are never touched at startup.
const HEAP_BYTES: usize = 384 * 1024 * 1024;

// Keep static alignment within the native linker's supported common-symbol
// alignment. Darwin's linker can place an over-aligned 64 KiB common symbol at
// only 16 KiB alignment. LLVM then folds pointer arithmetic using a false low-bit
// guarantee and dlmalloc writes chunk headers before this allocation. Larger
// client alignments are handled inside the arena by dlmalloc, not by the linker.
#[repr(C, align(4096))]
struct Memory(UnsafeCell<[u8; HEAP_BYTES]>);

// SAFETY: the backing region is handed to exactly one allocator, once. Every
// allocation/free is serialized by ALLOCATOR; clients access disjoint live blocks.
unsafe impl Sync for Memory {}
static MEMORY: Memory = Memory(UnsafeCell::new([0; HEAP_BYTES]));

struct FixedRegion(AtomicBool);

// SAFETY: a successful call transfers the entire aligned, writable, static region
// exclusively to Dlmalloc. It never relocates, overlaps another region or releases
// pages. All unsuccessful system operations return failure without changing memory.
unsafe impl dlmalloc::Allocator for FixedRegion {
    fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
        if size > HEAP_BYTES || self.0.swap(true, Ordering::Relaxed) {
            return (ptr::null_mut(), 0, 0);
        }
        (MEMORY.0.get().cast(), HEAP_BYTES, 0)
    }
    fn remap(&self, _: *mut u8, _: usize, _: usize, _: bool) -> *mut u8 {
        ptr::null_mut()
    }
    fn free_part(&self, _: *mut u8, _: usize, _: usize) -> bool {
        false
    }
    fn free(&self, _: *mut u8, _: usize) -> bool {
        false
    }
    fn can_release_part(&self, _: u32) -> bool {
        false
    }
    fn allocates_zeros(&self) -> bool {
        true
    }
    fn page_size(&self) -> usize {
        // Internal region granularity; no OS mapping operation uses this value.
        // The linked backing object and its extent are multiples of 4 KiB.
        4096
    }
}

struct Arena {
    locked: AtomicBool,
    heap: UnsafeCell<dlmalloc::Dlmalloc<FixedRegion>>,
}

// SAFETY: the atomic lock serializes every access to the UnsafeCell. A native
// std::sync::Mutex can allocate its platform primitive on first lock, recursively
// entering this global allocator. This lock never allocates or enters the kernel.
unsafe impl Sync for Arena {}

struct Unlock<'a>(&'a AtomicBool);
impl Drop for Unlock<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Arena {
    fn with_heap<R>(&self, f: impl FnOnce(&mut dlmalloc::Dlmalloc<FixedRegion>) -> R) -> R {
        while self
            .locked
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            std::hint::spin_loop();
        }
        let _unlock = Unlock(&self.locked);
        // SAFETY: the guard holds exclusive access until the closure returns.
        f(unsafe { &mut *self.heap.get() })
    }
}

#[global_allocator]
static ALLOCATOR: Arena = Arena {
    locked: AtomicBool::new(false),
    heap: UnsafeCell::new(dlmalloc::Dlmalloc::new_with_allocator(FixedRegion(
        AtomicBool::new(false),
    ))),
};

// SAFETY: Dlmalloc implements the allocation contract for the supplied layout.
// The lock grants exclusive allocator access, including during runtime startup.
// Allocation paths never allocate a lock or call the system allocator.
unsafe impl GlobalAlloc for Arena {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        self.with_heap(|heap| {
            // SAFETY: Dlmalloc's `malloc` takes `GlobalAlloc::alloc`'s contract,
            // which this method's caller upholds for `layout`; its size and
            // alignment are passed through unchanged.
            unsafe { heap.malloc(layout.size(), layout.align()) }
        })
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        self.with_heap(|heap| {
            // SAFETY: Dlmalloc's `calloc` takes `GlobalAlloc::alloc_zeroed`'s
            // contract, which this method's caller upholds for `layout`.
            unsafe { heap.calloc(layout.size(), layout.align()) }
        })
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        self.with_heap(|heap| {
            // SAFETY: `GlobalAlloc::dealloc`'s caller passes a block this
            // allocator returned, so this heap allocated it, with the size and
            // alignment `layout` repeats.
            unsafe { heap.free(pointer, layout.size(), layout.align()) }
        })
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        self.with_heap(|heap| {
            // SAFETY: `GlobalAlloc::realloc`'s caller passes a block this heap
            // allocated with `layout`, and a new size that is nonzero and
            // valid for the same alignment.
            unsafe { heap.realloc(pointer, layout.size(), layout.align(), size) }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_backing_region_honors_its_declared_alignment() {
        // Hide the address from LLVM so this checks the linked image, rather
        // than folding to true from the very alignment promise under test.
        let address = std::hint::black_box(MEMORY.0.get() as usize);
        assert_eq!(address % std::mem::align_of::<Memory>(), 0);
    }

    #[test]
    fn fixed_heap_reuses_freed_blocks_and_preserves_aligned_reallocations() {
        let layout = Layout::from_size_align(1024 * 1024, 65536).unwrap();
        let doubled = Layout::from_size_align(layout.size() * 2, layout.align()).unwrap();
        // SAFETY: `layout` has a nonzero size.
        let first = unsafe { ALLOCATOR.alloc(layout) };
        assert!(!first.is_null());
        assert_eq!(first as usize % layout.align(), 0);
        // SAFETY: `first` is a live, non-null block of `layout.size()` bytes
        // that only this test holds.
        unsafe { ptr::write_bytes(first, 0x5a, layout.size()) };
        // SAFETY: `first` was allocated here with `layout`, and the new size is
        // nonzero and valid for its alignment. `first` is not used again.
        let larger = unsafe { ALLOCATOR.realloc(first, layout, doubled.size()) };
        assert!(!larger.is_null());
        assert_eq!(larger as usize % layout.align(), 0);
        // SAFETY: a successful reallocation keeps the old block's
        // `layout.size()` initialized bytes at the start of the non-null
        // `larger`.
        let kept = unsafe { std::slice::from_raw_parts(larger, layout.size()) };
        assert!(kept.iter().all(|b| *b == 0x5a));
        // SAFETY: `larger` is the live block of `doubled`'s size and alignment;
        // `kept` is not used past this point.
        unsafe { ALLOCATOR.dealloc(larger, doubled) };
        for _ in 0..512 {
            // SAFETY: `layout` has a nonzero size.
            let block = unsafe { ALLOCATOR.alloc_zeroed(layout) };
            assert!(!block.is_null());
            // SAFETY: `block` is non-null and `alloc_zeroed` initialized all
            // `layout.size()` bytes of it.
            let zeroed = unsafe { std::slice::from_raw_parts(block, layout.size()) };
            assert!(zeroed.iter().all(|b| *b == 0));
            // SAFETY: `block` is a live block of `layout.size()` bytes that
            // only this test holds; `zeroed` is not used past this point.
            unsafe { ptr::write_bytes(block, 0xa5, layout.size()) };
            // SAFETY: `block` was allocated in this iteration with `layout` and
            // is not used again.
            unsafe { ALLOCATOR.dealloc(block, layout) };
        }
        // SAFETY: the layout has a nonzero size; an allocation the heap cannot
        // satisfy returns null and touches nothing.
        let whole = unsafe { ALLOCATOR.alloc(Layout::from_size_align(HEAP_BYTES, 16).unwrap()) };
        assert!(whole.is_null());
    }
}
