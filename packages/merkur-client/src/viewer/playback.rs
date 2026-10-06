//! Animated images: the port of `playback.ts`.
//!
//! A timeline is sampled on the daemon's monotonic clock, which the heartbeat
//! maps onto the viewer's. Only a visible timeline with a next boundary owns a
//! deadline, so a terminal without animations does no work at all. A frame
//! whose tiles are not all resident keeps its requests: the next boundary
//! never cancels a slow transfer. The frame after it is fetched ahead once
//! every visible tile is resident, under the same admission, and a frame
//! change swaps tiles under the template's quads.

use std::collections::{BTreeMap, HashMap, HashSet};

use merkur_graphics::animation::{ENTRY_BYTES, HEADER_BYTES, MAX_MANIFEST_BYTES, Manifest, Sample};
use merkur_graphics::budget::{Budget, Usage};

use super::graphics::{FRAGMENT_BYTES, Frame, Scene, SceneAnimation, project, sort_for_allocation};
use crate::hex;
use crate::session::graphics::{GraphicsAsset, GraphicsDemand};

/// What every manifest the viewer retains may hold together.
const RETAINED_BYTES: usize = 16 * 1024 * 1024;
/// The largest time the clock mapping carries exactly.
const MAX_EXACT_US: f64 = 9_007_199_254_740_991.0;

/// One animation's playback, sampled on the daemon's clock.
pub trait Timeline {
    /// The frame at `now_us`, or the last sampled one when the clock is not
    /// mapped.
    fn sample(&mut self, now_us: Option<u64>) -> u32;
    /// The next boundary, if the timeline moves again.
    fn next_us(&self) -> Option<u64>;
    /// The frame that boundary selects, without advancing to it.
    fn next_frame(&self) -> Option<u32>;
}

/// Parses a verified manifest into the timeline of the image `root` of the
/// given size, or refuses it.
pub type Parse = Box<dyn FnMut(&[u8], &[u8; 32], u32, u32) -> Option<Box<dyn Timeline>>>;

/// The daemon's own timeline implementation over a manifest.
struct ManifestTimeline {
    manifest: Manifest,
    sample: Sample,
}

impl Timeline for ManifestTimeline {
    fn sample(&mut self, now_us: Option<u64>) -> u32 {
        if let Some(now_us) = now_us {
            self.sample = self.manifest.sample(now_us);
        }
        self.sample.frame
    }

    fn next_us(&self) -> Option<u64> {
        self.sample.next_us
    }

    fn next_frame(&self) -> Option<u32> {
        self.sample.next_us.map(|at| self.manifest.sample(at).frame)
    }
}

fn parse_manifest(
    storage: &Budget,
    bytes: &[u8],
    root: &[u8; 32],
    width: u32,
    height: u32,
) -> Option<Box<dyn Timeline>> {
    let manifest = Manifest::decode(bytes, storage)?;
    if manifest.root() != *root || manifest.width() != width || manifest.height() != height {
        return None;
    }
    let sample = manifest.sample(manifest.playback().anchor_us);
    Some(Box::new(ManifestTimeline { manifest, sample }))
}

struct Animation {
    demand: GraphicsDemand,
    bytes: Option<Vec<u8>>,
    timeline: Option<Box<dyn Timeline>>,
    frame: Option<u32>,
    /// The current frame's pixel root, and in hex.
    root: [u8; 32],
    identity: String,
    /// The tiles the shown frame binds: until all are resident, it stays.
    pending: Vec<String>,
}

impl Animation {
    /// Frame `frame`'s pixel root, from the manifest's entries.
    fn entry_root(&self, frame: u32) -> Option<[u8; 32]> {
        let at = HEADER_BYTES + frame as usize * ENTRY_BYTES;
        self.bytes.as_ref()?.get(at..at + 32)?.try_into().ok()
    }
}

/// The frame after the visible one, fetched ahead.
enum Prefetch {
    /// Not considered since the scene last changed.
    Owed,
    /// Considered: the scene with the next frame's tiles too, or nothing.
    Settled(Option<Scene>),
}

pub struct Playback {
    parse: Parse,
    /// Keyed by the image's pixel root in hex.
    animations: BTreeMap<String, Animation>,
    fragments: Vec<u8>,
    cell: (f64, f64),
    template: Option<Scene>,
    static_tiles: Vec<GraphicsDemand>,
    scene: Scene,
    prefetch: Prefetch,
    /// The daemon's microseconds, uncertainty included, at `local_ms`.
    clock: Option<(f64, f64)>,
    deadline_ms: Option<f64>,
    suspended: bool,
    retained_bytes: usize,
}

