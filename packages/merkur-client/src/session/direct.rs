//! The direct path: the daemon's own WebTransport server, dialled beside the
//! edge relay and adopted once the daemon authenticates the attachment. The
//! port of `wt-upgrade-controller.ts`, its candidate race and the upgrade leg
//! of `lib/webtransport.ts`.
//!
//! There is no retry ladder and no give-up. What may be dialled is recomputed
//! whenever it can have changed: a manifest lands, a punch outcome arrives,
//! the committed carrier proves another address, the live direct path goes
//! away. Anything this network has not been dialled for joins the session's
//! one race, the manifest's public candidates before its local ones, one
//! every `CANDIDATE_INTERLEAVE_MS`. A punched candidate (srflx toward an IPv4
//! client, a global IPv6 host toward an IPv6 one) waits until the manifest
//! built for this carrier's address has a punch outcome, because the punch is
//! what opens its filter.
//!
//! The first handshake starts a grace window in which a faster one may still
//! win; the winner's authenticated upgrade then decides. An endpoint whose
//! handshake failed or went unanswered, or whose upgrade failed, is not
//! dialled again from this network. A live direct path is kept.
//!
//! A dead path need not close: a phone that leaves the LAN, or one whose radio
//! slept, keeps a QUIC connection open until its idle timeout. Every heartbeat
//! ping goes out on both providers, so the relay answering a ping whose copy
//! the adopted path carried, while that copy stays unanswered an RTO longer,
//! is the path's death. The path is retired then, and the daemon told on
//! signaling, since a close on the dead path would never reach it.

use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr};

use base64::Engine;
use merkur_wire::protocol::{CHANNEL_CTRL, MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK};
use merkur_wire::signaling::{
    CandidateKind, CandidateOutcome, CandidateScope, ClientSignal, DaemonSignal, DirectCandidate,
    NatType, PunchOutcome, PunchState, WebtransportOutcome, WebtransportUpgradeInit,
    WebtransportUpgradeProof, webtransport_upgrade_proof_payload,
};

use super::{Action, ConnId, Phase, Session};
use crate::hex;
use crate::liveness::PathKind;

/// Cold native bootstrap, requested once for each authenticated lineage.
pub struct NativeTraversalSetup {
    pub lineage: u32,
    pub request: crate::issuance::StunCredentialRequest,
    pub key: merkur_e2e::traversal::TraversalKey,
}

/// Spacing of the race's dials, mirrored from `CANDIDATE_INTERLEAVE_MS`.
const CANDIDATE_INTERLEAVE_MS: u64 = 30;
/// Ceiling on a race from its batch's first dial, mirrored from
/// `RACE_DEADLINE_MS`: anything slower loses to staying on the relay.
const RACE_DEADLINE_MS: u64 = 2_500;
/// After the first handshake, a faster one may still win for three times its
/// duration, within 80..=400 ms. Mirrored from `raceGraceMs`.
const GRACE_FLOOR_MS: u64 = 80;
const GRACE_CEILING_MS: u64 = 400;
const GRACE_MULTIPLIER: u64 = 3;
/// The upgrade's legs, mirrored from `DEFAULT_UPGRADE_TIMEOUTS`: the
/// challenge answers the init within this, the ack the proof within the next.
const CHALLENGE_TIMEOUT_MS: u64 = 5_000;
const ACK_TIMEOUT_MS: u64 = 2_000;
/// Resource bound on the pings remembered for the adopted path. The relay
/// settles each one within its own RTO, at most `RTO_CEIL_MS`, while pings
/// leave every `HEARTBEAT_INTERVAL_MS`, so a handful are ever outstanding.
const DIRECT_PROBE_TOKENS: usize = 16;

fn race_grace_ms(first_handshake_ms: u64) -> u64 {
    (first_handshake_ms * GRACE_MULTIPLIER).clamp(GRACE_FLOOR_MS, GRACE_CEILING_MS)
}

/// One endpoint: an address under a certificate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Endpoint {
    addr: SocketAddr,
    cert_hash: [u8; 32],
    binding: u64,
}

struct Manifest {
    generation: u64,
    cert_hash: [u8; 32],
    candidates: Vec<DirectCandidate>,
    nat_type: NatType,
    browser_address: IpAddr,
    punch: PunchState,
    admission_pending: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AttemptState {
    /// Waiting out the interleave.
    Queued {
        start_ms: u64,
    },
    Pending {
        dialed_ms: u64,
    },
    Ready {
        handshake_ms: u64,
    },
    Failed,
}

struct Attempt {
    endpoint: Endpoint,
    kind: CandidateKind,
    conn: Option<ConnId>,
    state: AttemptState,
}

struct Race {
    attempts: Vec<Attempt>,
    deadline_ms: u64,
    grace_ms: Option<u64>,
    nat_type: NatType,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Challenge,
    Ack,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Challenge => "challenge",
            Self::Ack => "ack",
        }
    }
}

/// The race's winner inside its authenticated upgrade.
struct Upgrade {
    conn: ConnId,
    endpoint: Endpoint,
    kind: CandidateKind,
    stage: Stage,
    deadline_ms: u64,
    nat_type: NatType,
    report: Vec<CandidateOutcome>,
    /// The provisional id the daemon's challenge named this attachment by.
    temp_peer_id: Option<String>,
}

