use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::command::Format;
use merkur_graphics::processing::{DecodeRequest, MAX_RGBA_BYTES};
use merkur_image_worker::descriptor::Request;
use merkur_image_worker::{OUTPUT_METADATA_BYTES, Reservations, WORKSPACE_BYTES, Worker};
use std::io::{Seek, Write};

fn reservations(png: bool) -> Reservations {
    let workspace = Usage {
        bytes: WORKSPACE_BYTES,
        objects: 1,
    };
    let output = Usage {
        bytes: if png { MAX_RGBA_BYTES } else { 4 } + OUTPUT_METADATA_BYTES,
        objects: 1,
    };
    Reservations {
        workspace: Budget::new(workspace).reserve(workspace).unwrap(),
        output: Budget::new(output).reserve(output).unwrap(),
    }
}

fn request(format: Format, compressed: bool, length: usize, inflated: usize) -> Request {
    Request {
        decode: DecodeRequest {
            format,
            compressed,
            base64: false,
            width: 1,
            height: 1,
            inflated_bytes: inflated as u32,
        },
        offset: 17,
        length: length as u64,
    }
}

#[tokio::test]
async fn native_formats_snapshot_only_the_extent_without_moving_the_senders_offset() {
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[13, 17, 19, 255])
            .unwrap();
    }
    for format in [Format::Rgb, Format::Rgba, Format::Png] {
        for compressed in [false, true] {
            let raw = match format {
                Format::Rgb => vec![13, 17, 19],
                Format::Rgba => vec![13, 17, 19, 255],
                Format::Png => png.clone(),
            };
            let inflated = raw.len();
            let bytes = if compressed {
                let mut encoder =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(&raw).unwrap();
                encoder.finish().unwrap()
            } else {
                raw
            };
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(&[91; 17]).unwrap();
            file.write_all(&bytes).unwrap();
            file.write_all(&[92; 11]).unwrap();
            let position = file.stream_position().unwrap();
            let mut worker = Worker::launch_descriptor(
                &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
                request(format, compressed, bytes.len(), inflated),
                file.try_clone().unwrap(),
                reservations(format == Format::Png),
            )
            .await
            .unwrap();
            assert!(worker.push(b"", true).await.is_err());
            let image = worker.finish().await.unwrap();
            assert_eq!(image.pixels().rgba(), &[13, 17, 19, 255]);
            assert_eq!(file.stream_position().unwrap(), position);
            file.set_len(0).unwrap();
            assert_eq!(image.pixels().rgba(), &[13, 17, 19, 255]);
        }
    }
}

#[tokio::test]
async fn native_descriptor_rejects_short_files_and_nonregular_objects() {
    use std::os::fd::OwnedFd;
    let file = tempfile::tempfile().unwrap();
    file.set_len(20).unwrap();
    let (socket, _other) = std::os::unix::net::UnixStream::pair().unwrap();
    for file in [file, std::fs::File::from(OwnedFd::from(socket))] {
        let mut worker = Worker::launch_descriptor(
            &std::fs::canonicalize(env!("CARGO_BIN_EXE_merkur-image-worker")).unwrap(),
            request(Format::Rgba, false, 4, 0),
            file,
            reservations(false),
        )
        .await
        .unwrap();
        assert!(worker.finish().await.is_err());
    }
}
