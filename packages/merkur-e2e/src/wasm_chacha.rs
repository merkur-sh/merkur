//! Browser ChaCha20-Poly1305 for every sealed and opened frame, using wasm `simd128`.
//!
//! Snow's pure-Rust resolver runs RustCrypto's scalar backends on wasm32; there
//! is no wasm SIMD backend in `chacha20`. ChaCha20 is about three quarters of
//! the per-frame AEAD cost there, so this module replaces it with a four-block
//! kernel: one block per lane, 16- and 8-bit rotations as byte shuffles, and an
//! in-register 4x4 transpose so the keystream is XORed with 128-bit loads and
//! stores. One batch at counter 0 yields the Poly1305 key (block 0) and the
//! keystream for the first 192 bytes (blocks 1-3), so a keystroke or ACK costs a
//! single batch. Poly1305 stays on the audited `poly1305` crate.
//!
//! Measured through the shipped e2e-wasm artifact (`bench:e2e-crypto`, paired
//! rounds against the build it replaced): 32-byte datagram seal -19% and open
//! -12%, 8 KiB stream seal and open -28%. The cipher is RFC 8439
//! ChaCha20-Poly1305 with Noise's nonce encoding, byte-exact with the resolver
//! it replaces; the tests below pin that against RFC vectors and
//! differentially against RustCrypto.

#[cfg(not(target_feature = "simd128"))]
compile_error!("the browser transport cipher needs wasm simd128; e2e-wasm enables it in .cargo/config.toml");

use core::arch::wasm32::{
    i8x16_shuffle, i32x4_shuffle, u32x4, u32x4_add, u32x4_shl, u32x4_shr, u32x4_splat, v128,
    v128_load, v128_or, v128_store, v128_xor,
};

use poly1305::universal_hash::{KeyInit, UniversalHash};
use snow::types::Cipher;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

/// Snow's `CIPHERKEYLEN` and `TAGLEN` (its `constants` module is private).
const CIPHERKEYLEN: usize = 32;
const TAGLEN: usize = 16;

/// Four blocks per batch: one ChaCha20 block per `u32x4` lane.
const BATCH_BYTES: usize = 256;
/// Blocks 1-3 of the counter-0 batch: the keystream that shares its batch with
/// the Poly1305 key.
const HEAD_BYTES: usize = BATCH_BYTES - 64;

#[inline(always)]
fn rotate_16(value: v128) -> v128 {
    i8x16_shuffle::<2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13>(value, value)
}

#[inline(always)]
fn rotate_8(value: v128) -> v128 {
    i8x16_shuffle::<3, 0, 1, 2, 7, 4, 5, 6, 11, 8, 9, 10, 15, 12, 13, 14>(value, value)
}

#[inline(always)]
fn rotate_12(value: v128) -> v128 {
    v128_or(u32x4_shl(value, 12), u32x4_shr(value, 20))
}

#[inline(always)]
fn rotate_7(value: v128) -> v128 {
    v128_or(u32x4_shl(value, 7), u32x4_shr(value, 25))
}

#[inline(always)]
fn quarter_round(x: &mut [v128; 16], a: usize, b: usize, c: usize, d: usize) {
    x[a] = u32x4_add(x[a], x[b]);
    x[d] = rotate_16(v128_xor(x[d], x[a]));
    x[c] = u32x4_add(x[c], x[d]);
    x[b] = rotate_12(v128_xor(x[b], x[c]));
    x[a] = u32x4_add(x[a], x[b]);
    x[d] = rotate_8(v128_xor(x[d], x[a]));
    x[c] = u32x4_add(x[c], x[d]);
    x[b] = rotate_7(v128_xor(x[b], x[c]));
}

/// Rows are state words across four blocks; columns become 16-byte block slices.
#[inline(always)]
fn transpose(a: v128, b: v128, c: v128, d: v128) -> [v128; 4] {
    let ab_low = i32x4_shuffle::<0, 4, 1, 5>(a, b);
    let ab_high = i32x4_shuffle::<2, 6, 3, 7>(a, b);
    let cd_low = i32x4_shuffle::<0, 4, 1, 5>(c, d);
    let cd_high = i32x4_shuffle::<2, 6, 3, 7>(c, d);
    [
        i32x4_shuffle::<0, 1, 4, 5>(ab_low, cd_low),
        i32x4_shuffle::<2, 3, 6, 7>(ab_low, cd_low),
        i32x4_shuffle::<0, 1, 4, 5>(ab_high, cd_high),
        i32x4_shuffle::<2, 3, 6, 7>(ab_high, cd_high),
    ]
}

