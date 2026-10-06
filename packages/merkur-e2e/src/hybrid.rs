//! Merkur's post-quantum session bootstrap.
//!
//! This module is shared by the daemon and browser Wasm build. It owns the
//! canonical session transcripts, ML-KEM-1024, the daemon's static ML-DSA-87
//! identity, and the final session-secret derivation so those byte strings
//! cannot drift between implementations.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use libcrux_ml_dsa::ml_dsa_87::{
    self, MLDSA87Signature, MLDSA87SigningKey, MLDSA87VerificationKey,
};
use libcrux_ml_kem::mlkem1024::{
    self, MlKem1024Ciphertext, MlKem1024PrivateKey, MlKem1024PublicKey,
};
use sha2::{Digest, Sha256, Sha512};
use zeroize::{Zeroize, Zeroizing};

/// FIPS 203 ML-KEM-1024 encapsulation-key size.
pub const ML_KEM_ENCAPSULATION_KEY_BYTES: usize = 1_568;
/// FIPS 203 ML-KEM-1024 decapsulation-key size.
pub const ML_KEM_DECAPSULATION_KEY_BYTES: usize = 3_168;
/// FIPS 203 ML-KEM-1024 ciphertext size.
pub const ML_KEM_CIPHERTEXT_BYTES: usize = 1_568;
/// Caller-provided entropy required by deterministic ML-KEM key generation.
pub const ML_KEM_KEYGEN_SEED_BYTES: usize = 64;
/// Caller-provided entropy required by deterministic ML-KEM encapsulation.
pub const ML_KEM_ENCAPS_RANDOM_BYTES: usize = 32;
/// ML-KEM shared-secret size.
pub const ML_KEM_SHARED_SECRET_BYTES: usize = 32;
/// Browser and daemon nonces are exactly 256 bits.
pub const SESSION_NONCE_BYTES: usize = 32;
/// A compact SHA-512 capability commitment (`k` or `q`).
pub const SESSION_COMMITMENT_BYTES: usize = 64;
/// FIPS 204 ML-DSA-87 key-generation seed size.
pub const DAEMON_IDENTITY_SEED_BYTES: usize = 32;
/// FIPS 204 ML-DSA-87 expanded signing-key size.
pub const DAEMON_IDENTITY_SIGNING_KEY_BYTES: usize = 4_896;
/// FIPS 204 ML-DSA-87 public verification-key size.
pub const DAEMON_IDENTITY_PUBLIC_KEY_BYTES: usize = 2_592;
/// FIPS 204 ML-DSA-87 signature size.
pub const DAEMON_IDENTITY_SIGNATURE_BYTES: usize = 4_627;
/// Fresh hedging randomness required for each ML-DSA signature.
pub const DAEMON_IDENTITY_SIGNING_RANDOM_BYTES: usize = 32;
/// The Noise PSK and direct-upgrade secret are each 256 bits.
pub const SESSION_SECRET_BYTES: usize = 32;
/// The carrier-rebind chaining secret is 512 bits.
///
/// It is longer than the other two because it is used as an HKDF pseudorandom
/// key rather than as key material directly: the rebind MAC subkey is
/// `HKDF-Expand(RS, "merkur-rebind/mac")`, and `hkdf`'s `from_prk` rejects a
/// pseudorandom key shorter than the hash output.
pub const SESSION_REBIND_SECRET_BYTES: usize = 64;
/// `noise_psk || direct_upgrade_secret || rebind_secret`.
pub const SESSION_SECRETS_BYTES: usize = 128;

/// FIPS 204 external signing context for a daemon's session response.
pub const DAEMON_IDENTITY_SIGNATURE_CONTEXT: &[u8] = b"merkur-session-ready";
/// FIPS 204 external signing context for the browser delegate's exact-session proof.
pub const SESSION_DELEGATION_SIGNATURE_CONTEXT: &[u8] = b"merkur-session-delegation";

const REQUEST_DOMAIN: &[u8] = b"merkur-session/request";
const RESPONSE_DOMAIN: &[u8] = b"merkur-session/response";
const DELEGATION_PROOF_DOMAIN: &[u8] = b"merkur-session-delegation-proof\0";
const DELEGATION_AUTHORIZATION_DOMAIN: &[u8] = b"merkur-session-delegation-authorization\0";
const TOKEN_DIGEST_DOMAIN: &[u8] = b"merkur-session/token-digest";
const REQUEST_DIGEST_DOMAIN: &[u8] = b"merkur-session/request-digest";
const KDF_SALT_DOMAIN: &[u8] = b"merkur-session/kdf-salt";
const DAEMON_IDENTITY_KEY_HASH_DOMAIN: &[u8] = b"merkur-daemon-identity-key\0";
const SESSION_REQUEST_COMMITMENT_DOMAIN: &[u8] = b"merkur-session-request\0";
const NOISE_PSK_INFO: &[u8] = b"merkur-session/noise-psk";
const DIRECT_UPGRADE_INFO: &[u8] = b"merkur-session/direct-upgrade";
const REBIND_SECRET_INFO: &[u8] = b"merkur-session/rebind";

// Fail compilation if a pinned library changes a selected parameter.
const _: [(); ML_KEM_KEYGEN_SEED_BYTES] = [(); libcrux_ml_kem::KEY_GENERATION_SEED_SIZE];
const _: [(); ML_KEM_ENCAPS_RANDOM_BYTES] = [(); libcrux_ml_kem::ENCAPS_SEED_SIZE];
const _: [(); ML_KEM_SHARED_SECRET_BYTES] = [(); libcrux_ml_kem::SHARED_SECRET_SIZE];
const _: [(); ML_KEM_ENCAPSULATION_KEY_BYTES] = [(); MlKem1024PublicKey::len()];
const _: [(); ML_KEM_CIPHERTEXT_BYTES] = [(); MlKem1024Ciphertext::len()];
const _: [(); ML_KEM_DECAPSULATION_KEY_BYTES] = [(); MlKem1024PrivateKey::len()];
const _: [(); DAEMON_IDENTITY_SIGNING_KEY_BYTES] = [(); MLDSA87SigningKey::len()];
const _: [(); DAEMON_IDENTITY_PUBLIC_KEY_BYTES] = [(); MLDSA87VerificationKey::len()];
const _: [(); DAEMON_IDENTITY_SIGNATURE_BYTES] = [(); MLDSA87Signature::len()];

