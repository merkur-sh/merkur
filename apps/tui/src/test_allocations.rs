use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Tally {
    pub allocations: usize,
    pub bytes: usize,
}

thread_local! {
    static TALLY: Cell<Option<Tally>> = const { Cell::new(None) };
}

struct CountingAllocator;
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn record(bytes: usize) {
    let _ = TALLY.try_with(|slot| {
        if let Some(mut tally) = slot.get() {
            tally.allocations += 1;
            tally.bytes += bytes;
            slot.set(Some(tally));
        }
    });
}

// SAFETY: every operation forwards System's allocation identity and layout unchanged.
// Recording uses const TLS without allocation or destructors.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller's layout reaches System unchanged.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller's layout reaches System unchanged.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        // SAFETY: pointer and layout identify System's block; size is forwarded unchanged.
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: every block returned by this allocator belongs to System.
        unsafe { System.dealloc(pointer, layout) }
    }
}

pub(crate) fn measure(run: impl FnOnce()) -> Tally {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TALLY.set(None);
        }
    }
    assert!(TALLY.replace(Some(Tally::default())).is_none());
    let reset = Reset;
    run();
    let tally = TALLY.get().expect("active allocation scope");
    drop(reset);
    tally
}
