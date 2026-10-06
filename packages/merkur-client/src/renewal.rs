//! Renewing reconnect authority for the current session, client side.
//!
//! The port of `apps/web/src/session/session-renewal.ts`. A rebind needs a
//! live authorization epoch: the daemon refuses one whose server capability
//! expired (`lineage_expired`) or whose epoch spent its generations
//! (`generation_budget_exhausted`). A renewal asks the server for a fresh
//! capability bound to a renewal intent under the lineage, has the host sign
//! the delegated proof with the device's delegate key, and proves possession
//! of the current chaining secret. The daemon answers with a MACed verdict;
//! nothing else grants or denies the epoch. It resets no terminal, input or
//! display state and changes no generation.

use merkur_authorization::{SIGNATURE_BYTES, decode_exact, encode};
use merkur_e2e::{RebindKeeper, SESSION_NONCE_BYTES};
use merkur_wire::signaling::{ClientSignal, DaemonSignal, SessionRenew};

use crate::Entropy;
use crate::auth::Delegation;
use crate::issuance::{RenewalCapability, RenewalRequest};
use crate::rebind::Lineage;

/// Generations one authorization epoch permits, mirrored from
/// `MAX_REBIND_GENERATIONS`.
pub const MAX_REBIND_GENERATIONS: u64 = 8;

/// One renewal: its intent, then the capability and the delegated proof.
pub struct Renewal {
    nonce: String,
    intent: Vec<u8>,
    /// The capability and the proof the host is signing.
    unsigned: Option<(RenewalCapability, Vec<u8>)>,
    prepared: Option<Prepared>,
    /// The possession transcript of the flight last sent, and its generation.
    sent: Option<(Vec<u8>, u64)>,
}

struct Prepared {
    capability: RenewalCapability,
    proof: Vec<u8>,
    signature: Vec<u8>,
    certificate: Box<merkur_authorization::DelegationCertificate>,
}

/// An authenticated verdict on this renewal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub accepted: bool,
    pub generation_base: u64,
    /// The capability's lifetime as the server stated it.
    pub lifetime_ms: u64,
}

impl Renewal {
    /// The intent under the lineage, and the capability request bound to it,
    /// which also asks for `edge_wt_url`'s current certificate hashes.
    pub fn new(
        keeper: &RebindKeeper,
        lineage: Lineage<'_>,
        delegation_id: &str,
        edge_wt_url: &str,
        entropy: &mut impl Entropy,
    ) -> Option<(Self, RenewalRequest)> {
        let nonce: [u8; SESSION_NONCE_BYTES] = entropy.array();
        let intent = keeper
            .renewal_intent(
                lineage.session_id,
                lineage.browser_node_id,
                lineage.daemon_id,
                &nonce,
            )
            .ok()?;
        let commitment = merkur_e2e::compute_session_renewal_commitment(&intent).ok()?;
        Some((
            Self {
                nonce: encode(&nonce),
                intent,
                unsigned: None,
                prepared: None,
                sent: None,
            },
            RenewalRequest {
                daemon_id: lineage.daemon_id.into(),
                browser_node_id: lineage.browser_node_id.into(),
                session_id: lineage.session_id.into(),
                delegation_id: delegation_id.into(),
                commitment: encode(&commitment),
                edge_wt_url: edge_wt_url.into(),
            },
        ))
    }

    /// The delegated proof over the server's capability, for the host to sign.
    pub fn prepare(
        &mut self,
        capability: RenewalCapability,
        delegation: &Delegation,
    ) -> Option<&[u8]> {
        let certificate = serde_json::to_vec(&delegation.certificate).ok()?;
        let proof = merkur_e2e::build_session_renewal_delegation_proof(
            &self.intent,
            &capability.session_token,
            &certificate,
        )
        .ok()?;
        Some(&self.unsigned.insert((capability, proof)).1)
    }

    /// Takes the delegate's signature over the prepared proof. One that does
    /// not verify under the certificate leaves the renewal unprepared.
    pub fn signed(&mut self, delegation: &Delegation, signature: &[u8; SIGNATURE_BYTES]) -> bool {
        let Some((capability, proof)) = self.unsigned.take() else {
            return false;
        };
        if !delegation.verifies(&proof, signature) {
            return false;
        }
        self.prepared = Some(Prepared {
            capability,
            proof,
            signature: signature.to_vec(),
            certificate: Box::new(delegation.certificate.clone()),
        });
        true
    }

    pub fn is_prepared(&self) -> bool {
        self.prepared.is_some()
    }

    /// `session_renew` under the keeper's current generation. A key cut
    /// changes neither the intent nor the delegated proof, so a lost answer
    /// is retried by rebuilding only the possession MAC.
    pub fn flight(&mut self, keeper: &RebindKeeper, lineage: Lineage<'_>) -> Option<ClientSignal> {
        let prepared = self.prepared.as_ref()?;
        let transcript = keeper
            .renewal_request(&prepared.proof, &prepared.signature)
            .ok()?;
        let mac = keeper.renewal_mac(&transcript).ok()?;
        let counter = keeper.counter();
        self.sent = Some((transcript, counter));
        Some(ClientSignal::SessionRenew(SessionRenew {
            session_id: lineage.session_id.into(),
            browser_node_id: lineage.browser_node_id.into(),
            rebind_counter: counter,
            client_nonce: self.nonce.clone(),
            session_token: prepared.capability.session_token.clone(),
            delegation_certificate: prepared.certificate.clone(),
            delegation_signature: encode(&prepared.signature),
            mac: encode(&mac),
        }))
    }

    /// The daemon's verdict on the flight last sent, or `None` for anything
    /// that does not verify.
    pub fn answer(&self, keeper: &RebindKeeper, signal: &DaemonSignal) -> Option<Verdict> {
        let DaemonSignal::SessionRenewed {
            client_nonce,
            rebind_counter,
            accepted,
            expires_at_ms,
            generation_base,
            mac,
        } = signal
        else {
            return None;
        };
        let (transcript, counter) = self.sent.as_ref()?;
        let prepared = self.prepared.as_ref()?;
        if *client_nonce != self.nonce
            || rebind_counter != counter
            || *generation_base > keeper.counter()
        {
            return None;
        }
        let mac = decode_exact::<64>(mac, "mac").ok()?;
        keeper
            .verify_renewal(
                transcript,
                *expires_at_ms,
                *generation_base,
                *accepted,
                &mac,
            )
            .then_some(Verdict {
                accepted: *accepted,
                generation_base: *generation_base,
                lifetime_ms: prepared.capability.session_token_expires_in_ms,
            })
    }
}

#[cfg(test)]
mod tests;
