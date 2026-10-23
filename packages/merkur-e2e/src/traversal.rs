//! Purpose-separated authority for native UDP traversal.

use hkdf::Hkdf;
use hmac::digest::KeyInit;
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
            .map_err(|_error| crate::SessionCryptoError::Kdf)?;
        Ok(Self(key))
    }

    pub fn mac(&self, daemon: bool, transcript: &[u8]) -> [u8; 64] {
        // HMAC pads a short key to the digest block size before applying its
        // inner and outer pads. Supply that fixed-size key directly.
        let mut padded = Zeroizing::new([0; 128]);
        for (byte, key) in padded.iter_mut().zip(self.0.iter()) {
            *byte = *key;
        }
        let mut mac = <Hmac<Sha512> as KeyInit>::new((&*padded).into());
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
            .map_err(|_error| crate::SessionCryptoError::Kdf)?;
        let (id, keys) = bytes
            .split_first_chunk::<16>()
            .ok_or(crate::SessionCryptoError::Kdf)?;
        let (client, daemon) = keys
            .split_first_chunk::<32>()
            .ok_or(crate::SessionCryptoError::Kdf)?;
        let daemon = daemon
            .first_chunk::<32>()
            .ok_or(crate::SessionCryptoError::Kdf)?;
        Ok(CheckKeys {
            id: *id,
            client: Zeroizing::new(*client),
            daemon: Zeroizing::new(*daemon),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn require(condition: bool, message: &'static str) -> TestResult {
        if condition {
            Ok(())
        } else {
            Err(message.into())
        }
    }

    #[test]
    fn checks_and_envelopes_bind_their_owner_and_purpose() -> TestResult {
        let key = TraversalKey::derive(&[3; 32], "session")?;
        let other = TraversalKey::derive(&[3; 32], "other")?;
        let tag = key.mac(false, b"snapshot");
        require(key.verifies(false, b"snapshot", &tag), "snapshot validates")?;
        require(!key.verifies(true, b"snapshot", &tag), "purpose is bound")?;
        require(
            !other.verifies(false, b"snapshot", &tag),
            "session is bound",
        )?;
        let checks = key.checks(1, 2, 3)?;
        require(*checks.client != *checks.daemon, "directions differ")?;
        require(checks.id != key.checks(1, 2, 4)?.id, "binding is bound")?;
        require(
            checks.id != key.checks(2, 2, 3)?.id,
            "client generation is bound",
        )?;
        require(
            checks.id != key.checks(1, 3, 3)?.id,
            "manifest generation is bound",
        )?;
        Ok(())
    }
    #[test]
    fn traversal_hkdf_and_hmac_match_sha512_vectors() -> TestResult {
        let key = TraversalKey::derive(&[3; 32], "session")?;
        require(
            *key.0
                == [
                    218, 255, 203, 67, 56, 242, 143, 238, 173, 31, 255, 107, 171, 221, 120, 30, 42,
                    193, 201, 246, 80, 124, 90, 200, 233, 160, 170, 100, 0, 250, 244, 125,
                ],
            "root HKDF vector",
        )?;
        require(
            key.mac(false, b"snapshot")
                == [
                    252, 12, 237, 71, 48, 211, 207, 138, 3, 228, 148, 198, 87, 188, 113, 85, 10,
                    33, 121, 222, 133, 213, 216, 197, 207, 182, 127, 146, 245, 175, 248, 253, 41,
                    214, 179, 143, 113, 175, 66, 250, 99, 105, 104, 16, 148, 86, 204, 120, 141,
                    219, 151, 149, 69, 80, 109, 99, 114, 43, 186, 194, 221, 87, 114, 113,
                ],
            "HMAC vector",
        )?;
        let checks = key.checks(1, 2, 3)?;
        require(
            checks.id
                == [
                    243, 105, 110, 165, 111, 88, 33, 77, 50, 43, 144, 22, 218, 234, 54, 121,
                ],
            "check id vector",
        )?;
        require(
            *checks.client
                == [
                    214, 145, 149, 69, 136, 199, 205, 48, 149, 92, 248, 237, 135, 86, 89, 45, 170,
                    223, 131, 152, 116, 65, 54, 215, 86, 64, 180, 79, 131, 79, 190, 65,
                ],
            "client key vector",
        )?;
        require(
            *checks.daemon
                == [
                    210, 255, 110, 143, 32, 239, 11, 209, 242, 233, 121, 49, 208, 56, 164, 106, 26,
                    179, 137, 97, 188, 144, 171, 95, 70, 131, 4, 45, 91, 221, 132, 112,
                ],
            "daemon key vector",
        )?;
        Ok(())
    }
}
