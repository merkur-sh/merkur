//! Self-signed certificates and the SHA-256 hashes peers pin.
//!
//! The edge serves WebTransport with a self-signed certificate. Peers pin its
//! SHA-256 hash with `serverCertificateHashes`, delivered out of band by the
//! server with every issuance, renewal and daemon lease, so no public CA is
//! involved. A certificate pinned this way may be valid for at most 14 days, so
//! the edge rotates. It always holds two: the one it serves and the one it will
//! serve next, and it registers both. A peer that learned the hashes at any
//! time since the last rotation therefore dials across the next one. See README.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tracing::info;

/// Validity of every generated certificate, under WebTransport's 14-day
/// ceiling for hash-pinned certificates.
pub const CERT_VALIDITY_DAYS: u32 = 13;

/// A certificate is published as the next one for this long, then served for
/// at most this long again: it is retired once its successor has been published
/// for a period, or once it is two periods old. Pinned for at most twelve days,
/// it retires a day inside its validity.
pub const ROTATION_PERIOD: Duration = Duration::from_secs(6 * 86_400);
const _: () = assert!(2 * ROTATION_PERIOD.as_secs() < CERT_VALIDITY_DAYS as u64 * 86_400);

/// One self-signed identity and the hash peers pin.
pub struct EdgeCert {
    pub identity: wtransport::Identity,
    pub cert_hash: [u8; 32],
    created_at_unix_ms: u64,
}

#[derive(Deserialize, Serialize)]
struct StoredCertMetadata {
    created_at_unix_ms: u64,
}

impl EdgeCert {
    /// Generate a fresh self-signed identity for the edge's anycast hostnames
    /// and compute the SHA-256 hash the browser pins.
    pub fn generate(subject_alt_names: &[&str]) -> Result<EdgeCert, String> {
        let identity = wtransport::Identity::self_signed_builder()
            .subject_alt_names(subject_alt_names)
            .from_now_utc()
            .validity_days(CERT_VALIDITY_DAYS)
            .build()
            .map_err(|e| format!("failed to generate self-signed identity: {e}"))?;

        let cert = identity
            .certificate_chain()
            .as_slice()
            .first()
            .ok_or_else(|| "no certificate in generated chain".to_string())?;

        let hash = cert.hash();
        let mut cert_hash = [0u8; 32];
        cert_hash.copy_from_slice(hash.as_ref());

        Ok(EdgeCert {
            identity,
            cert_hash,
            created_at_unix_ms: unix_time_ms()?,
        })
    }

    /// The same certificate and key, as an identity directory read twice gives.
    #[cfg(merkur_sim)]
    pub(crate) fn duplicate(&self) -> Self {
        Self {
            identity: self.identity.clone_identity(),
            cert_hash: self.cert_hash,
            created_at_unix_ms: self.created_at_unix_ms,
        }
    }