/// The RFC 8439 initial state with every word broadcast to all four lanes.
fn initial_state(key: &[u8; CIPHERKEYLEN], nonce: &[u8; 12]) -> [v128; 16] {
    let word = |bytes: &[u8], at: usize| {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    };
    let mut state = [u32x4_splat(0); 16];
    for (index, constant) in [0x6170_7865_u32, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]
        .into_iter()
        .enumerate()
    {
        state[index] = u32x4_splat(constant);
    }
    for index in 0..8 {
        state[4 + index] = u32x4_splat(word(key, 4 * index));
    }
    for index in 0..3 {
        state[13 + index] = u32x4_splat(word(nonce, 4 * index));
    }
    state
}

/// Keystream for the four consecutive blocks starting at `counter`.
#[inline(always)]
fn batch(state: &[v128; 16], counter: u32, out: &mut [u8; BATCH_BYTES]) {
    let mut initial = *state;
    initial[12] = u32x4_add(u32x4_splat(counter), u32x4(0, 1, 2, 3));
    let mut x = initial;
    for _ in 0..10 {
        quarter_round(&mut x, 0, 4, 8, 12);
        quarter_round(&mut x, 1, 5, 9, 13);
        quarter_round(&mut x, 2, 6, 10, 14);
        quarter_round(&mut x, 3, 7, 11, 15);
        quarter_round(&mut x, 0, 5, 10, 15);
        quarter_round(&mut x, 1, 6, 11, 12);
        quarter_round(&mut x, 2, 7, 8, 13);
        quarter_round(&mut x, 3, 4, 9, 14);
    }
    for (word, start) in x.iter_mut().zip(initial) {
        *word = u32x4_add(*word, start);
    }
    for group in 0..4 {
        let columns = transpose(
            x[4 * group],
            x[4 * group + 1],
            x[4 * group + 2],
            x[4 * group + 3],
        );
        for (block, slice) in columns.into_iter().enumerate() {
            let at = block * 64 + group * 16;
            // SAFETY: `at + 16 <= BATCH_BYTES`; wasm loads and stores are
            // byte-addressed, so the unaligned pointer is valid.
            unsafe { v128_store(out[at..at + 16].as_mut_ptr().cast(), slice) };
        }
    }
}

/// XOR `buffer` with `keystream`, 16 bytes at a time, then the byte tail.
#[inline(always)]
fn xor_into(buffer: &mut [u8], keystream: &[u8]) {
    debug_assert!(keystream.len() >= buffer.len());
    let whole = buffer.len() / 16 * 16;
    for at in (0..whole).step_by(16) {
        // `at + 16 <= whole <= buffer.len() <= keystream.len()`, and both
        // slices are bounds-checked here.
        let target = buffer[at..at + 16].as_mut_ptr().cast::<v128>();
        let stream = keystream[at..at + 16].as_ptr().cast::<v128>();
        // SAFETY: `target` addresses the 16 bytes of `buffer[at..at + 16]`;
        // wasm loads are byte-addressed, so the unaligned pointer is valid.
        let text = unsafe { v128_load(target) };
        // SAFETY: `stream` addresses the 16 bytes of `keystream[at..at + 16]`,
        // read the same way.
        let key = unsafe { v128_load(stream) };
        // SAFETY: `target` is still those 16 bytes of `buffer`, which this
        // function borrows mutably; wasm stores are byte-addressed too.
        unsafe { v128_store(target, v128_xor(text, key)) };
    }
    for (byte, stream) in buffer[whole..].iter_mut().zip(&keystream[whole..]) {
        *byte ^= stream;
    }
}

/// Apply the ChaCha20 keystream from `counter` onwards to `buffer`.
fn apply_keystream(state: &[v128; 16], mut counter: u32, buffer: &mut [u8]) {
    let mut keystream = [0u8; BATCH_BYTES];
    for chunk in buffer.chunks_mut(BATCH_BYTES) {
        batch(state, counter, &mut keystream);
        xor_into(chunk, &keystream);
        counter = counter.wrapping_add(4);
    }
}

/// The counter-0 batch: the Poly1305 key in bytes 0..32, and the keystream for
/// message bytes 0..192 in bytes 64..256.
///
/// Per-message keystream and the one-time Poly1305 key are not wiped: keystream
/// XOR the ciphertext is only the plaintext, which stays in memory regardless,
/// and a one-time key is spent once its nonce is (the replay window refuses a
/// second frame under it). Wiping them was measured at +12% on a 32-byte open,
/// the keystroke and ACK size. The long-lived key is wiped on drop.
fn first_batch(state: &[v128; 16]) -> [u8; BATCH_BYTES] {
    let mut keystream = [0u8; BATCH_BYTES];
    batch(state, 0, &mut keystream);
    keystream
}

