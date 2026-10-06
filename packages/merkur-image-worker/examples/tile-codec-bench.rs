//! Selection experiment, not a runtime codec switch. Every candidate round-trips
//! exact RGBA bytes. Generated inputs keep this experiment independent of private
//! terminal contents; they do not replace a photographic or physical-device corpus.
use std::hint::black_box;
use std::io::{Cursor, Read};
use std::time::Instant;

const SIDE: usize = 1024;
const REPEATS: usize = 3;

fn fixture(kind: &str) -> Vec<u8> {
    let mut pixels = vec![0; SIDE * SIDE * 4];
    let mut random = 0x123456789abcdef0u64;
    for y in 0..SIDE {
        for x in 0..SIDE {
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            let pixel = match kind {
                "diagram" => {
                    if x % 128 < 3 || y % 96 < 3 {
                        [20, 90, 180, 255]
                    } else if (x / 12 + y / 20) % 11 == 0 {
                        [32, 36, 40, 255]
                    } else {
                        [245, 247, 249, 255]
                    }
                }
                "gradient" => [
                    (x * 255 / (SIDE - 1)) as u8,
                    (y * 255 / (SIDE - 1)) as u8,
                    ((x + y) * 255 / (2 * SIDE - 2)) as u8,
                    255,
                ],
                "alpha" => [200, (x % 251) as u8, 100, ((x ^ y) % 256) as u8],
                "texture" => {
                    let wave =
                        ((x as f64 * 0.03).sin() * (y as f64 * 0.02).cos() * 80.0 + 128.0) as u8;
                    let noise = (random % 17) as u8;
                    [
                        wave.saturating_add(noise),
                        wave.saturating_sub(noise),
                        wave / 2 + noise,
                        255,
                    ]
                }
                "noise" => [
                    (random >> 8) as u8,
                    (random >> 16) as u8,
                    (random >> 24) as u8,
                    255,
                ],
                _ => unreachable!(),
            };
            pixels[(y * SIDE + x) * 4..(y * SIDE + x + 1) * 4].copy_from_slice(&pixel);
        }
    }
    pixels
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i16::from(a) + i16::from(b) - i16::from(c);
    let pa = (p - i16::from(a)).abs();
    let pb = (p - i16::from(b)).abs();
    let pc = (p - i16::from(c)).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

fn filter(input: &[u8], out: &mut [u8], stride: usize, use_paeth: bool) {
    if !use_paeth {
        out[..stride].copy_from_slice(&input[..stride]);
        for ((value, current), up) in out[stride..].iter_mut().zip(&input[stride..]).zip(input) {
            *value = current.wrapping_sub(*up);
        }
        return;
    }
    for i in 0..input.len() {
        let up = if i >= stride { input[i - stride] } else { 0 };
        let predictor = if use_paeth {
            let left = if i % stride >= 4 { input[i - 4] } else { 0 };
            let corner = if i >= stride && i % stride >= 4 {
                input[i - stride - 4]
            } else {
                0
            };
            paeth(left, up, corner)
        } else {
            up
        };
        out[i] = input[i].wrapping_sub(predictor);
    }
}

fn unfilter(bytes: &mut [u8], stride: usize, use_paeth: bool) {
    if !use_paeth {
        for offset in (stride..bytes.len()).step_by(stride) {
            let (previous, remaining) = bytes.split_at_mut(offset);
            for (value, up) in remaining[..stride]
                .iter_mut()
                .zip(&previous[offset - stride..])
            {
                *value = value.wrapping_add(*up);
            }
        }
        return;
    }
    for i in 0..bytes.len() {
        let up = if i >= stride { bytes[i - stride] } else { 0 };
        let predictor = if use_paeth {
            let left = if i % stride >= 4 { bytes[i - 4] } else { 0 };
            let corner = if i >= stride && i % stride >= 4 {
                bytes[i - stride - 4]
            } else {
                0
            };
            paeth(left, up, corner)
        } else {
            up
        };
        bytes[i] = bytes[i].wrapping_add(predictor);
    }
}

fn main() {
    if let Some(directory) = std::env::args().nth(1) {
        if directory == "--vector" {
            write_vector();
            return;
        }
        write_browser_fixtures(std::path::Path::new(&directory));
        return;
    }
    println!("fixture,tile,codec,encoded_bytes,encode_us,decode_us,max_tile_decode_us");
    for kind in ["diagram", "gradient", "alpha", "texture", "noise"] {
        let pixels = fixture(kind);
        for side in [128, 256, 512, 1024] {
            let tiles: Vec<Vec<u8>> = (0..SIDE)
                .step_by(side)
                .flat_map(|y| {
                    let pixels = &pixels;
                    (0..SIDE).step_by(side).map(move |x| {
                        let mut tile = Vec::with_capacity(side * side * 4);
                        for row in y..y + side {
                            tile.extend_from_slice(
                                &pixels[(row * SIDE + x) * 4..(row * SIDE + x + side) * 4],
                            );
                        }
                        tile
                    })
                })
                .collect();
            for codec in [
                "png-fast",
                "png-fast-up",
                "png-fast-paeth",
                "png-libdeflate-1",
                "png-libdeflate-3",
                "png-balanced",
                "zstd-up-1",
                "zstd-up-3",
                "zstd-paeth-1",
                "zstd-paeth-3",
            ] {
                let mut compressor =
                    zstd::bulk::Compressor::new(if codec.ends_with('3') { 3 } else { 1 }).unwrap();
                let mut scratch = vec![0; side * side * 4];
                let mut zstd_decoder = ruzstd::decoding::FrameDecoder::new();
                let mut deflater = libdeflater::Compressor::new(
                    libdeflater::CompressionLvl::new(if codec.ends_with('3') { 3 } else { 1 })
                        .unwrap(),
                );
                let mut scanlines = vec![0; (side * 4 + 1) * side];
                let mut deflated = vec![0; deflater.zlib_compress_bound(scanlines.len())];
                let mut decoded = vec![0; side * side * 4];
                let mut encoded =
                    Vec::with_capacity(zstd::zstd_safe::compress_bound(scratch.len()));
                let mut encode_ns = 0u128;
                let mut decode_ns = 0u128;
                let mut max_decode_ns = 0u128;
                let mut total_bytes = 0;
                // First pass warms codec state; only subsequent passes are timed.
                for repeat in 0..=REPEATS {
                    for tile in &tiles {
                        encoded.clear();
                        let start = Instant::now();
                        if codec.starts_with("png-libdeflate") {
                            encode_libdeflate(
                                side,
                                tile,
                                &mut scanlines,
                                &mut deflated,
                                &mut deflater,
                                &mut encoded,
                            );
                        } else if codec.starts_with("png") {
                            let mut encoder =
                                png::Encoder::new(&mut encoded, side as u32, side as u32);
                            encoder.set_color(png::ColorType::Rgba);
                            encoder.set_depth(png::BitDepth::Eight);
                            encoder.set_compression(if codec.starts_with("png-fast") {
                                png::Compression::Fast
                            } else {
                                png::Compression::Balanced
                            });
                            if codec == "png-fast-up" {
                                encoder.set_filter(png::Filter::Up);
                            }
                            if codec == "png-fast-paeth" {
                                encoder.set_filter(png::Filter::Paeth);
                            }
                            let mut writer = encoder.write_header().unwrap();
                            writer.write_image_data(black_box(tile)).unwrap();
                            writer.finish().unwrap();
                        } else {
                            filter(
                                black_box(tile),
                                &mut scratch,
                                side * 4,
                                codec.contains("paeth"),
                            );
                            compressor
                                .compress_to_buffer(&scratch, &mut encoded)
                                .unwrap();
                        }
                        let encoding = start.elapsed().as_nanos();
                        let start = Instant::now();
                        if codec.starts_with("png") {
                            let decoder = png::Decoder::new(Cursor::new(black_box(&encoded)));
                            let mut reader = decoder.read_info().unwrap();
                            reader.next_frame(&mut decoded).unwrap();
                            reader.finish().unwrap();
                        } else {
                            let mut reader = ruzstd::decoding::StreamingDecoder::new_with_decoder(
                                black_box(&encoded[..]),
                                &mut zstd_decoder,
                            )
                            .unwrap();
                            reader.read_exact(&mut decoded).unwrap();
                            assert_eq!(reader.read(&mut [0]).unwrap(), 0);
                            unfilter(&mut decoded, side * 4, codec.contains("paeth"));
                        }
                        let decoding = start.elapsed().as_nanos();
                        assert_eq!(&decoded, tile);
                        if repeat > 0 {
                            encode_ns += encoding;
                            decode_ns += decoding;
                            max_decode_ns = max_decode_ns.max(decoding);
                            total_bytes += encoded.len();
                        }
                    }
                }
                println!(
                    "{kind},{side},{codec},{},{:.1},{:.1},{:.1}",
                    total_bytes / REPEATS,
                    encode_ns as f64 / REPEATS as f64 / 1000.0,
                    decode_ns as f64 / REPEATS as f64 / 1000.0,
                    max_decode_ns as f64 / 1000.0
                );
            }
        }
    }
}

fn encode_libdeflate(
    side: usize,
    rgba: &[u8],
    scanlines: &mut [u8],
    deflated: &mut [u8],
    compressor: &mut libdeflater::Compressor,
    encoded: &mut Vec<u8>,
) {
    let stride = side * 4;
    for (row, out) in scanlines.chunks_exact_mut(stride + 1).enumerate() {
        out[0] = 2;
        let input = &rgba[row * stride..(row + 1) * stride];
        if row == 0 {
            out[1..].copy_from_slice(input);
        } else {
            for ((dst, src), up) in out[1..]
                .iter_mut()
                .zip(input)
                .zip(&rgba[(row - 1) * stride..row * stride])
            {
                *dst = src.wrapping_sub(*up);
            }
        }
    }
    let count = compressor.zlib_compress(scanlines, deflated).unwrap();
    encoded.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut header = [0u8; 13];
    header[..4].copy_from_slice(&(side as u32).to_be_bytes());
    header[4..8].copy_from_slice(&(side as u32).to_be_bytes());
    header[8] = 8;
    header[9] = 6;
    for (kind, bytes) in [
        (b"IHDR", &header[..]),
        (b"IDAT", &deflated[..count]),
        (b"IEND", &[][..]),
    ] {
        encoded.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        encoded.extend_from_slice(kind);
        encoded.extend_from_slice(bytes);
        let mut crc = crc32fast::Hasher::new();
        crc.update(kind);
        crc.update(bytes);
        encoded.extend_from_slice(&crc.finalize().to_be_bytes());
    }
}

fn write_browser_fixtures(directory: &std::path::Path) {
    use graphics_codec_probe::tile::{TileShape, filter, object_root};
    std::fs::create_dir_all(directory).unwrap();
    let mut entries = Vec::new();
    let mut compressor = zstd::bulk::Compressor::new(3).unwrap();
    for kind in ["diagram", "gradient", "alpha", "texture", "noise"] {
        let source = fixture(kind);
        for side in [128, 256] {
            let stored = side + 2;
            let shape = TileShape::new(stored as u16, stored as u16).unwrap();
            let mut deflater =
                libdeflater::Compressor::new(libdeflater::CompressionLvl::new(1).unwrap());
            let mut scanlines = vec![0; (stored * 4 + 1) * stored];
            let mut deflated = vec![0; deflater.zlib_compress_bound(scanlines.len())];
            let mut encoded = Vec::with_capacity(deflated.len() + 57);
            for y in (0..SIDE).step_by(side) {
                for x in (0..SIDE).step_by(side) {
                    let name = format!("{kind}-{side}-{x}-{y}");
                    let mut rgba = vec![0; shape.bytes()];
                    for row in 0..stored {
                        for column in 0..stored {
                            let sy = (y + row).saturating_sub(1).min(SIDE - 1);
                            let sx = (x + column).saturating_sub(1).min(SIDE - 1);
                            rgba[(row * stored + column) * 4..(row * stored + column + 1) * 4]
                                .copy_from_slice(
                                    &source[(sy * SIDE + sx) * 4..(sy * SIDE + sx + 1) * 4],
                                );
                        }
                    }
                    let mut filtered = vec![0; shape.bytes()];
                    assert!(filter(shape, &rgba, &mut filtered));
                    let mut tile = shape.header().to_vec();
                    tile.extend(compressor.compress(&filtered).unwrap());
                    let root: String = object_root(&tile)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    std::fs::write(directory.join(format!("{name}.tile")), &tile).unwrap();
                    std::fs::write(directory.join(format!("{name}.rgba")), &rgba).unwrap();
                    encoded.clear();
                    encode_libdeflate(
                        stored,
                        &rgba,
                        &mut scanlines,
                        &mut deflated,
                        &mut deflater,
                        &mut encoded,
                    );
                    std::fs::write(directory.join(format!("{name}-libdeflate-1.png")), &encoded)
                        .unwrap();
                    let png_root: String = merkur_graphics::tile::object_root(&encoded)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    for (suffix, compression) in [
                        ("fast", png::Compression::Fast),
                        ("fast-up", png::Compression::Fast),
                        ("fast-paeth", png::Compression::Fast),
                        ("balanced", png::Compression::Balanced),
                    ] {
                        let file =
                            std::fs::File::create(directory.join(format!("{name}-{suffix}.png")))
                                .unwrap();
                        let mut encoder = png::Encoder::new(file, stored as u32, stored as u32);
                        encoder.set_color(png::ColorType::Rgba);
                        encoder.set_depth(png::BitDepth::Eight);
                        encoder.set_compression(compression);
                        if suffix == "fast-up" {
                            encoder.set_filter(png::Filter::Up);
                        }
                        if suffix == "fast-paeth" {
                            encoder.set_filter(png::Filter::Paeth);
                        }
                        let mut writer = encoder.write_header().unwrap();
                        writer.write_image_data(&rgba).unwrap();
                        writer.finish().unwrap();
                    }
                    entries.push(format!(r#"{{"name":"{name}","kind":"{kind}","side":{side},"stored":{stored},"root":"{root}","pngRoot":"{png_root}"}}"#));
                }
            }
        }
    }
    std::fs::write(
        directory.join("index.json"),
        format!("[{}]", entries.join(",")),
    )
    .unwrap();
}

fn write_vector() {
    use merkur_graphics::budget::Budget;
    use merkur_graphics::processing::Pixels;
    use merkur_graphics::tile::{TILE_ENCODED_BYTES, object_root};
    use merkur_image_worker::tile::Encoder;
    let pixels = Pixels::new(1, 1, vec![27, 81, 243, 127].into_boxed_slice()).unwrap();
    let budget = Budget::new(Encoder::charge());
    let mut encoder = Encoder::new(budget.reserve(Encoder::charge()).unwrap()).unwrap();
    let mut output = vec![0; TILE_ENCODED_BYTES];
    let (shape, count) = encoder.encode(&pixels, 0, 0, &mut output).unwrap();
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    println!(
        r#"{{"width":{},"height":{},"root":"{}","png":"{}"}}"#,
        shape.width(),
        shape.height(),
        hex(&object_root(&output[..count])),
        hex(&output[..count])
    );
}
