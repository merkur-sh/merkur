//! One durable port-mapping lease for the pinned WebTransport port, and one
//! IPv6 firewall pinhole for the same port.
//!
//! # Why this exists at all
//!
//! A reflexive (`srflx`) candidate names a NAT mapping the daemon did not ask
//! for and cannot hold open by itself. It survives only because `side_channel`
//! refreshes it against RFC 4787's idle timer and punches filter state toward
//! each browser before it dials. An explicit port-mapping lease depends on
//! neither: the gateway has been told to forward, so unsolicited inbound is
//! admitted by configuration rather than by a race. It is the one candidate
//! kind structurally immune to the filtering that produces `no_settle`, and —
//! because it does not care what external port the NAT would otherwise pick —
//! the one v4 path that works behind endpoint-dependent (symmetric) mapping,
//! where no punch or spray can help a dialer-only browser.
//!
//! # One lease, the first protocol that proves itself
//!
//! PCP, NAT-PMP and UPnP IGD are asked *whether they are there* at the same
//! moment, with requests that change nothing on the gateway: a PCP `ANNOUNCE`
//! and a NAT-PMP external-address request from one socket to the first hop's
//! port 5351, and an SSDP search. The first protocol whose answer proves it
//! present is the one that maps. A gateway that speaks only UPnP therefore maps
//! after one SSDP and one HTTP exchange, instead of after the datagram
//! protocols' whole retransmission schedule has drawn silence.
//!
//! Exactly one protocol ever creates a mapping per cycle. miniupnpd serves all
//! three from one table, and an RFC 6886 delete removes every mapping for the
//! internal port, so two protocols mapping the same port would let one's
//! cleanup destroy the other's lease. A protocol that *refuses* created nothing,
//! so the next proven one may still map.
//!
//! # Only the edge NAT's lease is published
//!
//! A lease is worth publishing only on the NAT a browser would reach, and that
//! NAT's public address is already known: the STUN-observed reflexive address.
//! So the gateway's own view of its external address is compared with it before
//! anything is published — NAT-PMP's external-address answer, UPnP's
//! `GetExternalIPAddress` (asked before `AddPortMapping`), PCP's assigned address
//! in the MAP answer. A mismatch means this host sits behind a second NAT the
//! gateway is not; a mapping there would publish a port the outer NAT does not
//! forward, and the browser's race would spend its settle deadline on it. That is
//! reported as `gateway:inner_nat`, and a PCP mapping it already made is deleted.
//! With no reflexive address there is nothing to compare against, so nothing is
//! attempted (`skipped:no_reflexive`).
//!
//! # The IPv6 pinhole
//!
//! IPv6 has no NAT, so a `host6` candidate is dialable exactly when the CPE's
//! stateful firewall admits the browser's first datagram. `side_channel`'s
//! punch opens address-restricted firewalls; a pinhole opens the strictly
//! larger port-restricted class, which is plain 5-tuple conntrack and the
//! Linux default. The same probe-then-map shape applies: a PCP `ANNOUNCE` over
//! v6 to the first hop (bound to the global address, because the request's
//! client field must match its source) and an IGDv2
//! `WANIPv6FirewallControl:1` search run together, and the first proven one
//! opens the hole. A pinhole changes no address, so the wire keeps its candidate
//! kinds; the effect is the pinholed address ranking first among `host6`
//! candidates.
//!
//! # Nothing here blocks startup
//!
//! `start_server` publishes its candidate set immediately and never waits on a
//! mapping. A won lease arrives later in a new manifest.

pub mod announce;
pub mod natpmp;
pub mod pcp;
pub mod upnp;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::egress::{EgressPath, EgressPath6};

/// Lease lifetime to request. Gateways commonly grant less; the granted value
/// is what drives renewal, never this number. A UPnP gateway that grants only
/// permanent leases has its rule re-asserted on this cadence instead.
const REQUESTED_LIFETIME_SECS: u32 = 3600;

/// First retransmission interval, doubling. RFC 6886 §3.1 mandates 250 ms.
const INITIAL_TIMEOUT: Duration = Duration::from_millis(250);
/// Retries after the first attempt. The RFC's full schedule reaches roughly two
/// minutes across nine attempts; this runs entirely off the critical path, but
/// a maintenance slot is still serialized against certificate rotation, so it
/// stays bounded at ~7.75 s rather than unbounded.
const MAX_RETRIES: usize = 5;
const MAX_RETRY_TIMEOUT: Duration = Duration::from_secs(4);

/// RFC 6887 §19.1 / RFC 6886 §3.1: PCP and NAT-PMP servers listen on 5351.
const PXP_PORT: u16 = 5351;

/// Retransmission schedule, RFC 6887 §8.1.1 shape: doubling from the initial
/// interval, capped, a bounded number of attempts.
#[derive(Debug, Clone, Copy)]
pub struct RetransmitSchedule {
    pub initial: Duration,
    pub max_interval: Duration,
    pub attempts: u32,
}

impl RetransmitSchedule {
    pub const PRODUCTION: Self = Self {
        initial: INITIAL_TIMEOUT,
        max_interval: MAX_RETRY_TIMEOUT,
        attempts: MAX_RETRIES as u32 + 1,
    };

    /// One send and one wait: a delete is best effort, and its answer changes
    /// nothing the caller does.
    const DELETE: Self = Self {
        initial: INITIAL_TIMEOUT,
        max_interval: INITIAL_TIMEOUT,
        attempts: 2,
    };
}

/// Where the probes go and how long SSDP listens. Fixed by the protocols in
/// production; tests point them at fake servers and shorten the window.
#[derive(Debug, Clone, Copy)]
pub struct GatewayPorts {
    pub pxp: u16,
    pub ssdp: u16,
    pub ssdp_window: Duration,
}

