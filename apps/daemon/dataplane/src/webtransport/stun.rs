use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use super::discovery_socket::{DiscoveryResponse, DiscoverySocket, ResponseSource};
use ring::hmac;
use tokio::time::{Duration, Instant, timeout, timeout_at};
use tracing::{info, warn};
use wtransport::quinn::AsyncUdpSocket;

/// Credential and vantage points for a probe, delivered over the daemon's
/// authenticated control connection.
///
/// The daemon holds a minted ticket and the one key that ticket's messages are
/// signed under — never the deployment secret those are derived from. A ticket
/// is short-lived and replaced on every heartbeat, so a daemon that has lost
/// its control connection stops being able to probe, which is the intended
/// behaviour: it has also lost the ability to serve a session.
#[derive(Clone)]
pub struct StunCredential {
    /// `host:port` vantage points. At least two, or NAT behaviour is
    /// unknowable — see `infer_nat_behavior`.
    pub servers: Arc<Vec<String>>,
    /// Carried verbatim in the STUN USERNAME attribute.
    pub ticket: Arc<String>,
    /// Key for MESSAGE-INTEGRITY-SHA256 on both the request and the response.
    pub integrity_key: Arc<hmac::Key>,
    /// When this ticket stops being accepted, on the monotonic clock.
    ///
    /// Derived from the lifetime the control connection stated, stamped at
    /// arrival. A responder answers an expired ticket with silence, which on the
    /// reprobe path is indistinguishable from a network fault and so is read as
    /// "the NAT told us nothing" — the most expensive possible way to discover
    /// that the credential ran out. Checking here turns three wasted seconds of
    /// timeouts into an immediate, correctly attributed refusal.
    pub expires_at: Instant,
}

impl StunCredential {
    pub fn is_expired(&self, now: Instant) -> bool {
        now >= self.expires_at
    }
}

const STUN_TIMEOUT: Duration = Duration::from_secs(2);
/// Budget for one CHANGE-REQUEST exchange. The request rides a mapping the
/// same socket used a moment earlier, so this bounds a reply that is either in
/// flight or filtered, never one that has yet to open a path.
const FILTERING_TIMEOUT: Duration = Duration::from_millis(700);
/// CHANGE-PORT exchanges before silence becomes `PortDependent`. Two, because
/// one lost datagram must not classify a NAT; a second loss on a path that
/// answered the mapping probe milliseconds earlier is filtering.
const CHANGE_PORT_ATTEMPTS: usize = 2;
/// RFC 5780 section 7.2 CHANGE-REQUEST "change port" flag.
const CHANGE_PORT: u8 = 0x02;
/// RFC 5780 section 7.2 CHANGE-REQUEST "change IP" flag.
const CHANGE_IP: u8 = 0x04;
const STUN_MAGIC_COOKIE: u32 = 0x2112_A442;
const HAIRPIN_TIMEOUT: Duration = Duration::from_millis(500);

/// NAT mapping behavior detected via multi-server STUN probing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatMapping {
    /// Same external port for different destinations (cone NAT). Hole punch viable.
    EndpointIndependent,
    /// Different external port per destination (symmetric NAT). Hole punch won't work.
    EndpointDependent,
    /// Only one STUN server responded, cannot determine.
    Unknown,
}

impl NatMapping {
    pub fn as_str(self) -> &'static str {
        match self {
            NatMapping::EndpointIndependent => "endpoint_independent",
            NatMapping::EndpointDependent => "endpoint_dependent",
            NatMapping::Unknown => "unknown",
        }
    }
}

/// RFC 5780 filtering evidence for the live socket's mapping.
///
/// The two positive verdicts come from an authenticated reply arriving from an
/// endpoint the socket never addressed. `PortDependent` is the one negative
/// verdict, and it is reachable only when the same socket's mapping probe was
/// answered a moment earlier and `CHANGE_PORT_ATTEMPTS` changed-port requests
/// then drew nothing: the request provably reached the responder, so silence on
/// the changed port is filtering rather than loss. It never suppresses a
/// candidate — its sole consumer is the browser's birthday fan-out, which is
/// the one mechanism that reaches a port-dependent filter without a mapping.
/// A CHANGE-IP that the deployment cannot honour, an unavailable alternate, or
/// a source contacted earlier all remain `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatFiltering {
    EndpointIndependent,
    PortIndependent,
    PortDependent,
    Unknown,
}

