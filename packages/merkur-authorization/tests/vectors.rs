//! The committed interoperability vectors, reproduced byte for byte, and the
//! behaviour the TypeScript suite has always pinned.

use merkur_authorization::*;
use serde_json::Value;

const NOW: u64 = 1_800_000_000_000;
const ORIGIN: &str = "https://merkur.example";

fn vector(name: &str) -> Value {
    let path = format!(
        "{}/../shared/test-vectors/{name}",
        std::env::var("CARGO_MANIFEST_DIR").expect("test manifest directory")
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("vector file")).expect("vector json")
}

fn hex32(value: &Value) -> [u8; 32] {
    let text = value.as_str().expect("hex string");
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).expect("hex");
    }
    out
}

fn key(seed: [u8; 32]) -> SigningKey {
    SigningKey::from_seed(&mut seed.clone()).expect("seed")
}

#[test]
fn reproduces_the_user_authorization_vector() {
    let v = vector("user-authorization-mldsa87.json");
    let root = key(hex32(&v["rootSeedHex"]));
    let delegate = key(hex32(&v["delegateSeedHex"]));
    assert_eq!(encode(root.public_key()), v["rootPublicKey"]);
    assert_eq!(
        root_key_commitment(root.public_key()).unwrap(),
        v["rootKeyCommitment"]
    );

    let daemon_pk =
        decode_len(v["daemonIdentityPublicKey"].as_str().unwrap(), 2_592, "pk").unwrap();
    let daemon_p256 = decode_len(
        v["daemonIdentityP256PublicKey"].as_str().unwrap(),
        65,
        "p256",
    )
    .unwrap();
    assert_eq!(
        daemon_identity_key_commitment(&daemon_pk, &daemon_p256).unwrap(),
        v["daemonIdentityKeyCommitment"]
    );

    let expected: DelegationCertificate = serde_json::from_value(v["certificate"].clone()).unwrap();
    let certificate = DelegationCertificate::create(expected.payload(), &root, [0xa1; 32]).unwrap();
    assert_eq!(certificate, expected);
    assert_eq!(
        DelegationCertificate::parse(&certificate.to_json()).unwrap(),
        certificate
    );

    let request = decode_len(
        v["requestTranscriptBase64Url"].as_str().unwrap(),
        v["requestTranscriptBase64Url"].as_str().unwrap().len() * 3 / 4,
        "request",
    )
    .unwrap();
    let proof = session_delegation_proof_transcript(&request, &certificate).unwrap();
    assert_eq!(encode(&proof), v["proofTranscriptBase64Url"]);
    let signature = sign_session_delegation_proof(&proof, &delegate, [0xa2; 32]).unwrap();
    assert_eq!(encode(&signature), v["delegationSignature"]);
    assert_eq!(
        encode(&session_delegation_authorization_digest(&proof, &signature).unwrap()),
        v["authorizationDigest"]
    );

    let binding: DaemonBinding = serde_json::from_value(v["daemonBinding"].clone()).unwrap();
    assert_eq!(
        DaemonBinding::create(binding.payload(), &root, [0xa3; 32]).unwrap(),
        binding
    );
    binding
        .verify(root.public_key(), &binding.payload())
        .unwrap();

    let revocation: RevocationStatement = serde_json::from_value(v["revocation"].clone()).unwrap();
    assert_eq!(
        RevocationStatement::create(revocation.payload(), &delegate, [0xa5; 32]).unwrap(),
        revocation
    );
    revocation.verify(delegate.public_key()).unwrap();
}

