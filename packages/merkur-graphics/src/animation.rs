//! Immutable playback manifests and elapsed-time selection. Sampling does not
//! allocate, advance a mutable frame counter or depend on animation tick delivery.

use crate::budget::{Budget, Lease, Usage};
use crate::processing::pixel_bytes;

/// Resource bounds for one immutable animation catalogue and its seek index.
pub const MAX_FRAMES: usize = 4096;
pub const HEADER_BYTES: usize = 64;
pub const ENTRY_BYTES: usize = 36;
pub const MAX_MANIFEST_BYTES: usize = HEADER_BYTES + ENTRY_BYTES * MAX_FRAMES;
const DOMAIN: &[u8] = b"merkur.graphics.animation.manifest\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Mode {
    Stopped = 1,
    Loading = 2,
    Loop = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub root: [u8; 32],
    pub gap_ms: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Playback {
    pub mode: Mode,
    pub anchor_us: u64,
    pub frame: u32,
    /// Zero means infinite; the Kitty control value is translated once by its owner.
    pub loops: u32,
    pub completed: u64,
    pub elapsed_us: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub frame: u32,
    pub completed: u64,
    pub elapsed_us: u64,
    /// The next timeline boundary, in the authority's monotonic clock domain.
    /// Loading at its tail, finite-loop completion and stopped/all-gapless
    /// timelines have no deadline, and therefore require no playback loop.
    pub next_us: Option<u64>,
    pub ended: bool,
}

pub struct Manifest {
    width: u32,
    height: u32,
    revision: u64,
    playback: Playback,
    prefix: Box<[u64]>,
    bytes: Box<[u8]>,
    root: [u8; 32],
    _lease: Lease,
}

impl Manifest {
    pub fn charge(count: usize) -> Option<Usage> {
        if count == 0 || count > MAX_FRAMES {
            return None;
        }
        Some(Usage {
            bytes: size_of::<Self>()
                + 2 * size_of::<usize>()
                + (count + 1) * size_of::<u64>()
                + HEADER_BYTES
                + count * ENTRY_BYTES,
            objects: 3,
        })
    }

    /// Builds from `batch`, storage its owner admitted beforehand: `charge`,
    /// split off once the manifest is valid.
    pub fn new(
        width: u32,
        height: u32,
        revision: u64,
        playback: Playback,
        entries: &[Entry],
        batch: &mut Lease,
    ) -> Option<Self> {
        Self::build(
            width,
            height,
            revision,
            playback,
            entries.iter().copied(),
            |charge| batch.split(charge),
        )
    }

    fn build(
        width: u32,
        height: u32,
        revision: u64,
        playback: Playback,
        entries: impl ExactSizeIterator<Item = Entry> + Clone,
        admit: impl FnOnce(Usage) -> Option<Lease>,
    ) -> Option<Self> {
        pixel_bytes(width, height, 4)?;
        let charge = Self::charge(entries.len())?;
        let current = entries.clone().nth(playback.frame as usize)?;
        if revision == 0
            || entries.clone().any(|frame| frame.gap_ms > i32::MAX as u32)
            || playback.elapsed_us > u64::from(current.gap_ms) * 1000
            || (playback.loops != 0 && playback.completed > u64::from(playback.loops))
        {
            return None;
        }
        let lease = admit(charge)?;
        let mut bytes = vec![0; HEADER_BYTES + entries.len() * ENTRY_BYTES];
        put32(&mut bytes, 0, width);
        put32(&mut bytes, 4, height);
        put32(&mut bytes, 8, entries.len() as u32);
        put32(&mut bytes, 12, playback.mode as u32);
        put64(&mut bytes, 16, revision);
        put64(&mut bytes, 24, playback.anchor_us);
        put32(&mut bytes, 32, playback.frame);
        put32(&mut bytes, 36, playback.loops);
        put64(&mut bytes, 40, playback.completed);
        put64(&mut bytes, 48, playback.elapsed_us);
        let mut prefix = Vec::with_capacity(entries.len() + 1);
        prefix.push(0);
        let mut total = 0u64;
        for (entry, wire) in entries.zip(bytes[HEADER_BYTES..].chunks_exact_mut(ENTRY_BYTES)) {
            wire[..32].copy_from_slice(&entry.root);
            wire[32..].copy_from_slice(&entry.gap_ms.to_be_bytes());
            total += u64::from(entry.gap_ms) * 1000;
            prefix.push(total);
        }
        let root = root(&bytes);
        Some(Self {
            width,
            height,
            revision,
            playback,
            prefix: prefix.into_boxed_slice(),
            bytes: bytes.into_boxed_slice(),
            root,
            _lease: lease,
        })
    }

