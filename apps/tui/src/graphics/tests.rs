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

fn reference_upload(id: u32, format: u32, width: u32, height: u32, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for (index, chunk) in bytes.chunks(3072).enumerate() {
        let more = u8::from((index + 1) * 3072 < bytes.len());
        let header = if index == 0 {
            format!("\x1b_Ga=t,t=d,f={format},s={width},v={height},i={id},m={more};")
        } else {
            format!("\x1b_Gm={more};")
        };
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(STANDARD.encode(chunk).as_bytes());
        out.extend_from_slice(b"\x1b\\");
    }
    out
}

#[test]
fn upload_serialization_matches_each_chunk_boundary_and_numeric_extreme() {
    for length in [0, 1, 3, 3071, 3072, 3073, 266_256] {
        let bytes: Vec<_> = (0..length)
            .map(|index| u8::try_from(index % 251).unwrap())
            .collect();
        for (id, format, width, height) in [(1, 100, 3, 3), (u32::MAX, 32, u32::MAX, u32::MAX)] {
            let mut out = Vec::new();
            upload(&mut out, id, format, width, height, &bytes);
            assert_eq!(out, reference_upload(id, format, width, height, &bytes));
        }
    }
    for id in [0, 1, u32::MAX] {
        let mut out = Vec::new();
        delete(&mut out, id, false);
        assert_eq!(out, format!("\x1b_Ga=d,d=i,i={id},q=2\x1b\\").as_bytes());
        out.clear();
        delete_placement(&mut out, id, u32::MAX);
        assert_eq!(
            out,
            format!("\x1b_Ga=d,d=i,i={id},p=4294967295,q=2\x1b\\").as_bytes()
        );
    }
}

#[test]
fn the_largest_placement_header_fits_its_stack_storage() {
    let max = u32::MAX;
    let z = i32::MIN;
    let expected =
        format!("\x1b[{max};{max}H\x1b_Ga=p,i={max},p={max},X={max},Y={max},C=1,z={z}\x1b\\");
    let mut out = Vec::new();
    command(
        &mut out,
        format_args!("\x1b[{max};{max}H\x1b_Ga=p,i={max},p={max},X={max},Y={max},C=1,z={z}\x1b\\"),
    );
    assert_eq!(out, expected.as_bytes());
    assert_eq!(out.len(), COMMAND_BYTES);
}

#[test]
#[ignore = "graphics serialization allocation census; run with --ignored --nocapture"]
fn graphics_upload_cost_profile() {
    for length in [0, 1, 3, 3071, 3072, 3073, 266_256] {
        let bytes = vec![255; length];
        for capacity in [0, length * 2 + 256] {
            let mut out = Vec::with_capacity(capacity);
            let tally = crate::test_allocations::measure(|| {
                upload(&mut out, u32::MAX, 32, 258, 258, &bytes);
            });
            assert_eq!(out, reference_upload(u32::MAX, 32, 258, 258, &bytes));
            println!(
                "upload {length} reserved={capacity}: bytes={} capacity={} {tally:?}",
                out.len(),
                out.capacity()
            );
        }
    }
    for (name, id) in [("small", 1), ("large", u32::MAX)] {
        let mut out = Vec::with_capacity(256);
        let tally = crate::test_allocations::measure(|| delete(&mut out, id, false));
        println!(
            "delete {name}: bytes={} capacity={} {tally:?}",
            out.len(),
            out.capacity()
        );
        out.clear();
        let tally = crate::test_allocations::measure(|| delete_placement(&mut out, id, u32::MAX));
        println!(
            "delete placement {name}: bytes={} capacity={} {tally:?}",
            out.len(),
            out.capacity()
        );
    }
}