    /// Write this generation's certificate, key and metadata; no pointer names
    /// it yet.
    async fn stage_persisted(&self, identity_dir: &Path) -> Result<(), String> {
        tokio::fs::create_dir_all(identity_dir)
            .await
            .map_err(|error| format!("create identity directory: {error}"))?;
        let generation = self.generation_id();
        let cert_path = generation_path(identity_dir, &generation, "cert.pem");
        let key_path = generation_path(identity_dir, &generation, "key.pem");
        let metadata_path = generation_path(identity_dir, &generation, "json");
        if tokio::fs::try_exists(&cert_path).await.unwrap_or(false)
            && tokio::fs::try_exists(&key_path).await.unwrap_or(false)
            && tokio::fs::try_exists(&metadata_path).await.unwrap_or(false)
        {
            return Ok(());
        }

        let suffix = format!("tmp-{}", std::process::id());
        let cert_temp = cert_path.with_extension(&suffix);
        let key_temp = key_path.with_extension(&suffix);
        let metadata_temp = metadata_path.with_extension(&suffix);
        self.identity
            .certificate_chain()
            .store_pemfile(&cert_temp)
            .await
            .map_err(|error| format!("store certificate: {error}"))?;
        self.identity
            .private_key()
            .store_secret_pemfile(&key_temp)
            .await
            .map_err(|error| format!("store private key: {error}"))?;
        set_private_key_permissions(&key_temp).await?;
        let metadata = serde_json::to_vec(&StoredCertMetadata {
            created_at_unix_ms: self.created_at_unix_ms,
        })
        .map_err(|error| format!("serialize certificate metadata: {error}"))?;
        tokio::fs::write(&metadata_temp, metadata)
            .await
            .map_err(|error| format!("store certificate metadata: {error}"))?;
        tokio::fs::rename(cert_temp, cert_path)
            .await
            .map_err(|error| format!("activate certificate file: {error}"))?;
        tokio::fs::rename(key_temp, key_path)
            .await
            .map_err(|error| format!("activate private key file: {error}"))?;
        tokio::fs::rename(metadata_temp, metadata_path)
            .await
            .map_err(|error| format!("activate certificate metadata: {error}"))?;
        Ok(())
    }

    /// Point `pointer` at this generation, after staging it.
    async fn persist_as(&self, identity_dir: &Path, pointer: Pointer) -> Result<(), String> {
        self.stage_persisted(identity_dir).await?;
        let path = identity_dir.join(pointer.file());
        let temp = identity_dir.join(format!("{}.tmp-{}", pointer.file(), std::process::id()));
        tokio::fs::write(&temp, self.generation_id())
            .await
            .map_err(|error| format!("store {} identity pointer: {error}", pointer.file()))?;
        tokio::fs::rename(temp, path)
            .await
            .map_err(|error| format!("activate {} identity pointer: {error}", pointer.file()))
    }

    async fn load(identity_dir: &Path, pointer: Pointer) -> Result<Option<EdgeCert>, String> {
        let pointer_path = identity_dir.join(pointer.file());
        let generation = match tokio::fs::read_to_string(&pointer_path).await {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!("read {} identity pointer: {error}", pointer.file()));
            }
        };
        let generation = generation.trim();
        if generation.len() != 64 || !generation.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("invalid {} identity pointer", pointer.file()));
        }
        let cert_path = generation_path(identity_dir, generation, "cert.pem");
        let key_path = generation_path(identity_dir, generation, "key.pem");
        let metadata_path = generation_path(identity_dir, generation, "json");
        let metadata_bytes = tokio::fs::read(metadata_path)
            .await
            .map_err(|error| format!("read certificate metadata: {error}"))?;
        let metadata: StoredCertMetadata = serde_json::from_slice(&metadata_bytes)
            .map_err(|error| format!("parse certificate metadata: {error}"))?;
        let identity = wtransport::Identity::load_pemfiles(cert_path, key_path)
            .await
            .map_err(|error| format!("load persisted identity: {error}"))?;
        let cert = identity
            .certificate_chain()
            .as_slice()
            .first()
            .ok_or_else(|| "persisted identity has no certificate".to_string())?;
        let mut cert_hash = [0u8; 32];
        cert_hash.copy_from_slice(cert.hash().as_ref());
        let loaded = EdgeCert {
            identity,
            cert_hash,
            created_at_unix_ms: metadata.created_at_unix_ms,
        };
        if loaded.generation_id() != generation {
            return Err("persisted identity hash does not match its pointer".to_string());
        }
        Ok(Some(loaded))
    }

    fn generation_id(&self) -> String {
        self.cert_hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Base64 (standard) encoding of the SHA-256 cert hash: the spelling peers
    /// pin and the server hands out.
    pub fn cert_hash_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.cert_hash)
    }

    /// Age by the wall clock, which the persisted creation time is stamped in.
    /// A clock before the epoch reads as the oldest age, so it rotates.
    fn age(&self) -> Duration {
        let Ok(now_unix_ms) = unix_time_ms() else {
            return Duration::MAX;
        };
        Duration::from_millis(now_unix_ms.saturating_sub(self.created_at_unix_ms))
    }
}

