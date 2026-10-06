//! Carrier rebind admission on the daemon.
//!
//! A rebind re-authenticates a returning browser against a peer whose edge
//! tunnel was deliberately held open, using the chaining secret both sides
//! derived at the previous authentication. It reaches no application server, so
//! everything the server would have re-checked has a local counterpart here:
//! the generation fence below replaces the server-issued one-use capability,
//! and the caller's control-link freshness gate replaces the server's
//! revocation check.
//!
//! # Where `RS_n` is consumed
//!
//! Only when the successor Noise handshake completes — never on a valid MAC.
//! The blind edge is an on-path adversary: if a valid proof consumed the
//! secret, capturing this request, suppressing the original, and replaying the
//! copy would burn `RS_n` on a handshake the attacker cannot finish, locking
//! the legitimate browser out of rebind permanently with one unauthenticated
//! packet. Committing at handshake completion turns that replay into an
//! in-flight attempt that expires harmlessly.
//!
//! # Silence, and why it is not invisibility
//!
//! Unauthenticated requests are silent. Once the request MAC has verified, a
//! refusal is MACed in a separate domain and bound to that exact request. The
//! browser can immediately renew authorization instead of waiting for a watchdog.
//! Neither an edge presence hint nor an unverified refusal ends a lineage.
//!
//! Silence toward the caller is not silence toward the operator, and conflating
//! the two cost a production incident: with fourteen crypto failures collapsed
//! into one unnamed variant and no outcome leaving this process, a reconnect
//! storm that refused every rebind had to be diagnosed from the *browser's*
//! upgrade reports. Every outcome — refusals with their reason, both accept
//! paths, the commit with its proof-to-commit duration, and the two lifecycle
//! ends that previously left no record at all — is now reported through
//! `EVT_SESSION_REBIND`, rate-bounded because `UnknownPeer` is drivable by
//! anyone holding the rendezvous id.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use merkur_wire::signaling::{DaemonSignal, MAX_SAFE_INTEGER};
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::auth::DaemonIdentity;
use crate::connection::{InFlightRebind, PeerDisplayState, PeerMap};
use crate::ipc::events::{EVT_SESSION_REBIND, EventSink, SessionRebindEvt};
use crate::network::{self, NetworkState};
use crate::session::policy::SessionPolicy;

/// Outcome of admitting one `session_rebind` frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RebindAdmission {
    /// Answered; the browser may now run the successor Noise handshake.
    Accepted,
    /// Refused. Proven requests receive an authenticated reason; others are silent.
    Rejected,
}

/// Why a rebind was refused. Only a caller proving possession of the current
/// chaining secret receives an authenticated reason on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RebindRefusal {
    UnknownPeer,
    NotRebinding,
    SessionMismatch,
    PeerMismatch,
    StaleGeneration,
    ForgedGeneration,
    BadProof,
    LineageExpired,
    GenerationBudgetExhausted,
    ControlLinkStale,
    /// A crypto primitive was unavailable or failed. The payload names WHICH
    /// step, because this one variant absorbs fourteen distinct failures and
    /// collapsing them made the difference between "no RNG" and "the browser
    /// spliced a bad msg1" invisible in production.
    CryptoUnavailable(&'static str),
}

impl RebindRefusal {
    /// Stable, closed-set label for this refusal.
    ///
    /// Exhaustively matched on purpose: a new variant is a compile error here
    /// rather than an outcome that silently lands in no bucket. The TypeScript
    /// validator's `REBIND_OUTCOMES` set moves in lockstep with this function
    /// and with `REBIND_LIFECYCLE_OUTCOMES` below.
    pub(crate) fn metric_key(self) -> String {
        match self {
            Self::UnknownPeer => "unknown_peer".to_string(),
            Self::NotRebinding => "not_rebinding".to_string(),
            Self::SessionMismatch => "session_mismatch".to_string(),
            Self::PeerMismatch => "peer_mismatch".to_string(),
            Self::StaleGeneration => "stale_generation".to_string(),
            Self::ForgedGeneration => "forged_generation".to_string(),
            Self::BadProof => "bad_proof".to_string(),
            Self::LineageExpired => "lineage_expired".to_string(),
            Self::GenerationBudgetExhausted => "generation_budget_exhausted".to_string(),
            Self::ControlLinkStale => "control_link_stale".to_string(),
            Self::CryptoUnavailable(stage) => format!("crypto:{stage}"),
        }
    }

    /// Every refusal label this enum can produce, for the conformance test that
    /// pins the Rust and TypeScript vocabularies together.
    #[cfg(test)]
    pub(crate) fn all_metric_keys() -> Vec<String> {
        let mut keys: Vec<String> = [
            Self::UnknownPeer,
            Self::NotRebinding,
            Self::SessionMismatch,
            Self::PeerMismatch,
            Self::StaleGeneration,
            Self::ForgedGeneration,
            Self::BadProof,
            Self::LineageExpired,
            Self::GenerationBudgetExhausted,
            Self::ControlLinkStale,
        ]
        .into_iter()
        .map(Self::metric_key)
        .collect();
        keys.extend(CRYPTO_STAGES.iter().map(|stage| format!("crypto:{stage}")));
        keys
    }
}

/// Every stage `CryptoUnavailable` can name. Kept beside the enum so the label
/// vocabulary is enumerable without reaching into the call sites.
#[cfg(test)]
pub(crate) const CRYPTO_STAGES: [&str; 15] = [
    "identity",
    "request_transcript",
    "msg1_bind",
    "request_digest",
    "nonce",
    "encaps_randomness",
    "encapsulation",
    "response_transcript",
    "combiner",
    "prologue_digest",
    "responder_prepare",
    "hybrid_combiner",
    "psk_install",
    "answer_transcript",
    "response_mac",
];

/// Outcomes that are not refusals: the lifecycle ends of one rebind attempt.
///
/// `accepted`, `accepted_held`, and `accepted_replay` distinguish derivation,
/// an answer waiting for a lane, and a zero-ML-KEM retransmission. `committed`
/// is the only one that spends `RS_n`.
#[cfg(test)]
pub(crate) const REBIND_LIFECYCLE_OUTCOMES: [&str; 7] = [
    "accepted",
    "accepted_held",
    "accepted_replay",
    "committed",
    "attempt_expired",
    "response_flushed",
    "envelope_rejected",
];

/// The parsed, structurally-valid contents of a `session_rebind` frame.
///
/// `Clone` so a test can model the browser's VERBATIM re-send precisely: the
/// same bytes, not an equivalent request. Regenerating one would draw a fresh
/// Noise ephemeral and therefore be a different request, which is exactly the
/// distinction the replay path turns on.
#[derive(Clone)]
pub(crate) struct RebindRequest {
    pub session_id: String,
    pub browser_node_id: String,
    pub counter: u64,
    pub client_nonce: [u8; 32],
    pub encapsulation_key: Box<[u8; 1568]>,
    pub mac: [u8; 64],
    /// Noise message 1, fused into this flight so the successor handshake costs
    /// no round trip of its own. Bound into the request transcript, so the MAC
    /// above authenticates it: the blind edge is an on-path adversary and could
    /// otherwise splice its own.
    pub noise_msg1: Vec<u8>,
}

/// Decide whether a peer may be rebound at all, before any proof is checked.
///
/// Ordering matters: none of these consult the request, so an unauthenticated
/// caller cannot use them to probe. The proof check that follows is what makes
/// the remaining state transitions safe.
fn admissible(
    peer: &PeerDisplayState,
    control_link_fresh: bool,
    now_ms: f64,
) -> Result<(), RebindRefusal> {
    // Deliberately NOT gated on an armed rebind window. The window governs
    // whether the daemon holds a tunnel open, which is resource management; it
    // is not an authentication precondition, and treating it as one made the
    // fast path unreachable exactly when it matters most. The daemon learns a
    // browser left only when the edge tells it, and the edge learns only when
    // the browser's QUIC connection actually closes — so on a short outage the
    // browser detects the loss and comes back *before* the daemon has noticed
    // it went anywhere. Requiring the window there refuses the very request
    // that proves the carrier changed.
    //
    // What actually authorizes a rebind is possession of the chaining secret,
    // checked below, plus the bounds in this function. An attacker holding that
    // secret could complete a rebind against an armed window just as easily, so
    // the window adds no security here — only a race.
    if !peer.authenticated {
        return Err(RebindRefusal::NotRebinding);
    }
    // A direct carrier is deliberately NOT an exclusion. Its liveness verdict
    // can trail the browser's by several seconds, and it is the incumbent we
    // want to preserve while the successor is proved. Successful Noise
    // completion retires it atomically with the key cut; a failed attempt
    // leaves it usable.
    // A rebind skips the server, which makes this daemon the sole enforcement
    // point for a delegation revoked while the browser was away. Revocation is
    // pushed over the control link, so a stale link means the tombstones this
    // peer would be checked against may already be out of date: fail closed to
    // full authentication, which does consult the server.
    if !control_link_fresh {
        return Err(RebindRefusal::ControlLinkStale);
    }
    let Some(rebind) = peer.rebind.as_ref() else {
        return Err(RebindRefusal::NotRebinding);
    };
    if rebind
        .authorization
        .expired(crate::auth::unix_time_ms().unwrap_or(u64::MAX), now_ms)
    {
        return Err(RebindRefusal::LineageExpired);
    }
    if rebind
        .counter
        .saturating_sub(rebind.authorization.generation_base)
        >= SessionPolicy::MAX_REBIND_GENERATIONS
    {
        return Err(RebindRefusal::GenerationBudgetExhausted);
    }
    Ok(())
}

/// Events this outcome channel will admit per heartbeat tick.
///
/// A bound is REQUIRED, not defensive. `UnknownPeer` and a post-park
/// `NotRebinding` are drivable by anyone who holds the rendezvous id and can
/// reach the edge, so an unbounded emit here would let an unauthenticated
/// caller flood the event channel this process depends on for its lifecycle
/// frames. Eight per 2 s tick sits an order of magnitude under the TypeScript
/// side's `Queue.dropping(64)` while still admitting every event of a real
/// reconnect storm, which is at most a handful of attempts per second.
///
/// Owner-loop state rather than per-peer state on purpose: per-peer state would
/// itself be the unbounded allocation the bound exists to prevent. The daemon
/// has one rebind owner, so plain integers are both cheaper than atomics and
/// make each test/harness own an independent budget.
const MAX_REBIND_EVENTS_PER_TICK: u32 = 8;

/// Cumulative rebind tallies since process start, for the stats sample.
///
/// Peer-anonymous by construction — five integers and no identity — so this is
/// compatible with the sample's rule that nothing in it may become an unbounded
/// metric label.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RebindTallies {
    pub requests: u64,
    pub accepted: u64,
    pub committed: u64,
    pub refused: u64,
    pub envelopes_rejected: u64,
    pub events_suppressed: u64,
}

/// The complete observability state for carrier rebind.
///
/// All callers run on the dataplane owner loop. Keeping the sink, token bucket,
/// and tallies under that same owner makes races and process-global test state
/// impossible while preserving one process-wide rate bound in production.
pub(crate) struct RebindTelemetry {
    event_tx: EventSink,
    tokens: u32,
    tallies: RebindTallies,
}

impl RebindTelemetry {
    pub(crate) fn new(event_tx: EventSink) -> Self {
        Self {
            event_tx,
            tokens: MAX_REBIND_EVENTS_PER_TICK,
            tallies: RebindTallies::default(),
        }
    }

    /// Refill the outcome budget. Called once per heartbeat tick.
    pub(crate) fn refill(&mut self) {
        self.tokens = MAX_REBIND_EVENTS_PER_TICK;
    }

    pub(crate) fn tallies(&self) -> RebindTallies {
        self.tallies
    }

    fn increment(value: &mut u64) {
        *value = value.saturating_add(1);
    }