struct Adopted {
    conn: ConnId,
    kind: CandidateKind,
    nat_type: NatType,
    /// What the daemon knows this attachment by, for the loss notice.
    temp_peer_id: String,
}

/// The adopted path's answers to the heartbeat, by ping token.
#[derive(Default)]
pub(super) struct DirectProbe {
    /// Tokens whose ping the adopted path carried, oldest first.
    sent: VecDeque<u64>,
    /// The newest token the adopted path answered.
    answered: u64,
    /// A token the relay answered while the adopted path had not, and when
    /// that silence becomes the path's death.
    deadline: Option<(u64, u64)>,
}

impl DirectProbe {
    /// The ping `token` went out on the adopted path.
    pub(super) fn sent(&mut self, token: u64) {
        if self.sent.len() == DIRECT_PROBE_TOKENS {
            self.sent.pop_front();
        }
        self.sent.push_back(token);
    }

    /// The adopted path answered `token`: it carries what was sent up to it.
    fn answered(&mut self, token: u64) {
        self.answered = self.answered.max(token);
        let answered = self.answered;
        self.sent.retain(|sent| *sent > answered);
        if self.deadline.is_some_and(|(token, _)| token <= answered) {
            self.deadline = None;
        }
    }

    /// The relay answered `token`; the adopted path has until `at_ms`.
    fn relay_answered(&mut self, token: u64, at_ms: u64) {
        if self.deadline.is_none() && token > self.answered && self.sent.contains(&token) {
            self.deadline = Some((token, at_ms));
        }
    }
}

#[derive(Default)]
pub(super) struct Direct {
    native: bool,
    native_offer: Option<merkur_wire::traversal::Offer>,
    native_generation: u64,
    native_recovery: u64,
    checked: Vec<(Endpoint, CandidateKind)>,
    manifest: Option<Manifest>,
    /// The last punch outcome heard, and the manifest generation it served.
    punch: Option<(u64, PunchOutcome)>,
    /// The address the committed signaling attachment proved.
    carrier_address: Option<IpAddr>,
    /// Endpoints not dialled again from `carrier_address`.
    spent: Vec<Endpoint>,
    race: Option<Race>,
    upgrade: Option<Upgrade>,
    path: Option<Adopted>,
    probe: DirectProbe,
    admission_done: Option<u64>,
}

impl Direct {
    /// The adopted direct attachment, which carries every sealed frame.
    pub(super) fn path(&self) -> Option<ConnId> {
        self.path.as_ref().map(|path| path.conn)
    }

    /// The adopted path's heartbeat ledger, for the link that pings it.
    pub(super) fn probe_mut(&mut self) -> &mut DirectProbe {
        &mut self.probe
    }

    /// Whether `conn` is the race's winner inside its upgrade, whose control
    /// records are the upgrade's own, in the clear.
    pub(super) fn upgrading(&self, conn: ConnId) -> bool {
        self.upgrade
            .as_ref()
            .is_some_and(|upgrade| upgrade.conn == conn)
    }

    pub(super) fn owns(&self, conn: ConnId) -> bool {
        self.path() == Some(conn)
            || self
                .upgrade
                .as_ref()
                .is_some_and(|upgrade| upgrade.conn == conn)
            || self.race.as_ref().is_some_and(|race| {
                race.attempts
                    .iter()
                    .any(|attempt| attempt.conn == Some(conn))
            })
    }

    pub(super) fn next_deadline(&self) -> Option<u64> {
        let race = self.race.iter().flat_map(|race| {
            let starts = race
                .attempts
                .iter()
                .filter_map(|attempt| match attempt.state {
                    AttemptState::Queued { start_ms } => Some(start_ms),
                    _ => None,
                });
            starts
                .chain(Some(race.deadline_ms))
                .chain(race.grace_ms)
                .collect::<Vec<_>>()
        });
        race.chain(self.upgrade.iter().map(|upgrade| upgrade.deadline_ms))
            .chain(self.probe.deadline.map(|(_, at_ms)| at_ms))
            .min()
    }

    /// Whether `candidate` needs no punch, or its punch has left. A punched
    /// candidate waits for a manifest built for the address this client is at
    /// now, and for that manifest's punch.
    fn punch_allows(&self, candidate: &DirectCandidate) -> bool {
        // Send router admission before spending a reflexive handshake. Once a
        // helper endpoint is offered, its allocation observation cannot hold
        // other candidates while waiting for a quote or an intermediate grant.
        if candidate.kind == CandidateKind::Srflx
            && self.manifest.as_ref().is_some_and(|manifest| {
                manifest.admission_pending
                    && !manifest.candidates.iter().any(|candidate| {
                        matches!(candidate.kind, CandidateKind::Tftp | CandidateKind::Sip)
                    })
            })
        {
            return false;
        }
        let Some(here) = self.carrier_address.or(self
            .manifest
            .as_ref()
            .map(|manifest| manifest.browser_address))
        else {
            return false;
        };
        if matches!(candidate.kind, CandidateKind::Tftp | CandidateKind::Sip) {
            return here.is_ipv4() == candidate.addr.is_ipv4()
                && self
                    .manifest
                    .as_ref()
                    .is_some_and(|manifest| manifest.browser_address == here);
        }
        let punched = if here.is_ipv6() {
            CandidateKind::Host6
        } else {
            CandidateKind::Srflx
        };
        if candidate.kind != punched {
            return true;
        }
        let Some(manifest) = self
            .manifest
            .as_ref()
            .filter(|manifest| manifest.browser_address == here)
        else {
            return false;
        };
        manifest.punch == PunchState::None
            || self.punch.is_some_and(|(generation, outcome)| {
                generation == manifest.generation && outcome != PunchOutcome::Superseded
            })
    }