/// Encrypt or decrypt `message` in place: its first 192 bytes use the counter-0
/// batch already computed for the Poly1305 key, the rest continues from block 4.
fn apply_message_keystream(state: &[v128; 16], first: &[u8; BATCH_BYTES], message: &mut [u8]) {
    let head = message.len().min(HEAD_BYTES);
    xor_into(&mut message[..head], &first[64..64 + head]);
    if message.len() > HEAD_BYTES {
        apply_keystream(state, 4, &mut message[HEAD_BYTES..]);
    }
}

fn tag(first: &[u8; BATCH_BYTES], aad: &[u8], ciphertext: &[u8]) -> [u8; TAGLEN] {
    let poly_key: &[u8; 32] = first[..32].try_into().expect("the batch starts with block 0");
    let mut mac = poly1305::Poly1305::new(poly_key.into());
    mac.update_padded(aad);
    mac.update_padded(ciphertext);
    let mut lengths = [0u8; 16];
    lengths[..8].copy_from_slice(&(aad.len() as u64).to_le_bytes());
    lengths[8..].copy_from_slice(&(ciphertext.len() as u64).to_le_bytes());
    mac.update_padded(&lengths);
    mac.finalize().into()
}

/// RFC 8439 AEAD seal in place; returns the detached tag.
fn seal(key: &[u8; CIPHERKEYLEN], nonce: &[u8; 12], aad: &[u8], message: &mut [u8]) -> [u8; TAGLEN] {
    let state = initial_state(key, nonce);
    let first = first_batch(&state);
    apply_message_keystream(&state, &first, message);
    tag(&first, aad, message)
}

/// RFC 8439 AEAD open: verify `expected` over `ciphertext` in constant time,
/// then decrypt into `out`. `out` is untouched when verification fails.
fn open(
    key: &[u8; CIPHERKEYLEN],
    nonce: &[u8; 12],
    aad: &[u8],
    ciphertext: &[u8],
    expected: &[u8],
    out: &mut [u8],
) -> bool {
    let state = initial_state(key, nonce);
    let first = first_batch(&state);
    let valid: bool = tag(&first, aad, ciphertext).ct_eq(expected).into();
    if valid {
        out[..ciphertext.len()].copy_from_slice(ciphertext);
        apply_message_keystream(&state, &first, &mut out[..ciphertext.len()]);
    }
    valid
}

/// Noise's ChaChaPoly nonce: 32 zero bits, then the 64-bit counter little-endian.
fn noise_nonce(nonce: u64) -> [u8; 12] {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&nonce.to_le_bytes());
    bytes
}

/// Drop-in for snow's `CipherChaChaPoly`: same name, nonce encoding, output
/// layout (`ciphertext || tag`) and verify-before-decrypt behaviour.
#[derive(Default)]
pub(crate) struct SimdChaChaPoly {
    key: [u8; CIPHERKEYLEN],
}

impl Drop for SimdChaChaPoly {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

impl Cipher for SimdChaChaPoly {
    fn name(&self) -> &'static str {
        "ChaChaPoly"
    }

    fn set(&mut self, key: &[u8; CIPHERKEYLEN]) {
        self.key = *key;
    }

    fn encrypt(&self, nonce: u64, authtext: &[u8], plaintext: &[u8], out: &mut [u8]) -> usize {
        let length = plaintext.len();
        out[..length].copy_from_slice(plaintext);
        let tag = seal(&self.key, &noise_nonce(nonce), authtext, &mut out[..length]);
        out[length..length + TAGLEN].copy_from_slice(&tag);
        length + TAGLEN
    }

    fn decrypt(
        &self,
        nonce: u64,
        authtext: &[u8],
        ciphertext: &[u8],
        out: &mut [u8],
    ) -> Result<usize, snow::Error> {
        let Some(length) = ciphertext.len().checked_sub(TAGLEN) else {
            return Err(snow::Error::Decrypt);
        };
        if out.len() < length {
            return Err(snow::Error::Decrypt);
        }
        let (body, expected) = ciphertext.split_at(length);
        if open(&self.key, &noise_nonce(nonce), authtext, body, expected, out) {
            Ok(length)
        } else {
            Err(snow::Error::Decrypt)
        }
    }
}

