//! Graphics rows converge under lost, duplicated and reordered display units.
//!
//! # Why this exists
//!
//! The graphics row wire rests on three rules, each pinned alone elsewhere: a
//! row entry carries its complete graphics replacement (an explicit empty set
//! included), a receiver applies a row only from a newer sequence, and the
//! daemon confirms a row only from the exact attempt a viewer acknowledged.
//! What no single test shows is the property they exist for, which
//! `proposals/kitty-graphics.md` §10 names: random terminal traces whose display
//! units are lost, duplicated and reordered still converge, including empty
//! replacements and graphics-only row changes, and nothing about images ever
//! costs a full display resync.
//!
//! This drives that property through the real send path ([`super::sim`]) and
//! the real receiver ([`super::viewer`]): a seeded trace of operations on the
//! daemon's `TerminalState`, with the owner loop running a random slice of
//! virtual time after each, so later operations overlap units still in flight.
//!
//! # Two graphics drivers
//!
//! - **Kitty commands**, through the image helper: uploads of small `f=32`
//!   images, placements with crops, offsets, scaling and z, relative
//!   placements, Unicode placeholders and every deletion selector, beside
//!   scrolls, resizes and the alternate screen. Decoded images exist only in
//!   that separately built, sandboxed helper, so these runs live in
//!   `real_helper`, the lane `bun run gates` runs after building it.
//! - **Projection publication**: the projector's output published directly,
//!   with the same row shapes: graphics-only moves, empty replacements,
//!   overlapping fragments, and rows past one datagram. It needs no decoded
//!   image, so it runs by default.
//!
//! # The oracle
//!
//! At every checkpoint the session settles and the receiver must hold exactly
//! the daemon's current projection: equal row hashes, which digest text, wrap,
//! links and the graphics descriptors, and a byte-equal graphics export. The
//! digest backstop, whenever due there, must ask for no row.
//!
//! And the receiver must never have needed a full display resync: no refusal
//! the terminal worker answers with one, and at every checkpoint no display
//! generation beyond the ones committed viewports started. Pixels never reach
//! a viewer in this harness, so every trace is one whose asset streams are
//! disturbed entirely; each seed's undisturbed run is the case where nothing
//! else is.

use std::panic::AssertUnwindSafe;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use merkur_codec::{GraphicsEncodeScratch, PreparedGraphics};
use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::geometry::{CELL_UNIT, CellMetrics, RowSlice};
use merkur_graphics::projection::{Content, ContentKind, Fragment, Stack};

use super::policy::DisplayPolicy;
use super::sim::{DisplaySim, sim_peer_id};
use super::viewer::{DisturbedUnits, SimViewers, UnitDisturbance, UnitDisturbanceTally};
use crate::pty::Viewport;

const START_COLS: u16 = 32;
const START_ROWS: u16 = 10;
/// Seven and a half by fifteen and a quarter pixels: 16.16 cell metrics with a
/// fraction on both axes, so placements land on fractional cell boundaries.
const CELL_WIDTH: u32 = 491_520;
const CELL_HEIGHT: u32 = 999_424;
/// Image ids the drivers draw from. Few, so ids are reused and replaced.
const IMAGES: u64 = 4;
/// Operations between settled comparisons.
const CHECKPOINT_EVERY: usize = 8;
/// Virtual time the owner loop runs after an operation: none, so operations
/// pile into one flush, up to several flush intervals, so units overlap them.
const SLICES_MS: [f64; 5] = [0.0, 1.0, 4.0, 16.0, 40.0];
/// Owner-loop wakes one slice may take before it counts as spinning.
const WAKE_CAP: usize = 4_096;
/// Virtual time a checkpoint may take to settle before that is the finding.
const SETTLE_BUDGET_MS: f64 = 30_000.0;
/// Stacking values spanning the three text-relative strata and both sides of
/// the negative boundary Kitty draws below cell backgrounds.
const Z_VALUES: [i32; 6] = [-1_073_741_825, -1_073_741_824, -2, -1, 0, 3];
/// Kitty's first row/column diacritics (`rowcolumn-diacritics.txt`), enough
/// to address every placeholder cell these traces write.
const DIACRITICS: [char; 8] = [
    '\u{305}', '\u{30d}', '\u{30e}', '\u{310}', '\u{312}', '\u{33d}', '\u{33e}', '\u{33f}',
];

