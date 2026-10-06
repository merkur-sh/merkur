use std::sync::Arc;

use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::command::Format;
use merkur_graphics::processing::{DecodeRequest, Pixels};
use merkur_image_worker::composition::Request;
use merkur_image_worker::frame::{Frame, Raster};
use merkur_image_worker::{OUTPUT_METADATA_BYTES, Reservations, WORKSPACE_BYTES, Worker};

fn reservations(budget: &Budget, width: u32, height: u32) -> Reservations {
    let workspace = Usage {
        bytes: WORKSPACE_BYTES,
        objects: 1,
    };
    Reservations {
        workspace: Budget::new(workspace).reserve(workspace).unwrap(),
        output: budget
            .reserve(Usage {
                bytes: width as usize * height as usize * 4 + OUTPUT_METADATA_BYTES,
                objects: 1,
            })
            .unwrap(),
    }
}

#[tokio::test]
async fn confined_composition_edits_persistent_regions_without_copying_the_canvas() {
    let executable = &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap();
    let budget = Budget::new(Usage {
        bytes: 32 * 1024 * 1024,
        objects: 4096,
    });
    let (width, height) = (1027, 519);
    let mut decoder = Worker::launch(
        executable,
        DecodeRequest {
            format: Format::Rgba,
            compressed: false,
            base64: false,
            width,
            height,
            inflated_bytes: 0,
        },
        reservations(&budget, width, height),
    )
    .await
    .unwrap();
    let bytes: Vec<_> = (0..width * height).flat_map(|_| [255, 0, 0, 255]).collect();
    for (i, chunk) in bytes.chunks(4096).enumerate() {
        decoder
            .push(chunk, (i + 1) * 4096 >= bytes.len())
            .await
            .unwrap();
    }
    let original = Arc::new(decoder.finish().await.unwrap());
    let frame = Frame::from_image(
        &original,
        &mut budget.reserve(Frame::tree_charge(width, height)).unwrap(),
    )
    .unwrap();
    let patch = Pixels::new(3, 3, [0, 0, 255, 128].repeat(9).into()).unwrap();
    for overwrite in [false, true] {
        let request = Request {
            width: 512,
            height: 256,
            x: 255,
            y: 2,
            patch_width: 2,
            patch_height: 2,
            overwrite,
        };
        let mut worker = Worker::launch_composition(
            executable,
            request,
            reservations(&budget, request.width, request.height),
        )
        .await
        .unwrap();
        assert!(worker.push(&[], true).await.is_err());
        worker
            .compose_input(request, &frame, [256, 256], &patch, [1, 1])
            .await
            .unwrap();
        let output = Arc::new(worker.finish().await.unwrap());
        let mut batch = budget
            .reserve(Frame::replacement_charge([width, height], 256, 256, 512, 256).unwrap())
            .unwrap();
        let result = frame.replace_tiles(256, 256, &output, &mut batch).unwrap();
        assert_eq!(result.run(0, 0).as_ptr(), frame.run(0, 0).as_ptr());
        for y in 0..height {
            let mut row = vec![0; width as usize * 4];
            assert!(result.copy_row(0, y, &mut row));
            for (x, pixel) in row.chunks_exact(4).enumerate() {
                let expected = if (511..513).contains(&x) && (258..260).contains(&y) {
                    if overwrite {
                        [0, 0, 255, 128]
                    } else {
                        [127, 0, 128, 255]
                    }
                } else {
                    [255, 0, 0, 255]
                };
                assert_eq!(pixel, expected);
            }
        }
    }
    drop((original, frame, decoder));
    merkur_image_worker::retirement::drain();
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}

#[tokio::test]
async fn composition_metadata_and_crops_are_validated_before_pipe_input() {
    let executable = &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap();
    let budget = Budget::new(Usage {
        bytes: 1024 * 1024,
        objects: 128,
    });
    let request = Request {
        width: 2,
        height: 2,
        x: 1,
        y: 1,
        patch_width: 1,
        patch_height: 1,
        overwrite: false,
    };
    assert_eq!(Request::decode(&request.encode()), Some(request));
    for (offset, value) in [(0, 0), (12, 2), (16, 255), (24, 2), (27, 1)] {
        let mut bytes = request.encode();
        bytes[offset] = value;
        assert!(Request::decode(&bytes).is_none());
    }
    let pixels = Pixels::new(2, 2, vec![0; 16].into()).unwrap();
    let mut worker = Worker::launch_composition(executable, request, reservations(&budget, 2, 2))
        .await
        .unwrap();
    let mut changed = request;
    changed.overwrite = true;
    assert!(
        worker
            .compose_input(changed, &pixels, [0, 0], &pixels, [0, 0])
            .await
            .is_err()
    );
    assert!(
        worker
            .compose_input(request, &pixels, [1, 0], &pixels, [0, 0])
            .await
            .is_err()
    );
    assert!(
        worker
            .compose_input(request, &pixels, [0, 0], &pixels, [u32::MAX, 0])
            .await
            .is_err()
    );
    worker.cancel().await;
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
}
