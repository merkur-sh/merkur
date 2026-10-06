//! Strict standard-alphabet base64 for Kitty payload chunks, decoded by simdutf.
//!
//! simdutf decodes at about 20 GB/s, measured 3.56x faster than the `base64`
//! crate over a 2400x1360 RGBA image in Kitty's 4,096-byte chunks, but its
//! decoder is WHATWG forgiving-base64: it skips ASCII whitespace, and its
//! `Loose` mode accepts nonzero unused bits in a partial final group. This
//! wrapper restores strict RFC 4648 decoding without a second pass. It derives
//! the exact decoded length from the input (padding count and position checked
//! here), checks the final group's unused bits, and requires simdutf's output
//! count to equal that length. A skipped character always shortens the output,
//! so no leniency can pass. Padded and unpadded final chunks are both accepted,
//! because Kitty's icat omits the padding.

/// Decode `input` into `output`, returning the byte count, or `None` for any
/// input the strict standard alphabet refuses or that does not fit `output`.
pub fn decode(input: &[u8], output: &mut [u8]) -> Option<usize> {
    let padding = input.iter().rev().take_while(|byte| **byte == b'=').count();
    let body = input.len() - padding;
    let tail = body % 4;
    // A lone final character carries six bits, less than one byte.
    if tail == 1 || padding > 2 {
        return None;
    }
    // Padding completes the final quartet exactly, or is absent.
    if padding != 0 && padding != 4 - tail {
        return None;
    }
    let expected = body / 4 * 3
        + match tail {
            2 => 1,
            3 => 2,
            _ => 0,
        };
    if expected > output.len() {
        return None;
    }
    if tail != 0 {
        let last = sextet(input[body - 1])?;
        let unused_bits = if tail == 2 { 0x0f } else { 0x03 };
        if last & unused_bits != 0 {
            return None;
        }
    }
    // SAFETY: `input` is readable for its length, and `output` holds at least
    // `expected` bytes, which is the most a strict decode of `input` writes.
    // simdutf writes no more than the decoded length of the characters it
    // accepts, which is never more than the strict length computed above.
    let result = unsafe {
        simdutf::base64_to_binary(
            input.as_ptr(),
            input.len(),
            output.as_mut_ptr(),
            simdutf::Base64Options::Default,
            simdutf::LastChunkHandlingOptions::Loose,
        )
    };
    (result.error == simdutf::ErrorCode::Success && result.count == expected).then_some(expected)
}

fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::decode;
    use base64::Engine as _;

    /// The decoder this replaced: engine chosen by the trailing `=`.
    fn reference(input: &[u8], output: &mut [u8]) -> Option<usize> {
        let engine = if input.last() == Some(&b'=') {
            &base64::prelude::BASE64_STANDARD
        } else {
            &base64::prelude::BASE64_STANDARD_NO_PAD
        };
        engine.decode_slice(input, output).ok()
    }

    fn agree(input: &[u8]) {
        let (mut expected, mut actual) = (vec![0u8; 8192], vec![0u8; 8192]);
        let want = reference(input, &mut expected);
        let got = decode(input, &mut actual);
        assert_eq!(got, want, "verdict for {:?}", String::from_utf8_lossy(input));
        if let Some(n) = want {
            assert_eq!(actual[..n], expected[..n]);
        }
    }

    #[test]
    fn edge_vectors_match_the_strict_reference() {
        for input in [
            &b""[..],
            b"QQ",
            b"QR",
            b"QQ==",
            b"QR==",
            b"QQ=",
            b"QUI",
            b"QUJ",
            b"QUI=",
            b"QUJ=",
            b"Q",
            b"QUJD",
            b" QUJD",
            b"QU JD",
            b"QUJD\n",
            b"QUJD\tQUJD",
            b"QU=D",
            b"QUJD====",
            b"=QUJ",
            b"QQ==QUJD",
            b"QUJ-",
            b"QUJ_",
        ] {
            agree(input);
        }
        // SIMD blocks engage only past their width: plant the bad byte deep.
        let long = base64::prelude::BASE64_STANDARD_NO_PAD.encode(vec![0x5a_u8; 3000]);
        for (at, bad) in [(1000, b' '), (1000, b'\n'), (2001, b'-'), (1500, b'=')] {
            let mut input = long.clone().into_bytes();
            input[at] = bad;
            agree(&input);
        }
        let mut tail_bits = long.clone().into_bytes();
        tail_bits.truncate(4 * 500 + 2);
        *tail_bits.last_mut().expect("nonempty") = b'R';
        agree(&tail_bits);
        agree(long.as_bytes());
    }

    #[test]
    fn a_short_output_buffer_is_refused_rather_than_overrun() {
        let encoded = base64::prelude::BASE64_STANDARD.encode([7u8; 300]);
        let mut output = vec![0u8; 299];
        assert_eq!(decode(encoded.as_bytes(), &mut output), None);
    }

    /// Seeded differential fuzz: random short inputs over a mixed alphabet, and
    /// one-to-three-byte mutations or truncations of a long valid input.
    #[test]
    fn differential_fuzz_matches_the_strict_reference() {
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let noise = b"= \n\t-_.\x00\xff\r";
        let long = base64::prelude::BASE64_STANDARD
            .encode((0..3000u32).map(|i| (i * 31 % 251) as u8).collect::<Vec<_>>())
            .into_bytes();
        let mut valid = 0;
        for round in 0..200_000 {
            let input: Vec<u8> = if round % 4 == 0 {
                let mut input = long.clone();
                if next() % 3 == 0 {
                    let keep = (next() as usize) % input.len();
                    input.truncate(keep);
                }
                for _ in 0..(1 + next() % 3) {
                    if input.is_empty() {
                        break;
                    }
                    let at = (next() as usize) % input.len();
                    let pool = if next() % 2 == 0 { &alphabet[..] } else { &noise[..] };
                    input[at] = pool[(next() as usize) % pool.len()];
                }
                input
            } else {
                let len = (next() % 70) as usize;
                (0..len)
                    .map(|_| {
                        if next() % 10 == 0 {
                            noise[(next() as usize) % noise.len()]
                        } else {
                            alphabet[(next() as usize) % alphabet.len()]
                        }
                    })
                    .collect()
            };
            if reference(&input, &mut vec![0u8; 8192]).is_some() {
                valid += 1;
            }
            agree(&input);
        }
        assert!(valid > 10_000, "the fuzz must exercise the accepting path, saw {valid}");
    }
}