fn disturbance(seed: u64) -> UnitDisturbance {
    UnitDisturbance {
        seed: seed ^ 0xD157_ABED,
        loss_pct: 20,
        duplicate_pct: 20,
        reorder_pct: 20,
    }
}

/// Splitmix64, the generator the simulator's own screens use, so a trace
/// replays from its seed on any host.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Driver {
    Kitty,
    Projection,
}

/// What a set of traces exercised, for the vacuity controls.
#[derive(Default)]
struct Outcome {
    graphics_operations: usize,
    resizes_with_graphics: usize,
    alternate_screen_switches: usize,
    checkpoints: usize,
    checkpoints_with_graphics: usize,
    digests_compared: usize,
    snapshots: usize,
    jumbo_rows: usize,
    recovered_by_fec: usize,
    disturbed: UnitDisturbanceTally,
}

impl Outcome {
    fn absorb(&mut self, other: Outcome) {
        let add = |total: &mut DisturbedUnits, run: DisturbedUnits| {
            total.units += run.units;
            total.graphics_only += run.graphics_only;
            total.empty_replacements += run.empty_replacements;
        };
        self.graphics_operations += other.graphics_operations;
        self.resizes_with_graphics += other.resizes_with_graphics;
        self.alternate_screen_switches += other.alternate_screen_switches;
        self.checkpoints += other.checkpoints;
        self.checkpoints_with_graphics += other.checkpoints_with_graphics;
        self.digests_compared += other.digests_compared;
        self.snapshots += other.snapshots;
        self.jumbo_rows += other.jumbo_rows;
        self.recovered_by_fec += other.recovered_by_fec;
        add(&mut self.disturbed.arrived, other.disturbed.arrived);
        add(&mut self.disturbed.lost, other.disturbed.lost);
        add(&mut self.disturbed.duplicated, other.disturbed.duplicated);
        add(&mut self.disturbed.reordered, other.disturbed.reordered);
    }
}

fn viewport(cols: u16, rows: u16, seq: u32) -> Viewport {
    let cell = CellMetrics::new(CELL_WIDTH, CELL_HEIGHT).expect("valid cell metrics");
    let extent = |count: u16, metric: u32| {
        u16::try_from((u64::from(count) * u64::from(metric) + (1 << 15)) >> 16)
            .expect("the viewport fits a PTY winsize")
    };
    Viewport {
        cols,
        rows,
        seq,
        geometry_generation: 1,
        cell: Some(cell),
        pixel_width: extent(cols, cell.width()),
        pixel_height: extent(rows, cell.height()),
    }
}

