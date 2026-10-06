//! Verified tiles rendered at the host's pixel geometry through Kitty graphics.
//!
//! Every upload has an identity and must be acknowledged. A complete prepared
//! scene replaces the previous placements together; an incomplete scene never
//! tears. Rasterization runs only when a tile or its geometry changes.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::{Engine, engine::general_purpose::STANDARD};
use merkur_client::viewer::graphics::{Quad, Scene};
use merkur_graphics::budget::{Budget, Lease, Usage};
use zeroize::Zeroizing;

mod worker;
pub(crate) use worker::completed;
use worker::{Prepared, Source, Worker};

use crate::host::HostSize;

/// A hard retained-pixel budget, independent of the terminal's own quota.
/// It bounds hostile overlapping placements before allocating their rasters.
const WORKING_BYTES: usize = 128 * 1024 * 1024;

static NEXT_IMAGE: AtomicU32 = AtomicU32::new(1);

/// A queued delete is still owed until the host consumed its containing frame.
/// Exit and panic cleanup can therefore release even images whose last frame
/// was only partly written. This also owns uploads with no visible placement.
#[derive(Default)]
struct HostImages {
    live: BTreeSet<u32>,
    deleting: BTreeSet<u32>,
}
impl HostImages {
    fn consumed(&mut self) {
        for id in std::mem::take(&mut self.deleting) {
            self.live.remove(&id);
        }
    }
    fn restore(&mut self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for id in std::mem::take(&mut self.live) {
            bytes.extend_from_slice(format!("\x1b_Ga=d,d=I,i={id},q=2\x1b\\").as_bytes());
        }
        self.deleting.clear();
        bytes
    }
}
static HOST_IMAGES: Mutex<HostImages> = Mutex::new(HostImages {
    live: BTreeSet::new(),
    deleting: BTreeSet::new(),
});

pub(crate) fn host_consumed() {
    let mut images = HOST_IMAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    images.consumed();
}

pub(crate) fn restore_commands() -> Vec<u8> {
    let mut images = HOST_IMAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    images.restore()
}

fn image_id() -> io::Result<u32> {
    let id = NEXT_IMAGE
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| io::Error::other("host graphics identity namespace exhausted"))?;
    HOST_IMAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .live
        .insert(id);
    Ok(id)
}

struct Tile {
    id: u32,
    source: Arc<Source>,
    sent: bool,
    confirmed: bool,
}
impl std::ops::Deref for Tile {
    type Target = Source;
    fn deref(&self) -> &Source {
        &self.source
    }
}

/// The same source region and scale can occur in many placements. Destination
/// position is included because a subpixel translation changes the samples.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct RasterKey {
    tile: String,
    rect: [u32; 4],
    mapping: [u64; 8],
    layer: u8,
}
struct Raster {
    id: u32,
    pixels: Zeroizing<Vec<u8>>,
    sent: bool,
    confirmed: bool,
    _storage: Lease,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Placement {
    key: RasterKey,
    layer: u8,
    order: u32,
}

pub struct Graphics {
    epoch: u32,
    tiles: BTreeMap<String, Tile>,
    rasters: BTreeMap<RasterKey, Raster>,
    desired: Vec<Placement>,
    shown: Vec<Placement>,
    scene: Option<Scene>,
    size: Option<HostSize>,
    erased: bool,
    complete: bool,
    garbage: Vec<u32>,
    retired: Vec<String>,
    budget: Budget,
    worker: Option<Worker>,
    generation: Arc<AtomicBool>,
    pending_tiles: BTreeSet<String>,
    pending_rasters: BTreeMap<RasterKey, Arc<AtomicBool>>,
    uploads: BTreeMap<u32, Upload>,
    dirty: bool,
}

enum Upload {
    Tile(String),
    Raster(RasterKey),
}

impl Default for Graphics {
    fn default() -> Self {
        Self {
            epoch: 0,
            tiles: BTreeMap::new(),
            rasters: BTreeMap::new(),
            desired: Vec::new(),
            shown: Vec::new(),
            scene: None,
            size: None,
            erased: false,
            complete: false,
            garbage: Vec::new(),
            retired: Vec::new(),
            budget: Budget::new(Usage {
                bytes: WORKING_BYTES,
                objects: usize::MAX,
            }),
            worker: None,
            generation: Arc::new(AtomicBool::new(false)),
            pending_tiles: BTreeSet::new(),
            pending_rasters: BTreeMap::new(),
            uploads: BTreeMap::new(),
            dirty: false,
        }
    }
}
impl Drop for Graphics {
    fn drop(&mut self) {
        self.generation.store(true, Ordering::Release);
    }
}

impl Graphics {
    pub fn fence(&mut self, epoch: u32) {
        self.garbage.extend(self.tiles.values().map(|tile| tile.id));
        self.garbage
            .extend(self.rasters.values().map(|raster| raster.id));
        self.tiles.clear();
        self.rasters.clear();
        self.uploads.clear();
        self.generation.store(true, Ordering::Release);
        self.generation = Arc::new(AtomicBool::new(false));
        self.pending_tiles.clear();
        self.pending_rasters.clear();
        self.dirty = true;
        self.desired.clear();
        self.shown.clear();
        self.scene = None;
        self.retired.clear();
        self.epoch = epoch;
        self.erased = true;
    }