impl GatewayPorts {
    pub const STANDARD: Self = Self {
        pxp: PXP_PORT,
        ssdp: upnp::SSDP_PORT,
        ssdp_window: upnp::SSDP_WINDOW,
    };
}

/// Which protocol produced a lease. Reported as a metric dimension so "which of
/// these actually works on real networks" is answerable from the fleet rather
/// than by scraping one daemon's logs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    Pcp,
    NatPmp,
    Upnp,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pcp => "pcp",
            Self::NatPmp => "natpmp",
            Self::Upnp => "upnp",
        }
    }

    pub fn mapped_key(self) -> &'static str {
        match self {
            Self::Pcp => "pcp:mapped",
            Self::NatPmp => "natpmp:mapped",
            Self::Upnp => "upnp:mapped",
        }
    }

    pub fn renewed_key(self) -> &'static str {
        match self {
            Self::Pcp => "pcp:renewed",
            Self::NatPmp => "natpmp:renewed",
            Self::Upnp => "upnp:renewed",
        }
    }
}

/// Why no request was sent. Distinct from a request that was sent and refused.
///
/// This distinction is the whole point. The predecessor collapsed "we never
/// asked" and "the gateway said no" into the same `false`, which is what let a
/// 30-day run of zeroes read as "these protocols do not work" when it may only
/// have meant "we never addressed a gateway".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// No egress path resolved at all — no routable IPv4 interface.
    NoEgressPath,
    /// An egress interface, but no first hop on it or on the default route.
    NoGateway,
    /// No STUN-observed IPv4 address yet, so no lease could be verified as the
    /// edge NAT's.
    ReflexiveUnknown,
}

impl SkipReason {
    fn metric_key(self) -> &'static str {
        match self {
            Self::NoEgressPath => "skipped:no_egress_path",
            Self::NoGateway => "skipped:no_gateway",
            Self::ReflexiveUnknown => "skipped:no_reflexive",
        }
    }
}

/// The gateway-side handle a lease needs to renew and release itself.
#[derive(Clone, Debug)]
enum LeaseHandle {
    /// A PCP MAP is named by its nonce across acquire, renew and delete.
    Pcp { nonce: [u8; 12], internal_port: u16 },
    /// NAT-PMP names a mapping by its internal port alone.
    NatPmp { internal_port: u16 },
    /// A UPnP mapping is identified on the gateway by its external port; the
    /// control endpoint is what renewal and deletion address. `lease_secs` is
    /// what the gateway accepted: 0 when it grants only permanent leases.
    Upnp {
        control: upnp::ControlUrl,
        external_port: u16,
        internal_port: u16,
        client: Ipv4Addr,
        lease_secs: u32,
    },
}

/// A live lease. Dropping it does **not** delete the mapping — see [`release`].
#[derive(Clone, Debug)]
pub struct Lease {
    /// The verified edge-NAT address and the granted external port.
    pub external: SocketAddr,
    pub protocol: Protocol,
    /// Lifetime the gateway granted, which may be far less than requested.
    pub lifetime: Duration,
    /// When this daemon's clock says the lease lapses.
    pub expires_at: Instant,
    /// Gateway epoch at acquisition. A backwards jump means the gateway
    /// rebooted and dropped every mapping — RFC 6886 §3.6, RFC 6887 §8.5.
    /// UPnP carries no epoch and reports zero; its loss is detected by the
    /// announcement listener not at all, and by renewal re-asserting the
    /// mapping, which `AddPortMapping` does idempotently.
    pub epoch: u32,
    /// The first hop this lease was taken from and the interface it left by.
    /// A path edge that moves either one means the lease is on the wrong
    /// gateway, whatever its renewal timer says.
    pub gateway: Ipv4Addr,
    pub interface_index: u32,
    pub local_ipv4: Ipv4Addr,
    inner: LeaseHandle,
}

/// The published half of a lease: what a browser would dial, and until when.
///
/// Deliberately separate from [`Lease`], which owns the gateway handle needed
/// to renew. The reprobe only has to decide whether to carry a candidate
/// forward, so it takes this and stays a pure function over plain data — the
/// same property that makes the reflexive carry-forward rules testable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriorLease {
    pub candidate: super::AddressCandidate,
    pub expires_at: Instant,
    pub protocol: Protocol,
}

impl PriorLease {
    pub fn is_live(&self, now: Instant) -> bool {
        self.expires_at > now
    }
}

impl Lease {
    pub fn prior(&self) -> PriorLease {
        PriorLease {
            candidate: self.candidate(),
            expires_at: self.expires_at,
            protocol: self.protocol,
        }
    }

    /// Renew at half the *granted* lifetime, not at a fixed interval against an
    /// assumed one. A gateway that grants 120 s against a 3600 s request is
    /// common, and a fixed 30-minute timer would let that lease lapse 28 times
    /// over before noticing.
    pub fn renew_after(&self) -> Duration {
        self.expires_at
            .saturating_duration_since(Instant::now())
            .saturating_sub(self.lifetime / 2)
    }

    pub fn candidate(&self) -> super::AddressCandidate {
        super::AddressCandidate {
            addr: self.external.ip().to_string(),
            port: self.external.port(),
            kind: super::CandidateFlavor::NatMap,
        }
    }

    /// Whether `announcement` says the gateway no longer holds this lease: the
    /// epoch went backwards, or the external address it announces is not the
    /// one this lease was published under.
    pub fn lost_to(&self, announcement: &announce::Announcement) -> bool {
        if matches!(self.inner, LeaseHandle::Upnp { .. }) {
            // UPnP holds no epoch; an announcement is another protocol's.
            return false;
        }
        announcement.epoch < self.epoch
            || announcement
                .external
                .is_some_and(|external| IpAddr::V4(external) != self.external.ip())
    }

