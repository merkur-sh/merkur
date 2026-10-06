//! Ignored profiles for the colour and varint kernels on the display encode
//! and apply paths.
//!
//! `indexed_color_for` runs once per non-default colour of every encoded run
//! (`encode_color`), `resolve_color` on every colour change in daemon capture
//! and browser row hashing, `encode_varint_u32` once per run codepoint and run
//! length, and `decode_varint_u32` once per run in the browser's cell
//! iterator. Each profile drives the production function over a deterministic
//! input class, checks the result against an independent oracle, and reports
//! allocator requests and median/p95 nanoseconds per call.
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

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

// SAFETY: every method forwards the caller's layout and pointer unchanged to
// the system allocator; counting touches only atomics.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record();
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record();
        // SAFETY: the caller's `layout` reaches `System` unchanged, so the
        // caller's obligations are exactly `System`'s.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: every block this allocator hands out is `System`'s, so
        // `pointer` and `layout` name a block `System` allocated.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record();
        // SAFETY: `pointer` and `layout` name a block `System` allocated, and
        // the caller's new size reaches it unchanged.
        unsafe { System.realloc(pointer, layout, size) }
    }
}

fn record() {
    if COUNTING.load(Ordering::Relaxed) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    }
}

fn count_allocations(run: impl FnOnce()) -> usize {
    ALLOCATIONS.store(0, Ordering::Relaxed);
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
