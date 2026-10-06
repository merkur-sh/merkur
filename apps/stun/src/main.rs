//! merkur-stun — authenticated STUN Binding responder.
//!
//! Replaces the public STUN servers the daemon used to probe. It answers one
//! question — "what source address did this datagram arrive from" — and answers
//! it only for a caller holding a ticket minted by the application server.
//!
//! # Shape
//!
//! Binding has one blocking receive owner per socket and fixed packet buffers.
//! It holds no per-source state, and no terminal authorization or content
//! reaches this service.
//!
//! Multiple ports reveal port-dependent mapping. Equal mappings prove address
//! independence only when distinct IP addresses were actually observed. The
//! existing single-IP Fly deployment cannot perform the different-IP tests.
//!
//! # Refusals are silent
//!
//! Every rejection path drops the datagram. A STUN error response would make
//! this an amplifier: an attacker spoofing a victim's source address gets us to
//! send the victim a packet. For the same reason a success response is never
//! larger than the request that earned it, which the wire tests assert.

use merkur_stun_protocol::message;
mod ticket;

#[cfg(all(test, target_os = "macos"))]
mod packet_profile;

use std::env;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tracing::{error, info, warn};

use crate::message::{
    ATTR_OTHER_ADDRESS, ATTR_XOR_MAPPED_ADDRESS, MAX_MESSAGE_LEN, ResponseWriter,
    parse_binding_request,
};
use crate::ticket::TicketKey;

/// Raw length of the deployment secret, matching `EDGE_REGISTRATION_KEY_BYTES`
/// on the server so both secrets are generated and rotated the same way.
const TICKET_KEY_BYTES: usize = 64;

const DEFAULT_PORTS: &str = "3478,3479,3480";

/// Binding counters. The responder keeps no per-source state.
#[derive(Default)]
struct Counters {
    served: AtomicU64,
    dropped_unparsed: AtomicU64,
    dropped_bad_ticket: AtomicU64,
    dropped_bad_integrity: AtomicU64,
    /// A CHANGE-REQUEST this deployment cannot honour — `change_ip` always, and
    /// `change_port` when only one port is configured.
    dropped_unsupported_change: AtomicU64,
}

struct Config {
    /// Ports a daemon addresses directly: the mapping observers named in the
    /// server's `STUN_SERVERS`.
    ports: Vec<u16>,
    /// Ports that only ever *answer*, never receive a mapping probe.
    ///
    /// A CHANGE-PORT reply must come from a port the daemon has never sent to,
    /// or its contact ledger discounts it. Answering from another mapping
    /// observer therefore proved nothing, and it did worse than nothing on a
    /// conntrack NAT: the unsolicited reply from port B was tracked as a flow
    /// before the daemon's own mapping probe to port B, so that later probe
    /// collided with it and was translated to a fresh external port — an
    /// endpoint-independent NAT read as endpoint-dependent, and every srflx
    /// candidate was withheld. A port nothing dials cannot collide with
    /// anything. Bound and served like the others, so a misconfigured
    /// `STUN_SERVERS` that names one still gets an answer.
    change_ports: Vec<u16>,
    /// Explicit bind addresses, or empty for the platform default.
    ///
    /// The Fly deployment leaves this empty and binds one anycast IPv4, where
    /// `change_ip` is unanswerable — a second *region* is not a second address.
    /// The Hetzner box host sets it to two addresses from its routed /64, which
    /// is what makes the address-change half of RFC 5780 answerable at all, and
    /// costs nothing because a /64 is one allocation.
    bind_addresses: Vec<std::net::IpAddr>,
    ticket_key: TicketKey,
}

fn parse_bind_addresses(raw: &str) -> Result<Vec<std::net::IpAddr>, String> {
    let mut addresses = Vec::new();
    for field in raw.split(',') {
        let field = field.trim();
        if field.is_empty() {
            continue;
        }
        let address: std::net::IpAddr = field
            .parse()
            .map_err(|_| format!("invalid address in MERKUR_STUN_BIND: {field}"))?;
        if addresses.contains(&address) {
            return Err(format!("duplicate address {address}"));
        }
        addresses.push(address);
    }
    Ok(addresses)
}

fn parse_ports(raw: &str, variable: &str) -> Result<Vec<u16>, String> {
    let mut ports = Vec::new();
    for field in raw.split(',') {
        let field = field.trim();
        if field.is_empty() {
            continue;
        }
        let port: u16 = field
            .parse()
            .map_err(|_| format!("invalid port in {variable}: {field}"))?;
        if port < 1024 {
            return Err(format!("refusing privileged port {port}"));
        }
        if ports.contains(&port) {
            return Err(format!("duplicate port {port}"));
        }
        ports.push(port);
    }
    Ok(ports)
}