    fn server(&self) -> pcp::Server {
        pcp::Server {
            gateway: IpAddr::V4(self.gateway),
            interface: self.interface_index,
            port: PXP_PORT,
        }
    }
}

/// What one acquisition attempt learned. Every arm is reportable; none of them
/// is silence.
#[derive(Debug)]
pub enum Outcome {
    Mapped(Box<Lease>),
    /// A gateway was addressed and no protocol gave a usable mapping.
    Unsupported,
    /// A protocol answered, and the gateway's external address is not the
    /// reflexive one: this host is behind a NAT the gateway is not.
    InnerNat,
    /// No request was sent, and why.
    NotAttempted(SkipReason),
}

impl Outcome {
    /// Metric label, `"<protocol-or-skip>:<outcome>"`, over a closed set.
    pub fn metric_key(&self) -> &'static str {
        match self {
            Self::Mapped(lease) => lease.protocol.mapped_key(),
            Self::Unsupported => "gateway:unsupported",
            Self::InnerNat => "gateway:inner_nat",
            Self::NotAttempted(reason) => reason.metric_key(),
        }
    }
}

/// Probe, pick the first proven protocol, take exactly one lease.
///
/// Never blocks a caller that matters: this runs on the detached maintenance
/// task, and its result reaches browsers in a new manifest.
pub async fn acquire(
    internal_port: u16,
    egress: Option<&EgressPath>,
    reflexive: Option<IpAddr>,
) -> Outcome {
    acquire_with(
        internal_port,
        egress,
        reflexive,
        RetransmitSchedule::PRODUCTION,
        GatewayPorts::STANDARD,
    )
    .await
}

/// A first-hop datagram protocol that answered its non-mutating probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FirstHopProof {
    Pcp,
    NatPmp { external: Ipv4Addr },
}

/// What one mapping attempt with a proven protocol produced.
enum Attempt {
    Mapped(Box<Lease>),
    /// The gateway is not the edge NAT; nothing of ours is left on it.
    InnerNat,
    /// The protocol refused or went silent; it created nothing.
    Refused,
}

/// [`acquire`] with an explicit schedule and gateway ports.
///
/// Exists so tests can drive the real code path against fake gateways and a
/// blackholed one without paying the production schedule, which is
/// deliberately long because nothing waits on it.
pub(crate) async fn acquire_with(
    internal_port: u16,
    egress: Option<&EgressPath>,
    reflexive: Option<IpAddr>,
    schedule: RetransmitSchedule,
    ports: GatewayPorts,
) -> Outcome {
    let Some(egress) = egress else {
        warn!("port mapping not attempted: no egress path resolved");
        return Outcome::NotAttempted(SkipReason::NoEgressPath);
    };
    let Some(gateway) = egress.gateway else {
        warn!(
            interface = %egress.interface_name,
            local = %egress.local_ipv4,
            "port mapping not attempted: no first hop on the egress interface or the default route"
        );
        return Outcome::NotAttempted(SkipReason::NoGateway);
    };
    if internal_port == 0 {
        return Outcome::NotAttempted(SkipReason::NoEgressPath);
    }
    let Some(IpAddr::V4(reflexive)) = reflexive else {
        info!("port mapping not attempted: no STUN-observed IPv4 address to verify a lease against");
        return Outcome::NotAttempted(SkipReason::ReflexiveUnknown);
    };

    info!(
        gateway = %gateway,
        client = %egress.local_ipv4,
        interface = %egress.interface_name,
        %reflexive,
        "requesting a port-mapping lease"
    );

    let server = pcp::Server {
        gateway: IpAddr::V4(gateway),
        interface: egress.interface_index,
        port: ports.pxp,
    };
    let (proof_tx, mut proofs) = mpsc::channel(2);
    let first_hop = probe_first_hop(egress.local_ipv4, server, schedule, proof_tx);
    let igd = upnp::discover(egress, ports.ssdp, ports.ssdp_window, reflexive);
    tokio::pin!(first_hop);
    tokio::pin!(igd);
    let (mut first_hop_done, mut proofs_closed, mut igd_done) = (false, false, false);
    let mut inner_nat = false;

    while !(proofs_closed && igd_done) {
        let attempt = tokio::select! {
            biased;
            proof = proofs.recv(), if !proofs_closed => match proof {
                Some(FirstHopProof::Pcp) => {
                    map_pcp(egress, server, internal_port, reflexive, schedule).await
                }
                Some(FirstHopProof::NatPmp { external }) if external != reflexive => {
                    info!(%external, %reflexive, "natpmp: gateway is not the edge NAT; not mapping on it");
                    Attempt::InnerNat
                }
                Some(FirstHopProof::NatPmp { .. }) => {
                    map_natpmp(egress, server, internal_port, reflexive, schedule).await
                }
                None => {
                    proofs_closed = true;
                    Attempt::Refused
                }
            },
            () = &mut first_hop, if !first_hop_done => {
                first_hop_done = true;
                Attempt::Refused
            }
            found = &mut igd, if !igd_done => {
                igd_done = true;
                match found {
                    upnp::Discovery::Edge(control) => {
                        map_upnp(egress, control, internal_port, reflexive).await
                    }
                    upnp::Discovery::InnerNat => Attempt::InnerNat,
                    upnp::Discovery::None => Attempt::Refused,
                }
            }
        };
        match attempt {
            Attempt::Mapped(lease) => {
                info!(
                    protocol = lease.protocol.as_str(),
                    external = %lease.external,
                    lifetime_s = lease.lifetime.as_secs(),
                    "port-mapping lease acquired"
                );
                return Outcome::Mapped(lease);
            }
            Attempt::InnerNat => inner_nat = true,
            Attempt::Refused => {}
        }
    }
    if inner_nat {
        Outcome::InnerNat
    } else {
        Outcome::Unsupported
    }
}