impl NatFiltering {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EndpointIndependent => "endpoint_independent",
            Self::PortIndependent => "port_independent",
            Self::PortDependent => "port_dependent",
            Self::Unknown => "unknown",
        }
    }
}

/// Whether an unsolicited inbound datagram was observed reaching this host
/// over IPv6.
///
/// IPv6 has no NAT, so `NatMapping` and `PortAllocation` are meaningless there
/// and are deliberately not reused: the only thing standing between a browser
/// and a `host6` candidate is the CPE's stateful firewall. That is one
/// question, and it deserves its own answer rather than a borrowed vocabulary
/// that would invite someone to read a mapping verdict off a v6 probe.
///
/// # Deliberately two states, not three
///
/// There is no `Filtered`. The v4 probe does carry a negative verdict
/// (`NatFiltering::PortDependent`), but that verdict exists to *select* a
/// mechanism — the browser's birthday fan-out — and nothing selects on a v6
/// negative: the pinhole is attempted whenever a v6 gateway exists, and the
/// punch whenever a `host6` candidate is offered. A verdict with no consumer
/// would only tempt a suppression, and the 2026-08-17 reprobe entry records
/// what retracting undisproved evidence costs: the candidate race of every
/// attached browser torn down.
///
/// So this verdict never suppresses a candidate. Its job is to make the
/// question answerable: `host6` is the only candidate kind that has ever won a
/// direct upgrade in production, and it wins on roughly 7% of the attempts
/// where it is offered. Knowing whether the other 93% are filtered is what
/// says whether the pinhole is doing anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ipv6Reachability {
    /// A datagram from an address this socket never spoke to arrived, so the
    /// firewall passes unsolicited inbound and a `host6` candidate is dialable.
    Reachable,
    /// Not established. No credential, no v6 vantage point, no v6 address, a
    /// single-address responder that refused `change_ip`, or no answer.
    Unknown,
}

impl Ipv6Reachability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reachable => "reachable",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortAllocation {
    Preserved,
    Stable,
    Sequential,
    Randomized,
    Unknown,
}

impl PortAllocation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preserved => "preserved",
            Self::Stable => "stable",
            Self::Sequential => "sequential",
            Self::Randomized => "randomized",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct DiscoveryEvidence {
    pub nat_filtering: &'static str,
}
impl Default for DiscoveryEvidence {
    fn default() -> Self {
        Self {
            nat_filtering: "unknown",
        }
    }
}
impl From<&StunResult> for DiscoveryEvidence {
    fn from(result: &StunResult) -> Self {
        Self {
            nat_filtering: result.nat_filtering.as_str(),
        }
    }
}

pub struct StunResult {
    pub local_port: u16,
    pub public_addr: SocketAddr,
    pub nat_mapping: NatMapping,
    /// Observed allocation on this live socket only. Never extrapolated to
    /// another socket or treated as a promise about future mappings.
    pub port_allocation: PortAllocation,
    /// Result of the RFC 5780 port-change filtering test.
    pub nat_filtering: NatFiltering,
    pub hairpin: bool,
    /// The local source address the kernel routes toward the observer that
    /// answered first — a route lookup, not a packet. It is what the mapping
    /// layer resolves its egress interface from: the address that provably
    /// reached the internet, rather than whichever interface holds a default
    /// route on a split-tunnel or multi-homed host.
    pub local_ip: Option<IpAddr>,
}

#[derive(Debug, Clone, Copy)]
struct StunObservation {
    mapped: SocketAddr,
    /// The observer that produced this mapping. Reused as a provably-reachable
    /// public destination for the source-address route lookup.
    server: SocketAddr,
}

/// Each exchange installs a bounded, authenticated receive registration before
/// sending. Quinn remains the only reader; cancellation removes the slot.
async fn exchange(
    socket: &Arc<DiscoverySocket>,
    credential: &StunCredential,
    destination: SocketAddr,
    change_flags: u8,
    source: ResponseSource,
    budget: Duration,
) -> Option<DiscoveryResponse> {
    if credential.is_expired(Instant::now()) {
        return None;
    }
    let mut transaction = [0; 12];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut transaction).ok()?;
    let deadline = (Instant::now() + budget).min(credential.expires_at);
    let (_registration, response) = socket
        .register(
            transaction,
            source,
            credential.integrity_key.clone(),
            deadline,
        )
        .ok()?;
    let request = build_binding_request_with_change(&transaction, credential, change_flags)?;
    socket.record_discovery_contact(destination);
    timeout_at(deadline, socket.send(destination, request.as_bytes()))
        .await
        .ok()?
        .ok()?;
    let response = timeout_at(deadline, response).await.ok()?.ok()?;
    parse_stun_response(&response.bytes[..response.len], &transaction)?;
    Some(response)
}

