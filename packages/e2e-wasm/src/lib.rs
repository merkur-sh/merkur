//! Browser binding for Merkur's E2E Noise transport.
//!
//! The browser is always the Noise INITIATOR; the daemon is the responder. Both
//! now run the same `merkur-e2e` code, so the two sides cannot drift and the
//! committed interop vectors describe the wire format rather than reconciling
//! two implementations.
//!
//! # Boundary design
//!
//! Terminal frames cross this boundary on every keystroke and every display
//! update, so the binding never allocates per frame. Each session owns two
//! buffers in WebAssembly linear memory:
//!
//!   1. JavaScript writes the payload into `input_ptr()`.
//!   2. It calls `seal`/`open`, which works straight out of that buffer and
//!      writes the result to `output_ptr()`.
//!   3. It reads the result back as a view over the same memory.
//!
//! One boundary crossing per frame, no `Vec` returned across it, and no
//! wasm-bindgen scratch allocation. Growing a buffer moves it and can detach
//! every JavaScript view of linear memory, so `reserve` reports the new
//! capacity and callers must re-read both pointers afterwards.

use merkur_e2e::{
    FRAME_OVERHEAD, ML_KEM_CIPHERTEXT_BYTES, ML_KEM_ENCAPSULATION_KEY_BYTES, NoiseHandshake,
    NoiseTransport, RebindClientBootstrap as CoreRebindClientBootstrap, SESSION_COMMITMENT_BYTES,
    SESSION_NONCE_BYTES, SESSION_SECRET_BYTES,
    SessionClientBootstrap as CoreSessionClientBootstrap,
    build_session_delegation_proof_transcript as core_build_delegation_proof_transcript,
    build_session_request_transcript as core_build_request_transcript,
    build_session_response_transcript as core_build_response_transcript,
    compute_daemon_identity_key_hash as core_compute_identity_key_hash,
    compute_session_delegation_authorization_digest as core_compute_delegation_authorization_digest,
    compute_session_request_commitment as core_compute_request_commitment,
    derive_prologue as core_derive_prologue, generate_static_keypair as core_generate_keypair,
    hash_session_response_transcript as core_hash_response_transcript,
    lane_for_channel as core_lane_for_channel,
};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

mod authorization;
mod client_admission;
mod client_session;
mod content;
pub use authorization::{MlDsa87SigningKey, hmac_sha512, ml_dsa87_verify, sha256, sha512};
pub use content::{E2eContentReceiver, E2eContentSender};

/// Matches the edge's `MAX_RELIABLE_FRAME` ceiling. Frame lengths reaching
/// `open` come from the network, so the buffer a peer can force this session to
/// allocate is bounded here rather than by whatever length it claims.
const MAX_FRAME_BYTES: usize = merkur_e2e::MAX_TRANSPORT_FRAME_BYTES;

/// `open` returns the plaintext length, or this sentinel when the frame was
/// dropped. A drop is the EXPECTED outcome for a duplicate delivered over a
/// second transport, so it is an ordinary return value and not an exception.
const FRAME_DROPPED: i32 = -1;

/// `seal` returns the framed length, or this sentinel when it could not seal:
/// a lane out of range, a length past the reserved capacity, or an exhausted
/// counter. Unlike a dropped frame this IS an error on the browser side, and
/// the caller raises it there; it is a plain integer rather than a `Result`
/// because `seal` runs once per keystroke and once per display ACK, and
/// wasm-bindgen materializes a `Result` as a three-element JavaScript array on
/// every call — two heap cells per keystroke for a branch that is never taken.
const SEAL_FAILED: i32 = -1;

#[wasm_bindgen]
pub struct E2eTransport {
    transport: NoiseTransport,
    requests: Option<Box<merkur_e2e::ContentRequests>>,
    input: Vec<u8>,
    output: Vec<u8>,
}

/// Exact transcript signed by the browser's root-certified session delegation.
#[wasm_bindgen(js_name = buildSessionDelegationProofTranscript)]
pub fn build_session_delegation_proof_transcript(
    request_transcript: &[u8],
    canonical_certificate_json: &[u8],
) -> Result<Vec<u8>, JsError> {
    core_build_delegation_proof_transcript(request_transcript, canonical_certificate_json)
        .map_err(|error| JsError::new(&error.to_string()))
}