impl Default for Playback {
    fn default() -> Self {
        let storage = Budget::new(Usage {
            bytes: RETAINED_BYTES,
            objects: 3 * 4_096,
        });
        Self::new(Box::new(move |bytes, root, width, height| {
            parse_manifest(&storage, bytes, root, width, height)
        }))
    }
}

impl Playback {
    pub fn new(parse: Parse) -> Self {
        Self {
            parse,
            animations: BTreeMap::new(),
            fragments: Vec::new(),
            cell: (0.0, 0.0),
            template: None,
            static_tiles: Vec::new(),
            scene: Scene::default(),
            prefetch: Prefetch::Owed,
            clock: None,
            deadline_ms: None,
            suspended: false,
            retained_bytes: 0,
        }
    }

    /// Whether any visible placement is animated.
    pub fn active(&self) -> bool {
        !self.animations.is_empty()
    }

    /// When the next visible boundary is due, on the viewer's clock.
    pub fn deadline_ms(&self) -> Option<f64> {
        self.deadline_ms
    }

    /// The scene last rendered, with the next frame's tiles when those are
    /// fetched ahead.
    pub fn scene(&self) -> &Scene {
        match &self.prefetch {
            Prefetch::Settled(Some(scene)) => scene,
            _ => &self.scene,
        }
    }

    /// The daemon's clock read `native_us` at `local_ms`, within
    /// `uncertainty_us`. True when a timeline must be sampled again.
    pub fn calibrate(&mut self, native_us: u64, local_ms: f64, uncertainty_us: f64) -> bool {
        if native_us as f64 > MAX_EXACT_US
            || !local_ms.is_finite()
            || !uncertainty_us.is_finite()
            || uncertainty_us < 0.0
        {
            return false;
        }
        self.clock = Some((native_us as f64 + uncertainty_us, local_ms));
        !self.suspended
            && self.animations.values().any(|animation| {
                animation
                    .timeline
                    .as_ref()
                    .is_some_and(|timeline| timeline.next_us().is_some())
            })
    }

    /// The presented placements changed, or the cell did.
    pub fn replace(&mut self, fragments: &[u8], cell_width: f64, cell_height: f64) {
        self.fragments = fragments.to_vec();
        self.cell = (cell_width, cell_height);
        self.template = None;
        self.prefetch = Prefetch::Owed;
        let mut visible = HashSet::new();
        for fragment in fragments.chunks_exact(FRAGMENT_BYTES) {
            if u16::from_be_bytes([fragment[36], fragment[37]]) != 1 {
                continue;
            }
            let root: [u8; 32] = fragment[4..36].try_into().expect("32 bytes");
            let key = hex(&root);
            visible.insert(key.clone());
            if self.animations.contains_key(&key) {
                continue;
            }
            let demand = GraphicsDemand {
                asset: GraphicsAsset::Animation,
                authority: root,
                frame: 0,
                key: format!("animation:{key}"),
                source: root,
                level: 0,
                x: 0,
                y: 0,
                width: u32::from(u16::from_be_bytes([fragment[38], fragment[39]])),
                height: u32::from_be_bytes(fragment[40..44].try_into().expect("four bytes")),
            };
            self.animations.insert(
                key.clone(),
                Animation {
                    demand,
                    bytes: None,
                    timeline: None,
                    frame: None,
                    root,
                    identity: key,
                    pending: Vec::new(),
                },
            );
        }
        let gone: Vec<String> = self
            .animations
            .keys()
            .filter(|key| !visible.contains(*key))
            .cloned()
            .collect();
        for key in gone {
            if let Some(mut animation) = self.animations.remove(&key) {
                self.release(&mut animation);
            }
        }
        self.deadline_ms = None;
    }