/// Probe the actual, still-open WT socket.
///
/// Order is dictated by the contact ledger, not by the NAT. A filtering verdict
/// needs a reply from an endpoint this socket never addressed, and on a
/// two-address observer host both addresses are mapping observers — so the
/// CHANGE-IP exchange has to run after the *first* mapping observation and
/// before the second address is contacted, or address independence becomes
/// unprovable for the life of the socket. The conntrack collision that once
/// made this order dangerous (an unsolicited changed-port reply tracked as a
/// flow ahead of the daemon's own probe to that port) is closed on the
/// responder, whose CHANGE-PORT answers come from a change-only port nothing
/// ever probes — see `apps/stun`.
pub async fn probe(
    socket: &Arc<DiscoverySocket>,
    credential: &StunCredential,
) -> Result<StunResult, String> {
    if credential.is_expired(Instant::now()) {
        return Err("STUN credential expired".to_string());
    }
    let local_port = socket.local_addr().map_err(|e| e.to_string())?.port();
    let mut destinations = Vec::with_capacity(credential.servers.len().min(8));
    for server in credential.servers.iter().take(8) {
        if let Some(addr) = resolve_observer_for(server, true).await
            && !destinations.contains(&addr)
        {
            destinations.push(addr);
        }
    }
    let mut observations = Vec::with_capacity(destinations.len());
    let mut filtering = NatFiltering::Unknown;
    for destination in destinations {
        let Some(response) = exchange(
            socket,
            credential,
            destination,
            0,
            ResponseSource::Exact(destination),
            STUN_TIMEOUT,
        )
        .await
        else {
            continue;
        };
        let success = merkur_stun_protocol::message::parse_success(
            &response.bytes[..response.len],
            response.bytes[8..20]
                .try_into()
                .map_err(|_| "invalid transaction")?,
        )
        .ok_or("invalid mapping")?;
        let mapped = success.mapped.ok_or("invalid mapping")?;
        if observed_inside_nat_realm(mapped.ip()) {
            info!(observer = %destination, %mapped, "observer is inside this daemon's NAT realm; its observation is discarded");
            continue;
        }
        if observations.is_empty() {
            filtering = classify_filtering(socket, credential, destination, success.other).await;
        }
        observations.push(StunObservation {
            mapped,
            server: destination,
        });
    }
    let public_addr = observations
        .first()
        .ok_or("all STUN servers failed")?
        .mapped;
    let (nat_mapping, port_allocation) = infer_nat_behavior(local_port, &observations);
    let hairpin = test_hairpin_on_socket(socket, public_addr).await;
    let local_ip = route_source_for(observations[0].server);
    info!(local_port, public = %public_addr, observers = observations.len(),
        nat = nat_mapping.as_str(), allocation = port_allocation.as_str(),
        filtering = filtering.as_str(), hairpin, "live_socket_stun");
    Ok(StunResult {
        local_port,
        public_addr,
        nat_mapping,
        port_allocation,
        nat_filtering: filtering,
        hairpin,
        local_ip,
    })
}

