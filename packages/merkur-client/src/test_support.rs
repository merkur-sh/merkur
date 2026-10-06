//! Account, daemon and edge fixtures for the core's tests: a daemon that
//! answers exactly as the dataplane's `session::auth_flow` does.

use merkur_authorization::{
    DELEGATION_LIFETIME_MS, DELEGATION_SCOPES, DaemonBinding, DaemonBindingPayload,
    DelegationCertificate, DelegationPayload, SigningKey, daemon_identity_key_commitment,
    decode_len, encode, root_key_commitment, session_delegation_authorization_digest,
    session_delegation_proof_transcript, verify_session_delegation_proof,
};
use merkur_e2e::{
    DAEMON_IDENTITY_SIGNATURE_CONTEXT, NoiseHandshake, NoiseTransport, SessionServerEncapsulation,
    SoftwareP256SigningKey, daemon_p256_digest,
};
use merkur_wire::signaling::{ClientSignal, DaemonSignal, RebindFinal, SessionAuth};

use crate::Entropy;
use crate::auth::Delegation;
use crate::issuance::Issuance;

pub const ORIGIN: &str = "https://merkur.example";
pub const NOW: u64 = 1_800_000_000_000;
pub const BROWSER_NODE_ID: &str = "browser-1";

/// Deterministic entropy: a counter stream, never zero.
pub struct Counter(pub u8);
impl Entropy for Counter {
    fn fill(&mut self, bytes: &mut [u8]) {
        for byte in bytes {
            self.0 = self.0.wrapping_add(1).max(1);
            *byte = self.0;
        }
    }
}

pub fn key(seed: u8) -> SigningKey {
    SigningKey::from_seed(&mut [seed; 32]).unwrap()
}

/// The account's delegate key, which the host holds and the core never sees.
pub fn delegate() -> SigningKey {
    key(0x22)
}

/// The host's half of step 2: the delegate signs the bind's proof.
pub fn sign(
    unsigned: crate::auth::UnsignedAuth,
    delegation: &Delegation,
) -> Result<(crate::auth::BoundAuth, ClientSignal), crate::auth::AuthError> {
    let signature = merkur_authorization::sign_session_delegation_proof(
        unsigned.proof(),
        &delegate(),
        [0x77; 32],
    )
    .unwrap();
    unsigned.sign(delegation, &signature)
}

/// Prepares `renewal` over `capability` and signs its proof, as a host does.
pub fn prepare_renewal(
    renewal: &mut crate::renewal::Renewal,
    capability: crate::issuance::RenewalCapability,
    delegation: &Delegation,
) -> bool {
    let Some(proof) = renewal
        .prepare(capability, delegation)
        .map(<[u8]>::to_vec)
    else {
        return false;
    };
    let signature =
        merkur_authorization::sign_session_delegation_proof(&proof, &delegate(), [0x77; 32])
            .unwrap();
    renewal.signed(delegation, &signature)
}

/// Answers every signature request the session is waiting on, as a host does.
pub fn answer_signatures(
    session: &mut crate::session::Session,
    now_ms: u64,
    entropy: &mut impl Entropy,
) {
    while let Some(request) = session.take_signature_request() {
        let signature = merkur_authorization::sign_session_delegation_proof(
            &request.proof,
            &delegate(),
            [0x77; 32],
        )
        .unwrap();
        session.signed(now_ms, request.id, Some(&signature), entropy);
    }
}

pub struct Daemon {
    pub id: &'static str,
    pub identity: SigningKey,
    pub p256: SoftwareP256SigningKey,
}

pub fn account() -> (Delegation, Daemon, DaemonBinding) {
    let root = key(0x11);
    let delegate = delegate();
    let commitment = root_key_commitment(root.public_key()).unwrap();
    let certificate = DelegationCertificate::create(
        DelegationPayload {
            user_id: "user-1".into(),
            root_key_commitment: commitment.clone(),
            delegation_id: "delegation-1".into(),
            delegate_public_key: encode(delegate.public_key()),
            scopes: DELEGATION_SCOPES.iter().map(|s| s.to_string()).collect(),
            server_origin: ORIGIN.into(),
            root_epoch: 1,
            issued_at: NOW,
            expires_at: NOW + DELEGATION_LIFETIME_MS,
        },
        &root,
        [0x33; 32],
    )
    .unwrap();
    let daemon = Daemon {
        id: "daemon-1",
        identity: key(0x44),
        p256: SoftwareP256SigningKey::from_seed(&[0x55; 32]).unwrap(),
    };
    let binding = DaemonBinding::create(
        DaemonBindingPayload {
            user_id: "user-1".into(),
            root_key_commitment: commitment,
            daemon_id: daemon.id.into(),
            daemon_identity_key_commitment: daemon_identity_key_commitment(
                daemon.identity.public_key(),
                &daemon.p256.public_key(),
            )
            .unwrap(),
            server_origin: ORIGIN.into(),
            link_claim_id: "claim-1".into(),
            issued_at: NOW,
        },
        &root,
        [0x66; 32],
    )
    .unwrap();
    let mut root_public_key = Box::new([0u8; merkur_authorization::PUBLIC_KEY_BYTES]);
    root_public_key.copy_from_slice(root.public_key());
    (
        Delegation {
            certificate,
            root_public_key,
            server_origin: ORIGIN.into(),
        },
        daemon,
        binding,
    )
}