/// Ask PCP and NAT-PMP whether they are there, from one socket bound to the
/// egress address, each on its own retransmission schedule.
///
/// Both requests change nothing on the gateway. The version byte tells the
/// answers apart: a PCP `ANNOUNCE` answer is version 2; NAT-PMP's
/// external-address answer is version 0. A NAT-PMP-only server answers the PCP
/// request with a version-0 `UNSUPP_VERSION`, and a PCP-only server answers the
/// NAT-PMP request with a version-2 one; either settles that protocol as absent.
/// An ICMP port-unreachable settles both.
async fn probe_first_hop(
    client: Ipv4Addr,
    server: pcp::Server,
    schedule: RetransmitSchedule,
    proofs: mpsc::Sender<FirstHopProof>,
) {
    let Ok(socket) = pcp::bind(IpAddr::V4(client), server).await else {
        return;
    };
    let announce = pcp::announce_request(IpAddr::V4(client));
    let (mut pcp_open, mut natpmp_open) = (true, true);
    let mut buf = [0u8; pcp::MAX_RESPONSE_LEN];
    let mut interval = schedule.initial;
    for _ in 0..schedule.attempts.max(1) {
        if pcp_open {
            let _ = socket.send(&announce).await;
        }
        if natpmp_open {
            let _ = socket.send(&natpmp::EXTERNAL_ADDRESS_REQUEST).await;
        }
        let deadline = tokio::time::Instant::now() + interval;
        while pcp_open || natpmp_open {
            let len = match tokio::time::timeout_at(deadline, socket.recv(&mut buf)).await {
                Err(_) => break,
                Ok(Ok(len)) => len,
                Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                    debug!(gateway = %server.gateway, "first hop refused port 5351: neither PCP nor NAT-PMP");
                    return;
                }
                Ok(Err(_)) => return,
            };
            let answer = &buf[..len];
            if let Some(announced) = pcp::parse_announce(answer) {
                match announced {
                    pcp::AnnounceAnswer::Present { .. } => {
                        if pcp_open {
                            pcp_open = false;
                            let _ = proofs.send(FirstHopProof::Pcp).await;
                        }
                    }
                    // A PCP server refusing our version-0 request: NAT-PMP is
                    // not here; PCP's own answer is still to come.
                    pcp::AnnounceAnswer::Refused(pcp::RESULT_UNSUPP_VERSION) => {
                        natpmp_open = false;
                    }
                    pcp::AnnounceAnswer::Refused(code) => {
                        pcp_open = false;
                        debug!(code, "pcp: ANNOUNCE refused");
                    }
                }
                continue;
            }
            match natpmp::parse_answer(answer) {
                // A retransmitted request can draw a second answer; one proof
                // per protocol.
                Some(natpmp::Answer::External { address, .. }) if natpmp_open => {
                    natpmp_open = false;
                    let _ = proofs
                        .send(FirstHopProof::NatPmp { external: address })
                        .await;
                }
                Some(natpmp::Answer::External { .. }) => {}
                Some(natpmp::Answer::PcpUnsupported) => pcp_open = false,
                Some(natpmp::Answer::Refused(code)) => {
                    natpmp_open = false;
                    debug!(code, "natpmp: external-address request refused");
                }
                None => {
                    // A PCP-only server's version-2 refusal of the NAT-PMP
                    // request carries no opcode this parser knows.
                    if answer.len() >= 4
                        && answer[0] == pcp::VERSION
                        && answer[3] == pcp::RESULT_UNSUPP_VERSION
                    {
                        natpmp_open = false;
                    }
                }
            }
        }
        if !pcp_open && !natpmp_open {
            return;
        }
        interval = (interval * 2).min(schedule.max_interval);
    }
}

fn random_nonce() -> [u8; 12] {
    let mut nonce = [0u8; 12];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce);
    nonce
}

fn lease(
    egress: &EgressPath,
    reflexive: Ipv4Addr,
    external_port: u16,
    protocol: Protocol,
    lifetime_secs: u32,
    epoch: u32,
    inner: LeaseHandle,
) -> Box<Lease> {
    let lifetime = Duration::from_secs(u64::from(lifetime_secs));
    Box::new(Lease {
        external: SocketAddr::new(IpAddr::V4(reflexive), external_port),
        protocol,
        lifetime,
        expires_at: Instant::now() + lifetime,
        epoch,
        gateway: egress.gateway.unwrap_or(Ipv4Addr::UNSPECIFIED),
        interface_index: egress.interface_index,
        local_ipv4: egress.local_ipv4,
        inner,
    })
}