/// Whether an observer that reported `mapped` saw this socket from inside its
/// own NAT realm: a private, shared-address (RFC 6598), loopback, link-local or
/// unique-local source. Such an observer — a box probing a responder on its own
/// host, a responder on the daemon's LAN — was reached without crossing the NAT
/// being measured, so its mapping says nothing about that NAT and comparing it
/// with a public observer's would read any NAT as endpoint-dependent.
///
/// Exact address classes only. `classify_ip` also rejects `.0` and `.255` hosts
/// as a guard for interface enumeration, and a public mapping can end in either.
fn observed_inside_nat_realm(mapped: IpAddr) -> bool {
    match mapped.to_canonical() {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || (octets[0] == 100 && (octets[1] & 0xc0) == 0x40)
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The source address the kernel would use toward `destination`: a connected
/// UDP socket performs the route lookup and sends nothing.
fn route_source_for(destination: SocketAddr) -> Option<IpAddr> {
    let bind: SocketAddr = if destination.is_ipv4() {
        (std::net::Ipv4Addr::UNSPECIFIED, 0).into()
    } else {
        (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
    };
    let socket = std::net::UdpSocket::bind(bind).ok()?;
    socket.connect(destination).ok()?;
    let local = socket.local_addr().ok()?.ip();
    (!local.is_unspecified()).then_some(local)
}

/// RFC 5780 §4.4 filtering tests against the observer that just answered the
/// mapping probe, so every request here rides a translation the NAT provably
/// holds.
///
/// A different IP AND port is the strongest test, and it is attempted only when
/// the observer advertised OTHER-ADDRESS: the responder emits that attribute
/// exactly when it can honour the combined change, so its absence saves a
/// `FILTERING_TIMEOUT` that a single-address deployment could never answer.
/// A same-IP changed port proves only port independence. Silence across
/// `CHANGE_PORT_ATTEMPTS` is the negative verdict — see `NatFiltering`.
async fn classify_filtering(
    socket: &Arc<DiscoverySocket>,
    credential: &StunCredential,
    observer: SocketAddr,
    other_address: Option<SocketAddr>,
) -> NatFiltering {
    if other_address.is_some_and(|other| !socket.contacted_discovery_ip(other.ip())) {
        let alternate = exchange(
            socket,
            credential,
            observer,
            CHANGE_IP | CHANGE_PORT,
            ResponseSource::ChangedAddress(observer),
            FILTERING_TIMEOUT,
        )
        .await;
        if alternate
            .as_ref()
            .is_some_and(|r| !socket.contacted_discovery_ip(r.source.ip()))
        {
            return NatFiltering::EndpointIndependent;
        }
    }
    for _ in 0..CHANGE_PORT_ATTEMPTS {
        let alternate = exchange(
            socket,
            credential,
            observer,
            CHANGE_PORT,
            ResponseSource::ChangedPort(observer),
            FILTERING_TIMEOUT,
        )
        .await;
        match alternate {
            Some(r) if !socket.contacted_discovery_endpoint(r.source) => {
                return NatFiltering::PortIndependent;
            }
            // A reply from an endpoint this socket already addressed says
            // nothing about filtering, and a responder that answers from its
            // own observer port is misconfigured rather than filtered.
            Some(_) => return NatFiltering::Unknown,
            None => {}
        }
    }
    if credential.is_expired(Instant::now()) {
        // The last request may have been refused rather than filtered.
        return NatFiltering::Unknown;
    }
    NatFiltering::PortDependent
}

/// The same live dual-stack listener, with a different-address response. This
/// proves arrival at the socket, not general reachability from every browser.
pub async fn probe_ipv6_reachability(
    socket: &Arc<DiscoverySocket>,
    credential: &StunCredential,
) -> Ipv6Reachability {
    if credential.is_expired(Instant::now()) {
        return Ipv6Reachability::Unknown;
    }
    for server in credential.servers.iter().take(8) {
        let Some(destination) = resolve_observer_for(server, false).await else {
            continue;
        };
        if let Some(response) = exchange(
            socket,
            credential,
            destination,
            CHANGE_IP | CHANGE_PORT,
            ResponseSource::ChangedAddress(destination),
            FILTERING_TIMEOUT,
        )
        .await
            && !socket.contacted_discovery_ip(response.source.ip())
        {
            return Ipv6Reachability::Reachable;
        }
    }
    Ipv6Reachability::Unknown
}

/// Resolve a vantage point, keeping only addresses of the requested family.
///
/// The v4 NAT and v6 reachability probes share the listener but ask different
/// questions, so each must select its own family. Before this took a
/// family, every vantage point was resolved with `SocketAddr::is_ipv4` and a v6
/// entry in `STUN_SERVERS` was silently discarded — the configuration parsed,
/// the probe ran, and the address was never spoken to.
pub(crate) async fn resolve_observer_for(server: &str, want_ipv4: bool) -> Option<SocketAddr> {
    match timeout(STUN_TIMEOUT, tokio::net::lookup_host(server)).await {
        Ok(Ok(mut addresses)) => addresses.find(|address| address.is_ipv4() == want_ipv4),
        Ok(Err(error)) => {
            warn!("STUN DNS resolution failed for {server}: {error}");
            None
        }
        Err(_) => {
            warn!("STUN DNS resolution timed out for {server}");
            None
        }
    }
}

fn build_binding_request_with_change(
    transaction: &[u8; 12],
    credential: &StunCredential,
    change: u8,
) -> Option<merkur_stun_protocol::message::ResponseWriter> {
    merkur_stun_protocol::message::binding_request(
        transaction,
        credential.ticket.as_bytes(),
        change,
        &credential.integrity_key,
    )
}

fn infer_nat_behavior(
    local_port: u16,
    observations: &[StunObservation],
) -> (NatMapping, PortAllocation) {
    if observations.len() < 2 {
        return (NatMapping::Unknown, PortAllocation::Unknown);
    }
    let first = observations[0].mapped;
    let mapping = if observations
        .iter()
        .all(|observation| observation.mapped == first)
    {
        if observations
            .iter()
            .any(|observation| observation.server.ip() != observations[0].server.ip())
        {
            NatMapping::EndpointIndependent
        } else {
            NatMapping::Unknown
        }
    } else {
        NatMapping::EndpointDependent
    };
    let ports: Vec<i32> = observations
        .iter()
        .map(|observation| i32::from(observation.mapped.port()))
        .collect();
    let allocation = if ports.iter().all(|port| *port == i32::from(local_port)) {
        PortAllocation::Preserved
    } else if ports.iter().all(|port| *port == ports[0]) {
        PortAllocation::Stable
    } else if ports.len() >= 3 {
        let deltas: Vec<i32> = ports.windows(2).map(|pair| pair[1] - pair[0]).collect();
        let direction = deltas[0].signum();
        if direction != 0
            && deltas
                .iter()
                .all(|delta| delta.signum() == direction && delta.unsigned_abs() <= 16)
        {
            PortAllocation::Sequential
        } else {
            PortAllocation::Randomized
        }
    } else {
        PortAllocation::Unknown
    };
    (mapping, allocation)
}

/// A one-use, locally generated authenticated success packet is reflected
/// through our own NAT. No network request handler or second reader is needed.
async fn test_hairpin_on_socket(socket: &Arc<DiscoverySocket>, reflexive_addr: SocketAddr) -> bool {
    let mut random = [0; 44];
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random).is_err() {
        return false;
    }
    let transaction: [u8; 12] = random[..12].try_into().expect("fixed transaction");
    let key = Arc::new(hmac::Key::new(hmac::HMAC_SHA256, &random[12..]));
    let deadline = Instant::now() + HAIRPIN_TIMEOUT;
    let Ok((_registration, response)) = socket.register(
        transaction,
        ResponseSource::AuthenticatedSelf,
        key.clone(),
        deadline,
    ) else {
        return false;
    };
    let mut packet = Vec::with_capacity(56);
    packet.extend_from_slice(&[1, 1, 0, 36]);
    packet.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    packet.extend_from_slice(&transaction);
    let tag = hmac::sign(&key, &packet);
    packet.extend_from_slice(&[0, 0x1c, 0, 32]);
    packet.extend_from_slice(tag.as_ref());
    matches!(
        timeout_at(deadline, async {
            socket.send(reflexive_addr, &packet).await.ok()?;
            response.await.ok()
        })
        .await,
        Ok(Some(_))
    )
}

fn parse_stun_response(data: &[u8], expected_txn_id: &[u8; 12]) -> Option<SocketAddr> {
    merkur_stun_protocol::message::parse_success(data, expected_txn_id)?.mapped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(_order: usize, addr: &str) -> StunObservation {
        StunObservation {
            mapped: addr.parse().unwrap(),
            server: "198.51.100.1:3478".parse().unwrap(),
        }
    }

    #[test]
    fn one_observer_address_does_not_prove_address_independent_mapping() {
        let observations = [
            observation(0, "203.0.113.4:45000"),
            observation(1, "203.0.113.4:45000"),
            observation(2, "203.0.113.4:45000"),
        ];
        assert_eq!(
            infer_nat_behavior(40000, &observations),
            (NatMapping::Unknown, PortAllocation::Stable)
        );
    }

    #[test]
    fn infers_sequential_destination_dependent_mapping() {
        let observations = [
            observation(0, "203.0.113.4:45000"),
            observation(1, "203.0.113.4:45002"),
            observation(2, "203.0.113.4:45004"),
        ];
        assert_eq!(
            infer_nat_behavior(40000, &observations),
            (NatMapping::EndpointDependent, PortAllocation::Sequential)
        );
    }

    fn credential(expires_at: Instant) -> StunCredential {
        StunCredential {
            servers: Arc::new(vec!["198.51.100.1:3478".to_string()]),
            ticket: Arc::new("ticket".to_string()),
            integrity_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, b"key")),
            expires_at,
        }
    }

    /// An expired credential must fail before a socket is opened. The responder
    /// answers it with silence, so letting the probe run would spend the full
    /// STUN, filtering, and hairpin budget to learn nothing, and would report
    /// the result as an unclassifiable NAT rather than as a spent ticket.
    #[tokio::test]
    async fn an_expired_credential_is_refused_without_touching_the_network() {
        let expired = credential(Instant::now() - Duration::from_secs(1));
        assert!(expired.is_expired(Instant::now()));

        let started = std::time::Instant::now();
        let outcome = probe(&test_socket().1, &expired).await;
        assert!(matches!(
            outcome.as_ref().err().map(String::as_str),
            Some("STUN credential expired")
        ));
        assert!(
            started.elapsed() < STUN_TIMEOUT,
            "the refusal must be immediate, not a timeout"
        );
    }

    #[test]
    fn a_credential_is_live_right_up_to_its_deadline() {
        let deadline = Instant::now() + Duration::from_secs(30);
        let credential = credential(deadline);
        assert!(!credential.is_expired(deadline - Duration::from_millis(1)));
        assert!(credential.is_expired(deadline));
    }

    #[test]
    fn an_observer_that_saw_a_private_source_is_inside_the_realm() {
        for inside in [
            "10.224.25.222",
            "192.168.1.10",
            "172.16.0.9",
            "100.64.0.5",
            "127.0.0.1",
            "169.254.1.1",
            "fd00::1",
            "fe80::1",
            "::1",
            "::ffff:10.0.0.2",
        ] {
            assert!(
                observed_inside_nat_realm(inside.parse().unwrap()),
                "{inside}"
            );
        }
        // Public addresses stay observations, including ones a /24 guess
        // would take for a network or broadcast address.
        for outside in ["109.167.7.0", "203.0.113.255", "2.28.25.125", "2a01:4f8::5"] {
            assert!(
                !observed_inside_nat_realm(outside.parse().unwrap()),
                "{outside}"
            );
        }
    }

    #[test]
    fn one_observer_cannot_classify_mapping_or_allocation() {
        let observations = [observation(0, "203.0.113.4:45000")];
        assert_eq!(
            infer_nat_behavior(40000, &observations),
            (NatMapping::Unknown, PortAllocation::Unknown)
        );
    }
}

