//! The scene's images through the viewer: what it asks the session for, and
//! when, across fences, residency, manifests and the daemon's clock.

use merkur_graphics::animation::{Entry, Manifest, Mode, Playback as Timeline};
use merkur_graphics::budget::{Budget, Usage};

use super::*;
use crate::session::graphics::GraphicsAsset;

/// One placement of a 512x1 image shown one to one over 512x1 cells of one
/// pixel: two tiles.
fn placement(root: [u8; 32], animated: bool) -> Vec<u8> {
    let mut bytes = vec![0; 124];
    bytes[4..36].copy_from_slice(&root);
    bytes[36..38].copy_from_slice(&u16::from(animated).to_be_bytes());
    bytes[38..40].copy_from_slice(&512u16.to_be_bytes());
    bytes[40..44].copy_from_slice(&1u32.to_be_bytes());
    bytes[52..60].copy_from_slice(&1u64.to_be_bytes());
    for (index, value) in [0u64, 512, 0, 1, 0, 512, 0, 1].into_iter().enumerate() {
        let at = 60 + index * 8;
        bytes[at..at + 8].copy_from_slice(&(value << 32).to_be_bytes());
    }
    bytes
}

/// A looping 512x1 animation of two 100 ms frames, anchored at the daemon's
/// zero: its manifest and root.
fn two_frame_loop() -> (Vec<u8>, [u8; 32]) {
    let charge = Manifest::charge(2).expect("two frames");
    let budget = Budget::new(Usage {
        bytes: 1 << 20,
        objects: 16,
    });
    let mut lease = budget.reserve(charge).expect("room");
    let manifest = Manifest::new(
        512,
        1,
        1,
        Timeline {
            mode: Mode::Loop,
            anchor_us: 0,
            frame: 0,
            loops: 0,
            completed: 0,
            elapsed_us: 0,
        },
        &[
            Entry {
                root: [1; 32],
                gap_ms: 100,
            },
            Entry {
                root: [2; 32],
                gap_ms: 100,
            },
        ],
        &mut lease,
    )
    .expect("a valid manifest");
    (manifest.bytes().to_vec(), manifest.root())
}

fn scene_of(fragments: Vec<u8>) -> Viewer<FakeGrid> {
    let mut viewer = Viewer::new(FakeGrid {
        graphics_revision: 1,
        graphics_fragments: fragments,
        ..FakeGrid::default()
    });
    viewer.fence(0.0, DisplayFence { lineage: 1 });
    viewer.set_cell_size(0.0, 1.0, 1.0);
    viewer
}

/// Every graphics demand in `outputs`, by lineage.
fn asked(outputs: Vec<Output>) -> Vec<(u32, Vec<GraphicsDemand>)> {
    outputs
        .into_iter()
        .filter_map(|output| match output {
            Output::GraphicsDemand { epoch, demands } => Some((epoch, demands)),
            _ => None,
        })
        .collect()
}

fn tiles(demands: &[GraphicsDemand]) -> Vec<&GraphicsDemand> {
    demands
        .iter()
        .filter(|demand| demand.asset == GraphicsAsset::Tile)
        .collect()
}

#[test]
fn a_fence_asks_the_new_lineage_for_the_whole_scene_again() {
    let mut viewer = scene_of(placement([7; 32], false));
    let [(1, first)] = &asked(drain(&mut viewer, 0.0))[..] else {
        panic!("one demand for lineage 1");
    };
    assert_eq!(first.len(), 2);
    // A static scene asks for nothing more as its tiles arrive.
    viewer.set_graphics_resident(0.0, 1, &first[0].key, true);
    assert!(asked(drain(&mut viewer, 0.0)).is_empty());
    viewer.fence(1.0, DisplayFence { lineage: 2 });
    assert_eq!(asked(drain(&mut viewer, 1.0)), [(2, first.clone())]);
    // What the host held belongs to the ended lineage.
    viewer.set_graphics_resident(1.0, 1, &first[1].key, true);
    assert!(asked(drain(&mut viewer, 1.0)).is_empty());
}

