//! The three-flight hybrid authentication, client side.
//!
//! 1. [`PendingAuth::new`] draws a fresh 32-byte nonce and a one-use ML-KEM-1024
//!    key; both go into the issuance request.
//! 2. [`PendingAuth::bind`] checks that the user root authorized the daemon the
//!    server named, builds the request transcript over the capability, and
//!    writes Noise message 1 under a prologue bound to that transcript. The
//!    delegate's proof over `preamble || msg1` is the host's to sign, wherever
//!    its key lives; [`UnsignedAuth::sign`] verifies that signature and yields
//!    flight 1 (`session_auth`).
//! 3. [`BoundAuth::complete`] rebuilds the response transcript from the
//!    fields it will act on, verifies both daemon identity signatures before it
//!    decapsulates, derives the Noise PSK, the direct-upgrade key and the rebind
//!    chaining secret, and only then reads Noise message 2 and writes message 3
//!    (flight 3, `noise_final`).
//!
//! Every value a later step needs is captured once, in the step that verified
//! it; nothing is re-read from the wire.

use merkur_authorization::{
    DaemonBindingPayload, DelegationCertificate, SIGNATURE_BYTES, daemon_identity_key_commitment,
    decode_exact, encode, session_delegation_authorization_digest,
    session_delegation_proof_transcript, verify_session_delegation_proof,
};
use merkur_e2e::{
    ML_KEM_CIPHERTEXT_BYTES, ML_KEM_ENCAPSULATION_KEY_BYTES, ML_KEM_KEYGEN_SEED_BYTES,
    NoiseTransport, PendingNoiseInitiator, RebindKeeper, SESSION_NONCE_BYTES,
    SessionClientBootstrap,
};
use merkur_wire::signaling::{ClientSignal, DaemonSignal, NoiseFinal, SessionAuth};
use zeroize::Zeroizing;

use crate::Entropy;
use crate::issuance::Issuance;

const P256_PUBLIC_KEY_BYTES: usize = 65;
const DAEMON_IDENTITY_PUBLIC_KEY_BYTES: usize = merkur_e2e::DAEMON_IDENTITY_PUBLIC_KEY_BYTES;
const DAEMON_IDENTITY_SIGNATURE_BYTES: usize = merkur_e2e::DAEMON_IDENTITY_SIGNATURE_BYTES;

/// Why an authentication attempt ended. Each ends only its own attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthError {
    /// The user root did not authorize the daemon the server named.
    DaemonNotAuthorized,
    /// A field the client itself builds could not be built.
    InvalidRequest,
    /// The daemon's answer was malformed or its proof did not verify.
    DaemonAuthFailed,
    /// Noise message 2 did not complete the handshake.
    HandshakeFailed,
}

/// The account material a device authenticates with: its root-signed
/// delegation and the root public key that pins every daemon binding. The
/// delegate key that signs each session proof stays with the host, which
/// answers the session's signature requests; the core holds no secret of it.
pub struct Delegation {
    pub certificate: DelegationCertificate,
    pub root_public_key: Box<[u8; merkur_authorization::PUBLIC_KEY_BYTES]>,
    pub server_origin: String,
}

impl Delegation {
    /// Whether `signature` is the delegate's over `proof`, under the session
    /// delegation context. A host's signer is checked before anything it
    /// signed leaves.
    pub fn verifies(&self, proof: &[u8], signature: &[u8; SIGNATURE_BYTES]) -> bool {
        decode_exact::<{ merkur_authorization::PUBLIC_KEY_BYTES }>(
            &self.certificate.delegate_public_key,
            "delegate public key",
        )
        .is_ok_and(|public_key| verify_session_delegation_proof(proof, signature, &public_key))
    }
}

/// Step 1: the one-use bootstrap bound into the issuance request.
pub struct PendingAuth {
    bootstrap: SessionClientBootstrap,
    client_nonce: [u8; SESSION_NONCE_BYTES],
}

impl PendingAuth {
    pub fn new(entropy: &mut impl Entropy) -> Self {
        let mut seed = Zeroizing::new([0u8; ML_KEM_KEYGEN_SEED_BYTES]);
        entropy.fill(&mut *seed);
        Self {
            bootstrap: SessionClientBootstrap::new(*seed),
            client_nonce: entropy.array(),
        }
    }

    /// `(clientNonce, encapsulationKey)` for the issuance request.
    pub fn request_fields(&self) -> (String, String) {
        (
            encode(&self.client_nonce),
            encode(self.bootstrap.encapsulation_key()),
        )
    }