    /// Authentication belongs to the asset owner. Parsing checks every field
    /// and canonical byte before reserving the retained seek/index allocations.
    pub fn decode(bytes: &[u8], budget: &Budget) -> Option<Self> {
        if bytes.len() < HEADER_BYTES || bytes.len() > MAX_MANIFEST_BYTES || bytes[56..64] != [0; 8]
        {
            return None;
        }
        let count = word32(bytes, 8) as usize;
        Self::charge(count)?;
        if bytes.len() != HEADER_BYTES + count * ENTRY_BYTES {
            return None;
        }
        let mode = match word32(bytes, 12) {
            1 => Mode::Stopped,
            2 => Mode::Loading,
            3 => Mode::Loop,
            _ => return None,
        };
        let entries = wire_entries(&bytes[HEADER_BYTES..]);
        Self::build(
            word32(bytes, 0),
            word32(bytes, 4),
            word64(bytes, 16),
            Playback {
                mode,
                anchor_us: word64(bytes, 24),
                frame: word32(bytes, 32),
                loops: word32(bytes, 36),
                completed: word64(bytes, 40),
                elapsed_us: word64(bytes, 48),
            },
            entries,
            |charge| budget.reserve(charge),
        )
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn playback(&self) -> Playback {
        self.playback
    }
    pub fn entries(&self) -> impl ExactSizeIterator<Item = Entry> + Clone + '_ {
        wire_entries(&self.bytes[HEADER_BYTES..])
    }
    pub fn entry(&self, index: usize) -> Option<Entry> {
        self.entries().nth(index)
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn root(&self) -> [u8; 32] {
        self.root
    }

    pub fn content(&self) -> crate::projection::Content {
        crate::projection::Content {
            root: self.root,
            width: self.width,
            height: self.height,
            kind: crate::projection::ContentKind::Animation,
        }
    }

    pub fn sample(&self, now_us: u64) -> Sample {
        let state = self.playback;
        let total = *self.prefix.last().expect("nonempty manifest");
        if state.mode == Mode::Stopped || total == 0 {
            return Sample {
                frame: state.frame,
                completed: state.completed,
                elapsed_us: state.elapsed_us,
                next_us: None,
                ended: false,
            };
        }
        let phase = u128::from(self.prefix[state.frame as usize])
            + u128::from(state.elapsed_us)
            + u128::from(now_us.saturating_sub(state.anchor_us));
        let cycles = phase / u128::from(total);
        let completed = u128::from(state.completed) + cycles;
        let loading_end = state.mode == Mode::Loading && cycles != 0;
        let loop_end =
            state.mode == Mode::Loop && state.loops != 0 && completed >= u128::from(state.loops);
        if loading_end || loop_end {
            // A gapless tail is never presented by autonomous playback.
            let frame = self.prefix.partition_point(|offset| *offset < total) - 1;
            return Sample {
                frame: frame as u32,
                completed: if loop_end {
                    u64::from(state.loops)
                } else {
                    state.completed
                },
                elapsed_us: self.prefix[frame + 1] - self.prefix[frame],
                next_us: None,
                ended: true,
            };
        }
        let phase = (phase % u128::from(total)) as u64;
        let frame = self.prefix.partition_point(|offset| *offset <= phase) - 1;
        let remaining = self.prefix[frame + 1] - phase;
        Sample {
            frame: frame as u32,
            completed: if state.mode == Mode::Loop {
                completed.min(u128::from(u64::MAX)) as u64
            } else {
                state.completed
            },
            elapsed_us: phase - self.prefix[frame],
            next_us: now_us.max(state.anchor_us).checked_add(remaining),
            ended: false,
        }
    }
}

fn wire_entries(bytes: &[u8]) -> impl ExactSizeIterator<Item = Entry> + Clone + '_ {
    bytes.chunks_exact(ENTRY_BYTES).map(|wire| Entry {
        root: wire[..32].try_into().expect("fixed manifest entry"),
        gap_ms: word32(wire, 32),
    })
}

pub fn root(bytes: &[u8]) -> [u8; 32] {
    let mut hash = blake3::Hasher::new();
    hash.update(DOMAIN);
    hash.update(bytes);
    *hash.finalize().as_bytes()
}

fn word32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().expect("bounded field"))
}
fn word64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(bytes[offset..offset + 8].try_into().expect("bounded field"))
}
fn put32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}
fn put64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
}

/// One process-local monotonic domain shared by native playback and authenticated
/// clock observations. No wall-clock corrections can move a timeline backwards.
#[cfg(not(target_arch = "wasm32"))]
pub fn monotonic_us() -> u64 {
    static CLOCK: std::sync::LazyLock<std::time::Instant> =
        std::sync::LazyLock::new(std::time::Instant::now);
    u64::try_from(CLOCK.elapsed().as_micros()).expect("animation clock exhausted")
}