    /// Every endpoint dialable now and neither spent nor racing, in dial
    /// order: public candidates, then local ones.
    fn dialable(&self) -> Vec<(Endpoint, CandidateKind)> {
        if self.native {
            return self
                .checked
                .iter()
                .copied()
                .filter(|(endpoint, _)| {
                    !self.spent.contains(endpoint)
                        && !self.race.as_ref().is_some_and(|race| {
                            race.attempts
                                .iter()
                                .any(|attempt| attempt.endpoint == *endpoint)
                        })
                })
                .collect();
        }
        let Some(manifest) = self.manifest.as_ref() else {
            return Vec::new();
        };
        let racing = |endpoint: &Endpoint| {
            self.race.as_ref().is_some_and(|race| {
                race.attempts
                    .iter()
                    .any(|attempt| attempt.endpoint == *endpoint)
            })
        };
        let mut entries: Vec<(Endpoint, CandidateKind)> = Vec::new();
        for scope in [CandidateScope::Public, CandidateScope::Local] {
            for candidate in manifest
                .candidates
                .iter()
                .filter(|candidate| candidate.scope == scope && self.punch_allows(candidate))
            {
                let endpoint = Endpoint {
                    addr: SocketAddr::new(candidate.addr, candidate.port),
                    cert_hash: manifest.cert_hash,
                    binding: 0,
                };
                if !self.spent.contains(&endpoint)
                    && !racing(&endpoint)
                    && !entries.iter().any(|(entry, _)| *entry == endpoint)
                {
                    entries.push((endpoint, candidate.kind));
                }
            }
        }
        entries
    }
}

fn nat_label(nat: NatType) -> &'static str {
    match nat {
        NatType::EndpointIndependent => "endpoint_independent",
        NatType::EndpointDependent => "endpoint_dependent",
        NatType::None => "none",
    }
}

fn kind_label(kind: CandidateKind) -> &'static str {
    match kind {
        CandidateKind::Srflx => "srflx",
        CandidateKind::NatMap => "nat_map",
        CandidateKind::Host4 => "host4",
        CandidateKind::Host6 => "host6",
        CandidateKind::Loopback => "loopback",
        CandidateKind::Tftp => "tftp",
        CandidateKind::Sip => "sip",
    }
}

fn outcome(kind: CandidateKind, disposition: &str) -> CandidateOutcome {
    CandidateOutcome {
        kind: kind_label(kind).to_string(),
        disposition: disposition.to_string(),
    }
}

impl Session {
    /// The native host owns UDP sockets. Browser hosts never call this method.
    pub fn enable_native_traversal(&mut self) {
        self.direct.native = true;
    }

    /// Cheap revision read: no derivation or allocation on a driver turn.
    pub fn native_traversal_epoch(&self) -> Option<u32> {
        (self.direct.native
            && !self.config.relay_only
            && matches!(self.phase, Phase::Established(_)))
        .then_some(self.display_lineage)
    }

    pub fn native_traversal_setup(&self) -> Option<NativeTraversalSetup> {
        if !self.is_ready() {
            return None;
        }
        let lineage = self.native_traversal_epoch()?;
        let Phase::Established(established) = &self.phase else {
            return None;
        };
        let issued = self.issued.as_ref()?;
        Some(NativeTraversalSetup {
            lineage,
            request: crate::issuance::StunCredentialRequest {
                daemon_id: self.daemon_id.clone(),
                browser_node_id: self.config.browser_node_id.clone(),
                session_id: issued.session_id.clone(),
                delegation_id: self.delegation.certificate.delegation_id.clone(),
                rebind_counter: established.rebind.counter(),
                generation: 0,
            },
            key: merkur_e2e::traversal::TraversalKey::derive(
                &established.direct_upgrade_secret,
                &issued.session_id,
            )
            .ok()?,
        })
    }

    pub fn native_traversal_offer(&self) -> Option<&merkur_wire::traversal::Offer> {
        self.direct.native_offer.as_ref()
    }
    pub fn native_traversal_recovery_generation(&self) -> u64 {
        self.direct.native_recovery
    }

    pub fn native_direct_live(&self) -> bool {
        self.direct.path.is_some()
    }

    pub fn native_direct_attempt_pending(&self) -> bool {
        self.direct.race.is_some() || self.direct.upgrade.is_some()
    }

    /// Cold discovery retries use the measured round trip and carrier recovery's
    /// bounded backoff. They never delay terminal traffic.
    pub fn native_discovery_retry_delay(&self, failures: u32) -> std::time::Duration {
        let ceiling = std::time::Duration::from_millis(super::RECONNECT_CEIL_MS);
        let base = std::time::Duration::from_secs_f64(
            (self.heartbeat.rto_ms().ceil() / 1_000.0)
                .max(std::time::Duration::from_millis(super::RECONNECT_BASE_MS).as_secs_f64())
                .min(ceiling.as_secs_f64()),
        );
        base.saturating_mul(1u32.checked_shl(failures).unwrap_or(u32::MAX))
            .min(ceiling)
    }

