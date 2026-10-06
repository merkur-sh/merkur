//! A bounded proof of the rebind chain's bookkeeping. Every outcome the keeper
//! does not decide itself (each MAC, the KEM, the Noise binding, each digest)
//! is a stub the harness controls or leaves symbolic, so Kani explores every
//! combination of verified, forged and stale answers over two operations from
//! any generation and either a pending successor or none. It proves the state
//! machine, not the cryptography:
//!
//! - the generation never moves back, and a tentative successor is always
//!   exactly one generation ahead of the incumbent;
//! - a successor leaves exactly once, by promotion or by being dropped, and
//!   only a promotion replaces the incumbent secret;
//! - an answer whose proof does not verify, that names a stale generation or
//!   names another attempt, changes nothing;
//! - a response whose proof does not verify leaves the one-use bootstrap in its
//!   slot.
//!
//! The keeper never reads a secret's or an attempt's bytes: it copies secrets
//! and compares attempts whole. So each such value is symbolic in its first and
//! last byte only ([`symbolic`]), and the harness compares those two
//! ([`mark`]): any two values can be equal or differ, a copy or comparison that
//! skips either end of the array is caught, and neither the wipes nor the
//! harness's own comparisons run over bytes the solver must track.

use zeroize::Zeroizing;

use super::{PendingRebind, RebindKeeper};
use crate::{
    ML_KEM_CIPHERTEXT_BYTES, NoiseCheckpoint, RebindClientBootstrap, SESSION_NONCE_BYTES,
    SESSION_REBIND_SECRET_BYTES, SessionBootstrapSecrets, SessionCryptoError, SessionSecrets,
};

/// Operations one run applies; two take about 13 minutes. With fully symbolic
/// values neither three nor two reached a verdict in the 15-minute budget, most
/// of it unrolling the byte-wise wipes and whole-array comparisons. Starting
/// from an arbitrary pending successor keeps every two-operation sequence of a
/// longer run in reach.
const STEPS: usize = 2;
/// The tag a stubbed MAC check accepts, and one it refuses.
const VALID: [u8; 1] = [1];
const FORGED: [u8; 1] = [0];

type Secret = [u8; SESSION_REBIND_SECRET_BYTES];

/// A value's symbolic bytes, the only ones that can tell two values apart.
type Mark = (u8, u8);

fn mark<const N: usize>(bytes: &[u8; N]) -> Mark {
    (bytes[0], bytes[N - 1])
}

/// Everything the keeper decides with: the incumbent generation, and the
/// tentative successor's secret, generation and attempt.
#[derive(Clone, Copy, PartialEq, Eq)]
struct State {
    secret: Mark,
    counter: u64,
    pending: Option<(Mark, u64, Mark)>,
}

impl State {
    fn of(keeper: &RebindKeeper) -> Self {
        Self {
            secret: mark(&keeper.secret),
            counter: keeper.counter,
            pending: keeper.pending.as_ref().map(|pending| {
                (
                    mark(&pending.secret),
                    pending.counter,
                    mark(&pending.attempt),
                )
            }),
        }
    }
}

/// A value the solver chooses at both ends.
fn symbolic<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    bytes[0] = kani::any();
    bytes[N - 1] = kani::any();
    bytes
}

fn tag(verified: bool) -> &'static [u8] {
    if verified { &VALID } else { &FORGED }
}

fn verifies(mac: &[u8]) -> Result<(), SessionCryptoError> {
    if mac == VALID {
        Ok(())
    } else {
        Err(SessionCryptoError::InvalidRebindMac)
    }
}

/// Succeeds with `value` or fails, symbolically.
fn either<T>(value: impl FnOnce() -> T) -> Result<T, SessionCryptoError> {
    if kani::any() {
        Ok(value())
    } else {
        Err(SessionCryptoError::InvalidTranscript)
    }
}

fn verify_response_mac(
    _: &Secret,
    _: &[u8],
    _: &[u8],
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    verifies(mac)
}