/// Fail-closed errors at the post-quantum session boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionCryptoError {
    EmptyField(&'static str),
    InvalidLength {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
    InvalidEncapsulationKey,
    InvalidDecapsulationKey,
    InvalidDaemonIdentitySignature,
    InvalidMlDsaSignature,
    InvalidRebindMac,
    InvalidTranscript,
    Signing,
    Kdf,
}

impl std::fmt::Display for SessionCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyField(field) => write!(f, "session field `{field}` must not be empty"),
            Self::InvalidLength {
                field,
                expected,
                actual,
            } => write!(
                f,
                "session field `{field}` has {actual} bytes; expected exactly {expected}"
            ),
            Self::InvalidEncapsulationKey => write!(f, "invalid ML-KEM-1024 encapsulation key"),
            Self::InvalidDecapsulationKey => write!(f, "invalid ML-KEM-1024 decapsulation key"),
            Self::InvalidDaemonIdentitySignature => {
                write!(f, "invalid composite daemon identity signature")
            }
            Self::InvalidMlDsaSignature => write!(f, "invalid ML-DSA-87 signature"),
            Self::InvalidRebindMac => write!(f, "invalid carrier-rebind HMAC-SHA-512 proof"),
            Self::InvalidTranscript => write!(f, "invalid session authentication transcript"),
            Self::Signing => write!(f, "ML-DSA-87 signing failed"),
            Self::Kdf => write!(f, "session HKDF-SHA-512 expansion failed"),
        }
    }
}

impl std::error::Error for SessionCryptoError {}

/// Computes compact capability claim `k` exactly as the application server.
///
/// `SHA-512("merkur-daemon-identity-key\\0" || public_key[2592] || p256_public_key[65])`
pub fn compute_daemon_identity_key_hash(
    public_key: &[u8],
    p256_public_key: &[u8],
) -> Result<[u8; SESSION_COMMITMENT_BYTES], SessionCryptoError> {
    let public_key =
        exact_ref::<DAEMON_IDENTITY_PUBLIC_KEY_BYTES>("daemon_identity_public_key", public_key)?;
    let mut hash = Sha512::new();
    hash.update(DAEMON_IDENTITY_KEY_HASH_DOMAIN);
    hash.update(public_key);
    crate::validate_daemon_p256_public_key(p256_public_key)?;
    hash.update(p256_public_key);
    Ok(hash.finalize().into())
}

/// Computes compact capability claim `q` exactly as the application server.
///
/// `SHA-512("merkur-session-request\\0" || client_nonce[32] || ek[1568])`
pub fn compute_session_request_commitment(
    client_nonce: &[u8],
    encapsulation_key: &[u8],
) -> Result<[u8; SESSION_COMMITMENT_BYTES], SessionCryptoError> {
    let nonce = exact_ref::<SESSION_NONCE_BYTES>("client_nonce", client_nonce)?;
    let key = exact_ref::<ML_KEM_ENCAPSULATION_KEY_BYTES>("encapsulation_key", encapsulation_key)?;
    let mut hash = Sha512::new();
    hash.update(SESSION_REQUEST_COMMITMENT_DOMAIN);
    hash.update(nonce);
    hash.update(key);
    Ok(hash.finalize().into())
}

/// Plain SHA-256, for the release-key fingerprint and build verification id.
pub fn sha256(message: &[u8]) -> [u8; 32] {
    Sha256::digest(message).into()
}

/// Plain SHA-512, for the user-authorization commitments and signed build
/// manifests, which hash in TypeScript-owned framing.
pub fn sha512(message: &[u8]) -> [u8; 64] {
    Sha512::digest(message).into()
}

/// HMAC-SHA-512 for the daemon link approval MAC.
pub fn hmac_sha512(key: &[u8], message: &[u8]) -> Result<[u8; 64], SessionCryptoError> {
    let mut mac =
        <Hmac<Sha512> as Mac>::new_from_slice(key).map_err(|_| SessionCryptoError::Kdf)?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().into())
}

/// Canonical request transcript authenticated by the server capability and
/// bound into the daemon's signed response.
///
/// The exact capability token is represented by a domain-separated SHA-512
/// digest. Every other value has fixed binary order and length framing; JSON
/// encoding never participates in authentication. No browser address is bound:
/// the daemon learns it only from the edge's validated path report.
pub fn build_session_request_transcript(
    token: &[u8],
    session_id: &str,
    browser_node_id: &str,
    daemon_id: &str,
    client_nonce: &[u8; SESSION_NONCE_BYTES],
    encapsulation_key: &[u8; ML_KEM_ENCAPSULATION_KEY_BYTES],
) -> Result<Vec<u8>, SessionCryptoError> {
    require_nonempty("token", token)?;
    require_nonempty("session_id", session_id.as_bytes())?;
    require_nonempty("browser_node_id", browser_node_id.as_bytes())?;
    require_nonempty("daemon_id", daemon_id.as_bytes())?;

    let token_digest = domain_hash(TOKEN_DIGEST_DOMAIN, token);
    let mut transcript = BinaryTranscript::new(REQUEST_DOMAIN);
    transcript.field(1, &token_digest);
    transcript.field(2, session_id.as_bytes());
    transcript.field(3, browser_node_id.as_bytes());
    transcript.field(4, daemon_id.as_bytes());
    transcript.field(5, client_nonce);
    transcript.field(6, encapsulation_key);
    Ok(transcript.finish())
}