/// Computes the delegation authorization digest bound into response signing and KDF.
#[wasm_bindgen(js_name = computeSessionDelegationAuthorizationDigest)]
pub fn compute_session_delegation_authorization_digest(
    proof_transcript: &[u8],
    delegate_signature: &[u8],
) -> Result<Vec<u8>, JsError> {
    core_compute_delegation_authorization_digest(proof_transcript, delegate_signature)
        .map(|digest| digest.to_vec())
        .map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
impl E2eTransport {
    /// Byte offset of the buffer JavaScript writes into. Invalidated by
    /// `reserve`, and by any linear-memory growth.
    #[wasm_bindgen(getter)]
    pub fn input_ptr(&self) -> *const u8 {
        self.input.as_ptr()
    }

    /// Byte offset of the buffer results are written to.
    #[wasm_bindgen(getter)]
    pub fn output_ptr(&self) -> *const u8 {
        self.output.as_ptr()
    }

    /// Largest plaintext this session can currently seal without reserving.
    #[wasm_bindgen(getter)]
    pub fn capacity(&self) -> usize {
        self.input.len().saturating_sub(FRAME_OVERHEAD)
    }

    /// Grows both buffers to hold `plaintext_bytes` plus framing. Callers must
    /// re-read `input_ptr` and `output_ptr` after this returns.
    pub fn reserve(&mut self, plaintext_bytes: usize) -> Result<(), JsError> {
        if plaintext_bytes > MAX_FRAME_BYTES {
            return Err(JsError::new("e2e frame exceeds the maximum frame size"));
        }
        let required = plaintext_bytes + FRAME_OVERHEAD;
        if self.input.len() < required {
            self.input.resize(required, 0);
            self.output.resize(required, 0);
        }
        Ok(())
    }

    /// Seals `len` plaintext bytes previously written at `input_ptr`, writing
    /// `counter || ciphertext` to `output_ptr`. Returns the framed length, or
    /// `SEAL_FAILED`; see that constant for why it is not a `Result`.
    pub fn seal(&mut self, channel_lane: usize, datagram: bool, len: usize) -> i32 {
        if channel_lane >= merkur_e2e::LANE_COUNT || len > self.capacity() {
            return SEAL_FAILED;
        }
        match self
            .transport
            .seal_into(channel_lane, datagram, &self.input[..len], &mut self.output)
        {
            Ok(framed) => i32::try_from(framed).unwrap_or(SEAL_FAILED),
            Err(_) => SEAL_FAILED,
        }
    }

    /// Opens `len` framed bytes previously written at `input_ptr`, writing the
    /// plaintext to `output_ptr`. Returns the plaintext length, or
    /// `FRAME_DROPPED` for a replay, a reorder duplicate, or an auth failure —
    /// the caller drops the frame and keeps the lane running.
    pub fn open(&mut self, channel_lane: usize, datagram: bool, len: usize) -> i32 {
        if channel_lane >= merkur_e2e::LANE_COUNT || len > self.input.len() {
            return FRAME_DROPPED;
        }
        // `open_into` needs `framed.len() - 8` bytes of room; `output` is sized
        // alongside `input`, so it always has at least that much.
        let (framed, out) = (&self.input[..len], &mut self.output);
        match self
            .transport
            .open_into(channel_lane, datagram, framed, out)
        {
            Ok(plaintext_len) => i32::try_from(plaintext_len).unwrap_or(FRAME_DROPPED),
            Err(_) => FRAME_DROPPED,
        }
    }
}

impl Drop for E2eTransport {
    fn drop(&mut self) {
        // JavaScript's cached views are detached whenever any allocation grows
        // the shared Wasm memory, including while a successor Noise generation
        // is being built. Wipe through the authoritative Rust Vecs so disposal
        // is both infallible across memory growth and guaranteed not to leave
        // the latest plaintext/ciphertext in the allocator's free list.
        self.input.zeroize();
        self.output.zeroize();
    }
}

/// The browser's `XXpsk3` initiator between writing message 1 and learning the
/// PSK.
///
/// Message 1 now rides the request flight, so the initiator must exist before
/// the ML-KEM exchange has produced the PSK. This type has no read method: the
/// only way out is `installPskAndReadMsg2`, which consumes it. That is what
/// keeps Merkur's ordering rule — verify the daemon's response proof BEFORE
/// touching message 2, because the daemon is authenticated by that proof and
/// not by Noise — a structural property rather than a review note.
#[wasm_bindgen]
pub struct E2ePendingHandshake {
    inner: Option<merkur_e2e::PendingNoiseInitiator>,
}

#[wasm_bindgen]
impl E2ePendingHandshake {
    /// Build the initiator and write message 1 together, so a caller cannot
    /// hold one that has not yet spoken.
    #[wasm_bindgen(js_name = start)]
    pub fn start(static_private: &[u8], prologue: &[u8]) -> Result<E2ePendingStart, JsError> {
        let (pending, msg1) = merkur_e2e::PendingNoiseInitiator::start(static_private, prologue)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(E2ePendingStart {
            handshake: E2ePendingHandshake {
                inner: Some(pending),
            },
            msg1,
        })
    }
}

/// A pending handshake and the message 1 it just wrote.
#[wasm_bindgen]
pub struct E2ePendingStart {
    handshake: E2ePendingHandshake,
    msg1: Vec<u8>,
}

#[wasm_bindgen]
impl E2ePendingStart {
    #[wasm_bindgen(getter)]
    pub fn msg1(&self) -> Vec<u8> {
        self.msg1.clone()
    }

    /// Take the handshake out; the wrapper is spent.
    #[wasm_bindgen(js_name = takeHandshake)]
    pub fn take_handshake(&mut self) -> E2ePendingHandshake {
        E2ePendingHandshake {
            inner: self.handshake.inner.take(),
        }
    }
}

/// The exact second flight and its responder state, with no PSK installed yet.
#[wasm_bindgen]
pub struct E2eResponderStart {
    inner: Option<merkur_e2e::AwaitingNoisePsk>,
    msg2: Vec<u8>,
}

#[wasm_bindgen]
impl E2eResponderStart {
    pub fn start(static_private: &[u8], prologue: &[u8], msg1: &[u8]) -> Result<Self, JsError> {
        let (pending, msg2) =
            merkur_e2e::PendingNoiseResponder::start(static_private, prologue, msg1)
                .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self {
            inner: Some(pending),
            msg2,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn msg2(&self) -> Vec<u8> {
        self.msg2.clone()
    }

    #[wasm_bindgen(js_name = installPsk)]
    pub fn install_psk(&mut self, psk: &[u8]) -> Result<E2eHandshake, JsError> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| JsError::new("responder already consumed"))?
            .install_psk(psk)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(E2eHandshake { inner: Some(inner) })
    }
}

#[wasm_bindgen]
pub struct E2eHandshake {
    inner: Option<NoiseHandshake>,
}

#[wasm_bindgen]
impl E2eHandshake {
    /// The browser side of `Noise_XXpsk3_25519_ChaChaPoly_SHA512`. The daemon
    /// constructs the responder from the same crate.
    #[wasm_bindgen(constructor)]
    pub fn new(
        static_private: &[u8],
        psk: &[u8],
        prologue: &[u8],
    ) -> Result<E2eHandshake, JsError> {
        let inner = NoiseHandshake::new_initiator(static_private, psk, prologue)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self { inner: Some(inner) })
    }

    /// Responder role. Production browsers never take it — the daemon is always
    /// the responder — but the wire-conformance check has to drive both halves
    /// of a handshake from one process to prove this module and the daemon agree
    /// byte for byte.
    #[wasm_bindgen(js_name = newResponder)]
    pub fn new_responder(
        static_private: &[u8],
        psk: &[u8],
        prologue: &[u8],
    ) -> Result<E2eHandshake, JsError> {
        let inner = NoiseHandshake::new_responder(static_private, psk, prologue)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Self { inner: Some(inner) })
    }

    pub fn write_message(&mut self) -> Result<Vec<u8>, JsError> {
        self.handshake_mut()?
            .write_message(&[])
            .map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn read_message(&mut self, message: &[u8]) -> Result<(), JsError> {
        self.handshake_mut()?
            .read_message(message)
            .map(|_payload| ())
            .map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn is_complete(&self) -> bool {
        self.inner
            .as_ref()
            .map(NoiseHandshake::is_complete)
            .unwrap_or(false)
    }

    pub fn remote_static(&self) -> Option<Vec<u8>> {
        self.inner.as_ref().and_then(NoiseHandshake::remote_static)
    }

    /// Consumes the handshake and returns the transport. `wasm_bindgen` cannot
    /// take `self` by value here, so the handshake is taken out of its slot;
    /// calling any method afterwards is a hard error rather than a silent
    /// second transport with a duplicate nonce schedule.
    pub fn into_transport(&mut self, initial_capacity: usize) -> Result<E2eTransport, JsError> {
        let handshake = self
            .inner
            .take()
            .ok_or_else(|| JsError::new("e2e handshake already consumed"))?;
        let transport = handshake
            .into_transport()
            .map_err(|error| JsError::new(&error.to_string()))?;
        let capacity = initial_capacity.min(MAX_FRAME_BYTES) + FRAME_OVERHEAD;
        Ok(E2eTransport {
            transport,
            requests: None,
            input: vec![0u8; capacity],
            output: vec![0u8; capacity],
        })
    }

    fn handshake_mut(&mut self) -> Result<&mut NoiseHandshake, JsError> {
        self.inner
            .as_mut()
            .ok_or_else(|| JsError::new("e2e handshake already consumed"))
    }
}

/// One-shot browser ML-KEM-1024 bootstrap. The 3,168-byte decapsulation key is
/// held only inside Wasm and zeroized when this object is completed or dropped.
#[wasm_bindgen]
pub struct SessionClientBootstrap {
    inner: Option<CoreSessionClientBootstrap>,
}

#[wasm_bindgen]
impl SessionClientBootstrap {
    /// Generates ML-KEM-1024 from exactly 64 caller-provided random bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(keygen_seed: &mut [u8]) -> Result<SessionClientBootstrap, JsError> {
        let inner = CoreSessionClientBootstrap::from_seed(keygen_seed)
            .map_err(|error| JsError::new(&error.to_string()));
        keygen_seed.fill(0);
        let inner = inner?;
        Ok(Self { inner: Some(inner) })
    }

    /// The 1,568-byte FIPS 203 encapsulation/public key sent in the authenticated
    /// request. This returns a copy; no secret key bytes cross the boundary.
    #[wasm_bindgen(getter, js_name = encapsulationKey)]
    pub fn encapsulation_key(&self) -> Result<Vec<u8>, JsError> {
        self.inner
            .as_ref()
            .map(|inner| inner.encapsulation_key().to_vec())
            .ok_or_else(|| JsError::new("session bootstrap already consumed"))
    }

    /// Authenticated completion. The static daemon ML-DSA-87 signature is
    /// verified before ML-KEM decapsulation. Returns
    /// `noise_psk[32] || direct_upgrade_secret[32]` and consumes the bootstrap
    /// on every success or failure path.
    ///
    /// The third combiner output, the carrier-rebind chaining secret, is
    /// deliberately **not** returned. It is the only session secret that
    /// outlives a carrier, so it is moved into a [`RebindKeeper`] that never
    /// hands it back across this boundary — see that type for the limits of
    /// that protection.
    pub fn complete(
        &mut self,
        ciphertext: &[u8],
        daemon_identity_public_key: &[u8],
        daemon_identity_p256_public_key: &[u8],
        daemon_signature: &[u8],
        p256_signature: &[u8],
        response_transcript: &[u8],
        pending: &mut E2ePendingHandshake,
        noise_msg2: &[u8],
    ) -> Result<SessionBootstrapOutput, JsError> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| JsError::new("session bootstrap already consumed"))?;
        merkur_e2e::validate_session_response_msg2(response_transcript, noise_msg2)
            .map_err(js_error)?;
        let secrets = inner
            .complete(
                ciphertext,
                daemon_identity_public_key,
                daemon_identity_p256_public_key,
                daemon_signature,
                p256_signature,
                response_transcript,
            )
            .map_err(|error| JsError::new(&error.to_string()))?;
        let noise = pending
            .inner
            .take()
            .ok_or_else(|| JsError::new("pending handshake already consumed"))?
            .read_authenticated_msg2(noise_msg2)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let secrets = secrets
            .bind_noise(noise.checkpoint(), response_transcript)
            .map_err(js_error)?;
        let mut handshake = noise
            .install_psk(secrets.noise_psk())
            .map_err(|error| JsError::new(&error.to_string()))?;
        let msg3 = handshake
            .write_message(&[])
            .map_err(|error| JsError::new(&error.to_string()))?;
        let keeper =
            merkur_e2e::RebindKeeper::from_session(secrets.rebind_secret(), response_transcript)
                .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(SessionBootstrapOutput {
            handshake: E2eHandshake {
                inner: Some(handshake),
            },
            msg3,
            transport_secrets: secrets.as_bytes()[..2 * SESSION_SECRET_BYTES].to_vec(),
            rebind: RebindKeeper {
                inner: Some(keeper),
            },
        })
    }
}