    /// A verified manifest the session delivered for `key`. False when it
    /// names no visible animation, one already playing, or cannot be kept.
    pub fn accept(&mut self, key: &str, mut bytes: Vec<u8>) -> bool {
        let animation = key
            .strip_prefix("animation:")
            .and_then(|identity| self.animations.get_mut(identity));
        let Some(animation) = animation.filter(|animation| {
            animation.timeline.is_none()
                && bytes.len() <= MAX_MANIFEST_BYTES
                && self.retained_bytes + bytes.len() <= RETAINED_BYTES
        }) else {
            bytes.fill(0);
            return false;
        };
        let demand = &animation.demand;
        let Some(timeline) = (self.parse)(&bytes, &demand.source, demand.width, demand.height)
        else {
            bytes.fill(0);
            return false;
        };
        self.retained_bytes += bytes.len();
        animation.bytes = Some(bytes);
        animation.timeline = Some(timeline);
        self.template = None;
        self.prefetch = Prefetch::Owed;
        true
    }

    /// Samples every timeline at `now_ms`, projects what changed, and names
    /// the assets the scene needs that are not `resident`. `admit` is the
    /// host's budget for exactly a working set.
    pub fn render(
        &mut self,
        now_ms: f64,
        admit: &mut dyn FnMut(&Scene) -> bool,
        resident: &dyn Fn(&str) -> bool,
    ) -> Vec<GraphicsDemand> {
        self.deadline_ms = None;
        let now_us = self
            .clock
            .map(|(native_us, local_ms)| native_us + (now_ms - local_ms) * 1_000.0);
        let sample_at = now_us
            .filter(|now_us| now_us.is_finite() && (0.0..=MAX_EXACT_US).contains(now_us))
            .map(|now_us| now_us as u64);
        let mut changed = false;
        let mut deadline_us: Option<u64> = None;
        for animation in self.animations.values_mut() {
            let Some(timeline) = animation.timeline.as_mut() else {
                continue;
            };
            // An incomplete frame owns its requests until every tile is
            // resident: a timeline boundary never cancels a slow transfer.
            if animation.pending.iter().any(|key| !resident(key)) {
                continue;
            }
            let frame = timeline.sample(sample_at);
            let next = timeline.next_us();
            if animation.frame != Some(frame)
                && let Some(root) = animation.entry_root(frame)
            {
                animation.frame = Some(frame);
                animation.root = root;
                animation.identity = hex(&root);
                changed = true;
            }
            if let Some(next) = next
                && now_us.is_some_and(f64::is_finite)
            {
                deadline_us = Some(deadline_us.map_or(next, |known| known.min(next)));
            }
        }
        if changed {
            self.prefetch = Prefetch::Owed;
        }
        if self.template.is_none() {
            let animations = &self.animations;
            let template = project(
                &self.fragments,
                self.cell.0,
                self.cell.1,
                &mut *admit,
                |key, _, _, _| {
                    let animation = animations.get(key)?;
                    let timeline = animation.timeline.as_ref()?;
                    Some(Frame {
                        root: animation.root,
                        frame: animation.frame?,
                        reserve: timeline.next_frame().is_some(),
                    })
                },
            );
            let bound: HashSet<&str> = template.quads.iter().map(|quad| &*quad.key).collect();
            self.static_tiles = template
                .tiles
                .iter()
                .filter(|tile| bound.contains(&*tile.key))
                .cloned()
                .collect();
            self.scene = template.clone();
            self.template = Some(template);
        } else if changed && let Some(template) = &self.template {
            let original: HashMap<&str, &GraphicsDemand> = template
                .tiles
                .iter()
                .map(|tile| (&*tile.key, tile))
                .collect();
            let mut tiles = self.static_tiles.clone();
            let mut keys: HashSet<String> = tiles.iter().map(|tile| tile.key.clone()).collect();
            let mut animations = Vec::new();
            for group in &template.animations {
                let Some(animation) = self.animations.get(&group.key) else {
                    continue;
                };
                let mut bindings = Vec::new();
                for (binding, prior) in &group.bindings {
                    let Some(tile) = original.get(&**prior) else {
                        continue;
                    };
                    let key = format!(
                        "{}:{}:{}:{}",
                        animation.identity, tile.level, tile.x, tile.y
                    );
                    bindings.push((binding.clone(), key.clone()));
                    if keys.insert(key.clone()) {
                        tiles.push(GraphicsDemand {
                            key,
                            authority: animation.demand.authority,
                            source: animation.root,
                            frame: animation.frame.unwrap_or(0),
                            ..(*tile).clone()
                        });
                    }
                }
                animations.push(SceneAnimation {
                    key: group.key.clone(),
                    bindings,
                    reserve: animation
                        .timeline
                        .as_ref()
                        .is_some_and(|timeline| timeline.next_frame().is_some()),
                });
            }
            // Keep admission's packing order even when pixels one frame
            // shared diverge into different frame roots.
            sort_for_allocation(&mut tiles);
            let scene = Scene {
                tiles,
                quads: template.quads.clone(),
                animations,
            };
            if admit(&scene) {
                self.scene = scene;
            } else {
                // Admission picks the common coarser level: a working-set
                // change, never the ordinary frame path.
                self.template = None;
                self.prefetch = Prefetch::Owed;
                return self.render(now_ms, admit, resident);
            }
        }
        // Fetching ahead starts only once every visible tile is resident, in
        // the same budget, and never displaces the visible frame.
        if matches!(self.prefetch, Prefetch::Owed)
            && self.scene.tiles.iter().all(|tile| resident(&tile.key))
        {
            self.prefetch = Prefetch::Settled(self.fetch_ahead(admit));
        }
        let mut demands: Vec<GraphicsDemand> = self
            .animations
            .values()
            .map(|animation| animation.demand.clone())
            .collect();
        demands.extend(
            self.scene()
                .tiles
                .iter()
                .filter(|tile| !resident(&tile.key))
                .cloned(),
        );
        for group in &self.scene.animations {
            if let Some(animation) = self.animations.get_mut(&group.key) {
                animation.pending = group.bindings.iter().map(|(_, key)| key.clone()).collect();
            }
        }
        if !self.suspended
            && let (Some(deadline_us), Some(now_us)) = (deadline_us, now_us)
        {
            self.deadline_ms = Some(now_ms + ((deadline_us as f64 - now_us) / 1_000.0).max(0.0));
        }
        demands
    }