/// Append Noise message 1 to a session request preamble.
///
/// The genesis counterpart of `bind_rebind_request_msg1`, and the same two
/// digests for the same reason. The prologue binds the PREAMBLE above, which
/// the browser holds before it can write message 1; this produces
/// `preamble || msg1`, which is what the browser's ML-DSA-87 delegate signature
/// covers and what the response transcript is built from.
///
/// Message 1 rides the same flight as the signature over it, so without this it
/// would be unauthenticated: an on-path party could splice its own and make the
/// legitimate browser's message 3 fail, denying the connection without holding
/// any key.
pub fn bind_session_request_msg1(
    request_preamble: &[u8],
    noise_msg1: &[u8],
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(request_preamble, REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    require_nonempty("noise_msg1", noise_msg1)?;
    let mut bound = Vec::with_capacity(request_preamble.len() + 16 + noise_msg1.len());
    bound.extend_from_slice(request_preamble);
    // Field 7, in the same encoding the transcript itself uses, so the result
    // stays a canonical transcript rather than an ad-hoc concatenation.
    bound.extend_from_slice(&7u64.to_be_bytes());
    bound.extend_from_slice(&(noise_msg1.len() as u64).to_be_bytes());
    bound.extend_from_slice(noise_msg1);
    Ok(bound)
}

/// Exact bytes signed by the browser's root-certified delegation key.
///
/// Layout: `"merkur-session-delegation-proof\0" ||
/// u64be(request.len) || request || SHA-512(canonical full certificate JSON)`.
pub fn build_session_delegation_proof_transcript(
    request_transcript: &[u8],
    canonical_certificate_json: &[u8],
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(request_transcript, REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    require_nonempty("delegation_certificate", canonical_certificate_json)?;
    let certificate_digest: [u8; 64] = Sha512::digest(canonical_certificate_json).into();
    let mut transcript = Vec::with_capacity(
        DELEGATION_PROOF_DOMAIN.len() + 8 + request_transcript.len() + certificate_digest.len(),
    );
    transcript.extend_from_slice(DELEGATION_PROOF_DOMAIN);
    transcript.extend_from_slice(&(request_transcript.len() as u64).to_be_bytes());
    transcript.extend_from_slice(request_transcript);
    transcript.extend_from_slice(&certificate_digest);
    Ok(transcript)
}

/// Digest bound into the daemon-signed response and hybrid KDF.
///
/// Layout: `SHA-512("merkur-session-delegation-authorization\0" ||
/// u64be(proof.len) || proof || SHA-512(delegate_signature))`.
pub fn compute_session_delegation_authorization_digest(
    proof_transcript: &[u8],
    delegate_signature: &[u8],
) -> Result<[u8; SESSION_COMMITMENT_BYTES], SessionCryptoError> {
    if !proof_transcript.starts_with(DELEGATION_PROOF_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let delegate_signature =
        exact_ref::<DAEMON_IDENTITY_SIGNATURE_BYTES>("delegation_signature", delegate_signature)?;
    let signature_digest: [u8; 64] = Sha512::digest(delegate_signature).into();
    let mut hash = Sha512::new();
    hash.update(DELEGATION_AUTHORIZATION_DOMAIN);
    hash.update((proof_transcript.len() as u64).to_be_bytes());
    hash.update(proof_transcript);
    hash.update(signature_digest);
    Ok(hash.finalize().into())
}

/// Canonical response transcript signed by the daemon's static ML-DSA-87
/// identity and used as session KDF context.
pub fn build_session_response_transcript(
    request_transcript: &[u8],
    delegation_authorization_digest: &[u8; SESSION_COMMITMENT_BYTES],
    daemon_nonce: &[u8; SESSION_NONCE_BYTES],
    ciphertext: &[u8; ML_KEM_CIPHERTEXT_BYTES],
    next_expected_input_seq: u32,
    noise_msg2: &[u8],
) -> Result<Vec<u8>, SessionCryptoError> {
    if !has_domain(request_transcript, REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    let request_digest = domain_hash(REQUEST_DIGEST_DOMAIN, request_transcript);
    let sequence = next_expected_input_seq.to_be_bytes();

    let mut transcript = BinaryTranscript::new(RESPONSE_DOMAIN);
    transcript.field(1, &request_digest);
    transcript.field(2, delegation_authorization_digest);
    transcript.field(3, daemon_nonce);
    transcript.field(4, ciphertext);
    transcript.field(5, &sequence);
    require_nonempty("noise_msg2", noise_msg2)?;
    transcript.field(6, noise_msg2);
    Ok(transcript.finish())
}

/// Refuse a separately supplied message 2 unless it is the exact final field
/// covered by the identity proof. Used at the byte-oriented WASM boundary.
pub fn validate_session_response_msg2(
    response_transcript: &[u8],
    noise_msg2: &[u8],
) -> Result<(), SessionCryptoError> {
    require_nonempty("noise_msg2", noise_msg2)?;
    let suffix_len = noise_msg2
        .len()
        .checked_add(9)
        .ok_or(SessionCryptoError::InvalidTranscript)?;
    let offset = response_transcript
        .len()
        .checked_sub(suffix_len)
        .ok_or(SessionCryptoError::InvalidTranscript)?;
    let suffix = &response_transcript[offset..];
    if !has_domain(response_transcript, RESPONSE_DOMAIN)
        || suffix[0] != 6
        || suffix[1..9] != (noise_msg2.len() as u64).to_be_bytes()
        || suffix[9..] != *noise_msg2
    {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    Ok(())
}

/// Expanded static daemon identity. Its secret bytes are wiped on drop.
pub struct DaemonIdentitySigningKey {
    signing_key: MLDSA87SigningKey,
    public_key: [u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES],
}

impl DaemonIdentitySigningKey {
    /// Expands exactly one 32-byte seed and wipes both the supplied slice and
    /// all transient secret copies. The expanded secret is retained and reused
    /// for signatures; per-signature hedging randomness must still be fresh.
    pub fn from_seed(seed: &mut [u8]) -> Result<Self, SessionCryptoError> {
        let seed_result = copy_exact::<DAEMON_IDENTITY_SEED_BYTES>("identity_seed", seed);
        seed.zeroize();
        let mut seed = Zeroizing::new(seed_result?);
        let key_pair = ml_dsa_87::generate_key_pair(*seed);
        seed.zeroize();

        let public_key = *key_pair.verification_key.as_ref();
        let signing_key = key_pair.signing_key;
        Ok(Self {
            signing_key,
            public_key,
        })
    }

    pub fn public_key(&self) -> &[u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES] {
        &self.public_key
    }

    pub fn public_key_hash(
        &self,
        p256_public_key: &[u8],
    ) -> Result<[u8; SESSION_COMMITMENT_BYTES], SessionCryptoError> {
        compute_daemon_identity_key_hash(&self.public_key, p256_public_key)
    }

    /// Signs one complete response transcript under the mandatory FIPS 204
    /// context. The 32-byte hedging randomness is wiped on every return path.
    pub fn sign_response(
        &self,
        response_transcript: &[u8],
        mut signing_randomness: [u8; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES],
    ) -> Result<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES], SessionCryptoError> {
        if !has_domain(response_transcript, RESPONSE_DOMAIN) {
            signing_randomness.zeroize();
            return Err(SessionCryptoError::InvalidTranscript);
        }
        self.sign_with_context(
            DAEMON_IDENTITY_SIGNATURE_CONTEXT,
            response_transcript,
            signing_randomness,
        )
    }

    /// All identity proof sites use a fixed FIPS 204 context. Only the daemon
    /// signing worker owns a production signing key.
    pub fn sign_with_context(
        &self,
        context: &[u8],
        transcript: &[u8],
        mut signing_randomness: [u8; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES],
    ) -> Result<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES], SessionCryptoError> {
        let result = ml_dsa_87::sign(&self.signing_key, transcript, context, signing_randomness);
        signing_randomness.zeroize();
        result
            .map(|signature| *signature.as_ref())
            .map_err(|_| SessionCryptoError::Signing)
    }
}

/// An ML-DSA-87 key that signs under a FIPS 204 context, wherever its secret
/// lives: expanded in locked memory, or inside a Secure Enclave that never
/// releases it. Every signature site takes this, so no caller holds a seed.
///
/// `randomness` is the caller's fresh 32 bytes of hedging entropy. A hardware
/// key hedges with its own generator; it wipes the supplied bytes unused.
pub trait MlDsa87Signer: Send + Sync {
    fn public_key(&self) -> &[u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES];

    fn sign_with_context(
        &self,
        context: &[u8],
        message: &[u8],
        randomness: [u8; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES],
    ) -> Result<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES], SessionCryptoError>;
}

impl MlDsa87Signer for DaemonIdentitySigningKey {
    fn public_key(&self) -> &[u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES] {
        DaemonIdentitySigningKey::public_key(self)
    }

    fn sign_with_context(
        &self,
        context: &[u8],
        message: &[u8],
        randomness: [u8; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES],
    ) -> Result<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES], SessionCryptoError> {
        DaemonIdentitySigningKey::sign_with_context(self, context, message, randomness)
    }
}

impl std::fmt::Debug for DaemonIdentitySigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DaemonIdentitySigningKey([REDACTED])")
    }
}