/// What `SessionClientBootstrap::complete` hands back: the two secrets
/// JavaScript needs, and the rebind chaining state it must not see.
#[wasm_bindgen]
pub struct SessionBootstrapOutput {
    handshake: E2eHandshake,
    msg3: Vec<u8>,
    transport_secrets: Vec<u8>,
    rebind: RebindKeeper,
}

#[wasm_bindgen]
impl SessionBootstrapOutput {
    #[wasm_bindgen(getter)]
    pub fn msg3(&self) -> Vec<u8> {
        self.msg3.clone()
    }

    #[wasm_bindgen(js_name = takeHandshake)]
    pub fn take_handshake(&mut self) -> E2eHandshake {
        E2eHandshake {
            inner: self.handshake.inner.take(),
        }
    }

    /// `noise_psk[32] || direct_upgrade_secret[32]`.
    #[wasm_bindgen(getter, js_name = transportSecrets)]
    pub fn transport_secrets(&self) -> Vec<u8> {
        self.transport_secrets.clone()
    }

    /// Moves the rebind chaining state out. Consumes this object's copy.
    #[wasm_bindgen(js_name = takeRebindKeeper)]
    pub fn take_rebind_keeper(&mut self) -> RebindKeeper {
        RebindKeeper {
            inner: self.rebind.inner.take(),
        }
    }
}