    /// Step 2: everything flight 1 carries but the delegate's signature over
    /// [`UnsignedAuth::proof`].
    pub fn bind(
        self,
        issuance: &Issuance,
        delegation: &Delegation,
        browser_node_id: &str,
    ) -> Result<UnsignedAuth, AuthError> {
        let daemon_public_key: [u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES] =
            decode_exact(&issuance.daemon_identity_public_key, "daemon identity")
                .map_err(|_| AuthError::DaemonNotAuthorized)?;
        let daemon_p256: [u8; P256_PUBLIC_KEY_BYTES] =
            decode_exact(&issuance.daemon_identity_p256_public_key, "daemon P-256")
                .map_err(|_| AuthError::DaemonNotAuthorized)?;
        let identity_commitment = daemon_identity_key_commitment(&daemon_public_key, &daemon_p256)
            .map_err(|_| AuthError::DaemonNotAuthorized)?;
        let binding = &issuance.daemon_binding;
        binding
            .verify(
                &delegation.root_public_key[..],
                &DaemonBindingPayload {
                    user_id: delegation.certificate.user_id.clone(),
                    root_key_commitment: delegation.certificate.root_key_commitment.clone(),
                    daemon_id: issuance.daemon_id.clone(),
                    daemon_identity_key_commitment: identity_commitment,
                    server_origin: delegation.server_origin.clone(),
                    link_claim_id: binding.link_claim_id.clone(),
                    issued_at: binding.issued_at,
                },
            )
            .map_err(|_| AuthError::DaemonNotAuthorized)?;

        let preamble = merkur_e2e::build_session_request_transcript(
            issuance.session_token.as_bytes(),
            &issuance.session_id,
            browser_node_id,
            &issuance.daemon_id,
            &self.client_nonce,
            self.bootstrap.encapsulation_key(),
        )
        .map_err(|_| AuthError::InvalidRequest)?;
        let preamble_hash = merkur_e2e::hash_session_request_transcript(&preamble)
            .map_err(|_| AuthError::InvalidRequest)?;
        // Message 1 is written before the request leaves, under a prologue that
        // binds the preamble: the client cannot bind an answer it has not
        // received, and that is exactly what used to cost a round trip.
        let (noise_static, _) =
            merkur_e2e::generate_static_keypair().map_err(|_| AuthError::InvalidRequest)?;
        let noise_static = Zeroizing::new(noise_static);
        let prologue =
            merkur_e2e::derive_prologue(&issuance.session_id, &issuance.daemon_id, &preamble_hash);
        let (noise, noise_msg1) = PendingNoiseInitiator::start(&noise_static, &prologue)
            .map_err(|_| AuthError::InvalidRequest)?;
        // The signature covers `preamble || msg1`: message 1 rides the flight
        // that proves it, so an on-path party cannot splice its own.
        let request = merkur_e2e::bind_session_request_msg1(&preamble, &noise_msg1)
            .map_err(|_| AuthError::InvalidRequest)?;
        let proof = session_delegation_proof_transcript(&request, &delegation.certificate)
            .map_err(|_| AuthError::InvalidRequest)?;
        let (client_nonce, encapsulation_key) = self.request_fields();
        Ok(UnsignedAuth {
            proof,
            session_token: issuance.session_token.clone(),
            session_id: issuance.session_id.clone(),
            client_nonce,
            encapsulation_key,
            noise_msg1,
            bound: BoundAuth {
                bootstrap: self.bootstrap,
                noise,
                request,
                authorization_digest: [0; 64],
                daemon_public_key: Box::new(daemon_public_key),
                daemon_p256,
            },
        })
    }
}

/// Step 2, waiting for the delegate's signature over [`Self::proof`]. Signing
/// happens wherever the host keeps the key, off the session's turn; the
/// session dials meanwhile.
pub struct UnsignedAuth {
    proof: Vec<u8>,
    session_token: String,
    session_id: String,
    client_nonce: String,
    encapsulation_key: String,
    noise_msg1: Vec<u8>,
    bound: BoundAuth,
}

impl UnsignedAuth {
    /// The exact bytes the delegate signs under the session delegation context.
    pub fn proof(&self) -> &[u8] {
        &self.proof
    }

    /// Flight 1, and the state the answer is checked against. A signature
    /// that is not the certificate's delegate's over this proof is refused,
    /// so a failing signer can never put a forged proof on the wire.
    pub fn sign(
        self,
        delegation: &Delegation,
        signature: &[u8; SIGNATURE_BYTES],
    ) -> Result<(BoundAuth, ClientSignal), AuthError> {
        if !delegation.verifies(&self.proof, signature) {
            return Err(AuthError::InvalidRequest);
        }
        let authorization_digest = session_delegation_authorization_digest(&self.proof, signature)
            .map_err(|_| AuthError::InvalidRequest)?;
        let flight = ClientSignal::SessionAuth(SessionAuth {
            session_token: self.session_token,
            session_id: self.session_id,
            client_nonce: self.client_nonce,
            encapsulation_key: self.encapsulation_key,
            delegation_certificate: Box::new(delegation.certificate.clone()),
            delegation_signature: encode(signature),
            noise_msg1: encode(&self.noise_msg1),
        });
        Ok((
            BoundAuth {
                authorization_digest,
                ..self.bound
            },
            flight,
        ))
    }
}