#[test]
fn opens_and_reseals_the_webcrypto_root_envelope() {
    let v = vector("user-root-envelope.json");
    let seed = hex32(&v["rootSeedHex"]);
    let export_hex = v["exportKeyHex"].as_str().unwrap();
    let mut export_key = [0u8; 64];
    for (index, byte) in export_key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&export_hex[index * 2..index * 2 + 2], 16).unwrap();
    }
    let user_id = v["userId"].as_str().unwrap();
    let origin = v["serverOrigin"].as_str().unwrap();
    let root_pk: [u8; 2_592] = decode_exact(v["rootPublicKey"].as_str().unwrap(), "pk").unwrap();
    let envelope: RootEnvelope = serde_json::from_value(v["envelope"].clone()).unwrap();

    let opened = envelope
        .open(&export_key, user_id, &root_pk, origin)
        .unwrap();
    assert_eq!(*opened, seed);

    let nonce: [u8; ROOT_ENVELOPE_NONCE_BYTES] = decode_exact(&envelope.nonce, "nonce").unwrap();
    assert_eq!(
        RootEnvelope::seal(&seed, &export_key, user_id, &root_pk, origin, nonce).unwrap(),
        envelope
    );

    let mut wrong_key = export_key;
    wrong_key[0] ^= 1;
    assert!(
        envelope
            .open(&wrong_key, user_id, &root_pk, origin)
            .is_err()
    );
    assert!(
        envelope
            .open(&export_key, "someone-else", &root_pk, origin)
            .is_err()
    );
    assert!(
        envelope
            .open(&export_key, user_id, &root_pk, "https://attacker.example")
            .is_err()
    );
}

fn make_certificate() -> (SigningKey, SigningKey, String, DelegationCertificate) {
    let root = key([0x11; 32]);
    let delegate = key([0x22; 32]);
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
    (root, delegate, commitment, certificate)
}

#[test]
fn a_delegation_is_fixed_to_thirty_days_and_strictly_verified() {
    let (root, _, commitment, certificate) = make_certificate();
    let commitment: &str = &commitment;
    let expect =
        move |origin: &'static str, now_ms: u64, id: Option<&'static str>| DelegationExpectation {
            user_id: "user-1",
            root_key_commitment: commitment,
            delegation_id: id,
            server_origin: origin,
            root_epoch: 1,
            now_ms,
        };
    certificate
        .verify(
            root.public_key(),
            &expect(ORIGIN, NOW, Some("delegation-1")),
        )
        .unwrap();
    let mut moved = certificate.clone();
    moved.server_origin = "https://attacker.example".into();
    assert!(
        moved
            .verify(
                root.public_key(),
                &expect("https://attacker.example", NOW, None)
            )
            .is_err()
    );
    assert!(
        certificate
            .verify(
                root.public_key(),
                &expect(ORIGIN, certificate.expires_at, None)
            )
            .is_err()
    );
    assert!(
        certificate
            .verify(
                root.public_key(),
                &expect(ORIGIN, NOW - CLOCK_SKEW_MS - 1, None)
            )
            .is_err()
    );
    certificate
        .verify(
            root.public_key(),
            &expect(ORIGIN, NOW - CLOCK_SKEW_MS, None),
        )
        .unwrap();

    let mut reversed = certificate.clone();
    reversed.scopes.reverse();
    let error = DelegationCertificate::parse(&reversed.to_json()).unwrap_err();
    assert!(
        error.to_string().contains("fixed canonical scopes"),
        "{error}"
    );

    let mut short = certificate.payload();
    short.expires_at -= 1;
    assert!(DelegationCertificate::create(short, &root, [0; 32]).is_err());
}

#[test]
fn parse_demands_exact_fields_in_canonical_order() {
    let (_, _, _, certificate) = make_certificate();
    let json = certificate.to_json();
    assert!(DelegationCertificate::parse(&json).is_ok());
    // The same fields in another order (serde_json's map sorts keys).
    let reordered: Value = serde_json::from_str(&json).unwrap();
    assert!(DelegationCertificate::parse(&reordered.to_string()).is_err());
    // An extra field and a padded signature.
    assert!(DelegationCertificate::parse(&json.replacen('{', "{\"extra\":1,", 1)).is_err());
    let padded = json.replace(
        &certificate.signature,
        &format!("{}=", certificate.signature),
    );
    assert!(DelegationCertificate::parse(&padded).is_err());
    // Whitespace is not the canonical spelling.
    assert!(DelegationCertificate::parse(&json.replacen(':', ": ", 1)).is_err());
}

