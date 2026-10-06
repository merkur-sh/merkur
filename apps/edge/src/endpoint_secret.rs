//! The relay's endpoint secret: 32 random bytes created once per identity
//! volume, from which its QUIC stateless-reset key and connection-ID key derive.
//!
//! A relay restarted on the same volume recognizes every connection ID it
//! issued before the restart and answers each with a stateless reset its peer
//! can verify (RFC 9000 §10.3), so a peer learns of the restart on its next
//! packet instead of at its idle timeout. A process holding any other secret
//! drops those IDs as foreign and could only ever issue tokens nobody accepts,
//! so it can never reset a live connection. The secret belongs to one volume
//! and is never shared between replicas.

use std::path::Path;
use std::sync::Arc;

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use wtransport::quinn::{EndpointConfig, HashedConnectionIdGenerator};

const SECRET_BYTES: usize = 32;
const SECRET_FILE: &str = "endpoint-secret";

pub struct EndpointSecret([u8; SECRET_BYTES]);

impl EndpointSecret {
    /// The volume's secret, created on first start and read on every later one.
    pub async fn load_or_create(identity_dir: &Path) -> Result<Self, String> {
        let path = identity_dir.join(SECRET_FILE);
        match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let secret = <[u8; SECRET_BYTES]>::try_from(bytes.as_slice())
                    .map_err(|_| format!("endpoint secret is not {SECRET_BYTES} bytes"))?;
                return Ok(Self(secret));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("read endpoint secret: {error}")),
        }
        tokio::fs::create_dir_all(identity_dir)
            .await
            .map_err(|error| format!("create identity directory: {error}"))?;
        let secret = Self::generate()?;
        let temp = identity_dir.join(format!("{SECRET_FILE}.tmp-{}", std::process::id()));
        write_private(&temp, &secret.0).await?;
        tokio::fs::rename(&temp, &path)
            .await
            .map_err(|error| format!("activate endpoint secret: {error}"))?;
        Ok(secret)
    }

    /// A fresh secret no volume holds.
    pub fn generate() -> Result<Self, String> {
        let mut secret = [0; SECRET_BYTES];
        SystemRandom::new()
            .fill(&mut secret)
            .map_err(|_| "no system randomness for the endpoint secret".to_string())?;
        Ok(Self(secret))
    }

    /// The same secret, as a volume read twice gives.
    #[cfg(merkur_sim)]
    pub(crate) fn duplicate(&self) -> Self {
        Self(self.0)
    }

    /// Install the derived keys. A reset needs no rate limit here: each one is
    /// smaller than the packet that caused it, and only a connection ID this
    /// secret issued draws one, so a burst of old connections after a restart
    /// learns of it at once rather than one per 20 ms.
    pub fn install(&self, config: &mut EndpointConfig) {
        let reset = self.derive(b"merkur-edge stateless reset");
        let connection_ids = self.derive(b"merkur-edge connection id");
        let mut connection_id_key = [0; 8];
        connection_id_key.copy_from_slice(&connection_ids.as_ref()[..8]);
        let connection_id_key = u64::from_le_bytes(connection_id_key);
        config
            .reset_key(Arc::new(hmac::Key::new(hmac::HMAC_SHA256, reset.as_ref())))
            .cid_generator(move || {
                Box::new(HashedConnectionIdGenerator::from_key(connection_id_key))
            })
            .min_reset_interval(std::time::Duration::ZERO);
    }

    fn derive(&self, label: &[u8]) -> hmac::Tag {
        hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, &self.0), label)
    }
}

/// Written with owner-only permissions before any byte of the secret lands.
#[cfg(unix)]
async fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .await
        .map_err(|error| format!("create endpoint secret: {error}"))?;
    file.write_all(bytes)
        .await
        .map_err(|error| format!("write endpoint secret: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("sync endpoint secret: {error}"))
}

#[cfg(not(unix))]
async fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    tokio::fs::write(path, bytes)
        .await
        .map_err(|error| format!("write endpoint secret: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_secret_is_created_once_owner_only_and_read_back_unchanged() {
        let directory = std::env::temp_dir().join(format!(
            "merkur-edge-secret-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        let first = EndpointSecret::load_or_create(&directory).await.unwrap();
        let second = EndpointSecret::load_or_create(&directory).await.unwrap();
        assert_eq!(first.0, second.0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = tokio::fs::metadata(directory.join(SECRET_FILE))
                .await
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        tokio::fs::write(directory.join(SECRET_FILE), [0; 7])
            .await
            .unwrap();
        assert!(EndpointSecret::load_or_create(&directory).await.is_err());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
