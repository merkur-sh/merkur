//! The three flights against an in-process daemon that answers exactly as the
//! dataplane's `session::auth_flow` does, down to a sealed frame each way.

use merkur_authorization::{decode_len, encode};
use merkur_wire::signaling::{ClientSignal, DaemonSignal};

use super::*;
use crate::test_support::{BROWSER_NODE_ID, Counter, account, answer, delegate, issuance, key, sign};

#[test]
fn three_flights_establish_the_same_transport_as_the_daemon() {
    let (delegation, daemon, binding) = account();
    let issued = issuance(&daemon, binding);
    let mut entropy = Counter(0);
    let pending = PendingAuth::new(&mut entropy);
    let (bound, flight) = sign(
        pending.bind(&issued, &delegation, BROWSER_NODE_ID).unwrap(),
        &delegation,
    )
    .unwrap();
    assert!(
        flight.is_valid(),
        "flight 1 passes the dataplane's own envelope rules"
    );
    assert_eq!(
        ClientSignal::parse(flight.to_json().as_bytes()).as_ref(),
        Some(&flight)
    );

    let (ready, mut responder, _) = answer(&daemon, &flight, delegate().public_key());
    let mut established = bound.complete(&ready).unwrap();
    assert_eq!(established.next_expected_input_seq, 1);

    let ClientSignal::NoiseFinal(NoiseFinal { data }) = &established.noise_final else {
        panic!("flight 3 is noise_final");
    };
    responder
        .read_message(&decode_len(data, data.len() * 3 / 4, "msg3").unwrap())
        .unwrap();
    let mut daemon_transport = responder.into_transport().unwrap();

    let lane = merkur_e2e::lane_for_channel(merkur_wire::protocol::CHANNEL_PTY).unwrap();
    let sealed = established
        .transport
        .seal_datagram(lane, b"keystroke")
        .unwrap();
    assert_eq!(
        daemon_transport.open_datagram(lane, &sealed).unwrap(),
        b"keystroke"
    );
    let echo = daemon_transport.seal_stream(lane, b"echo").unwrap();
    assert_eq!(
        established.transport.open_stream(lane, &echo).unwrap(),
        b"echo"
    );
}

#[test]
fn a_daemon_the_root_never_bound_is_refused_before_anything_is_signed() {
    let (delegation, daemon, binding) = account();
    let mut issued = issuance(&daemon, binding);
    // The server names a different daemon identity under the same binding.
    issued.daemon_identity_public_key = encode(key(0x45).public_key());
    let mut entropy = Counter(0);
    let pending = PendingAuth::new(&mut entropy);
    assert!(matches!(
        pending.bind(&issued, &delegation, BROWSER_NODE_ID).map(|_| ()),
        Err(AuthError::DaemonNotAuthorized)
    ));
}

#[test]
fn a_forged_answer_is_refused_before_decapsulation() {
    let (delegation, daemon, binding) = account();
    let issued = issuance(&daemon, binding);
    let mut entropy = Counter(0);
    let (bound, flight) = sign(
        PendingAuth::new(&mut entropy)
            .bind(&issued, &delegation, BROWSER_NODE_ID)
            .unwrap(),
        &delegation,
    )
    .unwrap();
    let (ready, _, _) = answer(&daemon, &flight, delegate().public_key());
    let DaemonSignal::SessionReady {
        daemon_nonce,
        ciphertext,
        daemon_signature,
        p256_signature,
        noise_msg2,
        ..
    } = ready
    else {
        unreachable!()
    };
    // Another next-input sequence than the one the daemon signed.
    let forged = DaemonSignal::SessionReady {
        daemon_nonce,
        ciphertext,
        next_expected_input_seq: 8,
        daemon_signature,
        p256_signature,
        noise_msg2,
    };
    assert!(matches!(
        bound.complete(&forged),
        Err(AuthError::DaemonAuthFailed)
    ));
}