impl Drop for DaemonIdentitySigningKey {
    fn drop(&mut self) {
        self.signing_key.as_mut_slice().zeroize();
    }
}

/// Verifies the daemon's identity signature over a complete response
/// transcript under the mandatory FIPS 204 context.
pub fn verify_daemon_identity_signature(
    public_key: &[u8],
    p256_public_key: &[u8],
    response_transcript: &[u8],
    signature: &[u8],
    p256_signature: &[u8],
) -> Result<(), SessionCryptoError> {
    if !has_domain(response_transcript, RESPONSE_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    crate::verify_daemon_p256_signature(
        p256_public_key,
        &crate::daemon_p256_digest(DAEMON_IDENTITY_SIGNATURE_CONTEXT, response_transcript),
        p256_signature,
    )?;
    verify_ml_dsa87(
        public_key,
        DAEMON_IDENTITY_SIGNATURE_CONTEXT,
        response_transcript,
        signature,
    )
    .map_err(|error| match error {
        SessionCryptoError::InvalidMlDsaSignature => {
            SessionCryptoError::InvalidDaemonIdentitySignature
        }
        other => other,
    })
}

/// Verifies one ML-DSA-87 signature under a FIPS 204 external context.
///
/// The single ML-DSA verifier for every Merkur signature: the daemon identity
/// response above, and through the browser/Bun binding the server capability,
/// user-root delegations, daemon bindings, revocations, daemon management
/// proofs and release manifests.
pub fn verify_ml_dsa87(
    public_key: &[u8],
    context: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<(), SessionCryptoError> {
    let public_key = MLDSA87VerificationKey::new(copy_exact::<DAEMON_IDENTITY_PUBLIC_KEY_BYTES>(
        "ml_dsa87_public_key",
        public_key,
    )?);
    let signature = MLDSA87Signature::new(copy_exact::<DAEMON_IDENTITY_SIGNATURE_BYTES>(
        "ml_dsa87_signature",
        signature,
    )?);
    ml_dsa_87::verify(&public_key, message, context, &signature)
        .map_err(|_| SessionCryptoError::InvalidMlDsaSignature)
}

/// Browser-side ML-KEM bootstrap state.
///
/// The expanded decapsulation key is zeroized on drop. `complete` consumes the
/// object and verifies the daemon signature before performing decapsulation,
/// preventing both unauthenticated decapsulation and key reuse.
pub struct SessionClientBootstrap {
    decapsulation_key: Zeroizing<[u8; ML_KEM_DECAPSULATION_KEY_BYTES]>,
    encapsulation_key: [u8; ML_KEM_ENCAPSULATION_KEY_BYTES],
}

impl SessionClientBootstrap {
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

    /// Verifies the static daemon identity before decapsulating and deriving
    /// the session keys. A failed signature consumes this one-use bootstrap.
    pub fn complete(
        self,
        ciphertext: &[u8],
        daemon_identity_public_key: &[u8],
        daemon_identity_p256_public_key: &[u8],
        daemon_signature: &[u8],
        p256_signature: &[u8],
        response_transcript: &[u8],
    ) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
        verify_daemon_identity_signature(
            daemon_identity_public_key,
            daemon_identity_p256_public_key,
            response_transcript,
            daemon_signature,
            p256_signature,
        )?;
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
        let secrets =
            derive_session_secrets(&*shared_secret, daemon_signature, response_transcript);
        shared_secret.zeroize();
        secrets
    }
}

/// Daemon-side first phase. It exposes the ciphertext so the response
/// transcript can be built and signed before deriving session secrets.
pub struct SessionServerEncapsulation {
    ciphertext: [u8; ML_KEM_CIPHERTEXT_BYTES],
    shared_secret: Zeroizing<[u8; ML_KEM_SHARED_SECRET_BYTES]>,
}

impl SessionServerEncapsulation {
    /// Encapsulates to a validated ML-KEM-1024 key using exactly 32 fresh
    /// caller-supplied random bytes. Randomness is wiped on every return path.
    pub fn new(
        encapsulation_key: &[u8],
        mut encaps_randomness: [u8; ML_KEM_ENCAPS_RANDOM_BYTES],
    ) -> Result<Self, SessionCryptoError> {
        let key_bytes = match copy_exact::<ML_KEM_ENCAPSULATION_KEY_BYTES>(
            "encapsulation_key",
            encapsulation_key,
        ) {
            Ok(key_bytes) => key_bytes,
            Err(error) => {
                encaps_randomness.zeroize();
                return Err(error);
            }
        };
        let public_key = MlKem1024PublicKey::from(key_bytes);
        if !mlkem1024::validate_public_key(&public_key) {
            encaps_randomness.zeroize();
            return Err(SessionCryptoError::InvalidEncapsulationKey);
        }
        let (ciphertext, shared_secret) = mlkem1024::encapsulate(&public_key, encaps_randomness);
        encaps_randomness.zeroize();
        Ok(Self {
            ciphertext: ciphertext.into(),
            shared_secret: Zeroizing::new(shared_secret),
        })
    }

    pub fn ciphertext(&self) -> &[u8; ML_KEM_CIPHERTEXT_BYTES] {
        &self.ciphertext
    }

    /// The encapsulated shared secret, for the carrier-rebind combiner in
    /// [`crate::rebind`]. Crate-internal: the genesis path must reach it only
    /// through [`Self::complete`], which binds the daemon's ML-DSA signature.
    pub(crate) fn shared_secret(&self) -> &[u8; ML_KEM_SHARED_SECRET_BYTES] {
        &self.shared_secret
    }

    /// Binds the public daemon signature and signed response into the session
    /// KDF. The ML-KEM shared secret is wiped as this one-use value is consumed.
    pub fn complete(
        mut self,
        daemon_signature: &[u8],
        response_transcript: &[u8],
    ) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
        let out =
            derive_session_secrets(&*self.shared_secret, daemon_signature, response_transcript);
        self.shared_secret.zeroize();
        out
    }
}