/// Run one seeded trace and check the oracle at every checkpoint.
async fn run_trace(
    driver: Driver,
    seed: u64,
    operations: usize,
    disturbance: Option<UnitDisturbance>,
) -> Outcome {
    let context = format!(
        "{driver:?} trace seed {seed:#x}, {} display units",
        if disturbance.is_some() {
            "disturbed"
        } else {
            "undisturbed"
        }
    );
    // Named before anything can fail: `settle` reports divergence without
    // knowing which trace it is settling.
    eprintln!("GRAPHICS_TRACE {context}");
    let mut rng = Rng(seed);
    let (mut cols, mut rows) = (START_COLS, START_ROWS);
    let mut sim = DisplaySim::new(cols, rows);
    if driver == Driver::Kitty {
        sim.use_built_image_worker();
    }
    let mut viewers = SimViewers::attach(&mut sim, cols, rows);
    if let Some(disturbance) = disturbance {
        viewers.disturb_display_units(disturbance);
    }
    let peer = sim_peer_id(0);
    let first_generation = sim.peer_generation(&peer);
    // A browser commits its viewport on attach; until then placements have
    // no pixel geometry.
    let mut commits = 1u32;
    sim.commit_viewport(viewport(cols, rows, commits));
    // Each commit owes the snapshot that starts a display generation, but
    // commits that land before it goes out share it, so a count of commits
    // leaves room for generations nothing owes. `owed_from` is the generation
    // the last owing commit found: while the daemon is still on it, that
    // snapshot has not gone out.
    let mut owed = 1u32;
    let mut owed_from = first_generation;

    let mut outcome = Outcome::default();
    let mut kitty = KittyModel::default();
    let mut sprites = Sprites::new();
    let mut alternate = false;
    let mut bytes = Vec::new();
    let mut export = Vec::new();
    for index in 0..operations {
        bytes.clear();
        let roll = rng.below(100);
        if roll < 8 {
            sim.graphics_export(&mut export);
            outcome.resizes_with_graphics += usize::from(!export.is_empty());
            cols = 20 + rng.below(21) as u16;
            rows = 6 + rng.below(7) as u16;
            // Off `owed_from`, the last owed snapshot went out: this commit
            // owes the next one.
            let generation = sim.peer_generation(&peer);
            if generation != owed_from {
                owed += 1;
                owed_from = generation;
            }
            commits += 1;
            sim.commit_viewport(viewport(cols, rows, commits));
            if driver == Driver::Projection {
                // The live projector re-projects inside the resize itself.
                sim.publish_graphics_projection(sprites.project(cols, rows));
            }
            viewers.resize(cols, rows);
        } else if roll < 13 {
            alternate = !alternate;
            outcome.alternate_screen_switches += 1;
            bytes.extend_from_slice(if alternate {
                b"\x1b[?1049h"
            } else {
                b"\x1b[?1049l"
            });
        } else if roll < 50 {
            text_operation(&mut rng, cols, rows, &mut bytes);
        } else {
            outcome.graphics_operations += 1;
            match driver {
                Driver::Kitty => kitty.operation(&mut rng, cols, rows, &mut bytes),
                Driver::Projection => {
                    sprites.operation(&mut rng, cols, rows);
                    sim.publish_graphics_projection(sprites.project(cols, rows));
                }
            }
        }
        if !bytes.is_empty() {
            sim.write_pty_resuming(&bytes).await;
        }
        let slice_ms = rng.pick(&SLICES_MS);
        if slice_ms > 0.0 {
            viewers.run_for_ms(&mut sim, slice_ms, WAKE_CAP).await;
        }
        if (index + 1) % CHECKPOINT_EVERY == 0 || index + 1 == operations {
            let at = format!("{context}, operation {index}");
            checkpoint(&mut sim, &mut viewers, &peer, &at, &mut outcome).await;
            // A settled daemon owes no snapshot, so every owed generation has
            // started and any other is a full display resync.
            assert!(
                !sim.snapshot_pending(&peer),
                "{at}: the daemon still owes a snapshot on a settled screen"
            );
            let generations = sim.peer_generation(&peer).wrapping_sub(first_generation);
            assert_eq!(
                generations, owed,
                "{at}: the daemon started {generations} display generations where {commits} \
                 committed viewports owe {owed}; any other is a full display resync"
            );
        }
    }

    let viewer = viewers.viewer(&peer);
    assert_eq!(
        viewer.display_resyncs, 0,
        "{context}: the receiver refused units the terminal worker answers with a full \
         display resync"
    );
    outcome.snapshots = viewer.snapshots_applied;
    outcome.jumbo_rows = viewer.reliable_deltas;
    outcome.recovered_by_fec = viewer.recovered_by_fec;
    outcome.disturbed = viewer.disturbed;
    if driver == Driver::Kitty {
        sim.shutdown_graphics().await;
    }
    outcome
}

/// Settle, then require the receiver to hold exactly the daemon's projection.
async fn checkpoint(
    sim: &mut DisplaySim,
    viewers: &mut SimViewers,
    peer: &str,
    context: &str,
    outcome: &mut Outcome,
) {
    viewers.settle(sim, peer, SETTLE_BUDGET_MS).await;
    let terminal = viewers.viewer(peer).terminal_mut();
    assert_eq!(
        (terminal.cols(), terminal.rows()),
        sim.terminal_dimensions(),
        "{context}: settled on other dimensions than the daemon's"
    );
    let mut daemon = Vec::new();
    let mut received = Vec::new();
    sim.graphics_export(&mut daemon);
    viewers.graphics_export(peer, &mut received);
    assert!(
        received == daemon,
        "{context}: every row hash agrees, yet the receiver presents {} graphics bytes \
         where the daemon projects {}",
        received.len(),
        daemon.len()
    );
    // The backstop must find nothing to repair on a settled screen: graphics
    // digests agree at both ends. Digests emitted before it settled describe
    // older grids, which a browser skips, so they go first. Quiet time then
    // makes a digest due with every row old enough to be in it; the parked
    // owner loop spends none of it.
    viewers.discard_digests();
    let digests = viewers.digests_seen();
    viewers
        .run_for_ms(
            sim,
            DisplayPolicy::HEARTBEAT_TIME_INTERVAL_MS.max(DisplayPolicy::DIGEST_ROW_SETTLE_MS),
            WAKE_CAP,
        )
        .await;
    sim.tick_heartbeat().await;
    viewers.pump(sim);
    assert_eq!(
        viewers.answer_digests(sim),
        0,
        "{context}: the hash digest found rows the settled receiver disagrees on"
    );
    outcome.digests_compared += viewers.digests_seen() - digests;
    outcome.checkpoints += 1;
    outcome.checkpoints_with_graphics += usize::from(!daemon.is_empty());
}

