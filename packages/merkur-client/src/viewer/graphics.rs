//! The presented scene's images as tiles and quads: the port of `scene.ts`.
//!
//! The grid exports one fragment per row of each placement, 124 bytes each,
//! in canonical alpha order. Every placement is sampled at one pyramid level,
//! the one its smallest footprint needs, so its clipped rows share their
//! seams. Each level is cut into 256-pixel tiles stored with a one-pixel
//! gutter, and each fragment into one quad per tile it crosses, whose edges
//! are computed once where two quads meet.
//!
//! A quad names its tile by binding: the placement's own pixels, level and
//! tile. A static image's binding is its tile's key. An animated placement is
//! projected at the frame its timeline selects, and its group maps each
//! binding to that frame's tile, so a frame change swaps tiles under the same
//! quads.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::session::graphics::{GraphicsAsset, GraphicsDemand};

pub(super) const FRAGMENT_BYTES: usize = 124;
const TILE_SIDE: u32 = 256;
/// The stored tile's side, gutters included.
const STORED_SIDE: f64 = 258.0;
/// Distinct tiles, and distinct bindings, in one scene.
const MAX_TILES: usize = 4_096;
const MAX_QUADS: usize = 262_144;
/// Coarser levels tried, all placements together, before nothing is shown.
const MAX_REDUCTION: u32 = 14;

/// One tile's part of one fragment, in the host's pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct Quad {
    /// The tile's binding: its key, or for an animated placement the key its
    /// group maps it to.
    pub key: String,
    /// Below text, below the default background, or above text.
    pub layer: u8,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    /// The source rectangle in the stored tile, as fractions of its side.
    pub u: f64,
    pub v: f64,
    pub uw: f64,
    pub vh: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scene {
    /// Largest first, which keeps small gutters from fragmenting the space
    /// full tiles need.
    pub tiles: Vec<GraphicsDemand>,
    /// Shared by every frame of the scene's animations.
    pub quads: Rc<[Quad]>,
    pub animations: Vec<SceneAnimation>,
}

/// One animated image's bindings, each to its current frame's tile.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneAnimation {
    /// The image's pixel root, in hex.
    pub key: String,
    /// Whether its timeline will move to another frame.
    pub reserve: bool,
    /// `(binding, tile key)`, in the order the fragments named them.
    pub bindings: Vec<(String, String)>,
}