/// Which certificate an identity-directory pointer names.
#[derive(Clone, Copy)]
enum Pointer {
    Current,
    Next,
}

impl Pointer {
    fn file(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Next => "next",
        }
    }
}

/// The certificate the edge serves and the one it serves next.
pub struct EdgeCerts {
    pub active: EdgeCert,
    pub next: EdgeCert,
}

impl EdgeCerts {
    /// The pair the identity directory holds, generated where it holds none
    /// and rotated as often as its age demands, so what is served is always
    /// inside its validity.
    pub async fn load_or_generate(
        subject_alt_names: &[&str],
        identity_dir: &Path,
    ) -> Result<EdgeCerts, String> {
        let active = match EdgeCert::load(identity_dir, Pointer::Current).await? {
            Some(active) => active,
            None => {
                let active = EdgeCert::generate(subject_alt_names)?;
                active.persist_as(identity_dir, Pointer::Current).await?;
                active
            }
        };
        // A rotation that stopped between its two pointer writes leaves `next`
        // naming the certificate now served: its successor was never made.
        let next = match EdgeCert::load(identity_dir, Pointer::Next).await? {
            Some(next) if next.cert_hash != active.cert_hash => next,
            _ => {
                let next = EdgeCert::generate(subject_alt_names)?;
                next.persist_as(identity_dir, Pointer::Next).await?;
                next
            }
        };
        let mut certs = EdgeCerts { active, next };
        if certs.rotation_due() {
            while certs.rotation_due() {
                certs.advance(Self::successor(subject_alt_names, identity_dir).await?);
            }
            certs.persist(identity_dir).await?;
        }
        Ok(certs)
    }

    /// The next certificate has been published for a period, or the served one
    /// is two periods old.
    pub fn rotation_due(&self) -> bool {
        self.next.age() >= ROTATION_PERIOD || self.active.age() >= 2 * ROTATION_PERIOD
    }

    /// A fresh certificate to publish as the next one, staged on disk but named
    /// by no pointer until [`Self::persist`].
    pub async fn successor(
        subject_alt_names: &[&str],
        identity_dir: &Path,
    ) -> Result<EdgeCert, String> {
        let successor = EdgeCert::generate(subject_alt_names)?;
        successor.stage_persisted(identity_dir).await?;
        Ok(successor)
    }

    /// Serve the next certificate and publish `successor` as the next one. A
    /// running edge has already reloaded its endpoint with the next certificate.
    pub fn advance(&mut self, successor: EdgeCert) {
        self.active = std::mem::replace(&mut self.next, successor);
    }

    /// Point the identity directory at this pair, then delete every other
    /// generation. A cut between the two writes leaves `next` naming the served
    /// certificate, which a restart repairs.
    pub async fn persist(&self, identity_dir: &Path) -> Result<(), String> {
        self.active
            .persist_as(identity_dir, Pointer::Current)
            .await?;
        self.next.persist_as(identity_dir, Pointer::Next).await?;
        self.prune(identity_dir).await
    }

