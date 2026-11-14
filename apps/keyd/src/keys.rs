//! The keys keyd holds, read once from systemd's credential directory.
//!
//! Each file holds the same canonical unpadded base64url the server's
//! environment held before keyd took the key, so moving a deployment's file
//! keeps every password record and daemon link valid.

use std::fs;
use std::io;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use merkur_authorization::SigningKey;
use opaque_ke::{CipherSuite, ServerSetup};
use p256::ecdsa::SigningKey as P256SigningKey;
use zeroize::Zeroizing;

pub const OPAQUE_SERVER_SETUP: &str = "opaque-server-setup";
pub const SESSION_TOKEN_SEED: &str = "session-token-mldsa87-seed";
pub const VAPID_PRIVATE_KEY: &str = "web-push-vapid-private-key";

const OPAQUE_SERVER_SETUP_BYTES: usize = 128;
const SEED_BYTES: usize = 32;
const P256_SCALAR_BYTES: usize = 32;
pub const P256_PUBLIC_KEY_BYTES: usize = 65;

/// The OPAQUE configuration of `@serenity-kit/opaque` 1.1.0: Ristretto255 and a
/// triple Diffie-Hellman over SHA-512. The server never stretches a password,
/// so its key-stretching function is never called; the browser's Argon2id
/// policy lives with the clients (`merkur-client-native`'s `opaque.rs`).
pub struct Suite;

impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = opaque_ke::ksf::Identity;
}

pub struct Vapid {
    pub key: P256SigningKey,
    pub public_key: [u8; P256_PUBLIC_KEY_BYTES],
}

pub struct Keys {
    pub opaque: ServerSetup<Suite>,
    pub opaque_public_key: Vec<u8>,
    pub capability: SigningKey,
    pub vapid: Option<Vapid>,
}

#[derive(Debug)]
pub struct KeyError(pub String);

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Reads every key from `directory`. The web-push key is the one that may be
/// absent: a deployment without web push has none.
pub fn load(directory: &Path) -> Result<Keys, KeyError> {
    let setup = read(directory, OPAQUE_SERVER_SETUP, OPAQUE_SERVER_SETUP_BYTES)?
        .ok_or_else(|| missing(OPAQUE_SERVER_SETUP))?;
    let opaque = ServerSetup::<Suite>::deserialize(&setup).map_err(|_| {
        KeyError(format!(
            "{OPAQUE_SERVER_SETUP} is not an OPAQUE server setup"
        ))
    })?;
    let opaque_public_key = opaque.keypair().public().serialize().to_vec();

    let mut seed = read(directory, SESSION_TOKEN_SEED, SEED_BYTES)?
        .ok_or_else(|| missing(SESSION_TOKEN_SEED))?;
    let capability = SigningKey::from_seed(&mut seed)
        .map_err(|_| KeyError(format!("{SESSION_TOKEN_SEED} is not an ML-DSA-87 seed")))?;

    let vapid = match read(directory, VAPID_PRIVATE_KEY, P256_SCALAR_BYTES)? {
        None => None,
        Some(scalar) => {
            let key = P256SigningKey::from_slice(&scalar)
                .map_err(|_| KeyError(format!("{VAPID_PRIVATE_KEY} is not a P-256 key")))?;
            let mut public_key = [0u8; P256_PUBLIC_KEY_BYTES];
            public_key.copy_from_slice(key.verifying_key().to_sec1_point(false).as_bytes());
            Some(Vapid { key, public_key })
        }
    };
    Ok(Keys {
        opaque,
        opaque_public_key,
        capability,
        vapid,
    })
}

fn missing(name: &str) -> KeyError {
    KeyError(format!("{name} is missing"))
}

/// `None` when the file does not exist. A file may end in one newline, as an
/// editor leaves it; anything else must be the canonical encoding.
fn read(
    directory: &Path,
    name: &str,
    bytes: usize,
) -> Result<Option<Zeroizing<Vec<u8>>>, KeyError> {
    let text = match fs::read(directory.join(name)) {
        Ok(text) => Zeroizing::new(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(KeyError(format!("{name} is unreadable: {error}"))),
    };
    let value = text.strip_suffix(b"\n").unwrap_or(&text);
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| KeyError(format!("{name} is not base64url")))?,
    );
    if decoded.len() != bytes || URL_SAFE_NO_PAD.encode(&*decoded).as_bytes() != value {
        return Err(KeyError(format!(
            "{name} is not the canonical encoding of {bytes} bytes"
        )));
    }
    Ok(Some(decoded))
}

/// Key provisioning for this crate's tests. Development and the server's tests provision
/// with `scripts/keyd.ts`'s `newKeydKeySet`.
#[cfg(test)]
pub mod testing {
    use std::fs::{self, OpenOptions};
    use std::io::{self, Write};
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::path::Path;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use opaque_ke::ServerSetup;
    use p256::ecdsa::SigningKey as P256SigningKey;
    use rand_core::{OsRng, RngCore};
    use zeroize::Zeroizing;

    use super::*;

    /// Writes a fresh set of keys into `directory` (created 0700), each file 0600,
    /// for this crate's tests. Refuses to replace a key that exists. Development and
    /// the server's tests provision with `scripts/keyd.ts`'s `newKeydKeySet`.
    pub fn generate(directory: &Path) -> io::Result<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        let setup = Zeroizing::new(ServerSetup::<Suite>::new(&mut OsRng).serialize().to_vec());
        let mut seed = Zeroizing::new([0u8; SEED_BYTES]);
        OsRng.fill_bytes(&mut *seed);
        let mut scalar = Zeroizing::new([0u8; P256_SCALAR_BYTES]);
        loop {
            OsRng.fill_bytes(&mut *scalar);
            if P256SigningKey::from_slice(&*scalar).is_ok() {
                break;
            }
        }
        for (name, value) in [
            (OPAQUE_SERVER_SETUP, setup.as_slice()),
            (SESSION_TOKEN_SEED, seed.as_slice()),
            (VAPID_PRIVATE_KEY, scalar.as_slice()),
        ] {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(directory.join(name))?;
            file.write_all(Zeroizing::new(URL_SAFE_NO_PAD.encode(value)).as_bytes())?;
            file.sync_all()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::testing::generate;
    use super::*;

    #[test]
    fn generated_keys_load_and_are_never_replaced() {
        let dir = std::env::temp_dir().join(format!("merkur-keyd-keys-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        generate(&dir).unwrap();
        let keys = load(&dir).unwrap();
        assert_eq!(keys.opaque_public_key.len(), 32);
        assert!(keys.vapid.is_some());
        assert!(
            generate(&dir).is_err(),
            "an existing key is never overwritten"
        );
        fs::remove_file(dir.join(VAPID_PRIVATE_KEY)).unwrap();
        assert!(load(&dir).unwrap().vapid.is_none());
        let seed = fs::read(dir.join(SESSION_TOKEN_SEED)).unwrap();
        fs::write(
            dir.join(SESSION_TOKEN_SEED),
            [seed.as_slice(), b"\n"].concat(),
        )
        .unwrap();
        assert!(load(&dir).is_ok(), "one trailing newline is an editor's");
        fs::write(
            dir.join(SESSION_TOKEN_SEED),
            [seed.as_slice(), b"="].concat(),
        )
        .unwrap();
        assert!(load(&dir).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
