//! `playback.test.ts`, over a timeline that selects frame 1 from the daemon's
//! first second on.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use super::*;

/// One animated (`kind` 1) or static (0) placement of a 512x1 image, shown
/// one to one over a 512x1 cell area.
fn fragment(kind: u16) -> Vec<u8> {
    let mut bytes = vec![0; FRAGMENT_BYTES];
    bytes[4..36].fill(7);
    bytes[36..38].copy_from_slice(&kind.to_be_bytes());
    bytes[38..40].copy_from_slice(&512u16.to_be_bytes());
    bytes[40..44].copy_from_slice(&1u32.to_be_bytes());
    bytes[52..60].copy_from_slice(&1u64.to_be_bytes());
    for (index, value) in [0u64, 512, 0, 1, 0, 512, 0, 1].into_iter().enumerate() {
        let at = 60 + index * 8;
        bytes[at..at + 8].copy_from_slice(&(value << 32).to_be_bytes());
    }
    bytes
}

/// Two frames, whose pixel roots are all ones and all twos.
fn manifest() -> Vec<u8> {
    let mut bytes = vec![0; HEADER_BYTES + 2 * ENTRY_BYTES];
    bytes[64..96].fill(1);
    bytes[100..132].fill(2);
    bytes
}

#[derive(Default)]
struct Probe {
    now_ms: Cell<f64>,
    samples: RefCell<Vec<Option<u64>>>,
    frees: Cell<u32>,
    prefetch: bool,
}

struct Fake(Rc<Probe>);

impl Timeline for Fake {
    fn sample(&mut self, now_us: Option<u64>) -> u32 {
        self.0.samples.borrow_mut().push(now_us);
        u32::from(now_us.is_some_and(|now_us| now_us >= 1_000_000))
    }

    fn next_us(&self) -> Option<u64> {
        None
    }

    fn next_frame(&self) -> Option<u32> {
        (self.0.prefetch && self.0.now_ms.get() < 1_000.0).then_some(1)
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.0.frees.set(self.0.frees.get() + 1);
    }
}

struct Harness {
    player: Playback,
    probe: Rc<Probe>,
    resident: HashSet<String>,
    admit: Box<dyn FnMut(&Scene) -> bool>,
    /// The animation's manifest demand.
    key: String,
}

impl Harness {
    fn new(prefetch: bool, admit: impl FnMut(&Scene) -> bool + 'static) -> Self {
        let probe = Rc::new(Probe {
            prefetch,
            ..Probe::default()
        });
        let timelines = Rc::clone(&probe);
        let mut harness = Self {
            player: Playback::new(Box::new(move |_, _, _, _| {
                Some(Box::new(Fake(Rc::clone(&timelines))) as Box<dyn Timeline>)
            })),
            probe,
            resident: HashSet::new(),
            admit: Box::new(admit),
            key: String::new(),
        };
        harness.player.replace(&fragment(1), 1.0, 1.0);
        harness.key = harness.render()[0].key.clone();
        harness
    }

    fn render(&mut self) -> Vec<GraphicsDemand> {
        let resident = &self.resident;
        self.player
            .render(self.probe.now_ms.get(), &mut *self.admit, &|key| {
                resident.contains(key)
            })
    }

    fn scene(&self) -> Scene {
        self.player.scene().clone()
    }

    fn hold(&mut self, scene: &Scene) {
        self.resident
            .extend(scene.tiles.iter().map(|tile| tile.key.clone()));
    }
}

fn assets(demands: &[GraphicsDemand]) -> Vec<GraphicsAsset> {
    demands.iter().map(|demand| demand.asset).collect()
}

#[test]
fn a_slow_frame_keeps_its_requests_until_every_tile_is_resident_and_reuses_its_quads() {
    let mut h = Harness::new(false, |_| true);
    assert!(h.player.accept(&h.key.clone(), manifest()));
    h.player.calibrate(0, 0.0, 0.0);
    h.render();
    let first = h.scene();
    assert_eq!(first.tiles.len(), 2);
    h.resident.insert(first.tiles[0].key.clone());
    h.probe.now_ms.set(1_500.0);
    h.render();
    assert_eq!(h.scene(), first);
    assert_eq!(*h.probe.samples.borrow(), [Some(0)]);

    h.resident.insert(first.tiles[1].key.clone());
    h.render();
    let second = h.scene();
    assert!(Rc::ptr_eq(&second.quads, &first.quads));
    assert!(
        second
            .tiles
            .iter()
            .all(|tile| tile.frame == 1 && tile.source[0] == 2)
    );
    let bindings = |scene: &Scene| -> Vec<String> {
        scene.animations[0]
            .bindings
            .iter()
            .map(|(binding, _)| binding.clone())
            .collect()
    };
    assert_eq!(bindings(&second), bindings(&first));
    h.hold(&second);
    assert_eq!(assets(&h.render()), [GraphicsAsset::Animation]);
}

#[test]
fn an_unmapped_clock_holds_the_declared_frame_and_clear_releases_every_manifest() {
    let mut h = Harness::new(false, |_| true);
    assert!(h.player.accept(&h.key.clone(), manifest()));
    h.probe.now_ms.set(1e9);
    h.render();
    let scene = h.scene();
    assert!(!scene.tiles.is_empty());
    assert!(scene.tiles.iter().all(|tile| tile.frame == 0));
    assert_eq!(h.probe.samples.borrow()[0], None);
    h.player.clear();
    assert_eq!(h.probe.frees.get(), 1);
    assert!(!h.player.accept(&h.key.clone(), vec![0; 100]));
    assert!(!h.player.calibrate(100, 100.0, 10.0));
}