#[test]
fn a_disclosed_bootstrap_psk_cannot_substitute_the_identity_signed_noise_response() {
    let (delegation, daemon, binding) = account();
    let issued = issuance(&daemon, binding);
    let mut entropy = Counter(0);
    let (mut bound, flight) = sign(
        PendingAuth::new(&mut entropy)
            .bind(&issued, &delegation, BROWSER_NODE_ID)
            .unwrap(),
        &delegation,
    )
    .unwrap();
    let (mut ready, _, _) = answer(&daemon, &flight, delegate().public_key());
    // Duplicate only this deterministic synthetic test KEM key. This models
    // disclosure of the valid bootstrap PSK without handing over Noise keys.
    let duplicate = merkur_e2e::SessionClientBootstrap::new(std::array::from_fn(|i| (i + 1) as u8));
    assert_eq!(
        duplicate.encapsulation_key(),
        bound.bootstrap.encapsulation_key()
    );
    let disclosed = std::mem::replace(&mut bound.bootstrap, duplicate);
    let DaemonSignal::SessionReady {
        daemon_nonce,
        ciphertext,
        daemon_signature,
        p256_signature,
        noise_msg2,
        next_expected_input_seq,
    } = &mut ready
    else {
        unreachable!()
    };
    let ciphertext: [u8; 1568] = decode_len(ciphertext, 1568, "ciphertext")
        .unwrap()
        .try_into()
        .unwrap();
    let nonce: [u8; 32] = decode_len(daemon_nonce, 32, "nonce")
        .unwrap()
        .try_into()
        .unwrap();
    let signature = decode_len(daemon_signature, 4627, "signature").unwrap();
    let classical_signature = decode_len(p256_signature, 64, "signature").unwrap();
    let real_msg2 = decode_len(noise_msg2, noise_msg2.len() * 3 / 4, "noise").unwrap();
    let response = merkur_e2e::build_session_response_transcript(
        &bound.request,
        &bound.authorization_digest,
        &nonce,
        &ciphertext,
        *next_expected_input_seq as u32,
        &real_msg2,
    )
    .unwrap();
    let secrets = disclosed
        .complete(
            &ciphertext,
            &bound.daemon_public_key[..],
            &bound.daemon_p256,
            &signature,
            &classical_signature,
            &response,
        )
        .unwrap();
    let ClientSignal::SessionAuth(auth) = &flight else {
        unreachable!()
    };
    let client_nonce: [u8; 32] = decode_len(&auth.client_nonce, 32, "nonce")
        .unwrap()
        .try_into()
        .unwrap();
    let kem_key: [u8; 1568] = decode_len(&auth.encapsulation_key, 1568, "key")
        .unwrap()
        .try_into()
        .unwrap();
    let preamble = merkur_e2e::build_session_request_transcript(
        auth.session_token.as_bytes(),
        &auth.session_id,
        BROWSER_NODE_ID,
        daemon.id,
        &client_nonce,
        &kem_key,
    )
    .unwrap();
    let prologue = merkur_e2e::derive_prologue(
        &auth.session_id,
        daemon.id,
        &merkur_e2e::hash_session_request_transcript(&preamble).unwrap(),
    );
    let msg1 = decode_len(&auth.noise_msg1, auth.noise_msg1.len() * 3 / 4, "noise").unwrap();
    let fake_static = merkur_e2e::generate_static_keypair().unwrap().0;
    let (fake, substituted_msg2) =
        merkur_e2e::PendingNoiseResponder::start(&fake_static, &prologue, &msg1).unwrap();
    let _fake_with_correct_psk = fake.install_psk(secrets.noise_psk()).unwrap();
    *noise_msg2 = encode(&substituted_msg2);
    assert!(matches!(
        bound.complete(&ready),
        Err(AuthError::DaemonAuthFailed)
    ));
}

#[test]
fn a_signature_that_is_not_the_delegates_never_reaches_the_wire() {
    let (delegation, daemon, binding) = account();
    let issued = issuance(&daemon, binding);
    let mut entropy = Counter(0);
    let unsigned = PendingAuth::new(&mut entropy)
        .bind(&issued, &delegation, BROWSER_NODE_ID)
        .unwrap();
    // Another key's signature over the right proof, as a faulty signer returns.
    let forged = merkur_authorization::sign_session_delegation_proof(
        unsigned.proof(),
        &key(0x23),
        [0x77; 32],
    )
    .unwrap();
    assert!(matches!(
        unsigned.sign(&delegation, &forged),
        Err(AuthError::InvalidRequest)
    ));
}