impl Drop for SessionBootstrapOutput {
    fn drop(&mut self) {
        self.transport_secrets.fill(0);
    }
}

/// Owner of the carrier-rebind chaining secret: `merkur_e2e::RebindKeeper`,
/// the same chain the native client advances.
///
/// The secret never crosses back into JavaScript. WebAssembly linear memory is
/// readable from JavaScript through `WebAssembly.Memory.buffer`, so this is
/// defence against *accidental* exposure — a devtools inspection, an error
/// serialization, a structured clone into `postMessage` — and not against
/// same-origin script compromise, which the security model already scopes out.
/// Keep it worker-local, never post it, and never persist it.
#[wasm_bindgen]
pub struct RebindKeeper {
    inner: Option<merkur_e2e::RebindKeeper>,
}

impl RebindKeeper {
    fn keeper(&self) -> Result<&merkur_e2e::RebindKeeper, JsError> {
        self.inner
            .as_ref()
            .ok_or_else(|| JsError::new("rebind keeper already taken"))
    }

    fn keeper_mut(&mut self) -> Result<&mut merkur_e2e::RebindKeeper, JsError> {
        self.inner
            .as_mut()
            .ok_or_else(|| JsError::new("rebind keeper already taken"))
    }
}

fn js_error(error: merkur_e2e::SessionCryptoError) -> JsError {
    JsError::new(&error.to_string())
}

