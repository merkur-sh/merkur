//! Ignored profiles for colour, varint and prepared-row kernels on the display
//! encode and apply paths.
//!
//! `indexed_color_for` runs once per non-default colour of every encoded run
//! (`encode_color`), `resolve_color` on every colour change in daemon capture
//! and browser row hashing, `encode_varint_u32` once per run codepoint and run
//! length, and `decode_varint_u32` once per run in the browser's cell
//! iterator. Each profile drives the production function over a deterministic
//! input class, checks the result against an independent oracle, and reports
//! allocator requests and timings. The prepared-row profile also reports
//! hardware instructions, with both unprepared encoders as null controls.
//!
//! Run with:
//! `cargo test --release --locked -p merkur-codec --test kernel_profile -- --ignored --nocapture --test-threads=1`

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use merkur_codec::{
    INDEXED_COLOR_TABLE, decode_varint_u32, encode_varint_u32, indexed_color_for, named_color,
    resolve_color,
};

struct CountingAllocator;

static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);
static FREED_BYTES: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

// SAFETY: every method forwards the caller's layout and pointer unchanged to
// the system allocator; counting touches only atomics.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if COUNTING.load(Ordering::Relaxed) {
            FREED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        // SAFETY: every block this allocator hands out is `System`'s, so
        // `pointer` and `layout` name a block `System` allocated.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        if COUNTING.load(Ordering::Relaxed) {
            FREED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        // SAFETY: `pointer` and `layout` name a block `System` allocated, and
        // the caller's new size reaches it unchanged.
        unsafe { System.realloc(pointer, layout, size) }
    }
}

fn record(bytes: usize) {
    if COUNTING.load(Ordering::Relaxed) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(bytes, Ordering::Relaxed);
    }
}

fn count_allocations(run: impl FnOnce()) -> usize {
    ALLOCATIONS.store(0, Ordering::Relaxed);
    ALLOCATED_BYTES.store(0, Ordering::Relaxed);
    FREED_BYTES.store(0, Ordering::Relaxed);
    COUNTING.store(true, Ordering::SeqCst);
    run();
    COUNTING.store(false, Ordering::SeqCst);
    ALLOCATIONS.load(Ordering::Relaxed)
}

const SAMPLES: usize = 301;