#[cfg(test)]
mod live_stun_tests {
    use super::*;

    /// End-to-end against the real deployed responder.
    ///
    /// Ignored by default because it needs the network and a live credential.
    /// It exists because everything else about this client is checked against
    /// our own encoder: only this proves the bytes this daemon emits are the
    /// bytes `apps/stun` accepts, and that the response it returns survives
    /// verification here.
    ///
    /// Run with:
    /// `MERKUR_STUN_TEST_SERVERS=host:3478,host:3479 \
    ///  MERKUR_STUN_TEST_TICKET=... MERKUR_STUN_TEST_SECRET=... \
    ///  cargo test -p merkur-dataplane live_stun -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "requires the deployed STUN responder and a live ticket"]
    async fn a_live_probe_authenticates_and_classifies() {
        use base64::Engine as _;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;

        let servers: Vec<String> = std::env::var("MERKUR_STUN_TEST_SERVERS")
            .expect("MERKUR_STUN_TEST_SERVERS")
            .split(',')
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        let ticket = std::env::var("MERKUR_STUN_TEST_TICKET").expect("MERKUR_STUN_TEST_TICKET");
        let secret = URL_SAFE_NO_PAD
            .decode(std::env::var("MERKUR_STUN_TEST_SECRET").expect("MERKUR_STUN_TEST_SECRET"))
            .expect("secret is base64url");

        let credential = StunCredential {
            servers: std::sync::Arc::new(servers),
            ticket: std::sync::Arc::new(ticket),
            integrity_key: std::sync::Arc::new(hmac::Key::new(hmac::HMAC_SHA256, &secret)),
            // The operator supplies a freshly minted ticket on the command line,
            // so the only thing this bound has to do is not expire mid-run.
            expires_at: Instant::now() + Duration::from_secs(300),
        };

        let result = probe(&test_socket().1, &credential)
            .await
            .expect("probe must succeed");
        println!(
            "public={} nat={} allocation={} hairpin={}",
            result.public_addr,
            result.nat_mapping.as_str(),
            result.port_allocation.as_str(),
            result.hairpin
        );

        // A single observation yields `Unknown`, which is precisely the state
        // that makes the reprobe drop its reflexive candidate. Reaching a real
        // classification is the point of the deployment having several vantage
        // points.
        assert_ne!(
            result.nat_mapping,
            NatMapping::Unknown,
            "fewer than two vantage points answered; NAT behaviour stayed unknowable"
        );
        assert_ne!(result.port_allocation, PortAllocation::Unknown);
        // Filtering is allowed to be Unknown — a NAT that filters answers by
        // saying nothing, and so does a lost packet. What must never happen is
        // a verdict reached from an unauthenticated or same-port reply.
        println!("filtering={}", result.nat_filtering.as_str());
    }
}

