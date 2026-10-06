use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use merkur_e2e::{
    CONTENT_CHUNK_BYTES, CONTENT_CHUNK_OVERHEAD, CONTENT_MAX_OBJECT_BYTES, ContentDescriptor,
    ContentRequests, NoiseHandshake, generate_static_keypair,
};

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

struct CountAllocations;

// SAFETY: observe this test thread only; the bookkeeping is two const
// thread-local `Cell`s, so it never allocates. Each operation delegates the
// unchanged pointer/layout contract to System.
unsafe impl GlobalAlloc for CountAllocations {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
        }
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
        }
        // SAFETY: `ptr` and `layout` name a block `System` allocated, as every
        // block this allocator hands out is, and the caller's new size reaches
        // it unchanged.
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: every block this allocator hands out is `System`'s, so `ptr`
        // and `layout` name a block `System` allocated.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountAllocations = CountAllocations;

#[test]
fn maximum_object_seals_opens_and_authenticates_duplicates_without_chunk_allocations() {
    let (a, _) = generate_static_keypair().unwrap();
    let (b, _) = generate_static_keypair().unwrap();
    let mut a = NoiseHandshake::new_initiator(&a, &[7; 32], b"content allocation proof").unwrap();
    let mut b = NoiseHandshake::new_responder(&b, &[7; 32], b"content allocation proof").unwrap();
    b.read_message(&a.write_message(&[]).unwrap()).unwrap();
    a.read_message(&b.write_message(&[]).unwrap()).unwrap();
    b.read_message(&a.write_message(&[]).unwrap()).unwrap();
    let mut a = a.into_transport().unwrap();
    let mut b = b.into_transport().unwrap();
    let chunks = CONTENT_MAX_OBJECT_BYTES / CONTENT_CHUNK_BYTES;
    let desc = ContentDescriptor::new(
        1,
        [1; 32],
        [2; 32],
        CONTENT_MAX_OBJECT_BYTES as u32,
        0,
        chunks as u32,
    )
    .unwrap();
    let mut sender = a.content_sender(desc).unwrap();
    let mut requests = ContentRequests::default();
    requests.range(desc).unwrap();
    let mut receiver = b.content_receiver(&mut requests, sender.header()).unwrap();
    let mut plaintext = vec![0; CONTENT_CHUNK_BYTES];
    let mut record = vec![0; CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD];
    let mut decoded = vec![0; CONTENT_CHUNK_BYTES + 16];
    ALLOCATIONS.set(0);
    TRACK.set(true);
    // Register/cancel itself remains allocation-free after the owner admits its
    // fixed table. Historical IDs are fenced by one scalar, not retained nodes.
    for request in 2..=1024 {
        requests.whole(request, [1; 32], 37).unwrap();
        assert!(requests.cancel(request));
    }
    for index in 0..chunks {
        plaintext.fill(index as u8);
        let len = sender.seal_next(&plaintext, &mut record).unwrap();
        let chunk = receiver.open_chunk(&record[..len], &mut decoded).unwrap();
        assert_eq!(chunk.object_index, index as u32);
        assert!(!chunk.duplicate);
        assert_eq!(&decoded[..chunk.len], plaintext);
        assert!(
            receiver
                .open_chunk(&record[..len], &mut decoded)
                .unwrap()
                .duplicate
        );
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}
