//! The client's carrier-rebind chaining state.
//!
//! Every other session secret dies within seconds of the handshake that
//! produced it. This one is retained across a network outage so a returning
//! client can re-authenticate without the application server, which makes it
//! the longest-lived secret in the client and the root of the whole rebind
//! chain. The keeper never hands it out: the only operations are producing
//! proofs over it, completing a rebind, and disposal. Both clients hold one —
//! the browser through `e2e-wasm`, the native client directly — so the chain
//! is advanced by one implementation.
//!
//! Keep it in memory only. An on-disk copy would be an offline-attackable file
//! whose compromise unwinds every generation of the chain.

use zeroize::Zeroize;

use crate::{
    ML_KEM_CIPHERTEXT_BYTES, ML_KEM_ENCAPSULATION_KEY_BYTES, RebindClientBootstrap,
    SESSION_COMMITMENT_BYTES, SESSION_NONCE_BYTES, SESSION_REBIND_SECRET_BYTES,
    SESSION_SECRET_BYTES, SessionCryptoError,
};

pub struct RebindKeeper {
    secret: [u8; SESSION_REBIND_SECRET_BYTES],
    counter: u64,
    lineage: [u8; SESSION_COMMITMENT_BYTES],
    /// Successor derived but not yet proven committed by the daemon.
    pending: Option<PendingRebind>,
}

struct PendingRebind {
    secret: [u8; SESSION_REBIND_SECRET_BYTES],
    counter: u64,
    attempt: [u8; 64],
}

/// What a completed rebind yields for the successor session.
pub struct RebindOutcome {
    /// `noise_psk[32] || direct_upgrade_secret[32]`.
    pub transport_secrets: zeroize::Zeroizing<[u8; 2 * SESSION_SECRET_BYTES]>,
    /// SHA-512 of the rebind response transcript, bound into the successor
    /// Noise prologue exactly as the genesis response digest is.
    pub prologue_digest: [u8; 64],
}

impl RebindKeeper {
    /// Starts the chain from the genesis combiner's rebind secret and the
    /// signed response transcript that fixes its lineage.
    pub fn from_session(
        rebind_secret: &[u8; SESSION_REBIND_SECRET_BYTES],
        response_transcript: &[u8],
    ) -> Result<Self, SessionCryptoError> {
        Ok(Self {
            secret: *rebind_secret,
            counter: 0,
            lineage: crate::compute_rebind_lineage_digest(response_transcript)?,
            pending: None,
        })
    }

    /// The generation this keeper will request next.
    pub fn counter(&self) -> u64 {
        self.counter
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn pending_attempt_digest(&self) -> Option<&[u8; 64]> {
        self.pending.as_ref().map(|pending| &pending.attempt)
    }

    pub fn reconciliation_transcript(
        &self,
        session: &str,
        browser: &str,
        daemon: &str,
        nonce: &[u8; 32],
    ) -> Result<Vec<u8>, SessionCryptoError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or(SessionCryptoError::InvalidTranscript)?;
        crate::build_rebind_reconciliation(
            session,
            browser,
            daemon,
            &self.lineage,
            self.counter,
            &pending.attempt,
            nonce,
        )
    }

    pub fn reconciliation_mac(
        &self,
        request: &[u8],
        successor: bool,
    ) -> Result<[u8; 64], SessionCryptoError> {
        let secret = if successor {
            &self
                .pending
                .as_ref()
                .ok_or(SessionCryptoError::InvalidTranscript)?
                .secret
        } else {
            &self.secret
        };
        crate::compute_rebind_reconciliation_mac(secret, request)
    }

