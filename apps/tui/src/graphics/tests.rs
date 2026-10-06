use super::*;
use merkur_client::session::graphics::{GraphicsAsset, GraphicsDemand};

fn png(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(pixels).unwrap();
        writer.finish().unwrap();
    }
    bytes
}
fn tile(key: &str) -> GraphicsDemand {
    GraphicsDemand {
        asset: GraphicsAsset::Tile,
        authority: [1; 32],
        frame: 0,
        key: key.into(),
        source: [1; 32],
        level: 0,
        x: 0,
        y: 0,
        width: 3,
        height: 3,
    }
}
fn quad(key: &str) -> Quad {
    Quad {
        key: key.into(),
        layer: 2,
        left: 2.0,
        top: 3.0,
        right: 4.0,
        bottom: 5.0,
        u: 1.0 / 258.0,
        v: 1.0 / 258.0,
        uw: 1.0 / 258.0,
        vh: 1.0 / 258.0,
    }
}
fn scene(key: &str) -> Scene {
    Scene {
        tiles: vec![tile(key)],
        quads: vec![quad(key)].into(),
        animations: vec![],
    }
}
fn size() -> HostSize {
    HostSize {
        cols: 8,
        rows: 5,
        cell: Some((2.0, 3.0)),
    }
}
fn contains(bytes: &[u8], pattern: &[u8]) -> bool {
    bytes.windows(pattern.len()).any(|window| window == pattern)
}
fn settled(graphics: &mut Graphics) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !graphics.pending_tiles.is_empty() || !graphics.pending_rasters.is_empty() {
        graphics.completed().unwrap();
        assert!(
            std::time::Instant::now() < deadline,
            "graphics worker did not finish"
        );
        std::thread::yield_now();
    }
}
fn compose(graphics: &mut Graphics, scene: &Scene, size: HostSize, bytes: &mut Vec<u8>) {
    settled(graphics);
    graphics.compose(scene, size, bytes).unwrap();
    settled(graphics);
    graphics.compose(scene, size, bytes).unwrap();
}
fn acknowledge(graphics: &mut Graphics) {
    let ids: Vec<_> = graphics
        .tiles
        .values()
        .map(|tile| tile.id)
        .chain(graphics.rasters.values().map(|raster| raster.id))
        .collect();
    for id in ids {
        graphics.reply(id, None, Ok(())).unwrap();
    }
}
#[test]
fn uploads_need_acknowledgements_and_unchanged_frames_do_no_graphics_work() {
    let mut graphics = Graphics::default();
    graphics.fence(7);
    graphics
        .tile(7, "tile".into(), png(3, 3, &[255; 36]))
        .unwrap();
    settled(&mut graphics);
    let id = graphics.tiles["tile"].id;
    assert_eq!(
        graphics.reply(id, None, Ok(())).unwrap(),
        None,
        "an unsent upload has no proof"
    );
    let scene = scene("tile");
    let mut bytes = Vec::new();
    compose(&mut graphics, &scene, size(), &mut bytes);
    assert!(contains(&bytes, b"a=t,t=d,f=100"));
    assert!(contains(&bytes, b"a=t,t=d,f=32,s=2,v=2"));
    assert!(!contains(&bytes, b"a=p"));
    assert_eq!(
        graphics.reply(id, None, Ok(())).unwrap(),
        Some((7, Some("tile".into())))
    );
    bytes.clear();
    compose(&mut graphics, &scene, size(), &mut bytes);
    assert!(
        bytes.is_empty(),
        "a source ACK alone cannot publish an unconfirmed raster"
    );
    acknowledge(&mut graphics);
    compose(&mut graphics, &scene, size(), &mut bytes);
    assert!(contains(&bytes, b"\x1b[2;2H"));
    assert!(contains(&bytes, b"X=0,Y=0,C=1,z=0"));
    assert!(bytes.starts_with(b"\x1b7") && bytes.ends_with(b"\x1b8"));
    bytes.clear();
    compose(&mut graphics, &scene, size(), &mut bytes);
    assert!(bytes.is_empty());
    graphics.hide(&mut bytes);
    assert!(contains(&bytes, b"a=d,d=i"));
    bytes.clear();
    compose(&mut graphics, &scene, size(), &mut bytes);
    assert!(contains(&bytes, b"a=p"));
    assert!(
        !contains(&bytes, b"a=t"),
        "tab switching retains the acknowledged uploads"
    );
}
#[test]
fn an_incomplete_replacement_holds_the_previous_scene_and_retirement_revokes_residency() {
    let mut graphics = Graphics::default();
    graphics.fence(1);
    graphics
        .tile(1, "old".into(), png(3, 3, &[255; 36]))
        .unwrap();
    let mut bytes = Vec::new();
    compose(&mut graphics, &scene("old"), size(), &mut bytes);
    acknowledge(&mut graphics);
    compose(&mut graphics, &scene("old"), size(), &mut bytes);
    assert_eq!(graphics.shown[0].key.tile, "old");
    bytes.clear();
    compose(&mut graphics, &scene("new"), size(), &mut bytes);
    assert_eq!(graphics.shown[0].key.tile, "old");
    assert_eq!(
        graphics.retired().collect::<Vec<_>>(),
        vec![(1, "old".into())]
    );
    graphics.tile(1, "new".into(), png(3, 3, &[0; 36])).unwrap();
    bytes.clear();
    compose(&mut graphics, &scene("new"), size(), &mut bytes);
    assert!(!contains(&bytes, b"a=p"));
    assert_eq!(graphics.shown[0].key.tile, "old");
    acknowledge(&mut graphics);
    bytes.clear();
    compose(&mut graphics, &scene("new"), size(), &mut bytes);
    assert_eq!(graphics.shown[0].key.tile, "new");
    assert!(contains(&bytes, b"a=d,d=i") && contains(&bytes, b"a=p"));
    assert!(graphics.rasters.keys().all(|key| key.tile == "new"));
}
#[test]
fn fences_and_close_delete_owned_images_and_ignore_late_assets_and_proofs() {
    let mut graphics = Graphics::default();
    graphics.fence(1);
    graphics
        .tile(1, "old".into(), png(3, 3, &[255; 36]))
        .unwrap();
    settled(&mut graphics);
    let id = graphics.tiles["old"].id;
    let mut bytes = Vec::new();
    compose(&mut graphics, &scene("old"), size(), &mut bytes);
    graphics.fence(2);
    assert_eq!(graphics.reply(id, None, Err("ENOENT")).unwrap(), None);
    graphics
        .tile(1, "late".into(), png(3, 3, &[255; 36]))
        .unwrap();
    assert!(graphics.tiles.is_empty());
    bytes.clear();
    graphics.destroy(&mut bytes);
    assert!(contains(&bytes, format!("d=I,i={id},q=2").as_bytes()));
    assert!(graphics.garbage.is_empty());
}
#[test]
fn upload_chunks_reconstitute_the_exact_bytes_with_one_acknowledged_identity() {
    let bytes: Vec<u8> = (0..10_000).map(|index| index as u8).collect();
    let mut output = Vec::new();
    upload(&mut output, 37, 32, 50, 50, &bytes);
    let mut rest = output.as_slice();
    let mut decoded = Vec::new();
    let mut count = 0;
    while !rest.is_empty() {
        rest = rest.strip_prefix(b"\x1b_G").unwrap();
        let at = rest.iter().position(|byte| *byte == b';').unwrap();
        let fields = &rest[..at];
        rest = &rest[at + 1..];
        let at = rest
            .windows(2)
            .position(|bytes| bytes == b"\x1b\\")
            .unwrap();
        assert!(at <= 4096);
        decoded.extend(STANDARD.decode(&rest[..at]).unwrap());
        rest = &rest[at + 2..];
        assert_eq!(contains(fields, b"i=37"), count == 0);
        assert!(fields.ends_with(if rest.is_empty() { b"m=0" } else { b"m=1" }));
        count += 1;
    }
    assert_eq!(count, 4);
    assert_eq!(decoded, bytes);
}
#[test]
fn rasterization_crops_gutters_and_blends_alpha_without_transparent_color_fringe() {
    let mut pixels = vec![0; 36];
    pixels[16..20].copy_from_slice(&[200, 40, 80, 255]);
    pixels[20..24].copy_from_slice(&[0, 255, 0, 0]);
    let tile = Source {
        png: Zeroizing::new(vec![]),
        pixels: Zeroizing::new(pixels),
        width: 3,
        height: 3,
        _storage: Budget::new(Usage {
            bytes: 36,
            objects: 1,
        })
        .reserve(Usage {
            bytes: 36,
            objects: 1,
        })
        .unwrap(),
    };
    let mut quad = quad("tile");
    quad.right = 3.0;
    quad.bottom = 4.0;
    assert_eq!(
        &*rasterize(&tile, &quad, [2, 3, 3, 4], || false).unwrap(),
        &[200, 40, 80, 255]
    );
    quad.u = 1.5 / 258.0;
    assert_eq!(
        &*rasterize(&tile, &quad, [2, 3, 3, 4], || false).unwrap(),
        &[200, 40, 80, 128]
    );
    quad.left = -0.2;
    quad.right = 2.6;
    let key = raster_key("tile", &quad, 8, 4).unwrap();
    assert_eq!(key.rect, [0, 3, 3, 4]);
    quad.left = 2.6;
    quad.right = 7.8;
    assert_eq!(
        raster_key("tile", &quad, 8, 4).unwrap().rect[0],
        key.rect[2]
    );
}
#[test]
fn host_refusals_and_excessive_pixel_extents_fail_before_publishing() {
    let mut graphics = Graphics::default();
    graphics.fence(1);
    assert!(graphics.tile(1, "bad".into(), vec![0; 57]).is_err());
    assert!(graphics.tiles.is_empty());
    graphics
        .tile(1, "tile".into(), png(3, 3, &[255; 36]))
        .unwrap();
    let mut bytes = Vec::new();
    graphics
        .compose(&scene("tile"), size(), &mut bytes)
        .unwrap();
    settled(&mut graphics);
    graphics
        .compose(&scene("tile"), size(), &mut bytes)
        .unwrap();
    settled(&mut graphics);
    let id = graphics.tiles["tile"].id;
    assert!(graphics.reply(id, None, Err("ENOSPC:quota")).is_err());
    assert!(!graphics.tiles["tile"].confirmed);
    let mut scene = scene("tile");
    std::rc::Rc::make_mut(&mut scene.quads)[0].right = 1_000_000.0;
    std::rc::Rc::make_mut(&mut scene.quads)[0].bottom = 1_000_000.0;
    assert!(
        graphics
            .compose(
                &scene,
                HostSize {
                    cols: 60_000,
                    rows: 60_000,
                    cell: Some((100.0, 100.0))
                },
                &mut bytes
            )
            .is_err()
    );
    assert!(graphics.shown.is_empty());
}

