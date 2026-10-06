//! Carrier rebind: re-authenticating a returning browser to an existing parked
//! daemon peer without an application-server round trip.
//!
//! # Why this exists
//!
//! A network drop today destroys a *session*, not just a carrier: the browser
//! must obtain a fresh server capability, a fresh one-use ML-KEM bootstrap, a
//! fresh delegation proof, and a fresh Noise handshake. That is several round
//! trips plus an HTTPS request to the application server. The terminal state
//! survives — the daemon parks the peer with its display cache and input
//! sequence domain — but the authentication does not.
//!
//! A rebind replaces only the authentication half. The browser proves
//! possession of a chaining secret `RS_n` derived at session establishment,
//! and that proof authorizes a fresh ML-KEM-1024 exchange whose output keys a
//! completely new Noise session. No key ever crosses a carrier boundary.
//!
//! # Three-flight exchange
//!
//! Flight 1 binds the nonce, one-use ML-KEM encapsulation key and Noise message
//! 1 to a MAC under `RS_n`. The Noise prologue hashes the request preamble,
//! before message 1 exists. Flight 2 carries the daemon nonce, ciphertext and
//! resync point, plus Noise message 2. The response transcript keys the KDF;
//! a separate answer MAC binds that transcript AND message 2 after Noise has
//! produced it. This avoids a circular KDF while authenticating every byte the
//! browser consumes. Flight 3 completes `Noise_XXpsk3` with the derived PSK.
//!
//! The daemon retains its responder and the exact answer bytes for duplicate
//! requests. Rebuilding message 2 would create a new ephemeral that the retained
//! responder could not finish. Message 2 has no PSK token and carries an empty
//! payload; terminal data opens only after the final message mixes in the PSK.
//!
//! # What authenticates whom
//!
//! Unlike the genesis exchange, the daemon is **not** authenticated by Noise
//! here — its static X25519 key is process-ephemeral and unpinned, so an
//! on-path party could substitute it in the handshake. What authenticates the
//! daemon is the flight-2 MAC under `RS_n`. Callers must therefore verify that
//! MAC *before* touching the Noise message or installing any transport state.
//!
//! # Consumption
//!
//! `RS_n` must be consumed by exactly one successful rebind, and only once the
//! handshake completes — never on a valid MAC alone. The blind edge is an
//! on-path adversary: if a valid MAC consumed `RS_n`, capturing flight 1,
//! suppressing the original, and replaying the copy would burn the secret on a
//! handshake the attacker cannot finish, permanently locking the legitimate
//! browser out of rebind with a single unauthenticated packet.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha512};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use libcrux_ml_kem::mlkem1024::{self, MlKem1024Ciphertext, MlKem1024PrivateKey};

use crate::hybrid::{
    BinaryTranscript, ML_KEM_CIPHERTEXT_BYTES, ML_KEM_DECAPSULATION_KEY_BYTES,
    ML_KEM_ENCAPS_RANDOM_BYTES, ML_KEM_ENCAPSULATION_KEY_BYTES, ML_KEM_KEYGEN_SEED_BYTES,
    ML_KEM_SHARED_SECRET_BYTES, SESSION_COMMITMENT_BYTES, SESSION_NONCE_BYTES,
    SESSION_REBIND_SECRET_BYTES, SessionBootstrapSecrets, SessionCryptoError,
    SessionServerEncapsulation, copy_exact, domain_hash, exact_ref, expand_session_secrets,
    has_domain, require_nonempty,
};

/// Rebind proofs are full HMAC-SHA-512 tags.
pub const SESSION_REBIND_MAC_BYTES: usize = 64;

const REBIND_REQUEST_DOMAIN: &[u8] = b"merkur-rebind/request";
const REBIND_RESPONSE_DOMAIN: &[u8] = b"merkur-rebind/response";
const REBIND_REQUEST_DIGEST_DOMAIN: &[u8] = b"merkur-rebind/request-digest";
const REBIND_LINEAGE_DOMAIN: &[u8] = b"merkur-rebind/lineage";
const REBIND_KDF_SALT_DOMAIN: &[u8] = b"merkur-rebind/kdf-salt";
const REBIND_REQUEST_MAC_DOMAIN: &[u8] = b"merkur-rebind/request-mac\0";
const REBIND_RESPONSE_MAC_DOMAIN: &[u8] = b"merkur-rebind/response-mac\0";
const REBIND_MAC_KEY_INFO: &[u8] = b"merkur-rebind/mac";

/// Ties a rebind generation back to the ML-DSA-signed genesis exchange.
///
/// Without this, `RS_n` would be a bare secret with no provable relationship
/// to any authorization decision, and no reviewer could check the claim that
/// generation *n* descends from an authorized session. The digest is computed
/// once from the genesis response transcript and never changes across
/// generations.
pub fn compute_rebind_lineage_digest(
    genesis_response_transcript: &[u8],
) -> Result<[u8; SESSION_COMMITMENT_BYTES], SessionCryptoError> {
    require_nonempty("genesis_response_transcript", genesis_response_transcript)?;
    Ok(domain_hash(
        REBIND_LINEAGE_DOMAIN,
        genesis_response_transcript,
    ))
}

/// Canonical request transcript, MACed under `RS_n` and bound into the
/// successor key schedule.
///
/// No browser address is bound, as in the genesis transcript: a rebind is
/// precisely the case where the browser's address changed, and the daemon
/// learns the new one from the edge's validated path report on the committed
/// carrier.
pub fn build_rebind_request_transcript(
    session_id: &str,
    browser_node_id: &str,
    daemon_id: &str,
    rebind_counter: u64,
    lineage_digest: &[u8; SESSION_COMMITMENT_BYTES],
    client_nonce: &[u8; SESSION_NONCE_BYTES],
    encapsulation_key: &[u8; ML_KEM_ENCAPSULATION_KEY_BYTES],
) -> Result<Vec<u8>, SessionCryptoError> {
    require_nonempty("session_id", session_id.as_bytes())?;
    require_nonempty("browser_node_id", browser_node_id.as_bytes())?;
    require_nonempty("daemon_id", daemon_id.as_bytes())?;

    let mut transcript = BinaryTranscript::new(REBIND_REQUEST_DOMAIN);
    transcript.field(1, session_id.as_bytes());
    transcript.field(2, browser_node_id.as_bytes());
    transcript.field(3, daemon_id.as_bytes());
    // Fixed 8 big-endian bytes: the counter is the generation fence, and
    // outside the MAC an attacker would simply renumber a replayed request.
    transcript.field(4, &rebind_counter.to_be_bytes());
    transcript.field(5, lineage_digest);
    transcript.field(6, client_nonce);
    transcript.field(7, encapsulation_key);
    Ok(transcript.finish())
}