fn put(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(text.as_bytes());
}

/// Text that moves, erases and wraps rows, which is what makes placements
/// and placeholders move, clip and retire.
fn text_operation(rng: &mut Rng, cols: u16, rows: u16, out: &mut Vec<u8>) {
    let row = 1 + rng.below(u64::from(rows));
    let col = 1 + rng.below(u64::from(cols));
    let count = 1 + rng.below(3);
    match rng.below(9) {
        0 | 1 => {
            put(out, &format!("\x1b[{row};{col}H"));
            // Past the right margin half the time, so rows wrap.
            let length = 1 + rng.below(u64::from(cols) * 3 / 2);
            for _ in 0..length {
                out.push(b'a' + rng.below(26) as u8);
            }
        }
        2 => put(out, &format!("\x1b[{row};1H\x1b[2K")),
        3 => put(
            out,
            &format!("\x1b[{rows};1H{}", "\n".repeat(count as usize)),
        ),
        4 => put(out, &format!("\x1b[{count}S")),
        5 => put(out, &format!("\x1b[{count}T")),
        6 => put(
            out,
            &format!(
                "\x1b[{row};1H\x1b[{count}{}",
                if rng.chance(50) { 'L' } else { 'M' }
            ),
        ),
        7 => {
            let bottom = row + rng.below(u64::from(rows) - row + 1);
            put(out, &format!("\x1b[{row};{bottom}r\x1b[{count}S\x1b[r"));
        }
        _ => put(out, if rng.chance(50) { "\x1b[2J" } else { "\x1b[J" }),
    }
}

/// What the Kitty driver has asked for, so most commands name something that
/// exists. The terminal decides what actually happened; this only aims.
#[derive(Default)]
struct KittyModel {
    /// Transmitted source dimensions, by image id minus one.
    images: [Option<(u64, u64)>; IMAGES as usize],
    /// `(image, placement)` pairs placed and not yet deleted by id.
    placements: Vec<(u64, u64)>,
}