#[test]
fn hiding_cancels_wakeups_and_removing_the_last_placement_releases_its_timeline() {
    let mut h = Harness::new(false, |_| true);
    h.player.accept(&h.key.clone(), manifest());
    h.player.suspend(true);
    assert!(!h.player.calibrate(100, 0.0, 10.0));
    assert!(h.player.suspend(false));
    h.player.replace(&[], 1.0, 1.0);
    assert_eq!(h.probe.frees.get(), 1);
    assert!(h.render().is_empty());
    assert!(!h.player.active());
    for i in 0..100u32 {
        assert!(
            !h.player
                .calibrate(u64::from(i) * 2_000, f64::from(i * 2), 1.0)
        );
    }
    assert!(!h.player.suspend(false));
    assert!(!h.player.accept(&h.key.clone(), vec![0; 100]));
}

#[test]
fn a_static_image_neither_requests_a_manifest_nor_parses_a_timeline() {
    let mut player = Playback::new(Box::new(|_, _, _, _| panic!("static parse")));
    player.replace(&fragment(0), 1.0, 1.0);
    assert!(!player.calibrate(100, 0.0, 10.0));
    let demands = player.render(0.0, &mut |_| true, &|_| false);
    assert!(!demands.is_empty());
    assert!(
        demands
            .iter()
            .all(|demand| demand.asset == GraphicsAsset::Tile)
    );
    assert!(!player.active());
}

#[test]
fn clock_samples_do_not_wake_a_stopped_or_completed_timeline() {
    let mut h = Harness::new(false, |_| true);
    assert!(h.player.accept(&h.key.clone(), manifest()));
    h.render();
    for i in 0..100u32 {
        assert!(
            !h.player
                .calibrate(u64::from(i) * 2_000, f64::from(i * 2), 1.0)
        );
    }
    assert_eq!(h.player.deadline_ms(), None);
}

#[test]
fn the_next_frame_is_fetched_once_the_visible_one_is_resident_and_reuses_its_quads() {
    let mut h = Harness::new(true, |_| true);
    h.player.accept(&h.key.clone(), manifest());
    h.player.calibrate(0, 0.0, 0.0);
    h.render();
    let first = h.scene();
    assert_eq!(first.tiles.len(), 2);
    h.hold(&first);
    let demands = h.render();
    let ahead = h.scene();
    assert_eq!(ahead.tiles.len(), 4);
    assert!(Rc::ptr_eq(&ahead.quads, &first.quads));
    assert!(
        demands
            .iter()
            .filter(|demand| demand.asset == GraphicsAsset::Tile)
            .all(|demand| demand.frame == 1)
    );
    h.render();
    assert_eq!(h.scene(), ahead);

    h.hold(&ahead);
    h.probe.now_ms.set(1_500.0);
    let demands = h.render();
    let next = h.scene();
    assert!(Rc::ptr_eq(&next.quads, &first.quads));
    assert_eq!(assets(&demands), [GraphicsAsset::Animation]);
    assert!(next.tiles.iter().all(|tile| tile.frame == 1));
}

#[test]
fn fetching_ahead_never_lowers_the_visible_level_or_asks_for_unadmitted_pixels() {
    let rejected = Rc::new(Cell::new(0));
    let counted = Rc::clone(&rejected);
    let mut h = Harness::new(true, move |scene| {
        if scene.tiles.len() <= 2 {
            return true;
        }
        counted.set(counted.get() + 1);
        false
    });
    h.player.accept(&h.key.clone(), manifest());
    h.player.calibrate(0, 0.0, 0.0);
    h.render();
    let first = h.scene();
    h.hold(&first);
    h.render();
    assert_eq!(h.scene(), first);
    assert_eq!(assets(&h.render()), [GraphicsAsset::Animation]);
    assert_eq!(rejected.get(), 1);
}

#[test]
fn a_moving_timeline_owns_one_deadline_on_the_viewer_clock() {
    struct Moving;
    impl Timeline for Moving {
        fn sample(&mut self, _: Option<u64>) -> u32 {
            0
        }
        fn next_us(&self) -> Option<u64> {
            Some(5_250_000)
        }
        fn next_frame(&self) -> Option<u32> {
            Some(1)
        }
    }
    let mut player = Playback::new(Box::new(|_, _, _, _| Some(Box::new(Moving))));
    player.replace(&fragment(1), 1.0, 1.0);
    let key = player.render(0.0, &mut |_| true, &|_| false)[0].key.clone();
    assert!(player.accept(&key, manifest()));
    // Unmapped: no deadline at all.
    player.render(100.0, &mut |_| true, &|_| true);
    assert_eq!(player.deadline_ms(), None);
    // The daemon read 5 s at the viewer's 1000 ms: the boundary is 250 ms on.
    assert!(player.calibrate(5_000_000, 1_000.0, 0.0));
    player.render(1_000.0, &mut |_| true, &|_| true);
    assert_eq!(player.deadline_ms(), Some(1_250.0));
    // Hidden: the deadline goes, and a render owns none.
    assert!(!player.suspend(true));
    assert_eq!(player.deadline_ms(), None);
    player.render(1_100.0, &mut |_| true, &|_| true);
    assert_eq!(player.deadline_ms(), None);
}