async fn map_pcp(
    egress: &EgressPath,
    server: pcp::Server,
    internal_port: u16,
    reflexive: Ipv4Addr,
    schedule: RetransmitSchedule,
) -> Attempt {
    let nonce = random_nonce();
    let client = IpAddr::V4(egress.local_ipv4);
    let mapping = match pcp::map(
        client,
        server,
        internal_port,
        REQUESTED_LIFETIME_SECS,
        nonce,
        IpAddr::V4(reflexive),
        schedule,
    )
    .await
    {
        Ok(mapping) if mapping.lifetime_secs > 0 => mapping,
        Ok(_) => {
            warn!("pcp: gateway granted a zero-lifetime mapping; not usable");
            return Attempt::Refused;
        }
        Err(error) => {
            debug!("pcp: no mapping: {error:?}");
            return Attempt::Refused;
        }
    };
    if pcp::unmapped(mapping.assigned_external) != IpAddr::V4(reflexive) {
        info!(
            assigned = %mapping.assigned_external,
            %reflexive,
            "pcp: gateway is not the edge NAT; deleting the mapping it made"
        );
        let _ = pcp::map(
            client,
            server,
            internal_port,
            0,
            nonce,
            IpAddr::V4(reflexive),
            RetransmitSchedule::DELETE,
        )
        .await;
        return Attempt::InnerNat;
    }
    Attempt::Mapped(lease(
        egress,
        reflexive,
        mapping.assigned_external_port,
        Protocol::Pcp,
        mapping.lifetime_secs,
        mapping.epoch,
        LeaseHandle::Pcp {
            nonce,
            internal_port,
        },
    ))
}

async fn map_natpmp(
    egress: &EgressPath,
    server: pcp::Server,
    internal_port: u16,
    reflexive: Ipv4Addr,
    schedule: RetransmitSchedule,
) -> Attempt {
    match natpmp::map(
        egress.local_ipv4,
        server,
        internal_port,
        REQUESTED_LIFETIME_SECS,
        schedule,
    )
    .await
    {
        Ok(mapping) if mapping.lifetime_secs > 0 => Attempt::Mapped(lease(
            egress,
            reflexive,
            mapping.external_port,
            Protocol::NatPmp,
            mapping.lifetime_secs,
            mapping.epoch,
            LeaseHandle::NatPmp { internal_port },
        )),
        Ok(_) => {
            warn!("natpmp: gateway granted a zero-lifetime mapping; not usable");
            Attempt::Refused
        }
        Err(error) => {
            debug!("natpmp: no mapping: {error:?}");
            Attempt::Refused
        }
    }
}

async fn map_upnp(
    egress: &EgressPath,
    control: upnp::ControlUrl,
    internal_port: u16,
    reflexive: Ipv4Addr,
) -> Attempt {
    match upnp::add_port_mapping(
        &control,
        egress.local_ipv4,
        internal_port,
        internal_port,
        REQUESTED_LIFETIME_SECS,
    )
    .await
    {
        Ok(granted) => Attempt::Mapped(lease(
            egress,
            reflexive,
            granted.external_port,
            Protocol::Upnp,
            upnp_cadence_secs(granted.lease_secs),
            0,
            LeaseHandle::Upnp {
                control,
                external_port: granted.external_port,
                internal_port,
                client: egress.local_ipv4,
                lease_secs: granted.lease_secs,
            },
        )),
        Err(error) => {
            upnp::log_refusal("AddPortMapping", error);
            Attempt::Refused
        }
    }
}

/// The lifetime a UPnP lease is tracked under: what the gateway accepted, or,
/// for a permanent lease, the requested lifetime as the re-assert cadence.
fn upnp_cadence_secs(lease_secs: u32) -> u32 {
    if lease_secs == 0 {
        REQUESTED_LIFETIME_SECS
    } else {
        lease_secs
    }
}

/// Renew in place. `false` means the lease should be treated as lost.
pub async fn renew(lease: &mut Lease) -> bool {
    let server = lease.server();
    let reflexive = lease.external.ip();
    let client = lease.local_ipv4;
    // Cloned so the gateway exchange can update the lease it renews; this runs
    // once per half-lifetime.
    match lease.inner.clone() {
        LeaseHandle::Pcp {
            nonce,
            internal_port,
        } => {
            match pcp::map(
                IpAddr::V4(client),
                server,
                internal_port,
                REQUESTED_LIFETIME_SECS,
                nonce,
                reflexive,
                RetransmitSchedule::PRODUCTION,
            )
            .await
            {
                Ok(mapping)
                    if mapping.lifetime_secs > 0
                        && mapping.assigned_external_port == lease.external.port()
                        && pcp::unmapped(mapping.assigned_external) == reflexive =>
                {
                    if !accept_epoch(lease, mapping.epoch, mapping.lifetime_secs) {
                        return false;
                    }
                }
                Ok(_) => return false,
                Err(error) => {
                    warn!("pcp lease renewal failed: {error:?}");
                    return false;
                }
            }
        }
        LeaseHandle::NatPmp { internal_port } => {
            match natpmp::map(
                client,
                server,
                internal_port,
                REQUESTED_LIFETIME_SECS,
                RetransmitSchedule::PRODUCTION,
            )
            .await
            {
                Ok(mapping) if mapping.lifetime_secs > 0 => {
                    if mapping.external_port != lease.external.port() {
                        warn!(
                            published = lease.external.port(),
                            granted = mapping.external_port,
                            "natpmp: renewal moved the external port; re-acquiring"
                        );
                        return false;
                    }
                    if !accept_epoch(lease, mapping.epoch, mapping.lifetime_secs) {
                        return false;
                    }
                }
                Ok(_) => return false,
                Err(error) => {
                    warn!("natpmp lease renewal failed: {error:?}");
                    return false;
                }
            }
        }
        LeaseHandle::Upnp {
            control,
            external_port,
            internal_port,
            client,
            lease_secs,
        } => {
            // `AddPortMapping` on an existing entry refreshes its lease; on a
            // rebooted gateway it recreates it. Both are the renewal wanted.
            match upnp::add_port_mapping(&control, client, internal_port, external_port, lease_secs)
                .await
            {
                Ok(granted) if granted.external_port == external_port => {
                    lease.lifetime =
                        Duration::from_secs(u64::from(upnp_cadence_secs(granted.lease_secs)));
                    lease.expires_at = Instant::now() + lease.lifetime;
                    lease.inner = LeaseHandle::Upnp {
                        control,
                        external_port,
                        internal_port,
                        client,
                        lease_secs: granted.lease_secs,
                    };
                }
                Ok(other) => {
                    // The gateway handed the port to someone else meanwhile
                    // and reserved a different one; the published candidate
                    // is now wrong, so re-acquire through the ordinary path.
                    warn!(
                        published = external_port,
                        granted = other.external_port,
                        "upnp: renewal moved the external port; re-acquiring"
                    );
                    let _ = upnp::delete_port_mapping(&control, other.external_port).await;
                    return false;
                }
                Err(error) => {
                    upnp::log_refusal("AddPortMapping(renew)", error);
                    return false;
                }
            }
        }
    }
    debug!(
        protocol = lease.protocol.as_str(),
        lifetime_s = lease.lifetime.as_secs(),
        "port-mapping lease renewed"
    );
    true
}