/// The frame an animated placement shows, as its timeline selects it.
pub struct Frame {
    pub root: [u8; 32],
    pub frame: u32,
    pub reserve: bool,
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

/// A 32.32 fixed-point value.
fn fixed(bytes: &[u8], at: usize) -> f64 {
    f64::from(u32_at(bytes, at)) + f64::from(u32_at(bytes, at + 4)) / 4_294_967_296.0
}

/// The scene at the finest levels `admit` takes, or an empty one. `admit` is
/// the host's resource budget for exactly this working set. `resolve` names
/// an animated image's current frame from its pixel root in hex, the root,
/// and its size; one it cannot is not shown.
pub fn project(
    fragments: &[u8],
    cell_width: f64,
    cell_height: f64,
    mut admit: impl FnMut(&Scene) -> bool,
    mut resolve: impl FnMut(&str, &[u8; 32], u32, u32) -> Option<Frame>,
) -> Scene {
    if !fragments.len().is_multiple_of(FRAGMENT_BYTES) {
        return Scene::default();
    }
    for reduction in 0..=MAX_REDUCTION {
        if let Some(scene) =
            project_level(fragments, cell_width, cell_height, reduction, &mut resolve)
            && admit(&scene)
        {
            return scene;
        }
    }
    let empty = Scene::default();
    admit(&empty);
    empty
}

fn project_level(
    fragments: &[u8],
    cell_width: f64,
    cell_height: f64,
    reduction: u32,
    resolve: &mut impl FnMut(&str, &[u8; 32], u32, u32) -> Option<Frame>,
) -> Option<Scene> {
    // One sampling ratio per placement: its smallest, over every clipped row.
    let mut footprints: Vec<(u64, f64)> = Vec::new();
    for fragment in fragments.chunks_exact(FRAGMENT_BYTES) {
        let placement = u64::from_be_bytes(fragment[52..60].try_into().expect("eight bytes"));
        let sx = fixed(fragment, 100) - fixed(fragment, 92);
        let sy = fixed(fragment, 116) - fixed(fragment, 108);
        let dx = (fixed(fragment, 68) - fixed(fragment, 60)) * cell_width;
        let dy = (fixed(fragment, 84) - fixed(fragment, 76)) * cell_height;
        let ratio = (sx / dx).min(sy / dy);
        match footprints.iter_mut().find(|(id, _)| *id == placement) {
            Some((_, known)) => *known = known.min(ratio),
            None => footprints.push((placement, ratio)),
        }
    }
    let mut tiles: Vec<GraphicsDemand> = Vec::new();
    let mut keys: HashSet<String> = HashSet::new();
    let mut bindings: HashSet<String> = HashSet::new();
    let mut quads = Vec::new();
    let mut animations: Vec<SceneAnimation> = Vec::new();
    let mut groups: HashMap<String, usize> = HashMap::new();
    for fragment in fragments.chunks_exact(FRAGMENT_BYTES) {
        let row = f64::from(u32_at(fragment, 0));
        let root: [u8; 32] = fragment[4..36].try_into().expect("32 bytes");
        let identity = crate::hex(&root);
        let source_width = u32::from(u16_at(fragment, 38));
        let source_height = u32_at(fragment, 40);
        let animated = u16_at(fragment, 36) == 1;
        let selected = if animated {
            let Some(selected) = resolve(&identity, &root, source_width, source_height) else {
                continue;
            };
            Some(selected)
        } else {
            None
        };
        let pixels = selected
            .as_ref()
            .map_or_else(|| identity.clone(), |selected| crate::hex(&selected.root));
        let placement = u64::from_be_bytes(fragment[52..60].try_into().expect("eight bytes"));
        let ratio = footprints
            .iter()
            .find(|(id, _)| *id == placement)
            .map_or(1.0, |(_, ratio)| *ratio);
        let maximum = f64::from(source_width.max(source_height)).log2().ceil() as u32;
        let level = maximum.min(ratio.max(1.0).log2().floor().max(0.0) as u32 + reduction);
        let scale = 2f64.powi(level as i32);
        let width = (f64::from(source_width) / scale).ceil() as u32;
        let height = (f64::from(source_height) / scale).ceil() as u32;
        let z = i32::from_be_bytes(fragment[44..48].try_into().expect("four bytes"));
        let layer = if z < -1_073_741_824 {
            0
        } else if z < 0 {
            1
        } else {
            2
        };
        let left = fixed(fragment, 60) * cell_width;
        let right = fixed(fragment, 68) * cell_width;
        let top = (row + fixed(fragment, 76)) * cell_height;
        let bottom = (row + fixed(fragment, 84)) * cell_height;
        let sl = fixed(fragment, 92) / scale;
        let sr = fixed(fragment, 100) / scale;
        let st = fixed(fragment, 108) / scale;
        let sb = fixed(fragment, 116) / scale;
        let last_x = width.saturating_sub(1);
        let last_y = height.saturating_sub(1);
        let first_tx = (last_x.min(sl.floor() as u32)) / TILE_SIDE;
        let last_tx =
            (last_x.min((sl.floor() as u32).max((sr.ceil() as u32).saturating_sub(1)))) / TILE_SIDE;
        let first_ty = (last_y.min(st.floor() as u32)) / TILE_SIDE;
        let last_ty =
            (last_y.min((st.floor() as u32).max((sb.ceil() as u32).saturating_sub(1)))) / TILE_SIDE;
        for ty in first_ty..=last_ty {
            for tx in first_tx..=last_tx {
                let (x0, y0) = (f64::from(tx * TILE_SIDE), f64::from(ty * TILE_SIDE));
                let key = format!("{pixels}:{level}:{tx}:{ty}");
                let binding = format!("{identity}:{level}:{tx}:{ty}");
                if bindings.insert(binding.clone()) {
                    if bindings.len() > MAX_TILES {
                        return None;
                    }
                    // Every row of one image binds the same frame's tile.
                    if let Some(selected) = &selected {
                        let group = *groups.entry(identity.clone()).or_insert_with(|| {
                            animations.push(SceneAnimation {
                                key: identity.clone(),
                                reserve: selected.reserve,
                                bindings: Vec::new(),
                            });
                            animations.len() - 1
                        });
                        animations[group]
                            .bindings
                            .push((binding.clone(), key.clone()));
                    }
                }
                if !keys.contains(&key) {
                    if tiles.len() >= MAX_TILES {
                        return None;
                    }
                    keys.insert(key.clone());
                    tiles.push(GraphicsDemand {
                        asset: GraphicsAsset::Tile,
                        authority: root,
                        frame: selected.as_ref().map_or(0, |selected| selected.frame),
                        key,
                        source: selected.as_ref().map_or(root, |selected| selected.root),
                        level: level as u8,
                        x: tx,
                        y: ty,
                        width: TILE_SIDE.min(width - tx * TILE_SIDE) + 2,
                        height: TILE_SIDE.min(height - ty * TILE_SIDE) + 2,
                    });
                }
                let a = sl.max(x0);
                let b = sr.min(x0 + f64::from(TILE_SIDE));
                let c = st.max(y0);
                let d = sb.min(y0 + f64::from(TILE_SIDE));
                if quads.len() >= MAX_QUADS {
                    return None;
                }
                // A tile boundary maps to one destination value from either
                // side, and a placement edge is the fragment's own edge.
                let across = |at: f64| left + (right - left) * (at - sl) / (sr - sl);
                let down = |at: f64| top + (bottom - top) * (at - st) / (sb - st);
                quads.push(Quad {
                    key: binding,
                    layer,
                    left: if a == sl { left } else { across(a) },
                    top: if c == st { top } else { down(c) },
                    right: if b == sr { right } else { across(b) },
                    bottom: if d == sb { bottom } else { down(d) },
                    u: (a - x0 + 1.0) / STORED_SIDE,
                    v: (c - y0 + 1.0) / STORED_SIDE,
                    uw: (b - a) / STORED_SIDE,
                    vh: (d - c) / STORED_SIDE,
                });
            }
        }
    }
    sort_for_allocation(&mut tiles);
    Some(Scene {
        tiles,
        quads: quads.into(),
        animations,
    })
}

/// Largest first, stable, so tiny gutters cannot fragment the space full tiles
/// need.
pub(super) fn sort_for_allocation(tiles: &mut [GraphicsDemand]) {
    tiles.sort_by(|a, b| b.height.cmp(&a.height).then(b.width.cmp(&a.width)));
}

#[cfg(test)]
mod tests;