    /// Delete the files of every generation neither pointer names: what
    /// earlier rotations retired, and a successor a cut rotation staged.
    async fn prune(&self, identity_dir: &Path) -> Result<(), String> {
        let kept = [self.active.generation_id(), self.next.generation_id()];
        let mut entries = tokio::fs::read_dir(identity_dir)
            .await
            .map_err(|error| format!("list identity directory: {error}"))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("list identity directory: {error}"))?
        {
            let name = entry.file_name();
            let Some((generation, _)) = name
                .to_str()
                .and_then(|name| name.strip_prefix("identity-"))
                .and_then(|rest| rest.split_once('.'))
            else {
                continue;
            };
            if kept.iter().any(|kept| kept == generation) {
                continue;
            }
            tokio::fs::remove_file(entry.path())
                .await
                .map_err(|error| format!("remove retired identity {generation}: {error}"))?;
        }
        Ok(())
    }

    /// What peers pin: the served certificate's hash, then the next one's.
    pub fn hashes_base64(&self) -> [String; 2] {
        [self.active.cert_hash_base64(), self.next.cert_hash_base64()]
    }

    /// Log the pinned hashes so an operator can match them against the
    /// server's registry. The edge harnesses read the served one from
    /// `cert_hash_b64`, the first field.
    pub fn log_pins(&self) {
        info!(
            cert_hash_b64 = %self.active.cert_hash_base64(),
            next_cert_hash_b64 = %self.next.cert_hash_base64(),
            valid_days = CERT_VALIDITY_DAYS,
            "edge self-signed certificates loaded; peers pin both hashes"
        );
    }
}

fn generation_path(identity_dir: &Path, generation: &str, suffix: &str) -> PathBuf {
    identity_dir.join(format!("identity-{generation}.{suffix}"))
}

fn unix_time_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock before unix epoch: {error}"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system time exceeds u64 milliseconds".to_string())
}

#[cfg(unix)]
async fn set_private_key_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(|error| format!("set private key permissions: {error}"))
}