#[test]
fn an_animated_image_plays_on_the_daemon_clock_the_heartbeat_maps() {
    let (manifest, root) = two_frame_loop();
    let mut viewer = scene_of(placement(root, true));
    // Its manifest first: an animated image shows nothing without a timeline.
    let [(1, first)] = &asked(drain(&mut viewer, 0.0))[..] else {
        panic!("one demand for lineage 1");
    };
    let [manifest_demand] = &first[..] else {
        panic!("only the manifest: {first:?}");
    };
    assert_eq!(manifest_demand.asset, GraphicsAsset::Animation);
    // A manifest of another lineage starts nothing.
    viewer.graphics_manifest(0.0, 2, &manifest_demand.key, manifest.clone());
    assert!(asked(drain(&mut viewer, 0.0)).is_empty());

    // Unmapped, the timeline holds its anchor frame.
    viewer.graphics_manifest(0.0, 1, &manifest_demand.key, manifest);
    let [(1, anchored)] = &asked(drain(&mut viewer, 0.0))[..] else {
        panic!("the anchor frame's tiles");
    };
    let shown = tiles(anchored);
    assert_eq!(shown.len(), 2);
    assert!(
        shown
            .iter()
            .all(|tile| tile.source == [1; 32] && tile.frame == 0)
    );
    let bindings: Vec<String> = viewer
        .graphics_scene()
        .quads
        .iter()
        .map(|quad| quad.key.clone())
        .collect();

    // Once the visible frame is held, the next one is fetched ahead.
    for tile in &shown {
        viewer.set_graphics_resident(0.0, 1, &tile.key, true);
    }
    let ahead = asked(drain(&mut viewer, 0.0));
    let (_, ahead) = ahead.last().expect("the next frame fetched ahead");
    assert!(
        tiles(ahead)
            .iter()
            .all(|tile| tile.source == [2; 32] && tile.frame == 1)
    );

    // The daemon read 50 ms at the viewer's 1000 ms: frame 1 is due 50 ms on.
    viewer.graphics_clock(1_000.0, 50_000, 0.0);
    assert!(
        viewer
            .graphics_scene()
            .tiles
            .iter()
            .any(|tile| tile.source == [1; 32])
    );
    viewer.handle_timeout(1_049.0);
    assert!(
        viewer
            .graphics_scene()
            .tiles
            .iter()
            .any(|tile| tile.source == [1; 32])
    );
    viewer.handle_timeout(1_050.0);
    let scene = viewer.graphics_scene();
    let (visible, next): (Vec<_>, Vec<_>) =
        scene.tiles.iter().partition(|tile| tile.source == [2; 32]);
    assert_eq!(visible.len(), 2);
    assert!(visible.iter().all(|tile| tile.frame == 1));
    // Frame 0 comes round again and is fetched ahead as the loop's next.
    assert!(next.iter().all(|tile| tile.source == [1; 32]));
    // The same quads, bound to the new frame's tiles.
    let rebound: Vec<String> = scene.quads.iter().map(|quad| quad.key.clone()).collect();
    assert_eq!(rebound, bindings);
    assert!(
        scene.animations[0]
            .bindings
            .iter()
            .all(|(_, key)| key.starts_with(&crate::hex(&[2; 32])))
    );
}

#[test]
fn a_hidden_view_samples_no_timeline() {
    let (manifest, root) = two_frame_loop();
    let mut viewer = scene_of(placement(root, true));
    let key = asked(drain(&mut viewer, 0.0))[0].1[0].key.clone();
    viewer.graphics_manifest(0.0, 1, &key, manifest);
    viewer.graphics_clock(1_000.0, 50_000, 0.0);
    let shown: Vec<String> = viewer
        .graphics_scene()
        .tiles
        .iter()
        .map(|tile| tile.key.clone())
        .collect();
    for key in &shown {
        viewer.set_graphics_resident(1_000.0, 1, key, true);
    }
    // Hidden before frame 1 was due at 1050 ms: no deadline, no sample.
    drain(&mut viewer, 1_000.0);
    viewer.set_visible(1_016.0, false);
    assert!(
        drain(&mut viewer, 1_016.0)
            .iter()
            .all(|output| !matches!(output, Output::Ack { .. }))
    );
    assert_eq!(viewer.playback.deadline_ms(), None);
    viewer.handle_timeout(1_060.0);
    assert!(
        viewer
            .graphics_scene()
            .animations
            .iter()
            .all(|group| group.bindings.iter().all(|(_, key)| shown.contains(key)))
    );
    // Visible again inside frame 1's 100 ms: it is sampled at once.
    viewer.set_visible(1_100.0, true);
    assert!(
        viewer.graphics_scene().animations[0]
            .bindings
            .iter()
            .all(|(_, key)| !shown.contains(key))
    );
}

#[test]
fn the_renderer_refusal_selects_one_coarser_scene_before_requesting_assets() {
    let mut viewer = Viewer::new(FakeGrid {
        graphics_revision: 1,
        graphics_fragments: placement([7; 32], false),
        graphics_tile_limit: Some(1),
        ..FakeGrid::default()
    });
    viewer.fence(0.0, DisplayFence { lineage: 1 });
    viewer.set_cell_size(0.0, 1.0, 1.0);
    assert_eq!(viewer.grid.graphics_admissions, [2, 1]);
    let demands = asked(drain(&mut viewer, 0.0));
    let [(1, demands)] = &demands[..] else {
        panic!("one admitted demand");
    };
    assert_eq!(demands.len(), 1);
    assert_eq!(demands[0].level, 1);
    assert_eq!(viewer.graphics_scene().tiles, *demands);
}

#[test]
fn total_renderer_refusal_has_a_bounded_retry_and_requests_no_assets() {
    let mut viewer = Viewer::new(FakeGrid {
        graphics_revision: 1,
        graphics_fragments: placement([7; 32], false),
        graphics_tile_limit: Some(0),
        ..FakeGrid::default()
    });
    viewer.fence(0.0, DisplayFence { lineage: 1 });
    viewer.set_cell_size(0.0, 1.0, 1.0);
    assert_eq!(viewer.grid.graphics_admissions.len(), 16);
    assert_eq!(viewer.grid.graphics_admissions.last(), Some(&0));
    assert!(viewer.graphics_scene().tiles.is_empty());
    assert!(viewer.graphics_scene().quads.is_empty());
    assert!(asked(drain(&mut viewer, 0.0)).is_empty());
}