#[wasm_bindgen]
impl RebindKeeper {
    #[wasm_bindgen(getter, js_name = hasPending)]
    pub fn has_pending(&self) -> bool {
        self.inner
            .as_ref()
            .is_some_and(|keeper| keeper.has_pending())
    }

    #[wasm_bindgen(getter, js_name = pendingAttemptDigest)]
    pub fn pending_attempt_digest(&self) -> Result<Vec<u8>, JsError> {
        self.keeper()?
            .pending_attempt_digest()
            .map(|digest| digest.to_vec())
            .ok_or_else(|| JsError::new("no uncertain rebind"))
    }

    #[wasm_bindgen(js_name = reconciliationTranscript)]
    pub fn reconciliation_transcript(
        &self,
        session: &str,
        browser: &str,
        daemon: &str,
        nonce: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let keeper = self.keeper()?;
        if !keeper.has_pending() {
            return Err(JsError::new("no uncertain rebind"));
        }
        keeper
            .reconciliation_transcript(
                session,
                browser,
                daemon,
                exact_array_ref::<32>("nonce", nonce)?,
            )
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = reconciliationMac)]
    pub fn reconciliation_mac(&self, request: &[u8], successor: bool) -> Result<Vec<u8>, JsError> {
        let keeper = self.keeper()?;
        if successor && !keeper.has_pending() {
            return Err(JsError::new("no uncertain rebind"));
        }
        keeper
            .reconciliation_mac(request, successor)
            .map(|mac| mac.to_vec())
            .map_err(js_error)
    }

    /// The current-generation answer cancels exactly the uncertain responder;
    /// the successor-generation answer proves the daemon already committed it.
    pub fn reconcile(&mut self, request: &[u8], counter: u64, mac: &[u8]) -> bool {
        self.inner
            .as_mut()
            .is_some_and(|keeper| keeper.reconcile(request, counter, mac))
    }

    #[wasm_bindgen(js_name = finalMac)]
    pub fn final_mac(&self, message: &[u8]) -> Result<Vec<u8>, JsError> {
        let keeper = self.keeper()?;
        if !keeper.has_pending() {
            return Err(JsError::new("no uncertain rebind"));
        }
        keeper
            .final_mac(message)
            .map(|mac| mac.to_vec())
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = renewalIntent)]
    pub fn renewal_intent(
        &self,
        session_id: &str,
        browser_node_id: &str,
        daemon_id: &str,
        nonce: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let nonce = exact_array_ref::<SESSION_NONCE_BYTES>("nonce", nonce)?;
        self.keeper()?
            .renewal_intent(session_id, browser_node_id, daemon_id, nonce)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = renewalCommitment)]
    pub fn renewal_commitment(&self, intent: &[u8]) -> Result<Vec<u8>, JsError> {
        merkur_e2e::compute_session_renewal_commitment(intent)
            .map(|value| value.to_vec())
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = renewalDelegationProof)]
    pub fn renewal_delegation_proof(
        &self,
        intent: &[u8],
        capability: &str,
        certificate: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        merkur_e2e::build_session_renewal_delegation_proof(intent, capability, certificate)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = renewalRequest)]
    pub fn renewal_request(&self, proof: &[u8], signature: &[u8]) -> Result<Vec<u8>, JsError> {
        self.keeper()?
            .renewal_request(proof, signature)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = renewalMac)]
    pub fn renewal_mac(&self, request: &[u8]) -> Result<Vec<u8>, JsError> {
        self.keeper()?
            .renewal_mac(request)
            .map(|mac| mac.to_vec())
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = verifyRenewal)]
    pub fn verify_renewal(
        &self,
        request: &[u8],
        expiry: u64,
        generation_base: u64,
        accepted: bool,
        mac: &[u8],
    ) -> bool {
        self.inner.as_ref().is_some_and(|keeper| {
            keeper.verify_renewal(request, expiry, generation_base, accepted, mac)
        })
    }

    /// The generation this keeper will request next.
    #[wasm_bindgen(getter)]
    pub fn counter(&self) -> u64 {
        self.inner.as_ref().map_or(0, |keeper| keeper.counter())
    }

    /// The request PREAMBLE — what the Noise prologue binds.
    ///
    /// Message 1 is NOT in here, and must not be: it cannot be written until
    /// the prologue exists. `bindRequestMsg1` produces what the MAC is taken
    /// over.
    #[wasm_bindgen(js_name = requestTranscript)]
    pub fn request_transcript(
        &self,
        session_id: &str,
        browser_node_id: &str,
        daemon_id: &str,
        client_nonce: &[u8],
        encapsulation_key: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let nonce = exact_array_ref::<SESSION_NONCE_BYTES>("client_nonce", client_nonce)?;
        let key = exact_array_ref::<ML_KEM_ENCAPSULATION_KEY_BYTES>(
            "encapsulation_key",
            encapsulation_key,
        )?;
        self.keeper()?
            .request_transcript(session_id, browser_node_id, daemon_id, nonce, key)
            .map_err(js_error)
    }

    /// `preamble || msg1` — what the flight-1 MAC and the daemon's replay digest
    /// are taken over, so a spliced message 1 fails the proof.
    #[wasm_bindgen(js_name = bindRequestMsg1)]
    pub fn bind_request_msg1(
        &self,
        request_preamble: &[u8],
        noise_msg1: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        merkur_e2e::bind_rebind_request_msg1(request_preamble, noise_msg1).map_err(js_error)
    }

    /// The possession proof over a request transcript.
    #[wasm_bindgen(js_name = requestMac)]
    pub fn request_mac(&self, request_transcript: &[u8]) -> Result<Vec<u8>, JsError> {
        self.keeper()?
            .request_mac(request_transcript)
            .map(|mac| mac.to_vec())
            .map_err(js_error)
    }

    /// Refusals authenticate only the currently retained attempt, without
    /// consuming its one-use bootstrap or mutating either generation.
    #[wasm_bindgen(js_name = verifyRefusal)]
    pub fn verify_refusal(&self, request: &[u8], reason: &str, mac: &[u8]) -> bool {
        self.inner
            .as_ref()
            .is_some_and(|keeper| keeper.verify_refusal(request, reason, mac))
    }

    /// Check the entire answer before the browser publishes a carrier or consumes
    /// its bootstrap. Spoofed and stale answers are ignored without state changes.
    #[wasm_bindgen(js_name = verifyResponse)]
    pub fn verify_response(
        &self,
        request: &[u8],
        daemon_nonce: &[u8],
        ciphertext: &[u8],
        next_expected_input_seq: u32,
        noise_msg2: &[u8],
        mac: &[u8],
    ) -> bool {
        let (Some(keeper), Ok(nonce), Ok(ciphertext)) = (
            self.inner.as_ref(),
            daemon_nonce.try_into(),
            ciphertext.try_into(),
        ) else {
            return false;
        };
        keeper.verify_response(
            request,
            nonce,
            ciphertext,
            next_expected_input_seq,
            noise_msg2,
            mac,
        )
    }

    /// Verifies the daemon's response proof, decapsulates, and derives the
    /// successor generation, held tentative until [`Self::promote`].
    #[wasm_bindgen(js_name = completeRebind)]
    pub fn complete_rebind(
        &mut self,
        bootstrap: &mut RebindClientBootstrap,
        request_transcript: &[u8],
        daemon_nonce: &[u8],
        ciphertext: &[u8],
        next_expected_input_seq: u32,
        noise_msg2: &[u8],
        response_mac: &[u8],
        pending: &mut E2ePendingHandshake,
    ) -> Result<RebindOutput, JsError> {
        let nonce = exact_array_ref::<SESSION_NONCE_BYTES>("daemon_nonce", daemon_nonce)?;
        let ciphertext = exact_array_ref::<ML_KEM_CIPHERTEXT_BYTES>("ciphertext", ciphertext)?;
        if bootstrap.inner.is_none() {
            return Err(JsError::new("rebind bootstrap already consumed"));
        }
        if !self.keeper()?.verify_response(
            request_transcript,
            nonce,
            ciphertext,
            next_expected_input_seq,
            noise_msg2,
            response_mac,
        ) {
            return Err(JsError::new("invalid rebind response"));
        }
        let noise = pending
            .inner
            .take()
            .ok_or_else(|| JsError::new("pending handshake already consumed"))?
            .read_authenticated_msg2(noise_msg2)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let outcome = self
            .keeper_mut()?
            .complete_rebind(
                &mut bootstrap.inner,
                request_transcript,
                nonce,
                ciphertext,
                next_expected_input_seq,
                noise_msg2,
                response_mac,
                noise.checkpoint(),
            )
            .map_err(js_error)?;
        let mut handshake = noise
            .install_psk(&outcome.transport_secrets[..32])
            .map_err(|error| JsError::new(&error.to_string()))?;
        let msg3 = handshake
            .write_message(&[])
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(RebindOutput {
            handshake: E2eHandshake {
                inner: Some(handshake),
            },
            msg3,
            transport_secrets: outcome.transport_secrets.to_vec(),
            prologue_digest: outcome.prologue_digest.to_vec(),
        })
    }

    /// Commits the tentative successor and wipes its predecessor.
    ///
    /// Call this only on proof that the daemon committed too — the first
    /// inbound frame that opens under the successor generation.
    pub fn promote(&mut self) -> Result<(), JsError> {
        self.keeper_mut()?
            .promote()
            .map_err(|_| JsError::new("no tentative rebind generation to promote"))
    }

    /// Discards a tentative successor after a failed or timed-out rebind,
    /// keeping the current generation usable for another attempt.
    pub fn abandon(&mut self) {
        if let Some(keeper) = self.inner.as_mut() {
            keeper.abandon();
        }
    }
}