    /// Emit one rebind outcome, subject to the bound above.
    ///
    /// `session_id` reaches the span and the log and must never reach a metric
    /// label; only `outcome` is aggregated on. See `SessionRebindEvt`.
    fn emit(&mut self, session_id: &str, outcome: String, generation: u64, attempt_ms: u32) {
        // The daemon's reader (`handleSessionRebind`) refuses an event with an
        // empty session id or a number past `Number.MAX_SAFE_INTEGER`, and
        // treats a refused event as fatal to the sidecar. Nothing it would
        // refuse leaves here: a monitoring frame must not be able to shut down
        // the process it monitors.
        if !merkur_wire::signaling::is_session_id(session_id) || generation > MAX_SAFE_INTEGER {
            return;
        }
        if self.tokens == 0 {
            Self::increment(&mut self.tallies.events_suppressed);
            return;
        }
        self.tokens -= 1;
        // Diagnostic, never lifecycle, for the same reason.
        let _ = self.event_tx.send_diagnostic_json(
            EVT_SESSION_REBIND,
            &SessionRebindEvt {
                session_id: session_id.to_string(),
                outcome,
                generation,
                attempt_ms,
                events_suppressed: self.tallies.events_suppressed.min(MAX_SAFE_INTEGER),
            },
        );
    }

    /// Report a rebind envelope the signaling validator rejected outright.
    ///
    /// The only genuinely silent path upstream of `handle_session_rebind`: a
    /// malformed frame never reaches a handler, so without this a browser whose
    /// request is dropped at the door is indistinguishable from one refused
    /// inside.
    ///
    /// The envelope is unauthenticated and failed validation, so its session
    /// id is reported only when the parser found one the validator admits
    /// (`RefusedEnvelope::SessionRebind`). Without one the rejection is
    /// counted and no event is emitted.
    pub(crate) fn report_envelope_rejected(&mut self, session_id: Option<&str>) {
        Self::increment(&mut self.tallies.envelopes_rejected);
        if let Some(session_id) = session_id {
            self.emit(session_id, "envelope_rejected".to_string(), 0, 0);
        }
    }
}

/// Admit one `session_rebind` frame and answer it.
///
/// Identity checks precede proof verification. The proof gates policy and
/// generation refusals, and ML-KEM encapsulation comes last so an unauthenticated
/// caller can neither learn policy state nor drive encapsulation. This mirrors
/// genesis authentication, which verifies the capability before any KEM work.
pub(crate) async fn handle_session_rebind(
    peer_id: &str,
    request: RebindRequest,
    peers: &mut PeerMap,
    daemon_identity: &Option<DaemonIdentity>,
    daemon_id: &str,
    network_state: &Arc<RwLock<NetworkState>>,
    telemetry: &mut RebindTelemetry,
    control_link_fresh: bool,
    now_ms: f64,
    daemon_static: &[u8],
    candidate: Option<&Arc<crate::edge_candidate::CandidateReply>>,
) -> RebindAdmission {
    // The session the BROWSER asked about, which is the key that joins these
    // outcomes to its own `carrier_recovery` rows. Attacker-controlled in
    // principle, but bounded by the signaling envelope validator, capped in
    // volume by the emit budget, and never used as a metric label.
    let asked_session_id = request.session_id.clone();
    RebindTelemetry::increment(&mut telemetry.tallies.requests);
    let mut refuse = |reason: RebindRefusal| {
        // Wire responses are emitted only by the authenticated refusal path.
        // Every rejection remains observable locally, including bad proofs.
        info!(peer = peer_id, ?reason, "rebind refused");
        RebindTelemetry::increment(&mut telemetry.tallies.refused);
        telemetry.emit(&asked_session_id, reason.metric_key(), request.counter, 0);
        RebindAdmission::Rejected
    };

    let Some(peer) = peers.get_mut(peer_id) else {
        return refuse(RebindRefusal::UnknownPeer);
    };
    if let Some(candidate) = candidate {
        if candidate.is_closed() || candidate.nonce != request.client_nonce {
            return refuse(RebindRefusal::BadProof);
        }
        if peer
            .rebind
            .as_ref()
            .and_then(|r| r.in_flight.as_ref())
            .and_then(|f| f.candidate.as_ref())
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|owner| !Arc::ptr_eq(&owner, candidate) && !owner.is_closed())
        {
            return refuse(RebindRefusal::BadProof);
        }
    }
    let admission = admissible(peer, control_link_fresh, now_ms);
    if !peer.authenticated || peer.rebind.is_none() {
        return refuse(RebindRefusal::NotRebinding);
    }
    if peer.signal_session_id != request.session_id {
        return refuse(RebindRefusal::SessionMismatch);
    }
    // Trust the signaling peer id, not the id the payload claims to be.
    if peer_id != request.browser_node_id {
        return refuse(RebindRefusal::PeerMismatch);
    }

    let rebind = peer.rebind.as_mut().expect("checked above");
    let request_transcript = match crate::e2e::build_rebind_request_transcript(
        &request.session_id,
        &request.browser_node_id,
        daemon_id,
        request.counter,
        &rebind.lineage_digest,
        &request.client_nonce,
        &request.encapsulation_key,
    ) {
        Ok(transcript) => transcript,
        Err(error) => {
            warn!(peer = peer_id, %error, "rebind transcript construction failed");
            return refuse(RebindRefusal::CryptoUnavailable("request_transcript"));
        }
    };

    // Two digests. The PREAMBLE above is what the Noise prologue binds, because
    // message 1 cannot be written until the prologue exists. `bound` is
    // `preamble || msg1`, and it is what the MAC and the replay digest are taken
    // over — so a spliced message 1 fails the MAC and, even if it did not, would
    // resolve to a different digest and never hit the replay path.
    let bound_transcript =
        match crate::e2e::bind_rebind_request_msg1(&request_transcript, &request.noise_msg1) {
            Ok(bound) => bound,
            Err(error) => {
                warn!(peer = peer_id, %error, "rebind msg1 binding failed");
                return refuse(RebindRefusal::CryptoUnavailable("msg1_bind"));
            }
        };

    if crate::e2e::verify_rebind_request_mac(&rebind.secret, &bound_transcript, &request.mac)
        .is_err()
    {
        // An unauthenticated sender has no authority over the live lineage.
        // Admission is bounded by the signaling transport, not a destructive
        // per-session counter an attacker can exhaust for the real owner.
        return refuse(RebindRefusal::BadProof);
    }
    rebind.pending_refusal = None;
    if candidate.is_some()
        && rebind
            .in_flight
            .as_ref()
            .and_then(|f| f.candidate.as_ref())
            .is_some_and(|owner| owner.upgrade().is_none_or(|owner| owner.is_closed()))
    {
        rebind.in_flight = None;
        peer.noise_handshake = None;
    }

    // Defined only after possession has been verified. In particular a forged
    // packet must never obtain a policy oracle or an authenticated denial that
    // an on-path party could substitute for the real browser's request.
    macro_rules! refuse_proven {
        ($reason:expr) => {{
            let reason = $reason;
            let key = reason.metric_key();
            if let Ok(mac) =
                crate::e2e::compute_rebind_refusal_mac(&rebind.secret, &bound_transcript, &key)
            {
                let bytes = DaemonSignal::SessionRebindRefused {
                    reason: key.into(),
                    mac: URL_SAFE_NO_PAD.encode(mac),
                }
                .to_json()
                .into_bytes();
                if !crate::edge_candidate::reply(
                    network_state,
                    peer_id,
                    candidate,
                    bytes.clone(),
                    false,
                )
                .await
                    && candidate.is_none()
                {
                    rebind.pending_refusal = Some(bytes);
                }
            }
            return refuse(reason);
        }};
    }
    if let Err(reason) = admission {
        refuse_proven!(reason);
    }

    // Exact equality, never `>=`. A lower counter is a replay of a spent
    // generation; a higher one is a forgery attempting to skip the fence.
    if request.counter < rebind.counter {
        refuse_proven!(RebindRefusal::StaleGeneration);
    }
    if request.counter > rebind.counter {
        refuse_proven!(RebindRefusal::ForgedGeneration);
    }

    let Some(identity) = daemon_identity.as_ref() else {
        refuse_proven!(RebindRefusal::CryptoUnavailable("identity"));
    };

    let request_digest = match crate::e2e::compute_rebind_request_digest(&bound_transcript) {
        Ok(digest) => digest,
        Err(error) => {
            warn!(peer = peer_id, %error, "rebind digest failed");
            refuse_proven!(RebindRefusal::CryptoUnavailable("request_digest"));
        }
    };

    // An identical request is a retransmission of one whose answer was lost.
    // Replay the stored answer rather than running a second ML-KEM exchange:
    // a fresh ciphertext would derive different successor secrets and strand
    // whichever copy the browser eventually acts on.
    // Built inside the fresh arm and installed after the borrow of `rebind`
    // ends. A replay leaves it `None`: the responder that produced the retained
    // message 2 is already on the peer, and rebuilding would strand it.
    let mut peer_handshake: Option<crate::e2e::NoiseHandshake> = None;
    let replay = rebind
        .in_flight
        .as_mut()
        .filter(|flight| flight.request_digest == request_digest);
    let (daemon_nonce, ciphertext, next_expected_input_seq, noise_msg2) = match replay {
        Some(flight) => (
            flight.daemon_nonce,
            flight.ciphertext.clone(),
            flight.next_expected_input_seq,
            flight.noise_msg2.clone(),
        ),
        None => {
            let daemon_nonce = match identity.generate_random() {
                Ok(nonce) => nonce,
                Err(error) => {
                    warn!(peer = peer_id, %error, "rebind randomness unavailable");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("nonce"));
                }
            };
            let encaps_randomness = match identity.generate_random() {
                Ok(random) => random,
                Err(error) => {
                    warn!(peer = peer_id, %error, "rebind randomness unavailable");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("encaps_randomness"));
                }
            };
            let server = match crate::e2e::RebindServerEncapsulation::new(
                &*request.encapsulation_key,
                encaps_randomness,
            ) {
                Ok(server) => server,
                Err(error) => {
                    warn!(peer = peer_id, %error, "rebind encapsulation failed");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("encapsulation"));
                }
            };
            let ciphertext = Box::new(*server.ciphertext());
            let next_expected_input_seq = peer.keystroke_next_expected_seq;
            let response_transcript = match crate::e2e::build_rebind_response_transcript(
                &bound_transcript,
                &daemon_nonce,
                &ciphertext,
                next_expected_input_seq,
            ) {
                Ok(transcript) => transcript,
                Err(error) => {
                    warn!(peer = peer_id, %error, "rebind response transcript failed");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("response_transcript"));
                }
            };
            let successor = match server.complete(&rebind.secret, &response_transcript) {
                Ok(secrets) => secrets,
                Err(error) => {
                    warn!(peer = peer_id, %error, "rebind combiner failed");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("combiner"));
                }
            };
            // The successor handshake runs HERE, in the same flight, which is
            // the whole point: it costs no round trip of its own. The PSK is
            // the successor's, derived from `RS_n || ml_kem_ss` above, and the
            // prologue binds the REQUEST transcript — the one thing both sides
            // already hold before the daemon has answered.
            let prologue_digest =
                match crate::e2e::hash_rebind_request_transcript(&request_transcript) {
                    Ok(digest) => digest,
                    Err(error) => {
                        warn!(peer = peer_id, %error, "rebind prologue digest failed");
                        refuse_proven!(RebindRefusal::CryptoUnavailable("prologue_digest"));
                    }
                };
            let prologue =
                crate::e2e::derive_prologue(&request.session_id, daemon_id, &prologue_digest);
            let (pending, noise_msg2) = match merkur_e2e::PendingNoiseResponder::start(
                daemon_static,
                &prologue,
                &request.noise_msg1,
            ) {
                Ok(prepared) => prepared,
                Err(error) => {
                    warn!(peer = peer_id, %error, "rebind responder prepare failed");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("responder_prepare"));
                }
            };
            let successor = match successor.bind_noise(pending.checkpoint(), &response_transcript) {
                Ok(secrets) => secrets,
                Err(error) => {
                    warn!(peer = peer_id, %error, "hybrid rebind combiner failed");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("hybrid_combiner"));
                }
            };
            let handshake = match pending.install_psk(successor.noise_psk()) {
                Ok(handshake) => handshake,
                Err(error) => {
                    warn!(peer = peer_id, %error, "rebind PSK installation failed");
                    refuse_proven!(RebindRefusal::CryptoUnavailable("psk_install"));
                }
            };
            // Held, not installed. `RS_n` stays live until the successor Noise
            // handshake completes. The message-2 bytes are retained with it so a
            // verbatim repeat is answered identically rather than with a fresh
            // ephemeral the retained responder could never finish.
            rebind.in_flight = Some(InFlightRebind {
                candidate: candidate.map(Arc::downgrade),
                request_digest,
                daemon_nonce,
                ciphertext: ciphertext.clone(),
                next_expected_input_seq,
                successor,
                noise_msg2: noise_msg2.clone(),
                issued_at_ms: now_ms,
                pending_response: None,
            });
            peer_handshake = Some(handshake);
            (
                daemon_nonce,
                ciphertext,
                next_expected_input_seq,
                noise_msg2,
            )
        }
    };

    let response_transcript = match crate::e2e::build_rebind_response_transcript(
        &bound_transcript,
        &daemon_nonce,
        &ciphertext,
        next_expected_input_seq,
    ) {
        Ok(transcript) => transcript,
        Err(error) => {
            warn!(peer = peer_id, %error, "rebind response transcript failed");
            refuse_proven!(RebindRefusal::CryptoUnavailable("answer_transcript"));
        }
    };
    let mac = match crate::e2e::compute_rebind_response_mac(
        &rebind.secret,
        &response_transcript,
        &noise_msg2,
    ) {
        Ok(mac) => mac,
        Err(error) => {
            warn!(peer = peer_id, %error, "rebind response proof failed");
            refuse_proven!(RebindRefusal::CryptoUnavailable("response_mac"));
        }
    };

    // Install the successor responder. `RS_n` and the derived secrets stay held
    // until the handshake COMPLETES — installing them now would commit the
    // generation on a proof alone, which is exactly the replay this design
    // avoids. A replay leaves `peer_handshake` as `None` and therefore leaves
    // the responder that produced the retained message 2 exactly where it is.
    let lineage_age_ms = (now_ms - rebind.genesis_at_ms).max(0.0);
    let answered_fresh = peer_handshake.is_some();
    if let Some(handshake) = peer_handshake {
        peer.clear_noise_bootstrap_material();
        peer.noise_handshake = Some(crate::connection::PendingNoiseHandshake::new(handshake));
    }
    // Genesis authentication needs an auth timeout because no usable session
    // exists yet. A rebind already has one: its in-flight attempt owns a
    // separate bounded expiry below, and arming the peer-level timeout here
    // would let a failed successor tear down the healthy incumbent later.

    let rebound_bytes = DaemonSignal::SessionRebound {
        daemon_nonce: URL_SAFE_NO_PAD.encode(daemon_nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(&ciphertext[..]),
        next_expected_input_seq: next_expected_input_seq.into(),
        mac: URL_SAFE_NO_PAD.encode(mac),
        noise_msg2: URL_SAFE_NO_PAD.encode(&noise_msg2),
    }
    .to_json()
    .into_bytes();
    let outcome = if !crate::edge_candidate::reply(
        network_state,
        peer_id,
        candidate,
        rebound_bytes.clone(),
        false,
    )
    .await
    {
        // Hold it rather than drop it. There is no lane right now — the old one
        // was removed and its replacement has not registered — but the answer
        // is complete and correct, and `flush_pending_rebind_response` puts it
        // on the wire the moment one exists. Without this the browser reads the
        // silence as a refusal and falls back to full re-authentication, which
        // is the session churn this whole path exists to avoid.
        if candidate.is_none()
            && let Some(flight) = peer.rebind.as_mut().and_then(|r| r.in_flight.as_mut())
        {
            flight.pending_response = Some(rebound_bytes);
        }
        "accepted_held"
    } else {
        if let Some(flight) = peer.rebind.as_mut().and_then(|r| r.in_flight.as_mut()) {
            // Delivered, so nothing is owed. Clearing matters on the retransmit
            // path: an attempt whose first send failed and whose second succeeded
            // must not be flushed a third time by a later lane registration.
            flight.pending_response = None;
        }
        if answered_fresh {
            "accepted"
        } else {
            "accepted_replay"
        }
    };
    info!(
        peer = peer_id,
        generation = request.counter,
        lineage_age_ms,
        "rebind accepted"
    );
    RebindTelemetry::increment(&mut telemetry.tallies.accepted);
    // A replayed flight is answered from the stored ciphertext and costs no
    // ML-KEM work, so it is a different event from deriving an answer even
    // though both put the same bytes on the wire.
    telemetry.emit(&asked_session_id, outcome.to_string(), request.counter, 0);
    RebindAdmission::Accepted
}

