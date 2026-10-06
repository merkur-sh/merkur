//! `scene.ts`'s projection over fragments laid out as the grid exports them.

use super::*;

const ROOT: [u8; 32] = [0xab; 32];

fn put_fixed(fragment: &mut [u8], at: usize, value: f64) {
    let int = value.floor();
    fragment[at..at + 4].copy_from_slice(&(int as u32).to_be_bytes());
    let frac = ((value - int) * 4_294_967_296.0) as u32;
    fragment[at + 4..at + 8].copy_from_slice(&frac.to_be_bytes());
}

/// One fragment of placement `placement`: rows `dest` of cells shown from
/// source pixels `source`, both `(left, top, right, bottom)`.
fn fragment(
    placement: u64,
    size: (u16, u32),
    dest: (f64, f64, f64, f64),
    source: (f64, f64, f64, f64),
    animated: bool,
) -> Vec<u8> {
    let mut bytes = vec![0; FRAGMENT_BYTES];
    bytes[4..36].copy_from_slice(&ROOT);
    bytes[36..38].copy_from_slice(&u16::from(animated).to_be_bytes());
    bytes[38..40].copy_from_slice(&size.0.to_be_bytes());
    bytes[40..44].copy_from_slice(&size.1.to_be_bytes());
    bytes[52..60].copy_from_slice(&placement.to_be_bytes());
    put_fixed(&mut bytes, 60, dest.0);
    put_fixed(&mut bytes, 68, dest.2);
    put_fixed(&mut bytes, 76, dest.1);
    put_fixed(&mut bytes, 84, dest.3);
    put_fixed(&mut bytes, 92, source.0);
    put_fixed(&mut bytes, 100, source.2);
    put_fixed(&mut bytes, 108, source.1);
    put_fixed(&mut bytes, 116, source.3);
    bytes
}

/// No animated image has a timeline.
fn still(_: &str, _: &[u8; 32], _: u32, _: u32) -> Option<Frame> {
    None
}

fn shape(scene: &Scene) -> Vec<(String, u32, u32)> {
    scene
        .tiles
        .iter()
        .map(|tile| (tile.key.clone(), tile.width, tile.height))
        .collect()
}

#[test]
fn an_image_at_its_own_size_is_cut_into_gutter_bordered_tiles_largest_first() {
    // 600x300 pixels over 60x15 cells of 10x20 pixels: one to one.
    let bytes = fragment(
        1,
        (600, 300),
        (0.0, 0.0, 60.0, 15.0),
        (0.0, 0.0, 600.0, 300.0),
        false,
    );
    let scene = project(&bytes, 10.0, 20.0, |_| true, still);
    let root = crate::hex(&ROOT);
    let key = |x: u32, y: u32| format!("{root}:0:{x}:{y}");
    assert_eq!(
        shape(&scene),
        [
            (key(0, 0), 258, 258),
            (key(1, 0), 258, 258),
            (key(2, 0), 90, 258),
            (key(0, 1), 258, 46),
            (key(1, 1), 258, 46),
            (key(2, 1), 90, 46),
        ]
    );
    assert_eq!(scene.quads.len(), 6);
    let first = &scene.quads[0];
    assert_eq!((first.left, first.top, first.right), (0.0, 0.0, 256.0));
    assert_eq!((first.u, first.uw), (1.0 / 258.0, 256.0 / 258.0));
    let last = scene.quads.last().expect("a quad");
    assert_eq!((last.right, last.bottom), (600.0, 300.0));
}

#[test]
fn a_placement_shown_at_half_size_samples_the_next_level() {
    let bytes = fragment(
        1,
        (600, 300),
        (0.0, 0.0, 30.0, 7.5),
        (0.0, 0.0, 600.0, 300.0),
        false,
    );
    let scene = project(&bytes, 10.0, 20.0, |_| true, still);
    let root = crate::hex(&ROOT);
    assert_eq!(
        shape(&scene),
        [
            (format!("{root}:1:0:0"), 258, 152),
            (format!("{root}:1:1:0"), 46, 152),
        ]
    );
}

#[test]
fn an_animated_placement_shows_the_frame_its_timeline_selects() {
    let bytes = fragment(
        1,
        (100, 100),
        (0.0, 0.0, 10.0, 5.0),
        (0.0, 0.0, 100.0, 100.0),
        true,
    );
    // No timeline yet: nothing to show.
    assert_eq!(
        project(&bytes, 10.0, 20.0, |_| true, still),
        Scene::default()
    );

    let frame_root = [0xcd; 32];
    let scene = project(
        &bytes,
        10.0,
        20.0,
        |_| true,
        |identity, root, width, height| {
            assert_eq!(
                (identity, root, width, height),
                (&*crate::hex(&ROOT), &ROOT, 100, 100)
            );
            Some(Frame {
                root: frame_root,
                frame: 3,
                reserve: true,
            })
        },
    );
    let binding = format!("{}:0:0:0", crate::hex(&ROOT));
    let key = format!("{}:0:0:0", crate::hex(&frame_root));
    let [tile] = &scene.tiles[..] else {
        panic!("one tile: {scene:?}");
    };
    assert_eq!(
        (&tile.key, tile.frame, tile.source, tile.authority),
        (&key, 3, frame_root, ROOT)
    );
    assert_eq!(scene.quads[0].key, binding);
    assert_eq!(
        scene.animations,
        [SceneAnimation {
            key: crate::hex(&ROOT),
            reserve: true,
            bindings: vec![(binding, key)],
        }]
    );
}

#[test]
fn a_working_set_the_host_refuses_is_sampled_coarser() {
    let bytes = fragment(
        1,
        (600, 300),
        (0.0, 0.0, 60.0, 15.0),
        (0.0, 0.0, 600.0, 300.0),
        false,
    );
    let scene = project(&bytes, 10.0, 20.0, |scene| scene.tiles.len() <= 2, still);
    assert_eq!(scene.tiles.len(), 2);
    assert!(scene.tiles.iter().all(|tile| tile.level == 1));
}
