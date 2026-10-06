//! The simulator mints session capabilities in Rust, where the server mints
//! them in TypeScript. Its token must be the server's, byte for byte, before
//! any scenario trusts a session it authorizes.

use merkur_authorization::SigningKey;
use merkur_sim::server::{SessionTokenPayload, session_token};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    seed_hex: String,
    extra_entropy_hex: String,
    token: String,
    payload: Payload,
}

#[derive(Deserialize)]
struct Payload {
    u: String,
    g: String,
    b: String,
    d: String,
    s: String,
    k: String,
    q: String,
    iat: u64,
    e: u64,
}

fn hex<const N: usize>(text: &str) -> [u8; N] {
    let mut bytes = [0; N];
    assert_eq!(text.len(), 2 * N, "{N} bytes of hex");
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * index..2 * index + 2], 16).expect("hex");
    }
    bytes
}

#[test]
fn the_session_token_is_the_servers() {
    let vector: Vector = serde_json::from_str(include_str!(
        "../../../packages/shared/test-vectors/session-authorization-mldsa87.json"
    ))
    .expect("the server's vector");
    let key = SigningKey::from_seed(&mut hex::<32>(&vector.seed_hex)).expect("a key");
    let payload = &vector.payload;
    let token = session_token(
        &key,
        &SessionTokenPayload {
            u: &payload.u,
            g: &payload.g,
            b: &payload.b,
            d: &payload.d,
            s: &payload.s,
            k: &payload.k,
            q: &payload.q,
            iat: payload.iat,
            e: payload.e,
        },
        hex::<32>(&vector.extra_entropy_hex),
    );
    assert_eq!(token, vector.token);
}
