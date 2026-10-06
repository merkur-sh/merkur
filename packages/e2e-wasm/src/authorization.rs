//! ML-DSA-87 and the plain digests behind Merkur's TypeScript authorization
//! records: user-root delegations, daemon bindings, revocations, account
//! deletion, the server's session capability, daemon management proofs, and
//! release and build manifests.
//!
//! The same `merkur-e2e` code the daemon links, so the browser, the server and
//! the daemon sign and verify with one implementation. These calls run on cold
//! paths (sign-in, one per session connect, one per issuance or daemon proof),
//! so they return owned copies rather than lending linear-memory views.

use merkur_e2e::{
    DAEMON_IDENTITY_SEED_BYTES, DAEMON_IDENTITY_SIGNING_RANDOM_BYTES, DaemonIdentitySigningKey,
};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

/// An expanded ML-DSA-87 signing key held only in linear memory.
///
/// The 4,896-byte secret never becomes a JavaScript value; `free()` drops it,
/// and the core key wipes itself on drop. Callers free it in a `finally`.
#[wasm_bindgen]
pub struct MlDsa87SigningKey {
    key: DaemonIdentitySigningKey,
}

#[wasm_bindgen]
impl MlDsa87SigningKey {
    /// Expands a 32-byte FIPS 204 seed. The caller's seed is copied, not
    /// consumed: the browser keeps seeds sealed in its vault and derives the
    /// key again for each signature.
    #[wasm_bindgen(js_name = fromSeed)]
    pub fn from_seed(seed: &[u8]) -> Result<MlDsa87SigningKey, JsError> {
        let mut copy = Zeroizing::new([0u8; DAEMON_IDENTITY_SEED_BYTES]);
        if seed.len() != DAEMON_IDENTITY_SEED_BYTES {
            return Err(JsError::new("ML-DSA-87 seed must be exactly 32 bytes"));
        }
        copy.copy_from_slice(seed);
        let key = DaemonIdentitySigningKey::from_seed(&mut *copy)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self { key })
    }

    /// The 2,592-byte verification key, as a copy.
    #[wasm_bindgen(getter, js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.key.public_key().to_vec()
    }

    /// Hedged FIPS 204 signature under an external context of at most 255
    /// bytes. `randomness` is 32 fresh bytes from the caller; it is copied in,
    /// so tests can pin it.
    pub fn sign(
        &self,
        context: &[u8],
        message: &[u8],
        randomness: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let randomness: [u8; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES] = randomness
            .try_into()
            .map_err(|_| JsError::new("ML-DSA-87 signing randomness must be exactly 32 bytes"))?;
        self.key
            .sign_with_context(context, message, randomness)
            .map(|signature| signature.to_vec())
            .map_err(|error| JsError::new(&error.to_string()))
    }
}

/// Verifies an ML-DSA-87 signature. Any malformed input is `false`, never an
/// exception: every caller treats a bad length and a bad signature alike.
#[wasm_bindgen(js_name = mlDsa87Verify)]
pub fn ml_dsa87_verify(
    public_key: &[u8],
    context: &[u8],
    message: &[u8],
    signature: &[u8],
) -> bool {
    merkur_e2e::verify_ml_dsa87(public_key, context, message, signature).is_ok()
}

#[wasm_bindgen]
pub fn sha256(message: &[u8]) -> Vec<u8> {
    merkur_e2e::sha256(message).to_vec()
}

#[wasm_bindgen]
pub fn sha512(message: &[u8]) -> Vec<u8> {
    merkur_e2e::sha512(message).to_vec()
}

#[wasm_bindgen(js_name = hmacSha512)]
pub fn hmac_sha512(key: &[u8], message: &[u8]) -> Result<Vec<u8>, JsError> {
    merkur_e2e::hmac_sha512(key, message)
        .map(|mac| mac.to_vec())
        .map_err(|error| JsError::new(&error.to_string()))
}