fn verify_reconciliation_mac(
    _: &Secret,
    _: &[u8],
    _: u64,
    mac: &[u8],
) -> Result<(), SessionCryptoError> {
    verifies(mac)
}

/// The harness's request is the attempt it names.
fn reconciliation_attempt(request: &[u8]) -> Option<[u8; 64]> {
    request.try_into().ok()
}

fn response_transcript(
    _: &[u8],
    _: &[u8; SESSION_NONCE_BYTES],
    _: &[u8; ML_KEM_CIPHERTEXT_BYTES],
    _: u32,
) -> Result<Vec<u8>, SessionCryptoError> {
    either(Vec::new)
}

fn digest(_: &[u8]) -> Result<[u8; 64], SessionCryptoError> {
    either(symbolic)
}

fn decapsulate(
    bootstrap: RebindClientBootstrap,
    _: &Secret,
    _: &[u8],
    _: &[u8],
    _: &[u8],
    _: &[u8],
) -> Result<SessionBootstrapSecrets, SessionCryptoError> {
    // Its key is never read; forgetting it spares the solver a 3 KiB wipe.
    std::mem::forget(bootstrap);
    either(|| SessionBootstrapSecrets::from_bytes(symbolic()))
}

fn bind_noise(
    secrets: SessionBootstrapSecrets,
    _: &NoiseCheckpoint,
    _: &[u8],
) -> Result<SessionSecrets, SessionCryptoError> {
    std::mem::forget(secrets);
    either(|| SessionSecrets::from_bytes(symbolic()))
}

/// zeroize's barrier is an empty `asm!` that keeps a wipe from being optimized
/// away; Kani reasons about the writes and models no assembly.
fn no_barrier<T: ?Sized>(_: &T) {}

#[kani::proof]
#[kani::unwind(130)]
#[kani::stub(crate::rebind::verify_rebind_response_mac, verify_response_mac)]
#[kani::stub(
    crate::rebind_commit::verify_rebind_reconciliation_response_mac,
    verify_reconciliation_mac
)]
#[kani::stub(crate::rebind_commit::reconciliation_attempt, reconciliation_attempt)]
#[kani::stub(crate::rebind::build_rebind_response_transcript, response_transcript)]
#[kani::stub(crate::rebind::compute_rebind_request_digest, digest)]
#[kani::stub(crate::rebind::hash_rebind_response_transcript, digest)]
#[kani::stub(crate::rebind::RebindClientBootstrap::complete, decapsulate)]
#[kani::stub(crate::hybrid::SessionBootstrapSecrets::bind_noise, bind_noise)]
#[kani::stub(zeroize::optimization_barrier, no_barrier)]
fn proof_rebind_keeper_chain() {
    // Any state the operations can reach: no successor, or one generation ahead.
    let counter: u64 = kani::any();
    let pending = kani::any::<bool>().then(|| PendingRebind {
        secret: symbolic(),
        counter: counter.saturating_add(1),
        attempt: symbolic(),
    });
    let mut keeper = RebindKeeper {
        secret: symbolic(),
        counter,
        lineage: [0; 64],
        pending,
    };
    let checkpoint = NoiseCheckpoint {
        contribution: Zeroizing::new(([0; 32], [0; 32])),
        hash: [0; 64],
    };
    let mut bootstrap = Some(RebindClientBootstrap::unkeyed());
    for _ in 0..STEPS {
        let before = State::of(&keeper);
        match kani::any::<u8>() % 4 {
            0 => complete(&mut keeper, &mut bootstrap, &checkpoint, before),
            1 => promote(&mut keeper, before),
            2 => abandon(&mut keeper, before),
            _ => reconcile(&mut keeper, before),
        }
        let after = State::of(&keeper);
        assert!(
            after.counter >= before.counter,
            "the generation never moves back"
        );
        if let Some((_, successor, _)) = after.pending {
            assert!(
                successor == after.counter.saturating_add(1),
                "a successor is one generation ahead"
            );
        }
    }
    std::mem::forget(bootstrap);
}

