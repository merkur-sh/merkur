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

fn race_grace_ms(first_handshake_ms: u64) -> u64 {
    (first_handshake_ms * GRACE_MULTIPLIER).clamp(GRACE_FLOOR_MS, GRACE_CEILING_MS)
}

/// One endpoint: an address under a certificate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Endpoint {
    addr: SocketAddr,
    cert_hash: [u8; 32],
}

struct Manifest {
    generation: u64,
    cert_hash: [u8; 32],
    candidates: Vec<DirectCandidate>,
    nat_type: NatType,
    browser_address: IpAddr,
    punch: PunchState,
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
}

struct Adopted {
    conn: ConnId,
    kind: CandidateKind,
    nat_type: NatType,
}

#[derive(Default)]
pub(super) struct Direct {
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
}

impl Direct {
    /// The adopted direct attachment, which carries every sealed frame.
    pub(super) fn path(&self) -> Option<ConnId> {
        self.path.as_ref().map(|path| path.conn)
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
            .min()
    }

    /// Whether `candidate` needs no punch, or its punch has left. A punched
    /// candidate waits for a manifest built for the address this client is at
    /// now, and for that manifest's punch.
    fn punch_allows(&self, candidate: &DirectCandidate) -> bool {
        let Some(here) = self.carrier_address.or(self
            .manifest
            .as_ref()
            .map(|manifest| manifest.browser_address))
        else {
            return false;
        };
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
    }
}

fn outcome(kind: CandidateKind, disposition: &str) -> CandidateOutcome {
    CandidateOutcome {
        kind: kind_label(kind).to_string(),
        disposition: disposition.to_string(),
    }
}

impl Session {
    /// A manifest landed: it replaces any earlier one.
    pub(super) fn on_direct_manifest(&mut self, now_ms: u64, signal: DaemonSignal) {
        let DaemonSignal::WebtransportManifest {
            generation,
            cert_hash,
            candidates,
            nat,
            browser_address,
            punch,
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
        self.direct.manifest = Some(Manifest {
            generation,
            cert_hash,
            candidates,
            nat_type: nat.nat_type,
            browser_address,
            punch,
        });
        self.refresh_direct(now_ms);
    }

    /// The daemon reported what became of one manifest's punch.
    pub(super) fn on_direct_punch(&mut self, now_ms: u64, generation: u64, outcome: PunchOutcome) {
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
            self.direct.spent.clear();
            self.revoke_race();
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
        self.direct.manifest = None;
        self.direct.punch = None;
        if !keep_network {
            self.direct.carrier_address = None;
            self.direct.spent.clear();
        }
    }

    fn revoke_race(&mut self) {
        let Some(race) = self.direct.race.take() else {
            return;
        };
        for conn in race.attempts.iter().filter_map(|attempt| attempt.conn) {
            self.actions.push_back(Action::Close { conn });
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
            return;
        }
        let Some(nat_type) = self
            .direct
            .manifest
            .as_ref()
            .map(|manifest| manifest.nat_type)
        else {
            return;
        };
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
                });
            }
        }
        self.actions.extend(dials);
    }

    pub(super) fn handle_direct_timeout(&mut self, now_ms: u64) {
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
            let Some(path) = self.direct.path.take() else {
                return;
            };
            // What the path's streams carried is gone with them: input goes
            // out again on the relay.
            self.outbox.reliable_sent = 0;
            self.paths.retire(PathKind::Direct);
            self.refresh_primary();
            self.report_direct("lost", Some(path.kind), path.nat_type, Vec::new(), None);
            self.graphics_interrupt();
            self.flush_input(now_ms);
            return self.refresh_direct(now_ms);
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
                }
            }
            Stage::Ack => {
                if payload != [MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK, 0, 0, 0] {
                    return self.fail_upgrade(now_ms, Stage::Ack, "invalid");
                }
                let Some(upgrade) = self.direct.upgrade.take() else {
                    return;
                };
                self.direct.path = Some(Adopted {
                    conn: upgrade.conn,
                    kind: upgrade.kind,
                    nat_type: upgrade.nat_type,
                });
                self.paths.register(PathKind::Direct);
                self.refresh_primary();
                // Measure the newly authenticated provider without retiring
                // the alternate or altering the display generation.
                let (heartbeat, mut link) = self.liveness();
                heartbeat.probe_without_resetting(now_ms, &mut link);
                self.graphics_admit();
                self.report_direct(
                    "selected",
                    Some(upgrade.kind),
                    upgrade.nat_type,
                    upgrade.report,
                    None,
                );
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
