use merkur_graphics::{budget::Budget, processing::Pixels, tile::TILE_ENCODED_BYTES};
use merkur_image_worker::tile::Encoder;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    static BYTES: Cell<usize> = const { Cell::new(0) };
}

struct CountAllocations;

// SAFETY: bookkeeping is thread-local and does not allocate. Every pointer and
// layout is passed unchanged to the system allocator.
unsafe impl GlobalAlloc for CountAllocations {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
            BYTES.set(BYTES.get() + layout.size());
        }
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
            BYTES.set(BYTES.get() + size);
        }
        // SAFETY: `pointer` and `layout` name a block `System` allocated, as
        // every block this allocator hands out is, and the caller's new size
        // reaches it unchanged.
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: every block this allocator hands out is `System`'s, so
        // `pointer` and `layout` name a block `System` allocated.
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountAllocations = CountAllocations;

#[test]
fn admitted_context_allocations_fit_and_reused_encoding_allocates_nothing() {
    let budget = Budget::new(Encoder::charge());
    let lease = budget.reserve(Encoder::charge()).unwrap();
    TRACK.set(true);
    let mut encoder = Encoder::new(lease).unwrap();
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 3); // arena, scanlines and fixed mip rows
    assert!(BYTES.get() <= Encoder::charge().bytes);
    let source = Pixels::new(
        513,
        519,
        (0..513 * 519 * 4)
            .map(|i| (i * 37 + i / 89) as u8)
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    )
    .unwrap();
    let mut output = vec![0; TILE_ENCODED_BYTES];
    encoder.encode(&source, 0, 0, &mut output).unwrap();
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..8 {
        for y in 0..3 {
            for x in 0..3 {
                let (_, len) = encoder.encode(&source, x, y, &mut output).unwrap();
                assert!(len > 57 && len <= TILE_ENCODED_BYTES);
            }
        }
        for level in 1..=10 {
            let (_, len) = encoder
                .encode_level(&source, level, [0, 0], &mut output, || false)
                .unwrap();
            assert!(len > 57 && len <= TILE_ENCODED_BYTES);
        }
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[tokio::test]
async fn releasing_a_published_source_allocates_nothing_on_its_owner() {
    use merkur_graphics::{budget::Usage, command::Format, processing::DecodeRequest};
    use merkur_image_worker::{OUTPUT_METADATA_BYTES, Reservations, WORKSPACE_BYTES, Worker};
    let workspace = Budget::new(Usage {
        bytes: WORKSPACE_BYTES,
        objects: 1,
    });
    let charge = Usage {
        bytes: 4 + OUTPUT_METADATA_BYTES,
        objects: 1,
    };
    let storage = Budget::new(charge);
    let mut worker = Worker::launch(
        &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
        DecodeRequest {
            format: Format::Rgba,
            compressed: false,
            base64: true,
            width: 1,
            height: 1,
            inflated_bytes: 0,
        },
        Reservations {
            workspace: workspace
                .reserve(Usage {
                    bytes: WORKSPACE_BYTES,
                    objects: 1,
                })
                .unwrap(),
            output: storage.reserve(charge).unwrap(),
        },
    )
    .await
    .unwrap();
    worker.push(b"G1Hzfw==", true).await.unwrap();
    let image = worker.finish().await.unwrap();
    assert_eq!(image.pixels().rgba(), [27, 81, 243, 127]);
    ALLOCATIONS.set(0);
    TRACK.set(true);
    drop(image);
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
    merkur_image_worker::retirement::drain();
    assert_eq!(
        storage.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}
