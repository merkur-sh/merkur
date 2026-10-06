//! The user-root seed, wrapped under the OPAQUE export key.
//!
//! Only a client that completes OPAQUE with the password learns the export key,
//! so the server stores this envelope without being able to open it. The key is
//! `HKDF-SHA-512(ikm = exportKey, salt = "merkur-user-root\0" origin "\0" userId,
//! info = "merkur-user-root-envelope-key")`, the cipher AES-256-GCM with a
//! 12-byte nonce, and the associated data the JSON object
//! `{userId, rootPublicKey, serverOrigin}`, so an envelope opens only for the
//! account, root and origin it was sealed for.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::canonical::{decode_exact, encode};
use crate::{
    AuthorizationError, OPAQUE_EXPORT_KEY_BYTES, PUBLIC_KEY_BYTES, SEED_BYTES, SigningKey, to_json,
};

pub const ROOT_ENVELOPE_NONCE_BYTES: usize = 12;
const ROOT_ENVELOPE_CIPHERTEXT_BYTES: usize = SEED_BYTES + 16;
const ROOT_ENVELOPE_INFO: &[u8] = b"merkur-user-root-envelope-key";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootEnvelope {
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeContext<'a> {
    user_id: &'a str,
    root_public_key: String,
    server_origin: &'a str,
}

impl RootEnvelope {
    /// `nonce` must be fresh for every sealing.
    pub fn seal(
        root_seed: &[u8; SEED_BYTES],
        export_key: &[u8; OPAQUE_EXPORT_KEY_BYTES],
        user_id: &str,
        root_public_key: &[u8; PUBLIC_KEY_BYTES],
        server_origin: &str,
        nonce: [u8; ROOT_ENVELOPE_NONCE_BYTES],
    ) -> Result<Self, AuthorizationError> {
        let cipher = envelope_cipher(export_key, user_id, server_origin)?;
        let aad = envelope_aad(user_id, root_public_key, server_origin);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: root_seed,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| AuthorizationError::message("user-root envelope sealing failed"))?;
        Ok(Self {
            nonce: encode(&nonce),
            ciphertext: encode(&ciphertext),
        })
    }

    /// Opens the envelope and proves the seed is the root whose public key the
    /// account advertises.
    pub fn open(
        &self,
        export_key: &[u8; OPAQUE_EXPORT_KEY_BYTES],
        user_id: &str,
        expected_root_public_key: &[u8; PUBLIC_KEY_BYTES],
        server_origin: &str,
    ) -> Result<Zeroizing<[u8; SEED_BYTES]>, AuthorizationError> {
        let nonce: [u8; ROOT_ENVELOPE_NONCE_BYTES] =
            decode_exact(&self.nonce, "user-root envelope nonce")?;
        let ciphertext: [u8; ROOT_ENVELOPE_CIPHERTEXT_BYTES] =
            decode_exact(&self.ciphertext, "user-root envelope ciphertext")?;
        let cipher = envelope_cipher(export_key, user_id, server_origin)?;
        let aad = envelope_aad(user_id, expected_root_public_key, server_origin);
        let mut plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| AuthorizationError::message("user-root envelope does not open"))?;
        let mut seed = Zeroizing::new([0u8; SEED_BYTES]);
        let length_ok = plaintext.len() == SEED_BYTES;
        if length_ok {
            seed.copy_from_slice(&plaintext);
        }
        plaintext.zeroize();
        if !length_ok {
            return Err(AuthorizationError::message(
                "decrypted user-root seed has the wrong length",
            ));
        }
        let key = SigningKey::from_seed(&mut *Zeroizing::new(*seed))
            .map_err(|_| AuthorizationError::message("decrypted user-root seed is invalid"))?;
        if !bool::from(key.public_key().ct_eq(expected_root_public_key)) {
            return Err(AuthorizationError::message(
                "Decrypted user-root seed does not match the account root public key",
            ));
        }
        Ok(seed)
    }
}

fn envelope_cipher(
    export_key: &[u8; OPAQUE_EXPORT_KEY_BYTES],
    user_id: &str,
    server_origin: &str,
) -> Result<Aes256Gcm, AuthorizationError> {
    if user_id.is_empty() {
        return Err(AuthorizationError::message("User id must not be empty"));
    }
    if server_origin.is_empty() {
        return Err(AuthorizationError::message(
            "Server origin must not be empty",
        ));
    }
    let salt = Zeroizing::new(format!("merkur-user-root\0{server_origin}\0{user_id}"));
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha512>::new(Some(salt.as_bytes()), export_key)
        .expand(ROOT_ENVELOPE_INFO, &mut *key)
        .map_err(|_| AuthorizationError::message("user-root envelope key derivation failed"))?;
    Aes256Gcm::new_from_slice(&*key)
        .map_err(|_| AuthorizationError::message("user-root envelope key is invalid"))
}

fn envelope_aad(
    user_id: &str,
    root_public_key: &[u8; PUBLIC_KEY_BYTES],
    server_origin: &str,
) -> String {
    to_json(&EnvelopeContext {
        user_id,
        root_public_key: encode(root_public_key),
        server_origin,
    })
}