/// What a completed rebind hands back to JavaScript.
#[wasm_bindgen]
pub struct RebindOutput {
    handshake: E2eHandshake,
    msg3: Vec<u8>,
    transport_secrets: Vec<u8>,
    prologue_digest: Vec<u8>,
}

#[wasm_bindgen]
impl RebindOutput {
    #[wasm_bindgen(getter)]
    pub fn msg3(&self) -> Vec<u8> {
        self.msg3.clone()
    }

    #[wasm_bindgen(js_name = takeHandshake)]
    pub fn take_handshake(&mut self) -> E2eHandshake {
        E2eHandshake {
            inner: self.handshake.inner.take(),
        }
    }

    /// `noise_psk[32] || direct_upgrade_secret[32]` for the successor session.
    #[wasm_bindgen(getter, js_name = transportSecrets)]
    pub fn transport_secrets(&self) -> Vec<u8> {
        self.transport_secrets.clone()
    }

    /// SHA-512 of the rebind response transcript, bound into the successor
    /// Noise prologue exactly as the genesis response digest is.
    #[wasm_bindgen(getter, js_name = prologueDigest)]
    pub fn prologue_digest(&self) -> Vec<u8> {
        self.prologue_digest.clone()
    }
}

impl Drop for RebindOutput {
    fn drop(&mut self) {
        self.transport_secrets.fill(0);
    }
}

