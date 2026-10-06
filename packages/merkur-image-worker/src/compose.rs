//! Private confined pixel composition. This module is linked only into the
//! helper executable, never the process which holds terminal keys.

use merkur_graphics::processing::{Pixels, pixel_bytes};
use merkur_image_worker::composition::{REQUEST_BYTES, Request};
use std::io::Read;

pub(crate) fn receive(input: &mut impl Read) -> Result<Pixels, ()> {
    let mut header = [0; REQUEST_BYTES];
    input.read_exact(&mut header).map_err(|_| ())?;
    let request = Request::decode(&header).ok_or(())?;
    let mut base = vec![0; pixel_bytes(request.width, request.height, 4).ok_or(())?];
    input.read_exact(&mut base).map_err(|_| ())?;
    // Source rows are consumed once. Composition needs no second canvas-sized
    // buffer, including when the source and destination share an original frame.
    let mut row = vec![0; request.patch_width as usize * 4];
    for y in request.y..request.y + request.patch_height {
        input.read_exact(&mut row).map_err(|_| ())?;
        let offset = (y as usize * request.width as usize + request.x as usize) * 4;
        let destination = &mut base[offset..offset + row.len()];
        if request.overwrite {
            destination.copy_from_slice(&row);
        } else {
            source_over(destination, &row);
        }
    }
    if input.read(&mut [0]).map_err(|_| ())? != 0 {
        return Err(());
    }
    Pixels::new(request.width, request.height, base.into()).ok_or(())
}

fn source_over(destination: &mut [u8], source: &[u8]) {
    for (destination, source) in destination.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
        let alpha = u32::from(source[3]);
        if alpha == 0 {
            continue;
        }
        if alpha == 255 || destination[3] == 0 {
            destination.copy_from_slice(source);
            continue;
        }
        // Porter-Duff source-over on straight-alpha sRGB channel values. Keep
        // full integer precision until the final nearest-integer quantization;
        // intermediate premultiplication would lose low-alpha channel values.
        let under = u32::from(destination[3]) * (255 - alpha);
        let total = alpha * 255 + under;
        for channel in 0..3 {
            destination[channel] = ((u32::from(source[channel]) * alpha * 255
                + u32::from(destination[channel]) * under
                + total / 2)
                / total) as u8;
        }
        destination[3] = ((total + 127) / 255) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_composition_matches_independent_floating_point_porter_duff() {
        for a in 0..=255u8 {
            for b in 0..=255u8 {
                let original = [13, 191, 249, b];
                let source = [243, 3, 47, a];
                let mut actual = original;
                source_over(&mut actual, &source);
                if a == 0 {
                    assert_eq!(actual, original);
                    continue;
                }
                // Unnormalized weights avoid introducing error before division
                // at exact half-integer results (for example 208.5).
                let sa = f64::from(a) * 255.0;
                let da = f64::from(b) * f64::from(255 - a);
                let total = sa + da;
                let mut expected = [0; 4];
                for c in 0..3 {
                    expected[c] = ((f64::from(source[c]) * sa + f64::from(original[c]) * da)
                        / total)
                        .round() as u8;
                }
                expected[3] = (total / 255.0).round() as u8;
                assert_eq!(actual, expected, "source alpha {a}, destination alpha {b}");
            }
        }
    }

    #[test]
    fn composition_changes_only_the_requested_rectangle_and_requires_exact_input() {
        let request = Request {
            width: 3,
            height: 2,
            x: 1,
            y: 1,
            patch_width: 1,
            patch_height: 1,
            overwrite: true,
        };
        let mut input = request.encode().to_vec();
        input.extend_from_slice(&[17; 24]);
        input.extend_from_slice(&[4, 5, 6, 0]);
        let pixels = receive(&mut input.as_slice()).unwrap();
        assert_eq!(&pixels.rgba()[..16], &[17; 16]);
        assert_eq!(&pixels.rgba()[16..20], &[4, 5, 6, 0]);
        assert_eq!(&pixels.rgba()[20..], &[17; 4]);
        for end in 0..input.len() {
            assert!(receive(&mut &input[..end]).is_err());
        }
        input.push(0);
        assert!(receive(&mut input.as_slice()).is_err());
    }
}
