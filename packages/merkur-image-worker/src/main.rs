mod arena;
mod compose;
mod gamma;
mod inflate;
mod sandbox;
mod strict_base64;

use merkur_graphics::command::{Format, MAX_CHUNK_BYTES};
use merkur_graphics::processing::{
    DecodeRequest, FINAL_CHUNK, MAX_INPUT_BYTES, MAX_RGBA_BYTES, Pixels, REQUEST_BYTES,
    RESULT_BYTES, Rejection, WORKER_READY, pixel_bytes,
};
use std::io::{self, Read, Write};

fn main() {
    // No logging, runtime, environment lookup, or image parsing before confinement.
    if sandbox::enter().is_err() {
        std::process::exit(70);
    }
    let mut args = std::env::args().skip(1);
    let result = match args.next() {
        None => serve(&mut io::stdin().lock(), &mut io::stdout().lock()),
        Some(mode) if mode == "--descriptor" => {
            let request = args
                .next()
                .and_then(|arg| merkur_image_worker::descriptor::Request::from_argument(&arg));
            match request.filter(|_| args.next().is_none()) {
                Some(request) => serve_descriptor(request, &mut io::stdout().lock()),
                None => Err(io::Error::other("invalid descriptor request")),
            }
        }
        Some(mode) if mode == "--compose" && args.next().is_none() => {
            let input = &mut io::stdin().lock();
            let output = &mut io::stdout().lock();
            output
                .write_all(&WORKER_READY)
                .and_then(|()| output.flush())
                .and_then(|()| {
                    write_result(
                        compose::receive(input).map_err(|()| Rejection::Invalid),
                        output,
                    )
                })
        }
        Some(_) => Err(io::Error::other("invalid worker operation")),
    };
    std::process::exit(if result.is_ok() { 0 } else { 71 });
}

fn serve(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    output.write_all(&WORKER_READY)?;
    output.flush()?;
    let mut header = [0; REQUEST_BYTES];
    input.read_exact(&mut header)?;
    let result = DecodeRequest::decode(&header)
        .ok_or(Rejection::Invalid)
        .and_then(|request| receive(input, request).and_then(|bytes| decode(request, bytes)));
    write_result(result, output)
}

fn write_result(result: Result<Pixels, Rejection>, output: &mut impl Write) -> io::Result<()> {
    let mut header = [0; RESULT_BYTES];
    match result {
        Ok(pixels) => {
            header[4..8].copy_from_slice(&pixels.width().to_le_bytes());
            header[8..12].copy_from_slice(&pixels.height().to_le_bytes());
            header[12..16].copy_from_slice(&(pixels.rgba().len() as u32).to_le_bytes());
            output.write_all(&header)?;
            output.write_all(pixels.rgba())?;
        }
        Err(rejection) => {
            // Fixed failure class, never decoder metadata, paths, or image contents.
            header[0] = 1;
            header[1] = rejection as u8;
            output.write_all(&header)?;
        }
    }
    output.flush()
}

fn serve_descriptor(
    request: merkur_image_worker::descriptor::Request,
    output: &mut impl Write,
) -> io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::FileExt;

    output.write_all(&WORKER_READY)?;
    output.flush()?;
    // SAFETY: descriptor-mode startup has not constructed or borrowed stdin.
    // Take its unique ownership, and close it before parsing any image bytes.
    let file = unsafe { std::fs::File::from_raw_fd(0) };
    let snapshot = (|| {
        // std metadata uses statx on Linux, which can inspect paths and is
        // deliberately denied. Use the allowlisted descriptor-only syscall.
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: the file owns a live descriptor and metadata is a valid output
        // buffer for the native stat ABI on our 64-bit Linux/macOS targets.
        #[cfg(target_os = "linux")]
        let status = unsafe { libc::syscall(libc::SYS_fstat, file.as_raw_fd(), metadata.as_mut_ptr()) };
        // SAFETY: the file owns a live descriptor, and `metadata` is a live
        // `stat` slot `fstat` writes once.
        #[cfg(not(target_os = "linux"))]
        let status = unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) };
        if status != 0 {
            return Err(());
        }
        // SAFETY: a successful fstat initialized the complete metadata structure.
        let metadata = unsafe { metadata.assume_init() };
        let end = request.offset.checked_add(request.length).ok_or(())?;
        let file_size = u64::try_from(metadata.st_size).map_err(|_| ())?;
        if !request.valid() || metadata.st_mode & libc::S_IFMT != libc::S_IFREG || end > file_size {
            return Err(());
        }
        let length = usize::try_from(request.length).map_err(|_| ())?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|_| ())?;
        bytes.resize(length, 0);
        // Positional IO leaves the sender's shared open-file offset untouched.
        // Truncation becomes a short-read error, never a mapped-page fault.
        file.read_exact_at(&mut bytes, request.offset)
            .map_err(|_| ())?;
        Ok(bytes)
    })();
    drop(file);
    write_result(
        snapshot
            .map_err(|()| Rejection::Invalid)
            .and_then(|bytes| decode(request.decode, bytes)),
        output,
    )
}