pub fn issuance(daemon: &Daemon, binding: DaemonBinding) -> Box<Issuance> {
    Box::new(Issuance {
        daemon_id: daemon.id.into(),
        daemon_identity_public_key: encode(daemon.identity.public_key()),
        daemon_identity_p256_public_key: encode(&daemon.p256.public_key()),
        daemon_binding: binding,
        session_token: "capability-token".into(),
        session_token_expires_at_ms: NOW + 60_000,
        session_token_expires_in_ms: 60_000,
        session_id: "session-1".into(),
        edge_wt_url: "https://edge.merkur.example:4433".into(),
        edge_cert_hashes: vec!["q83vASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4k=".into()],
        edge_attach_ticket: encode(&[7; 26]),
    })
}

/// The daemon's half of flights 1 and 2, as `session::auth_flow` runs it, and
/// the rebind lineage that authentication opens.
pub fn answer(
    daemon: &Daemon,
    flight: &ClientSignal,
    delegate_public_key: &[u8],
) -> (DaemonSignal, NoiseHandshake, DaemonLineage) {
    let ClientSignal::SessionAuth(SessionAuth {
        session_token,
        session_id,
        client_nonce,
        encapsulation_key,
        delegation_certificate,
        delegation_signature,
        noise_msg1,
    }) = flight
    else {
        panic!("flight 1 is session_auth");
    };
    let nonce: [u8; 32] = decode_len(client_nonce, 32, "nonce")
        .unwrap()
        .try_into()
        .unwrap();
    let key: [u8; 1_568] = decode_len(encapsulation_key, 1_568, "key")
        .unwrap()
        .try_into()
        .unwrap();
    let msg1 = decode_len(noise_msg1, noise_msg1.len() * 3 / 4, "msg1").unwrap();
    let preamble = merkur_e2e::build_session_request_transcript(
        session_token.as_bytes(),
        session_id,
        BROWSER_NODE_ID,
        daemon.id,
        &nonce,
        &key,
    )
    .unwrap();
    let request = merkur_e2e::bind_session_request_msg1(&preamble, &msg1).unwrap();
    let proof = session_delegation_proof_transcript(&request, delegation_certificate).unwrap();
    let signature = decode_len(delegation_signature, 4_627, "signature").unwrap();
    assert!(verify_session_delegation_proof(
        &proof,
        &signature,
        delegate_public_key
    ));
    let digest = session_delegation_authorization_digest(&proof, &signature).unwrap();

    let encapsulation = SessionServerEncapsulation::new(&key, [0x77; 32]).unwrap();
    let daemon_nonce = [0x88; 32];
    let (daemon_static, _) = merkur_e2e::generate_static_keypair().unwrap();
    let prologue = merkur_e2e::derive_prologue(
        session_id,
        daemon.id,
        &merkur_e2e::hash_session_request_transcript(&preamble).unwrap(),
    );
    let (pending, msg2) =
        merkur_e2e::PendingNoiseResponder::start(&daemon_static, &prologue, &msg1).unwrap();
    let response = merkur_e2e::build_session_response_transcript(
        &request,
        &digest,
        &daemon_nonce,
        encapsulation.ciphertext(),
        1,
        &msg2,
    )
    .unwrap();
    let mldsa = daemon
        .identity
        .sign_response(&response, [0x99; 32])
        .unwrap();
    let p256 = daemon
        .p256
        .sign_digest(&daemon_p256_digest(
            DAEMON_IDENTITY_SIGNATURE_CONTEXT,
            &response,
        ))
        .unwrap();
    let ciphertext = *encapsulation.ciphertext();
    let secrets = encapsulation
        .complete(&mldsa, &response)
        .unwrap()
        .bind_noise(pending.checkpoint(), &response)
        .unwrap();
    let lineage = DaemonLineage {
        daemon_id: daemon.id,
        session_id: session_id.clone(),
        secret: *secrets.rebind_secret(),
        direct_upgrade_secret: *secrets.direct_upgrade_secret(),
        counter: 0,
        lineage: merkur_e2e::compute_rebind_lineage_digest(&response).unwrap(),
    };
    let handshake = pending.install_psk(secrets.noise_psk()).unwrap();
    (
        DaemonSignal::SessionReady {
            daemon_nonce: encode(&daemon_nonce),
            ciphertext: encode(&ciphertext),
            // A new peer's count starts at 1.
            next_expected_input_seq: 1,
            daemon_signature: encode(&mldsa),
            p256_signature: encode(&p256),
            noise_msg2: encode(&msg2),
        },
        handshake,
        lineage,
    )
}