#[cfg(test)]
#[path = "wasm_chacha/wycheproof_tests.rs"]
mod wycheproof_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use chacha20poly1305::aead::AeadInPlace;
    use wasm_bindgen_test::wasm_bindgen_test;

    fn hex(text: &str) -> Vec<u8> {
        let digits: Vec<u8> = text.bytes().filter(u8::is_ascii_hexdigit).collect();
        digits
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    const SUNSCREEN: &[u8] = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";

    /// RFC 8439 section 2.4.2: ChaCha20 encryption from block counter 1.
    #[wasm_bindgen_test]
    fn rfc_8439_keystream_vector() {
        let key: [u8; 32] = core::array::from_fn(|index| index as u8);
        let nonce: [u8; 12] = hex("000000000000004a00000000").try_into().unwrap();
        let mut message = SUNSCREEN.to_vec();
        apply_keystream(&initial_state(&key, &nonce), 1, &mut message);
        assert_eq!(
            message,
            hex(
                "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b
                 f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8
                 07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736
                 5af90bbf74a35be6b40b8eedf2785e42874d"
            )
        );
    }

    /// RFC 8439 section 2.8.2: the AEAD test vector, with its 12-byte AAD.
    #[wasm_bindgen_test]
    fn rfc_8439_aead_vector() {
        let key: [u8; 32] = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
            .try_into()
            .unwrap();
        let nonce: [u8; 12] = hex("070000004041424344454647").try_into().unwrap();
        let aad = hex("50515253c0c1c2c3c4c5c6c7");
        let mut message = SUNSCREEN.to_vec();
        let tag = seal(&key, &nonce, &aad, &mut message);
        assert_eq!(
            message,
            hex(
                "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6
                 3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36
                 92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc
                 3ff4def08e4b7a9de576d26586cec64b6116"
            )
        );
        assert_eq!(tag.to_vec(), hex("1ae10b594f09e26a7e902ecbd0600691"));
        let mut opened = vec![0u8; message.len()];
        assert!(open(&key, &nonce, &aad, &message, &tag, &mut opened));
        assert_eq!(opened, SUNSCREEN);
    }

    /// Byte-exact against RustCrypto's ChaCha20-Poly1305 (the resolver this
    /// replaces) at every length through three batches and several nonces and
    /// AAD lengths, both through the raw AEAD and through snow's Cipher trait.
    #[wasm_bindgen_test]
    fn differential_against_rustcrypto_through_the_cipher_trait() {
        let key: [u8; 32] = core::array::from_fn(|index| (index * 29 + 3) as u8);
        let reference = chacha20poly1305::ChaCha20Poly1305::new(&key.into());
        let mut cipher = SimdChaChaPoly::default();
        cipher.set(&key);
        for nonce in [0u64, 1, 0x00ff_ffff_ffff_ffff, u64::MAX - 1] {
            for aad_len in [0usize, 1, 12, 16, 17, 64] {
                let aad: Vec<u8> = (0..aad_len).map(|index| (index * 7 + 1) as u8).collect();
                for length in (0..800).chain([1000, 1023, 1024, 1025, 2047, 2100, 8192]) {
                    let plaintext: Vec<u8> =
                        (0..length).map(|index| (index * 13 + length) as u8).collect();
                    let mut expected = plaintext.clone();
                    let expected_tag = reference
                        .encrypt_in_place_detached(&noise_nonce(nonce).into(), &aad, &mut expected)
                        .unwrap();
                    expected.extend_from_slice(&expected_tag);

                    let mut sealed = vec![0u8; length + TAGLEN];
                    assert_eq!(cipher.encrypt(nonce, &aad, &plaintext, &mut sealed), length + TAGLEN);
                    assert_eq!(sealed, expected, "nonce {nonce} aad {aad_len} length {length}");

                    let mut opened = vec![0u8; length];
                    assert_eq!(cipher.decrypt(nonce, &aad, &sealed, &mut opened).unwrap(), length);
                    assert_eq!(opened, plaintext);
                }
            }
        }
    }

    /// Any flipped bit in ciphertext, tag or AAD, a different nonce, or a
    /// truncated message is refused, and a refused open writes nothing.
    #[wasm_bindgen_test]
    fn forgeries_are_refused_without_writing_plaintext() {
        let mut cipher = SimdChaChaPoly::default();
        cipher.set(&[9u8; 32]);
        let aad = b"merkur.content.chunk";
        for length in [0usize, 1, 191, 192, 193, 754, 1200] {
            let plaintext = vec![0x42u8; length];
            let mut sealed = vec![0u8; length + TAGLEN];
            cipher.encrypt(7, aad, &plaintext, &mut sealed);
            for at in 0..sealed.len() {
                let mut forged = sealed.clone();
                forged[at] ^= 0x01;
                let mut out = vec![0xaau8; length];
                assert!(cipher.decrypt(7, aad, &forged, &mut out).is_err(), "bit at {at} of {length}");
                assert!(out.iter().all(|byte| *byte == 0xaa), "a refused open wrote plaintext");
            }
            let mut out = vec![0u8; length];
            assert!(cipher.decrypt(8, aad, &sealed, &mut out).is_err());
            assert!(cipher.decrypt(7, b"merkur.content.chunK", &sealed, &mut out).is_err());
            assert!(cipher.decrypt(7, aad, &sealed[..TAGLEN - 1], &mut out).is_err());
        }
    }
}