#[cfg(not(unix))]
async fn set_private_key_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "merkur-edge-{name}-{}-{}",
            std::process::id(),
            unix_time_ms().expect("clock")
        ))
    }

    fn aged(mut cert: EdgeCert, age: Duration) -> EdgeCert {
        cert.created_at_unix_ms = unix_time_ms()
            .expect("clock")
            .saturating_sub(age.as_millis() as u64);
        cert
    }

    #[test]
    fn generates_cert_with_32_byte_hash_and_base64() {
        let cert = EdgeCert::generate(&["localhost"]).expect("generate cert");
        assert_eq!(cert.cert_hash.len(), 32);
        let b64 = cert.cert_hash_base64();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .expect("base64 decodes");
        assert_eq!(decoded.as_slice(), cert.cert_hash.as_slice());
    }

    #[tokio::test]
    async fn persisted_pair_survives_restart() {
        let directory = test_directory("cert-pair");
        let first = EdgeCerts::load_or_generate(&["localhost"], &directory)
            .await
            .expect("create persisted pair");
        assert_ne!(first.active.cert_hash, first.next.cert_hash);
        let hashes = first.hashes_base64();
        drop(first);

        let second = EdgeCerts::load_or_generate(&["localhost"], &directory)
            .await
            .expect("reload persisted pair");
        assert_eq!(second.hashes_base64(), hashes);
        assert!(!second.rotation_due());
        tokio::fs::remove_dir_all(directory)
            .await
            .expect("remove test identity directory");
    }

    #[tokio::test]
    async fn rotation_serves_the_published_next_certificate() {
        let directory = test_directory("cert-rotation");
        let certs = EdgeCerts::load_or_generate(&["localhost"], &directory)
            .await
            .expect("create persisted pair");
        let published_next = certs.next.cert_hash;
        let mut rotated = certs;
        rotated.advance(
            EdgeCerts::successor(&["localhost"], &directory)
                .await
                .expect("successor"),
        );
        rotated.persist(&directory).await.expect("persist rotation");
        assert_eq!(rotated.active.cert_hash, published_next);
        assert_ne!(rotated.next.cert_hash, published_next);

        let reloaded = EdgeCerts::load_or_generate(&["localhost"], &directory)
            .await
            .expect("reload rotated pair");
        assert_eq!(reloaded.hashes_base64(), rotated.hashes_base64());
        tokio::fs::remove_dir_all(directory)
            .await
            .expect("remove test identity directory");
    }

    #[tokio::test]
    async fn a_rotation_deletes_every_generation_its_pointers_no_longer_name() {
        let directory = test_directory("cert-prune");
        let mut certs = EdgeCerts::load_or_generate(&["localhost"], &directory)
            .await
            .expect("create persisted pair");
        // A rotation cut after staging its successor leaves that one behind too.
        EdgeCerts::successor(&["localhost"], &directory)
            .await
            .expect("orphaned successor");
        for _ in 0..2 {
            certs.advance(
                EdgeCerts::successor(&["localhost"], &directory)
                    .await
                    .expect("successor"),
            );
            certs.persist(&directory).await.expect("persist rotation");
        }

        let mut names = Vec::new();
        let mut entries = tokio::fs::read_dir(&directory).await.expect("list");
        while let Some(entry) = entries.next_entry().await.expect("entry") {
            names.push(entry.file_name().into_string().expect("utf-8 name"));
        }
        names.sort();
        let mut expected = vec!["current".to_string(), "next".to_string()];
        for cert in [&certs.active, &certs.next] {
            let generation = cert.generation_id();
            for suffix in ["cert.pem", "json", "key.pem"] {
                expected.push(format!("identity-{generation}.{suffix}"));
            }
        }
        expected.sort();
        assert_eq!(names, expected);
        tokio::fs::remove_dir_all(directory)
            .await
            .expect("remove test identity directory");
    }

    #[test]
    fn rotation_is_due_by_either_certificate_age() {
        let fresh = || EdgeCert::generate(&["localhost"]).expect("generate cert");
        let pair = |active: Duration, next: Duration| EdgeCerts {
            active: aged(fresh(), active),
            next: aged(fresh(), next),
        };
        assert!(!pair(ROTATION_PERIOD, Duration::ZERO).rotation_due());
        assert!(pair(ROTATION_PERIOD, ROTATION_PERIOD).rotation_due());
        assert!(pair(2 * ROTATION_PERIOD, Duration::ZERO).rotation_due());
    }

    #[tokio::test]
    async fn a_long_downtime_rotates_until_what_is_served_is_young() {
        let directory = test_directory("cert-downtime");
        // Both certificates aged past every period while the edge was down.
        let active = aged(
            EdgeCert::generate(&["localhost"]).expect("generate"),
            4 * ROTATION_PERIOD,
        );
        let next = aged(
            EdgeCert::generate(&["localhost"]).expect("generate"),
            3 * ROTATION_PERIOD,
        );
        let stale = [active.cert_hash, next.cert_hash];
        active
            .persist_as(&directory, Pointer::Current)
            .await
            .expect("persist aged active");
        next.persist_as(&directory, Pointer::Next)
            .await
            .expect("persist aged next");

        let reloaded = EdgeCerts::load_or_generate(&["localhost"], &directory)
            .await
            .expect("reload");
        assert!(!reloaded.rotation_due());
        assert!(!stale.contains(&reloaded.active.cert_hash));
        assert!(!stale.contains(&reloaded.next.cert_hash));
        tokio::fs::remove_dir_all(directory)
            .await
            .expect("remove test identity directory");
    }

    #[tokio::test]
    async fn a_rotation_cut_between_its_pointers_makes_the_missing_successor() {
        let directory = test_directory("cert-cut-rotation");
        let served = EdgeCert::generate(&["localhost"]).expect("generate");
        served
            .persist_as(&directory, Pointer::Current)
            .await
            .expect("persist served");
        served
            .persist_as(&directory, Pointer::Next)
            .await
            .expect("persist the pointer the cut left behind");

        let reloaded = EdgeCerts::load_or_generate(&["localhost"], &directory)
            .await
            .expect("reload");
        assert_eq!(reloaded.active.cert_hash, served.cert_hash);
        assert_ne!(reloaded.next.cert_hash, served.cert_hash);
        tokio::fs::remove_dir_all(directory)
            .await
            .expect("remove test identity directory");
    }
}