fn receive(input: &mut impl Read, request: DecodeRequest) -> Result<Vec<u8>, Rejection> {
    request.inflated_limit().ok_or(Rejection::Invalid)?;
    let mut bytes = Vec::new();
    let mut encoded = [0; MAX_CHUNK_BYTES];
    let mut decoded = [0; MAX_CHUNK_BYTES];
    loop {
        let mut prefix = [0; 4];
        input
            .read_exact(&mut prefix)
            .map_err(|_| Rejection::Invalid)?;
        let count = u32::from_le_bytes(prefix);
        let final_chunk = count & FINAL_CHUNK != 0;
        let len = (count & !FINAL_CHUNK) as usize;
        if len > encoded.len() {
            return Err(Rejection::Invalid);
        }
        input
            .read_exact(&mut encoded[..len])
            .map_err(|_| Rejection::Invalid)?;
        let chunk = if request.base64 {
            // Intermediate chunks end on a quartet and cannot contain padding.
            // Kitty's icat omits final padding; the strict decoder accepts a
            // padded or unpadded final quartet and rejects nonzero unused bits.
            if !final_chunk && (!len.is_multiple_of(4) || encoded[..len].contains(&b'=')) {
                return Err(Rejection::Invalid);
            }
            let n = strict_base64::decode(&encoded[..len], &mut decoded).ok_or(Rejection::Invalid)?;
            &decoded[..n]
        } else {
            &encoded[..len]
        };
        // The owner bounds encoded bytes, up to two past this decoded bound.
        let total = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or(Rejection::Excess)?;
        if total > MAX_INPUT_BYTES {
            return Err(Rejection::Excess);
        }
        bytes
            .try_reserve(chunk.len())
            .map_err(|_| Rejection::Invalid)?;
        bytes.extend_from_slice(chunk);
        if final_chunk {
            return Ok(bytes);
        }
    }
}

fn decode(request: DecodeRequest, mut bytes: Vec<u8>) -> Result<Pixels, Rejection> {
    let limit = request.inflated_limit().ok_or(Rejection::Invalid)?;
    if request.compressed {
        let mut inflated = Vec::new();
        inflated
            .try_reserve_exact(limit)
            .map_err(|_| Rejection::Invalid)?;
        inflated.resize(limit, 0);
        inflate::zlib_exact(&bytes, &mut inflated).ok_or(Rejection::Invalid)?;
        bytes = inflated;
    } else if request.format != Format::Png {
        // Kitty answers short uncompressed pixels with ENODATA, and more than its
        // load buffer holds with EFBIG.
        if bytes.len() < limit {
            return Err(Rejection::Truncated);
        }
        if bytes.len() > limit {
            return Err(Rejection::Excess);
        }
    }
    match request.format {
        Format::Rgba => Pixels::new(request.width, request.height, bytes.into_boxed_slice())
            .ok_or(Rejection::Invalid),
        Format::Rgb => {
            let rgba_len =
                pixel_bytes(request.width, request.height, 4).ok_or(Rejection::Invalid)?;
            let mut rgba = Vec::new();
            rgba.try_reserve_exact(rgba_len)
                .map_err(|_| Rejection::Invalid)?;
            for pixel in bytes.chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
            Pixels::new(request.width, request.height, rgba.into_boxed_slice())
                .ok_or(Rejection::Invalid)
        }
        Format::Png => decode_png(&bytes).ok_or(Rejection::Png),
    }
}