/// Put an owed success or authenticated refusal onto a newly registered lane.
/// Neither answer may disappear between the departing lane and its replacement.
/// The peer owns one held refusal and at most one held successful attempt.
///
/// Returns whether anything was sent, so the caller can log a real event rather
/// than a periodic no-op.
pub(crate) async fn flush_pending_rebind_response(
    peer: &mut PeerDisplayState,
    peer_id: &str,
    network_state: &Arc<RwLock<NetworkState>>,
    telemetry: &mut RebindTelemetry,
) -> bool {
    let Some(rebind) = peer.rebind.as_mut() else {
        return false;
    };
    let (pending, is_refusal) = if let Some(pending) = rebind.pending_refusal.take() {
        (pending, true)
    } else if let Some(pending) = rebind
        .in_flight
        .as_mut()
        .and_then(|flight| flight.pending_response.take())
    {
        (pending, false)
    } else {
        return false;
    };
    if !network::send_signaling_to_peer(network_state, peer_id, pending.clone()).await {
        if is_refusal {
            rebind.pending_refusal = Some(pending);
        } else if let Some(flight) = rebind.in_flight.as_mut() {
            flight.pending_response = Some(pending);
        }
        return false;
    }
    info!(
        peer = peer_id,
        "flushed held rebind response onto a new lane"
    );
    telemetry.emit(
        &peer.signal_session_id,
        "response_flushed".to_string(),
        peer.rebind.as_ref().map_or(0, |rebind| rebind.counter),
        0,
    );
    true
}

/// Commit an in-flight rebind once its successor handshake completes.
///
/// A no-op for a genesis authentication, which has no attempt in flight. The
/// generation advances atomically with the secret rotation: leaving the counter
/// behind would make the browser's next request read as a forgery, and
/// advancing it without rotating would strand the chain.
///
/// Returns whether a flight was actually committed, which is what distinguishes
/// a rebind from a genesis authentication at the call site — the caller needs
/// that to re-offer the direct path against the successor upgrade secret.
pub(crate) fn commit_rebind(
    peer: &mut PeerDisplayState,
    peer_id: &str,
    telemetry: &mut RebindTelemetry,
    now_ms: f64,
) -> bool {
    let Some(rebind) = peer.rebind.as_mut() else {
        return false;
    };
    let Some(flight) = rebind.in_flight.take() else {
        return false;
    };
    // Proof-to-commit, the figure a production incident needed and could not
    // get: everything before it is the daemon's work, everything after is the
    // browser's round trip.
    let attempt_ms = (now_ms - flight.issued_at_ms)
        .max(0.0)
        .min(f64::from(u32::MAX)) as u32;
    peer.upgrade_secret = Some(*flight.successor.direct_upgrade_secret());
    let successor_secret = *flight.successor.rebind_secret();
    // Overwrite in place: assigning would drop the predecessor without
    // zeroizing, and this is the byte string the whole lineage rests on.
    rebind.secret.copy_from_slice(&successor_secret);
    rebind.counter = rebind.counter.saturating_add(1);
    rebind.pending_refusal = None;
    if let Some(window) = peer.edge_rebind.as_mut() {
        window.rebinds_used = rebind.counter;
    }
    let generation = rebind.counter;
    info!(peer = peer_id, generation, "rebind committed");
    RebindTelemetry::increment(&mut telemetry.tallies.committed);
    telemetry.emit(
        &peer.signal_session_id,
        "committed".to_string(),
        generation,
        attempt_ms,
    );
    true
}

/// Restore a rebound peer's carrier-scoped state in place.
///
/// The counterpart of `splice_resumed_peer`, and deliberately a different
/// function rather than a flag on it, because the two disagree about what a
/// reconnect *is*. A resume builds a successor session and must therefore open
/// a fresh input-sequence domain, a fresh dictionary, and a fresh display
/// generation. A rebind swaps the carrier under the *same* session: those are
/// unchanged on the browser side, so resetting them here would desynchronize
/// the two ends rather than resynchronize them.
///
/// Preserved on purpose:
///
/// - `latest_input_seq` and the keystroke sequence domain. `splice_resumed_peer`
///   zeroes the confirmed high-water because a successor session restarts the
///   domain; a rebind does not, and zeroing would make every subsequent
///   keystroke read as out-of-domain. It also means replayed input is
///   deduplicated against a counter that never reset, so the window where a
///   rebase could double-apply or drop a keystroke simply does not exist.
/// - The compression dictionary. It lives in the browser's terminal worker,
///   which survives the carrier swap, and it was trained on the grid this
///   rebind is preserving — so discarding it would force a readiness/install/ack
///   round trip and cold compression on exactly the frames the user is waiting
///   for. `carrier_boundary` therefore clears only READINESS, which the browser
///   re-signals once its replacement worker lineage is live. The daemon learns
///   what the peer actually kept from the resume claim: hashes present means it
///   held on, absent means it did not, and `handle_display_resume` discards
///   accordingly. This comment used to claim the preservation while
///   `carrier_boundary` reset it two lines later; the behaviour now matches.
/// - The display generation, cache, and row hashes, so the browser's resume
///   claim can still be answered with repairs instead of a full snapshot.
/// - The edge path's RTT estimates: the daemon-to-edge half is literally the
///   same QUIC connection, so they are a far better prior than the default.
pub(crate) fn splice_rebound_peer(peer: &mut PeerDisplayState, now_ms: f64) {
    // A CPU preparation completion is delivered only to the live generation.
    if peer.cancel_display_prepare() {
        peer.needs_full_diff = true;
    }
    // Retire what the dead carrier was holding, and nothing else. This used to
    // call `next_generation()`, which additionally wiped the display cache and
    // armed a snapshot -- silently contradicting every "preserved on purpose"
    // claim above it and making the `display_cache.initialized` branch at the
    // end of this function dead code. A generation bump is also not what makes
    // a straddling FEC group safe: a repair is pinned by `batch_start_seq`, and
    // keeping the sequence space monotonic across the swap is what makes that
    // identifier unique for the life of the session.
    let disowned_rows = peer.carrier_boundary();

    // This function runs only at successor commit. Until that point both the
    // incumbent Noise transport and every carrier-scoped display/input state
    // remain live; a silent, forged, or abandoned attempt therefore costs no
    // usable session. The caller installs the already-validated successor Noise
    // transport in the same owner-loop turn immediately after this boundary.

    // Out-of-order keystrokes whose predecessors died with the old carrier
    // would otherwise stall input until the reorder timeout while occupying the
    // byte budget. Clearing them is safe precisely because the sequence domain
    // is preserved: the browser retransmits from the point below.
    peer.keystroke_reorder_buf.clear();
    peer.reliable_inputs.clear();
    peer.keystroke_reorder_bytes = 0;

    // All daemon legs are durable. The successor reclaims the data attachments
    // with fresh nonces; dropping the peer's references cannot close the registry
    // owners or add a daemon dial to the browser-rebind critical path.
    peer.edge_tunnel = None;
    peer.edge_tunnel_bulk = None;
    peer.data_attachment_nonces = [None; 2];
    peer.bulk_delivery_confirmed = false;

    // Carrier-scoped congestion history.
    peer.backpressure_score = 0;
    peer.snapshot_retry_at_ms = 0.0;
    peer.snapshot_consecutive_failures = 0;

    // Keep the paired RTT/jitter estimates; reset only availability, or the next liveness
    // tick would read a stale `last_ack_at_ms` and declare the path dead.
    let prior_rtt = peer.paths.edge.rtt_ewma_ms;
    let prior_network_rtt = peer.paths.edge.network_rtt_ewma_ms;
    let prior_network_jitter = peer.paths.edge.network_jitter_ewma_ms;
    let prior_jitter = peer.paths.edge.jitter_ewma_ms;
    peer.paths.edge = crate::connection::PathHealth::fresh_available(now_ms);
    peer.reset_fec_evidence(crate::connection::PeerTransport::Edge);
    peer.paths.edge.rtt_ewma_ms = prior_rtt;
    peer.paths.edge.network_rtt_ewma_ms = prior_network_rtt;
    peer.paths.edge.network_jitter_ewma_ms = prior_network_jitter;
    peer.paths.edge.jitter_ewma_ms = prior_jitter;

    // The window is satisfied; this peer is live again.
    peer.edge_rebind = None;

    if peer.display_cache.initialized {
        // The browser's claim now drives the decision: `handle_display_resume`
        // compares its per-row hashes against the baseline this function just
        // preserved AND against the live grid, and repairs only the rows that
        // match neither. The second comparison is what rescues the
        // `disowned_rows` above: their acked hash is gone, but a row the
        // browser applied before the carrier died still equals the grid.
        info!(
            peer = &*peer.peer_id,
            generation = peer.generation,
            disowned_rows,
            "carrier rebound onto the retained display generation"
        );
        peer.needs_snapshot = false;
        peer.awaiting_resume_until_ms = Some(
            now_ms
                + SessionPolicy::awaiting_resume_timeout_ms(
                    peer.paths.edge.rtt_ewma_ms,
                    peer.paths.edge.jitter_ewma_ms,
                ),
        );
    }
}