    /// The current-generation answer cancels exactly the uncertain successor;
    /// the successor-generation answer proves the daemon already committed it.
    pub fn reconcile(&mut self, request: &[u8], counter: u64, mac: &[u8]) -> bool {
        let Some(pending) = self.pending.as_ref() else {
            return false;
        };
        let secret = if counter == self.counter {
            &self.secret
        } else if counter == pending.counter {
            &pending.secret
        } else {
            return false;
        };
        if crate::verify_rebind_reconciliation_response_mac(secret, request, counter, mac).is_err()
        {
            return false;
        }
        let Some(pending) = self.pending.as_ref() else {
            return false;
        };
        let Some(attempt) = crate::rebind_commit::reconciliation_attempt(request) else {
            return false;
        };
        if !bool::from(subtle::ConstantTimeEq::ct_eq(
            &pending.attempt[..],
            &attempt[..],
        )) {
            return false;
        }
        if counter == self.counter {
            self.abandon();
            true
        } else {
            self.promote().is_ok()
        }
    }

    pub fn final_mac(&self, message: &[u8]) -> Result<[u8; 64], SessionCryptoError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or(SessionCryptoError::InvalidTranscript)?;
        crate::compute_rebind_final_mac(&pending.secret, &pending.attempt, message)
    }

    pub fn renewal_intent(
        &self,
        session_id: &str,
        browser_node_id: &str,
        daemon_id: &str,
        nonce: &[u8; SESSION_NONCE_BYTES],
    ) -> Result<Vec<u8>, SessionCryptoError> {
        crate::build_session_renewal_intent(
            session_id,
            browser_node_id,
            daemon_id,
            &self.lineage,
            nonce,
        )
    }

    pub fn renewal_request(
        &self,
        proof: &[u8],
        signature: &[u8],
    ) -> Result<Vec<u8>, SessionCryptoError> {
        crate::build_session_renewal_request_transcript(proof, signature, self.counter)
    }

    pub fn renewal_mac(&self, request: &[u8]) -> Result<[u8; 64], SessionCryptoError> {
        crate::compute_session_renewal_request_mac(&self.secret, request)
    }

    pub fn verify_renewal(
        &self,
        request: &[u8],
        expiry: u64,
        generation_base: u64,
        accepted: bool,
        mac: &[u8],
    ) -> bool {
        crate::verify_session_renewal_response_mac(
            &self.secret,
            request,
            expiry,
            generation_base,
            accepted,
            mac,
        )
        .is_ok()
    }

    /// The request PREAMBLE — what the successor Noise prologue binds. Message 1
    /// is not in here and cannot be: it is written under that prologue.
    pub fn request_transcript(
        &self,
        session_id: &str,
        browser_node_id: &str,
        daemon_id: &str,
        client_nonce: &[u8; SESSION_NONCE_BYTES],
        encapsulation_key: &[u8; ML_KEM_ENCAPSULATION_KEY_BYTES],
    ) -> Result<Vec<u8>, SessionCryptoError> {
        crate::build_rebind_request_transcript(
            session_id,
            browser_node_id,
            daemon_id,
            self.counter,
            &self.lineage,
            client_nonce,
            encapsulation_key,
        )
    }

    /// The possession proof over a request transcript.
    pub fn request_mac(&self, request_transcript: &[u8]) -> Result<[u8; 64], SessionCryptoError> {
        crate::compute_rebind_request_mac(&self.secret, request_transcript)
    }

    /// Refusals authenticate only the retained attempt, without consuming its
    /// one-use bootstrap or mutating either generation.
    pub fn verify_refusal(&self, request: &[u8], reason: &str, mac: &[u8]) -> bool {
        crate::verify_rebind_refusal_mac(&self.secret, request, reason, mac).is_ok()
    }

    /// Checks a whole answer before the client publishes a carrier or consumes
    /// its bootstrap. Spoofed and stale answers change nothing.
    pub fn verify_response(
        &self,
        request: &[u8],
        daemon_nonce: &[u8; SESSION_NONCE_BYTES],
        ciphertext: &[u8; ML_KEM_CIPHERTEXT_BYTES],
        next_expected_input_seq: u32,
        noise_msg2: &[u8],
        mac: &[u8],
    ) -> bool {
        let Ok(response) = crate::build_rebind_response_transcript(
            request,
            daemon_nonce,
            ciphertext,
            next_expected_input_seq,
        ) else {
            return false;
        };
        crate::verify_rebind_response_mac(&self.secret, &response, noise_msg2, mac).is_ok()
    }

    /// Verifies the daemon's response proof, decapsulates, and derives the
    /// successor generation.
    ///
    /// The successor is held as **tentative**: this keeper still answers with
    /// generation *n* until [`Self::promote`]. The daemon commits its own side
    /// only when the successor Noise handshake completes, so promoting earlier
    /// would split the chain if the final handshake message were lost.
    ///
    /// The response transcript is rebuilt from the fields the caller will act
    /// on, never accepted as a blob off the wire, so the proof binds the exact
    /// `next_expected_input_seq` and ciphertext this session applies. The
    /// one-use bootstrap leaves its slot only once that proof verifies, so a
    /// spoofed answer leaves the attempt as it was.
    pub fn complete_rebind(
        &mut self,
        bootstrap: &mut Option<RebindClientBootstrap>,
        request_transcript: &[u8],
        daemon_nonce: &[u8; SESSION_NONCE_BYTES],
        ciphertext: &[u8; ML_KEM_CIPHERTEXT_BYTES],
        next_expected_input_seq: u32,
        noise_msg2: &[u8],
        response_mac: &[u8],
        checkpoint: &crate::NoiseCheckpoint,
    ) -> Result<RebindOutcome, SessionCryptoError> {
        let response_transcript = crate::build_rebind_response_transcript(
            request_transcript,
            daemon_nonce,
            ciphertext,
            next_expected_input_seq,
        )?;
        crate::verify_rebind_response_mac(
            &self.secret,
            &response_transcript,
            noise_msg2,
            response_mac,
        )?;
        let bootstrap = bootstrap
            .take()
            .ok_or(SessionCryptoError::InvalidTranscript)?;
        let secrets = bootstrap.complete(
            &self.secret,
            ciphertext,
            &response_transcript,
            noise_msg2,
            response_mac,
        )?;
        let secrets = secrets.bind_noise(checkpoint, &response_transcript)?;
        let prologue_digest = crate::hash_rebind_response_transcript(&response_transcript)?;
        let attempt = crate::compute_rebind_request_digest(request_transcript)?;
        if let Some(mut replaced) = self.pending.take() {
            replaced.secret.zeroize();
        }
        self.pending = Some(PendingRebind {
            secret: *secrets.rebind_secret(),
            counter: self.counter.saturating_add(1),
            attempt,
        });
        let mut transport_secrets = zeroize::Zeroizing::new([0u8; 2 * SESSION_SECRET_BYTES]);
        transport_secrets.copy_from_slice(&secrets.as_bytes()[..2 * SESSION_SECRET_BYTES]);
        Ok(RebindOutcome {
            transport_secrets,
            prologue_digest,
        })
    }

    /// Commits the tentative successor and wipes its predecessor. Call it only
    /// on proof the daemon committed too: the first inbound frame that opens
    /// under the successor generation.
    pub fn promote(&mut self) -> Result<(), SessionCryptoError> {
        let pending = self
            .pending
            .take()
            .ok_or(SessionCryptoError::InvalidTranscript)?;
        self.secret.zeroize();
        self.secret = pending.secret;
        self.counter = pending.counter;
        Ok(())
    }

    /// Discards a tentative successor after a failed or abandoned rebind,
    /// keeping the current generation usable for another attempt.
    pub fn abandon(&mut self) {
        if let Some(mut pending) = self.pending.take() {
            pending.secret.zeroize();
        }
    }
}

impl Drop for RebindKeeper {
    fn drop(&mut self) {
        self.secret.zeroize();
        if let Some(pending) = self.pending.as_mut() {
            pending.secret.zeroize();
        }
    }
}

#[cfg(kani)]
mod proofs;
