use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

type ProfileJob<'a> = (&'a str, Box<dyn Fn() + 'a>);

use merkur_authorization::*;

struct CountingAllocator;
static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

// SAFETY: all pointers and layouts pass unchanged to the system allocator.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller supplies System's required layout.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: the caller supplies System's required layout.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: this block was allocated by System with this layout.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        // SAFETY: the block and new size meet System's requirements.
        unsafe { System.realloc(pointer, layout, size) }
    }
}

fn record(bytes: usize) {
    if COUNTING.load(Ordering::Relaxed) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(bytes, Ordering::Relaxed);
    }
}

fn count(run: impl FnOnce()) -> (usize, usize) {
    ALLOCATIONS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    COUNTING.store(true, Ordering::SeqCst);
    run();
    COUNTING.store(false, Ordering::SeqCst);
    (
        ALLOCATIONS.load(Ordering::Relaxed),
        BYTES.load(Ordering::Relaxed),
    )
}

fn fixture() -> (SigningKey, DelegationCertificate) {
    let root = SigningKey::from_seed(&mut [1; 32]).unwrap();
    let delegate = SigningKey::from_seed(&mut [2; 32]).unwrap();
    let certificate = DelegationCertificate::create(
        DelegationPayload {
            user_id: "user".into(),
            root_key_commitment: root_key_commitment(root.public_key()).unwrap(),
            delegation_id: "delegation".into(),
            delegate_public_key: encode(delegate.public_key()),
            scopes: DELEGATION_SCOPES.map(str::to_string).to_vec(),
            server_origin: "https://merkur.example".into(),
            root_epoch: 1,
            issued_at: 1_800_000_000_000,
            expires_at: 1_800_000_000_000 + DELEGATION_LIFETIME_MS,
        },
        &root,
        [3; 32],
    )
    .unwrap();
    (root, certificate)
}

fn expected(c: &DelegationCertificate) -> DelegationExpectation<'_> {
    DelegationExpectation {
        user_id: &c.user_id,
        root_key_commitment: &c.root_key_commitment,
        delegation_id: Some(&c.delegation_id),
        server_origin: &c.server_origin,
        root_epoch: c.root_epoch,
        now_ms: c.issued_at,
    }
}

// Independent owned-payload control with the same validation and rejection order.
fn owned_verify(
    c: &DelegationCertificate,
    root: &[u8],
    e: &DelegationExpectation<'_>,
) -> Result<(), String> {
    c.payload().validate().map_err(|error| error.to_string())?;
    decode_len(&c.signature, SIGNATURE_BYTES, "delegation signature")
        .map_err(|error| error.to_string())?;
    if c.user_id != e.user_id
        || c.root_key_commitment != e.root_key_commitment
        || e.delegation_id.is_some_and(|id| id != c.delegation_id)
        || c.server_origin != e.server_origin
        || c.root_epoch != e.root_epoch
        || e.now_ms.saturating_add(CLOCK_SKEW_MS) < c.issued_at
        || e.now_ms >= c.expires_at
    {
        return Err(
            "delegation does not match its expected user, root, origin or validity".to_string(),
        );
    }
    c.payload().validate().map_err(|error| error.to_string())?;
    decode_len(&c.signature, SIGNATURE_BYTES, "delegation signature")
        .map_err(|error| error.to_string())?;
    let payload = serde_json::to_string(&c.payload()).map_err(|error| error.to_string())?;
    let signature = decode_len(&c.signature, SIGNATURE_BYTES, "delegation signature")
        .map_err(|error| error.to_string())?;
    merkur_e2e::verify_ml_dsa87(
        root,
        USER_DELEGATION_CONTEXT,
        payload.as_bytes(),
        &signature,
    )
    .map_err(|_error| "delegation signature does not verify".to_string())
}