impl KittyModel {
    fn operation(&mut self, rng: &mut Rng, cols: u16, rows: u16, out: &mut Vec<u8>) {
        let image = 1 + rng.below(IMAGES);
        // Placements mostly name an image that was transmitted, so they land;
        // the rest exercise the refusal.
        let transmitted: Vec<u64> = (1..=IMAGES)
            .filter(|id| self.images[*id as usize - 1].is_some())
            .collect();
        let shown = if transmitted.is_empty() || rng.chance(10) {
            image
        } else {
            rng.pick(&transmitted)
        };
        // Under 256, so a placeholder's underline colour can select it.
        let placement = 1 + rng.below(200);
        put(
            out,
            &format!(
                "\x1b[{};{}H",
                1 + rng.below(u64::from(rows)),
                1 + rng.below(u64::from(cols))
            ),
        );
        match rng.below(10) {
            0..=2 => {
                let (width, height) = (1 + rng.below(16), 1 + rng.below(32));
                let pixels: Vec<u8> = (0..width * height * 4).map(|_| rng.next() as u8).collect();
                let payload = base64::engine::general_purpose::STANDARD.encode(pixels);
                // Transmit-and-place a third of the time.
                let place = if rng.chance(33) {
                    self.placements.push((image, placement));
                    format!("a=T,p={placement},C=1")
                } else {
                    String::from("a=t")
                };
                put(
                    out,
                    &format!(
                        "\x1b_G{place},f=32,s={width},v={height},i={image},q=2;{payload}\x1b\\"
                    ),
                );
                self.images[image as usize - 1] = Some((width, height));
            }
            3..=5 => {
                // Reusing a placement id moves it: with the text unchanged, a
                // graphics-only change on every row it leaves or enters.
                let (image, placement) = if !self.placements.is_empty() && rng.chance(40) {
                    rng.pick(&self.placements)
                } else {
                    self.placements.push((shown, placement));
                    (shown, placement)
                };
                let mut keys = format!("a=p,i={image},p={placement},C=1,q=2");
                if let Some((width, height)) = self.images[image as usize - 1]
                    && rng.chance(50)
                {
                    let x = rng.below(width);
                    let y = rng.below(height);
                    keys.push_str(&format!(
                        ",x={x},y={y},w={},h={}",
                        1 + rng.below(width - x),
                        1 + rng.below(height - y)
                    ));
                }
                if rng.chance(40) {
                    keys.push_str(&format!(",X={},Y={}", rng.below(7), rng.below(15)));
                }
                if rng.chance(30) {
                    keys.push_str(&format!(",c={},r={}", 1 + rng.below(6), 1 + rng.below(4)));
                }
                if rng.chance(50) {
                    keys.push_str(&format!(",z={}", rng.pick(&Z_VALUES)));
                }
                put(out, &format!("\x1b_G{keys}\x1b\\"));
            }
            6 => {
                if self.placements.is_empty() {
                    return;
                }
                // A recent parent is the likeliest to have survived scrolling,
                // erasure and spatial deletion, which this model cannot see.
                let recent = &self.placements[self.placements.len().saturating_sub(3)..];
                let (parent_image, parent) = rng.pick(recent);
                let horizontal = rng.below(5) as i64 - 2;
                let vertical = rng.below(5) as i64 - 2;
                self.placements.push((shown, placement));
                put(
                    out,
                    &format!(
                        "\x1b_Ga=p,i={shown},p={placement},P={parent_image},Q={parent},\
                         H={horizontal},V={vertical},q=2\x1b\\"
                    ),
                );
            }
            7 => {
                // A virtual placement, then the placeholder cells that show it.
                let (width, height) = (1 + rng.below(4), 1 + rng.below(3));
                put(
                    out,
                    &format!(
                        "\x1b_Ga=p,U=1,i={shown},p={placement},c={width},r={height},q=2\x1b\\"
                    ),
                );
                let top = rng.below(u64::from(rows));
                let left = rng.below(u64::from(cols));
                for line in 0..height.min(u64::from(rows) - top) {
                    put(
                        out,
                        &format!(
                            "\x1b[{};{}H\x1b[38;5;{shown};58;5;{placement}m",
                            top + line + 1,
                            left + 1
                        ),
                    );
                    for column in 0..width.min(u64::from(cols) - left) {
                        out.extend_from_slice("\u{10eeee}".as_bytes());
                        if column == 0 {
                            let mut marks = String::new();
                            marks.push(DIACRITICS[line as usize]);
                            marks.push(DIACRITICS[0]);
                            put(out, &marks);
                        }
                    }
                    put(out, "\x1b[39;59m");
                }
            }
            _ => {
                let keys = match rng.below(8) {
                    0 => {
                        self.placements.retain(|(owner, _)| *owner != image);
                        format!("d=i,i={image}")
                    }
                    1 if !self.placements.is_empty() => {
                        let (image, placement) = rng.pick(&self.placements);
                        self.placements.retain(|entry| *entry != (image, placement));
                        format!("d=i,i={image},p={placement}")
                    }
                    2 => {
                        self.placements.retain(|(owner, _)| *owner != image);
                        self.images[image as usize - 1] = None;
                        format!("d=I,i={image}")
                    }
                    3 => {
                        self.placements.clear();
                        String::from("d=a")
                    }
                    4 => format!("d=y,y={}", 1 + rng.below(u64::from(rows))),
                    5 => format!("d=x,x={}", 1 + rng.below(u64::from(cols))),
                    6 => format!("d=z,z={}", rng.pick(&Z_VALUES)),
                    _ => format!(
                        "d=p,x={},y={}",
                        1 + rng.below(u64::from(cols)),
                        1 + rng.below(u64::from(rows))
                    ),
                };
                put(out, &format!("\x1b_Ga=d,{keys},q=2\x1b\\"));
            }
        }
    }
}