fn config_from_env() -> Result<Config, String> {
    let encoded = env::var("MERKUR_STUN_TICKET_KEY")
        .map_err(|_| "MERKUR_STUN_TICKET_KEY is required".to_string())?;
    let secret = URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| "MERKUR_STUN_TICKET_KEY must be canonical base64url".to_string())?;
    if secret.len() != TICKET_KEY_BYTES {
        return Err(format!(
            "MERKUR_STUN_TICKET_KEY must decode to exactly {TICKET_KEY_BYTES} bytes, got {}",
            secret.len()
        ));
    }

    let ports = parse_ports(
        &env::var("MERKUR_STUN_PORTS").unwrap_or_else(|_| DEFAULT_PORTS.to_string()),
        "MERKUR_STUN_PORTS",
    )?;
    if ports.is_empty() {
        return Err("MERKUR_STUN_PORTS resolved to no ports".to_string());
    }
    let change_ports = parse_ports(
        &env::var("MERKUR_STUN_CHANGE_PORTS").unwrap_or_default(),
        "MERKUR_STUN_CHANGE_PORTS",
    )?;
    // A port in both sets is a mapping observer that also answers CHANGE-PORT,
    // which is exactly the collision `change_ports` exists to rule out.
    if let Some(port) = change_ports.iter().find(|port| ports.contains(port)) {
        return Err(format!(
            "port {port} is in both MERKUR_STUN_PORTS and MERKUR_STUN_CHANGE_PORTS; a change-only port must never be a mapping observer"
        ));
    }

    let bind_addresses = parse_bind_addresses(&env::var("MERKUR_STUN_BIND").unwrap_or_default())?;

    Ok(Config {
        ports,
        change_ports,
        bind_addresses,
        ticket_key: TicketKey::new(&secret),
    })
}

/// Resolve the IPv4 bind address for `port`.
///
/// On Fly, UDP services must bind the address `fly-global-services` resolves to
/// inside the VM; a wildcard bind receives nothing. Off Fly, bind the IPv4
/// wildcard. This mirrors `apps/edge/src/main.rs`, because the constraint is
/// the platform's, not the application's.
fn resolve_v4_bind_addr(port: u16) -> SocketAddr {
    if env::var_os("FLY_APP_NAME").is_some() {
        match ("fly-global-services", port).to_socket_addrs() {
            Ok(mut addrs) => {
                if let Some(addr) = addrs.next() {
                    return addr;
                }
                warn!(
                    port,
                    "fly-global-services resolved to no addresses; using wildcard"
                );
            }
            Err(e) => warn!(
                port,
                "failed to resolve fly-global-services ({e}); using wildcard"
            ),
        }
    }
    SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, port))
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Sockets this process can answer from, keyed by the port they are bound to.
///
/// RFC 5780 filtering discovery works by answering from an address the client
/// has not spoken to. We hold several ports of one address, so the port-change
/// half of that test is answerable locally — see `serve` for what it does and
/// does not prove.
///
/// Keyed by the full local address, not by port, because two deployments need
/// different halves of RFC 5780 and only the full address distinguishes them.
///
/// Fly binds one anycast IPv4 on several ports: `change_port` is answerable,
/// `change_ip` is not, and a second region would not help because the address
/// belongs to the app rather than the machine. The Hetzner box host binds
/// several addresses out of its routed IPv6 /64, where both halves are
/// answerable — which matters because IPv6 has no NAT, so filtering is the
/// entire question a `host6` candidate turns on.
type Responders = std::collections::HashMap<SocketAddr, Arc<UdpSocket>>;

/// A socket on the same address as `arrived_on`, bound to a different port.
///
/// A change-only port is preferred over another mapping observer: the daemon's
/// contact ledger discounts a reply from any endpoint it has probed, and on a
/// conntrack NAT the unsolicited reply also poisons the later probe to that
/// same endpoint (see `Config::change_ports`). Another observer's port is still
/// used when no change-only port is bound, because a same-IP port change is
/// what the port-independence half of RFC 5780 needs and refusing it would
/// leave a two-port deployment unable to answer at all.
fn alternate_port_addr(
    local: &[SocketAddr],
    change_ports: &[u16],
    arrived_on: SocketAddr,
) -> Option<SocketAddr> {
    let same_ip_other_port = |candidate: &SocketAddr| {
        candidate.ip() == arrived_on.ip() && candidate.port() != arrived_on.port()
    };
    local
        .iter()
        .copied()
        .find(|candidate| same_ip_other_port(candidate) && change_ports.contains(&candidate.port()))
        .or_else(|| local.iter().copied().find(same_ip_other_port))
}

/// A socket on a different address from `arrived_on`.
///
/// `also_change_port` is RFC 5780's combined form: the response must come from
/// an address AND a port the client has never spoken to. When both are asked
/// for and only an address change is available, this returns `None` rather than
/// a partial answer — reporting a pass for a property that was not tested is
/// the failure mode this whole module is written to avoid. A change-only port
/// on the other address is preferred for the reason `alternate_port_addr` gives.
fn alternate_address_addr(
    local: &[SocketAddr],
    change_ports: &[u16],
    arrived_on: SocketAddr,
    also_change_port: bool,
) -> Option<SocketAddr> {
    let other_ip = |candidate: &SocketAddr| {
        candidate.is_ipv4() == arrived_on.is_ipv4()
            && candidate.ip() != arrived_on.ip()
            && (!also_change_port || candidate.port() != arrived_on.port())
    };
    local
        .iter()
        .copied()
        .find(|candidate| other_ip(candidate) && change_ports.contains(&candidate.port()))
        .or_else(|| local.iter().copied().find(other_ip))
}