#[test]
#[ignore = "retired-instruction population; select MERKUR_TUI_UPLOAD_BYTES"]
fn graphics_upload_instruction_profile() {
    let length: usize = std::env::var("MERKUR_TUI_UPLOAD_BYTES")
        .unwrap_or_else(|_| "3073".into())
        .parse()
        .unwrap();
    let rounds: usize = std::env::var("MERKUR_TUI_PROFILE_ROUNDS")
        .unwrap_or_else(|_| "100000".into())
        .parse()
        .unwrap();
    let command = std::env::var("MERKUR_TUI_GRAPHICS_COMMAND").unwrap_or_else(|_| "upload".into());
    let bytes = vec![255; length];
    let mut out = Vec::with_capacity(length * 2 + 256);
    for _ in 0..rounds {
        out.clear();
        match command.as_str() {
            "upload" => upload(
                std::hint::black_box(&mut out),
                u32::MAX,
                32,
                258,
                258,
                std::hint::black_box(&bytes),
            ),
            "delete" => delete(
                std::hint::black_box(&mut out),
                std::hint::black_box(u32::MAX),
                false,
            ),
            "delete-placement" => delete_placement(
                std::hint::black_box(&mut out),
                std::hint::black_box(u32::MAX),
                u32::MAX,
            ),
            _ => panic!("unknown graphics command"),
        }
        std::hint::black_box(&out);
    }
}

#[test]
#[ignore = "placement serialization allocation census; run with --ignored --nocapture"]
fn graphics_placement_cost_profile() {
    let mut graphics = Graphics::default();
    graphics.fence(1);
    graphics
        .tile(1, "tile".into(), png(3, 3, &[255; 36]))
        .unwrap();
    let scene = scene("tile");
    let mut out = Vec::with_capacity(1024);
    compose(&mut graphics, &scene, size(), &mut out);
    acknowledge(&mut graphics);
    compose(&mut graphics, &scene, size(), &mut out);
    for (name, order, layer) in [
        ("front", 0, 2),
        ("back", 0, 0),
        ("large", i32::MAX as u32, 2),
    ] {
        graphics.desired[0].order = order;
        graphics.desired[0].layer = layer;
        graphics.shown.clear();
        graphics.erased = true;
        graphics.dirty = true;
        out.clear();
        let tally = crate::test_allocations::measure(|| {
            graphics.compose(&scene, size(), &mut out).unwrap()
        });
        let id = graphics.rasters[&graphics.desired[0].key].id;
        let z = if layer == 0 {
            i32::MIN
        } else {
            i32::try_from(order).unwrap()
        };
        assert_eq!(
            out,
            format!(
                "\x1b7\x1b[2;2H\x1b_Ga=p,i={id},p={},X=0,Y=0,C=1,z={z}\x1b\\\x1b8",
                order + 1
            )
            .as_bytes()
        );
        println!(
            "placement {name}: bytes={} capacity={} {tally:?}",
            out.len(),
            out.capacity()
        );
    }
}

fn reconcile_fixture(count: u32, change: &str) -> (Graphics, Scene) {
    let scene = Scene {
        tiles: vec![],
        quads: vec![].into(),
        animations: vec![],
    };
    let mut graphics = Graphics::default();
    graphics.scene = Some(scene.clone());
    graphics.size = Some(size());
    graphics.complete = change != "incomplete";
    graphics.dirty = true;
    let key = raster_key("shared", &quad("shared"), 16, 12).unwrap();
    for index in 0..count {
        let placement = Placement {
            key: key.clone(),
            layer: 2,
            order: index * 3,
        };
        graphics.shown.push(placement.clone());
        let mut desired = placement;
        if change == "replacement" || (change == "sparse" && index % 3 == 0) {
            desired.order += 1;
        }
        if change == "key" && index % 3 == 0 {
            desired.key.mapping[4] = 0.5_f64.to_bits();
        }
        graphics.desired.push(desired);
    }
    if change == "key" && count != 0 {
        graphics.rasters.insert(
            graphics.desired[0].key.clone(),
            Raster {
                id: 2_147_483_645,
                pixels: Zeroizing::new(vec![]),
                sent: true,
                confirmed: true,
                _storage: graphics.reserve_pixels(0).unwrap(),
            },
        );
    }
    if change == "restore" {
        graphics.shown.clear();
        graphics.erased = true;
    }
    if count != 0 {
        graphics.rasters.insert(
            key,
            Raster {
                id: 2_147_483_646,
                pixels: Zeroizing::new(vec![]),
                sent: true,
                confirmed: true,
                _storage: graphics.reserve_pixels(0).unwrap(),
            },
        );
    }
    (graphics, scene)
}

