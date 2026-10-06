//! Carrier rebind, client side: the flights a candidate carries.
//!
//! A rebind authenticates a successor carrier with the session's chaining
//! secret instead of the server. [`RebindFlight::new`] writes `session_rebind`
//! (a fresh ML-KEM key, Noise message 1 under a prologue bound to the request
//! preamble, and the possession MAC over `preamble || msg1`). The daemon's
//! `session_rebound` is checked whole before anything is consumed; then the
//! successor is derived and held tentative while `rebind_final` goes out.
//! Only an authenticated `session_rebind_reconciled` under the successor
//! generation proves the daemon committed it: the daemon marks that answer for
//! selection, the edge swaps the attachment, and the keeper promotes.
//!
//! [`Reconcile`] asks the same question for an attempt whose answer was lost,
//! under both possible secrets. Neither silence nor an edge hint decides it.

use merkur_authorization::{decode_exact, decode_len, encode};
use merkur_e2e::{
    ML_KEM_CIPHERTEXT_BYTES, ML_KEM_KEYGEN_SEED_BYTES, NoiseTransport, PendingNoiseInitiator,
    RebindClientBootstrap, RebindKeeper, SESSION_NONCE_BYTES,
};
use merkur_wire::signaling::{
    ClientSignal, DaemonSignal, RebindFinal, SessionRebind, SessionRebindReconcile,
};
use zeroize::Zeroizing;

use crate::Entropy;

/// The three names every rebind transcript binds.
#[derive(Clone, Copy)]
pub struct Lineage<'a> {
    pub session_id: &'a str,
    pub browser_node_id: &'a str,
    pub daemon_id: &'a str,
}

#[cfg(test)]
mod model_tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RebindError {
    /// A field the client builds itself could not be built.
    InvalidRequest,
    /// The answer verified but its successor handshake did not complete.
    HandshakeFailed,
}

/// `session_rebind` in flight, and what its answer is checked against.
pub struct RebindFlight {
    bootstrap: Option<RebindClientBootstrap>,
    noise: Option<PendingNoiseInitiator>,
    /// `preamble || msg1`: what the MAC, the replay digest and the response
    /// transcript are taken over.
    request: Vec<u8>,
}

/// The successor generation, derived but not yet committed by the daemon.
pub struct Successor {
    pub transport: NoiseTransport,
    pub direct_upgrade_secret: Zeroizing<[u8; 32]>,
    /// `rebind_final`, to send on the candidate now.
    pub final_flight: ClientSignal,
    /// The daemon's input watermark when it answered. The incumbent may have
    /// advanced since, so it never renumbers input.
    pub next_expected_input_seq: u32,
}

impl RebindFlight {
    /// `nonce` is the candidate's routing nonce: the edge forwards it to the
    /// daemon beside the proof stream, and the MAC covers it here.
    pub fn new(
        keeper: &RebindKeeper,
        lineage: Lineage<'_>,
        nonce: &[u8; SESSION_NONCE_BYTES],
        entropy: &mut impl Entropy,
    ) -> Result<(Self, ClientSignal), RebindError> {
        let mut seed = Zeroizing::new([0u8; ML_KEM_KEYGEN_SEED_BYTES]);
        entropy.fill(&mut *seed);
        let bootstrap = RebindClientBootstrap::new(*seed);
        let preamble = keeper
            .request_transcript(
                lineage.session_id,
                lineage.browser_node_id,
                lineage.daemon_id,
                nonce,
                bootstrap.encapsulation_key(),
            )
            .map_err(|_| RebindError::InvalidRequest)?;
        let preamble_hash = merkur_e2e::hash_rebind_request_transcript(&preamble)
            .map_err(|_| RebindError::InvalidRequest)?;
        let prologue =
            merkur_e2e::derive_prologue(lineage.session_id, lineage.daemon_id, &preamble_hash);
        let (noise_static, _) =
            merkur_e2e::generate_static_keypair().map_err(|_| RebindError::InvalidRequest)?;
        let noise_static = Zeroizing::new(noise_static);
        let (noise, noise_msg1) = PendingNoiseInitiator::start(&noise_static, &prologue)
            .map_err(|_| RebindError::InvalidRequest)?;
        let request = merkur_e2e::bind_rebind_request_msg1(&preamble, &noise_msg1)
            .map_err(|_| RebindError::InvalidRequest)?;
        let mac = keeper
            .request_mac(&request)
            .map_err(|_| RebindError::InvalidRequest)?;
        let flight = ClientSignal::SessionRebind(SessionRebind {
            session_id: lineage.session_id.into(),
            browser_node_id: lineage.browser_node_id.into(),
            rebind_counter: keeper.counter(),
            client_nonce: encode(nonce),
            encapsulation_key: encode(bootstrap.encapsulation_key()),
            mac: encode(&mac),
            noise_msg1: encode(&noise_msg1),
        });
        Ok((
            Self {
                bootstrap: Some(bootstrap),
                noise: Some(noise),
                request,
            },
            flight,
        ))
    }