/// Median and p95 nanoseconds per element over `SAMPLES` passes of `run`,
/// which processes `per_pass` elements.
fn time_per_element(per_pass: usize, mut run: impl FnMut() -> u64) -> (f64, f64) {
    for _ in 0..16 {
        black_box(run());
    }
    let mut samples: Vec<f64> = (0..SAMPLES)
        .map(|_| {
            let start = Instant::now();
            black_box(run());
            start.elapsed().as_nanos() as f64 / per_pass as f64
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    (
        samples[samples.len() / 2],
        samples[(samples.len() * 95) / 100],
    )
}

fn lcg(seed: u64) -> impl FnMut() -> u32 {
    let mut state = seed;
    move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as u32
    }
}

mod prepared_rows {
    use super::*;
    use merkur_codec::{
        CellRepr, FrameHeader, FrameKind, PreparedGraphics, PreparedRowRef, RowRef,
        encode_frame_into, encode_prepared_frame_into, plan_cell_encoding, try_encode_frame_into,
    };

    fn header(cols: u16) -> FrameHeader {
        FrameHeader {
            kind: FrameKind::Delta,
            memory_only: false,
            cols,
            rows: 40,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 0,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: 1,
            frame_id: 12,
            presentation_id: 9,
            presentation_member_index: 0,
            presentation_member_count: 1,
            row_predecessor_presentation_id: 8,
            presentation_coherent: true,
            presentation_end: true,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            scroll_serial: 0,
            echo_horizon: 0,
        }
    }

    fn cells(len: u16, pattern: &str) -> Vec<CellRepr> {
        (0..len)
            .map(|i| CellRepr {
                codepoint: match pattern {
                    "blank" => 32,
                    "unicode" => 0x4e00 + u32::from(i % 90),
                    _ => 33 + u32::from(i % 90),
                },
                fg: if pattern == "rgb" {
                    let [red, _] = (i % 255).to_le_bytes();
                    [0x12, 0x34, red]
                } else {
                    CellRepr::BLANK.fg
                },
                link: u32::from(
                    pattern == "linked-all"
                        || (pattern == "linked-first" && i == 0)
                        || (pattern == "linked-last" && i + 1 == len),
                ),
                ..CellRepr::BLANK
            })
            .collect()
    }

    const PATTERNS: [&str; 7] = [
        "blank",
        "text",
        "rgb",
        "unicode",
        "linked-first",
        "linked-last",
        "linked-all",
    ];

    #[test]
    fn prepared_row_headers_match_unprepared() {
        for len in [1, 8, 120, 384] {
            for pattern in PATTERNS {
                let cells = cells(len, pattern);
                let graphics = PreparedGraphics::default();
                let header = header(len + 7);
                let mut prepared = Vec::new();
                let mut unprepared = Vec::new();
                let mut validated = Vec::new();
                let row = RowRef {
                    row_index: 3,
                    left: 7,
                    cells: &cells,
                    graphics: &[],
                };
                encode_frame_into(&mut unprepared, &header, std::iter::once(row));
                try_encode_frame_into(&mut validated, &header, std::iter::once(row)).unwrap();
                encode_prepared_frame_into(
                    &mut prepared,
                    &header,
                    std::iter::once(PreparedRowRef {
                        row_index: row.row_index,
                        left: row.left,
                        cells: &cells,
                        encoding: plan_cell_encoding(&cells).1,
                        graphics: &graphics,
                    }),
                );
                assert_eq!(prepared, unprepared, "{len} {pattern}");
                assert_eq!(prepared, validated, "{len} {pattern}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn instructions() -> u64 {
        unsafe extern "C" {
            fn syscall(number: i32, ...) -> i32;
        }
        let mut counts = [0u64; 2];
        // SAFETY: SYS_thread_selfcounts flavor 1 writes two u64 counters into
        // the supplied 16-byte buffer on the current thread.
        let result = unsafe { syscall(186, 1i32, counts.as_mut_ptr(), 16usize) };
        assert_eq!(result, 0);
        counts[0]
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "hardware instruction profile; release, --ignored --nocapture --test-threads=1"]
    fn prepared_row_header_profile() {
        let rounds = std::env::var("ROW_HEADER_ROUNDS")
            .map_or(65_536, |value| value.parse::<u32>().unwrap());
        let selected = std::env::var("ROW_HEADER_CASE").ok();
        for len in [1, 8, 120, 384] {
            for pattern in PATTERNS {
                if selected
                    .as_ref()
                    .is_some_and(|case| *case != format!("{len}:{pattern}"))
                {
                    continue;
                }
                let cells = cells(len, pattern);
                let graphics = PreparedGraphics::default();
                let header = header(len);
                let entry = PreparedRowRef {
                    row_index: 0,
                    left: 0,
                    cells: &cells,
                    encoding: plan_cell_encoding(&cells).1,
                    graphics: &graphics,
                };
                let mut out = Vec::with_capacity(8192);
                for sample in 0..4 {
                    for kind in if sample % 2 == 0 {
                        [0, 1, 2]
                    } else {
                        [2, 1, 0]
                    } {
                        let mut run = || {
                            for _ in 0..rounds {
                                let out = black_box(&mut out);
                                let header = black_box(&header);
                                if kind == 0 {
                                    encode_prepared_frame_into(out, header, std::iter::once(entry));
                                } else {
                                    let row = RowRef {
                                        row_index: 0,
                                        left: 0,
                                        cells: &cells,
                                        graphics: &[],
                                    };
                                    if kind == 1 {
                                        encode_frame_into(out, header, std::iter::once(row));
                                    } else {
                                        try_encode_frame_into(out, header, std::iter::once(row))
                                            .unwrap();
                                    }
                                }
                                black_box(out);
                            }
                        };
                        run();
                        let started = Instant::now();
                        let before = instructions();
                        run();
                        let retired = instructions() - before;
                        let nanos = started.elapsed().as_nanos() as f64 / f64::from(rounds);
                        let allocations = count_allocations(run);
                        println!(
                            "ROW_HEADER len={len} pattern={pattern} sample={sample} kind={kind} instructions={:.4} ns={nanos:.4} allocations={allocations} capacity={} bytes={}",
                            retired as f64 / f64::from(rounds),
                            out.capacity(),
                            out.len(),
                        );
                    }
                }
            }
        }
    }

    fn mz_frame(
        encoder: &mut merkur_codec::mz::MzEncoder,
        raw: &mut Vec<u8>,
        coded: &mut Vec<u8>,
        header: &FrameHeader,
        cells: &[CellRepr],
        graphics: &PreparedGraphics,
    ) -> Option<merkur_codec::mz::MzEncoded> {
        let encoding = plan_cell_encoding(cells).1;
        let metadata = encoder.encode_prepared_frame_into(
            raw,
            header,
            (0..header.row_count).map(|row_index| PreparedRowRef {
                row_index,
                left: 0,
                cells,
                encoding,
                graphics,
            }),
        );
        coded.clear();
        encoder.encode_prepared(
            raw.get(merkur_codec::STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES..)?,
            metadata,
            &merkur_codec::mz::NoHistory,
            None,
            None,
            coded,
        )
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "release MZ storage and instruction profile; --ignored --nocapture --test-threads=1"]
    fn mz_frame_items_profile() {
        use std::hash::Hasher;
        for (rows, width, pattern) in [
            (1, 1, "text"),
            (1, 8, "text"),
            (1, 120, "blank"),
            (39, 120, "text"),
            (39, 120, "rgb"),
            (39, 120, "unicode"),
            (39, 120, "linked-all"),
        ] {
            let cells = cells(width, pattern);
            let graphics = PreparedGraphics::default();
            let mut header = header(width);
            header.row_count = rows;
            // Initialize the process-wide static prior before cold ownership accounting.
            mz_frame(
                &mut Default::default(),
                &mut Vec::new(),
                &mut Vec::new(),
                &header,
                &cells,
                &graphics,
            )
            .unwrap();
            ALLOCATIONS.store(0, Ordering::Relaxed);
            ALLOCATED_BYTES.store(0, Ordering::Relaxed);
            FREED_BYTES.store(0, Ordering::Relaxed);
            COUNTING.store(true, Ordering::SeqCst);
            let mut encoder = merkur_codec::mz::MzEncoder::default();
            let mut raw = Vec::new();
            let mut coded = Vec::new();
            for _ in 0..8 {
                mz_frame(
                    &mut encoder,
                    &mut raw,
                    &mut coded,
                    &header,
                    &cells,
                    &graphics,
                )
                .unwrap();
            }
            COUNTING.store(false, Ordering::SeqCst);
            let allocated = ALLOCATED_BYTES.load(Ordering::Relaxed);
            let freed = FREED_BYTES.load(Ordering::Relaxed);
            assert!(allocated >= freed);
            let retained = allocated - freed;
            let cold_allocations = ALLOCATIONS.load(Ordering::Relaxed);
            let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
            fingerprint.write(&raw);
            fingerprint.write(&coded);
            let rounds = if rows == 1 { 65_536 } else { 512 };
            let before = instructions();
            for _ in 0..rounds {
                black_box(
                    mz_frame(
                        &mut encoder,
                        &mut raw,
                        &mut coded,
                        &header,
                        &cells,
                        &graphics,
                    )
                    .unwrap(),
                );
            }
            let retired = instructions() - before;
            let warm_allocations = count_allocations(|| {
                for _ in 0..rounds {
                    black_box(
                        mz_frame(
                            &mut encoder,
                            &mut raw,
                            &mut coded,
                            &header,
                            &cells,
                            &graphics,
                        )
                        .unwrap(),
                    );
                }
            });
            println!(
                "MZ_STORAGE rows={rows} width={width} pattern={pattern} instructions={} cold_allocations={cold_allocations} retained={retained} warm_allocations={warm_allocations} raw={} coded={} fingerprint={:016x}",
                retired as f64 / f64::from(rounds),
                raw.len(),
                coded.len(),
                fingerprint.finish(),
            );
        }
    }
}

/// The first palette slot producing `color`, by exhaustive search.
fn oracle_index(color: [u8; 3]) -> Option<u8> {
    INDEXED_COLOR_TABLE
        .iter()
        .position(|slot| *slot == color)
        .map(|index| index as u8)
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn indexed_color_profile() {
    const PER_CLASS: usize = 4096;
    let mut next = lcg(0xc0105);
    let classes: [(&str, Vec<[u8; 3]>); 4] = [
        // `ls`, `git diff`, prompts: the 16 ANSI slots, resolved to RGB.
        (
            "ansi16",
            (0..PER_CLASS)
                .map(|_| INDEXED_COLOR_TABLE[(next() % 16) as usize])
                .collect(),
        ),
        // 256-colour applications: the 6x6x6 cube.
        (
            "cube",
            (0..PER_CLASS)
                .map(|_| INDEXED_COLOR_TABLE[16 + (next() % 216) as usize])
                .collect(),
        ),
        (
            "gray",
            (0..PER_CLASS)
                .map(|_| INDEXED_COLOR_TABLE[232 + (next() % 24) as usize])
                .collect(),
        ),
        // Truecolour themes: almost never a palette colour, so the full scan.
        (
            "truecolor",
            (0..PER_CLASS)
                .map(|_| {
                    let rgb = next();
                    [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8]
                })
                .collect(),
        ),
    ];
    println!("indexed_color_profile: production indexed_color_for, {SAMPLES} passes");
    println!("class       calls  hits  allocs  median_ns_per_call  p95_ns_per_call");
    for (label, colors) in &classes {
        let mut hits = 0usize;
        for color in colors {
            let index = indexed_color_for(*color);
            if let Some(index) = index {
                assert_eq!(INDEXED_COLOR_TABLE[usize::from(index)], *color);
                hits += 1;
            }
            assert_eq!(index.is_some(), oracle_index(*color).is_some(), "{color:?}");
        }
        let allocations = count_allocations(|| {
            for color in colors {
                black_box(indexed_color_for(black_box(*color)));
            }
        });
        let (median, p95) = time_per_element(colors.len(), || {
            let mut sum = 0u64;
            for color in black_box(colors) {
                sum += u64::from(indexed_color_for(*color).unwrap_or(0));
            }
            sum
        });
        println!(
            "{label:<10} {:>6} {hits:>5} {allocations:>7} {median:>19.2} {p95:>16.2}",
            colors.len()
        );
    }
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn resolve_color_profile() {
    const COLORS: usize = 4096;
    const NAMED: [NamedColor; 8] = [
        NamedColor::Foreground,
        NamedColor::Background,
        NamedColor::Red,
        NamedColor::BrightBlue,
        NamedColor::DimGreen,
        NamedColor::Cursor,
        NamedColor::BrightWhite,
        NamedColor::DimForeground,
    ];
    let mut next = lcg(0xc010);
    // What the browser's row geometry resolves per cell: a default cell keeps
    // `Named(Foreground)`, a coloured one holds `Spec`, in runs.
    let mut row_runs = Vec::with_capacity(COLORS);
    while row_runs.len() < COLORS {
        let (color, run) = if next().is_multiple_of(7) {
            let rgb = next();
            (
                Color::Spec(Rgb {
                    r: (rgb >> 16) as u8,
                    g: (rgb >> 8) as u8,
                    b: rgb as u8,
                }),
                1 + next() % 8,
            )
        } else {
            (Color::Named(NamedColor::Foreground), 1 + next() % 40)
        };
        row_runs.extend(std::iter::repeat_n(color, run as usize));
    }
    row_runs.truncate(COLORS);
    let classes: [(&str, Vec<Color>); 4] = [
        ("row-runs", row_runs),
        (
            "named",
            (0..COLORS)
                .map(|_| Color::Named(NAMED[(next() % 8) as usize]))
                .collect(),
        ),
        (
            "indexed",
            (0..COLORS).map(|_| Color::Indexed(next() as u8)).collect(),
        ),
        (
            "spec",
            (0..COLORS)
                .map(|_| {
                    let rgb = next();
                    Color::Spec(Rgb {
                        r: (rgb >> 16) as u8,
                        g: (rgb >> 8) as u8,
                        b: rgb as u8,
                    })
                })
                .collect(),
        ),
    ];
    println!("resolve_color_profile: production resolve_color, {SAMPLES} passes");
    println!("class     calls  allocs  median_ns_per_call  p95_ns_per_call");
    for (label, colors) in &classes {
        for color in colors {
            let expected = match *color {
                Color::Spec(Rgb { r, g, b }) => [r, g, b],
                Color::Indexed(index) => INDEXED_COLOR_TABLE[usize::from(index)],
                Color::Named(named) => named_color(named),
            };
            assert_eq!(resolve_color(*color), expected);
        }
        let allocations = count_allocations(|| {
            for color in colors {
                black_box(resolve_color(black_box(*color)));
            }
        });
        let (median, p95) = time_per_element(colors.len(), || {
            let mut sum = 0u64;
            for color in black_box(colors) {
                let [r, g, b] = resolve_color(*color);
                sum += u64::from(r) + u64::from(g) + u64::from(b);
            }
            sum
        });
        println!(
            "{label:<8} {:>6} {allocations:>7} {median:>19.2} {p95:>16.2}",
            colors.len()
        );
    }
}

#[test]
#[ignore = "profile; run explicitly with --ignored --nocapture"]
fn varint_profile() {
    const VALUES: usize = 8192;
    let mut next = lcg(0x7a41);
    let classes: [(&str, Vec<u32>); 3] = [
        // Printable ASCII codepoints and short run lengths: one byte.
        (
            "1-byte",
            (0..VALUES).map(|_| 0x20 + next() % 0x5f).collect(),
        ),
        // Box drawing, Powerline, CJK: two or three bytes.
        (
            "bmp",
            (0..VALUES)
                .map(|_| {
                    [
                        0x2500 + next() % 0x80,
                        0xE0B0 + next() % 4,
                        0x4E00 + next() % 0x5000,
                    ][(next() % 3) as usize]
                })
                .collect(),
        ),
        // Emoji and other astral codepoints: three bytes.
        (
            "astral",
            (0..VALUES).map(|_| 0x1F300 + next() % 0x600).collect(),
        ),
    ];
    println!("varint_profile: production encode_varint_u32 / decode_varint_u32, {SAMPLES} passes");
    println!(
        "class    values  bytes  encode_allocs  encode_median  encode_p95  decode_median  decode_p95"
    );
    for (label, values) in &classes {
        let mut encoded = Vec::with_capacity(values.len() * 5);
        for value in values {
            encode_varint_u32(&mut encoded, *value);
        }
        let mut offset = 0usize;
        for value in values {
            assert_eq!(decode_varint_u32(&encoded, &mut offset), Ok(*value));
        }
        assert_eq!(offset, encoded.len());

        // The encoder's caller reserves nothing per value; a retained row
        // buffer is the production shape, so capacity is warmed first.
        let mut out = Vec::with_capacity(encoded.len());
        let allocations = count_allocations(|| {
            out.clear();
            for value in values {
                encode_varint_u32(&mut out, *value);
            }
        });
        let (encode_median, encode_p95) = time_per_element(values.len(), || {
            out.clear();
            for value in black_box(values) {
                encode_varint_u32(&mut out, *value);
            }
            out.len() as u64
        });
        let (decode_median, decode_p95) = time_per_element(values.len(), || {
            let mut offset = 0usize;
            let mut sum = 0u64;
            let bytes = black_box(&encoded);
            while offset < bytes.len() {
                sum += u64::from(decode_varint_u32(bytes, &mut offset).unwrap_or(0));
            }
            sum
        });
        println!(
            "{label:<8} {:>6} {:>6} {allocations:>14} {encode_median:>14.2} {encode_p95:>11.2} \
             {decode_median:>14.2} {decode_p95:>11.2}",
            values.len(),
            encoded.len()
        );
    }
}