/// RFC 6886 §3.6 / RFC 6887 §8.5: a gateway epoch that moves backwards means
/// the device rebooted and lost every mapping. A renewal that "succeeded"
/// against such a gateway no longer holds our forward, so the lease has to be
/// re-acquired rather than trusted.
fn accept_epoch(lease: &mut Lease, epoch: u32, lifetime_secs: u32) -> bool {
    if epoch < lease.epoch {
        warn!(
            previous_epoch = lease.epoch,
            epoch, "gateway epoch went backwards; the lease was lost to a reboot"
        );
        return false;
    }
    lease.epoch = epoch;
    lease.lifetime = Duration::from_secs(u64::from(lifetime_secs));
    lease.expires_at = Instant::now() + lease.lifetime;
    true
}

/// Delete the mapping on the gateway, best effort.
///
/// Deliberately an explicit call rather than a `Drop` impl. RFC 6886 §3.4
/// deletion removes **every** mapping for an internal port, so an unfenced
/// delete racing a freshly created replacement destroys the replacement. Making
/// retirement explicit is what lets the caller order it against re-acquisition
/// instead of hoping a detached destructor lands first.
pub async fn release(lease: Lease) {
    let server = lease.server();
    match lease.inner {
        LeaseHandle::Pcp {
            nonce,
            internal_port,
        } => {
            if let Err(error) = pcp::map(
                IpAddr::V4(lease.local_ipv4),
                server,
                internal_port,
                0,
                nonce,
                lease.external.ip(),
                RetransmitSchedule::DELETE,
            )
            .await
            {
                debug!("pcp lease delete failed, letting it expire: {error:?}");
            }
        }
        LeaseHandle::NatPmp { internal_port } => {
            if let Err(error) = natpmp::map(
                lease.local_ipv4,
                server,
                internal_port,
                0,
                RetransmitSchedule::DELETE,
            )
            .await
            {
                debug!("natpmp lease delete failed, letting it expire: {error:?}");
            }
        }
        LeaseHandle::Upnp { control, external_port, .. } => {
            if let Err(error) = upnp::delete_port_mapping(&control, external_port).await {
                upnp::log_refusal("DeletePortMapping", error);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// IPv6 pinhole
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinholeProtocol {
    Pcp6,
    Upnp6,
}

impl PinholeProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pcp6 => "pcp6",
            Self::Upnp6 => "upnp6",
        }
    }

    fn pinholed_key(self) -> &'static str {
        match self {
            Self::Pcp6 => "pcp6:pinholed",
            Self::Upnp6 => "upnp6:pinholed",
        }
    }

    fn renewed_key(self) -> &'static str {
        match self {
            Self::Pcp6 => "pcp6:renewed",
            Self::Upnp6 => "upnp6:renewed",
        }
    }
}

#[derive(Clone, Debug)]
enum PinholeHandle {
    Pcp {
        gateway: Ipv6Addr,
        interface: u32,
        nonce: [u8; 12],
    },
    Upnp {
        control: upnp::ControlUrl,
        unique_id: u16,
    },
}

/// A live firewall pinhole for UDP `port` on `address`.
#[derive(Clone, Debug)]
pub struct Pinhole {
    pub address: Ipv6Addr,
    pub port: u16,
    pub protocol: PinholeProtocol,
    pub lifetime: Duration,
    pub expires_at: Instant,
    pub epoch: u32,
    pub gateway: Ipv6Addr,
    pub interface_index: u32,
    inner: PinholeHandle,
}