/// Serve one socket forever.
///
/// `local_addr` is only for logging. It is deliberately not echoed back in a
/// RESPONSE-ORIGIN attribute: the client already sees the responding address as
/// the datagram's source, and the extra 24 bytes would make a success response
/// larger than the request that earned it.
fn serve(
    socket: Arc<UdpSocket>,
    local_addr: SocketAddr,
    config: Arc<Config>,
    counters: Arc<Counters>,
    responders: Arc<Responders>,
) -> ! {
    // The bound set is fixed for the process's life — every socket is bound
    // before any thread serves — so every alternate address and the socket it
    // answers from are resolved once here, before the loop.
    let mut local_addrs: Vec<SocketAddr> = responders.keys().copied().collect();
    local_addrs.sort_unstable();
    let change_ports: &[u16] = &config.change_ports;
    // RFC 5780 §7.2 OTHER-ADDRESS: the address and port a CHANGE-IP+PORT
    // answer would come from. Derived from the bound set rather than configured,
    // so a dual-family deployment advertises a v4 alternate to a v4 client and a
    // v6 alternate to a v6 client, and a single-address deployment advertises
    // nothing rather than a value it cannot honour.
    let other_address = alternate_address_addr(&local_addrs, change_ports, local_addr, true);
    let address_change = alternate_address_addr(&local_addrs, change_ports, local_addr, false);
    let bound = |alternate: Option<SocketAddr>| alternate.and_then(|addr| responders.get(&addr));
    let change_ip_socket = bound(address_change);
    let change_ip_port_socket = bound(other_address);
    let change_port_socket = bound(alternate_port_addr(&local_addrs, change_ports, local_addr));
    let mut receive = [0u8; MAX_MESSAGE_LEN + 1];
    // Decoded ticket bytes. Fixed size so a long USERNAME cannot allocate.
    let mut ticket_bytes = [0u8; ticket::TICKET_LEN];

    loop {
        let (len, peer) = match socket.recv_from(&mut receive) {
            Ok(value) => value,
            Err(error) => {
                // A transient error must not spin the thread at full tilt.
                warn!(%local_addr, "recv_from failed: {error}");
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
        };
        let datagram = &receive[..len];

        let request = match parse_binding_request(datagram) {
            Ok(request) => request,
            Err(_) => {
                counters.dropped_unparsed.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };

        // USERNAME carries the base64url ticket. Decode into a fixed buffer:
        // anything that is not exactly a ticket cannot be one.
        let decoded_len = match URL_SAFE_NO_PAD.decode_slice(request.username, &mut ticket_bytes) {
            Ok(value) => value,
            Err(_) => {
                counters.dropped_bad_ticket.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };
        let integrity_key = match config
            .ticket_key
            .verify(&ticket_bytes[..decoded_len], now_unix_secs())
        {
            Ok(key) => key,
            Err(_) => {
                counters.dropped_bad_ticket.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };

        if !request.verify_integrity(datagram, &integrity_key) {
            counters
                .dropped_bad_integrity
                .fetch_add(1, Ordering::Relaxed);
            continue;
        }

        // RFC 5780 section 7.2. A client asking us to change port is testing
        // whether its NAT will accept an inbound packet from a port it has never
        // sent to — which is exactly what a browser dialling a reflexive
        // candidate from an arbitrary port needs. Asking us to change address
        // tests the same property one level up, and is the only question that
        // matters over IPv6, where there is no NAT and a `host6` candidate turns
        // entirely on whether the CPE firewall passes an unsolicited datagram.
        //
        // Either form is REFUSED rather than downgraded when this deployment
        // cannot honour it. Answering a `change_ip` from the same address would
        // report a pass for a property that was never tested, and the client
        // would then publish a candidate nothing can reach.
        let alternate = match request.change_request {
            Some(change) if change.change_ip && change.change_port => change_ip_port_socket,
            Some(change) if change.change_ip => change_ip_socket,
            Some(change) if change.change_port => change_port_socket,
            _ => Some(&socket),
        };
        let Some(respond_from) = alternate else {
            counters
                .dropped_unsupported_change
                .fetch_add(1, Ordering::Relaxed);
            continue;
        };

        let mut writer = ResponseWriter::new(request.transaction_id);
        if !writer.push_address(ATTR_XOR_MAPPED_ADDRESS, peer, request.transaction_id, true) {
            continue;
        }
        if let Some(other) = other_address
            && !writer.push_address(ATTR_OTHER_ADDRESS, other, request.transaction_id, false)
        {
            continue;
        }
        if !writer.finish_in_place(&integrity_key) {
            continue;
        }

        if writer.as_bytes().len() > len {
            continue;
        }
        if let Err(error) = respond_from.send_to(writer.as_bytes(), peer) {
            warn!(%local_addr, "send_to failed: {error}");
            continue;
        }
        counters.served.fetch_add(1, Ordering::Relaxed);
    }
}

fn spawn_responder(
    socket: Arc<UdpSocket>,
    bind_addr: SocketAddr,
    config: &Arc<Config>,
    counters: &Arc<Counters>,
    responders: Arc<Responders>,
    threads: &mut Vec<std::thread::JoinHandle<()>>,
) {
    let local_addr = socket.local_addr().unwrap_or(bind_addr);
    socket
        .set_write_timeout(Some(std::time::Duration::from_millis(50)))
        .expect("bounded UDP sends");
    info!(%local_addr, "stun: listening");
    let config = Arc::clone(config);
    let counters = Arc::clone(counters);
    match std::thread::Builder::new()
        .name(format!("merkur-stun-{}", bind_addr.port()))
        .spawn(move || serve(socket, local_addr, config, counters, responders))
    {
        Ok(handle) => threads.push(handle),
        Err(error) => {
            error!(
                port = bind_addr.port(),
                "stun: failed to spawn thread: {error}"
            );
            std::process::exit(1);
        }
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = match config_from_env() {
        Ok(config) => Arc::new(config),
        Err(error) => {
            error!("stun: configuration error: {error}");
            std::process::exit(1);
        }
    };

    let counters = Arc::new(Counters::default());
    let mut threads = Vec::with_capacity(config.ports.len() + config.change_ports.len());

    // Bind every socket before serving any of them: a `change_port` response is
    // sent from a sibling socket, so each responder needs the whole set.
    let mut sockets: Vec<(SocketAddr, Arc<UdpSocket>)> = Vec::new();
    for port in config.ports.iter().chain(&config.change_ports).copied() {
        if config.bind_addresses.is_empty() {
            let bind_addr = resolve_v4_bind_addr(port);
            match UdpSocket::bind(bind_addr) {
                Ok(socket) => sockets.push((bind_addr, Arc::new(socket))),
                Err(error) => {
                    error!(%bind_addr, "stun: failed to bind: {error}");
                    std::process::exit(1);
                }
            }
            continue;
        }
        for address in &config.bind_addresses {
            let bind_addr = SocketAddr::new(*address, port);
            match UdpSocket::bind(bind_addr) {
                Ok(socket) => sockets.push((bind_addr, Arc::new(socket))),
                Err(error) => {
                    error!(%bind_addr, "stun: failed to bind: {error}");
                    std::process::exit(1);
                }
            }
        }
    }

    let responders: Arc<Responders> = Arc::new(
        sockets
            .iter()
            .map(|(addr, socket)| (*addr, Arc::clone(socket)))
            .collect(),
    );
    info!(
        vantage_points = responders.len(),
        change_only_ports = config.change_ports.len(),
        change_ip_answerable = config.bind_addresses.len() > 1,
        "stun: bound"
    );

    for (bind_addr, socket) in sockets {
        spawn_responder(
            socket,
            bind_addr,
            &config,
            &counters,
            Arc::clone(&responders),
            &mut threads,
        );
    }

    // Report counters on a slow cadence. There is no metrics exporter here on
    // purpose: this process is reachable by anyone and every additional client
    // it runs is additional surface, so its observability is `fly logs`.
    let report_counters = Arc::clone(&counters);
    std::thread::spawn(move || -> ! {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(300));
            info!(
                served = report_counters.served.load(Ordering::Relaxed),
                dropped_unparsed = report_counters.dropped_unparsed.load(Ordering::Relaxed),
                dropped_bad_ticket = report_counters.dropped_bad_ticket.load(Ordering::Relaxed),
                dropped_bad_integrity = report_counters
                    .dropped_bad_integrity
                    .load(Ordering::Relaxed),
                dropped_unsupported_change = report_counters
                    .dropped_unsupported_change
                    .load(Ordering::Relaxed),
                "stun: counters"
            );
        }
    });

    for handle in threads {
        let _ = handle.join();
    }
}

#[cfg(test)]
mod tests {
    use ring::rand::SystemRandom;

    use super::*;

    #[test]
    fn ports_parse_into_distinct_vantage_points() {
        assert_eq!(
            parse_ports("3478,3479,3480", "MERKUR_STUN_PORTS").unwrap(),
            vec![3478, 3479, 3480]
        );
        assert_eq!(
            parse_ports(" 3478 , 3479 ", "MERKUR_STUN_PORTS").unwrap(),
            vec![3478, 3479]
        );
    }

    /// Two vantage points is the minimum that lets the daemon infer anything at
    /// all; a duplicate would look like two and behave like one.
    #[test]
    fn a_duplicate_port_is_refused_because_it_is_not_a_second_vantage_point() {
        assert!(parse_ports("3478,3478", "MERKUR_STUN_PORTS").is_err());
    }

    #[test]
    fn privileged_and_malformed_port_lists_are_refused() {
        assert!(parse_ports("80", "MERKUR_STUN_PORTS").is_err());
        assert!(parse_ports("not-a-port", "MERKUR_STUN_PORTS").is_err());
        // Empty is the change-port default; the observer list checks emptiness
        // itself, because only that list has a minimum.
        assert_eq!(parse_ports("", "MERKUR_STUN_CHANGE_PORTS").unwrap(), Vec::<u16>::new());
    }

    /// End-to-end over a real socket pair: the responder must answer a properly
    /// credentialed request and stay silent for everything else. This is the
    /// test that would catch a regression in the drop-silently rule, which is
    /// what keeps the service from being a reflector.
    #[test]
    fn the_responder_answers_only_authenticated_requests() {
        let secret = [5u8; TICKET_KEY_BYTES];
        let config = Arc::new(Config {
            bind_addresses: Vec::new(),
            ports: vec![0],
            change_ports: Vec::new(),
            ticket_key: TicketKey::new(&secret),
        });
        let server = Arc::new(UdpSocket::bind("127.0.0.1:0").expect("bind server"));
        let server_addr = server.local_addr().expect("server addr");
        let counters = Arc::new(Counters::default());
        {
            let config = Arc::clone(&config);
            let counters = Arc::clone(&counters);
            let server = Arc::clone(&server);
            let responders: Arc<Responders> =
                Arc::new([(server_addr, Arc::clone(&server))].into_iter().collect());
            std::thread::spawn(move || {
                serve(server, server_addr, config, counters, responders)
            });
        }

        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(std::time::Duration::from_millis(500)))
            .expect("timeout");

        // Unauthenticated Binding request: must be met with silence.
        let mut bare = Vec::new();
        bare.extend_from_slice(&0x0001u16.to_be_bytes());
        bare.extend_from_slice(&0u16.to_be_bytes());
        bare.extend_from_slice(&message::MAGIC_COOKIE.to_be_bytes());
        bare.extend_from_slice(&[1u8; message::TRANSACTION_ID_LEN]);
        client.send_to(&bare, server_addr).expect("send bare");
        let mut buffer = [0u8; 512];
        assert!(
            client.recv_from(&mut buffer).is_err(),
            "an unauthenticated request must be dropped, not answered"
        );

        // Authenticated request: must be answered, and the answer must carry
        // our own source address.
        let rng = SystemRandom::new();
        let ticket = config
            .ticket_key
            .issue(now_unix_secs() + 300, &rng)
            .expect("issue");
        let username = URL_SAFE_NO_PAD.encode(ticket);
        let integrity_key = config
            .ticket_key
            .verify(&ticket, now_unix_secs())
            .expect("verify");
        let request = build_client_request(username.as_bytes(), &integrity_key);
        client.send_to(&request, server_addr).expect("send");

        let (len, from) = client
            .recv_from(&mut buffer)
            .expect("a valid request is answered");
        assert_eq!(from, server_addr);
        let response = &buffer[..len];
        assert_eq!(
            &response[0..2],
            &0x0101u16.to_be_bytes(),
            "success response"
        );
        assert!(
            len <= request.len(),
            "response {len} bytes must not exceed request {} bytes",
            request.len()
        );

        // The reflexive address in the response must be the client's own.
        let client_addr = client.local_addr().expect("client addr");
        let value_start = message::HEADER_LEN + 4;
        assert_eq!(response[value_start + 1], 0x01, "IPv4 family");
        let port = u16::from_be_bytes([response[value_start + 2], response[value_start + 3]])
            ^ (message::MAGIC_COOKIE >> 16) as u16;
        assert_eq!(
            port,
            client_addr.port(),
            "XOR-MAPPED-ADDRESS is our own port"
        );
    }

    /// A ticket that verifies but whose message integrity does not must also be
    /// met with silence — otherwise a captured ticket alone is enough to make
    /// the service reflect.
    #[test]
    fn a_valid_ticket_with_a_forged_body_is_dropped() {
        let secret = [6u8; TICKET_KEY_BYTES];
        let config = Arc::new(Config {
            bind_addresses: Vec::new(),
            ports: vec![0],
            change_ports: Vec::new(),
            ticket_key: TicketKey::new(&secret),
        });
        let server = Arc::new(UdpSocket::bind("127.0.0.1:0").expect("bind server"));
        let server_addr = server.local_addr().expect("addr");
        let counters = Arc::new(Counters::default());
        {
            let config = Arc::clone(&config);
            let counters = Arc::clone(&counters);
            let responders: Arc<Responders> =
                Arc::new([(server_addr, Arc::clone(&server))].into_iter().collect());
            std::thread::spawn(move || {
                serve(server, server_addr, config, counters, responders)
            });
        }

        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(std::time::Duration::from_millis(500)))
            .expect("timeout");

        let rng = SystemRandom::new();
        let ticket = config
            .ticket_key
            .issue(now_unix_secs() + 300, &rng)
            .expect("issue");
        let username = URL_SAFE_NO_PAD.encode(ticket);
        let wrong = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"not the derived key");
        let request = build_client_request(username.as_bytes(), &wrong);
        client.send_to(&request, server_addr).expect("send");

        let mut buffer = [0u8; 512];
        assert!(
            client.recv_from(&mut buffer).is_err(),
            "a real ticket with a forged integrity tag must still be dropped"
        );
    }

    fn addr(text: &str) -> SocketAddr {
        text.parse().expect("addr")
    }

    #[test]
    fn alternate_selection_never_answers_from_what_was_asked_to_change() {
        // One address, three observer ports and one change-only port — Fly.
        let one_address = [
            addr("10.0.0.1:3478"),
            addr("10.0.0.1:3479"),
            addr("10.0.0.1:3480"),
            addr("10.0.0.1:3481"),
        ];
        let change = [3481u16];
        // The change-only port wins over every observer port, from any of them.
        assert_eq!(
            alternate_port_addr(&one_address, &change, addr("10.0.0.1:3478")),
            Some(addr("10.0.0.1:3481"))
        );
        assert_eq!(
            alternate_port_addr(&one_address, &change, addr("10.0.0.1:3480")),
            Some(addr("10.0.0.1:3481"))
        );
        // Without one, another observer port still answers: port independence
        // needs a same-IP port change and a two-port deployment has nothing else.
        assert_eq!(
            alternate_port_addr(&one_address[..3], &[], addr("10.0.0.1:3478")),
            Some(addr("10.0.0.1:3479"))
        );
        // ...and it cannot answer an address change at all, which is exactly why
        // a second Fly region was rejected: the address belongs to the app.
        assert_eq!(
            alternate_address_addr(&one_address, &change, addr("10.0.0.1:3478"), false),
            None
        );

        // A single port cannot answer a port-change test.
        assert_eq!(
            alternate_port_addr(&[addr("10.0.0.1:3478")], &[], addr("10.0.0.1:3478")),
            None
        );

        // Two addresses on two observer ports plus a change-only port — the
        // Hetzner /64 deployment.
        let two_addresses = [
            addr("[2001:db8::1]:34780"),
            addr("[2001:db8::1]:34781"),
            addr("[2001:db8::1]:34782"),
            addr("[2001:db8::2]:34780"),
            addr("[2001:db8::2]:34781"),
            addr("[2001:db8::2]:34782"),
        ];
        let change = [34782u16];
        let from = addr("[2001:db8::1]:34780");
        let changed_ip =
            alternate_address_addr(&two_addresses, &change, from, false).expect("address");
        assert_ne!(changed_ip.ip(), from.ip());
        assert_eq!(changed_ip.port(), 34782, "the change-only port is preferred");

        // The combined form must change BOTH, or report nothing.
        let changed_both =
            alternate_address_addr(&two_addresses, &change, from, true).expect("both");
        assert_ne!(changed_both.ip(), from.ip());
        assert_eq!(changed_both.port(), 34782);

        // An address that exists only on the port already spoken to cannot
        // satisfy the combined form, and must not be downgraded to a partial
        // answer that would report a pass for an untested property.
        let single_port_each = [addr("[2001:db8::1]:34780"), addr("[2001:db8::2]:34780")];
        assert_eq!(
            alternate_address_addr(&single_port_each, &[], from, true),
            None,
            "change_ip+change_port must refuse rather than change only the address"
        );
        assert_eq!(
            alternate_address_addr(&single_port_each, &[], from, false),
            Some(addr("[2001:db8::2]:34780"))
        );
        // A v6 arrival never selects a v4 alternate, whatever its port set.
        let mixed = [addr("[2001:db8::1]:34780"), addr("203.0.113.1:34782")];
        assert_eq!(alternate_address_addr(&mixed, &change, from, false), None);
    }

    /// The address-change half of RFC 5780, end to end over real sockets.
    ///
    /// Two loopback addresses stand in for two addresses out of the Hetzner
    /// host's routed IPv6 /64. This is the half a single-address deployment can
    /// never answer, and the half that matters over IPv6: there is no NAT
    /// there, so whether a `host6` candidate is reachable turns entirely on
    /// whether the CPE firewall passes a datagram from an address the daemon
    /// never spoke to.
    /// Requires a second loopback address, which is why it is `--ignored`.
    ///
    /// Linux has `127.0.0.2` by default. macOS does not, and creating it needs
    /// privileges a test must not take:
    ///
    /// ```text
    /// sudo ifconfig lo0 alias 127.0.0.2 up
    /// cargo test -p merkur-stun -- --ignored a_change_ip
    /// ```
    ///
    /// The selection logic itself is covered unconditionally by
    /// `alternate_selection_never_answers_from_what_was_asked_to_change`; what
    /// this adds is proof that `serve` wires it to a real socket, which is the
    /// part a refactor could silently break.
    #[test]
    #[ignore = "requires a second loopback address; see the doc comment"]
    fn a_change_ip_request_is_answered_from_the_other_address() {
        let secret = [13u8; TICKET_KEY_BYTES];
        let first = UdpSocket::bind("127.0.0.1:0").expect("bind first");
        let first_addr = first.local_addr().expect("first addr");
        let second = UdpSocket::bind(SocketAddr::from((
            std::net::Ipv4Addr::new(127, 0, 0, 2),
            first_addr.port(),
        )))
        .or_else(|_| UdpSocket::bind("127.0.0.2:0"))
        .expect("bind second");
        let second_addr = second.local_addr().expect("second addr");
        assert_ne!(first_addr.ip(), second_addr.ip());
        let first = Arc::new(first);
        let second = Arc::new(second);

        let config = Arc::new(Config {
            bind_addresses: vec![first_addr.ip(), second_addr.ip()],
            ports: vec![first_addr.port()],
            change_ports: Vec::new(),
            ticket_key: TicketKey::new(&secret),
        });
        let counters = Arc::new(Counters::default());
        let responders: Arc<Responders> = Arc::new(
            [
                (first_addr, Arc::clone(&first)),
                (second_addr, Arc::clone(&second)),
            ]
            .into_iter()
            .collect(),
        );
        for (socket, addr) in [(&first, first_addr), (&second, second_addr)] {
            let socket = Arc::clone(socket);
            let config = Arc::clone(&config);
            let counters = Arc::clone(&counters);
            let responders = Arc::clone(&responders);
            std::thread::spawn(move || {
                serve(socket, addr, config, counters, responders)
            });
        }

        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(std::time::Duration::from_millis(800)))
            .expect("timeout");

        let rng = SystemRandom::new();
        let ticket = config
            .ticket_key
            .issue(now_unix_secs() + 300, &rng)
            .expect("issue");
        let username = URL_SAFE_NO_PAD.encode(ticket);
        let integrity = config
            .ticket_key
            .verify(&ticket, now_unix_secs())
            .expect("verify");

        let request = build_client_request_with_change(
            username.as_bytes(),
            &integrity,
            Some(message::ChangeRequest {
                change_ip: true,
                change_port: false,
            }),
        );
        client.send_to(&request, first_addr).expect("send");
        let mut buffer = [0u8; 512];
        let (_, from) = client
            .recv_from(&mut buffer)
            .expect("a change_ip request must be answered where two addresses are bound");
        assert_eq!(
            from.ip(),
            second_addr.ip(),
            "the response must come from the other ADDRESS, or it proves nothing"
        );

        // The combined form asks for an address AND a port neither of which has
        // been spoken to. Only one port is bound here, so it must be refused
        // rather than downgraded to the address-only answer above.
        let request = build_client_request_with_change(
            username.as_bytes(),
            &integrity,
            Some(message::ChangeRequest {
                change_ip: true,
                change_port: true,
            }),
        );
        client.send_to(&request, first_addr).expect("send");
        assert!(
            client.recv_from(&mut buffer).is_err(),
            "change_ip+change_port with one port must be refused, not partially honoured"
        );
    }

    /// RFC 5780 filtering discovery, end to end over real sockets.
    ///
    /// The response must arrive **from a different port** than the request was
    /// sent to. That is the whole test: it tells the client whether its NAT
    /// will accept an inbound packet from a port it never sent to, which is
    /// exactly the situation a browser dialling a reflexive candidate is in.
    #[test]
    fn a_change_port_request_is_answered_from_the_other_port() {
        let secret = [11u8; TICKET_KEY_BYTES];
        let first = UdpSocket::bind("127.0.0.1:0").expect("bind first");
        let second = UdpSocket::bind("127.0.0.1:0").expect("bind second");
        let first_addr = first.local_addr().expect("first addr");
        let second_addr = second.local_addr().expect("second addr");
        let first = Arc::new(first);
        let second = Arc::new(second);

        // `second` is change-only: the observer never receives a mapping probe
        // on it, so the daemon's ledger cannot discount its answer.
        let config = Arc::new(Config {
            bind_addresses: Vec::new(),
            ports: vec![first_addr.port()],
            change_ports: vec![second_addr.port()],
            ticket_key: TicketKey::new(&secret),
        });
        let counters = Arc::new(Counters::default());
        let responders: Arc<Responders> = Arc::new(
            [
                (first_addr, Arc::clone(&first)),
                (second_addr, Arc::clone(&second)),
            ]
            .into_iter()
            .collect(),
        );
        for (socket, addr) in [(&first, first_addr), (&second, second_addr)] {
            let socket = Arc::clone(socket);
            let config = Arc::clone(&config);
            let counters = Arc::clone(&counters);
            let responders = Arc::clone(&responders);
            std::thread::spawn(move || {
                serve(socket, addr, config, counters, responders)
            });
        }

        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        client
            .set_read_timeout(Some(std::time::Duration::from_millis(800)))
            .expect("timeout");

        let rng = SystemRandom::new();
        let ticket = config
            .ticket_key
            .issue(now_unix_secs() + 300, &rng)
            .expect("issue");
        let username = URL_SAFE_NO_PAD.encode(ticket);
        let integrity = config
            .ticket_key
            .verify(&ticket, now_unix_secs())
            .expect("verify");

        // change_port: must come back from `second_addr`.
        let request = build_client_request_with_change(
            username.as_bytes(),
            &integrity,
            Some(message::ChangeRequest {
                change_ip: false,
                change_port: true,
            }),
        );
        client.send_to(&request, first_addr).expect("send");
        let mut buffer = [0u8; 512];
        let (_, from) = client
            .recv_from(&mut buffer)
            .expect("a change_port request is answered");
        assert_eq!(
            from, second_addr,
            "the response must come from the other port, or it proves nothing about filtering"
        );

        // change_ip: unanswerable on one address, and must be refused rather
        // than answered from the same address as though it had been honoured.
        let request = build_client_request_with_change(
            username.as_bytes(),
            &integrity,
            Some(message::ChangeRequest {
                change_ip: true,
                change_port: false,
            }),
        );
        client.send_to(&request, first_addr).expect("send");
        assert!(
            client.recv_from(&mut buffer).is_err(),
            "an unhonourable change_ip must be dropped, not answered from the same address"
        );
        assert_eq!(
            counters.dropped_unsupported_change.load(Ordering::Relaxed),
            1
        );
    }

    /// Every CHANGE-REQUEST form through `serve`, on any machine.
    ///
    /// `serve` learns the bound set only from the responder table, so an alias
    /// key stands in for a second address: `127.0.0.2` on the observer's port
    /// maps to a real socket on `127.0.0.1`, and each answer's source names the
    /// socket `serve` chose. The table gives every form a different outcome —
    /// the observer, the change-only port, the other address, and a refusal for
    /// the combined form, because the other address is bound only on the port
    /// the client already spoke to — so answering one form with another's
    /// socket cannot pass. Unlike
    /// `a_change_ip_request_is_answered_from_the_other_address`, it needs no
    /// second loopback address.
    #[test]
    fn each_change_request_form_is_answered_from_its_own_socket_or_refused() {
        // RFC 5780 §7.2 CHANGE-REQUEST flag bits.
        const CHANGE_PORT: u8 = 0x02;
        const CHANGE_IP: u8 = 0x04;
        let secret = [17u8; TICKET_KEY_BYTES];
        let bind = || Arc::new(UdpSocket::bind("127.0.0.1:0").expect("bind"));
        let (observer, change_only, other_address) = (bind(), bind(), bind());
        let observer_addr = observer.local_addr().expect("observer addr");
        let change_only_addr = change_only.local_addr().expect("change-only addr");
        let other_address_addr = other_address.local_addr().expect("other address addr");
        let config = Arc::new(Config {
            bind_addresses: Vec::new(),
            ports: vec![observer_addr.port()],
            change_ports: vec![change_only_addr.port()],
            ticket_key: TicketKey::new(&secret),
        });
        let counters = Arc::new(Counters::default());
        let responders: Arc<Responders> = Arc::new(
            [
                (observer_addr, Arc::clone(&observer)),
                (change_only_addr, Arc::clone(&change_only)),
                (
                    SocketAddr::from(([127, 0, 0, 2], observer_addr.port())),
                    Arc::clone(&other_address),
                ),
            ]
            .into_iter()
            .collect(),
        );
        {
            let config = Arc::clone(&config);
            let counters = Arc::clone(&counters);
            std::thread::spawn(move || {
                serve(observer, observer_addr, config, counters, responders)
            });
        }

        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        // A hang guard only: every expectation below completes on an answer.
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .expect("timeout");
        let rng = SystemRandom::new();
        let ticket = config
            .ticket_key
            .issue(now_unix_secs() + 300, &rng)
            .expect("issue");
        let username = URL_SAFE_NO_PAD.encode(ticket);
        let integrity = config
            .ticket_key
            .verify(&ticket, now_unix_secs())
            .expect("verify");
        let ask = |transaction: u8, change: u8| {
            let request = message::binding_request(
                &[transaction; message::TRANSACTION_ID_LEN],
                username.as_bytes(),
                change,
                &integrity,
            )
            .expect("request");
            client
                .send_to(request.as_bytes(), observer_addr)
                .expect("send");
        };
        let mut buffer = [0u8; 512];
        let mut answer = || {
            let (_, from) = client.recv_from(&mut buffer).expect("answered");
            (buffer[message::HEADER_LEN - 1], from)
        };

        ask(1, 0);
        assert_eq!(answer(), (1, observer_addr), "a plain request");
        ask(2, CHANGE_PORT);
        assert_eq!(answer(), (2, change_only_addr), "change_port");
        ask(3, CHANGE_IP);
        assert_eq!(answer(), (3, other_address_addr), "change_ip");
        // Nothing here changes both address and port, so the combined form is
        // refused. The next answer is the plain request sent after it, which
        // proves the refusal sent nothing from any socket.
        ask(4, CHANGE_IP | CHANGE_PORT);
        ask(5, 0);
        assert_eq!(
            answer(),
            (5, observer_addr),
            "change_ip+change_port is refused"
        );
        assert_eq!(
            counters.dropped_unsupported_change.load(Ordering::Relaxed),
            1
        );
    }

    fn build_client_request_with_change(
        username: &[u8],
        key: &ring::hmac::Key,
        change: Option<message::ChangeRequest>,
    ) -> Vec<u8> {
        let mut msg = Vec::new();
        msg.extend_from_slice(&0x0001u16.to_be_bytes());
        msg.extend_from_slice(&0u16.to_be_bytes());
        msg.extend_from_slice(&message::MAGIC_COOKIE.to_be_bytes());
        msg.extend_from_slice(&[3u8; message::TRANSACTION_ID_LEN]);
        msg.extend_from_slice(&message::ATTR_USERNAME.to_be_bytes());
        msg.extend_from_slice(&(username.len() as u16).to_be_bytes());
        msg.extend_from_slice(username);
        while msg.len() % 4 != 0 {
            msg.push(0);
        }
        if let Some(change) = change {
            let mut flags = 0u8;
            if change.change_ip {
                flags |= 0x04;
            }
            if change.change_port {
                flags |= 0x02;
            }
            msg.extend_from_slice(&message::ATTR_CHANGE_REQUEST.to_be_bytes());
            msg.extend_from_slice(&4u16.to_be_bytes());
            msg.extend_from_slice(&[0, 0, 0, flags]);
        }
        let covered =
            (msg.len() + 4 + message::MESSAGE_INTEGRITY_SHA256_LEN - message::HEADER_LEN) as u16;
        msg[2..4].copy_from_slice(&covered.to_be_bytes());
        let tag = ring::hmac::sign(key, &msg);
        msg.extend_from_slice(&message::ATTR_MESSAGE_INTEGRITY_SHA256.to_be_bytes());
        msg.extend_from_slice(&(message::MESSAGE_INTEGRITY_SHA256_LEN as u16).to_be_bytes());
        msg.extend_from_slice(tag.as_ref());
        msg
    }

    fn build_client_request(username: &[u8], key: &ring::hmac::Key) -> Vec<u8> {
        let mut msg = Vec::new();
        msg.extend_from_slice(&0x0001u16.to_be_bytes());
        msg.extend_from_slice(&0u16.to_be_bytes());
        msg.extend_from_slice(&message::MAGIC_COOKIE.to_be_bytes());
        msg.extend_from_slice(&[2u8; message::TRANSACTION_ID_LEN]);
        msg.extend_from_slice(&message::ATTR_USERNAME.to_be_bytes());
        msg.extend_from_slice(&(username.len() as u16).to_be_bytes());
        msg.extend_from_slice(username);
        while msg.len() % 4 != 0 {
            msg.push(0);
        }
        let covered =
            (msg.len() + 4 + message::MESSAGE_INTEGRITY_SHA256_LEN - message::HEADER_LEN) as u16;
        msg[2..4].copy_from_slice(&covered.to_be_bytes());
        let tag = ring::hmac::sign(key, &msg);
        msg.extend_from_slice(&message::ATTR_MESSAGE_INTEGRITY_SHA256.to_be_bytes());
        msg.extend_from_slice(&(message::MESSAGE_INTEGRITY_SHA256_LEN as u16).to_be_bytes());
        msg.extend_from_slice(tag.as_ref());
        msg
    }
}