    /// `Ok(None)` for an answer that does not verify: spoofed and stale
    /// answers change nothing, and the attempt keeps waiting. `Ok(Some)` holds
    /// the successor tentative in `keeper`.
    pub fn complete(
        &mut self,
        keeper: &mut RebindKeeper,
        rebound: &DaemonSignal,
    ) -> Result<Option<Successor>, RebindError> {
        let DaemonSignal::SessionRebound {
            daemon_nonce,
            ciphertext,
            next_expected_input_seq,
            mac,
            noise_msg2,
        } = rebound
        else {
            return Ok(None);
        };
        let (Some(_), Ok(next_seq), Ok(daemon_nonce), Ok(ciphertext), Ok(mac), Ok(noise_msg2)) = (
            self.noise.as_ref(),
            u32::try_from(*next_expected_input_seq),
            decode_exact::<SESSION_NONCE_BYTES>(daemon_nonce, "daemon nonce"),
            decode_exact::<ML_KEM_CIPHERTEXT_BYTES>(ciphertext, "ciphertext"),
            decode_exact::<64>(mac, "mac"),
            decode_len(noise_msg2, noise_msg2.len() * 3 / 4, "noise"),
        ) else {
            return Ok(None);
        };
        // The whole answer, before the one-use bootstrap is consumed.
        if !keeper.verify_response(
            &self.request,
            &daemon_nonce,
            &ciphertext,
            next_seq,
            &noise_msg2,
            &mac,
        ) {
            return Ok(None);
        }
        let noise = self
            .noise
            .take()
            .expect("checked above")
            .read_authenticated_msg2(&noise_msg2)
            .map_err(|_| RebindError::HandshakeFailed)?;
        let outcome = keeper
            .complete_rebind(
                &mut self.bootstrap,
                &self.request,
                &daemon_nonce,
                &ciphertext,
                next_seq,
                &noise_msg2,
                &mac,
                noise.checkpoint(),
            )
            .map_err(|_| RebindError::HandshakeFailed)?;
        let (psk, upgrade) = outcome.transport_secrets.split_at(32);
        let mut handshake = noise
            .install_psk(psk)
            .map_err(|_| RebindError::HandshakeFailed)?;
        let noise_msg3 = handshake
            .write_message(&[])
            .map_err(|_| RebindError::HandshakeFailed)?;
        let transport = handshake
            .into_transport()
            .map_err(|_| RebindError::HandshakeFailed)?;
        let final_mac = keeper
            .final_mac(&noise_msg3)
            .map_err(|_| RebindError::HandshakeFailed)?;
        let mut direct_upgrade_secret = Zeroizing::new([0u8; 32]);
        direct_upgrade_secret.copy_from_slice(upgrade);
        Ok(Some(Successor {
            transport,
            direct_upgrade_secret,
            final_flight: ClientSignal::RebindFinal(RebindFinal {
                data: encode(&noise_msg3),
                mac: encode(&final_mac),
            }),
            next_expected_input_seq: next_seq,
        }))
    }

    /// The reason of an authenticated refusal of this exact request; `None`
    /// for anything else, which is ignored.
    pub fn refusal<'a>(&self, keeper: &RebindKeeper, signal: &'a DaemonSignal) -> Option<&'a str> {
        let DaemonSignal::SessionRebindRefused { reason, mac } = signal else {
            return None;
        };
        let mac = decode_exact::<64>(mac, "mac").ok()?;
        keeper
            .verify_refusal(&self.request, reason, &mac)
            .then_some(reason.as_str())
    }
}

/// `session_rebind_reconcile` in flight.
pub struct Reconcile {
    nonce: String,
    transcript: Vec<u8>,
    counter: u64,
    pub flight: ClientSignal,
}

impl Reconcile {
    /// `None` when the keeper holds no uncertain successor: nothing to ask.
    pub fn new(
        keeper: &RebindKeeper,
        lineage: Lineage<'_>,
        entropy: &mut impl Entropy,
    ) -> Option<Self> {
        let attempt = *keeper.pending_attempt_digest()?;
        let nonce: [u8; 32] = entropy.array();
        let transcript = keeper
            .reconciliation_transcript(
                lineage.session_id,
                lineage.browser_node_id,
                lineage.daemon_id,
                &nonce,
            )
            .ok()?;
        let mac = keeper.reconciliation_mac(&transcript, false).ok()?;
        let successor_mac = keeper.reconciliation_mac(&transcript, true).ok()?;
        let nonce = encode(&nonce);
        Some(Self {
            flight: ClientSignal::SessionRebindReconcile(SessionRebindReconcile {
                session_id: lineage.session_id.into(),
                browser_node_id: lineage.browser_node_id.into(),
                rebind_counter: keeper.counter(),
                client_nonce: nonce.clone(),
                attempt_digest: encode(&attempt),
                mac: encode(&mac),
                successor_mac: encode(&successor_mac),
            }),
            nonce,
            transcript,
            counter: keeper.counter(),
        })
    }

    /// `Some(true)` when the daemon proved it committed the successor (the
    /// keeper promoted it), `Some(false)` when it proved it did not (the
    /// keeper dropped it), `None` for anything that does not verify.
    pub fn answer(&self, keeper: &mut RebindKeeper, signal: &DaemonSignal) -> Option<bool> {
        let DaemonSignal::SessionRebindReconciled {
            client_nonce,
            rebind_counter,
            mac,
        } = signal
        else {
            return None;
        };
        if *client_nonce != self.nonce {
            return None;
        }
        let mac = decode_exact::<64>(mac, "mac").ok()?;
        keeper
            .reconcile(&self.transcript, *rebind_counter, &mac)
            .then_some(*rebind_counter != self.counter)
    }
}

#[cfg(test)]
mod tests;