fn complete(
    keeper: &mut RebindKeeper,
    slot: &mut Option<RebindClientBootstrap>,
    checkpoint: &NoiseCheckpoint,
    before: State,
) {
    // Each attempt brings a fresh bootstrap, or none is left.
    if slot.is_none() && kani::any() {
        *slot = Some(RebindClientBootstrap::unkeyed());
    }
    let had_bootstrap = slot.is_some();
    let verified: bool = kani::any();
    let completed = keeper
        .complete_rebind(
            slot,
            &[],
            &[0; SESSION_NONCE_BYTES],
            &[0; ML_KEM_CIPHERTEXT_BYTES],
            0,
            &[],
            tag(verified),
            checkpoint,
        )
        .is_ok();
    let after = State::of(keeper);
    if !verified {
        assert!(!completed, "an unverified response completes nothing");
        assert!(
            slot.is_some() == had_bootstrap,
            "an unverified response leaves the bootstrap"
        );
    }
    if completed {
        assert!(
            had_bootstrap && slot.is_none(),
            "the bootstrap is used once"
        );
        assert!(
            after.secret == before.secret && after.counter == before.counter,
            "the incumbent stays until a promotion"
        );
        assert!(after.pending.is_some());
    } else {
        assert!(after == before, "a failed completion changes nothing");
    }
    kani::cover!(completed, "a rebind completes");
    kani::cover!(
        completed && before.pending.is_some(),
        "a completion replaces an uncertain successor"
    );
    kani::cover!(
        !verified && had_bootstrap,
        "a forged response is refused and the bootstrap kept"
    );
}

fn promote(keeper: &mut RebindKeeper, before: State) {
    let promoted = keeper.promote().is_ok();
    let after = State::of(keeper);
    match before.pending {
        None => assert!(!promoted && after == before, "nothing to promote"),
        Some((secret, successor, _)) => {
            assert!(promoted);
            assert!(
                after.secret == secret && after.counter == successor && after.pending.is_none(),
                "the successor becomes the incumbent, once"
            );
        }
    }
    kani::cover!(promoted, "a successor is promoted");
}

fn abandon(keeper: &mut RebindKeeper, before: State) {
    keeper.abandon();
    let after = State::of(keeper);
    assert!(
        after.secret == before.secret && after.counter == before.counter && after.pending.is_none(),
        "abandoning drops only the successor"
    );
}

fn reconcile(keeper: &mut RebindKeeper, before: State) {
    let verified: bool = kani::any();
    let counter: u64 = kani::any();
    // The answer names the uncertain attempt, or any other.
    let named: [u8; 64] = match keeper.pending.as_ref() {
        Some(pending) if kani::any() => pending.attempt,
        _ => symbolic(),
    };
    let attempt = mark(&named);
    let settled = keeper.reconcile(&named, counter, tag(verified));
    let after = State::of(keeper);
    let Some((secret, successor, uncertain)) = before.pending else {
        assert!(!settled && after == before, "nothing to reconcile");
        return;
    };
    if !settled {
        assert!(
            after == before,
            "an unproven, stale or foreign answer changes nothing"
        );
    } else {
        assert!(
            verified && attempt == uncertain,
            "only a proven answer settles"
        );
        if counter == before.counter {
            assert!(
                after.secret == before.secret
                    && after.counter == before.counter
                    && after.pending.is_none(),
                "the incumbent's answer drops the successor"
            );
        } else {
            assert!(counter == successor);
            assert!(
                after.secret == secret && after.counter == successor && after.pending.is_none(),
                "the successor's answer promotes it"
            );
        }
    }
    kani::cover!(
        settled && counter == before.counter,
        "the incumbent's answer drops the successor"
    );
    kani::cover!(
        settled && counter != before.counter,
        "the successor's answer promotes it"
    );
    kani::cover!(
        !settled && verified && attempt == uncertain,
        "a proven answer for a stale generation is ignored"
    );
    kani::cover!(
        !settled && verified && attempt != uncertain,
        "a proven answer for another attempt is ignored"
    );
}