/// A placement already resolved to cell geometry: the projector's output
/// shape, not its input. Nothing anchors it to the grid, so text operations
/// leave it where it is; it moves when the driver republishes it.
#[derive(Clone, Copy)]
struct Sprite {
    content: Content,
    stack: Stack,
    /// Destination in 32.32 cells, `top` counted from row zero.
    left: u64,
    width: u64,
    top: u64,
    height: u64,
    /// Source crop in 32.32 pixels: `x`, `y`, width, height.
    source: [u64; 4],
}

/// The projection driver's scene and the storage its rows are admitted to.
struct Sprites {
    sprites: Vec<Sprite>,
    /// Placement identities are never reused, as the projector's are not.
    next_placement: u64,
    budget: Budget,
    scratch: GraphicsEncodeScratch,
}

fn scale(value: u64, numerator: u64, denominator: u64) -> u64 {
    (u128::from(value) * u128::from(numerator) / u128::from(denominator)) as u64
}

impl Sprites {
    fn new() -> Self {
        Self {
            sprites: Vec::new(),
            next_placement: 1,
            budget: Budget::new(Usage {
                bytes: 64 << 20,
                objects: 1 << 16,
            }),
            scratch: GraphicsEncodeScratch::default(),
        }
    }

    fn sprite(&mut self, rng: &mut Rng, cols: u16, rows: u16) -> Sprite {
        // Half the time a sprite shares content with an existing one, so rows
        // intern repeated domains as well as distinct ones.
        let content = match self.sprites.len() {
            0 => None,
            count if rng.chance(50) => Some(self.sprites[rng.below(count as u64) as usize].content),
            _ => None,
        }
        .unwrap_or_else(|| {
            let mut root = [0; 32];
            for byte in &mut root {
                *byte = rng.next() as u8;
            }
            Content {
                root,
                kind: ContentKind::Image,
                width: 1 + rng.below(64) as u32,
                height: 1 + rng.below(64) as u32,
            }
        });
        let placement = self.next_placement;
        self.next_placement += 1;
        let (width, height) = (u64::from(content.width), u64::from(content.height));
        let x = rng.below(width);
        let y = rng.below(height);
        let quarter = CELL_UNIT / 4;
        Sprite {
            content,
            stack: Stack {
                z: rng.pick(&Z_VALUES),
                image_id: 1 + rng.below(IMAGES) as u32,
                placement,
            },
            left: rng.below(u64::from(cols) * 4) * quarter,
            width: (1 + rng.below(u64::from(cols) * 2)) * quarter,
            top: rng.below(u64::from(rows) * 4) * quarter,
            height: (1 + rng.below(8)) * quarter,
            source: [
                x * CELL_UNIT,
                y * CELL_UNIT,
                (1 + rng.below(width - x)) * CELL_UNIT,
                (1 + rng.below(height - y)) * CELL_UNIT,
            ],
        }
    }

    fn operation(&mut self, rng: &mut Rng, cols: u16, rows: u16) {
        let count = self.sprites.len() as u64;
        match rng.below(20) {
            0..=4 => {
                for _ in 0..1 + rng.below(2) {
                    let sprite = self.sprite(rng, cols, rows);
                    self.sprites.push(sprite);
                }
            }
            // A move with the text untouched: graphics-only row changes, and
            // an explicit empty replacement on rows it covered alone.
            5..=9 if count > 0 => {
                let sprite = &mut self.sprites[rng.below(count) as usize];
                sprite.left = rng.below(u64::from(cols) * 4) * (CELL_UNIT / 4);
                sprite.top = rng.below(u64::from(rows) * 4) * (CELL_UNIT / 4);
            }
            10 if count > 0 => {
                let index = rng.below(count) as usize;
                let fresh = self.sprite(rng, cols, rows);
                let sprite = &mut self.sprites[index];
                sprite.stack.z = fresh.stack.z;
                if sprite.content == fresh.content {
                    sprite.source = fresh.source;
                }
            }
            11..=16 if count > 0 => {
                for _ in 0..1 + rng.below(3) {
                    if self.sprites.is_empty() {
                        break;
                    }
                    let index = rng.below(self.sprites.len() as u64) as usize;
                    self.sprites.swap_remove(index);
                }
            }
            17 | 18 => self.sprites.clear(),
            _ => {
                // One row past a datagram: distinct thin slivers, each its own
                // content domain, which only the reliable jumbo path carries.
                let row = rng.below(u64::from(rows)) * CELL_UNIT;
                for _ in 0..12 + rng.below(13) {
                    let mut sprite = self.sprite(rng, cols, rows);
                    for byte in &mut sprite.content.root {
                        *byte = rng.next() as u8;
                    }
                    sprite.top = row;
                    sprite.height = CELL_UNIT;
                    sprite.width = (1 + rng.below(4)) * (CELL_UNIT / 4);
                    self.sprites.push(sprite);
                }
            }
        }
    }

