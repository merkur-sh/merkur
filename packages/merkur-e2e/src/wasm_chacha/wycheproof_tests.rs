//! Wycheproof's adversarial AEAD vectors against the browser's actual SIMD kernel.

use super::{open, seal};
use wasm_bindgen_test::wasm_bindgen_test;

fn bytes(value: &serde_json::Value, field: &str) -> Vec<u8> {
    let text = value[field].as_str().expect("vector field is hexadecimal");
    assert_eq!(text.len() % 2, 0);
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(core::str::from_utf8(pair).unwrap(), 16)
                .expect("valid hexadecimal vector")
        })
        .collect()
}

#[wasm_bindgen_test]
fn wycheproof_chacha20_poly1305() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../test-vectors/wycheproof/chacha20_poly1305_test.json"
    ))
    .unwrap();
    let mut executed = 0;
    let mut unrepresentable_nonce = 0;
    for group in vectors["testGroups"].as_array().unwrap() {
        assert_eq!(group["keySize"], 256);
        assert_eq!(group["tagSize"], 128);
        for vector in group["tests"].as_array().unwrap() {
            let valid = match vector["result"].as_str().unwrap() {
                "valid" => true,
                "invalid" => false,
                other => panic!("unclassified vector result {other}"),
            };
            let nonce = bytes(vector, "iv");
            let Ok(nonce) = <[u8; 12]>::try_from(nonce) else {
                assert!(!valid, "invalid-length nonce must not be valid");
                unrepresentable_nonce += 1;
                continue;
            };
            let key: [u8; 32] = bytes(vector, "key").try_into().unwrap();
            let aad = bytes(vector, "aad");
            let plaintext = bytes(vector, "msg");
            let ciphertext = bytes(vector, "ct");
            let tag = bytes(vector, "tag");
            let mut out = vec![0xaa; ciphertext.len()];
            assert_eq!(
                open(&key, &nonce, &aad, &ciphertext, &tag, &mut out),
                valid,
                "Wycheproof tcId {} ({})",
                vector["tcId"],
                vector["comment"]
            );
            if valid {
                assert_eq!(out, plaintext, "tcId {} plaintext", vector["tcId"]);
                let mut sealed = plaintext;
                assert_eq!(
                    seal(&key, &nonce, &aad, &mut sealed).as_slice(),
                    tag,
                    "tcId {} tag",
                    vector["tcId"]
                );
                assert_eq!(sealed, ciphertext, "tcId {} ciphertext", vector["tcId"]);
            } else {
                assert!(
                    out.iter().all(|byte| *byte == 0xaa),
                    "tcId {} rejected ciphertext wrote plaintext",
                    vector["tcId"]
                );
            }
            executed += 1;
        }
    }
    assert_eq!(executed, 316);
    assert_eq!(unrepresentable_nonce, 9);
    assert_eq!(executed + unrepresentable_nonce, vectors["numberOfTests"]);
}