impl Pinhole {
    pub fn renew_after(&self) -> Duration {
        self.expires_at
            .saturating_duration_since(Instant::now())
            .saturating_sub(self.lifetime / 2)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinholeSkip {
    /// No global IPv6 address is offered, or nothing owns it.
    NoV6Path,
    /// A global address, but no v6 first hop to ask.
    NoV6Gateway,
}

#[derive(Debug)]
pub enum PinholeOutcome {
    Pinholed(Box<Pinhole>),
    /// A gateway was addressed and neither protocol opened a hole.
    Unsupported,
    NotAttempted(PinholeSkip),
}

impl PinholeOutcome {
    pub fn metric_key(&self) -> &'static str {
        match self {
            Self::Pinholed(pinhole) => pinhole.protocol.pinholed_key(),
            Self::Unsupported => "gateway6:unsupported",
            Self::NotAttempted(PinholeSkip::NoV6Path) => "skipped:no_v6_path",
            Self::NotAttempted(PinholeSkip::NoV6Gateway) => "skipped:no_v6_gateway",
        }
    }
}

/// Open a pinhole for `port` on `egress.local`: a PCP `ANNOUNCE` to the first
/// hop and an IGDv2 search run together, and the first proven protocol opens
/// the hole.
pub async fn acquire_pinhole(port: u16, egress: Option<&EgressPath6>) -> PinholeOutcome {
    acquire_pinhole_with(
        port,
        egress,
        RetransmitSchedule::PRODUCTION,
        GatewayPorts::STANDARD,
    )
    .await
}

pub(crate) async fn acquire_pinhole_with(
    port: u16,
    egress: Option<&EgressPath6>,
    schedule: RetransmitSchedule,
    ports: GatewayPorts,
) -> PinholeOutcome {
    let Some(egress) = egress else {
        return PinholeOutcome::NotAttempted(PinholeSkip::NoV6Path);
    };
    let Some(gateway) = egress.gateway else {
        warn!(
            interface = %egress.interface_name,
            local = %egress.local,
            "v6 pinhole not attempted: no first hop"
        );
        return PinholeOutcome::NotAttempted(PinholeSkip::NoV6Gateway);
    };
    info!(
        gateway = %gateway,
        client = %egress.local,
        interface = %egress.interface_name,
        "requesting an IPv6 firewall pinhole"
    );
    let server = pcp::Server {
        gateway: IpAddr::V6(gateway),
        interface: egress.interface_index,
        port: ports.pxp,
    };
    let pcp_present = pcp_announced(IpAddr::V6(egress.local), server, schedule);
    let igd = upnp::discover_v6(egress, ports.ssdp_window);
    tokio::pin!(pcp_present);
    tokio::pin!(igd);
    let (mut pcp_done, mut igd_done) = (false, false);
    while !(pcp_done && igd_done) {
        let opened = tokio::select! {
            biased;
            present = &mut pcp_present, if !pcp_done => {
                pcp_done = true;
                if present {
                    open_pcp_pinhole(egress, gateway, server, port, schedule).await
                } else {
                    None
                }
            }
            control = &mut igd, if !igd_done => {
                igd_done = true;
                match control {
                    Some(control) => open_upnp_pinhole(egress, gateway, control, port).await,
                    None => None,
                }
            }
        };
        if let Some(pinhole) = opened {
            return PinholeOutcome::Pinholed(pinhole);
        }
    }
    PinholeOutcome::Unsupported
}

/// Whether a PCP server answers `ANNOUNCE` with success, on the schedule.
async fn pcp_announced(client: IpAddr, server: pcp::Server, schedule: RetransmitSchedule) -> bool {
    let Ok(socket) = pcp::bind(client, server).await else {
        return false;
    };
    let request = pcp::announce_request(client);
    let mut buf = [0u8; pcp::MAX_RESPONSE_LEN];
    let mut interval = schedule.initial;
    for _ in 0..schedule.attempts.max(1) {
        if socket.send(&request).await.is_err() {
            return false;
        }
        let deadline = tokio::time::Instant::now() + interval;
        loop {
            let len = match tokio::time::timeout_at(deadline, socket.recv(&mut buf)).await {
                Err(_) => break,
                Ok(Ok(len)) => len,
                Ok(Err(_)) => return false,
            };
            match pcp::parse_announce(&buf[..len]) {
                Some(pcp::AnnounceAnswer::Present { .. }) => return true,
                Some(pcp::AnnounceAnswer::Refused(code)) => {
                    debug!(code, "pcp: ANNOUNCE refused");
                    return false;
                }
                None if natpmp::parse_answer(&buf[..len])
                    == Some(natpmp::Answer::PcpUnsupported) =>
                {
                    return false;
                }
                None => {}
            }
        }
        interval = (interval * 2).min(schedule.max_interval);
    }
    debug!(gateway = %server.gateway, "pcp: no ANNOUNCE answer across the retransmission schedule");
    false
}

async fn open_pcp_pinhole(
    egress: &EgressPath6,
    gateway: Ipv6Addr,
    server: pcp::Server,
    port: u16,
    schedule: RetransmitSchedule,
) -> Option<Box<Pinhole>> {
    let nonce = random_nonce();
    let client = IpAddr::V6(egress.local);
    match pcp::map(
        client,
        server,
        port,
        REQUESTED_LIFETIME_SECS,
        nonce,
        client,
        schedule,
    )
    .await
    {
        Ok(mapping) if mapping.lifetime_secs > 0 && mapping.assigned_external_port == port => {
            let lifetime = Duration::from_secs(u64::from(mapping.lifetime_secs));
            info!(protocol = "pcp6", address = %egress.local, lifetime_s = lifetime.as_secs(), "IPv6 pinhole opened");
            Some(Box::new(Pinhole {
                address: egress.local,
                port,
                protocol: PinholeProtocol::Pcp6,
                lifetime,
                expires_at: Instant::now() + lifetime,
                epoch: mapping.epoch,
                gateway,
                interface_index: egress.interface_index,
                inner: PinholeHandle::Pcp {
                    gateway,
                    interface: egress.interface_index,
                    nonce,
                },
            }))
        }
        Ok(_) => {
            warn!("pcp6: gateway granted a zero-lifetime or moved pinhole; not usable");
            None
        }
        Err(error) => {
            debug!(gateway = %gateway, "no pcp6 pinhole: {error:?}");
            None
        }
    }
}

async fn open_upnp_pinhole(
    egress: &EgressPath6,
    gateway: Ipv6Addr,
    control: upnp::ControlUrl,
    port: u16,
) -> Option<Box<Pinhole>> {
    // IGDv2 caps a pinhole lease at 86400 s; asking for the same hour as the
    // v4 lease keeps one renewal cadence.
    match upnp::add_pinhole(&control, egress.local, port, REQUESTED_LIFETIME_SECS).await {
        Ok(unique_id) => {
            let lifetime = Duration::from_secs(u64::from(REQUESTED_LIFETIME_SECS));
            info!(protocol = "upnp6", address = %egress.local, unique_id, "IPv6 pinhole opened");
            Some(Box::new(Pinhole {
                address: egress.local,
                port,
                protocol: PinholeProtocol::Upnp6,
                lifetime,
                expires_at: Instant::now() + lifetime,
                epoch: 0,
                gateway,
                interface_index: egress.interface_index,
                inner: PinholeHandle::Upnp { control, unique_id },
            }))
        }
        Err(error) => {
            upnp::log_refusal("AddPinhole", error);
            None
        }
    }
}

/// Renew in place. `false` means the pinhole should be treated as lost.
pub async fn renew_pinhole(pinhole: &mut Pinhole) -> bool {
    match &pinhole.inner {
        PinholeHandle::Pcp {
            gateway,
            interface,
            nonce,
        } => match pcp::map(
            IpAddr::V6(pinhole.address),
            pcp::Server {
                gateway: IpAddr::V6(*gateway),
                interface: *interface,
                port: PXP_PORT,
            },
            pinhole.port,
            REQUESTED_LIFETIME_SECS,
            *nonce,
            IpAddr::V6(pinhole.address),
            RetransmitSchedule::PRODUCTION,
        )
        .await
        {
            Ok(mapping)
                if mapping.lifetime_secs > 0 && mapping.assigned_external_port == pinhole.port =>
            {
                if mapping.epoch < pinhole.epoch {
                    warn!(
                        previous_epoch = pinhole.epoch,
                        epoch = mapping.epoch,
                        "gateway epoch went backwards; the pinhole was lost to a reboot"
                    );
                    return false;
                }
                pinhole.epoch = mapping.epoch;
                pinhole.lifetime = Duration::from_secs(u64::from(mapping.lifetime_secs));
                pinhole.expires_at = Instant::now() + pinhole.lifetime;
            }
            Ok(_) => return false,
            Err(error) => {
                warn!("pcp6 pinhole renewal failed: {error:?}");
                return false;
            }
        },
        PinholeHandle::Upnp { control, unique_id } => {
            match upnp::update_pinhole(control, *unique_id, REQUESTED_LIFETIME_SECS).await {
                Ok(()) => {
                    pinhole.lifetime = Duration::from_secs(u64::from(REQUESTED_LIFETIME_SECS));
                    pinhole.expires_at = Instant::now() + pinhole.lifetime;
                }
                Err(error) => {
                    upnp::log_refusal("UpdatePinhole", error);
                    return false;
                }
            }
        }
    }
    debug!(protocol = pinhole.protocol.as_str(), "IPv6 pinhole renewed");
    true
}

/// Close the pinhole on the gateway, best effort. Explicit for the same
/// ordering reason as [`release`].
pub async fn release_pinhole(pinhole: Pinhole) {
    match pinhole.inner {
        PinholeHandle::Pcp {
            gateway,
            interface,
            nonce,
        } => {
            let _ = pcp::map(
                IpAddr::V6(pinhole.address),
                pcp::Server {
                    gateway: IpAddr::V6(gateway),
                    interface,
                    port: PXP_PORT,
                },
                pinhole.port,
                0,
                nonce,
                IpAddr::V6(pinhole.address),
                RetransmitSchedule::DELETE,
            )
            .await;
        }
        PinholeHandle::Upnp { control, unique_id } => {
            if let Err(error) = upnp::delete_pinhole(&control, unique_id).await {
                upnp::log_refusal("DeletePinhole", error);
            }
        }
    }
}

/// What one pinhole cycle produced.
pub enum PinholeCycle {
    Opened(std::sync::Arc<Pinhole>),
    Renewed(std::sync::Arc<Pinhole>),
    None(PinholeOutcome),
}

impl PinholeCycle {
    pub fn metric_key(&self) -> &'static str {
        match self {
            Self::Opened(pinhole) => pinhole.protocol.pinholed_key(),
            Self::Renewed(pinhole) => pinhole.protocol.renewed_key(),
            Self::None(outcome) => outcome.metric_key(),
        }
    }