fn decode_png(bytes: &[u8]) -> Option<Pixels> {
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits {
            bytes: MAX_RGBA_BYTES,
        },
    );
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    // Sixteen-bit samples reach gamma correction before their reduction to
    // eight bits, as in libpng; they are reduced here rather than by the decoder.
    let wide = decoder.read_header_info().ok()?.bit_depth == png::BitDepth::Sixteen;
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().ok()?;
    let info = reader.info();
    let (width, height) = (info.width, info.height);
    let gamma = info
        .gamma()
        .map(png::ScaledFloat::into_scaled)
        .filter(|gamma| gamma::applies(*gamma));
    let bits = match (info.color_type, info.sbit.as_deref()) {
        (png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha, Some([gray, ..])) => *gray,
        (_, Some([red, green, blue, ..])) => *red.max(green).max(blue),
        _ => 16,
    };
    let rgba_len = pixel_bytes(width, height, 4)?;
    let size = reader
        .output_buffer_size()
        .filter(|&n| n <= rgba_len * if wide { 2 } else { 1 })?;
    let mut decoded = vec![0; size];
    let info = reader.next_frame(&mut decoded).ok()?;
    reader.finish().ok()?;
    let channels = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale => 1,
        _ => return None,
    };
    // Sample index of each RGB component: gray repeats its single sample.
    // A trailing sample is straight alpha, which is never gamma corrected.
    let component = |index: usize| if channels > 2 { index } else { 0 };
    let alpha = (channels % 2 == 0).then_some(channels - 1);
    let rgba = match info.bit_depth {
        png::BitDepth::Sixteen => {
            // Without a correction, reduction keeps each sample's high byte.
            let table = gamma.map(|gamma| gamma::table16(gamma, bits));
            let mut rgba = Vec::with_capacity(rgba_len);
            for pixel in decoded.chunks_exact(channels * 2) {
                let color = |index: usize| {
                    let at = component(index) * 2;
                    let sample = u16::from_be_bytes([pixel[at], pixel[at + 1]]);
                    table.as_ref().map_or(pixel[at], |(shift, table)| {
                        table[usize::from(sample >> shift)]
                    })
                };
                let alpha = alpha.map_or(255, |index| pixel[index * 2]);
                rgba.extend_from_slice(&[color(0), color(1), color(2), alpha]);
            }
            rgba
        }
        png::BitDepth::Eight => {
            let table = gamma.map(gamma::table8);
            let correct = |value: u8| {
                table
                    .as_ref()
                    .map_or(value, |table| table[usize::from(value)])
            };
            if channels == 4 {
                if table.is_some() {
                    for pixel in decoded.chunks_exact_mut(4) {
                        for value in &mut pixel[..3] {
                            *value = correct(*value);
                        }
                    }
                }
                decoded
            } else {
                let mut rgba = Vec::with_capacity(rgba_len);
                for pixel in decoded.chunks_exact(channels) {
                    let color = |index| correct(pixel[component(index)]);
                    let alpha = alpha.map_or(255, |index| pixel[index]);
                    rgba.extend_from_slice(&[color(0), color(1), color(2), alpha]);
                }
                rgba
            }
        }
        _ => return None,
    };
    Pixels::new(width, height, rgba.into_boxed_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn request(format: Format, compressed: bool) -> DecodeRequest {
        DecodeRequest {
            format,
            compressed,
            base64: true,
            width: 1,
            height: 1,
            inflated_bytes: 0,
        }
    }

    #[test]
    fn raw_pixels_have_exact_extents() {
        assert_eq!(
            decode(request(Format::Rgb, false), vec![5, 7, 9])
                .unwrap()
                .rgba(),
            &[5, 7, 9, 255]
        );
        // Kitty answers raw pixels past its load buffer with EFBIG.
        assert_eq!(
            decode(request(Format::Rgb, false), vec![5, 7, 9, 0]).err(),
            Some(Rejection::Excess)
        );
        assert_eq!(
            decode(request(Format::Rgba, false), vec![5, 7, 9, 11, 0]).err(),
            Some(Rejection::Excess)
        );
        // Kitty answers short uncompressed pixels with ENODATA.
        assert_eq!(
            decode(request(Format::Rgba, false), vec![5, 7, 9]).err(),
            Some(Rejection::Truncated)
        );
        assert_eq!(
            decode(request(Format::Rgb, false), vec![5, 7]).err(),
            Some(Rejection::Truncated)
        );
        assert_eq!(
            decode(request(Format::Png, false), b"not a png".to_vec()).err(),
            Some(Rejection::Png)
        );
    }

    #[test]
    fn input_past_the_resource_bound_is_excess() {
        // Unencoded chunks, so the decoded bound is reached byte for byte.
        let request = DecodeRequest {
            base64: false,
            ..request(Format::Png, false)
        };
        let mut input = request.encode().to_vec();
        for _ in 0..MAX_INPUT_BYTES / MAX_CHUNK_BYTES {
            input.extend_from_slice(&(MAX_CHUNK_BYTES as u32).to_le_bytes());
            input.resize(input.len() + MAX_CHUNK_BYTES, 0);
        }
        input.extend_from_slice(&(FINAL_CHUNK | 1).to_le_bytes());
        input.push(0);
        let mut output = Vec::new();
        serve(&mut input.as_slice(), &mut output).unwrap();
        assert_eq!(output[..4], WORKER_READY);
        assert_eq!(output[4..6], [1, Rejection::Excess as u8]);
    }

    #[test]
    fn zlib_requires_exact_output_and_no_trailing_stream() {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&[5, 7, 9]).unwrap();
        let bytes = encoder.finish().unwrap();
        assert!(decode(request(Format::Rgb, true), bytes.clone()).is_ok());
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(
            decode(request(Format::Rgb, true), trailing).err(),
            Some(Rejection::Invalid)
        );
        // A short inflated stream is a size mismatch, not truncated input.
        assert_eq!(
            decode(request(Format::Rgba, true), bytes).err(),
            Some(Rejection::Invalid)
        );
    }

    #[test]
    fn base64_is_strict_and_padding_cannot_end_an_intermediate_chunk() {
        let mut input = Vec::new();
        input.extend_from_slice(&4u32.to_le_bytes());
        input.extend_from_slice(b"YQ==");
        assert!(receive(&mut input.as_slice(), request(Format::Rgb, false)).is_err());
        let mut input = Vec::new();
        input.extend_from_slice(&(FINAL_CHUNK | 4).to_le_bytes());
        input.extend_from_slice(b"BQcJ");
        assert_eq!(
            receive(&mut input.as_slice(), request(Format::Rgb, false)).unwrap(),
            [5, 7, 9]
        );
    }

    #[test]
    fn final_base64_accepts_canonical_padded_and_unpadded_residues() {
        for length in 0..128 {
            let bytes: Vec<_> = (0..length).map(|n| (n * 53) as u8).collect();
            for engine in [
                &base64::prelude::BASE64_STANDARD,
                &base64::prelude::BASE64_STANDARD_NO_PAD,
            ] {
                let encoded = engine.encode(&bytes);
                // Exercise every legal chunk boundary, including an empty final
                // chunk after complete quartets. No byte is lost or duplicated.
                for split in (0..=encoded.len()).step_by(4) {
                    if encoded.as_bytes()[..split].contains(&b'=') {
                        continue;
                    }
                    let mut input = Vec::new();
                    input.extend_from_slice(&(split as u32).to_le_bytes());
                    input.extend_from_slice(&encoded.as_bytes()[..split]);
                    input.extend_from_slice(
                        &(FINAL_CHUNK | (encoded.len() - split) as u32).to_le_bytes(),
                    );
                    input.extend_from_slice(&encoded.as_bytes()[split..]);
                    assert_eq!(
                        receive(&mut input.as_slice(), request(Format::Rgb, false)).unwrap(),
                        bytes,
                    );
                }
            }
        }
    }

    #[test]
    fn base64_rejects_ambiguous_suffixes_and_partial_intermediate_quartets() {
        for encoded in [
            "A", "YQ=", "YR", "YR==", "YWJ", "YWJ=", "YQ===", "YQ==AA", "YQ\n",
        ] {
            let mut input = Vec::new();
            input.extend_from_slice(&(FINAL_CHUNK | encoded.len() as u32).to_le_bytes());
            input.extend_from_slice(encoded.as_bytes());
            assert!(
                receive(&mut input.as_slice(), request(Format::Rgb, false)).is_err(),
                "accepted {encoded:?}",
            );
        }
        for encoded in ["YQ", "YWI", "YQ=="] {
            let mut input = Vec::new();
            input.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
            input.extend_from_slice(encoded.as_bytes());
            input.extend_from_slice(&(FINAL_CHUNK | 4).to_le_bytes());
            input.extend_from_slice(b"BQcJ");
            assert!(receive(&mut input.as_slice(), request(Format::Rgb, false)).is_err());
        }
    }

    #[test]
    fn png_checks_dimensions_crc_and_complete_file() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[5, 7, 9, 11]).unwrap();
        }
        assert_eq!(decode_png(&bytes).unwrap().rgba(), &[5, 7, 9, 11]);
        assert!(decode_png(&bytes[..bytes.len() - 8]).is_none());
        bytes[29] ^= 1;
        assert!(decode_png(&bytes).is_none());
    }

    fn png_with_gamma(
        color: png::ColorType,
        depth: png::BitDepth,
        gamma: Option<u32>,
        srgb: bool,
        data: &[u8],
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
            encoder.set_color(color);
            encoder.set_depth(depth);
            if let Some(gamma) = gamma {
                encoder.set_source_gamma(png::ScaledFloat::from_scaled(gamma));
            }
            if srgb {
                encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
            }
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(data).unwrap();
        }
        bytes
    }

    #[test]
    fn png_gamma_matches_the_reference_decoder_and_leaves_alpha_straight() {
        use png::{BitDepth, ColorType};
        // Kitty 0.48.2 decodes gAMA 1.0 samples 64 and 128 as 136 and 186.
        let rgba = [64, 128, 0, 77, 255, 1, 128, 128];
        let linear = png_with_gamma(ColorType::Rgba, BitDepth::Eight, Some(100000), false, &rgba);
        assert_eq!(
            decode_png(&linear).unwrap().rgba(),
            &[136, 186, 0, 77, 255, 21, 186, 128]
        );
        // sRGB overrides gAMA, and gAMA 1/2.2 needs no correction.
        for (gamma, srgb) in [(Some(100000), true), (Some(45455), false), (None, false)] {
            let bytes = png_with_gamma(ColorType::Rgba, BitDepth::Eight, gamma, srgb, &rgba);
            assert_eq!(decode_png(&bytes).unwrap().rgba(), &rgba);
        }
        // Sixteen-bit samples are corrected before their reduction to eight bits.
        let wide = [
            0x80, 0x00, 0x40, 0x00, 0x20, 0x00, 0x80, 0xff, 0x40, 0xff, 0x20, 0xff,
        ];
        let bytes = png_with_gamma(
            ColorType::Rgb,
            BitDepth::Sixteen,
            Some(100000),
            false,
            &wide,
        );
        assert_eq!(
            decode_png(&bytes).unwrap().rgba(),
            &[0xba, 0x88, 0x63, 255, 0xbb, 0x89, 0x64, 255]
        );
        let gray = png_with_gamma(
            ColorType::GrayscaleAlpha,
            BitDepth::Eight,
            Some(100000),
            false,
            &[64, 9, 128, 200],
        );
        assert_eq!(
            decode_png(&gray).unwrap().rgba(),
            &[136, 136, 136, 9, 186, 186, 186, 200]
        );
    }
}