/// Drop an in-flight attempt whose successor handshake never arrived.
///
/// The generation and `RS_n` are deliberately left untouched: an abandoned
/// attempt must cost the browser a retry, never the chain.
pub(crate) fn expire_stale_rebind_attempts(
    peers: &mut PeerMap,
    telemetry: &mut RebindTelemetry,
    now_ms: f64,
) {
    for peer in peers.values_mut() {
        let Some(rebind) = peer.rebind.as_mut() else {
            continue;
        };
        let stale = rebind.in_flight.as_ref().is_some_and(|flight| {
            now_ms - flight.issued_at_ms >= SessionPolicy::session_auth_timeout_ms()
        });
        if stale {
            let generation = rebind.counter;
            rebind.in_flight = None;
            peer.noise_handshake = None;
            // Previously the one lifecycle end that left no record at all: an
            // attempt that was derived, answered, and then aged out logged
            // "rebind accepted" and nothing else, so it read as a success.
            telemetry.emit(
                &peer.signal_session_id,
                "attempt_expired".to_string(),
                generation,
                0,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::connection::{PeerTransport, RebindState};
    use crate::session::liveness::{CounterpartDetachAction, classify_counterpart_detach};

    /// A sink for tests that assert on behaviour rather than telemetry.
    ///
    /// The `EventOutput` is dropped immediately, which closes producer
    /// admission — so emits become no-ops rather than blocking. Tests that
    /// assert on the events themselves use `test_capturing_event_sink`.
    fn rebind_sink() -> crate::ipc::events::EventSink {
        let (sink, _output) = crate::ipc::events::test_event_sink();
        sink
    }

    fn rebind_telemetry() -> RebindTelemetry {
        RebindTelemetry::new(rebind_sink())
    }

    const SECRET: [u8; 64] = [0x5c; 64];
    const LINEAGE: [u8; 64] = [0x1d; 64];
    /// A REAL Noise message 1, because the daemon now reads it inside the
    /// fused flight — arbitrary bytes would fail the responder rather than the
    /// property under test. Built against the same preamble prologue the
    /// browser would use.
    fn test_msg1(counter: u64) -> Vec<u8> {
        let preamble = merkur_e2e::build_rebind_request_transcript(
            "session-from-server",
            "browser-node",
            "daemon-node",
            counter,
            &LINEAGE,
            &[0x71; 32],
            &[0x33; 1568],
        )
        .expect("preamble");
        let digest = merkur_e2e::hash_rebind_request_transcript(&preamble).expect("digest");
        let prologue = merkur_e2e::derive_prologue("session-from-server", "daemon-node", &digest);
        let (browser_static, _) = merkur_e2e::generate_static_keypair().expect("browser static");
        let (_pending, msg1) = merkur_e2e::PendingNoiseInitiator::start(&browser_static, &prologue)
            .expect("pending initiator");
        msg1
    }

    fn established_noise_pair() -> (crate::e2e::NoiseTransport, crate::e2e::NoiseTransport) {
        let psk = [0x6au8; merkur_e2e::SESSION_SECRET_BYTES];
        let prologue = b"rebind-incumbent";
        let (browser_static, _) = merkur_e2e::generate_static_keypair().expect("browser static");
        let (daemon_static, _) = merkur_e2e::generate_static_keypair().expect("daemon static");
        let mut browser =
            crate::e2e::NoiseHandshake::new_initiator(&browser_static, &psk, prologue)
                .expect("browser handshake");
        let mut daemon = crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, prologue)
            .expect("daemon handshake");
        daemon
            .read_message(&browser.write_message(b"").expect("message 1"))
            .expect("read message 1");
        browser
            .read_message(&daemon.write_message(b"").expect("message 2"))
            .expect("read message 2");
        daemon
            .read_message(&browser.write_message(b"").expect("message 3"))
            .expect("read message 3");
        (
            daemon.into_transport().expect("daemon transport"),
            browser.into_transport().expect("browser transport"),
        )
    }

    fn request_at(counter: u64) -> RebindRequest {
        RebindRequest {
            session_id: "session-from-server".to_string(),
            browser_node_id: "browser-node".to_string(),
            counter,
            client_nonce: [0x71; 32],
            encapsulation_key: Box::new([0x33; 1568]),
            mac: [0u8; 64],
            noise_msg1: test_msg1(counter),
        }
    }

    /// Successor secrets for an attempt whose exact values do not matter — the
    /// flush tests care about delivery, not about the chain.
    fn test_successor() -> crate::e2e::SessionSecrets {
        let request = merkur_e2e::build_rebind_request_transcript(
            "s",
            "b",
            "d",
            0,
            &LINEAGE,
            &[0x71; 32],
            &[0x33; 1568],
        )
        .unwrap();
        let response =
            merkur_e2e::build_rebind_response_transcript(&request, &[0x55; 32], &[0x44; 1568], 9)
                .unwrap();
        let bootstrap = merkur_e2e::derive_rebind_secrets(&SECRET, &[0x22; 32], &response).unwrap();
        let prologue = merkur_e2e::derive_prologue("s", "d", &[0x12; 64]);
        let browser = merkur_e2e::generate_static_keypair().unwrap().0;
        let daemon = merkur_e2e::generate_static_keypair().unwrap().0;
        let (_, msg1) = merkur_e2e::PendingNoiseInitiator::start(&browser, &prologue).unwrap();
        let (responder, _) =
            merkur_e2e::PendingNoiseResponder::start(&daemon, &prologue, &msg1).unwrap();
        bootstrap
            .bind_noise(responder.checkpoint(), &response)
            .unwrap()
    }

    fn rebindable_peer(now_ms: f64) -> PeerDisplayState {
        let mut peer = PeerDisplayState::new("browser-node".into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.signal_session_id = "session-from-server".to_string();
        peer.display_cache.initialized = true;
        peer.paths.webtransport.available = false;
        peer.rebind = Some(RebindState {
            secret: SECRET,
            counter: 0,
            lineage_digest: LINEAGE,
            genesis_at_ms: now_ms,
            authorization: crate::session::authorization_epoch::AuthorizationEpoch::new(
                crate::auth::unix_time_ms().unwrap()
                    + SessionPolicy::TEST_AUTHORIZATION_LIFETIME_MS,
                [0; 64],
                crate::auth::unix_time_ms().unwrap(),
                now_ms,
            ),
            in_flight: None,
            pending_refusal: None,
        });
        peer.edge_rebind = Some(crate::connection::EdgeRebindWindow {
            deadline_ms: now_ms + SessionPolicy::REBIND_WINDOW_MS as f64,
            rebinds_used: 0,
        });
        peer
    }

    /// A daemon identity that can actually run the KEM and sign, so a test can
    /// drive `handle_session_rebind` all the way to a real answer instead of
    /// stopping at `CryptoUnavailable`.
    /// A real X25519 static for the daemon's Noise responder, which the fused
    /// flight now builds inside `handle_session_rebind`.
    fn test_static() -> Vec<u8> {
        merkur_e2e::generate_static_keypair()
            .expect("static keypair")
            .0
    }

    /// The suite's daemon identity.
    ///
    /// Panics rather than returning `None`. It used to be fallible, and every
    /// MAC-driven test opened by returning early when it was absent — so on a
    /// build without a crypto backend the entire rebind suite passed while
    /// asserting nothing. `merkur-e2e` is an unconditional dependency, not a
    /// feature, so this cannot fail in a workspace `cargo test`; a build where
    /// it could is one that cannot verify rebind at all, and it should say so
    /// loudly instead of going green.
    fn test_identity() -> DaemonIdentity {
        use base64::Engine;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        DaemonIdentity::new(
            &URL_SAFE_NO_PAD.encode([0x33; merkur_e2e::DAEMON_IDENTITY_SEED_BYTES]),
            "daemon-node",
        )
        .expect("the rebind suite requires a crypto backend")
    }

    /// A request whose MAC is genuinely valid under `SECRET`, which is what the
    /// answer path requires. `request_at` alone carries a zero MAC and is only
    /// good for the checks that run before the proof.
    fn signed_request_at(counter: u64) -> RebindRequest {
        let mut request = request_at(counter);
        let preamble = merkur_e2e::build_rebind_request_transcript(
            &request.session_id,
            &request.browser_node_id,
            "daemon-node",
            counter,
            &LINEAGE,
            &request.client_nonce,
            &request.encapsulation_key,
        )
        .expect("request preamble");
        let bound = merkur_e2e::bind_rebind_request_msg1(&preamble, &request.noise_msg1)
            .expect("bound request transcript");
        request.mac = merkur_e2e::compute_rebind_request_mac(&SECRET, &bound).expect("request mac");
        request
    }

    /// THE instrument for any change to the rebind flights.
    ///
    /// The browser re-sends flight 1 VERBATIM when the edge announces the
    /// daemon attached, and `flush_pending_rebind_response` can put a held
    /// answer on a later lane — so two answers for one request is an expected,
    /// documented state, not an edge case. The answer must therefore be a pure
    /// function of stored state and byte-identical on every repeat.
    ///
    /// This is exactly the property a pipelined Noise handshake would break: a
    /// responder draws a fresh ephemeral, so a re-answered flight would carry a
    /// different message 2, the browser would complete against one while the
    /// daemon retained the other, and the handshake would fail on precisely the
    /// lossy path rebind exists to remove. Any such change must keep this test
    /// green by retaining the responder and its message bytes.
    #[tokio::test]
    async fn a_repeated_flight_is_answered_identically() {
        let identity = Some(test_identity());
        let mut peers = HashMap::new();
        peers.insert("browser-node".into(), rebindable_peer(0.0));
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        // A lane, so the answer actually goes out rather than entering the
        // accepted-but-held lifecycle state.
        let (capture_tx, mut captured) = tokio::sync::mpsc::unbounded_channel();
        network::register_edge_signaling(
            &network_state,
            "browser-node",
            Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(capture_tx)),
        )
        .await;

        // ONE request, sent twice. `signed_request_at` draws a fresh Noise
        // ephemeral, so calling it again would be a different flight, not a
        // retransmission of this one.
        let sent = signed_request_at(0);
        let first = handle_session_rebind(
            "browser-node",
            sent.clone(),
            &mut peers,
            &identity,
            "daemon-node",
            &network_state,
            &mut rebind_telemetry(),
            true,
            0.0,
            &test_static(),
            None,
        )
        .await;
        assert_eq!(first, RebindAdmission::Accepted);
        let first_bytes = captured.recv().await.expect("the answer went out");

        let flight = peers["browser-node"]
            .rebind
            .as_ref()
            .and_then(|rebind| rebind.in_flight.as_ref())
            .expect("an accepted rebind holds its answer");
        let first_nonce = flight.daemon_nonce;
        let first_ciphertext = flight.ciphertext.clone();
        let first_digest = flight.request_digest;

        // The incumbent remains usable until the successor commits. Input can
        // therefore advance after the first answer but before its retransmission.
        peers
            .get_mut("browser-node")
            .expect("incumbent")
            .keystroke_next_expected_seq += 1;

        // The same bytes again, exactly as `handleSpliceControl` re-sends them.
        let second = handle_session_rebind(
            "browser-node",
            sent,
            &mut peers,
            &identity,
            "daemon-node",
            &network_state,
            &mut rebind_telemetry(),
            true,
            0.0,
            &test_static(),
            None,
        )
        .await;
        assert_eq!(second, RebindAdmission::Accepted);
        let second_bytes = captured.recv().await.expect("the answer went out again");
        assert_eq!(
            first_bytes, second_bytes,
            "the wire bytes must be identical, not merely equivalent: the browser \
             may act on either copy"
        );

        let replayed = peers["browser-node"]
            .rebind
            .as_ref()
            .and_then(|rebind| rebind.in_flight.as_ref())
            .expect("the answer is still held");
        assert_eq!(
            replayed.request_digest, first_digest,
            "an identical request must resolve to the same digest"
        );
        assert_eq!(
            replayed.daemon_nonce, first_nonce,
            "a fresh nonce would derive different successor secrets and strand \
             whichever copy the browser acted on"
        );
        assert_eq!(
            &replayed.ciphertext, &first_ciphertext,
            "a second encapsulation would do the same"
        );
    }

    #[tokio::test]
    async fn expired_lineage_answers_only_an_authenticated_exact_request() {
        for hold_response in [false, true] {
            let identity = Some(test_identity());
            let mut peers = HashMap::new();
            let mut peer = rebindable_peer(0.0);
            let (daemon_noise, _browser_noise) = established_noise_pair();
            peer.noise = Some(daemon_noise);
            peers.insert("browser-node".into(), peer);
            let network_state = Arc::new(RwLock::new(NetworkState::new()));
            let (tx, mut captured) = tokio::sync::mpsc::unbounded_channel();
            if !hold_response {
                network::register_edge_signaling(
                    &network_state,
                    "browser-node",
                    Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx.clone())),
                )
                .await;
            }
            let request = signed_request_at(0);
            let mut forged = request.clone();
            forged.mac[0] ^= 1;
            let now_ms = SessionPolicy::TEST_AUTHORIZATION_LIFETIME_MS as f64;
            assert_eq!(
                handle_session_rebind(
                    "browser-node",
                    forged,
                    &mut peers,
                    &identity,
                    "daemon-node",
                    &network_state,
                    &mut rebind_telemetry(),
                    true,
                    now_ms,
                    &test_static(),
                    None
                )
                .await,
                RebindAdmission::Rejected
            );
            assert!(captured.try_recv().is_err());

            assert_eq!(
                handle_session_rebind(
                    "browser-node",
                    request.clone(),
                    &mut peers,
                    &identity,
                    "daemon-node",
                    &network_state,
                    &mut rebind_telemetry(),
                    true,
                    now_ms,
                    &test_static(),
                    None
                )
                .await,
                RebindAdmission::Rejected
            );
            if hold_response {
                assert!(captured.try_recv().is_err());
                let peer = peers.get_mut("browser-node").unwrap();
                assert!(peer.rebind.as_ref().unwrap().pending_refusal.is_some());
                assert!(
                    !flush_pending_rebind_response(
                        peer,
                        "browser-node",
                        &network_state,
                        &mut rebind_telemetry()
                    )
                    .await
                );
                network::register_edge_signaling(
                    &network_state,
                    "browser-node",
                    Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)),
                )
                .await;
                assert!(
                    flush_pending_rebind_response(
                        peer,
                        "browser-node",
                        &network_state,
                        &mut rebind_telemetry()
                    )
                    .await
                );
                assert!(
                    !flush_pending_rebind_response(
                        peer,
                        "browser-node",
                        &network_state,
                        &mut rebind_telemetry()
                    )
                    .await
                );
            }
            let (_, bytes) = captured
                .try_recv()
                .expect("refusal sent in the admitting turn");
            let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(response["type"], "session_rebind_refused");
            assert_eq!(response["reason"], "lineage_expired");
            let preamble = crate::e2e::build_rebind_request_transcript(
                &request.session_id,
                &request.browser_node_id,
                "daemon-node",
                request.counter,
                &LINEAGE,
                &request.client_nonce,
                &request.encapsulation_key,
            )
            .unwrap();
            let bound =
                crate::e2e::bind_rebind_request_msg1(&preamble, &request.noise_msg1).unwrap();
            let mac = URL_SAFE_NO_PAD
                .decode(response["mac"].as_str().unwrap())
                .unwrap();
            assert!(
                crate::e2e::verify_rebind_refusal_mac(&SECRET, &bound, "lineage_expired", &mac)
                    .is_ok()
            );
            let peer = &peers["browser-node"];
            assert!(peer.noise.is_some(), "refusal preserves incumbent");
            assert!(peer.rebind.as_ref().unwrap().in_flight.is_none());
        }
    }

    #[tokio::test]
    async fn a_replayed_held_answer_completes_noise_after_input_advances() {
        let identity = Some(test_identity());
        let daemon_static = test_static();
        let mut peers = PeerMap::from([("browser-node".into(), rebindable_peer(0.0))]);
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let mut telemetry = rebind_telemetry();
        let client = merkur_e2e::RebindClientBootstrap::new([0x15; 64]);
        let mut request = request_at(0);
        *request.encapsulation_key = *client.encapsulation_key();
        let preamble = merkur_e2e::build_rebind_request_transcript(
            &request.session_id,
            &request.browser_node_id,
            "daemon-node",
            request.counter,
            &LINEAGE,
            &request.client_nonce,
            &request.encapsulation_key,
        )
        .expect("request preamble");
        let digest = merkur_e2e::hash_rebind_request_transcript(&preamble).expect("digest");
        let prologue = merkur_e2e::derive_prologue(&request.session_id, "daemon-node", &digest);
        let (browser_static, _) = merkur_e2e::generate_static_keypair().expect("browser static");
        let (pending_browser, msg1) =
            merkur_e2e::PendingNoiseInitiator::start(&browser_static, &prologue)
                .expect("pending browser");
        request.noise_msg1 = msg1;
        let bound = merkur_e2e::bind_rebind_request_msg1(&preamble, &request.noise_msg1)
            .expect("bound request");
        request.mac = merkur_e2e::compute_rebind_request_mac(&SECRET, &bound).expect("request MAC");

        for next_expected in [1, 2] {
            // A queued incumbent PTY write completes between the two requests.
            peers
                .get_mut("browser-node")
                .expect("peer")
                .keystroke_next_expected_seq = next_expected;
            assert_eq!(
                handle_session_rebind(
                    "browser-node",
                    request.clone(),
                    &mut peers,
                    &identity,
                    "daemon-node",
                    &network_state,
                    &mut telemetry,
                    true,
                    f64::from(next_expected),
                    &daemon_static,
                    None
                )
                .await,
                RebindAdmission::Accepted,
            );
        }

        let (capture_tx, mut captured) = tokio::sync::mpsc::unbounded_channel();
        network::register_edge_signaling(
            &network_state,
            "browser-node",
            Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(capture_tx)),
        )
        .await;
        let peer = peers.get_mut("browser-node").expect("peer");
        assert!(
            flush_pending_rebind_response(peer, "browser-node", &network_state, &mut telemetry)
                .await
        );
        let (_, answer) = captured.try_recv().expect("held answer delivered");
        let response: serde_json::Value = serde_json::from_slice(&answer).expect("response JSON");
        let decode = |field: &str| {
            URL_SAFE_NO_PAD
                .decode(response[field].as_str().expect("base64 field"))
                .expect("base64 bytes")
        };
        let daemon_nonce = decode("daemon_nonce").try_into().expect("nonce length");
        let ciphertext = decode("ciphertext").try_into().expect("ciphertext length");
        let next_expected = u32::try_from(
            response["next_expected_input_seq"]
                .as_u64()
                .expect("input sequence"),
        )
        .expect("u32 sequence");
        let response_transcript = merkur_e2e::build_rebind_response_transcript(
            &bound,
            &daemon_nonce,
            &ciphertext,
            next_expected,
        )
        .expect("response transcript");
        merkur_e2e::verify_rebind_response_mac(
            &SECRET,
            &response_transcript,
            &decode("noise_msg2"),
            &decode("mac"),
        )
        .expect("complete wire answer authenticates");
        let successor = client
            .complete(
                &SECRET,
                &ciphertext,
                &response_transcript,
                &decode("noise_msg2"),
                &decode("mac"),
            )
            .expect("browser verifies response MAC and decapsulates");
        let pending_browser = pending_browser
            .read_authenticated_msg2(&decode("noise_msg2"))
            .expect("browser message 2");
        let successor = successor
            .bind_noise(pending_browser.checkpoint(), &response_transcript)
            .expect("browser hybrid secrets");
        let mut browser = pending_browser
            .install_psk(successor.noise_psk())
            .expect("browser PSK");
        let msg3 = browser.write_message(&[]).expect("browser completes Noise");
        let mut responder = peer
            .noise_handshake
            .take()
            .expect("retained responder")
            .handshake;
        responder
            .read_message(&msg3)
            .expect("replayed answer must agree with the retained responder's PSK");
        assert_eq!(
            next_expected, 1,
            "the response retains its original resync point"
        );
        assert_eq!(
            peer.keystroke_next_expected_seq, 2,
            "live input is not rewound"
        );
        assert_eq!(peer.rebind.as_ref().expect("lineage").counter, 0);
        assert!(commit_rebind(peer, "browser-node", &mut telemetry, 3.0));
        let rebind = peer.rebind.as_ref().expect("lineage");
        assert_eq!(rebind.counter, 1);
        assert!(
            rebind.secret == *successor.rebind_secret(),
            "successor chain agrees"
        );
        assert!(peer.upgrade_secret == Some(*successor.direct_upgrade_secret()));
        let mut browser = browser.into_transport().expect("browser transport");
        let mut daemon = responder.into_transport().expect("daemon transport");
        let lane =
            crate::e2e::lane_for_channel(crate::network::protocol::CHANNEL_PTY).expect("PTY lane");
        let sealed = browser.seal_stream(lane, b"after rebind").expect("seal");
        assert_eq!(
            daemon.open_stream(lane, &sealed).expect("open"),
            b"after rebind"
        );
    }

    /// Replaying a cached answer performs no KEM work and never consumes an
    /// allowance that packet loss could exhaust before the owner commits.
    #[tokio::test]
    async fn repeated_identical_requests_do_not_exhaust_the_attempt() {
        let identity = Some(test_identity());
        let mut peers = HashMap::new();
        peers.insert("browser-node".into(), rebindable_peer(0.0));
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        // Without a lane every call would report `Rejected` for the wrong
        // reason and this would pass vacuously.
        let (capture_tx, _captured) = tokio::sync::mpsc::unbounded_channel();
        network::register_edge_signaling(
            &network_state,
            "browser-node",
            Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(capture_tx)),
        )
        .await;

        let sent = signed_request_at(0);
        let mut last = RebindAdmission::Rejected;
        for _ in 0..20 {
            last = handle_session_rebind(
                "browser-node",
                sent.clone(),
                &mut peers,
                &identity,
                "daemon-node",
                &network_state,
                &mut rebind_telemetry(),
                true,
                0.0,
                &test_static(),
                None,
            )
            .await;
        }
        assert_eq!(
            last,
            RebindAdmission::Accepted,
            "an exact retransmission reuses the held cryptographic answer"
        );
    }

    /// A forged MAC must never reach the KEM or alter the owner's lineage.
    #[tokio::test]
    async fn bad_proofs_preserve_the_lineage_and_the_next_valid_request() {
        let identity = Some(test_identity());
        let mut peers = HashMap::new();
        peers.insert("browser-node".into(), rebindable_peer(0.0));
        let network_state = Arc::new(RwLock::new(NetworkState::new()));

        for _ in 0..20 {
            let mut forged = signed_request_at(0);
            forged.mac[0] ^= 0xff;
            assert_eq!(
                handle_session_rebind(
                    "browser-node",
                    forged,
                    &mut peers,
                    &identity,
                    "daemon-node",
                    &network_state,
                    &mut rebind_telemetry(),
                    true,
                    0.0,
                    &test_static(),
                    None
                )
                .await,
                RebindAdmission::Rejected
            );
        }

        let rebind = peers["browser-node"].rebind.as_ref().unwrap();
        assert_eq!(rebind.secret, SECRET);
        assert_eq!(rebind.counter, 0);
        assert!(rebind.in_flight.is_none());
        assert_eq!(
            handle_session_rebind(
                "browser-node",
                signed_request_at(0),
                &mut peers,
                &identity,
                "daemon-node",
                &network_state,
                &mut rebind_telemetry(),
                true,
                0.0,
                &test_static(),
                None
            )
            .await,
            RebindAdmission::Accepted
        );
    }

    #[test]
    fn a_live_direct_carrier_makes_a_browser_departure_a_non_event() {
        let mut peer = rebindable_peer(0.0);
        peer.paths.webtransport.available = true;
        assert_eq!(
            classify_counterpart_detach(&peer, 0.0),
            CounterpartDetachAction::Ignore
        );
    }

    #[test]
    fn a_peer_with_nothing_worth_keeping_is_retired_not_held() {
        let mut peer = rebindable_peer(0.0);
        peer.display_cache.initialized = false;
        assert_eq!(
            classify_counterpart_detach(&peer, 0.0),
            CounterpartDetachAction::Retire
        );

        let mut peer = rebindable_peer(0.0);
        peer.authenticated = false;
        assert_eq!(
            classify_counterpart_detach(&peer, 0.0),
            CounterpartDetachAction::Retire
        );
    }

    /// Both authorization bounds must fall back to today's behaviour rather
    /// than failing the reconnect: a rebind is an optimization, and every route
    /// that abandons it lands on the park/resume path that already exists.
    #[test]
    fn an_expired_or_exhausted_epoch_is_retained_for_renewal() {
        let peer = rebindable_peer(0.0);
        assert_eq!(
            classify_counterpart_detach(&peer, 0.0),
            CounterpartDetachAction::Rebind
        );
        assert_eq!(
            classify_counterpart_detach(
                &peer,
                SessionPolicy::TEST_AUTHORIZATION_LIFETIME_MS as f64
            ),
            CounterpartDetachAction::Rebind
        );

        let mut spent = rebindable_peer(0.0);
        spent.rebind.as_mut().expect("lineage").counter = SessionPolicy::MAX_REBIND_GENERATIONS;
        spent.edge_rebind.as_mut().expect("window").rebinds_used =
            SessionPolicy::MAX_REBIND_GENERATIONS;
        assert_eq!(
            classify_counterpart_detach(&spent, 0.0),
            CounterpartDetachAction::Rebind
        );

        let mut no_lineage = rebindable_peer(0.0);
        no_lineage.rebind = None;
        assert_eq!(
            classify_counterpart_detach(&no_lineage, 0.0),
            CounterpartDetachAction::Park
        );
    }

    /// A rebind is the one recovery path that never consults the server, which
    /// makes the daemon the sole enforcement point for a delegation revoked
    /// while the browser was away. A control link too stale to have received
    /// those tombstones must fail closed to full authentication.
    #[test]
    fn a_stale_control_link_refuses_rebind() {
        let peer = rebindable_peer(0.0);
        assert_eq!(admissible(&peer, true, 0.0), Ok(()));
        assert_eq!(
            admissible(&peer, false, 0.0),
            Err(RebindRefusal::ControlLinkStale)
        );
    }

    /// The window is resource management, not authentication. On a short
    /// outage the browser detects the loss and returns before the edge has even
    /// reported it gone, so gating admission on an armed window would refuse
    /// exactly the case the fast path exists for.
    #[test]
    fn a_peer_with_no_window_armed_is_still_rebindable() {
        let mut peer = rebindable_peer(0.0);
        peer.edge_rebind = None;
        assert_eq!(admissible(&peer, true, 0.0), Ok(()));
    }

    #[test]
    fn an_unauthenticated_peer_is_refused_but_a_direct_incumbent_is_preserved() {
        let mut unauthenticated = rebindable_peer(0.0);
        unauthenticated.authenticated = false;
        assert_eq!(
            admissible(&unauthenticated, true, 0.0),
            Err(RebindRefusal::NotRebinding)
        );

        let mut direct = rebindable_peer(0.0);
        direct.paths.webtransport.available = true;
        assert_eq!(admissible(&direct, true, 0.0), Ok(()));
    }

    /// The counter is the generation fence, so it is checked for exact
    /// equality. `>=` would let a forged higher generation skip the fence, and
    /// accepting a lower one would replay a spent generation.
    #[test]
    fn commit_advances_the_generation_and_rotates_the_secret() {
        let mut peer = rebindable_peer(0.0);
        let successor = test_successor();
        let rotated = *successor.rebind_secret();
        let upgrade = *successor.direct_upgrade_secret();

        peer.rebind.as_mut().expect("lineage").in_flight = Some(InFlightRebind {
            candidate: None,
            request_digest: [0u8; 64],
            daemon_nonce: [0x55; 32],
            ciphertext: Box::new([0x44; 1568]),
            next_expected_input_seq: 9,
            successor,
            noise_msg2: Vec::new(),
            issued_at_ms: 0.0,
            pending_response: None,
        });

        commit_rebind(&mut peer, "browser-node", &mut rebind_telemetry(), 0.0);
        let rebind = peer.rebind.as_ref().expect("lineage");
        assert_eq!(rebind.counter, 1, "the generation advances exactly once");
        assert_eq!(&rebind.secret, &rotated, "the chain ratchets forward");
        assert_ne!(&rebind.secret, &SECRET, "the predecessor is gone");
        assert!(rebind.in_flight.is_none());
        assert_eq!(peer.upgrade_secret, Some(upgrade));
    }

    /// The production failure: the answer was derived and then dropped because
    /// there was no lane at that instant, and the browser — for which silence
    /// IS a refusal — spent its attempt budget and fell back to full
    /// re-authentication.
    #[tokio::test]
    async fn a_held_answer_is_delivered_when_a_lane_appears() {
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let mut peer = rebindable_peer(0.0);
        peer.rebind.as_mut().expect("lineage").in_flight = Some(InFlightRebind {
            candidate: None,
            request_digest: [0u8; 64],
            daemon_nonce: [0x55; 32],
            ciphertext: Box::new([0x44; 1568]),
            next_expected_input_seq: 9,
            successor: test_successor(),
            noise_msg2: Vec::new(),
            issued_at_ms: 0.0,
            pending_response: Some(b"{\"type\":\"session_rebound\"}".to_vec()),
        });

        // No lane yet: nothing can go out, and the answer must survive to be
        // sent rather than be consumed by the failed attempt.
        assert!(
            !flush_pending_rebind_response(
                &mut peer,
                "browser-node",
                &network_state,
                &mut rebind_telemetry()
            )
            .await,
            "with no lane there is nothing to flush onto",
        );

        let (capture_tx, mut captured) = tokio::sync::mpsc::unbounded_channel();
        network::register_edge_signaling(
            &network_state,
            "browser-node",
            Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(capture_tx)),
        )
        .await;

        assert!(
            flush_pending_rebind_response(
                &mut peer,
                "browser-node",
                &network_state,
                &mut rebind_telemetry()
            )
            .await,
            "registration is the signal that the held answer can be delivered",
        );
        assert!(
            captured.try_recv().is_ok(),
            "the held answer reached the lane"
        );

        // Exactly once. A second registration must not re-send an answer the
        // browser has already acted on.
        assert!(
            !flush_pending_rebind_response(
                &mut peer,
                "browser-node",
                &network_state,
                &mut rebind_telemetry()
            )
            .await,
            "a delivered answer is not owed again",
        );
    }

    #[tokio::test]
    async fn nothing_is_owed_when_no_rebind_is_in_flight() {
        // The common case by far — this runs on every lane registration, so it
        // must be inert for a peer that never rebound.
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let mut peer = rebindable_peer(0.0);
        assert!(
            !flush_pending_rebind_response(
                &mut peer,
                "browser-node",
                &network_state,
                &mut rebind_telemetry()
            )
            .await
        );
    }

    #[test]
    fn commit_is_a_no_op_for_a_genesis_authentication() {
        let mut peer = rebindable_peer(0.0);
        commit_rebind(&mut peer, "browser-node", &mut rebind_telemetry(), 0.0);
        let rebind = peer.rebind.as_ref().expect("lineage");
        assert_eq!(rebind.counter, 0);
        assert_eq!(&rebind.secret, &SECRET);
    }

    /// An abandoned attempt must cost a retry, never the chain: `RS_n` and the
    /// generation both survive so the browser can simply try again.
    #[test]
    fn an_abandoned_attempt_expires_without_touching_the_chain() {
        let mut peers = HashMap::new();
        let mut peer = rebindable_peer(0.0);
        peer.rebind.as_mut().expect("lineage").in_flight = Some(InFlightRebind {
            candidate: None,
            request_digest: [0u8; 64],
            daemon_nonce: [0x55; 32],
            ciphertext: Box::new([0x44; 1568]),
            next_expected_input_seq: 9,
            successor: test_successor(),
            noise_msg2: Vec::new(),
            issued_at_ms: 0.0,
            pending_response: None,
        });
        peers.insert("browser-node".into(), peer);

        expire_stale_rebind_attempts(&mut peers, &mut rebind_telemetry(), 1.0);
        assert!(
            peers["browser-node"]
                .rebind
                .as_ref()
                .expect("lineage")
                .in_flight
                .is_some(),
            "a fresh attempt is not stale"
        );

        expire_stale_rebind_attempts(
            &mut peers,
            &mut rebind_telemetry(),
            SessionPolicy::session_auth_timeout_ms(),
        );
        let rebind = peers["browser-node"].rebind.as_ref().expect("lineage");
        assert!(rebind.in_flight.is_none(), "the attempt is dropped");
        assert_eq!(rebind.counter, 0, "the generation does not advance");
        assert_eq!(&rebind.secret, &SECRET, "the chaining secret survives");
    }

    /// Parking is the end of the fast path, not a pause in it: a parked peer
    /// has no tunnel and no rendezvous, so retaining the secret would leave it
    /// in memory for the half-hour that state lives, unusable.
    /// The window must survive the browser re-attaching at the edge, because
    /// the rebind request arrives on that very carrier and admission requires
    /// the window to still be armed. Disarming on an unauthenticated signal
    /// would make the fast path race itself into a full re-authentication.
    #[test]
    fn re_attachment_alone_does_not_close_the_window() {
        let mut peers = HashMap::new();
        let mut peer = rebindable_peer(0.0);
        // The capture tunnel reports its counterpart Attached, which is the
        // state a returning browser produces.
        let (capture_tx, _capture_rx) = tokio::sync::mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
            capture_tx,
        )));
        peers.insert("browser-node".into(), peer);
        crate::session::liveness::reconcile_rebind_windows_for_test(&mut peers, 1.0);
        assert!(
            peers["browser-node"].is_rebinding(),
            "only a proven rebind or the deadline closes the window"
        );
    }

    /// The generation counter is the fence that replaces the server's one-use
    /// capability, so it is checked for exact equality in both directions. A
    /// `>=` here would let a forged higher generation skip the fence entirely,
    /// and accepting a lower one would replay a spent generation.
    #[tokio::test]
    async fn the_generation_fence_rejects_both_stale_and_forged_counters() {
        let mut peers = HashMap::new();
        peers.insert("browser-node".into(), rebindable_peer(0.0));
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let identity = None;

        for counter in [1u64, 7] {
            let outcome = handle_session_rebind(
                "browser-node",
                request_at(counter),
                &mut peers,
                &identity,
                "daemon-node",
                &network_state,
                &mut rebind_telemetry(),
                true,
                0.0,
                &test_static(),
                None,
            )
            .await;
            assert_eq!(
                outcome,
                RebindAdmission::Rejected,
                "a counter of {counter} against generation 0 must be refused"
            );
        }

        // And the refusal must not have disturbed the lineage: an attacker
        // guessing counters cannot spend the chaining secret or advance past it.
        let rebind = peers["browser-node"].rebind.as_ref().expect("lineage");
        assert_eq!(rebind.counter, 0);
        assert_eq!(&rebind.secret, &SECRET);
        assert!(rebind.in_flight.is_none());
    }

    /// A peer the daemon has never heard of, or one whose payload claims a
    /// different identity than the carrier it arrived on, is refused before any
    /// state is touched.
    #[tokio::test]
    async fn identity_is_taken_from_the_carrier_not_the_payload() {
        let mut peers = HashMap::new();
        peers.insert("browser-node".into(), rebindable_peer(0.0));
        let network_state = Arc::new(RwLock::new(NetworkState::new()));
        let identity = None;

        let mut impostor = request_at(0);
        impostor.browser_node_id = "someone-else".to_string();
        assert_eq!(
            handle_session_rebind(
                "browser-node",
                impostor,
                &mut peers,
                &identity,
                "daemon-node",
                &network_state,
                &mut rebind_telemetry(),
                true,
                0.0,
                &test_static(),
                None
            )
            .await,
            RebindAdmission::Rejected
        );

        assert_eq!(
            handle_session_rebind(
                "unknown-peer",
                request_at(0),
                &mut peers,
                &identity,
                "daemon-node",
                &network_state,
                &mut rebind_telemetry(),
                true,
                0.0,
                &test_static(),
                None
            )
            .await,
            RebindAdmission::Rejected
        );
    }

    #[test]
    fn parking_destroys_the_lineage() {
        let mut peer = rebindable_peer(0.0);
        peer.clear_rebind_material();
        assert!(peer.rebind.is_none());
        assert!(peer.edge_rebind.is_none());
        assert!(!peer.is_rebinding());
    }

    #[test]
    fn rebound_edge_preserves_paired_network_estimates() {
        let mut peer = rebindable_peer(0.0);
        peer.paths.edge.network_rtt_ewma_ms = 120.0;
        peer.paths.edge.network_jitter_ewma_ms = 9.0;
        peer.paths.edge.rtt_ewma_ms = 190.0;
        peer.paths.edge.jitter_ewma_ms = 31.0;
        splice_rebound_peer(&mut peer, 1_000.0);
        assert_eq!(peer.paths.edge.network_rtt_ewma_ms, 120.0);
        assert_eq!(peer.paths.edge.network_jitter_ewma_ms, 9.0);
        assert_eq!(peer.paths.edge.rtt_ewma_ms, 190.0);
        assert_eq!(peer.paths.edge.jitter_ewma_ms, 31.0);
        assert!(peer.paths.edge.available);
        assert_eq!(peer.paths.edge.last_ack_at_ms, 1_000.0);
    }

    /// The regression this whole change exists for.
    ///
    /// `splice_rebound_peer` documents at length that the display generation,
    /// cache and row hashes are preserved so the browser's resume claim can be
    /// answered with repairs. It called `next_generation()`, which preserved
    /// none of them, so every carrier swap cost a full-screen snapshot -- 27 of
    /// 31 measured reconnects. The claim carries the generation the browser
    /// last applied, and only an unchanged generation can match it.
    #[test]
    fn a_carrier_swap_keeps_the_generation_so_the_browser_claim_still_matches() {
        use crate::connection::PeerTransport;
        use merkur_codec::CellRepr;

        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 7;
        peer.display_cache.resize(2, 2);
        let grid = vec![CellRepr::BLANK; 4];
        peer.display_cache
            .prime_from_snapshot(&grid, &[11, 22], &[]);
        peer.next_datagram_seq = 40;
        peer.next_frame_id = 12;
        assert!(peer.display_cache.initialized);

        splice_rebound_peer(&mut peer, 1_000.0);

        assert_eq!(
            peer.generation, 7,
            "a carrier swap is the same screen over a different pipe"
        );
        assert!(
            peer.display_cache.initialized,
            "the baseline is what the resume comparison reads"
        );
        assert_eq!(
            peer.display_cache.acked_row_hashes.as_slice(),
            &[11, 22],
            "the browser still has these rows on screen"
        );
        assert!(
            !peer.needs_snapshot,
            "a matched claim is repaired, not repainted"
        );
        assert!(
            peer.awaiting_resume_until_ms.is_some(),
            "the resume claim drives the decision, so it must be waited for"
        );
        // Monotonic across the swap. Restarting these inside a live generation
        // would read on the browser as duplicate, wildly reordered frames, and
        // would collide FEC groups that are pinned by `batch_start_seq`.
        assert_eq!(peer.next_datagram_seq, 40);
        assert_eq!(peer.next_frame_id, 12);
    }

    /// Carrier-scoped display readiness is retired only at commit, while the
    /// predecessor sealing context survives until the caller installs its
    /// already-validated successor in the same owner-loop turn.
    ///
    /// The browser's session-epoch fence runs on every authenticated session,
    /// a rebound one included, and unconditionally clears its compression
    /// dictionaries. Keeping ours would compress against bytes the peer just
    /// discarded. Noise has the opposite boundary: dropping it at admission
    /// makes a failed rebind destroy a healthy incumbent.
    #[test]
    fn a_committed_carrier_swap_retires_readiness_without_preempting_noise() {
        use crate::connection::PeerTransport;
        use crate::display::compressor::DISPLAY_DICTIONARY_MIN_BYTES;
        use merkur_codec::CellRepr;

        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 5;
        peer.display_dictionary_ready = true;
        peer.display_cache.resize(2, 2);
        let grid = vec![CellRepr::BLANK; 4];
        peer.display_cache
            .prime_from_snapshot(&grid, &[11, 22], &[]);
        // A REAL install, so this pins behaviour rather than passing vacuously:
        // a peer with no dictionary has no wire state to keep or drop, and an
        // assertion about it says nothing either way.
        peer.dictionary
            .build_next(5, vec![7u8; DISPLAY_DICTIONARY_MIN_BYTES])
            .expect("dictionary install");
        assert!(peer.dictionary.has_wire_state());
        let (incumbent, _browser) = established_noise_pair();
        peer.noise = Some(incumbent);

        // A REAL successor responder, installed exactly as the fused rebind
        // flight installs it, so the assertion below cannot pass vacuously on a
        // peer that never had one.
        peer.noise_handshake = Some(crate::connection::PendingNoiseHandshake::new(
            crate::e2e::NoiseHandshake::new_responder(
                &test_static(),
                &[0x5a; merkur_e2e::SESSION_SECRET_BYTES],
                b"prologue",
            )
            .expect("successor responder"),
        ));
        splice_rebound_peer(&mut peer, 1_000.0);

        assert!(
            !peer.display_dictionary_ready,
            "readiness describes the peer's possession of a live install on THIS \
             carrier, and the browser re-signals it once its replacement worker \
             lineage is up"
        );
        assert!(
            peer.dictionary.has_wire_state(),
            "the dictionary was trained on the grid this rebind preserves, so \
             dropping it would cost a readiness/install/ack exchange and cold \
             compression on exactly the repair rows the user is waiting for. \
             `handle_display_resume` retires it if the peer's claim says it kept \
             no grid."
        );
        assert!(
            peer.noise.is_some(),
            "the incumbent is retired only when the caller installs the already-validated successor"
        );
        assert!(
            peer.noise_handshake.is_some(),
            "the SUCCESSOR responder installed by `handle_session_rebind` must \
             survive this function, which runs after it. Clearing it dropped the \
             responder that wrote the message 2 already in flight, so the \
             browser's `noise_final` landed on 'no in-flight handshake' and \
             every rebind hung with a carrier neither end could use — a whole \
             `test:e2e:rebind` run, red, while every unit gate stayed green"
        );
        // Still the same screen: retiring these must not have cost the baseline.
        assert_eq!(peer.generation, 5);
        assert!(peer.display_cache.initialized);
    }

    /// A row whose only send was still in flight when the carrier died must
    /// come back. No acknowledgement can ever resolve it -- the connection that
    /// would have carried the ACK is gone, and the packet-threshold rule needs
    /// three later sequences applied above it, which can never happen. Left
    /// recorded as sent-and-awaiting-ack, the flush skips it forever.
    #[test]
    fn a_carrier_swap_disowns_rows_that_were_in_flight_when_the_link_broke() {
        use crate::connection::{PeerTransport, SentRow};
        use crate::display::policy::DisplayPolicy;
        use merkur_codec::CellRepr;

        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 3;
        // (cols, rows): a single column, two rows.
        peer.display_cache.resize(1, 2);
        let grid = vec![CellRepr::BLANK; 2];
        peer.display_cache
            .prime_from_snapshot(&grid, &[11, 22], &[]);
        // Row 0 changed and went out on a datagram the browser never received.
        peer.display_cache.record_sent_rows(
            5,
            &[SentRow {
                graphics: None,
                row: 0,
                hash: 99,
                cells: vec![CellRepr {
                    codepoint: 'x' as u32,
                    ..CellRepr::BLANK
                }]
                .into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        assert_eq!(peer.display_cache.sent_row_seq.first().copied(), Some(5));

        splice_rebound_peer(&mut peer, 1_000.0);

        assert_eq!(
            peer.display_cache.sent_row_seq.first().copied(),
            Some(0),
            "row 0 must be re-selectable, not recorded as already sent"
        );
        assert!(
            peer.display_cache.sent_datagrams.is_empty(),
            "every record describes a send on the carrier that just died"
        );
        // Row 1 was never in flight, so the swap costs it nothing.
        assert_eq!(
            peer.display_cache.acked_row_hashes.get(1).copied(),
            Some(22)
        );
    }

    // ── Outcome telemetry ──────────────────────────────────────────────────
    //
    // A rebind refusal is silence on the wire by design, so telemetry is the
    // ONLY place a refused rebind is observable. A production incident had to
    // be diagnosed from the browser's upgrade reports because these did not
    // exist; the tests below are what keep them honest.

    /// Decode the `EVT_SESSION_REBIND` frames a capturing sink collected.
    ///
    /// Frame shape is `[kind: u8][len: u32 BE][payload]`, per `ipc::write_frame`.
    fn captured_rebind_events(bytes: &[u8]) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        let mut index = 0usize;
        while index + 5 <= bytes.len() {
            let kind = bytes[index];
            let len = u32::from_be_bytes(
                bytes[index + 1..index + 5]
                    .try_into()
                    .expect("four length bytes"),
            ) as usize;
            let start = index + 5;
            let end = start + len;
            assert!(end <= bytes.len(), "truncated frame in capture");
            if kind == EVT_SESSION_REBIND {
                out.push(serde_json::from_slice(&bytes[start..end]).expect("rebind event json"));
            }
            index = end;
        }
        out
    }

    #[test]
    fn every_refusal_names_its_own_reason() {
        let keys = RebindRefusal::all_metric_keys();
        let mut unique: Vec<String> = keys.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            keys.len(),
            "two refusals sharing a label make them indistinguishable in \
             exactly the aggregate that has to tell them apart"
        );
        for key in &keys {
            assert!(!key.is_empty(), "an unlabelled refusal lands in no bucket");
            assert!(
                key.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == ':'),
                "label {key} is not a stable metric key"
            );
        }
        // The one variant that used to absorb fourteen distinct failures.
        assert_eq!(
            keys.iter().filter(|k| k.starts_with("crypto:")).count(),
            CRYPTO_STAGES.len(),
            "every crypto stage must be separately nameable"
        );
    }

    /// The Rust vocabulary and the TypeScript validator's `REBIND_OUTCOMES` set
    /// are two halves of one contract, and the IPC reader rejects an unknown
    /// outcome. This is the Rust half; `dataplane-client.test.ts` pins the same
    /// list on the other side.
    #[test]
    fn the_outcome_vocabulary_is_closed() {
        let mut all: Vec<String> = RebindRefusal::all_metric_keys();
        all.extend(REBIND_LIFECYCLE_OUTCOMES.iter().map(|s| (*s).to_string()));
        all.sort();
        let expected: Vec<String> = [
            "accepted",
            "accepted_held",
            "accepted_replay",
            "attempt_expired",
            "bad_proof",
            "committed",
            "control_link_stale",
            "crypto:answer_transcript",
            "crypto:combiner",
            "crypto:encaps_randomness",
            "crypto:encapsulation",
            "crypto:hybrid_combiner",
            "crypto:identity",
            "crypto:msg1_bind",
            "crypto:nonce",
            "crypto:prologue_digest",
            "crypto:psk_install",
            "crypto:request_digest",
            "crypto:request_transcript",
            "crypto:responder_prepare",
            "crypto:response_mac",
            "crypto:response_transcript",
            "envelope_rejected",
            "forged_generation",
            "generation_budget_exhausted",
            "lineage_expired",
            "not_rebinding",
            "peer_mismatch",
            "response_flushed",
            "session_mismatch",
            "stale_generation",
            "unknown_peer",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
        assert_eq!(
            all, expected,
            "the outcome vocabulary changed; update REBIND_OUTCOMES in \
             apps/daemon/src/services/dataplane-client.ts in the SAME commit, or \
             the daemon will reject its own event as a protocol error"
        );
    }

    #[tokio::test]
    async fn a_refused_rebind_reports_its_reason() {
        let (event_tx, mut event_output, captured) =
            crate::ipc::events::test_capturing_event_sink();
        let mut telemetry = RebindTelemetry::new(event_tx);
        let identity = Some(test_identity());
        // Empty peer map: the parked-peer case, and the refusal that dominated
        // the incident this telemetry exists for.
        let mut peers = HashMap::new();
        let network_state = Arc::new(RwLock::new(NetworkState::new()));

        let outcome = handle_session_rebind(
            "browser-node",
            signed_request_at(0),
            &mut peers,
            &identity,
            "daemon-node",
            &network_state,
            &mut telemetry,
            true,
            0.0,
            &test_static(),
            None,
        )
        .await;
        assert_eq!(outcome, RebindAdmission::Rejected);

        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
        let events = captured_rebind_events(&captured.lock().unwrap());
        assert_eq!(events.len(), 1, "one attempt, one outcome");
        assert_eq!(events[0]["outcome"], "unknown_peer");
        assert_eq!(
            events[0]["session_id"], "session-from-server",
            "the session the BROWSER asked about is the key that joins this to \
             its own carrier_recovery rows"
        );
        assert_eq!(events[0]["attempt_ms"], 0);
    }

    #[tokio::test]
    async fn a_committed_rebind_reports_its_proof_to_commit_duration() {
        let (event_tx, mut event_output, captured) =
            crate::ipc::events::test_capturing_event_sink();
        let mut telemetry = RebindTelemetry::new(event_tx);
        let mut peer = rebindable_peer(0.0);
        let successor = test_successor();
        peer.rebind.as_mut().expect("lineage").in_flight = Some(InFlightRebind {
            candidate: None,
            request_digest: [0u8; 64],
            daemon_nonce: [0x55; 32],
            ciphertext: Box::new([0x44; 1568]),
            next_expected_input_seq: 9,
            successor,
            noise_msg2: Vec::new(),
            issued_at_ms: 250.0,
            pending_response: None,
        });

        assert!(
            commit_rebind(&mut peer, "browser-node", &mut telemetry, 1_000.0),
            "a flight in hand commits"
        );
        assert!(
            !commit_rebind(&mut peer, "browser-node", &mut telemetry, 1_000.0),
            "a genesis authentication has nothing to commit, and must be \
             distinguishable from a rebind at the call site"
        );

        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
        let events = captured_rebind_events(&captured.lock().unwrap());
        assert_eq!(events.len(), 1, "only the real commit is an event");
        assert_eq!(events[0]["outcome"], "committed");
        assert_eq!(events[0]["generation"], 1, "the successor generation");
        assert_eq!(
            events[0]["attempt_ms"], 750,
            "proof-to-commit: the figure the incident wanted and could not get"
        );
    }

    /// The bound is what makes this channel safe to emit from at all: an
    /// `unknown_peer` refusal is drivable by anyone holding the rendezvous id.
    #[test]
    fn the_outcome_budget_bounds_a_flood_and_self_reports_it() {
        let mut telemetry = rebind_telemetry();
        let flood = MAX_REBIND_EVENTS_PER_TICK * 3;

        for generation in 0..flood {
            telemetry.emit(
                "session",
                "unknown_peer".to_string(),
                u64::from(generation),
                0,
            );
        }

        assert_eq!(
            telemetry.tallies().events_suppressed,
            u64::from(flood - MAX_REBIND_EVENTS_PER_TICK)
        );

        // A heartbeat opens the next bounded window; the running suppression
        // total survives it and is therefore what the next admitted event puts
        // in `events_suppressed`.
        telemetry.refill();
        telemetry.emit("session", "unknown_peer".to_string(), u64::from(flood), 0);
        assert_eq!(telemetry.tokens, MAX_REBIND_EVENTS_PER_TICK - 1);
        assert_eq!(
            telemetry.tallies().events_suppressed,
            u64::from(flood - MAX_REBIND_EVENTS_PER_TICK),
            "refilling tokens must not erase evidence of prior suppression"
        );
    }

    #[tokio::test]
    async fn a_rejected_rebind_envelope_is_not_silent() {
        let (event_tx, mut event_output, captured) =
            crate::ipc::events::test_capturing_event_sink();
        let mut telemetry = RebindTelemetry::new(event_tx);
        telemetry.report_envelope_rejected(Some("session-from-server"));
        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
        let events = captured_rebind_events(&captured.lock().unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["outcome"], "envelope_rejected");
        assert_eq!(
            events[0]["session_id"], "session-from-server",
            "a rebind dropped at the door and one refused inside are both \
             silence to the browser; only this tells them apart"
        );
    }

    /// What `handleSessionRebind` in `apps/daemon/src/services/dataplane-client.ts`
    /// requires of an event, on pain of a fatal `invalid_event`: exactly these
    /// five keys, a non-empty session id, an outcome in `REBIND_OUTCOMES`, and
    /// three integers no larger than `Number.MAX_SAFE_INTEGER`.
    fn assert_daemon_reader_accepts(event: &serde_json::Value) {
        let object = event.as_object().expect("an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "attempt_ms",
                "events_suppressed",
                "generation",
                "outcome",
                "session_id"
            ]
        );
        let session_id = event["session_id"].as_str().expect("a string session id");
        assert!(
            merkur_wire::signaling::is_session_id(session_id),
            "session id of {} bytes",
            session_id.len()
        );
        let outcome = event["outcome"].as_str().expect("a string outcome");
        assert!(
            REBIND_LIFECYCLE_OUTCOMES.contains(&outcome)
                || RebindRefusal::all_metric_keys()
                    .iter()
                    .any(|key| key == outcome),
            "{outcome} is outside the vocabulary pinned to REBIND_OUTCOMES"
        );
        for key in ["generation", "attempt_ms", "events_suppressed"] {
            let value = event[key].as_u64().expect("an unsigned integer");
            assert!(value <= MAX_SAFE_INTEGER, "{key} = {value}");
        }
    }

    /// The general guard: whatever reaches the telemetry, every event that
    /// leaves it is one the daemon's reader accepts.
    #[tokio::test]
    async fn every_emitted_rebind_event_is_one_the_daemon_reader_accepts() {
        let (event_tx, mut event_output, captured) =
            crate::ipc::events::test_capturing_event_sink();
        let mut telemetry = RebindTelemetry::new(event_tx);
        let longest = "s".repeat(merkur_wire::signaling::MAX_SESSION_ID_BYTES);
        let over_long = "s".repeat(merkur_wire::signaling::MAX_SESSION_ID_BYTES + 1);

        // A rejected envelope, with every id an unauthenticated sender can
        // make the parser hand over or withhold.
        for session_id in [
            None,
            Some(""),
            Some(over_long.as_str()),
            Some(longest.as_str()),
        ] {
            telemetry.report_envelope_rejected(session_id);
        }
        assert_eq!(telemetry.tallies().envelopes_rejected, 4);
        telemetry.refill();

        // Every outcome, at the largest generation a validated request names
        // and at its successor, the largest a commit forms.
        let mut outcomes = RebindRefusal::all_metric_keys();
        outcomes.extend(
            REBIND_LIFECYCLE_OUTCOMES
                .iter()
                .map(|key| (*key).to_string()),
        );
        let mut emitted = 1;
        for outcome in outcomes {
            for generation in [0, MAX_SAFE_INTEGER - 1, MAX_SAFE_INTEGER] {
                telemetry.emit(&longest, outcome.clone(), generation, u32::MAX);
                telemetry.refill();
                emitted += 1;
            }
        }
        // Past the reader's range, and from ids it would refuse: no event.
        telemetry.emit(&longest, "committed".to_string(), MAX_SAFE_INTEGER + 1, 0);
        telemetry.emit(&longest, "committed".to_string(), u64::MAX, 0);
        telemetry.emit("", "committed".to_string(), 1, 0);
        telemetry.emit(&over_long, "committed".to_string(), 1, 0);

        // A suppression tally past the reader's range is reported at its edge.
        telemetry.tallies.events_suppressed = u64::MAX;
        telemetry.emit(&longest, "committed".to_string(), 1, 0);
        emitted += 1;

        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
        let events = captured_rebind_events(&captured.lock().unwrap());
        assert_eq!(events.len(), emitted);
        for event in &events {
            assert_daemon_reader_accepts(event);
        }
        assert_eq!(
            events.last().expect("the last event")["events_suppressed"],
            MAX_SAFE_INTEGER
        );
    }

    /// A rebind envelope the validator refuses is counted, and reported only
    /// under an id the validator itself admits: the daemon stops its sidecar
    /// on an event with an empty session id, and this frame needs no
    /// authentication to send.
    #[tokio::test]
    async fn a_rejected_rebind_envelope_never_emits_an_id_the_validator_refuses() {
        use merkur_wire::signaling::{ClientSignal, RefusedEnvelope};
        let (event_tx, mut event_output, captured) =
            crate::ipc::events::test_capturing_event_sink();
        let mut telemetry = RebindTelemetry::new(event_tx);
        let over_long = format!(
            r#"{{"type":"session_rebind","session_id":"{}"}}"#,
            "s".repeat(merkur_wire::signaling::MAX_SESSION_ID_BYTES + 1)
        );
        let envelopes = [
            r#"{"type":"session_rebind"}"#,
            r#"{"type":"session_rebind","session_id":""}"#,
            r#"{"type":"session_rebind","session_id":7}"#,
            over_long.as_str(),
            r#"{"type":"session_rebind","session_id":"session-from-server"}"#,
        ];
        for envelope in envelopes {
            let Err(RefusedEnvelope::SessionRebind { session_id }) =
                ClientSignal::admit(envelope.as_bytes())
            else {
                panic!("{envelope} is a refused rebind");
            };
            telemetry.report_envelope_rejected(session_id.as_deref());
        }
        assert_eq!(
            telemetry.tallies().envelopes_rejected,
            envelopes.len() as u64,
            "every rejected envelope is counted"
        );

        event_output
            .shutdown()
            .await
            .expect("event output shutdown");
        let events = captured_rebind_events(&captured.lock().unwrap());
        assert_eq!(events.len(), 1, "only the admissible id is reported");
        assert_eq!(events[0]["session_id"], "session-from-server");
        assert_daemon_reader_accepts(&events[0]);
    }
}
