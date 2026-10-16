use poly1305::Poly1305;
use poly1305::universal_hash::{KeyInit, UniversalHash};
use ring::hmac;
use subtle::ConstantTimeEq;

fn verified(key: &hmac::Key, message: &[u8], presented: &[u8]) -> bool {
    hmac::verify(key, message, presented).is_ok()
}

fn constant_time(key: &hmac::Key, message: &[u8], presented: &[u8]) -> bool {
    let tag = hmac::sign(key, message);
    tag.as_ref().len() == presented.len() && bool::from(tag.as_ref().ct_eq(presented))
}

fn compared(key: &hmac::Key, message: &[u8], presented: &[u8]) -> bool {
    hmac::sign(key, message).as_ref() == presented // $ Alert
}

fn truncated(key: &hmac::Key, message: &[u8], presented: &[u8; 20]) -> bool {
    let mut context = hmac::Context::with_key(key);
    context.update(message);
    let tag = context.sign(); // $ Source
    tag.as_ref()[..20] != presented[..] // $ Alert
}

fn owned(key: &[u8; 32], message: &[u8], presented: &Vec<u8>) -> bool {
    let tag = Poly1305::new(key.into()).compute_unpadded(message); // $ Source
    let bytes = tag.to_vec();
    bytes.eq(presented) // $ Alert
}

fn sent(key: &hmac::Key, message: &[u8], expected: &[u8]) -> bool {
    let mut frame = message.to_vec();
    frame.extend_from_slice(hmac::sign(key, message).as_ref());
    frame[..message.len()] == *expected
}

fn pinned(key: &hmac::Key) {
    assert_eq!(hmac::sign(key, b"vector").as_ref(), [0u8; 32].as_slice());
}

fn main() {
    pinned(&hmac::Key::new(hmac::HMAC_SHA256, &[7u8; 32]));
    let key = hmac::Key::new(hmac::HMAC_SHA256, &[7u8; 32]);
    let _ = verified(&key, b"m", b"t");
    let _ = constant_time(&key, b"m", b"t");
    let _ = compared(&key, b"m", b"t");
    let _ = truncated(&key, b"m", &[0u8; 20]);
    let _ = owned(&[7u8; 32], b"m", &vec![0u8; 16]);
    let _ = sent(&key, b"m", b"m");
}