#[test]
fn the_delegate_proof_binds_the_exact_request() {
    let (_, delegate, _, certificate) = make_certificate();
    let request = merkur_e2e::build_session_request_transcript(
        b"exact-capability-and-ml-kem-request",
        "session-1",
        "browser-1",
        "daemon-1",
        &[0x31; 32],
        &[0x32; 1_568],
    )
    .unwrap();
    let proof = session_delegation_proof_transcript(&request, &certificate).unwrap();
    let signature = sign_session_delegation_proof(&proof, &delegate, [0x44; 32]).unwrap();
    assert!(verify_session_delegation_proof(
        &proof,
        &signature,
        delegate.public_key()
    ));
    let other = merkur_e2e::build_session_request_transcript(
        b"different-request",
        "session-1",
        "browser-1",
        "daemon-1",
        &[0x31; 32],
        &[0x32; 1_568],
    )
    .unwrap();
    let changed = session_delegation_proof_transcript(&other, &certificate).unwrap();
    assert!(!verify_session_delegation_proof(
        &changed,
        &signature,
        delegate.public_key()
    ));
    let digest = session_delegation_authorization_digest(&proof, &signature).unwrap();
    let mut flipped = signature;
    flipped[0] ^= 1;
    assert_ne!(
        session_delegation_authorization_digest(&proof, &flipped).unwrap(),
        digest
    );
}

#[test]
fn a_daemon_binding_pins_the_exact_payload() {
    let (root, _, commitment, _) = make_certificate();
    let payload = DaemonBindingPayload {
        user_id: "user-1".into(),
        root_key_commitment: commitment,
        daemon_id: "daemon-1".into(),
        daemon_identity_key_commitment: encode(&[7; 64]),
        server_origin: ORIGIN.into(),
        link_claim_id: "claim-1".into(),
        issued_at: NOW,
    };
    let binding = DaemonBinding::create(payload.clone(), &root, [0x55; 32]).unwrap();
    binding.verify(root.public_key(), &payload).unwrap();
    let other = DaemonBindingPayload {
        daemon_id: "daemon-2".into(),
        ..payload
    };
    assert!(binding.verify(root.public_key(), &other).is_err());
}

#[test]
fn revocations_are_sorted_bounded_and_delegate_signed() {
    let (_, delegate, commitment, _) = make_certificate();
    let payload = RevocationPayload {
        user_id: "user-1".into(),
        root_key_commitment: commitment,
        actor_delegation_id: "delegation-1".into(),
        targets: vec![
            RevocationTarget {
                delegation_id: "delegation-2".into(),
                expires_at: NOW + DELEGATION_LIFETIME_MS,
            },
            RevocationTarget {
                delegation_id: "delegation-3".into(),
                expires_at: NOW + DELEGATION_LIFETIME_MS,
            },
        ],
        issued_at: NOW,
        nonce: encode(&[0x66; 32]),
    };
    let statement = RevocationStatement::create(payload.clone(), &delegate, [0x77; 32]).unwrap();
    assert_eq!(
        RevocationStatement::parse(&statement.to_json()).unwrap(),
        statement
    );
    statement.verify(delegate.public_key()).unwrap();
    let mut moved = statement;
    moved.actor_delegation_id = "delegation-9".into();
    assert!(moved.verify(delegate.public_key()).is_err());

    let mut reversed = payload.clone();
    reversed.targets.reverse();
    let error = RevocationStatement::create(reversed, &delegate, [0; 32]).unwrap_err();
    assert!(error.to_string().contains("sorted"), "{error}");
    let mut duplicated = payload.clone();
    duplicated.targets[1].delegation_id = "delegation-2".into();
    assert!(
        RevocationStatement::create(duplicated, &delegate, [0; 32])
            .unwrap_err()
            .to_string()
            .contains("unique")
    );
    let mut empty = payload;
    empty.targets.clear();
    assert!(RevocationStatement::create(empty, &delegate, [0; 32]).is_err());
}