    pub fn destroy(&mut self, out: &mut Vec<u8>) {
        for id in self.garbage.drain(..) {
            delete(out, id, true);
        }
        for tile in self.tiles.values() {
            delete(out, tile.id, true);
        }
        for raster in self.rasters.values() {
            delete(out, raster.id, true);
        }
        self.tiles.clear();
        self.rasters.clear();
        self.uploads.clear();
        self.generation.store(true, Ordering::Release);
        self.generation = Arc::new(AtomicBool::new(false));
        self.pending_tiles.clear();
        self.pending_rasters.clear();
        self.dirty = true;
        self.desired.clear();
        self.shown.clear();
    }

    /// The transport already proved the PNG's commitment and bounded envelope.
    /// Decode only its canonical RGBA shape, once, to prepare exact placements.
    pub fn tile(&mut self, epoch: u32, key: String, bytes: Vec<u8>) -> io::Result<()> {
        let bytes = Zeroizing::new(bytes);
        if epoch != self.epoch || self.tiles.contains_key(&key) || self.pending_tiles.contains(&key)
        {
            return Ok(());
        }
        let shape = bytes
            .get(16..24)
            .ok_or_else(|| io::Error::other("verified tile lacks its PNG shape"))?;
        let width = u32::from_be_bytes(shape[..4].try_into().expect("four bytes"));
        let height = u32::from_be_bytes(shape[4..].try_into().expect("four bytes"));
        if !(3..=258).contains(&width) || !(3..=258).contains(&height) {
            return Err(io::Error::other(
                "verified tile has a noncanonical PNG shape",
            ));
        }
        let storage = self.reserve_pixels(width as usize * height as usize * 4 + bytes.len())?;
        let generation = Arc::clone(&self.generation);
        self.worker()?
            .tile(generation, key.clone(), bytes, storage)?;
        self.pending_tiles.insert(key);
        Ok(())
    }

    fn worker(&mut self) -> io::Result<&Worker> {
        if self.worker.is_none() {
            self.worker = Some(Worker::new()?);
        }
        Ok(self.worker.as_ref().expect("graphics worker started"))
    }

    /// Called by the worker's completion notification, never a polling timer.
    pub fn completed(&mut self) -> io::Result<bool> {
        let mut changed = false;
        if let Some(worker) = &self.worker {
            while let Some(result) = worker.receive()? {
                if !Arc::ptr_eq(&result.generation, &self.generation)
                    || result.generation.load(Ordering::Acquire)
                {
                    continue;
                }
                match result.prepared? {
                    Prepared::Tile { key, source } => {
                        if !self.pending_tiles.remove(&key) {
                            continue;
                        }
                        let id = image_id()?;
                        self.uploads.insert(id, Upload::Tile(key.clone()));
                        self.tiles.insert(
                            key,
                            Tile {
                                id,
                                source: Arc::new(source),
                                sent: false,
                                confirmed: false,
                            },
                        );
                        self.scene = None;
                        changed = true;
                    }
                    Prepared::Raster {
                        key,
                        cancel,
                        pixels,
                        storage,
                    } => {
                        if !self
                            .pending_rasters
                            .get(&key)
                            .is_some_and(|pending| Arc::ptr_eq(pending, &cancel))
                        {
                            continue;
                        }
                        self.pending_rasters.remove(&key);
                        if cancel.load(Ordering::Acquire) {
                            continue;
                        }
                        let id = image_id()?;
                        self.uploads.insert(id, Upload::Raster(key.clone()));
                        self.rasters.insert(
                            key,
                            Raster {
                                id,
                                pixels,
                                sent: false,
                                confirmed: false,
                                _storage: storage,
                            },
                        );
                        changed = true;
                    }
                    Prepared::Cancelled => {}
                }
            }
        }
        self.dirty |= changed;
        Ok(changed)
    }

