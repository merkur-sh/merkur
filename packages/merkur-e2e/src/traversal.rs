//! Purpose-separated authority for native UDP traversal.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha512;
use zeroize::Zeroizing;

#[derive(Clone, PartialEq, Eq)]
pub struct TraversalKey(Zeroizing<[u8; 32]>);

impl std::fmt::Debug for TraversalKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TraversalKey([redacted])")
    }
}

pub struct CheckKeys {
    pub id: [u8; 16],
    pub client: Zeroizing<[u8; 32]>,
    pub daemon: Zeroizing<[u8; 32]>,
}

impl TraversalKey {
    pub fn derive(direct: &[u8; 32], session_id: &str) -> Result<Self, crate::SessionCryptoError> {
        let hkdf = Hkdf::<Sha512>::new(Some(b"merkur-traversal/root\0"), direct);
        let mut key = Zeroizing::new([0; 32]);
        hkdf.expand(session_id.as_bytes(), &mut *key)
            .map_err(|_| crate::SessionCryptoError::Kdf)?;
        Ok(Self(key))
    }

    pub fn mac(&self, daemon: bool, transcript: &[u8]) -> [u8; 64] {
        let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(&*self.0).expect("fixed HMAC key");
        mac.update(if daemon {
            b"merkur-traversal/daemon\0"
        } else {
            b"merkur-traversal/client\0"
        });
        mac.update(transcript);
        mac.finalize().into_bytes().into()
    }

    pub fn verifies(&self, daemon: bool, transcript: &[u8], tag: &[u8]) -> bool {
        use subtle::ConstantTimeEq;
        bool::from(self.mac(daemon, transcript).as_slice().ct_eq(tag))
    }

    pub fn checks(
        &self,
        client_generation: u64,
        manifest: u64,
        binding: u64,
    ) -> Result<CheckKeys, crate::SessionCryptoError> {
        let hkdf = Hkdf::<Sha512>::new(Some(b"merkur-traversal/checks\0"), &*self.0);
        let mut context = [0; 24];
        context[..8].copy_from_slice(&client_generation.to_be_bytes());
        context[8..16].copy_from_slice(&manifest.to_be_bytes());
        context[16..].copy_from_slice(&binding.to_be_bytes());
        let mut bytes = Zeroizing::new([0; 80]);
        hkdf.expand(&context, &mut *bytes)
            .map_err(|_| crate::SessionCryptoError::Kdf)?;
        Ok(CheckKeys {
            id: bytes[..16].try_into().expect("fixed context id"),
            client: Zeroizing::new(bytes[16..48].try_into().expect("fixed client key")),
            daemon: Zeroizing::new(bytes[48..].try_into().expect("fixed daemon key")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_and_envelopes_bind_their_owner_and_purpose() {
        let key = TraversalKey::derive(&[3; 32], "session").unwrap();
        let other = TraversalKey::derive(&[3; 32], "other").unwrap();
        let tag = key.mac(false, b"snapshot");
        assert!(key.verifies(false, b"snapshot", &tag));
        assert!(!key.verifies(true, b"snapshot", &tag));
        assert!(!other.verifies(false, b"snapshot", &tag));
        let checks = key.checks(1, 2, 3).unwrap();
        assert_ne!(*checks.client, *checks.daemon);
        assert_ne!(checks.id, key.checks(1, 2, 4).unwrap().id);
        assert_ne!(checks.id, key.checks(2, 2, 3).unwrap().id);
        assert_ne!(checks.id, key.checks(1, 3, 3).unwrap().id);
    }
}