    pub fn pinhole(&self) -> Option<std::sync::Arc<Pinhole>> {
        match self {
            Self::Opened(pinhole) | Self::Renewed(pinhole) => Some(std::sync::Arc::clone(pinhole)),
            Self::None(_) => None,
        }
    }
}

/// Every metric key this module can emit, for the closed-set contract with the
/// TypeScript reader. `metric_key` returns static strings drawn from exactly
/// this list; `fixture_tests` pins every emitter to it, and
/// `packages/shared/src/ipc-wire-conformance.test.ts` reads it out of this
/// source file to compare against `NAT_MAPPING_OUTCOMES` — so it exists as a
/// literal here even though only tests reference it.
#[cfg(test)]
pub const METRIC_KEYS: [&str; 18] = [
    "pcp:mapped",
    "pcp:renewed",
    "natpmp:mapped",
    "natpmp:renewed",
    "upnp:mapped",
    "upnp:renewed",
    "gateway:unsupported",
    "gateway:inner_nat",
    "skipped:no_gateway",
    "skipped:no_egress_path",
    "skipped:no_reflexive",
    "pcp6:pinholed",
    "pcp6:renewed",
    "upnp6:pinholed",
    "upnp6:renewed",
    "gateway6:unsupported",
    "skipped:no_v6_path",
    "skipped:no_v6_gateway",
];

#[cfg(test)]
#[path = "fixture_tests.rs"]
mod fixture_tests;

#[cfg(test)]
#[path = "natlab_tests.rs"]
mod natlab_tests;