    /// The visible scene with every animation's next frame's tiles too, if
    /// there are any and `admit` takes them.
    fn fetch_ahead(&self, admit: &mut dyn FnMut(&Scene) -> bool) -> Option<Scene> {
        let visible: HashMap<&str, &GraphicsDemand> = self
            .scene
            .tiles
            .iter()
            .map(|tile| (&*tile.key, tile))
            .collect();
        let mut tiles = self.scene.tiles.clone();
        let mut keys: HashSet<String> = tiles.iter().map(|tile| tile.key.clone()).collect();
        for group in &self.scene.animations {
            let Some(animation) = self.animations.get(&group.key) else {
                continue;
            };
            let Some(next) = animation
                .timeline
                .as_ref()
                .and_then(|timeline| timeline.next_frame())
                .filter(|next| animation.frame != Some(*next))
            else {
                continue;
            };
            let Some(root) = animation.entry_root(next) else {
                continue;
            };
            let identity = hex(&root);
            for (_, current) in &group.bindings {
                let Some(tile) = visible.get(&**current) else {
                    continue;
                };
                let key = format!("{identity}:{}:{}:{}", tile.level, tile.x, tile.y);
                if keys.insert(key.clone()) {
                    tiles.push(GraphicsDemand {
                        key,
                        authority: animation.demand.authority,
                        source: root,
                        frame: next,
                        ..(*tile).clone()
                    });
                }
            }
        }
        if tiles.len() == self.scene.tiles.len() {
            return None;
        }
        sort_for_allocation(&mut tiles);
        let candidate = Scene {
            tiles,
            ..self.scene.clone()
        };
        admit(&candidate).then_some(candidate)
    }

    /// Whether the viewer is hidden: a hidden one owns no deadline. True when
    /// a timeline must be sampled again.
    pub fn suspend(&mut self, suspended: bool) -> bool {
        self.suspended = suspended;
        self.deadline_ms = None;
        !suspended && !self.animations.is_empty()
    }

    /// A new authenticated lineage: its daemon's clock and assets start over.
    pub fn clear(&mut self) {
        self.deadline_ms = None;
        let animations = std::mem::take(&mut self.animations);
        for (_, mut animation) in animations {
            self.release(&mut animation);
        }
        self.fragments.clear();
        self.template = None;
        self.prefetch = Prefetch::Owed;
        self.static_tiles.clear();
        self.scene = Scene::default();
        self.clock = None;
    }

    fn release(&mut self, animation: &mut Animation) {
        animation.timeline = None;
        if let Some(mut bytes) = animation.bytes.take() {
            self.retained_bytes -= bytes.len();
            bytes.fill(0);
        }
    }
}

#[cfg(test)]
mod tests;