/// Bootstrap combiner: HKDF-SHA-512 over the ML-KEM shared secret, salted by a
/// domain-separated digest of the signed response and its ML-DSA signature.
/// Only the Noise PSK is usable until the secondary outputs are combined with
/// the authenticated classical checkpoint by [`SessionBootstrapSecrets::bind_noise`].
pub fn derive_session_secrets(
    ml_kem_shared_secret: &[u8],
    daemon_signature: &[u8],
    response_transcript: &[u8],
) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
    let shared_secret =
        exact_ref::<ML_KEM_SHARED_SECRET_BYTES>("ml_kem_shared_secret", ml_kem_shared_secret)?;
    let signature =
        exact_ref::<DAEMON_IDENTITY_SIGNATURE_BYTES>("daemon_signature", daemon_signature)?;
    if !has_domain(response_transcript, RESPONSE_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }

    let mut salt_hash = Sha512::new();
    salt_hash.update(KDF_SALT_DOMAIN);
    salt_hash.update([0]);
    salt_hash.update((response_transcript.len() as u64).to_be_bytes());
    salt_hash.update(response_transcript);
    salt_hash.update((signature.len() as u64).to_be_bytes());
    salt_hash.update(signature);
    let mut salt = Zeroizing::new(<[u8; 64]>::from(salt_hash.finalize()));
    let secrets = expand_session_secrets(&salt, shared_secret);
    salt.zeroize();
    secrets
}

/// Shared expansion for both session-secret producers: the genesis combiner
/// above and the carrier-rebind combiner in [`crate::rebind`].
///
/// HKDF-Extract is performed explicitly rather than through `Hkdf::new` so the
/// pseudorandom key has an owner that is wiped. `hkdf 0.12.4` keeps its copy
/// inside an `Hmac` core that does not zeroize on drop, and one of these
/// outputs now roots a multi-generation rebind chain that outlives the call by
/// minutes — so the copy this function controls must not be left in freed
/// memory. The residual inside `Hkdf` is why the pseudorandom key is never
/// retained for anything beyond this expansion.
pub(crate) fn expand_session_secrets(
    salt: &[u8; 64],
    ikm: &[u8],
) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
    let mut extract =
        <Hmac<Sha512> as Mac>::new_from_slice(salt).map_err(|_| SessionCryptoError::Kdf)?;
    extract.update(ikm);
    let mut prk = Zeroizing::new(<[u8; 64]>::from(extract.finalize().into_bytes()));
    let hkdf = Hkdf::<Sha512>::from_prk(&*prk).map_err(|_| SessionCryptoError::Kdf)?;

    let mut secrets = SessionBootstrapSecrets {
        bytes: [0u8; SESSION_SECRETS_BYTES],
    };
    let (noise_psk, rest) = secrets.bytes.split_at_mut(SESSION_SECRET_BYTES);
    let (direct_upgrade_secret, rebind_secret) = rest.split_at_mut(SESSION_SECRET_BYTES);
    hkdf.expand(NOISE_PSK_INFO, noise_psk)
        .map_err(|_| SessionCryptoError::Kdf)?;
    hkdf.expand(DIRECT_UPGRADE_INFO, direct_upgrade_secret)
        .map_err(|_| SessionCryptoError::Kdf)?;
    hkdf.expand(REBIND_SECRET_INFO, rebind_secret)
        .map_err(|_| SessionCryptoError::Kdf)?;
    prk.zeroize();
    Ok(secrets)
}

/// The independent secrets derived for one authenticated session generation.
pub struct SessionSecrets {
    bytes: [u8; SESSION_SECRETS_BYTES],
}

/// Bootstrap-only KEM material. It cannot authorize a direct path or rebind:
/// those accessors exist only after consuming this owner with a Noise checkpoint.
pub struct SessionBootstrapSecrets {
    bytes: [u8; SESSION_SECRETS_BYTES],
}

impl SessionBootstrapSecrets {
    /// Bootstrap PSK, available independently of the secondary-secret combiner.
    pub fn noise_psk(&self) -> &[u8; SESSION_SECRET_BYTES] {
        self.bytes[..SESSION_SECRET_BYTES]
            .try_into()
            .expect("fixed split")
    }

    /// Finalize the secondary secrets with the authenticated classical
    /// checkpoint. The Noise PSK remains solely KEM-derived: XXpsk3 mixes it
    /// after this checkpoint, so feeding the combined outputs back would cycle.
    pub fn bind_noise(
        mut self,
        checkpoint: &crate::NoiseCheckpoint,
        response_transcript: &[u8],
    ) -> Result<SessionSecrets, SessionCryptoError> {
        let mut salt = Zeroizing::new(<[u8; 64]>::from(
            Sha512::new()
                .chain_update(b"merkur-session/secondary-salt\0")
                .chain_update(checkpoint.hash)
                .chain_update((response_transcript.len() as u64).to_be_bytes())
                .chain_update(response_transcript)
                .finalize(),
        ));
        let mut ikm = Zeroizing::new([0u8; 160]);
        ikm[..96].copy_from_slice(&self.bytes[32..]);
        ikm[96..128].copy_from_slice(&checkpoint.contribution.0);
        ikm[128..].copy_from_slice(&checkpoint.contribution.1);
        let mut extract =
            <Hmac<Sha512> as Mac>::new_from_slice(&*salt).map_err(|_| SessionCryptoError::Kdf)?;
        extract.update(&*ikm);
        let mut prk = Zeroizing::new(<[u8; 64]>::from(extract.finalize().into_bytes()));
        let hkdf = Hkdf::<Sha512>::from_prk(&*prk).map_err(|_| SessionCryptoError::Kdf)?;
        hkdf.expand(
            b"merkur-session/hybrid-direct-upgrade",
            &mut self.bytes[32..64],
        )
        .map_err(|_| SessionCryptoError::Kdf)?;
        hkdf.expand(
            b"merkur-session/hybrid-rebind-secret",
            &mut self.bytes[64..],
        )
        .map_err(|_| SessionCryptoError::Kdf)?;
        ikm.zeroize();
        salt.zeroize();
        prk.zeroize();
        Ok(SessionSecrets { bytes: self.bytes })
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn as_bytes(&self) -> &[u8; SESSION_SECRETS_BYTES] {
        &self.bytes
    }

    /// Secrets the rebind keeper's bounded proof chooses.
    #[cfg(kani)]
    pub(crate) fn from_bytes(bytes: [u8; SESSION_SECRETS_BYTES]) -> Self {
        Self { bytes }
    }
}

impl Drop for SessionBootstrapSecrets {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

impl SessionSecrets {
    pub fn noise_psk(&self) -> &[u8; SESSION_SECRET_BYTES] {
        self.bytes[..SESSION_SECRET_BYTES]
            .try_into()
            .expect("fixed split")
    }