/// The daemon's rebind state for one session, answering as
/// `session::rebind_flow` and `session::reconcile_flow` do.
pub struct DaemonLineage {
    pub daemon_id: &'static str,
    pub session_id: String,
    pub secret: [u8; 64],
    /// The key of the direct path's upgrade proof for the current generation.
    pub direct_upgrade_secret: [u8; 32],
    pub counter: u64,
    pub lineage: [u8; 64],
}

/// An answered rebind the daemon holds until its final flight commits it.
pub struct RebindInFlight {
    request: Vec<u8>,
    request_digest: [u8; 64],
    successor: merkur_e2e::SessionSecrets,
    responder: NoiseHandshake,
}

impl DaemonLineage {
    /// `session_rebound` for a request whose MAC verifies.
    pub fn answer(
        &self,
        flight: &ClientSignal,
        next_expected_input_seq: u32,
    ) -> (DaemonSignal, RebindInFlight) {
        let ClientSignal::SessionRebind(request) = flight else {
            panic!("a rebind flight, got {flight:?}");
        };
        assert_eq!(request.rebind_counter, self.counter, "an exact generation");
        let nonce: [u8; 32] = decode_len(&request.client_nonce, 32, "nonce")
            .unwrap()
            .try_into()
            .unwrap();
        let key = decode_len(&request.encapsulation_key, 1_568, "key").unwrap();
        let mac = decode_len(&request.mac, 64, "mac").unwrap();
        let msg1 = decode_len(
            &request.noise_msg1,
            request.noise_msg1.len() * 3 / 4,
            "msg1",
        )
        .unwrap();
        let preamble = merkur_e2e::build_rebind_request_transcript(
            &request.session_id,
            &request.browser_node_id,
            self.daemon_id,
            request.rebind_counter,
            &self.lineage,
            &nonce,
            &key.clone().try_into().unwrap(),
        )
        .unwrap();
        let bound = merkur_e2e::bind_rebind_request_msg1(&preamble, &msg1).unwrap();
        merkur_e2e::verify_rebind_request_mac(&self.secret, &bound, &mac)
            .expect("the possession proof verifies");
        let request_digest = merkur_e2e::compute_rebind_request_digest(&bound).unwrap();
        let server = merkur_e2e::RebindServerEncapsulation::new(&key, [0x31; 32]).unwrap();
        let ciphertext = *server.ciphertext();
        let daemon_nonce = [0x32; 32];
        let response = merkur_e2e::build_rebind_response_transcript(
            &bound,
            &daemon_nonce,
            &ciphertext,
            next_expected_input_seq,
        )
        .unwrap();
        let successor = server.complete(&self.secret, &response).unwrap();
        let prologue = merkur_e2e::derive_prologue(
            &request.session_id,
            self.daemon_id,
            &merkur_e2e::hash_rebind_request_transcript(&preamble).unwrap(),
        );
        let (daemon_static, _) = merkur_e2e::generate_static_keypair().unwrap();
        let (pending, msg2) =
            merkur_e2e::PendingNoiseResponder::start(&daemon_static, &prologue, &msg1).unwrap();
        let successor = successor
            .bind_noise(pending.checkpoint(), &response)
            .unwrap();
        let responder = pending.install_psk(successor.noise_psk()).unwrap();
        let response_mac =
            merkur_e2e::compute_rebind_response_mac(&self.secret, &response, &msg2).unwrap();
        (
            DaemonSignal::SessionRebound {
                daemon_nonce: encode(&daemon_nonce),
                ciphertext: encode(&ciphertext),
                next_expected_input_seq: next_expected_input_seq.into(),
                mac: encode(&response_mac),
                noise_msg2: encode(&msg2),
            },
            RebindInFlight {
                request: bound,
                request_digest,
                successor,
                responder,
            },
        )
    }

    /// An authenticated refusal of exactly that request.
    pub fn refuse(&self, in_flight: &RebindInFlight, reason: &str) -> DaemonSignal {
        let mac = merkur_e2e::compute_rebind_refusal_mac(&self.secret, &in_flight.request, reason)
            .unwrap();
        DaemonSignal::SessionRebindRefused {
            reason: reason.into(),
            mac: encode(&mac),
        }
    }