    /// Returns the original tile whose residency this reply proved. Unknown
    /// identities belong to another tab or to a retired upload and do nothing.
    pub fn reply(
        &mut self,
        id: u32,
        placement: Option<u32>,
        result: Result<(), &str>,
    ) -> io::Result<Option<(u32, Option<String>)>> {
        match self.uploads.get(&id) {
            Some(Upload::Tile(key)) => {
                let tile = self.tiles.get_mut(key).expect("indexed tile upload");
                if placement.is_some() || !tile.sent {
                    return Ok(None);
                }
                result.map_err(|error| {
                    io::Error::other(format!("host rejected graphics tile: {error}"))
                })?;
                if std::mem::replace(&mut tile.confirmed, true) {
                    return Ok(None);
                }
                self.dirty = true;
                return Ok(Some((self.epoch, Some(key.clone()))));
            }
            Some(Upload::Raster(key)) => {
                let raster = self.rasters.get_mut(key).expect("indexed raster upload");
                if !raster.sent {
                    return Ok(None);
                }
                result.map_err(|error| {
                    io::Error::other(format!("host rejected graphics placement: {error}"))
                })?;
                if placement.is_none() && !std::mem::replace(&mut raster.confirmed, true) {
                    self.dirty = true;
                    return Ok(Some((self.epoch, None)));
                }
            }
            None => {}
        }
        Ok(None)
    }

    /// A modal screen or tab switch removes placements but retains the uploads.
    /// The same acknowledged pixels can then be placed without retransmission.
    pub fn hide(&mut self, out: &mut Vec<u8>) {
        for placement in &self.shown {
            if let Some(raster) = self.rasters.get(&placement.key) {
                delete_placement(out, raster.id, placement.order + 1);
            }
        }
        self.shown.clear();
        self.erased = true;
        self.dirty = true;
    }

    /// Appends uploads and a complete scene's placement changes inside the
    /// caller's synchronized update. Geometry never changes the text cursor.
    pub fn compose(&mut self, scene: &Scene, size: HostSize, out: &mut Vec<u8>) -> io::Result<()> {
        if !self.dirty && self.scene.as_ref() == Some(scene) && self.size == Some(size) {
            return Ok(());
        }
        for id in self.garbage.drain(..) {
            delete(out, id, true);
        }
        if self.scene.as_ref() != Some(scene) || self.size != Some(size) {
            self.prepare(scene, size)?;
            self.scene = Some(scene.clone());
            self.size = Some(size);
        }
        for tile in self.tiles.values_mut() {
            if !tile.sent {
                upload(out, tile.id, 100, tile.width, tile.height, &tile.png);
                tile.sent = true;
            }
        }
        for (key, raster) in &mut self.rasters {
            if !raster.sent {
                upload(
                    out,
                    raster.id,
                    32,
                    key.rect[2] - key.rect[0],
                    key.rect[3] - key.rect[1],
                    &raster.pixels,
                );
                raster.sent = true;
            }
        }
        let ready = self.complete
            && self.desired.iter().all(|placement| {
                self.rasters
                    .get(&placement.key)
                    .is_some_and(|raster| raster.confirmed)
            });
        if ready && (self.erased || self.shown != self.desired) {
            let desired: BTreeSet<_> = self.desired.iter().collect();
            let shown: BTreeSet<_> = self.shown.iter().collect();
            out.extend_from_slice(b"\x1b7");
            for placement in &self.shown {
                if !desired.contains(placement)
                    && let Some(raster) = self.rasters.get(&placement.key)
                {
                    delete_placement(out, raster.id, placement.order + 1);
                }
            }
            let (cell_width, cell_height) = size.cell.unwrap_or((1.0, 1.0));
            for placement in &self.desired {
                if !self.erased && shown.contains(placement) {
                    continue;
                }
                let raster = &self.rasters[&placement.key];
                let [left, top, _, _] = placement.key.rect;
                let column = (f64::from(left) / cell_width).floor() as u32;
                let row = (f64::from(top) / cell_height).floor() as u32;
                let x = (f64::from(left) - f64::from(column) * cell_width).round() as u32;
                let y = (f64::from(top) - f64::from(row) * cell_height).round() as u32;
                let z = match placement.layer {
                    0 => i32::MIN,
                    1 => -1_073_741_824,
                    _ => 0,
                } + placement.order as i32;
                out.extend_from_slice(
                    format!(
                        "\x1b[{};{}H\x1b_Ga=p,i={},p={},X={x},Y={y},C=1,z={z}\x1b\\",
                        row + 1,
                        column + 1,
                        raster.id,
                        placement.order + 1
                    )
                    .as_bytes(),
                );
            }
            out.extend_from_slice(b"\x1b8");
            self.shown.clone_from(&self.desired);
            self.erased = false;
        }
        self.retire(scene, out);
        self.dirty = false;
        Ok(())
    }