#[test]
fn delegation_verification_preserves_rejections() {
    let (root, certificate) = fixture();
    let e = expected(&certificate);
    assert_eq!(certificate.verify(root.public_key(), &e), Ok(()));
    let mut cases = vec![certificate.clone(); 12];
    cases[0].user_id.clear();
    cases[1].root_key_commitment.push('=');
    cases[2].delegation_id.clear();
    cases[3].delegate_public_key.pop();
    cases[4].scopes.reverse();
    cases[5].server_origin.push('/');
    cases[6].root_epoch = 0;
    cases[7].issued_at = MAX_SAFE_INTEGER + 1;
    cases[8].expires_at = MAX_SAFE_INTEGER + 1;
    cases[9].expires_at += 1;
    cases[10].signature.push('=');
    cases[11].signature = encode(&[0; SIGNATURE_BYTES]);
    for c in cases {
        assert_eq!(
            c.verify(root.public_key(), &e)
                .map_err(|error| error.to_string()),
            owned_verify(&c, root.public_key(), &e)
        );
        assert!(c.verify(root.public_key(), &e).is_err());
    }
    for e in [
        DelegationExpectation {
            user_id: "other",
            ..expected(&certificate)
        },
        DelegationExpectation {
            root_key_commitment: "other",
            ..expected(&certificate)
        },
        DelegationExpectation {
            delegation_id: Some("other"),
            ..expected(&certificate)
        },
        DelegationExpectation {
            server_origin: "https://other.example",
            ..expected(&certificate)
        },
        DelegationExpectation {
            root_epoch: 2,
            ..expected(&certificate)
        },
        DelegationExpectation {
            now_ms: certificate.issued_at - CLOCK_SKEW_MS - 1,
            ..expected(&certificate)
        },
        DelegationExpectation {
            now_ms: certificate.expires_at,
            ..expected(&certificate)
        },
    ] {
        assert!(certificate.verify(root.public_key(), &e).is_err());
    }
    let payload = serde_json::to_string(&certificate.payload()).unwrap();
    assert_eq!(
        DelegationCertificate::create(certificate.payload(), &root, [3; 32]).unwrap(),
        certificate
    );
    assert!(!payload.contains("signature"));
}

#[test]
#[ignore = "profile; run with --ignored --nocapture --test-threads=1"]
fn delegation_verification_profile() {
    let (root, c) = fixture();
    let json = c.to_json();
    let mut malformed = c.clone();
    malformed.user_id.clear();
    let mut signature = c.clone();
    signature.signature = encode(&[0; SIGNATURE_BYTES]);
    let e = expected(&c);
    let wrong = DelegationExpectation {
        user_id: "other",
        ..expected(&c)
    };
    let payload = c.payload();
    let jobs: [ProfileJob<'_>; 12] = [
        (
            "valid",
            Box::new(|| {
                black_box(c.verify(root.public_key(), &e)).unwrap();
            }),
        ),
        (
            "owned-control",
            Box::new(|| {
                black_box(owned_verify(&c, root.public_key(), &e)).unwrap();
            }),
        ),
        (
            "malformed",
            Box::new(|| {
                black_box(malformed.verify(root.public_key(), &e)).unwrap_err();
            }),
        ),
        (
            "wrong-expectation",
            Box::new(|| {
                black_box(c.verify(root.public_key(), &wrong)).unwrap_err();
            }),
        ),
        (
            "bad-signature",
            Box::new(|| {
                black_box(signature.verify(root.public_key(), &e)).unwrap_err();
            }),
        ),
        (
            "validate",
            Box::new(|| {
                black_box(c.validate()).unwrap();
            }),
        ),
        (
            "verify-signature",
            Box::new(|| {
                black_box(c.verify_signature(root.public_key())).unwrap();
            }),
        ),
        (
            "parse",
            Box::new(|| {
                black_box(DelegationCertificate::parse(&json)).unwrap();
            }),
        ),
        (
            "payload-validate",
            Box::new(|| {
                black_box(payload.validate()).unwrap();
            }),
        ),
        (
            "create",
            Box::new(|| {
                black_box(DelegationCertificate::create(
                    payload.clone(),
                    &root,
                    [3; 32],
                ))
                .unwrap();
            }),
        ),
        (
            "json",
            Box::new(|| {
                black_box(c.to_json());
            }),
        ),
        (
            "payload",
            Box::new(|| {
                black_box(c.payload());
            }),
        ),
    ];
    let only = std::env::var("PROFILE_CASE").ok();
    let repeats = 1_000;
    for (name, run) in &jobs {
        if only.as_ref().is_some_and(|only| only != name) {
            continue;
        }
        report_profile(name, run.as_ref(), repeats);
    }
}

fn report_profile(name: &str, run: &dyn Fn(), repeats: usize) {
    let (allocations, bytes) = count(run);
    for _ in 0..10 {
        run();
    }
    let mut samples = Vec::new();
    for _ in 0..9 {
        let started = Instant::now();
        for _ in 0..repeats {
            run();
        }
        samples.push(started.elapsed().as_nanos() / repeats as u128);
    }
    samples.sort_unstable();
    println!(
        "{name}: allocations={allocations} bytes={bytes} median_ns={} max_ns={}",
        samples[4], samples[8]
    );
}