    pub fn direct_upgrade_secret(&self) -> &[u8; SESSION_SECRET_BYTES] {
        self.bytes[SESSION_SECRET_BYTES..2 * SESSION_SECRET_BYTES]
            .try_into()
            .expect("fixed split")
    }

    /// Chaining secret for the next carrier rebind.
    ///
    /// Unlike [`Self::direct_upgrade_secret`], which is bound to one carrier
    /// lineage and never parked, this is the one output a disconnected peer
    /// retains. It is consumed by exactly one successful rebind, which derives
    /// its successor.
    pub fn rebind_secret(&self) -> &[u8; SESSION_REBIND_SECRET_BYTES] {
        self.bytes[2 * SESSION_SECRET_BYTES..]
            .try_into()
            .expect("fixed split")
    }

    pub fn as_bytes(&self) -> &[u8; SESSION_SECRETS_BYTES] {
        &self.bytes
    }

    /// Copies outputs for a boundary that must own returned bytes. The source
    /// is still zeroized when this consumed value drops.
    pub fn into_bytes(self) -> [u8; SESSION_SECRETS_BYTES] {
        self.bytes
    }

    /// Secrets the rebind keeper's bounded proof chooses.
    #[cfg(kani)]
    pub(crate) fn from_bytes(bytes: [u8; SESSION_SECRETS_BYTES]) -> Self {
        Self { bytes }
    }
}

impl std::fmt::Debug for SessionSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionSecrets")
            .field("noise_psk", &"[REDACTED]")
            .field("direct_upgrade_secret", &"[REDACTED]")
            .field("rebind_secret", &"[REDACTED]")
            .finish()
    }
}

