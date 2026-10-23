
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Tally {
    pub(crate) allocations: usize,
    pub(crate) allocated_bytes: usize,
}

struct CountingAllocator;

static ENABLED: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);
thread_local! {
    static THREAD_TALLY: Cell<Option<Tally>> = const { Cell::new(None) };
}

fn record(bytes: usize) {
    if ENABLED.load(Ordering::Relaxed) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(bytes, Ordering::Relaxed);
    }
    // Const TLS requires neither allocation nor a destructor. `try_with`
    // also lets allocations during thread teardown bypass a retired slot.
    THREAD_TALLY
        .try_with(|slot| {
            if let Some(mut tally) = slot.get() {
                tally.allocations += 1;
                tally.allocated_bytes += bytes;
                slot.set(Some(tally));
            }
        })
        .unwrap_or(());
}

#[global_allocator]
static TEST_ALLOCATOR: CountingAllocator = CountingAllocator;

// SAFETY: every method hands its arguments unchanged to `System` and
// returns `System`'s answer, so `System`'s own `GlobalAlloc` guarantees
// hold. `record` only bumps atomics and a const thread-local `Cell`, so it
// never re-enters the allocator, and it could unwind only by overflowing a
// `usize` tally, which one test's allocations cannot reach.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: this wrapper forwards the allocator contract and layout
        // unchanged to the process system allocator.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: this wrapper forwards the allocator contract and layout
        // unchanged to the process system allocator.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            record(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: `pointer` and `layout` came from the forwarded system
        // allocator and are returned without modification.
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: this wrapper forwards the original allocation identity,
        // layout, and requested size unchanged to the system allocator.
        let next = unsafe { System.realloc(pointer, layout, new_size) };
        if !next.is_null() {
            record(new_size);
        }
        next
    }
}

pub(crate) fn begin_thread() {
    THREAD_TALLY.with(|slot| {
        assert!(
            slot.replace(Some(Tally {
                allocations: 0,
                allocated_bytes: 0
            }))
            .is_none()
        );
    });
}

pub(crate) fn end_thread() -> Tally {
    THREAD_TALLY.with(|slot| {
        slot.replace(None)
            .expect("thread allocation scope is active")
    })
}