    /// The driver publishes only socket facts gathered for this exact lineage.
    pub fn publish_native_candidates(
        &mut self,
        lineage: u32,
        mut snapshot: merkur_wire::traversal::Snapshot,
    ) -> bool {
        if self.native_traversal_epoch() != Some(lineage)
            || snapshot.generation <= self.direct.native_generation
        {
            return false;
        }
        let Some(setup) = self.native_traversal_setup() else {
            return false;
        };
        snapshot.mac = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(setup.key.mac(false, &snapshot.transcript()));
        if !snapshot.is_valid() {
            return false;
        }
        let Some(signaling) = self.lanes.as_ref().map(|lanes| lanes.signaling) else {
            return false;
        };
        self.direct.native_generation = snapshot.generation;
        self.direct.native_offer = None;
        self.direct.checked.clear();
        self.revoke_race();
        let signal = ClientSignal::WebtransportCandidates(snapshot);
        self.actions.push_back(Action::SendReliable {
            conn: signaling,
            channel: merkur_wire::protocol::CHANNEL_SIGNALING,
            payload: signal.to_json().into_bytes(),
        });
        true
    }

    pub(super) fn on_native_traversal_offer(
        &mut self,
        _now_ms: u64,
        offer: merkur_wire::traversal::Offer,
    ) {
        if !self.direct.native
            || offer.client_generation != self.direct.native_generation
            || self
                .direct
                .native_offer
                .as_ref()
                .is_some_and(|previous| offer.generation <= previous.generation)
        {
            return;
        }
        let Some(setup) = self.native_traversal_setup() else {
            return;
        };
        let Ok(mac) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&offer.mac) else {
            return;
        };
        if !offer.is_valid() || !setup.key.verifies(true, &offer.transcript(), &mac) {
            return;
        }
        self.revoke_race();
        self.direct.checked.clear();
        self.direct.native_offer = Some(offer);
    }

    /// A completed authenticated check is eligible only under its current
    /// candidate snapshot and binding. QUIC and upgrade still decide adoption.
    pub fn native_pair_checked(
        &mut self,
        now_ms: u64,
        lineage: u32,
        client_generation: u64,
        manifest_generation: u64,
        binding: u64,
        address: SocketAddr,
    ) -> bool {
        if self.native_traversal_epoch() != Some(lineage) || binding == 0 {
            return false;
        }
        let Some(offer) = self.direct.native_offer.as_ref().filter(|offer| {
            offer.client_generation == client_generation && offer.generation == manifest_generation
        }) else {
            return false;
        };
        let Ok(hash) = base64::engine::general_purpose::STANDARD.decode(&offer.cert_hash) else {
            return false;
        };
        let Ok(cert_hash) = <[u8; 32]>::try_from(hash) else {
            return false;
        };
        let endpoint = Endpoint {
            addr: address,
            cert_hash,
            binding,
        };
        if self
            .direct
            .checked
            .iter()
            .any(|(known, _)| *known == endpoint)
        {
            return false;
        }
        let kind = offer
            .candidates
            .iter()
            .find(|candidate| SocketAddr::new(candidate.addr, candidate.port) == address)
            .map_or(CandidateKind::Srflx, |candidate| candidate.kind);
        self.direct.spent.retain(|spent| *spent != endpoint);
        self.direct.checked.push((endpoint, kind));
        self.refresh_direct(now_ms);
        true
    }

    /// A route event invalidates pending checks/dials, not a working provider.
    pub fn native_network_changed(&mut self) {
        if !self.direct.native {
            return;
        }
        self.revoke_race();
        if let Some(upgrade) = self.direct.upgrade.take() {
            self.actions.push_back(Action::Close { conn: upgrade.conn });
        }
        self.direct.native_offer = None;
        self.direct.checked.clear();
        self.direct.spent.clear();
    }

    /// A manifest landed: it replaces any earlier one.
    pub(super) fn on_direct_manifest(&mut self, now_ms: u64, signal: DaemonSignal) {
        let DaemonSignal::WebtransportManifest {
            generation,
            cert_hash,
            candidates,
            nat,
            browser_address,
            punch,
            admission_pending,
        } = signal
        else {
            return;
        };
        let Some(cert_hash) = base64::engine::general_purpose::STANDARD
            .decode(cert_hash)
            .ok()
            .and_then(|hash| <[u8; 32]>::try_from(hash).ok())
        else {
            return;
        };
        if let Some(previous) = &self.direct.manifest
            && (generation < previous.generation
                || (generation == previous.generation
                    && (previous.cert_hash != cert_hash
                        || previous.browser_address != browser_address
                        || !previous.admission_pending)))
        {
            return;
        }
        if !self.direct.native
            && self
                .direct
                .manifest
                .as_ref()
                .is_some_and(|previous| generation > previous.generation)
        {
            // A newer manifest retires only what it no longer offers: a dial
            // or upgrade to an endpoint it still names is the same attempt,
            // and charging it as spent would bar that endpoint for the visit.
            let offered = |endpoint: &Endpoint| {
                endpoint.cert_hash == cert_hash
                    && candidates.iter().any(|candidate| {
                        SocketAddr::new(candidate.addr, candidate.port) == endpoint.addr
                    })
            };
            self.revoke_unoffered(offered);
            if let Some(upgrade) = self
                .direct
                .upgrade
                .take_if(|upgrade| !offered(&upgrade.endpoint))
            {
                self.direct.spent.push(upgrade.endpoint);
                self.actions.push_back(Action::Close { conn: upgrade.conn });
            }
        }
        self.direct.manifest = Some(Manifest {
            generation,
            cert_hash,
            candidates,
            nat_type: nat.nat_type,
            browser_address,
            punch,
            admission_pending,
        });
        self.refresh_direct(now_ms);
    }

    /// The daemon reported what became of one manifest's punch.
    pub(super) fn on_direct_punch(&mut self, now_ms: u64, generation: u64, outcome: PunchOutcome) {
        if self
            .direct
            .manifest
            .as_ref()
            .is_some_and(|manifest| manifest.generation > generation)
            || self
                .direct
                .punch
                .is_some_and(|(previous, _)| previous > generation)
        {
            return;
        }
        self.direct.punch = Some((generation, outcome));
        self.refresh_direct(now_ms);
    }

    /// The committed signaling attachment proved `address`. A move to another
    /// network revokes the race dialled from the last one, and nothing spent
    /// there is spent here. The first proof of the network a manifest was
    /// already raced from is no move: that race and what it spent stand.
    pub(super) fn on_carrier_address(&mut self, now_ms: u64, address: IpAddr) {
        if self.direct.carrier_address == Some(address) {
            return;
        }
        let dialled_from = self.direct.carrier_address.or(self
            .direct
            .manifest
            .as_ref()
            .map(|manifest| manifest.browser_address));
        self.direct.carrier_address = Some(address);
        self.actions.push_back(Action::ObservedPath(address));
        if dialled_from != Some(address) {
            self.revoke_race();
            self.direct.spent.clear();
            // Every provider now crosses a network no floor was measured on.
            self.paths.restart_floors();
            self.refresh_primary();
        }
        self.refresh_direct(now_ms);
    }

    /// The session's key lineage ended: its direct work and path go, and so
    /// does the manifest, which belonged to it. The network and what was
    /// dialled from it carry over a rebind; a new session forgets them too.
    pub(super) fn reset_direct(&mut self, keep_network: bool) {
        self.revoke_race();
        if let Some(upgrade) = self.direct.upgrade.take() {
            self.actions.push_back(Action::Close { conn: upgrade.conn });
        }
        if let Some(path) = self.direct.path.take() {
            self.actions.push_back(Action::Close { conn: path.conn });
            self.paths.retire(PathKind::Direct);
            self.refresh_primary();
        }
        self.direct.probe = DirectProbe::default();
        self.direct.manifest = None;
        self.direct.native_offer = None;
        self.direct.native_generation = 0;
        self.direct.checked.clear();
        if self.direct.native {
            self.direct.spent.clear();
        }
        self.direct.admission_done = None;
        self.direct.punch = None;
        if !keep_network {
            self.direct.carrier_address = None;
            self.direct.spent.clear();
        }
    }

    /// Retire the race's attempts at endpoints `offered` rejects; the rest
    /// keep racing. A retired pending handshake is spent, as in a revoke.
    fn revoke_unoffered(&mut self, offered: impl Fn(&Endpoint) -> bool) {
        let Some(race) = self.direct.race.as_mut() else {
            return;
        };
        let (kept, retired): (Vec<Attempt>, Vec<Attempt>) = std::mem::take(&mut race.attempts)
            .into_iter()
            .partition(|attempt| offered(&attempt.endpoint));
        race.attempts = kept;
        if race.attempts.is_empty() {
            self.direct.race = None;
        }
        for attempt in retired {
            if let Some(conn) = attempt.conn {
                if matches!(attempt.state, AttemptState::Pending { .. }) {
                    self.direct.spent.push(attempt.endpoint);
                }
                self.actions.push_back(Action::Close { conn });
            }
        }
    }

    fn revoke_race(&mut self) {
        let Some(race) = self.direct.race.take() else {
            return;
        };
        for attempt in race.attempts {
            if let Some(conn) = attempt.conn {
                if self.direct.native {
                    self.actions.retain(|action| !matches!(action, Action::DialDirect { conn: owner, .. } if *owner == conn));
                }
                if matches!(attempt.state, AttemptState::Pending { .. }) {
                    self.direct.spent.push(attempt.endpoint);
                }
                self.actions.push_back(Action::Close { conn });
            }
        }
    }

    /// Recompute what may be dialled, and race it.
    pub(super) fn refresh_direct(&mut self, now_ms: u64) {
        if self.config.relay_only
            || self.direct.path.is_some()
            || self.direct.upgrade.is_some()
            || !matches!(self.phase, Phase::Established(_))
        {
            return;
        }
        let entries = self.direct.dialable();
        if entries.is_empty() {
            self.finish_admission();
            return;
        }
        let nat_type = self
            .direct
            .manifest
            .as_ref()
            .map(|manifest| manifest.nat_type)
            .unwrap_or(NatType::None);
        let race = self.direct.race.get_or_insert_with(|| Race {
            attempts: Vec::new(),
            deadline_ms: 0,
            grace_ms: None,
            nat_type,
        });
        race.deadline_ms = race.deadline_ms.max(now_ms + RACE_DEADLINE_MS);
        for (index, (endpoint, kind)) in entries.into_iter().enumerate() {
            race.attempts.push(Attempt {
                endpoint,
                kind,
                conn: None,
                state: AttemptState::Queued {
                    start_ms: now_ms + index as u64 * CANDIDATE_INTERLEAVE_MS,
                },
            });
        }
        self.start_due_dials(now_ms);
    }

    fn start_due_dials(&mut self, now_ms: u64) {
        let Some(race) = self.direct.race.as_mut() else {
            return;
        };
        let mut dials = Vec::new();
        for attempt in &mut race.attempts {
            if let AttemptState::Queued { start_ms } = attempt.state
                && start_ms <= now_ms
            {
                let conn = ConnId(self.next_conn);
                self.next_conn += 1;
                attempt.conn = Some(conn);
                attempt.state = AttemptState::Pending { dialed_ms: now_ms };
                dials.push(Action::DialDirect {
                    conn,
                    addr: attempt.endpoint.addr,
                    cert_hash: attempt.endpoint.cert_hash,
                    binding: attempt.endpoint.binding,
                });
            }
        }
        self.actions.extend(dials);
    }

    pub(super) fn handle_direct_timeout(&mut self, now_ms: u64) {
        if self
            .direct
            .probe
            .deadline
            .is_some_and(|(_, at_ms)| at_ms <= now_ms)
        {
            self.retire_direct_path(now_ms, true);
        }
        self.start_due_dials(now_ms);
        if self.direct.race.as_ref().is_some_and(|race| {
            race.deadline_ms <= now_ms || race.grace_ms.is_some_and(|at| at <= now_ms)
        }) {
            self.finalize_race(now_ms);
        }
        if self
            .direct
            .upgrade
            .as_ref()
            .is_some_and(|upgrade| upgrade.deadline_ms <= now_ms)
        {
            let stage = self.direct.upgrade.as_ref().map(|upgrade| upgrade.stage);
            if let Some(stage) = stage {
                self.fail_upgrade(now_ms, stage, "timeout");
            }
        }
    }

    /// A direct attachment connected: a racing handshake completed.
    pub(super) fn on_direct_connected(&mut self, now_ms: u64, conn: ConnId) {
        let Some(race) = self.direct.race.as_mut() else {
            return;
        };
        let Some(attempt) = race
            .attempts
            .iter_mut()
            .find(|attempt| attempt.conn == Some(conn))
        else {
            return;
        };
        let AttemptState::Pending { dialed_ms } = attempt.state else {
            return;
        };
        let handshake_ms = now_ms.saturating_sub(dialed_ms);
        attempt.state = AttemptState::Ready { handshake_ms };
        if race.grace_ms.is_none() {
            race.grace_ms = Some(now_ms + race_grace_ms(handshake_ms));
        }
        self.try_finish_race(now_ms);
    }

    /// A direct attachment ended. A racing one failed its handshake; the
    /// winner's upgrade failed; the adopted path is lost.
    pub(super) fn on_direct_closed(&mut self, now_ms: u64, conn: ConnId) {
        if self.direct.path() == Some(conn) {
            return self.retire_direct_path(now_ms, false);
        }
        if let Some(stage) = self
            .direct
            .upgrade
            .as_ref()
            .filter(|upgrade| upgrade.conn == conn)
            .map(|upgrade| upgrade.stage)
        {
            return self.fail_upgrade(now_ms, stage, "closed");
        }
        let Some(race) = self.direct.race.as_mut() else {
            return;
        };
        let Some(attempt) = race
            .attempts
            .iter_mut()
            .find(|attempt| attempt.conn == Some(conn))
        else {
            return;
        };
        if matches!(attempt.state, AttemptState::Pending { .. }) {
            attempt.state = AttemptState::Failed;
            let endpoint = attempt.endpoint;
            self.direct.spent.push(endpoint);
        }
        self.try_finish_race(now_ms);
    }

    /// A pong for heartbeat `token` arrived on `conn`, either copy. The
    /// adopted path's own answer proves it; the relay's answer to a ping the
    /// adopted path also carried gives that path one RTO more to answer.
    pub(super) fn on_direct_pong(&mut self, now_ms: u64, conn: ConnId, token: u64) {
        let Some(path) = self.direct.path() else {
            return;
        };
        if conn == path {
            self.direct.probe.answered(token);
        } else {
            let at_ms = now_ms + self.heartbeat.rto_ceil_ms();
            self.direct.probe.relay_answered(token, at_ms);
        }
    }

    /// The adopted path is gone: closed, or `silent` past its probe deadline.
    /// What its streams carried goes with it, so input goes out again on the
    /// relay, and the daemon, which a dead path's close never reaches, is told
    /// on signaling which attachment to retire.
    fn retire_direct_path(&mut self, now_ms: u64, silent: bool) {
        let Some(path) = self.direct.path.take() else {
            return;
        };
        if self.direct.native {
            self.direct.native_recovery = self
                .direct
                .native_recovery
                .checked_add(1)
                .expect("native recovery generation exhausted");
            self.direct.native_offer = None;
            self.direct.checked.clear();
        }
        self.direct.probe = DirectProbe::default();
        self.outbox.reliable_sent = 0;
        self.paths.retire(PathKind::Direct);
        self.refresh_primary();
        if silent {
            self.actions.push_back(Action::Close { conn: path.conn });
        }
        if let Some(lanes) = &self.lanes {
            self.actions.push_back(Action::SendReliable {
                conn: lanes.signaling,
                channel: merkur_wire::protocol::CHANNEL_SIGNALING,
                payload: ClientSignal::WebtransportDirectLost {
                    temp_peer_id: path.temp_peer_id,
                }
                .to_json()
                .into_bytes(),
            });
        }
        self.report_direct("lost", Some(path.kind), path.nat_type, Vec::new(), None);
        self.graphics_interrupt();
        self.flush_input(now_ms);
        self.refresh_direct(now_ms);
    }

    /// Finish once nothing is waiting to start and no pending handshake can
    /// still beat the fastest one within the grace window.
    fn try_finish_race(&mut self, now_ms: u64) {
        let Some(race) = self.direct.race.as_mut() else {
            return;
        };
        if race
            .attempts
            .iter()
            .any(|attempt| matches!(attempt.state, AttemptState::Queued { .. }))
        {
            return;
        }
        let best = race
            .attempts
            .iter()
            .filter_map(|attempt| match attempt.state {
                AttemptState::Ready { handshake_ms } => Some(handshake_ms),
                _ => None,
            })
            .min();
        let youngest = race
            .attempts
            .iter()
            .filter_map(|attempt| match attempt.state {
                AttemptState::Pending { dialed_ms } => Some(dialed_ms),
                _ => None,
            })
            .max();
        match (best, youngest, race.grace_ms) {
            (_, None, _) => self.finalize_race(now_ms),
            (Some(best), Some(youngest), Some(grace)) => {
                let finish = grace.min(youngest + best);
                if finish <= now_ms {
                    self.finalize_race(now_ms);
                } else {
                    race.grace_ms = Some(finish);
                }
            }
            _ => {}
        }
    }

    /// The race ends: the fastest ready attempt upgrades, the rest close, and
    /// a pending handshake the race stops waiting for is spent.
    fn finalize_race(&mut self, now_ms: u64) {
        let Some(race) = self.direct.race.take() else {
            return;
        };
        let winner = race
            .attempts
            .iter()
            .filter_map(|attempt| match attempt.state {
                AttemptState::Ready { handshake_ms } => Some((handshake_ms, attempt.conn)),
                _ => None,
            })
            .min_by_key(|(handshake_ms, _)| *handshake_ms)
            .and_then(|(_, conn)| conn);
        let mut report = Vec::with_capacity(race.attempts.len());
        let mut chosen = None;
        for attempt in &race.attempts {
            let disposition = match attempt.state {
                AttemptState::Queued { .. } => "not_dialled",
                AttemptState::Pending { .. } => {
                    self.direct.spent.push(attempt.endpoint);
                    "no_settle"
                }
                AttemptState::Ready { .. } if attempt.conn == winner => {
                    chosen = Some((attempt.endpoint, attempt.kind));
                    "won"
                }
                AttemptState::Ready { .. } => "ready_lost_race",
                AttemptState::Failed => "other",
            };
            report.push(outcome(attempt.kind, disposition));
            if attempt.conn != winner
                && let Some(conn) = attempt.conn
            {
                self.actions.push_back(Action::Close { conn });
            }
        }
        let (Some(conn), Some((endpoint, kind))) = (winner, chosen) else {
            self.report_direct("failed", None, race.nat_type, report, None);
            return self.refresh_direct(now_ms);
        };
        // Leg one: the init names the authenticated peer the proof will bind.
        let init = ClientSignal::WebtransportUpgradeInit(WebtransportUpgradeInit {
            browser_node_id: self.config.browser_node_id.clone(),
        });
        self.actions.push_back(Action::SendReliable {
            conn,
            channel: CHANNEL_CTRL,
            payload: init.to_json().into_bytes(),
        });
        self.direct.upgrade = Some(Upgrade {
            conn,
            endpoint,
            kind,
            stage: Stage::Challenge,
            deadline_ms: now_ms + CHALLENGE_TIMEOUT_MS,
            nat_type: race.nat_type,
            report,
            temp_peer_id: None,
        });
    }

    /// A control record on the upgrading attachment: the challenge, then the
    /// ack, in the clear, since the path carries nothing sealed until adopted.
    pub(super) fn on_direct_control(&mut self, now_ms: u64, conn: ConnId, payload: &[u8]) {
        let Some(upgrade) = self
            .direct
            .upgrade
            .as_ref()
            .filter(|upgrade| upgrade.conn == conn)
        else {
            return;
        };
        match upgrade.stage {
            Stage::Challenge => {
                let Some(DaemonSignal::WebtransportUpgradeChallenge {
                    nonce_hex,
                    temp_peer_id,
                }) = DaemonSignal::parse(payload)
                else {
                    return self.fail_upgrade(now_ms, Stage::Challenge, "invalid");
                };
                let (Phase::Established(established), Some(issued)) =
                    (&self.phase, self.issued.as_ref())
                else {
                    return self.fail_upgrade(now_ms, Stage::Challenge, "invalid");
                };
                let proof_payload = zeroize::Zeroizing::new(webtransport_upgrade_proof_payload(
                    &nonce_hex,
                    &issued.session_id,
                    &self.config.browser_node_id,
                    &self.daemon_id,
                    &temp_peer_id,
                ));
                let Ok(proof) = merkur_e2e::hmac_sha512(
                    &*established.direct_upgrade_secret,
                    proof_payload.as_bytes(),
                ) else {
                    return self.fail_upgrade(now_ms, Stage::Challenge, "crypto");
                };
                let proof = zeroize::Zeroizing::new(proof);
                let signal = ClientSignal::WebtransportUpgradeProof(WebtransportUpgradeProof {
                    proof_hex: hex(&*proof),
                });
                self.actions.push_back(Action::SendReliable {
                    conn,
                    channel: CHANNEL_CTRL,
                    payload: signal.to_json().into_bytes(),
                });
                if let Some(upgrade) = self.direct.upgrade.as_mut() {
                    upgrade.stage = Stage::Ack;
                    upgrade.deadline_ms = now_ms + ACK_TIMEOUT_MS;
                    upgrade.temp_peer_id = Some(temp_peer_id);
                }
            }
            Stage::Ack => {
                if payload != [MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK, 0, 0, 0] {
                    return self.fail_upgrade(now_ms, Stage::Ack, "invalid");
                }
                let Some(Upgrade {
                    conn,
                    kind,
                    nat_type,
                    report,
                    temp_peer_id: Some(temp_peer_id),
                    ..
                }) = self.direct.upgrade.take()
                else {
                    return;
                };
                self.direct.path = Some(Adopted {
                    conn,
                    kind,
                    nat_type,
                    temp_peer_id,
                });
                self.direct.probe = DirectProbe::default();
                self.finish_admission();
                self.paths.register(PathKind::Direct);
                self.refresh_primary();
                // Measure the newly authenticated provider without retiring
                // the alternate or altering the display generation.
                let (heartbeat, mut link) = self.liveness();
                heartbeat.probe_without_resetting(now_ms, &mut link);
                self.graphics_admit();
                self.report_direct("selected", Some(kind), nat_type, report, None);
            }
        }
    }

    /// The winner's authenticated upgrade failed: it is spent here, and what
    /// else this network offers races.
    fn fail_upgrade(&mut self, now_ms: u64, stage: Stage, reason: &'static str) {
        let Some(mut upgrade) = self.direct.upgrade.take() else {
            return;
        };
        self.actions.push_back(Action::Close { conn: upgrade.conn });
        self.direct.spent.push(upgrade.endpoint);
        for candidate in upgrade
            .report
            .iter_mut()
            .filter(|candidate| candidate.disposition == "won")
        {
            candidate.disposition = "ready_upgrade_failed".to_string();
        }
        self.report_direct(
            "failed",
            None,
            upgrade.nat_type,
            upgrade.report,
            Some((stage.name(), reason)),
        );
        self.refresh_direct(now_ms);
    }

    fn finish_admission(&mut self) {
        if self.direct.native {
            return;
        }
        let Some(manifest) = self.direct.manifest.as_ref() else {
            return;
        };
        if manifest.admission_pending
            || self.direct.race.is_some()
            || self.direct.upgrade.is_some()
            || self.direct.admission_done == Some(manifest.generation)
        {
            return;
        }
        let Some(lanes) = &self.lanes else {
            return;
        };
        let generation = manifest.generation;
        self.direct.admission_done = Some(generation);
        self.actions.push_back(Action::SendReliable {
            conn: lanes.signaling,
            channel: merkur_wire::protocol::CHANNEL_SIGNALING,
            payload: ClientSignal::WebtransportAdmissionDone { generation }
                .to_json()
                .into_bytes(),
        });
    }

    /// What one attempt came to, for the daemon's log. A race that dialled
    /// nothing reports nothing.
    fn report_direct(
        &mut self,
        result: &'static str,
        winner: Option<CandidateKind>,
        nat_type: NatType,
        candidates: Vec<CandidateOutcome>,
        admission: Option<(&'static str, &'static str)>,
    ) {
        if result == "failed"
            && candidates
                .iter()
                .all(|candidate| candidate.disposition == "not_dialled")
        {
            return;
        }
        let Some(lanes) = self.lanes.as_ref() else {
            return;
        };
        let (stage, reason) = admission.unwrap_or(("none", "none"));
        let report = ClientSignal::WebtransportOutcome(WebtransportOutcome {
            outcome: result.to_string(),
            admission_stage: stage.to_string(),
            admission_reason: reason.to_string(),
            nat_type: nat_label(nat_type).to_string(),
            winner_kind: winner.map(|kind| kind_label(kind).to_string()),
            candidates,
        });
        self.actions.push_back(Action::SendReliable {
            conn: lanes.signaling,
            channel: merkur_wire::protocol::CHANNEL_SIGNALING,
            payload: report.to_json().into_bytes(),
        });
    }
}