#[test]
fn the_link_claim_and_approval_are_authenticated_by_the_code() {
    let (root, _, commitment, _) = make_certificate();
    let secret = [0x81; 32];
    let nonce = [0x82; 32];
    let p256: [u8; 65] = decode_exact(
        "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
        "p256",
    )
    .unwrap();
    let identity_commitment = daemon_identity_key_commitment(root.public_key(), &p256).unwrap();
    let claim = LinkClaimPayload {
        link_claim_id: "claim-1".into(),
        daemon_id: "daemon-1".into(),
        daemon_identity_public_key: encode(root.public_key()),
        daemon_identity_p256_public_key: encode(&p256),
        daemon_identity_key_commitment: identity_commitment.clone(),
        name: "workstation".into(),
        platform: "darwin-arm64".into(),
        identity_seal_backend: DaemonIdentitySealBackend::Software,
    };
    let claim_commitment = claim.commitment(&secret).unwrap();
    let substituted = LinkClaimPayload {
        daemon_id: "substituted-daemon".into(),
        ..claim.clone()
    };
    assert_ne!(substituted.commitment(&secret).unwrap(), claim_commitment);
    let other_backend = LinkClaimPayload {
        identity_seal_backend: DaemonIdentitySealBackend::Hardware,
        ..claim.clone()
    };
    assert_ne!(other_backend.commitment(&secret).unwrap(), claim_commitment);
    let mismatched = LinkClaimPayload {
        daemon_identity_key_commitment: encode(&[9; 64]),
        ..claim.clone()
    };
    assert!(mismatched.commitment(&secret).is_err());

    let binding = DaemonBinding::create(
        DaemonBindingPayload {
            user_id: "user-1".into(),
            root_key_commitment: commitment,
            daemon_id: claim.daemon_id.clone(),
            daemon_identity_key_commitment: identity_commitment,
            server_origin: ORIGIN.into(),
            link_claim_id: claim.link_claim_id.clone(),
            issued_at: NOW,
        },
        &root,
        [0x84; 32],
    )
    .unwrap();
    let approval = LinkApproval::create(
        LinkApprovalPayload {
            link_claim_id: claim.link_claim_id.clone(),
            claim_commitment,
            user_root_public_key: encode(root.public_key()),
            root_epoch: 1,
            daemon_binding: binding,
        },
        &nonce,
        &secret,
    )
    .unwrap();
    approval.verify(&nonce, &secret).unwrap();
    assert_eq!(LinkApproval::parse(&approval.to_json()).unwrap(), approval);
    let mut bumped = approval.clone();
    bumped.root_epoch = 2;
    assert!(bumped.verify(&nonce, &secret).is_err());
    assert!(approval.verify(&[0x83; 32], &secret).is_err());

    let code = format_link_code(&claim.link_claim_id, &secret).unwrap();
    assert_eq!(
        parse_link_code(&code).unwrap(),
        (claim.link_claim_id, secret)
    );
    assert!(parse_link_code("claim-1").is_err());
    assert!(parse_link_code(&format!("{code}.x")).is_err());
}

#[test]
fn an_account_deletion_needs_the_root_and_covers_every_field() {
    let (root, delegate, commitment, _) = make_certificate();
    let payload = AccountDeletionPayload {
        user_id: "user-1".into(),
        root_key_commitment: commitment,
        root_epoch: 1,
        issued_at: NOW,
        nonce: encode(&[0x44; 32]),
    };
    let statement = AccountDeletionStatement::create(payload.clone(), &root, [0x55; 32]).unwrap();
    statement.verify(root.public_key()).unwrap();
    assert_eq!(
        AccountDeletionStatement::parse(&statement.to_json()).unwrap(),
        statement
    );

    let by_delegate = AccountDeletionStatement::create(payload, &delegate, [0x55; 32]).unwrap();
    assert!(by_delegate.verify(root.public_key()).is_err());

    for edit in [
        |s: &mut AccountDeletionStatement| s.user_id = "user-2".into(),
        |s: &mut AccountDeletionStatement| s.root_epoch = 2,
        |s: &mut AccountDeletionStatement| s.issued_at -= 1,
    ] {
        let mut edited = statement.clone();
        edit(&mut edited);
        assert!(edited.verify(root.public_key()).is_err());
    }
    let json = statement.to_json();
    assert!(AccountDeletionStatement::parse(&json.replacen('{', "{\"extra\":1,", 1)).is_err());
    let without_nonce = json.replace(&format!(",\"nonce\":\"{}\"", statement.nonce), "");
    assert!(AccountDeletionStatement::parse(&without_nonce).is_err());
}