    fn prepare(&mut self, scene: &Scene, size: HostSize) -> io::Result<()> {
        self.desired.clear();
        self.complete = true;
        let Some((cell_width, cell_height)) = size.cell else {
            return Ok(());
        };
        let width = (f64::from(size.cols) * cell_width).floor() as u32;
        let height = (f64::from(size.rows.saturating_sub(1)) * cell_height).floor() as u32;
        let bindings: BTreeMap<_, _> = scene
            .animations
            .iter()
            .flat_map(|animation| &animation.bindings)
            .map(|(binding, key)| (binding, key))
            .collect();
        for (order, quad) in scene.quads.iter().enumerate() {
            let key = bindings.get(&quad.key).copied().unwrap_or(&quad.key);
            let Some(tile) = self.tiles.get(key).map(|tile| Arc::clone(&tile.source)) else {
                continue;
            };
            let Some(raster_key) = raster_key(key, quad, width, height) else {
                continue;
            };
            if !self.rasters.contains_key(&raster_key)
                && !self.pending_rasters.contains_key(&raster_key)
            {
                let storage = self.reserve_pixels(pixel_bytes(raster_key.rect)?)?;
                let cancel = Arc::new(AtomicBool::new(false));
                let generation = Arc::clone(&self.generation);
                self.worker()?.raster(
                    (generation, Arc::clone(&cancel)),
                    raster_key.clone(),
                    quad.clone(),
                    tile,
                    storage,
                )?;
                self.pending_rasters.insert(raster_key.clone(), cancel);
            }
            self.desired.push(Placement {
                key: raster_key,
                layer: quad.layer,
                order: order as u32,
            });
        }
        // Missing tiles hold all existing placements until this scene is ready.
        self.complete = self.desired.len()
            == scene
                .quads
                .iter()
                .filter(|quad| raster_key("", quad, width, height).is_some())
                .count();
        Ok(())
    }
    fn reserve_pixels(&self, additional: usize) -> io::Result<Lease> {
        self.budget
            .reserve(Usage {
                bytes: additional,
                objects: 1,
            })
            .ok_or_else(|| {
                io::Error::other("host graphics working set exceeds its retained-pixel budget")
            })
    }

    pub fn retired(&mut self) -> impl Iterator<Item = (u32, String)> + '_ {
        let epoch = self.epoch;
        self.retired.drain(..).map(move |key| (epoch, key))
    }

    fn retire(&mut self, scene: &Scene, out: &mut Vec<u8>) {
        let keep: BTreeSet<_> = self
            .desired
            .iter()
            .chain(&self.shown)
            .map(|placement| &placement.key)
            .collect();
        self.pending_rasters.retain(|key, cancel| {
            if keep.contains(key) {
                return true;
            }
            cancel.store(true, Ordering::Release);
            false
        });
        self.rasters.retain(|key, raster| {
            if keep.contains(key) {
                return true;
            }
            delete(out, raster.id, true);
            self.uploads.remove(&raster.id);
            false
        });
        let tiles: BTreeSet<_> = scene.tiles.iter().map(|demand| &demand.key).collect();
        self.tiles.retain(|key, tile| {
            if tiles.contains(key) {
                return true;
            }
            delete(out, tile.id, true);
            self.uploads.remove(&tile.id);
            self.retired.push(key.clone());
            false
        });
    }
}

fn raster_key(key: &str, quad: &Quad, width: u32, height: u32) -> Option<RasterKey> {
    let values = [
        quad.left,
        quad.top,
        quad.right,
        quad.bottom,
        quad.u,
        quad.v,
        quad.uw,
        quad.vh,
    ];
    if values.iter().any(|value| !value.is_finite())
        || quad.right <= quad.left
        || quad.bottom <= quad.top
    {
        return None;
    }
    // Pixel centres inside adjacent quads share exactly the same edge.
    let edge = |value: f64, bound: u32| (value - 0.5).ceil().clamp(0.0, f64::from(bound)) as u32;
    let rect = [
        edge(quad.left, width),
        edge(quad.top, height),
        edge(quad.right, width),
        edge(quad.bottom, height),
    ];
    (rect[2] > rect[0] && rect[3] > rect[1]).then(|| RasterKey {
        tile: key.into(),
        rect,
        mapping: values.map(f64::to_bits),
        layer: quad.layer,
    })
}