    /// The one commit point: a final flight whose MAC and Noise message 3
    /// verify spends the predecessor secret.
    pub fn commit(&mut self, in_flight: RebindInFlight, flight: &ClientSignal) -> NoiseTransport {
        let ClientSignal::RebindFinal(RebindFinal { data, mac }) = flight else {
            panic!("a rebind final, got {flight:?}");
        };
        let msg3 = decode_len(data, data.len() * 3 / 4, "msg3").unwrap();
        merkur_e2e::verify_rebind_final_mac(
            in_flight.successor.rebind_secret(),
            &in_flight.request_digest,
            &msg3,
            &decode_len(mac, 64, "mac").unwrap(),
        )
        .expect("the final flight verifies");
        let mut responder = in_flight.responder;
        responder.read_message(&msg3).unwrap();
        self.secret = *in_flight.successor.rebind_secret();
        self.direct_upgrade_secret = *in_flight.successor.direct_upgrade_secret();
        self.counter += 1;
        responder.into_transport().unwrap()
    }

    /// An accepted renewal: the delegated proof and the possession MAC verify,
    /// and the epoch starts at the current generation. The capability itself
    /// is the server's to sign and the daemon's to check; the client never
    /// reads it.
    pub fn renew(
        &mut self,
        flight: &ClientSignal,
        delegate_public_key: &[u8],
        expires_at_ms: u64,
    ) -> DaemonSignal {
        let ClientSignal::SessionRenew(request) = flight else {
            panic!("a renewal, got {flight:?}");
        };
        assert_eq!(
            request.rebind_counter, self.counter,
            "the current generation"
        );
        let nonce: [u8; 32] = decode_len(&request.client_nonce, 32, "nonce")
            .unwrap()
            .try_into()
            .unwrap();
        let signature = decode_len(&request.delegation_signature, 4_627, "signature").unwrap();
        let intent = merkur_e2e::build_session_renewal_intent(
            &request.session_id,
            &request.browser_node_id,
            self.daemon_id,
            &self.lineage,
            &nonce,
        )
        .unwrap();
        let proof = merkur_e2e::build_session_renewal_delegation_proof(
            &intent,
            &request.session_token,
            &serde_json::to_vec(&*request.delegation_certificate).unwrap(),
        )
        .unwrap();
        assert!(verify_session_delegation_proof(
            &proof,
            &signature,
            delegate_public_key
        ));
        let transcript = merkur_e2e::build_session_renewal_request_transcript(
            &proof,
            &signature,
            request.rebind_counter,
        )
        .unwrap();
        merkur_e2e::verify_session_renewal_request_mac(
            &self.secret,
            &transcript,
            &decode_len(&request.mac, 64, "mac").unwrap(),
        )
        .expect("the possession proof verifies");
        let mac = merkur_e2e::compute_session_renewal_response_mac(
            &self.secret,
            &transcript,
            expires_at_ms,
            self.counter,
            true,
        )
        .unwrap();
        DaemonSignal::SessionRenewed {
            client_nonce: request.client_nonce.clone(),
            rebind_counter: request.rebind_counter,
            accepted: true,
            expires_at_ms,
            generation_base: self.counter,
            mac: encode(&mac),
        }
    }

    /// Which generation the daemon holds, proven under that generation's
    /// secret.
    pub fn reconcile(&self, flight: &ClientSignal) -> DaemonSignal {
        let ClientSignal::SessionRebindReconcile(request) = flight else {
            panic!("a reconcile, got {flight:?}");
        };
        let attempt: [u8; 64] = decode_len(&request.attempt_digest, 64, "attempt")
            .unwrap()
            .try_into()
            .unwrap();
        let nonce: [u8; 32] = decode_len(&request.client_nonce, 32, "nonce")
            .unwrap()
            .try_into()
            .unwrap();
        let transcript = merkur_e2e::build_rebind_reconciliation(
            &request.session_id,
            &request.browser_node_id,
            self.daemon_id,
            &self.lineage,
            request.rebind_counter,
            &attempt,
            &nonce,
        )
        .unwrap();
        let proof = if self.counter == request.rebind_counter {
            &request.mac
        } else {
            assert_eq!(self.counter, request.rebind_counter + 1);
            &request.successor_mac
        };
        merkur_e2e::verify_rebind_reconciliation_mac(
            &self.secret,
            &transcript,
            &decode_len(proof, 64, "mac").unwrap(),
        )
        .expect("the reconcile proof verifies");
        let mac = merkur_e2e::compute_rebind_reconciliation_response_mac(
            &self.secret,
            &transcript,
            self.counter,
        )
        .unwrap();
        DaemonSignal::SessionRebindReconciled {
            client_nonce: request.client_nonce.clone(),
            rebind_counter: self.counter,
            mac: encode(&mac),
        }
    }
}