impl Drop for SessionSecrets {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

/// SHA-512 digest of the REQUEST transcript, bound into the Noise prologue.
///
/// The prologue moved from the response to the request so the browser can write
/// Noise message 1 in the same flight as its request; see `derive_prologue` for
/// why that loses no binding.
pub fn hash_session_request_transcript(
    request_transcript: &[u8],
) -> Result<[u8; 64], SessionCryptoError> {
    if !has_domain(request_transcript, REQUEST_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    Ok(Sha512::digest(request_transcript).into())
}

/// SHA-512 digest of the response transcript. Still the KDF salt; no longer the
/// prologue.
pub fn hash_session_response_transcript(
    response_transcript: &[u8],
) -> Result<[u8; 64], SessionCryptoError> {
    if !has_domain(response_transcript, RESPONSE_DOMAIN) {
        return Err(SessionCryptoError::InvalidTranscript);
    }
    Ok(Sha512::digest(response_transcript).into())
}

pub(crate) struct BinaryTranscript {
    bytes: Vec<u8>,
}

impl BinaryTranscript {
    pub(crate) fn new(domain: &[u8]) -> Self {
        let mut bytes = Vec::with_capacity(domain.len() + 1 + 2_048);
        bytes.extend_from_slice(domain);
        bytes.push(0);
        Self { bytes }
    }

    pub(crate) fn field(&mut self, tag: u8, value: &[u8]) {
        self.bytes.push(tag);
        self.bytes
            .extend_from_slice(&(value.len() as u64).to_be_bytes());
        self.bytes.extend_from_slice(value);
    }

    pub(crate) fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

pub(crate) fn domain_hash(domain: &[u8], value: &[u8]) -> [u8; 64] {
    let mut hash = Sha512::new();
    hash.update(domain);
    hash.update([0]);
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value);
    hash.finalize().into()
}

pub(crate) fn has_domain(transcript: &[u8], domain: &[u8]) -> bool {
    transcript.len() > domain.len()
        && transcript.starts_with(domain)
        && transcript.get(domain.len()) == Some(&0)
}

pub(crate) fn require_nonempty(
    field: &'static str,
    value: &[u8],
) -> Result<(), SessionCryptoError> {
    if value.is_empty() {
        Err(SessionCryptoError::EmptyField(field))
    } else {
        Ok(())
    }
}

pub(crate) fn copy_exact<const N: usize>(
    field: &'static str,
    bytes: &[u8],
) -> Result<[u8; N], SessionCryptoError> {
    exact_ref::<N>(field, bytes).copied()
}

pub(crate) fn exact_ref<'a, const N: usize>(
    field: &'static str,
    bytes: &'a [u8],
) -> Result<&'a [u8; N], SessionCryptoError> {
    bytes
        .try_into()
        .map_err(|_| SessionCryptoError::InvalidLength {
            field,
            expected: N,
            actual: bytes.len(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(key: &[u8; ML_KEM_ENCAPSULATION_KEY_BYTES]) -> Vec<u8> {
        build_session_request_transcript(
            b"signed.session.token",
            "session-from-server",
            "browser-node",
            "daemon-node",
            &[0x33; SESSION_NONCE_BYTES],
            key,
        )
        .unwrap()
    }

    #[test]
    fn the_separately_supplied_second_flight_must_equal_the_signed_field() {
        let seed = [0x11; ML_KEM_KEYGEN_SEED_BYTES];
        let client = SessionClientBootstrap::new(seed);
        let request = build_session_request_transcript(
            b"token",
            "session",
            "browser",
            "daemon",
            &[0x22; SESSION_NONCE_BYTES],
            client.encapsulation_key(),
        )
        .unwrap();
        let msg2 = [0x33; 96];
        let response = build_session_response_transcript(
            &request,
            &[0x44; 64],
            &[0x55; SESSION_NONCE_BYTES],
            &[0x66; ML_KEM_CIPHERTEXT_BYTES],
            1,
            &msg2,
        )
        .unwrap();
        assert!(validate_session_response_msg2(&response, &msg2).is_ok());
        assert!(validate_session_response_msg2(&response, &[0x34; 96]).is_err());
        assert!(validate_session_response_msg2(&response, &msg2[..95]).is_err());
        assert!(validate_session_response_msg2(&response[..response.len() - 1], &msg2).is_err());
        assert!(validate_session_response_msg2(&response, &[]).is_err());
    }

    #[test]
    fn generic_ml_dsa87_verifier_binds_context_message_and_lengths() {
        let mut seed = [0x5a; DAEMON_IDENTITY_SEED_BYTES];
        let key = DaemonIdentitySigningKey::from_seed(&mut seed).unwrap();
        let context = b"merkur-browser-delegation";
        let signature = key
            .sign_with_context(context, b"payload", [0x21; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES])
            .unwrap();
        verify_ml_dsa87(key.public_key(), context, b"payload", &signature).unwrap();
        assert_eq!(
            verify_ml_dsa87(key.public_key(), b"merkur-session-delegation", b"payload", &signature),
            Err(SessionCryptoError::InvalidMlDsaSignature)
        );
        assert_eq!(
            verify_ml_dsa87(key.public_key(), context, b"payloaD", &signature),
            Err(SessionCryptoError::InvalidMlDsaSignature)
        );
        let mut flipped = signature;
        flipped[100] ^= 1;
        assert_eq!(
            verify_ml_dsa87(key.public_key(), context, b"payload", &flipped),
            Err(SessionCryptoError::InvalidMlDsaSignature)
        );
        assert!(matches!(
            verify_ml_dsa87(key.public_key(), context, b"payload", &signature[1..]),
            Err(SessionCryptoError::InvalidLength { .. })
        ));
        assert!(matches!(
            verify_ml_dsa87(&key.public_key()[1..], context, b"payload", &signature),
            Err(SessionCryptoError::InvalidLength { .. })
        ));
    }

    #[test]
    fn deterministic_ml_kem_and_signed_combiner_agree() {
        let client = SessionClientBootstrap::new([0x11; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(client.encapsulation_key());
        let server = SessionServerEncapsulation::new(
            client.encapsulation_key(),
            [0x44; ML_KEM_ENCAPS_RANDOM_BYTES],
        )
        .unwrap();
        let response_tbs = build_session_response_transcript(
            &request_tbs,
            &[0x22; SESSION_COMMITMENT_BYTES],
            &[0x55; SESSION_NONCE_BYTES],
            server.ciphertext(),
            17,
            &[0x96; 96],
        )
        .unwrap();

        let mut identity_seed = [0x66; DAEMON_IDENTITY_SEED_BYTES];
        let p256 = crate::SoftwareP256SigningKey::from_seed(&identity_seed).unwrap();
        let identity = DaemonIdentitySigningKey::from_seed(&mut identity_seed).unwrap();
        assert_eq!(identity_seed, [0; DAEMON_IDENTITY_SEED_BYTES]);
        let signature = identity
            .sign_response(&response_tbs, [0x77; DAEMON_IDENTITY_SIGNING_RANDOM_BYTES])
            .unwrap();
        let p256_sig = p256
            .sign_digest(&crate::daemon_p256_digest(
                DAEMON_IDENTITY_SIGNATURE_CONTEXT,
                &response_tbs,
            ))
            .unwrap();
        verify_daemon_identity_signature(
            identity.public_key(),
            &p256.public_key(),
            &response_tbs,
            &signature,
            &p256_sig,
        )
        .unwrap();

        let client_secrets = client
            .complete(
                server.ciphertext(),
                identity.public_key(),
                &p256.public_key(),
                &signature,
                &p256_sig,
                &response_tbs,
            )
            .unwrap();
        let server_secrets = server.complete(&signature, &response_tbs).unwrap();

        assert_eq!(client_secrets.as_bytes(), server_secrets.as_bytes());
        assert_ne!(
            client_secrets.noise_psk(),
            &client_secrets.as_bytes()[32..64]
        );
        assert!(client_secrets.as_bytes().iter().any(|byte| *byte != 0));
    }

    #[test]
    fn capability_commitments_match_exact_server_preimages() {
        let public_key = [0xa5; DAEMON_IDENTITY_PUBLIC_KEY_BYTES];
        let p256_public_key = crate::SoftwareP256SigningKey::from_seed(&[5; 32])
            .unwrap()
            .public_key();
        let nonce = [0x3c; SESSION_NONCE_BYTES];
        let ek = [0x72; ML_KEM_ENCAPSULATION_KEY_BYTES];

        let expected_k: [u8; 64] = Sha512::new()
            .chain_update(b"merkur-daemon-identity-key\0")
            .chain_update(public_key)
            .chain_update(p256_public_key)
            .finalize()
            .into();
        let expected_q: [u8; 64] = Sha512::new()
            .chain_update(b"merkur-session-request\0")
            .chain_update(nonce)
            .chain_update(ek)
            .finalize()
            .into();
        assert_eq!(
            compute_daemon_identity_key_hash(&public_key, &p256_public_key).unwrap(),
            expected_k
        );
        assert_eq!(
            compute_session_request_commitment(&nonce, &ek).unwrap(),
            expected_q
        );
    }

    #[test]
    fn transcript_is_canonical_and_binds_every_field() {
        let client = SessionClientBootstrap::new([7; ML_KEM_KEYGEN_SEED_BYTES]);
        let base = request(client.encapsulation_key());
        assert!(has_domain(&base, REQUEST_DOMAIN));
        assert_eq!(base, request(client.encapsulation_key()));
        let other_nonce = build_session_request_transcript(
            b"signed.session.token",
            "session-from-server",
            "browser-node",
            "daemon-node",
            &[0x34; SESSION_NONCE_BYTES],
            client.encapsulation_key(),
        )
        .unwrap();
        assert_ne!(base, other_nonce);
    }

    #[test]
    fn delegation_proof_and_authorization_digest_match_exact_preimages() {
        let client = SessionClientBootstrap::new([7; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(client.encapsulation_key());
        let certificate = br#"{"userId":"user-1","signature":"AA"}"#;
        let signature = [0x5a; DAEMON_IDENTITY_SIGNATURE_BYTES];
        let certificate_digest: [u8; 64] = Sha512::digest(certificate).into();
        let mut expected_proof = Vec::new();
        expected_proof.extend_from_slice(b"merkur-session-delegation-proof\0");
        expected_proof.extend_from_slice(&(request_tbs.len() as u64).to_be_bytes());
        expected_proof.extend_from_slice(&request_tbs);
        expected_proof.extend_from_slice(&certificate_digest);
        let proof = build_session_delegation_proof_transcript(&request_tbs, certificate).unwrap();
        assert_eq!(proof, expected_proof);

        let signature_digest: [u8; 64] = Sha512::digest(signature).into();
        let expected_authorization: [u8; 64] = Sha512::new()
            .chain_update(b"merkur-session-delegation-authorization\0")
            .chain_update((proof.len() as u64).to_be_bytes())
            .chain_update(&proof)
            .chain_update(signature_digest)
            .finalize()
            .into();
        assert_eq!(
            compute_session_delegation_authorization_digest(&proof, &signature).unwrap(),
            expected_authorization
        );
    }

    #[test]
    fn signature_rejects_transcript_context_and_identity_tampering() {
        let client = SessionClientBootstrap::new([9; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(client.encapsulation_key());
        let server = SessionServerEncapsulation::new(client.encapsulation_key(), [8; 32]).unwrap();
        let response_tbs = build_session_response_transcript(
            &request_tbs,
            &[3; SESSION_COMMITMENT_BYTES],
            &[4; SESSION_NONCE_BYTES],
            server.ciphertext(),
            5,
            &[0x96; 96],
        )
        .unwrap();
        let mut seed = [1; DAEMON_IDENTITY_SEED_BYTES];
        let p256 = crate::SoftwareP256SigningKey::from_seed(&seed).unwrap();
        let identity = DaemonIdentitySigningKey::from_seed(&mut seed).unwrap();
        let signature = identity.sign_response(&response_tbs, [2; 32]).unwrap();
        let p256_sig = p256
            .sign_digest(&crate::daemon_p256_digest(
                DAEMON_IDENTITY_SIGNATURE_CONTEXT,
                &response_tbs,
            ))
            .unwrap();

        let mut tampered_transcript = response_tbs.clone();
        *tampered_transcript.last_mut().unwrap() ^= 1;
        assert_eq!(
            verify_daemon_identity_signature(
                identity.public_key(),
                &p256.public_key(),
                &tampered_transcript,
                &signature,
                &p256_sig
            ),
            Err(SessionCryptoError::InvalidDaemonIdentitySignature)
        );

        let mut other_seed = [3; DAEMON_IDENTITY_SEED_BYTES];
        let other = DaemonIdentitySigningKey::from_seed(&mut other_seed).unwrap();
        assert_eq!(
            verify_daemon_identity_signature(
                other.public_key(),
                &p256.public_key(),
                &response_tbs,
                &signature,
                &p256_sig
            ),
            Err(SessionCryptoError::InvalidDaemonIdentitySignature)
        );

        let pk = MLDSA87VerificationKey::new(*identity.public_key());
        let sig = MLDSA87Signature::new(signature);
        assert!(ml_dsa_87::verify(&pk, &response_tbs, b"wrong-context", &sig).is_err());
    }

    #[test]
    fn response_fields_and_signature_change_kdf() {
        let client = SessionClientBootstrap::new([9; ML_KEM_KEYGEN_SEED_BYTES]);
        let request_tbs = request(client.encapsulation_key());
        let server = SessionServerEncapsulation::new(client.encapsulation_key(), [8; 32]).unwrap();
        let base = build_session_response_transcript(
            &request_tbs,
            &[7; SESSION_COMMITMENT_BYTES],
            &[4; SESSION_NONCE_BYTES],
            server.ciphertext(),
            5,
            &[0x96; 96],
        )
        .unwrap();
        let changed = build_session_response_transcript(
            &request_tbs,
            &[8; SESSION_COMMITMENT_BYTES],
            &[5; SESSION_NONCE_BYTES],
            server.ciphertext(),
            6,
            &[0x96; 96],
        )
        .unwrap();
        let base_sig = [1; DAEMON_IDENTITY_SIGNATURE_BYTES];
        let changed_sig = [2; DAEMON_IDENTITY_SIGNATURE_BYTES];
        let base_kdf = derive_session_secrets(&[3; 32], &base_sig, &base).unwrap();
        assert_ne!(
            base_kdf.as_bytes(),
            derive_session_secrets(&[3; 32], &base_sig, &changed)
                .unwrap()
                .as_bytes()
        );
        assert_ne!(
            base_kdf.as_bytes(),
            derive_session_secrets(&[3; 32], &changed_sig, &base)
                .unwrap()
                .as_bytes()
        );
    }

    #[test]
    fn rejects_wrong_lengths_and_noncanonical_public_key() {
        let mut short_seed = [0; 63];
        assert!(matches!(
            SessionClientBootstrap::from_seed(&mut short_seed),
            Err(SessionCryptoError::InvalidLength {
                field: "keygen_seed",
                ..
            })
        ));
        assert_eq!(short_seed, [0; 63]);
        assert!(matches!(
            SessionServerEncapsulation::new(&[0xff; ML_KEM_ENCAPSULATION_KEY_BYTES], [1; 32]),
            Err(SessionCryptoError::InvalidEncapsulationKey)
        ));
        assert!(matches!(
            derive_session_secrets(&[0; 31], &[0; DAEMON_IDENTITY_SIGNATURE_BYTES], b"t"),
            Err(SessionCryptoError::InvalidLength {
                field: "ml_kem_shared_secret",
                ..
            })
        ));
        assert!(matches!(
            compute_daemon_identity_key_hash(&[0; DAEMON_IDENTITY_PUBLIC_KEY_BYTES - 1], &[0; 65]),
            Err(SessionCryptoError::InvalidLength {
                field: "daemon_identity_public_key",
                ..
            })
        ));
    }
}

#[cfg(test)]
mod refactor_equivalence {
    use super::*;

    /// The explicit extract/`from_prk` split must not change any derived byte
    /// against the `Hkdf::new` form it replaced. The genesis PSK and upgrade
    /// secret are wire-visible through live sessions, so this is a hard cutover
    /// only for the newly appended third output.
    #[test]
    fn explicit_extract_matches_hkdf_new() {
        let salt = [0x5au8; 64];
        let ikm = [0x3cu8; ML_KEM_SHARED_SECRET_BYTES];

        let reference = Hkdf::<Sha512>::new(Some(&salt), &ikm);
        let mut expected_psk = [0u8; SESSION_SECRET_BYTES];
        let mut expected_upgrade = [0u8; SESSION_SECRET_BYTES];
        reference.expand(NOISE_PSK_INFO, &mut expected_psk).unwrap();
        reference
            .expand(DIRECT_UPGRADE_INFO, &mut expected_upgrade)
            .unwrap();

        let secrets = expand_session_secrets(&salt, &ikm).unwrap();
        assert_eq!(secrets.noise_psk(), &expected_psk);
        assert_eq!(&secrets.as_bytes()[32..64], &expected_upgrade);

        let mut expected_rebind = [0u8; SESSION_REBIND_SECRET_BYTES];
        reference
            .expand(REBIND_SECRET_INFO, &mut expected_rebind)
            .unwrap();
        assert_eq!(&secrets.as_bytes()[64..], &expected_rebind);
        assert_ne!(&secrets.as_bytes()[64..96], secrets.noise_psk());
    }
}