/// Step 3's input: the bound request and the pending handshake.
pub struct BoundAuth {
    bootstrap: SessionClientBootstrap,
    noise: PendingNoiseInitiator,
    request: Vec<u8>,
    authorization_digest: [u8; 64],
    daemon_public_key: Box<[u8; DAEMON_IDENTITY_PUBLIC_KEY_BYTES]>,
    daemon_p256: [u8; P256_PUBLIC_KEY_BYTES],
}

/// A completed authentication: the E2E transport, flight 3, and the secrets
/// that outlive this carrier.
pub struct Established {
    pub transport: NoiseTransport,
    /// Flight 3, to send on signaling now.
    pub noise_final: ClientSignal,
    pub rebind: RebindKeeper,
    pub direct_upgrade_secret: Zeroizing<[u8; 32]>,
    /// The first input sequence the daemon expects; unacknowledged input
    /// replays from here.
    pub next_expected_input_seq: u32,
}

impl BoundAuth {
    pub fn complete(self, ready: &DaemonSignal) -> Result<Established, AuthError> {
        let DaemonSignal::SessionReady {
            daemon_nonce,
            ciphertext,
            next_expected_input_seq,
            daemon_signature,
            p256_signature,
            noise_msg2,
        } = ready
        else {
            return Err(AuthError::DaemonAuthFailed);
        };
        if !ready.is_valid() {
            return Err(AuthError::DaemonAuthFailed);
        }
        let next_expected_input_seq =
            u32::try_from(*next_expected_input_seq).map_err(|_| AuthError::DaemonAuthFailed)?;
        let daemon_nonce: [u8; SESSION_NONCE_BYTES] =
            decode_exact(daemon_nonce, "daemon nonce").map_err(|_| AuthError::DaemonAuthFailed)?;
        let ciphertext: [u8; ML_KEM_CIPHERTEXT_BYTES] =
            decode_exact(ciphertext, "ciphertext").map_err(|_| AuthError::DaemonAuthFailed)?;
        let daemon_signature: [u8; DAEMON_IDENTITY_SIGNATURE_BYTES] =
            decode_exact(daemon_signature, "daemon signature")
                .map_err(|_| AuthError::DaemonAuthFailed)?;
        let p256_signature: [u8; 64] = decode_exact(p256_signature, "P-256 signature")
            .map_err(|_| AuthError::DaemonAuthFailed)?;
        let noise_msg2 =
            merkur_authorization::decode_len(noise_msg2, noise_msg2.len() * 3 / 4, "noise")
                .map_err(|_| AuthError::DaemonAuthFailed)?;

        // Rebuilt from the fields this session acts on, never taken off the wire.
        let response = merkur_e2e::build_session_response_transcript(
            &self.request,
            &self.authorization_digest,
            &daemon_nonce,
            &ciphertext,
            next_expected_input_seq,
            &noise_msg2,
        )
        .map_err(|_| AuthError::DaemonAuthFailed)?;
        // Both identity signatures are verified before decapsulation.
        let secrets = self
            .bootstrap
            .complete(
                &ciphertext,
                &self.daemon_public_key[..],
                &self.daemon_p256,
                &daemon_signature,
                &p256_signature,
                &response,
            )
            .map_err(|_| AuthError::DaemonAuthFailed)?;
        let pending = self
            .noise
            .read_authenticated_msg2(&noise_msg2)
            .map_err(|_| AuthError::HandshakeFailed)?;
        let secrets = secrets
            .bind_noise(pending.checkpoint(), &response)
            .map_err(|_| AuthError::DaemonAuthFailed)?;
        let rebind = RebindKeeper::from_session(secrets.rebind_secret(), &response)
            .map_err(|_| AuthError::DaemonAuthFailed)?;
        let mut handshake = pending
            .install_psk(secrets.noise_psk())
            .map_err(|_| AuthError::HandshakeFailed)?;
        let noise_msg3 = handshake
            .write_message(&[])
            .map_err(|_| AuthError::HandshakeFailed)?;
        let transport = handshake
            .into_transport()
            .map_err(|_| AuthError::HandshakeFailed)?;
        Ok(Established {
            transport,
            noise_final: ClientSignal::NoiseFinal(NoiseFinal {
                data: encode(&noise_msg3),
            }),
            rebind,
            direct_upgrade_secret: Zeroizing::new(*secrets.direct_upgrade_secret()),
            next_expected_input_seq,
        })
    }
}

/// `encapsulation_key` bytes are pinned by the type, so the request field is
/// always the canonical length.
const _: () = assert!(
    ML_KEM_ENCAPSULATION_KEY_BYTES == merkur_wire::signaling::ML_KEM_ENCAPSULATION_KEY_BYTES
);

#[cfg(test)]
mod tests;