fn pixel_bytes(rect: [u32; 4]) -> io::Result<usize> {
    ((rect[2] - rect[0]) as usize)
        .checked_mul((rect[3] - rect[1]) as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| io::Error::other("host graphics pixel extent overflows"))
}

fn rasterize(
    tile: &Source,
    quad: &Quad,
    rect: [u32; 4],
    cancelled: impl Fn() -> bool,
) -> io::Result<Zeroizing<Vec<u8>>> {
    let mut pixels = Zeroizing::new(Vec::new());
    pixels
        .try_reserve_exact(pixel_bytes(rect)?)
        .map_err(io::Error::other)?;
    for y in rect[1]..rect[3] {
        if cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "graphics preparation cancelled",
            ));
        }
        let sy = 258.0
            * (quad.v + (f64::from(y) + 0.5 - quad.top) / (quad.bottom - quad.top) * quad.vh)
            - 0.5;
        for x in rect[0]..rect[2] {
            if x & 255 == 0 && cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "graphics preparation cancelled",
                ));
            }
            let sx = 258.0
                * (quad.u + (f64::from(x) + 0.5 - quad.left) / (quad.right - quad.left) * quad.uw)
                - 0.5;
            let x0 = sx.floor().clamp(0.0, f64::from(tile.width - 1)) as u32;
            let y0 = sy.floor().clamp(0.0, f64::from(tile.height - 1)) as u32;
            let x1 = (x0 + 1).min(tile.width - 1);
            let y1 = (y0 + 1).min(tile.height - 1);
            let tx = (sx - sx.floor()).clamp(0.0, 1.0);
            let ty = (sy - sy.floor()).clamp(0.0, 1.0);
            let samples = [
                (x0, y0, (1.0 - tx) * (1.0 - ty)),
                (x1, y0, tx * (1.0 - ty)),
                (x0, y1, (1.0 - tx) * ty),
                (x1, y1, tx * ty),
            ];
            let mut rgba = [0.0; 4];
            for (x, y, weight) in samples {
                let at = (y as usize * tile.width as usize + x as usize) * 4;
                let pixel = &tile.pixels[at..at + 4];
                let alpha = f64::from(pixel[3]);
                rgba[3] += alpha * weight;
                for channel in 0..3 {
                    rgba[channel] += f64::from(pixel[channel]) * alpha * weight;
                }
            }
            for value in &rgba[..3] {
                pixels.push(if rgba[3] > 0.0 {
                    (value / rgba[3]).round() as u8
                } else {
                    0
                });
            }
            pixels.push(rgba[3].round() as u8);
        }
    }
    Ok(pixels)
}

fn upload(out: &mut Vec<u8>, id: u32, format: u32, width: u32, height: u32, bytes: &[u8]) {
    // Three decoded bytes per quartet; no intermediate encoded allocation.
    let mut encoded = [0; 4096];
    let mut chunks = bytes.chunks(3072).peekable();
    let mut first = true;
    while let Some(chunk) = chunks.next() {
        let more = u8::from(chunks.peek().is_some());
        if first {
            out.extend_from_slice(
                format!("\x1b_Ga=t,t=d,f={format},s={width},v={height},i={id},m={more};")
                    .as_bytes(),
            );
            first = false;
        } else {
            out.extend_from_slice(format!("\x1b_Gm={more};").as_bytes());
        }
        let length = STANDARD
            .encode_slice(chunk, &mut encoded)
            .expect("base64 chunk capacity");
        out.extend_from_slice(&encoded[..length]);
        out.extend_from_slice(b"\x1b\\");
    }
}
fn delete(out: &mut Vec<u8>, id: u32, free: bool) {
    if free {
        HOST_IMAGES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .deleting
            .insert(id);
    }
    out.extend_from_slice(
        format!(
            "\x1b_Ga=d,d={},i={id},q=2\x1b\\",
            if free { 'I' } else { 'i' }
        )
        .as_bytes(),
    );
}

fn delete_placement(out: &mut Vec<u8>, id: u32, placement: u32) {
    out.extend_from_slice(format!("\x1b_Ga=d,d=i,i={id},p={placement},q=2\x1b\\").as_bytes());
}

#[cfg(test)]
mod tests;
