use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use merkur_graphics::command::Receiver;
use merkur_graphics::ingest::Ingest;
use vte::ansi::{Handler, Processor};

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    static LIVE_BYTES: Cell<isize> = const { Cell::new(0) };
}

struct CountAllocations;

// SAFETY: instrument only the calling test thread, with no allocating
// bookkeeping: three const thread-local `Cell`s. Each operation hands its
// pointer and layout unchanged to `System`, whose guarantees it returns.
unsafe impl GlobalAlloc for CountAllocations {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
            LIVE_BYTES.set(LIVE_BYTES.get() + layout.size() as isize);
        }
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACK.get() {
            ALLOCATIONS.set(ALLOCATIONS.get() + 1);
            LIVE_BYTES.set(LIVE_BYTES.get() + size as isize - layout.size() as isize);
        }
        // SAFETY: `ptr` and `layout` name a block `System` allocated, as every
        // block this allocator hands out is, and the caller's new size reaches
        // it unchanged.
        unsafe { System.realloc(ptr, layout, size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if TRACK.get() {
            LIVE_BYTES.set(LIVE_BYTES.get() - layout.size() as isize);
        }
        // SAFETY: every block this allocator hands out is `System`'s, so `ptr`
        // and `layout` name a block `System` allocated.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountAllocations = CountAllocations;

#[test]
fn maximum_source_commitment_allocates_no_pixel_copy_or_hash_storage() {
    use merkur_graphics::processing::{MAX_RGBA_BYTES, Pixels};
    use merkur_graphics::source::SourceManifest;
    let pixels = Pixels::new(4096, 4096, vec![127; MAX_RGBA_BYTES].into()).unwrap();
    ALLOCATIONS.set(0);
    LIVE_BYTES.set(0);
    TRACK.set(true);
    let manifest = SourceManifest::from_pixels(&pixels);
    let decoded = SourceManifest::decode(manifest.encode()).unwrap();
    TRACK.set(false);
    assert_eq!(manifest, decoded);
    assert_eq!(ALLOCATIONS.get(), 0);
    assert_eq!(LIVE_BYTES.get(), 0);
}

#[test]
fn immutable_graphics_rows_charge_actual_storage_and_reuse_unchanged_captures() {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::geometry::{CELL_UNIT, CellMetrics, PIXEL_UNIT};
    use merkur_graphics::placements::{Layout as PlacementLayout, Position};
    use merkur_graphics::projection::{
        Content, Fragment, MAX_ROW_FRAGMENTS, PlacementProjection, RowFragments, Stack,
        retained_usage,
    };
    let content = Content {
        kind: merkur_graphics::projection::ContentKind::Image,
        root: [0; 32],
        width: 64,
        height: 64,
    };
    let geometry = PlacementLayout {
        columns: 8,
        rows: 4,
        ..PlacementLayout::default()
    }
    .geometry(
        64,
        64,
        CellMetrics::new(8 * PIXEL_UNIT, 16 * PIXEL_UNIT).unwrap(),
    )
    .unwrap()
    .unwrap();
    let projection = PlacementProjection {
        content,
        stack: Stack {
            z: 0,
            image_id: 1,
            placement: 1,
        },
        geometry,
        position: Position { column: 0, line: 0 },
        clip: None,
    };
    let (_, first) = projection.rows(80, 24).unwrap().next().unwrap();
    let fragments: Vec<_> = (1..=MAX_ROW_FRAGMENTS)
        .map(|id| Fragment {
            stack: Stack {
                placement: id as u64,
                ..first.stack
            },
            ..first
        })
        .collect();
    let charge = retained_usage(fragments.len()).unwrap();
    let budget = Budget::new(Usage {
        bytes: charge.bytes,
        objects: charge.objects,
    });
    // Darwin initializes the budget's OS mutex lazily (64 bytes). That is
    // budget-domain storage, outside the row's two owned allocations.
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    let mut row = RowFragments::default();
    ALLOCATIONS.set(0);
    LIVE_BYTES.set(0);
    TRACK.set(true);
    row.replace(&budget, 80, &fragments).unwrap();
    TRACK.set(false);
    assert_eq!(
        (ALLOCATIONS.get(), LIVE_BYTES.get()),
        (charge.objects, charge.bytes as isize)
    );
    assert_eq!(budget.used(), Some(charge));

    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..1000 {
        assert!(!row.replace(&budget, 80, &fragments).unwrap());
        let sent = row.clone();
        let repair = sent.clone();
        assert!(row.same(&repair));
        assert!(row.intersects_cells(0, 1));
        for (_, fragment) in projection.rows(80, 24).unwrap() {
            assert_eq!(fragment.slice.bottom, CELL_UNIT);
            let bytes = fragment.encode();
            std::hint::black_box(Fragment::decode(&bytes, 80).unwrap());
        }
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
    assert_eq!(LIVE_BYTES.get(), charge.bytes as isize);
    TRACK.set(true);
    row.replace(&budget, 80, &[]).unwrap();
    for _ in 0..1000 {
        assert!(!row.replace(&budget, 80, &[]).unwrap());
        assert!(!row.clone().intersects_cells(0, 80));
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
    assert_eq!(LIVE_BYTES.get(), 0);
}

struct Owner {
    receiver: Receiver,
    ingest: Ingest,
    printable: usize,
}

impl Handler for Owner {
    fn input_str(&mut self, text: &str) {
        self.printable += text.len();
    }
    fn apc_start(&mut self) {
        self.receiver.start();
    }
    fn apc_put(&mut self, bytes: &[u8]) {
        self.receiver.push(bytes);
    }
    fn apc_end(&mut self, complete: bool) {
        std::hint::black_box(self.ingest.accept(self.receiver.finish(complete)));
    }
}

#[test]
fn warm_text_and_bounded_ingestion_have_no_allocations() {
    let mut owner = Owner {
        receiver: Receiver::default(),
        ingest: Ingest::new(8192),
        printable: 0,
    };
    let mut parser = Processor::<vte::ansi::StdSyncHandler>::new();
    TRACK.set(true);
    for _ in 0..1000 {
        parser.advance(&mut owner, b"plain terminal text\r\n");
        parser.advance(&mut owner, b"\x1b_Gf=100,m=1;AAAA\x1b\\");
        parser.advance(&mut owner, b"\x1b_Gm=0;BBBB\x1b\\");
        owner.ingest.cancel();
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
    assert_eq!(owner.printable, 19_000);
}

#[test]
fn geometry_and_placeholder_projection_allocate_nothing() {
    use merkur_graphics::geometry::{CELL_UNIT, CellMetrics, CellRect, Geometry, PIXEL_UNIT};
    use merkur_graphics::placeholder::{Color, PLACEHOLDER, RowDecoder};

    let metrics = CellMetrics::new(8 * PIXEL_UNIT, 16 * PIXEL_UNIT).unwrap();
    let geometry = Geometry::virtual_placement(101, 71, 80, 24, metrics).unwrap();
    let unit = i128::from(CELL_UNIT);
    let clip = CellRect::fixed(2 * unit + unit / 3, unit / 2, 75 * unit, 23 * unit).unwrap();
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..1000 {
        let mut row = RowDecoder::default();
        for column in 0..80 {
            std::hint::black_box(row.cell(PLACEHOLDER, &[], Color::Indexed(42), Color::Default));
            std::hint::black_box(geometry.project_cell(column, 12, column, 80));
            std::hint::black_box(geometry.project_row_clipped(0, 0, 80, 12, clip));
        }
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn aggregate_reservation_and_refund_allocate_nothing() {
    use merkur_graphics::budget::{Aggregate, Usage};
    let limit = Usage {
        bytes: 10,
        objects: 1,
    };
    let aggregate = Aggregate::new(limit);
    let budget = aggregate.partition(limit);
    drop(budget.reserve(limit).unwrap());
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..1000 {
        let mut lease = budget.reserve(limit).unwrap();
        assert!(budget.reserve(limit).is_none());
        assert!(lease.shrink(Usage {
            bytes: 3,
            objects: 1
        }));
        drop(lease);
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
    assert_eq!(
        aggregate.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[test]
fn maximum_depth_relative_projection_allocates_nothing() {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::placements::Layout as PlacementLayout;
    use merkur_graphics::placements::{
        AnchorId, MAX_DEPENDENCY_DEPTH, Origin, PLACEMENT_METADATA_BYTES, Placements, Position,
    };
    use merkur_graphics::publication::ImageIncarnation;
    use std::num::NonZeroU64;
    let mut placements = Placements::new(Budget::new(Usage {
        bytes: MAX_DEPENDENCY_DEPTH * PLACEMENT_METADATA_BYTES,
        objects: MAX_DEPENDENCY_DEPTH,
    }));
    let one = NonZeroU64::new(1).unwrap();
    let mut parent = placements
        .put(
            ImageIncarnation(one),
            1,
            Origin::Direct(AnchorId(one)),
            PlacementLayout::default(),
        )
        .unwrap();
    for id in 2..=MAX_DEPENDENCY_DEPTH {
        parent = placements
            .put(
                ImageIncarnation(NonZeroU64::new(id as u64).unwrap()),
                1,
                Origin::Relative {
                    parent,
                    columns: -1,
                    rows: 1,
                },
                PlacementLayout::default(),
            )
            .unwrap();
    }
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..1000 {
        let point = placements
            .position(
                parent,
                |_| {
                    Some(Position {
                        column: 100,
                        line: -100,
                    })
                },
                |_| None,
            )
            .unwrap();
        assert_eq!(
            point,
            Position {
                column: 101 - MAX_DEPENDENCY_DEPTH as i64,
                line: MAX_DEPENDENCY_DEPTH as i64 - 101
            }
        );
        std::hint::black_box(point);
    }
    TRACK.set(false);
    assert_eq!(ALLOCATIONS.get(), 0);
}

#[test]
fn maximum_depth_and_width_retirement_allocates_nothing() {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::placements::{
        AnchorId, Layout as PlacementLayout, MAX_DEPENDENCY_DEPTH, Origin,
        PLACEMENT_METADATA_BYTES, Placements,
    };
    use merkur_graphics::publication::ImageIncarnation;
    use std::num::NonZeroU64;

    const COUNT: usize = 8192;
    let budget = Budget::new(Usage {
        bytes: COUNT * PLACEMENT_METADATA_BYTES,
        objects: COUNT,
    });
    let mut placements = Placements::new(budget.clone());
    let image = ImageIncarnation(NonZeroU64::new(1).unwrap());
    let root = placements
        .put(
            image,
            1,
            Origin::Direct(AnchorId(image.0)),
            PlacementLayout::default(),
        )
        .unwrap();
    let mut parent = root;
    for id in 2..=COUNT {
        let child = placements
            .put(
                image,
                id as u32,
                Origin::Relative {
                    parent,
                    columns: 0,
                    rows: 0,
                },
                PlacementLayout::default(),
            )
            .unwrap();
        parent = if id < MAX_DEPENDENCY_DEPTH {
            child
        } else {
            root
        };
    }
    ALLOCATIONS.set(0);
    TRACK.set(true);
    for _ in 0..10 {
        placements.invalidate(root);
    }
    let mut count = 0;
    placements.remove(root, |removed, image_has_placements| {
        count += 1;
        assert_eq!(removed.image, image);
        assert_eq!(image_has_placements, count != COUNT);
    });
    TRACK.set(false);
    assert_eq!(count, COUNT);
    assert_eq!(ALLOCATIONS.get(), 0);
    assert_eq!(
        budget.used().unwrap(),
        Usage {
            bytes: 0,
            objects: 0
        }
    );
    assert!(placements.is_empty());
    assert!(placements.take_dirty().is_empty());
    assert_eq!(placements.anchored(AnchorId(image.0)).count(), 0);
    assert_eq!(placements.image_placements(image).count(), 0);
}

#[test]
fn sparse_placement_storage_stays_within_live_and_retired_reservations() {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::placements::{
        AnchorId, Layout, Origin, PLACEMENT_METADATA_BYTES, Placements,
    };
    use merkur_graphics::publication::ImageIncarnation;
    use std::num::NonZeroU64;

    let budget = Budget::new(Usage {
        bytes: 128 * PLACEMENT_METADATA_BYTES,
        objects: 128,
    });
    let mut placements = Placements::new(budget.clone());
    let mut ids = Vec::with_capacity(128);
    // Mutex poison bookkeeping initializes Rust's per-thread descriptor once;
    // that runtime allocation is not storage owned by the graphics model.
    let warm = budget
        .reserve(Usage {
            bytes: 1,
            objects: 1,
        })
        .unwrap();
    drop(warm);
    LIVE_BYTES.set(0);
    TRACK.set(true);
    for n in 1..=128 {
        let identity = NonZeroU64::new(n).unwrap();
        ids.push(
            placements
                .put(
                    ImageIncarnation(identity),
                    1,
                    Origin::Direct(AnchorId(identity)),
                    Layout::default(),
                )
                .unwrap(),
        );
        assert!(LIVE_BYTES.get() as usize <= budget.used().unwrap().bytes);
    }
    while let Some(id) = ids.pop() {
        let mut retired = None;
        placements.remove(id, |placement, _| retired = Some(placement));
        assert!(LIVE_BYTES.get() as usize <= budget.used().unwrap().bytes);
        drop(retired);
        assert!(
            LIVE_BYTES.get() as usize <= budget.used().unwrap().bytes,
            "live {}, reserved {}, placements {}",
            LIVE_BYTES.get(),
            budget.used().unwrap().bytes,
            placements.len()
        );
    }
    assert_eq!(LIVE_BYTES.get(), 0);
    TRACK.set(false);
}

#[test]
fn sparse_image_storage_and_retained_roots_stay_within_reservations() {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::command::{Chunk, Control, Received};
    use merkur_graphics::ingest::Step;
    use merkur_graphics::publication::TerminalIncarnation;
    use merkur_graphics::scene::{IMAGE_METADATA_BYTES, Image, Published, Scene};

    struct AllocationImage(u8);
    impl merkur_graphics::scene::SceneContent for AllocationImage {
        fn descriptor(&self) -> merkur_graphics::projection::Content {
            merkur_graphics::projection::Content {
                kind: merkur_graphics::projection::ContentKind::Image,
                root: [self.0; 32],
                width: 1,
                height: 1,
            }
        }
        fn retire(&self) {}
    }
    let charge = IMAGE_METADATA_BYTES + std::mem::size_of::<Image<AllocationImage>>();
    let budget = Budget::new(Usage {
        bytes: 128 * charge,
        objects: 128,
    });
    let mut scene: Scene<AllocationImage> =
        Scene::new(TerminalIncarnation([1; 16]), budget.clone());
    let mut ingest = Ingest::new(4096);
    let mut roots = Vec::with_capacity(128);
    let control = Control::parse(b"I=1,s=1,v=1").unwrap();
    let warm = budget
        .reserve(Usage {
            bytes: 1,
            objects: 1,
        })
        .unwrap();
    drop(warm);
    LIVE_BYTES.set(0);
    TRACK.set(true);
    for index in 0..128 {
        let Step::Data { id, .. } = ingest.accept(Received::Chunk(Chunk {
            control,
            payload: b"AAAAAA==",
        })) else {
            panic!("data command")
        };
        let fence = scene.begin(id, &control).unwrap();
        let Published::Image { image, .. } = scene.publish(fence, AllocationImage(index)).unwrap()
        else {
            panic!("image publication")
        };
        roots.push(image);
        ingest.finish_validation(id);
        assert!(LIVE_BYTES.get() as usize <= budget.used().unwrap().bytes);
    }
    scene.clear();
    assert_eq!(budget.used().unwrap().objects, 128);
    assert!(LIVE_BYTES.get() as usize <= budget.used().unwrap().bytes);
    roots.clear();
    assert_eq!(LIVE_BYTES.get(), 0);
    assert_eq!(budget.used().unwrap().bytes, 0);
    TRACK.set(false);
}