/// One-shot browser ML-KEM-1024 bootstrap for a carrier rebind.
#[wasm_bindgen]
pub struct RebindClientBootstrap {
    inner: Option<CoreRebindClientBootstrap>,
}

#[wasm_bindgen]
impl RebindClientBootstrap {
    /// Generates ML-KEM-1024 from exactly 64 caller-provided random bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(keygen_seed: &mut [u8]) -> Result<RebindClientBootstrap, JsError> {
        let inner = CoreRebindClientBootstrap::from_seed(keygen_seed)
            .map_err(|error| JsError::new(&error.to_string()));
        keygen_seed.fill(0);
        Ok(Self {
            inner: Some(inner?),
        })
    }

    /// The 1,568-byte encapsulation key sent in the rebind request.
    #[wasm_bindgen(getter, js_name = encapsulationKey)]
    pub fn encapsulation_key(&self) -> Result<Vec<u8>, JsError> {
        self.inner
            .as_ref()
            .map(|inner| inner.encapsulation_key().to_vec())
            .ok_or_else(|| JsError::new("rebind bootstrap already consumed"))
    }
}

/// X25519 static keypair for this handshake lineage, returned as
/// `private || public`. Both halves are 32 bytes; the caller splits them.
#[wasm_bindgen]
pub fn generate_static_keypair() -> Result<Vec<u8>, JsError> {
    let (private_key, public_key) =
        core_generate_keypair().map_err(|error| JsError::new(&error.to_string()))?;
    let mut pair = Vec::with_capacity(private_key.len() + public_key.len());
    pair.extend_from_slice(&private_key);
    pair.extend_from_slice(&public_key);
    Ok(pair)
}

/// Session-bound prologue. Byte-identical to the daemon's, which is what stops a
/// captured handshake from being replayed into a different session.
#[wasm_bindgen]
pub fn derive_prologue(
    session_id: &str,
    daemon_id: &str,
    response_transcript_hash: &[u8],
) -> Result<Vec<u8>, JsError> {
    let hash = exact_array_ref::<64>("response_transcript_hash", response_transcript_hash)?;
    Ok(core_derive_prologue(session_id, daemon_id, hash))
}