#[cfg(test)]
mod ipv6_reachability_tests {
    use super::*;

    #[test]
    fn the_verdict_has_no_negative_state_by_construction() {
        // If a `Filtered` variant is ever added, this fails to compile and the
        // author has to read why it is absent: no mechanism selects on a v6
        // negative — the pinhole and the punch both run regardless — so a v6
        // negative could only ever become a suppression.
        match Ipv6Reachability::Unknown {
            Ipv6Reachability::Reachable | Ipv6Reachability::Unknown => {}
        }
        assert_eq!(Ipv6Reachability::Reachable.as_str(), "reachable");
        assert_eq!(Ipv6Reachability::Unknown.as_str(), "unknown");
    }

    #[tokio::test]
    async fn an_expired_credential_is_refused_without_touching_the_network() {
        let credential = StunCredential {
            servers: Arc::new(vec!["[2001:db8::1]:34780".to_string()]),
            ticket: Arc::new("t".to_string()),
            integrity_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, &[0u8; 32])),
            expires_at: Instant::now() - Duration::from_secs(1),
        };
        assert_eq!(
            probe_ipv6_reachability(&test_socket().1, &credential).await,
            Ipv6Reachability::Unknown
        );
    }

    #[tokio::test]
    async fn a_v4_only_vantage_list_yields_unknown_rather_than_probing_v4() {
        // The whole defect this replaced was a v6 vantage point being silently
        // dropped by an `is_ipv4` filter. The mirror image must not happen: a
        // v4-only list must produce no v6 probe at all, not a v4 one.
        let credential = StunCredential {
            servers: Arc::new(vec!["203.0.113.1:3478".to_string()]),
            ticket: Arc::new("t".to_string()),
            integrity_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, &[0u8; 32])),
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        assert_eq!(
            probe_ipv6_reachability(&test_socket().1, &credential).await,
            Ipv6Reachability::Unknown
        );
    }

    #[tokio::test]
    async fn resolution_selects_by_family_in_both_directions() {
        assert!(
            resolve_observer_for("203.0.113.1:3478", true)
                .await
                .is_some()
        );
        assert!(
            resolve_observer_for("203.0.113.1:3478", false)
                .await
                .is_none()
        );
        assert!(
            resolve_observer_for("[2001:db8::1]:34780", false)
                .await
                .is_some()
        );
        assert!(
            resolve_observer_for("[2001:db8::1]:34780", true)
                .await
                .is_none(),
            "a v6 vantage point must never be handed to the v4 probe"
        );
    }
}