    /// Every visible row's canonical replacement at these dimensions, clipped
    /// as the projector clips: the source shrinks with the destination.
    fn project(&mut self, cols: u16, rows: u16) -> Vec<PreparedGraphics> {
        let limit = u64::from(cols) * CELL_UNIT;
        let mut rows_out: Vec<Vec<Fragment>> = vec![Vec::new(); usize::from(rows)];
        for sprite in &self.sprites {
            let right = (sprite.left + sprite.width).min(limit);
            if sprite.left >= right {
                continue;
            }
            let [x, y, width, height] = sprite.source;
            let source_right = x + scale(width, right - sprite.left, sprite.width);
            let bottom_edge = sprite.top + sprite.height;
            for row in sprite.top / CELL_UNIT..bottom_edge.div_ceil(CELL_UNIT).min(u64::from(rows))
            {
                let row_top = row * CELL_UNIT;
                let top = sprite.top.max(row_top);
                let bottom = bottom_edge.min(row_top + CELL_UNIT);
                rows_out[row as usize].push(Fragment {
                    content: sprite.content,
                    stack: sprite.stack,
                    slice: RowSlice {
                        left: sprite.left,
                        right,
                        top: top - row_top,
                        bottom: bottom - row_top,
                        source_left: x,
                        source_right,
                        source_top: y + scale(height, top - sprite.top, sprite.height),
                        source_bottom: y + scale(height, bottom - sprite.top, sprite.height),
                    },
                });
            }
        }
        rows_out
            .into_iter()
            .map(|mut fragments| {
                fragments.sort_by(Fragment::compare);
                // Admission only: a published test projection holds no charge.
                PreparedGraphics::new(&self.budget, cols, &fragments, &mut self.scratch)
                    .expect("a canonical row fits the projection budget")
                    .0
            })
            .collect()
    }
}