/// Shared, binary request TBS. `token` is the exact issued-token byte string;
/// the core binds its SHA-512 digest and never canonicalizes JSON.
#[wasm_bindgen(js_name = buildSessionRequestTranscript)]
pub fn build_session_request_transcript(
    token: &[u8],
    session_id: &str,
    browser_node_id: &str,
    daemon_id: &str,
    client_nonce: &[u8],
    encapsulation_key: &[u8],
) -> Result<Vec<u8>, JsError> {
    let nonce = exact_array_ref::<SESSION_NONCE_BYTES>("client_nonce", client_nonce)?;
    let key =
        exact_array_ref::<ML_KEM_ENCAPSULATION_KEY_BYTES>("encapsulation_key", encapsulation_key)?;
    core_build_request_transcript(token, session_id, browser_node_id, daemon_id, nonce, key)
        .map_err(|error| JsError::new(&error.to_string()))
}

/// Shared response authentication/KDF TBS.
#[wasm_bindgen(js_name = buildSessionResponseTranscript)]
pub fn build_session_response_transcript(
    request_transcript: &[u8],
    delegation_authorization_digest: &[u8],
    daemon_nonce: &[u8],
    ciphertext: &[u8],
    next_expected_input_seq: u32,
    noise_msg2: &[u8],
) -> Result<Vec<u8>, JsError> {
    let nonce = exact_array_ref::<SESSION_NONCE_BYTES>("daemon_nonce", daemon_nonce)?;
    let authorization_digest = exact_array_ref::<SESSION_COMMITMENT_BYTES>(
        "delegation_authorization_digest",
        delegation_authorization_digest,
    )?;
    let ciphertext = exact_array_ref::<ML_KEM_CIPHERTEXT_BYTES>("ciphertext", ciphertext)?;
    core_build_response_transcript(
        request_transcript,
        authorization_digest,
        nonce,
        ciphertext,
        next_expected_input_seq,
        noise_msg2,
    )
    .map_err(|error| JsError::new(&error.to_string()))
}

/// Computes capability claim `q` over the exact nonce and ML-KEM key.
#[wasm_bindgen(js_name = computeSessionRequestCommitment)]
pub fn compute_session_request_commitment(
    client_nonce: &[u8],
    encapsulation_key: &[u8],
) -> Result<Vec<u8>, JsError> {
    core_compute_request_commitment(client_nonce, encapsulation_key)
        .map(|digest| digest.to_vec())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// Computes capability claim `k` over the exact daemon identity public key.
#[wasm_bindgen(js_name = computeDaemonIdentityKeyHash)]
pub fn compute_daemon_identity_key_hash(
    public_key: &[u8],
    p256_public_key: &[u8],
) -> Result<Vec<u8>, JsError> {
    core_compute_identity_key_hash(public_key, p256_public_key)
        .map(|digest| digest.to_vec())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// SHA-512 of the rebind request PREAMBLE — what the successor Noise prologue
/// binds, so message 1 can ride flight 1.
#[wasm_bindgen(js_name = hashRebindRequestTranscript)]
pub fn hash_rebind_request_transcript(request_transcript: &[u8]) -> Result<Vec<u8>, JsError> {
    merkur_e2e::hash_rebind_request_transcript(request_transcript)
        .map(|hash| hash.to_vec())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// SHA-512 of the request PREAMBLE — what the Noise prologue binds.
///
/// The prologue moved off the response so the browser can write message 1 in
/// the same flight as its request; message 1 therefore cannot be inside what
/// this hashes, or the derivation would be circular.
#[wasm_bindgen(js_name = hashSessionRequestTranscript)]
pub fn hash_session_request_transcript(request_transcript: &[u8]) -> Result<Vec<u8>, JsError> {
    merkur_e2e::hash_session_request_transcript(request_transcript)
        .map(|hash| hash.to_vec())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// `preamble || msg1` — what the browser's delegate signature covers, because
/// message 1 rides the same flight as the signature over it.
#[wasm_bindgen(js_name = bindSessionRequestMsg1)]
pub fn bind_session_request_msg1(
    request_preamble: &[u8],
    noise_msg1: &[u8],
) -> Result<Vec<u8>, JsError> {
    merkur_e2e::bind_session_request_msg1(request_preamble, noise_msg1)
        .map_err(|error| JsError::new(&error.to_string()))
}

/// SHA-512(response TBS). Still the KDF salt; no longer the prologue.
#[wasm_bindgen(js_name = hashSessionResponseTranscript)]
pub fn hash_session_response_transcript(response_transcript: &[u8]) -> Result<Vec<u8>, JsError> {
    core_hash_response_transcript(response_transcript)
        .map(|hash| hash.to_vec())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// Wire channel id to Noise lane index, or `-1` for a channel with no lane.
#[wasm_bindgen]
pub fn lane_for_channel(channel_id: u8) -> i32 {
    core_lane_for_channel(channel_id)
        .and_then(|lane| i32::try_from(lane).ok())
        .unwrap_or(-1)
}

fn exact_array_ref<'a, const N: usize>(
    field: &str,
    value: &'a [u8],
) -> Result<&'a [u8; N], JsError> {
    value.try_into().map_err(|_| {
        JsError::new(&format!(
            "{field} has {} bytes; expected exactly {N}",
            value.len()
        ))
    })
}