fn reference_reconciliation(graphics: &Graphics) -> Vec<u8> {
    let mut out = Vec::new();
    if graphics.complete && (graphics.erased || graphics.shown != graphics.desired) {
        let desired: BTreeSet<_> = graphics.desired.iter().collect();
        let shown: BTreeSet<_> = graphics.shown.iter().collect();
        out.extend_from_slice(b"\x1b7");
        for placement in &graphics.shown {
            if !desired.contains(placement) {
                let id = graphics.rasters[&placement.key].id;
                out.extend_from_slice(
                    format!("\x1b_Ga=d,d=i,i={id},p={},q=2\x1b\\", placement.order + 1).as_bytes(),
                );
            }
        }
        for placement in &graphics.desired {
            if !graphics.erased && shown.contains(placement) {
                continue;
            }
            let id = graphics.rasters[&placement.key].id;
            out.extend_from_slice(
                format!(
                    "\x1b[2;2H\x1b_Ga=p,i={id},p={},X=0,Y=0,C=1,z={}\x1b\\",
                    placement.order + 1,
                    placement.order
                )
                .as_bytes(),
            );
        }
        out.extend_from_slice(b"\x1b8");
    }
    let shown = if graphics.complete {
        &graphics.desired
    } else {
        &graphics.shown
    };
    for (key, raster) in &graphics.rasters {
        if !graphics
            .desired
            .iter()
            .chain(shown)
            .any(|placement| &placement.key == key)
        {
            out.extend_from_slice(format!("\x1b_Ga=d,d=I,i={},q=2\x1b\\", raster.id).as_bytes());
        }
    }
    out
}

#[test]
fn ordered_placements_keep_the_deletion_then_insertion_command_stream() {
    for count in [0, 1, 2, 8, 64, 256] {
        for change in [
            "unchanged",
            "replacement",
            "sparse",
            "restore",
            "incomplete",
            "key",
        ] {
            let (mut graphics, scene) = reconcile_fixture(count, change);
            let expected = reference_reconciliation(&graphics);
            let mut out = Vec::new();
            graphics.compose(&scene, size(), &mut out).unwrap();
            assert_eq!(out, expected, "{count} {change}");
            for placements in [&graphics.shown, &graphics.desired] {
                assert!(
                    placements
                        .windows(2)
                        .all(|pair| pair[0].order < pair[1].order)
                );
            }
        }
    }
}

#[test]
#[ignore = "placement reconciliation allocation census; run with --ignored --nocapture"]
fn placement_reconcile_cost_profile() {
    for count in [0, 1, 8, 64, 256] {
        for change in [
            "unchanged",
            "replacement",
            "sparse",
            "restore",
            "incomplete",
            "key",
        ] {
            let (mut graphics, scene) = reconcile_fixture(count, change);
            let expected = reference_reconciliation(&graphics);
            let mut out = Vec::with_capacity(65536);
            let tally = crate::test_allocations::measure(|| {
                graphics.compose(&scene, size(), &mut out).unwrap()
            });
            assert_eq!(out, expected);
            println!(
                "reconcile {count} {change}: bytes={} capacity={} desired_capacity={} shown_capacity={} {tally:?}",
                out.len(),
                out.capacity(),
                graphics.desired.capacity(),
                graphics.shown.capacity()
            );
        }
    }
}

#[test]
#[ignore = "retired-instruction population; select MERKUR_TUI_PLACEMENTS and MERKUR_TUI_RECONCILE"]
fn placement_reconcile_instruction_profile() {
    let count = std::env::var("MERKUR_TUI_PLACEMENTS")
        .unwrap_or_else(|_| "64".into())
        .parse()
        .unwrap();
    let change = std::env::var("MERKUR_TUI_RECONCILE").unwrap_or_else(|_| "replacement".into());
    let rounds: u32 = std::env::var("MERKUR_TUI_PROFILE_ROUNDS")
        .unwrap_or_else(|_| "10000".into())
        .parse()
        .unwrap();
    let mut out = Vec::with_capacity(65536);
    for _ in 0..rounds {
        let (mut graphics, scene) = reconcile_fixture(count, &change);
        out.clear();
        graphics
            .compose(std::hint::black_box(&scene), size(), &mut out)
            .unwrap();
        std::hint::black_box(&out);
    }
}