#[test]
fn queued_deletes_stay_owned_until_the_host_consumed_them() {
    let mut images = HostImages {
        live: [17, 19, 23].into(),
        deleting: [17, 19].into(),
    };
    let before = images.restore();
    for id in [17, 19, 23] {
        assert!(contains(&before, format!("i={id},q=2").as_bytes()));
    }
    assert!(images.restore().is_empty());
    images.live = [17, 19, 23].into();
    images.deleting = [17, 19].into();
    images.consumed();
    assert_eq!(images.live, [23].into());
    assert!(images.deleting.is_empty());
    assert_eq!(images.restore(), b"\x1b_Ga=d,d=I,i=23,q=2\x1b\\");
}

#[test]
fn animation_bindings_and_layer_order_survive_shared_rasters() {
    use merkur_client::viewer::graphics::SceneAnimation;
    let mut graphics = Graphics::default();
    graphics.fence(1);
    graphics
        .tile(1, "frame".into(), png(3, 3, &[255; 36]))
        .unwrap();
    let mut quads = vec![quad("binding"); 4];
    quads[0].layer = 0;
    quads[1].layer = 1;
    let scene = Scene {
        tiles: vec![tile("frame")],
        quads: quads.into(),
        animations: vec![SceneAnimation {
            key: "animation".into(),
            reserve: true,
            bindings: vec![("binding".into(), "frame".into())],
        }],
    };
    let mut bytes = Vec::new();
    compose(&mut graphics, &scene, size(), &mut bytes);
    assert_eq!(graphics.rasters.len(), 3);
    acknowledge(&mut graphics);
    bytes.clear();
    compose(&mut graphics, &scene, size(), &mut bytes);
    for (placement, z) in [(1, i32::MIN), (2, -1_073_741_823), (3, 2), (4, 3)] {
        assert!(contains(
            &bytes,
            format!("p={placement},X=0,Y=0,C=1,z={z}").as_bytes()
        ));
    }
    graphics.hide(&mut bytes);
    for placement in 1..=4 {
        assert!(contains(&bytes, format!("p={placement},q=2").as_bytes()));
    }
}

#[test]
fn a_fence_cancels_preparation_without_refunding_live_worker_buffers() {
    let mut graphics = Graphics::default();
    graphics.fence(1);
    let bytes = png(258, 258, &vec![255; 258 * 258 * 4]);
    graphics.tile(1, "tile".into(), bytes).unwrap();
    assert!(
        graphics.tiles.is_empty(),
        "decoding never runs on the caller"
    );
    let generation = Arc::clone(&graphics.generation);
    graphics.fence(2);
    assert!(generation.load(Ordering::Acquire));
    // Joining the actual worker proves all its queued/results buffers released.
    drop(graphics.worker.take());
    assert_eq!(
        graphics.budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    assert!(graphics.tiles.is_empty() && graphics.rasters.is_empty());
}