/// Run each seed disturbed and undisturbed, then require the traces to have
/// exercised what the oracle is about.
///
/// Every trace owns its simulated daemon (`DisplaySim` gives its terminal its
/// own graphics resources), so seeds run side by side, one current-thread
/// runtime per worker thread, and their outcomes are absorbed in seed order.
/// The Kitty driver's time is mostly the kernel launching sandboxed helpers,
/// which only spreading the seeds across cores shortens.
fn converge_across_seeds(driver: Driver, seeds: &[u64], operations: usize) {
    let runs: Vec<OnceLock<(Outcome, Outcome)>> = seeds.iter().map(|_| OnceLock::new()).collect();
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .min(seeds.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("a trace runtime");
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&seed) = seeds.get(index) else {
                        return;
                    };
                    let run = std::panic::catch_unwind(AssertUnwindSafe(|| {
                        runtime.block_on(async {
                            (
                                run_trace(driver, seed, operations, Some(disturbance(seed))).await,
                                run_trace(driver, seed, operations, None).await,
                            )
                        })
                    }));
                    match run {
                        Ok(run) => {
                            assert!(runs[index].set(run).is_ok(), "seed {seed:#x} ran twice");
                        }
                        // Concurrent traces interleave their `GRAPHICS_TRACE`
                        // lines, so name the failing one after its panic.
                        Err(panic) => {
                            eprintln!("GRAPHICS_TRACE failed: {driver:?} trace seed {seed:#x}");
                            std::panic::resume_unwind(panic);
                        }
                    }
                }
            });
        }
    });
    let mut disturbed = Outcome::default();
    let mut undisturbed = Outcome::default();
    for run in runs {
        let (disturbed_run, undisturbed_run) = run.into_inner().expect("every seed ran");
        disturbed.absorb(disturbed_run);
        undisturbed.absorb(undisturbed_run);
    }
    let arrived = disturbed.disturbed.arrived;
    let lost = disturbed.disturbed.lost;
    let duplicated = disturbed.disturbed.duplicated;
    let reordered = disturbed.disturbed.reordered;
    eprintln!(
        "GRAPHICS_CONVERGENCE driver={driver:?} seeds={} operations={operations} \
         graphics_operations={} checkpoints={} graphics_checkpoints={} digests={} \
         snapshots={} jumbo_rows={} fec_recoveries={} resizes_with_graphics={} \
         arrived={arrived:?} lost={lost:?} duplicated={duplicated:?} reordered={reordered:?}",
        seeds.len(),
        disturbed.graphics_operations,
        disturbed.checkpoints + undisturbed.checkpoints,
        disturbed.checkpoints_with_graphics + undisturbed.checkpoints_with_graphics,
        disturbed.digests_compared + undisturbed.digests_compared,
        disturbed.snapshots + undisturbed.snapshots,
        disturbed.jumbo_rows + undisturbed.jumbo_rows,
        disturbed.recovered_by_fec,
        disturbed.resizes_with_graphics + undisturbed.resizes_with_graphics,
    );

    // Controls: an oracle over screens without graphics, a digest check that
    // never received a digest, or a disturbance that never reached the row
    // shapes graphics recovery depends on, would pass without proving
    // anything.
    for (outcome, name) in [(&disturbed, "disturbed"), (&undisturbed, "undisturbed")] {
        assert!(
            outcome.checkpoints_with_graphics > 0,
            "no {name} checkpoint compared a screen holding graphics"
        );
        assert!(
            outcome.digests_compared > 0,
            "no {name} checkpoint compared a hash digest"
        );
        assert!(
            outcome.resizes_with_graphics > 0,
            "no {name} resize re-rooted a screen holding graphics"
        );
        assert!(
            outcome.alternate_screen_switches > 0,
            "no {name} trace switched screens"
        );
        // The projection driver's dense rows are built to pass one datagram.
        assert!(
            driver == Driver::Kitty || outcome.jumbo_rows > 0,
            "no {name} row rode the reliable lane as a jumbo delta"
        );
    }
    for (units, name) in [
        (lost, "lost"),
        (duplicated, "duplicated"),
        (reordered, "reordered"),
    ] {
        assert!(
            units.graphics_only > 0,
            "no {name} unit carried a graphics-only row change: {units:?}"
        );
        assert!(
            units.empty_replacements > 0,
            "no {name} unit carried an empty graphics replacement: {units:?}"
        );
    }
    assert_eq!(
        undisturbed.disturbed.lost.units
            + undisturbed.disturbed.duplicated.units
            + undisturbed.disturbed.reordered.units,
        0,
        "an undisturbed trace disturbed display units"
    );
}

const SEEDS: [u64; 4] = [
    0x6A09_E667_F3BC_C908,
    0xBB67_AE85_84CA_A73B,
    0x3C6E_F372_FE94_F82B,
    0xA54F_F53A_5F1D_36F1,
];

/// Seeds for the long runs: the fixed four, then a splitmix stream.
fn many_seeds(count: usize) -> Vec<u64> {
    let mut rng = Rng(0x510E_527F_ADE6_82D1);
    SEEDS
        .into_iter()
        .chain(std::iter::repeat_with(|| rng.next()))
        .take(count)
        .collect()
}

#[test]
fn projected_graphics_converge_under_disturbed_display_units() {
    converge_across_seeds(Driver::Projection, &SEEDS, 160);
}

/// The Kitty driver needs the helper `bun run build:image-worker` builds; the
/// gate runs this module with `--ignored real_helper::` after that build.
mod real_helper {
    use super::*;

    #[test]
    #[ignore = "real helper: bun run build:image-worker"]
    fn kitty_graphics_converge_under_disturbed_display_units() {
        converge_across_seeds(Driver::Kitty, &SEEDS, 160);
    }
}

/// Long runs over 64 seeds, `bun run test:graphics:long`: deferred by the
/// gate, never part of a default or real-helper lane.
mod long {
    use super::*;

    #[test]
    #[ignore = "long run: bun run test:graphics:long"]
    fn projected_graphics_converge_across_many_seeds() {
        converge_across_seeds(Driver::Projection, &many_seeds(64), 160);
    }

    #[test]
    #[ignore = "long run: bun run test:graphics:long"]
    fn kitty_graphics_converge_across_many_seeds() {
        converge_across_seeds(Driver::Kitty, &many_seeds(64), 160);
    }
}