/// Append Noise message 1 to a request preamble, producing what the flight-1
/// MAC and the replay digest are actually taken over.
///
/// TWO digests, deliberately, and conflating them is circular. The Noise
/// prologue binds the PREAMBLE — message 1 cannot be written until the prologue
/// exists, so the prologue must not depend on it. The MAC binds
/// `preamble || msg1`, because message 1 rides the same flight as the MAC and
/// would otherwise be unauthenticated: the blind edge is an on-path adversary
/// by this module's own threat model, and could splice its own message 1 into
/// an otherwise valid flight. It could not complete the handshake — it holds
/// neither the browser's static key nor the decapsulation key — but it could
/// make the legitimate browser's message 3 fail for the whole generation, which
/// is an unauthenticated party denying the fast path at will.
pub fn bind_rebind_request_msg1(
    request_preamble: &[u8],
    noise_msg1: &[u8],
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(request_preamble, REBIND_REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    require_nonempty("noise_msg1", noise_msg1)?;
    let mut bound = Vec::with_capacity(request_preamble.len() + 16 + noise_msg1.len());
    bound.extend_from_slice(request_preamble);
    // Same field encoding the transcript itself uses, so the result stays a
    // canonical transcript rather than an ad-hoc concatenation.
    bound.extend_from_slice(&8u64.to_be_bytes());
    bound.extend_from_slice(&(noise_msg1.len() as u64).to_be_bytes());
    bound.extend_from_slice(noise_msg1);
    Ok(bound)
}

/// Canonical response transcript, MACed under `RS_n` and used as the successor
/// key schedule's salt.
///
/// `next_expected_input_seq` is bound because it is the keystroke resync point
/// across the carrier gap: an attacker able to shift it would cause silent
/// input loss or duplicate application of keystrokes.
pub fn build_rebind_response_transcript(
    request_transcript: &[u8],
    daemon_nonce: &[u8; SESSION_NONCE_BYTES],
    ciphertext: &[u8; ML_KEM_CIPHERTEXT_BYTES],
    next_expected_input_seq: u32,
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(request_transcript, REBIND_REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let request_digest = domain_hash(REBIND_REQUEST_DIGEST_DOMAIN, request_transcript);
    let sequence = next_expected_input_seq.to_be_bytes();

    let mut transcript = BinaryTranscript::new(REBIND_RESPONSE_DOMAIN);
    transcript.field(1, &request_digest);
    transcript.field(2, daemon_nonce);
    transcript.field(3, ciphertext);
    transcript.field(4, &sequence);
    Ok(transcript.finish())
}

/// Digest identifying one in-flight rebind attempt.
///
/// The daemon stores this beside the generation counter so an exact
/// retransmission of flight 1 — the lost-flight-2 case — is answered from the
/// stored nonce and ciphertext instead of running a second ML-KEM exchange.
pub fn compute_rebind_request_digest(
    request_transcript: &[u8],
) -> Result<[u8; SESSION_COMMITMENT_BYTES], SessionCryptoError> {
    if !has_domain(request_transcript, REBIND_REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    Ok(domain_hash(
        REBIND_REQUEST_DIGEST_DOMAIN,
        request_transcript,
    ))
}

/// SHA-512 digest bound into the successor Noise prologue, mirroring
/// `hash_session_response_transcript` for the genesis exchange.
/// SHA-512 digest of the rebind REQUEST transcript, bound into the successor
/// Noise prologue so message 1 can travel in flight 1.
pub fn hash_rebind_request_transcript(
    request_transcript: &[u8],
) -> Result<[u8; 64], SessionCryptoError> {
    if !has_domain(request_transcript, REBIND_REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    Ok(Sha512::digest(request_transcript).into())
}

pub fn hash_rebind_response_transcript(
    response_transcript: &[u8],
) -> Result<[u8; 64], SessionCryptoError> {
    if !has_domain(response_transcript, REBIND_RESPONSE_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    Ok(Sha512::digest(response_transcript).into())
}

/// Use-separated MAC subkey.
///
/// `RS_n` is also HKDF input material for the successor generation in the same
/// exchange, so the MACs are keyed by a derived subkey rather than by `RS_n`
/// directly.
fn rebind_mac_key(
    rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
) -> Result<Zeroizing<[u8; 64]>, SessionCryptoError> {
    let hkdf = Hkdf::<Sha512>::from_prk(rebind_secret).map_err(|_| SessionCryptoError::Kdf)?;
    let mut key = Zeroizing::new([0u8; 64]);
    hkdf.expand(REBIND_MAC_KEY_INFO, &mut *key)
        .map_err(|_| SessionCryptoError::Kdf)?;
    Ok(key)
}

pub(crate) fn rebind_mac(
    rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    domain: &[u8],
    transcript: &[u8],
) -> Result<[u8; SESSION_REBIND_MAC_BYTES], SessionCryptoError> {
    let key = rebind_mac_key(rebind_secret)?;
    let mut mac =
        <Hmac<Sha512> as Mac>::new_from_slice(&*key).map_err(|_| SessionCryptoError::Kdf)?;
    mac.update(domain);
    mac.update(&(transcript.len() as u64).to_be_bytes());
    mac.update(transcript);
    Ok(mac.finalize().into_bytes().into())
}

pub(crate) fn verify_rebind_mac(
    rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    domain: &[u8],
    transcript: &[u8],
    presented: &[u8],
) -> Result<(), SessionCryptoError> {
    let presented = exact_ref::<SESSION_REBIND_MAC_BYTES>("rebind_mac", presented)?;
    let expected = rebind_mac(rebind_secret, domain, transcript)?;
    if bool::from(expected.ct_eq(presented)) {
        Ok(())
    } else {
        Err(SessionCryptoError::InvalidRebindMac)
    }
}

/// Refusal proof is separate from both successful response and request proofs.
/// The digest binds the exact generation, identities, nonce, KEM key and Noise
/// message 1; a captured refusal cannot terminate a different attempt.
fn refusal_transcript(request: &[u8], reason: &str) -> Result<Vec<u8>, SessionCryptoError> {
    if reason.is_empty()
        || reason.len() > 96
        || !reason.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b':'
        })
    {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let digest = compute_rebind_request_digest(request)?;
    let mut transcript = Vec::with_capacity(digest.len() + reason.len());
    transcript.extend_from_slice(&digest);
    transcript.extend_from_slice(reason.as_bytes());
    Ok(transcript)
}

/// The response used by the KDF precedes Noise message 2. Authenticate that
/// message separately after producing it, avoiding a circular key schedule.
fn answer_transcript(response: &[u8], noise_msg2: &[u8]) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(response, REBIND_RESPONSE_DOMAIN) || noise_msg2.is_empty() {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let mut transcript = BinaryTranscript::new(b"merkur-rebind/answer");
    transcript.field(1, response);
    transcript.field(2, noise_msg2);
    Ok(transcript.finish())
}

pub fn compute_rebind_response_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    response: &[u8],
    noise_msg2: &[u8],
) -> Result<[u8; SESSION_REBIND_MAC_BYTES], SessionCryptoError> {
    rebind_mac(
        secret,
        REBIND_RESPONSE_MAC_DOMAIN,
        &answer_transcript(response, noise_msg2)?,
    )
}

/// Pure authentication: an invalid answer must not consume a one-use bootstrap.
pub fn verify_rebind_response_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    response: &[u8],
    noise_msg2: &[u8],
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    verify_rebind_mac(
        secret,
        REBIND_RESPONSE_MAC_DOMAIN,
        &answer_transcript(response, noise_msg2)?,
        mac,
    )
}

/// Only send after authenticating the exact request with the same secret.
pub fn compute_rebind_refusal_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request: &[u8],
    reason: &str,
) -> Result<[u8; SESSION_REBIND_MAC_BYTES], SessionCryptoError> {
    rebind_mac(
        secret,
        b"merkur-rebind-refusal-mac\0",
        &refusal_transcript(request, reason)?,
    )
}

/// Verify against locally retained request bytes, never a transcript from the wire.
pub fn verify_rebind_refusal_mac(
    secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request: &[u8],
    reason: &str,
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    verify_rebind_mac(
        secret,
        b"merkur-rebind-refusal-mac\0",
        &refusal_transcript(request, reason)?,
        mac,
    )
}

/// Browser's possession proof over the request transcript.
pub fn compute_rebind_request_mac(
    rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request_transcript: &[u8],
) -> Result<[u8; SESSION_REBIND_MAC_BYTES], SessionCryptoError> {
    if !has_domain(request_transcript, REBIND_REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    rebind_mac(rebind_secret, REBIND_REQUEST_MAC_DOMAIN, request_transcript)
}

/// Constant-time verification of the browser's possession proof.
pub fn verify_rebind_request_mac(
    rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    request_transcript: &[u8],
    presented: &[u8],
) -> Result<(), SessionCryptoError> {
    if !has_domain(request_transcript, REBIND_REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    verify_rebind_mac(
        rebind_secret,
        REBIND_REQUEST_MAC_DOMAIN,
        request_transcript,
        presented,
    )
}

/// Successor generation combiner.
///
/// `HKDF-Extract` over the concatenation `RS_n || ml_kem_shared_secret`, salted
/// by a domain-separated digest of the MACed response transcript. Concatenation
/// rather than nesting is deliberate: the result is secure if *either* input is
/// secure, and it avoids requiring HMAC-SHA-512 to be a dual pseudorandom
/// function — an assumption the nested form would need in both directions, for
/// healing and for chaining.
///
/// The output supplies the successor Noise PSK. Direct-upgrade and rebind
/// outputs remain opaque until [`SessionBootstrapSecrets::bind_noise`] mixes
/// in the authenticated classical checkpoint.
pub fn derive_rebind_secrets(
    rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
    ml_kem_shared_secret: &[u8],
    response_transcript: &[u8],
) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
    let shared_secret =
        exact_ref::<ML_KEM_SHARED_SECRET_BYTES>("ml_kem_shared_secret", ml_kem_shared_secret)?;
    if !has_domain(response_transcript, REBIND_RESPONSE_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }

    let mut salt_hash = Sha512::new();
    salt_hash.update(REBIND_KDF_SALT_DOMAIN);
    salt_hash.update([0]);
    salt_hash.update((response_transcript.len() as u64).to_be_bytes());
    salt_hash.update(response_transcript);
    let mut salt = Zeroizing::new(<[u8; 64]>::from(salt_hash.finalize()));

    let mut ikm = Zeroizing::new([0u8; SESSION_REBIND_SECRET_BYTES + ML_KEM_SHARED_SECRET_BYTES]);
    ikm[..SESSION_REBIND_SECRET_BYTES].copy_from_slice(rebind_secret);
    ikm[SESSION_REBIND_SECRET_BYTES..].copy_from_slice(shared_secret);

    let secrets = expand_session_secrets(&salt, &*ikm);
    ikm.zeroize();
    salt.zeroize();
    secrets
}

/// Browser-side one-use ML-KEM bootstrap for a rebind.
///
/// Mirrors `SessionClientBootstrap`, with the daemon's ML-DSA response
/// signature replaced by the flight-2 MAC. As there, the authenticator is
/// checked *before* decapsulation, so an unauthenticated party cannot drive
/// ML-KEM work, and a failed check consumes the bootstrap.
pub struct RebindClientBootstrap {
    decapsulation_key: Zeroizing<[u8; ML_KEM_DECAPSULATION_KEY_BYTES]>,
    encapsulation_key: [u8; ML_KEM_ENCAPSULATION_KEY_BYTES],
}

impl RebindClientBootstrap {
    /// Deterministically generates ML-KEM-1024 from exactly 64 caller-supplied
    /// random bytes. The seed is cleared after expansion.
    pub fn new(mut keygen_seed: [u8; ML_KEM_KEYGEN_SEED_BYTES]) -> Self {
        let key_pair = mlkem1024::generate_key_pair(keygen_seed);
        keygen_seed.zeroize();
        let (private_key, public_key) = key_pair.into_parts();
        let private_bytes: [u8; ML_KEM_DECAPSULATION_KEY_BYTES] = private_key.into();
        let public_bytes: [u8; ML_KEM_ENCAPSULATION_KEY_BYTES] = public_key.into();
        Self {
            decapsulation_key: Zeroizing::new(private_bytes),
            encapsulation_key: public_bytes,
        }
    }

    /// Length-checking constructor for byte-oriented boundaries. The caller's
    /// mutable seed buffer is wiped even when its length is invalid.
    pub fn from_seed(keygen_seed: &mut [u8]) -> Result<Self, SessionCryptoError> {
        let seed_result = copy_exact::<ML_KEM_KEYGEN_SEED_BYTES>("keygen_seed", keygen_seed);
        keygen_seed.zeroize();
        let mut seed = Zeroizing::new(seed_result?);
        let out = Self::new(*seed);
        seed.zeroize();
        Ok(out)
    }

    pub fn encapsulation_key(&self) -> &[u8; ML_KEM_ENCAPSULATION_KEY_BYTES] {
        &self.encapsulation_key
    }

    /// A bootstrap without key material, for the rebind keeper's bounded
    /// proof, which stubs every use of the key.
    #[cfg(kani)]
    pub(crate) fn unkeyed() -> Self {
        Self {
            decapsulation_key: Zeroizing::new([0; ML_KEM_DECAPSULATION_KEY_BYTES]),
            encapsulation_key: [0; ML_KEM_ENCAPSULATION_KEY_BYTES],
        }
    }

    /// Verifies the daemon's response MAC, then decapsulates and derives the
    /// successor generation.
    ///
    /// The caller must not treat success as permission to discard `RS_n`: the
    /// daemon commits its own side only when the successor handshake
    /// completes, so a lost final handshake message would otherwise leave the
    /// two sides on different generations with no way back.
    pub fn complete(
        self,
        rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
        ciphertext: &[u8],
        response_transcript: &[u8],
        noise_msg2: &[u8],
        response_mac: &[u8],
    ) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
        verify_rebind_response_mac(rebind_secret, response_transcript, noise_msg2, response_mac)?;
        let ciphertext_bytes = copy_exact::<ML_KEM_CIPHERTEXT_BYTES>("ciphertext", ciphertext)?;
        let ciphertext = MlKem1024Ciphertext::from(ciphertext_bytes);
        let private_key = MlKem1024PrivateKey::from(&*self.decapsulation_key);
        if !mlkem1024::validate_private_key(&private_key, &ciphertext) {
            let mut private_bytes: [u8; ML_KEM_DECAPSULATION_KEY_BYTES] = private_key.into();
            private_bytes.zeroize();
            return Err(SessionCryptoError::InvalidDecapsulationKey);
        }

        let mut shared_secret = Zeroizing::new(mlkem1024::decapsulate(&private_key, &ciphertext));
        let mut private_bytes: [u8; ML_KEM_DECAPSULATION_KEY_BYTES] = private_key.into();
        private_bytes.zeroize();
        let secrets = derive_rebind_secrets(rebind_secret, &*shared_secret, response_transcript);
        shared_secret.zeroize();
        secrets
    }
}

/// Daemon-side first phase of a rebind.
///
/// Exposes the ciphertext so the response transcript can be built and MACed
/// before the successor generation is derived, mirroring the genesis exchange's
/// build-then-sign ordering.
pub struct RebindServerEncapsulation {
    inner: SessionServerEncapsulation,
}

impl RebindServerEncapsulation {
    /// Encapsulates to a validated ML-KEM-1024 key using exactly 32 fresh
    /// caller-supplied random bytes. Randomness is wiped on every return path.
    pub fn new(
        encapsulation_key: &[u8],
        encaps_randomness: [u8; ML_KEM_ENCAPS_RANDOM_BYTES],
    ) -> Result<Self, SessionCryptoError> {
        Ok(Self {
            inner: SessionServerEncapsulation::new(encapsulation_key, encaps_randomness)?,
        })
    }

    pub fn ciphertext(&self) -> &[u8; ML_KEM_CIPHERTEXT_BYTES] {
        self.inner.ciphertext()
    }

    /// Derives the successor generation from the MACed response transcript.
    pub fn complete(
        self,
        rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
        response_transcript: &[u8],
    ) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
        derive_rebind_secrets(
            rebind_secret,
            self.inner.shared_secret(),
            response_transcript,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RS: [u8; SESSION_REBIND_SECRET_BYTES] = [0x5c; SESSION_REBIND_SECRET_BYTES];
    /// A stand-in for Noise message 1, which now rides flight 1 and is bound
    /// into the request transcript so the MAC authenticates it.
    const MSG1: [u8; 4] = [0xa1, 0xa2, 0xa3, 0xa4];
    const MSG2: [u8; 4] = [0xb1, 0xb2, 0xb3, 0xb4];

    #[test]
    fn answer_proof_authenticates_noise_without_consuming_the_bootstrap() {
        let client = RebindClientBootstrap::new([0x13; ML_KEM_KEYGEN_SEED_BYTES]);
        let request =
            bind_rebind_request_msg1(&request(7, client.encapsulation_key()), &MSG1).unwrap();
        let encapsulation =
            RebindServerEncapsulation::new(client.encapsulation_key(), [7; 32]).unwrap();
        let response =
            build_rebind_response_transcript(&request, &[5; 32], encapsulation.ciphertext(), 17)
                .unwrap();
        let msg2 = [6; 96];
        let mac = compute_rebind_response_mac(&RS, &response, &msg2).unwrap();
        assert!(verify_rebind_response_mac(&RS, &response, &[7; 96], &mac).is_err());
        assert!(verify_rebind_response_mac(&RS, &response, &msg2, &[0; 64]).is_err());
        assert!(verify_rebind_request_mac(&RS, &request, &mac).is_err());
        assert!(verify_rebind_response_mac(&RS, &response, &msg2, &mac).is_ok());

        assert!(
            client
                .complete(&RS, encapsulation.ciphertext(), &response, &msg2, &mac)
                .is_ok()
        );
    }

    #[test]
    fn refusal_binds_reason_request_generation_and_mac_domain() {
        let client = RebindClientBootstrap::new([0x13; ML_KEM_KEYGEN_SEED_BYTES]);
        let preamble = request(7, client.encapsulation_key());
        let bound = bind_rebind_request_msg1(&preamble, &MSG1).unwrap();
        let mac = compute_rebind_refusal_mac(&RS, &bound, "lineage_expired").unwrap();
        assert!(verify_rebind_refusal_mac(&RS, &bound, "lineage_expired", &mac).is_ok());
        assert!(verify_rebind_refusal_mac(&RS, &bound, "control_link_stale", &mac).is_err());
        assert!(verify_rebind_request_mac(&RS, &bound, &mac).is_err());
        let other = bind_rebind_request_msg1(&preamble, &[0x42; 4]).unwrap();
        assert!(verify_rebind_refusal_mac(&RS, &other, "lineage_expired", &mac).is_err());
        let next =
            bind_rebind_request_msg1(&request(8, client.encapsulation_key()), &MSG1).unwrap();
        assert!(verify_rebind_refusal_mac(&RS, &next, "lineage_expired", &mac).is_err());
        assert!(verify_rebind_refusal_mac(&[0; 64], &bound, "lineage_expired", &mac).is_err());
        assert!(verify_rebind_refusal_mac(&RS, &bound, "lineage_expired", &mac[..63]).is_err());
    }

    /// The reason message 1 is bound at all.
    ///
    /// It rides the same flight as the MAC over it, and the blind edge is an
    /// on-path adversary by this module's own threat model. A spliced message 1
    /// must fail the MAC — and, independently, must resolve to a different
    /// replay digest, so it can never be answered from a cached flight either.
    #[test]
    fn a_spliced_message_one_fails_the_mac_and_changes_the_digest() {
        let client = RebindClientBootstrap::new([0x13; ML_KEM_KEYGEN_SEED_BYTES]);
        let preamble = request(7, client.encapsulation_key());

        let honest = bind_rebind_request_msg1(&preamble, &MSG1).expect("honest binding");
        let mac = compute_rebind_request_mac(&RS, &honest).expect("mac");
        assert!(verify_rebind_request_mac(&RS, &honest, &mac).is_ok());

        // Same preamble, attacker's message 1.
        let spliced = bind_rebind_request_msg1(&preamble, &[0xff, 0xfe, 0xfd, 0xfc])
            .expect("spliced binding");
        assert!(
            verify_rebind_request_mac(&RS, &spliced, &mac).is_err(),
            "a spliced message 1 must not pass the flight-1 proof"
        );
        assert_ne!(
            compute_rebind_request_digest(&honest).expect("honest digest"),
            compute_rebind_request_digest(&spliced).expect("spliced digest"),
            "and must never resolve to the cached answer for the honest flight"
        );
    }

    /// The prologue binds the PREAMBLE, never the bound transcript. If it bound
    /// the latter it would depend on a message that cannot be written until the
    /// prologue exists — the circularity that makes pipelining impossible.
    #[test]
    fn the_prologue_digest_is_independent_of_message_one() {
        let client = RebindClientBootstrap::new([0x13; ML_KEM_KEYGEN_SEED_BYTES]);
        let preamble = request(7, client.encapsulation_key());
        let digest = hash_rebind_request_transcript(&preamble).expect("preamble digest");

        for msg1 in [MSG1.as_slice(), &[0x01], &[0xff; 64]] {
            let bound = bind_rebind_request_msg1(&preamble, msg1).expect("binding");
            assert_ne!(
                hash_rebind_request_transcript(&bound).expect("bound digest"),
                digest,
                "the two digests must be distinct values"
            );
        }
        assert_eq!(
            hash_rebind_request_transcript(&preamble).expect("stable"),
            digest,
            "the prologue digest cannot move with message 1"
        );
    }
    const LINEAGE: [u8; SESSION_COMMITMENT_BYTES] = [0x1d; SESSION_COMMITMENT_BYTES];

    fn request(counter: u64, key: &[u8; ML_KEM_ENCAPSULATION_KEY_BYTES]) -> Vec<u8> {
        build_rebind_request_transcript(
            "session-from-server",
            "browser-node",
            "daemon-node",
            counter,
            &LINEAGE,
            &[0x71; SESSION_NONCE_BYTES],
            key,
        )
        .unwrap()
    }

    fn exchange(counter: u64) -> (crate::hybrid::SessionSecrets, crate::hybrid::SessionSecrets) {
        let client = RebindClientBootstrap::new([0x11; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(counter, client.encapsulation_key());
        let mac1 = compute_rebind_request_mac(&RS, &request_tbs).unwrap();
        verify_rebind_request_mac(&RS, &request_tbs, &mac1).unwrap();

        let server = RebindServerEncapsulation::new(
            client.encapsulation_key(),
            [0x44; ML_KEM_ENCAPS_RANDOM_BYTES],
        )
        .unwrap();
        let response_tbs = build_rebind_response_transcript(
            &request_tbs,
            &[0x55; SESSION_NONCE_BYTES],
            server.ciphertext(),
            9,
        )
        .unwrap();
        let mac2 = compute_rebind_response_mac(&RS, &response_tbs, &MSG2).unwrap();

        let client_secrets = client
            .complete(&RS, server.ciphertext(), &response_tbs, &MSG2, &mac2)
            .unwrap();
        let server_secrets = server.complete(&RS, &response_tbs).unwrap();
        let prologue = crate::derive_prologue("rebind-fixture", "daemon", &[0x12; 64]);
        let (browser_static, _) = crate::generate_static_keypair().unwrap();
        let (daemon_static, _) = crate::generate_static_keypair().unwrap();
        let (initiator, msg1) =
            crate::PendingNoiseInitiator::start(&browser_static, &prologue).unwrap();
        let (responder, msg2) =
            crate::PendingNoiseResponder::start(&daemon_static, &prologue, &msg1).unwrap();
        let initiator = initiator.read_authenticated_msg2(&msg2).unwrap();
        (
            client_secrets
                .bind_noise(initiator.checkpoint(), &response_tbs)
                .unwrap(),
            server_secrets
                .bind_noise(responder.checkpoint(), &response_tbs)
                .unwrap(),
        )
    }

    #[test]
    fn both_sides_derive_the_same_successor_generation() {
        let (client, server) = exchange(1);
        assert_eq!(client.as_bytes(), server.as_bytes());
        // The successor must not reproduce the secret that authorized it.
        assert_ne!(client.rebind_secret(), &RS);
    }

    /// Key separation is the only thing preventing a frame sealed under the old
    /// generation from opening under the new one, so consecutive generations
    /// must never derive equal transport keys even when every other input is
    /// identical.
    #[test]
    fn consecutive_generations_never_share_keys() {
        let (first, _) = exchange(1);
        let (second, _) = exchange(2);
        assert_ne!(first.noise_psk(), second.noise_psk());
        assert_ne!(
            first.direct_upgrade_secret(),
            second.direct_upgrade_secret()
        );
        assert_ne!(first.rebind_secret(), second.rebind_secret());
    }

    #[test]
    fn a_wrong_secret_fails_both_macs_and_never_reaches_decapsulation() {
        let wrong = [0x5d; SESSION_REBIND_SECRET_BYTES];
        let client = RebindClientBootstrap::new([0x12; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(4, client.encapsulation_key());
        let mac1 = compute_rebind_request_mac(&RS, &request_tbs).unwrap();
        assert_eq!(
            verify_rebind_request_mac(&wrong, &request_tbs, &mac1),
            Err(SessionCryptoError::InvalidRebindMac)
        );

        let server = RebindServerEncapsulation::new(
            client.encapsulation_key(),
            [0x45; ML_KEM_ENCAPS_RANDOM_BYTES],
        )
        .unwrap();
        let response_tbs = build_rebind_response_transcript(
            &request_tbs,
            &[0x56; SESSION_NONCE_BYTES],
            server.ciphertext(),
            9,
        )
        .unwrap();
        let mac2 = compute_rebind_response_mac(&wrong, &response_tbs, &MSG2).unwrap();
        assert_eq!(
            client
                .complete(&RS, server.ciphertext(), &response_tbs, &MSG2, &mac2)
                .err(),
            Some(SessionCryptoError::InvalidRebindMac)
        );
    }

    /// Every transcript field is authenticated: flipping any one of them must
    /// invalidate the MAC rather than silently producing a different session.
    #[test]
    fn every_request_field_is_bound() {
        let client = RebindClientBootstrap::new([0x13; ML_KEM_KEYGEN_SEED_BYTES]);
        let key = client.encapsulation_key();
        let base = request(7, key);
        let mac = compute_rebind_request_mac(&RS, &base).unwrap();

        let variants = [
            build_rebind_request_transcript(
                "other-session",
                "browser-node",
                "daemon-node",
                7,
                &LINEAGE,
                &[0x71; SESSION_NONCE_BYTES],
                key,
            ),
            build_rebind_request_transcript(
                "session-from-server",
                "other-browser",
                "daemon-node",
                7,
                &LINEAGE,
                &[0x71; SESSION_NONCE_BYTES],
                key,
            ),
            build_rebind_request_transcript(
                "session-from-server",
                "browser-node",
                "other-daemon",
                7,
                &LINEAGE,
                &[0x71; SESSION_NONCE_BYTES],
                key,
            ),
            // The counter is the generation fence.
            build_rebind_request_transcript(
                "session-from-server",
                "browser-node",
                "daemon-node",
                8,
                &LINEAGE,
                &[0x71; SESSION_NONCE_BYTES],
                key,
            ),
            build_rebind_request_transcript(
                "session-from-server",
                "browser-node",
                "daemon-node",
                7,
                &[0x1e; SESSION_COMMITMENT_BYTES],
                &[0x71; SESSION_NONCE_BYTES],
                key,
            ),
            build_rebind_request_transcript(
                "session-from-server",
                "browser-node",
                "daemon-node",
                7,
                &LINEAGE,
                &[0x72; SESSION_NONCE_BYTES],
                key,
            ),
        ];
        for variant in variants {
            let variant = variant.unwrap();
            assert_ne!(variant, base);
            assert_eq!(
                verify_rebind_request_mac(&RS, &variant, &mac),
                Err(SessionCryptoError::InvalidRebindMac)
            );
        }
    }

    #[test]
    fn response_binds_the_request_and_the_input_resync_point() {
        let client = RebindClientBootstrap::new([0x14; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(2, client.encapsulation_key());
        let server = RebindServerEncapsulation::new(
            client.encapsulation_key(),
            [0x46; ML_KEM_ENCAPS_RANDOM_BYTES],
        )
        .unwrap();
        let base = build_rebind_response_transcript(
            &request_tbs,
            &[0x57; SESSION_NONCE_BYTES],
            server.ciphertext(),
            9,
        )
        .unwrap();
        let mac = compute_rebind_response_mac(&RS, &base, &MSG2).unwrap();

        let shifted_sequence = build_rebind_response_transcript(
            &request_tbs,
            &[0x57; SESSION_NONCE_BYTES],
            server.ciphertext(),
            10,
        )
        .unwrap();
        assert_eq!(
            verify_rebind_response_mac(&RS, &shifted_sequence, &MSG2, &mac),
            Err(SessionCryptoError::InvalidRebindMac)
        );

        let other_request = request(3, client.encapsulation_key());
        let other = build_rebind_response_transcript(
            &other_request,
            &[0x57; SESSION_NONCE_BYTES],
            server.ciphertext(),
            9,
        )
        .unwrap();
        assert_eq!(
            verify_rebind_response_mac(&RS, &other, &MSG2, &mac),
            Err(SessionCryptoError::InvalidRebindMac)
        );
    }

    /// The two MAC domains must not be interchangeable, or a captured request
    /// proof would authenticate a forged response.
    #[test]
    fn request_and_response_macs_are_domain_separated() {
        let client = RebindClientBootstrap::new([0x15; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(5, client.encapsulation_key());
        let request_mac = compute_rebind_request_mac(&RS, &request_tbs).unwrap();
        let same_bytes_other_domain =
            rebind_mac(&RS, REBIND_RESPONSE_MAC_DOMAIN, &request_tbs).unwrap();
        assert_ne!(request_mac, same_bytes_other_domain);
    }

    #[test]
    fn transcripts_reject_a_foreign_domain() {
        let genesis = crate::hybrid::build_session_request_transcript(
            b"token",
            "session",
            "browser",
            "daemon",
            &[0; SESSION_NONCE_BYTES],
            &[0; ML_KEM_ENCAPSULATION_KEY_BYTES],
        )
        .unwrap();
        assert_eq!(
            compute_rebind_request_mac(&RS, &genesis),
            Err(SessionCryptoError::InvalidTranscript)
        );
        assert_eq!(
            hash_rebind_response_transcript(&genesis),
            Err(SessionCryptoError::InvalidTranscript)
        );
        assert_eq!(
            derive_rebind_secrets(&RS, &[0u8; ML_KEM_SHARED_SECRET_BYTES], &genesis).err(),
            Some(SessionCryptoError::InvalidTranscript)
        );
    }

    #[test]
    fn lineage_digest_is_domain_separated_and_stable() {
        let genesis = b"merkur-session/response\0some-bytes";
        let first = compute_rebind_lineage_digest(genesis).unwrap();
        assert_eq!(first, compute_rebind_lineage_digest(genesis).unwrap());
        assert_ne!(first, domain_hash(REBIND_REQUEST_DIGEST_DOMAIN, genesis));
        assert!(compute_rebind_lineage_digest(&[]).is_err());
    }
}

/// Committed cross-implementation vector for the rebind exchange.
///
/// The daemon and browser derive these bytes with the same code, so nothing at
/// runtime would detect a drift between the two sides of the wire — the vector
/// is the only thing that does, in the same way `session-auth.json` pins the
/// direct-upgrade proof.
#[cfg(any(test, feature = "testing"))]
pub mod vectors {
    use super::*;

    /// Message 1 as the vector pins it. A fixed value, because the vector's
    /// whole job is to be byte-identical across the two implementations.
    pub const VECTOR_NOISE_MSG1: [u8; 4] = [0xa1, 0xa2, 0xa3, 0xa4];
    pub const VECTOR_NOISE_MSG2: [u8; 4] = [0xb1, 0xb2, 0xb3, 0xb4];
    pub const VECTOR_REBIND_SECRET: [u8; SESSION_REBIND_SECRET_BYTES] =
        [0x5c; SESSION_REBIND_SECRET_BYTES];
    pub const VECTOR_LINEAGE_DIGEST: [u8; SESSION_COMMITMENT_BYTES] =
        [0x1d; SESSION_COMMITMENT_BYTES];
    pub const VECTOR_SESSION_ID: &str = "session-from-server";
    pub const VECTOR_BROWSER_NODE_ID: &str = "browser-node";
    pub const VECTOR_DAEMON_ID: &str = "daemon-node";
    pub const VECTOR_COUNTER: u64 = 3;
    pub const VECTOR_CLIENT_NONCE: [u8; SESSION_NONCE_BYTES] = [0x71; SESSION_NONCE_BYTES];
    pub const VECTOR_DAEMON_NONCE: [u8; SESSION_NONCE_BYTES] = [0x55; SESSION_NONCE_BYTES];
    pub const VECTOR_KEYGEN_SEED: [u8; ML_KEM_KEYGEN_SEED_BYTES] = [0x11; ML_KEM_KEYGEN_SEED_BYTES];
    pub const VECTOR_ENCAPS_RANDOM: [u8; ML_KEM_ENCAPS_RANDOM_BYTES] =
        [0x44; ML_KEM_ENCAPS_RANDOM_BYTES];
    pub const VECTOR_NEXT_EXPECTED_INPUT_SEQ: u32 = 9;

    /// Replays the exact committed exchange and returns every value the vector
    /// pins, so both language suites assert the same derivation.
    pub struct RebindVector {
        /// The preamble: what the Noise prologue binds.
        pub request_transcript: Vec<u8>,
        /// `preamble || msg1`: what the flight-1 MAC and the replay digest are
        /// taken over. Two digests, because the prologue cannot depend on a
        /// message that cannot be written until the prologue exists.
        pub bound_request_transcript: Vec<u8>,
        pub request_mac: [u8; SESSION_REBIND_MAC_BYTES],
        pub ciphertext: [u8; ML_KEM_CIPHERTEXT_BYTES],
        pub response_transcript: Vec<u8>,
        pub response_mac: [u8; SESSION_REBIND_MAC_BYTES],
        pub prologue_digest: [u8; 64],
        pub successor_secrets: [u8; crate::hybrid::SESSION_SECRETS_BYTES],
    }

    pub fn rebind_vector() -> RebindVector {
        let client = RebindClientBootstrap::new(VECTOR_KEYGEN_SEED);
        let request_transcript = build_rebind_request_transcript(
            VECTOR_SESSION_ID,
            VECTOR_BROWSER_NODE_ID,
            VECTOR_DAEMON_ID,
            VECTOR_COUNTER,
            &VECTOR_LINEAGE_DIGEST,
            &VECTOR_CLIENT_NONCE,
            client.encapsulation_key(),
        )
        .expect("vector request transcript");
        let bound_request_transcript =
            bind_rebind_request_msg1(&request_transcript, &VECTOR_NOISE_MSG1)
                .expect("vector bound request transcript");
        let request_mac =
            compute_rebind_request_mac(&VECTOR_REBIND_SECRET, &bound_request_transcript)
                .expect("vector request mac");

        let server =
            RebindServerEncapsulation::new(client.encapsulation_key(), VECTOR_ENCAPS_RANDOM)
                .expect("vector encapsulation");
        let ciphertext = *server.ciphertext();
        // Bound to the WHOLE request, message 1 included.
        let response_transcript = build_rebind_response_transcript(
            &bound_request_transcript,
            &VECTOR_DAEMON_NONCE,
            &ciphertext,
            VECTOR_NEXT_EXPECTED_INPUT_SEQ,
        )
        .expect("vector response transcript");
        let response_mac = compute_rebind_response_mac(
            &VECTOR_REBIND_SECRET,
            &response_transcript,
            &VECTOR_NOISE_MSG2,
        )
        .expect("vector response mac");
        // The prologue binds the REQUEST now, so message 1 can ride flight 1.
        let prologue_digest =
            hash_rebind_request_transcript(&request_transcript).expect("vector prologue digest");

        let successor = client
            .complete(
                &VECTOR_REBIND_SECRET,
                &ciphertext,
                &response_transcript,
                &VECTOR_NOISE_MSG2,
                &response_mac,
            )
            .expect("vector successor");

        RebindVector {
            request_transcript,
            bound_request_transcript,
            request_mac,
            ciphertext,
            response_transcript,
            response_mac,
            prologue_digest,
            successor_secrets: *successor.as_bytes(),
        }
    }
}

#[cfg(test)]
mod committed_vector {
    use super::vectors::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The committed vector is the only thing that detects a drift between the
    /// daemon and browser sides of this exchange: both derive it with the same
    /// code, so nothing at runtime would notice if the derivation changed.
    #[test]
    fn committed_vector_still_reproduces() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/test-vectors/session-auth.json"
        ));
        let doc: serde_json::Value = serde_json::from_str(raw).expect("vector JSON");
        let pinned = &doc["rebind"];
        let v = rebind_vector();

        let expect = |key: &str, actual: &[u8]| {
            let want = pinned[key]
                .as_str()
                .unwrap_or_else(|| panic!("{key} missing"));
            assert_eq!(
                want,
                hex(actual),
                "committed rebind vector drifted at {key}"
            );
        };
        expect("noise_msg1_hex", &VECTOR_NOISE_MSG1);
        expect("noise_msg2_hex", &VECTOR_NOISE_MSG2);
        expect("request_transcript_hex", &v.request_transcript);
        expect("bound_request_transcript_hex", &v.bound_request_transcript);
        expect("request_mac_hex", &v.request_mac);
        expect("ciphertext_hex", &v.ciphertext);
        expect("response_transcript_hex", &v.response_transcript);
        expect("response_mac_hex", &v.response_mac);
        expect("prologue_digest_hex", &v.prologue_digest);
        expect("successor_secrets_hex", &v.successor_secrets);
        assert_eq!(
            pinned["rebind_counter"].as_u64(),
            Some(VECTOR_COUNTER),
            "committed rebind vector drifted at rebind_counter"
        );
        assert_eq!(
            pinned["next_expected_input_seq"].as_u64(),
            Some(u64::from(VECTOR_NEXT_EXPECTED_INPUT_SEQ)),
            "committed rebind vector drifted at next_expected_input_seq"
        );
    }

    /// Emits the vector JSON for `packages/shared/test-vectors/session-auth.json`.
    /// Ignored by default; run with `--ignored -- --nocapture` to regenerate.
    #[test]
    #[ignore]
    fn emit_rebind_vector() {
        let v = rebind_vector();
        println!(
            r#"  "rebind": {{
    "rebind_secret_hex": "{}",
    "lineage_digest_hex": "{}",
    "session_id": "{}",
    "browser_node_id": "{}",
    "daemon_id": "{}",
    "rebind_counter": {},
    "client_nonce_hex": "{}",
    "noise_msg1_hex": "{}",
    "noise_msg2_hex": "{}",
    "daemon_nonce_hex": "{}",
    "ml_kem_keygen_seed_hex": "{}",
    "ml_kem_encaps_random_hex": "{}",
    "next_expected_input_seq": {},
    "request_transcript_hex": "{}",
    "bound_request_transcript_hex": "{}",
    "request_mac_hex": "{}",
    "ciphertext_hex": "{}",
    "response_transcript_hex": "{}",
    "response_mac_hex": "{}",
    "prologue_digest_hex": "{}",
    "successor_secrets_hex": "{}"
  }}"#,
            hex(&VECTOR_REBIND_SECRET),
            hex(&VECTOR_LINEAGE_DIGEST),
            VECTOR_SESSION_ID,
            VECTOR_BROWSER_NODE_ID,
            VECTOR_DAEMON_ID,
            VECTOR_COUNTER,
            hex(&VECTOR_CLIENT_NONCE),
            hex(&VECTOR_NOISE_MSG1),
            hex(&VECTOR_NOISE_MSG2),
            hex(&VECTOR_DAEMON_NONCE),
            hex(&VECTOR_KEYGEN_SEED),
            hex(&VECTOR_ENCAPS_RANDOM),
            VECTOR_NEXT_EXPECTED_INPUT_SEQ,
            hex(&v.request_transcript),
            hex(&v.bound_request_transcript),
            hex(&v.request_mac),
            hex(&v.ciphertext),
            hex(&v.response_transcript),
            hex(&v.response_mac),
            hex(&v.prologue_digest),
            hex(&v.successor_secrets),
        );
    }
}