#[cfg(test)]
fn test_socket() -> (
    wtransport::Endpoint<wtransport::endpoint::endpoint_side::Server>,
    Arc<DiscoverySocket>,
) {
    let (config, _, _, socket) = super::build_server_config_owning_socket(0).unwrap();
    let endpoint = wtransport::Endpoint::server_with_socket(config, socket.clone()).unwrap();
    (endpoint, socket)
}

#[cfg(test)]
mod natlab {
    use super::*;

    /// Run by scripts/natlab/discovery.sh in a routed Linux namespace. Uses the
    /// actual observer binary, daemon accept loop, TLS pin, and STUN socket.
    #[tokio::test]
    #[ignore = "requires the isolated routed discovery NAT lab"]
    async fn natlab_live_discovery() {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let mode = std::env::var("MERKUR_NATLAB_CASE").unwrap();
        let secret = URL_SAFE_NO_PAD
            .decode(std::env::var("MERKUR_STUN_TEST_SECRET").unwrap())
            .unwrap();
        let credential = StunCredential {
            servers: Arc::new(vec![
                "198.51.100.10:3478".into(),
                "198.51.100.11:3478".into(),
            ]),
            ticket: Arc::new(std::env::var("MERKUR_STUN_TEST_TICKET").unwrap()),
            integrity_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, &secret)),
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        let (endpoint, cert, info) = crate::webtransport::start_server(44300, None).unwrap();
        let endpoint = Arc::new(endpoint);
        let state = Arc::new(tokio::sync::RwLock::new(
            crate::webtransport::WebTransportState::from_server_info(cert, &info),
        ));
        let socket = state.read().await.discovery_socket.clone().unwrap();
        let (messages, mut message_rx) = tokio::sync::mpsc::channel(16);
        let (events, mut event_rx) = tokio::sync::mpsc::channel(16);
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let owner = tokio::spawn(crate::webtransport::accept_loop(
            endpoint,
            state.clone(),
            messages,
            events,
            shutdown_rx,
        ));
        let result = probe(&socket, &credential).await.unwrap();
        assert_eq!(result.local_port, 44300);
        let expected_public = if mode == "masquerade" {
            "198.51.100.1:44300"
        } else {
            "198.51.100.1:50000"
        };
        assert_eq!(result.public_addr, expected_public.parse().unwrap());
        assert_eq!(result.nat_mapping, NatMapping::EndpointIndependent);
        // Static SNAT rewrites the port; masquerade preserves it. Both are one
        // mapping seen from two addresses, which is what makes the verdict
        // above reachable at all.
        let expected_allocation = if mode == "masquerade" {
            PortAllocation::Preserved
        } else {
            PortAllocation::Stable
        };
        assert_eq!(result.port_allocation, expected_allocation);
        match mode.as_str() {
            "open" => {
                assert_eq!(result.nat_filtering, NatFiltering::EndpointIndependent);
                std::fs::write("/tmp/merkur-discovery-rebind-ready", b"ready").unwrap();
                timeout(Duration::from_secs(10), async {
                    while !std::path::Path::new("/tmp/merkur-discovery-rebound").exists() {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await
                .unwrap();
                let rebound = probe(&socket, &credential).await.unwrap();
                assert_eq!(rebound.local_port, 44300, "the listener never rebinds");
                assert_eq!(rebound.public_addr, "198.51.100.1:50001".parse().unwrap());
                assert_ne!(
                    rebound.nat_filtering,
                    NatFiltering::EndpointIndependent,
                    "an observer contacted in the first round cannot prove fresh address independence"
                );
            }
            "loss" => {
                // Every changed-source reply is lost while the mapping probe
                // was answered from the same path. By construction that is the
                // negative verdict: it withholds the punch and never the
                // candidate.
                assert_eq!(result.nat_filtering, NatFiltering::PortDependent);
            }
            "address" => {
                assert_eq!(result.nat_filtering, NatFiltering::PortIndependent);
            }
            "port" => {
                assert_eq!(result.nat_filtering, NatFiltering::PortDependent);
            }
            "masquerade" => {
                // Plain conntrack masquerade preserves the source port and
                // filters by 5-tuple. Before change-only responder ports, the
                // unsolicited changed-port reply was tracked as a flow ahead of
                // the daemon's own probe to that port, which then collided and
                // was translated to a fresh port — reading as symmetric.
                assert_eq!(result.nat_filtering, NatFiltering::PortDependent);
                assert!(!result.hairpin);
            }
            _ => panic!("unexpected lab case"),
        }
        let mapped = result.public_addr;
        let published = crate::webtransport::build_reprobe_result(
            None,
            Vec::new(),
            Ok(result),
            crate::webtransport::PriorReflexive::default(),
            None,
        );
        assert!(
            published.candidates.iter().any(|candidate| {
                candidate.kind == crate::webtransport::CandidateFlavor::Srflx
                    && candidate.addr == mapped.ip().to_string()
                    && candidate.port == mapped.port()
            }),
            "inconclusive filtering never suppresses the observed mapping"
        );
        assert!(message_rx.try_recv().is_err());
        assert!(event_rx.try_recv().is_err());
        assert!(state.read().await.peer_connections.is_empty());
        shutdown.send(()).unwrap();
        assert!(owner.await.unwrap().is_empty());
    }
}
