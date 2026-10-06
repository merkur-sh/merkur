//! UPnP Internet Gateway Device client: SSDP discovery, one bounded HTTP/1.1
//! fetch of the device description, and the four SOAP actions Merkur needs.
//!
//! # Why hand-rolled
//!
//! `igd-next`'s async build drags `hyper`, `hyper-util`, `http-body-util` and
//! `xmltree` into the dataplane for four fixed-shape requests, and it exposes
//! IPv4 only — the IGDv2 `WANIPv6FirewallControl` pinhole would have been a
//! second, hand-written SOAP path beside it. One small client covers both
//! families with one HTTP path, one XML scan, fixed buffers and no HTTP stack.
//! It runs on the owned maintenance task, never on a frame path.
//!
//! # Which device
//!
//! A LAN can answer SSDP with several IGDs: a mesh node, an ISP modem in front
//! of a user's router, a stale device in bridge mode. Only one of them is the
//! NAT whose public address a browser would dial, and that address is known: it
//! is the STUN-observed reflexive address. So every device is asked for its
//! `GetExternalIPAddress`, and only the one whose answer equals the reflexive
//! address is ever mapped. A device reporting any other address is an inner NAT;
//! a mapping on it would publish a port the outer NAT does not forward. The
//! question is asked *before* `AddPortMapping`, so a gateway that only grants
//! permanent leases never accumulates a rule on the wrong device.
//!
//! # What is deliberately not here
//!
//! No event subscription and no XML parser: the device description is scanned
//! for the service blocks by tag, which is what every IGD client ends up doing
//! and what the format was written for.
//!
//! The service names, the error codes worth a retry and the SSDP ordering follow
//! the router behaviour Tailscale's portmapper (`net/portmapper`) records; the
//! real-router descriptions under `fixtures/` come from its test suite.

use std::fmt::Write as _;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpSocket;
use tracing::{debug, info, warn};

use super::super::egress::EgressPath;

const SSDP_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
/// UPnP Device Architecture §1.3: SSDP listens on 1900.
pub const SSDP_PORT: u16 = 1900;
/// MX advertised in the search; responders spread replies over this window.
const SSDP_MX_SECS: u8 = 2;
/// How long a search listens: the advertised MX plus one second for the HTTP
/// exchanges a device's answer starts. Derived from `SSDP_MX_SECS`, so a
/// conforming responder always lands inside it.
pub const SSDP_WINDOW: Duration = Duration::from_secs(SSDP_MX_SECS as u64 + 1);
/// One SSDP datagram. Responses are a few hundred bytes; anything larger is
/// not a device answer.
const SSDP_RESPONSE_BYTES: usize = 1500;
/// Device descriptions run 5–40 KiB. A cap, not a target: a description that
/// does not fit is a device this client will not talk to.
const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);

const IGD_SEARCH_TARGET: &str = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";
/// Some IGDs answer only a broad search, and some answer `ssdp:all` with just
/// their first descriptor, so both are sent.
const ALL_SEARCH_TARGET: &str = "ssdp:all";
/// A search answer is worth a description fetch only when it names an IGD;
/// `ssdp:all` also draws every television and printer on the LAN.
const IGD_MARKER: &str = "InternetGatewayDevice";
const WAN_IP_CONNECTION_2: &str = "urn:schemas-upnp-org:service:WANIPConnection:2";
const WAN_IP_CONNECTION_1: &str = "urn:schemas-upnp-org:service:WANIPConnection:1";
const WAN_PPP_CONNECTION_1: &str = "urn:schemas-upnp-org:service:WANPPPConnection:1";
/// The DSL Forum TR-064 names of the same two services, still served by older
/// DSL CPE (deprecated in 2015, not retired).
const LEGACY_WAN_IP_CONNECTION_1: &str = "urn:dslforum-org:service:WANIPConnection:1";
const LEGACY_WAN_PPP_CONNECTION_1: &str = "urn:dslforum-org:service:WANPPPConnection:1";
const WAN_IPV6_FIREWALL_1: &str = "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1";

/// UPnP error 718: the requested external port is held by another mapping.
const ERROR_CONFLICT_IN_MAPPING_ENTRY: u16 = 718;
/// UPnP error 725: `OnlyPermanentLeasesSupported`.
const ERROR_ONLY_PERMANENT_LEASES: u16 = 725;
/// UPnP error 402: `Invalid Args`, which some gateways return for any non-zero
/// lease duration instead of 725.
const ERROR_INVALID_ARGS: u16 = 402;
/// Resource bound on alternative external ports tried after 718 against a
/// service with no `AddAnyPortMapping`. Each retry answers an explicit
/// conflict; the bound only caps a gateway that conflicts with everything.
const UPNP_CONFLICT_RETRIES: usize = 4;
/// The lowest external port asked for after a conflict: gateways refuse
/// privileged ports, and zero is the wildcard that forwards every port.
const FIRST_UNPRIVILEGED_PORT: u16 = 1024;
/// Resource bound on distinct devices whose description is fetched per search.
const MAX_DEVICES: usize = 4;

/// A control endpoint: where to POST and which service the action belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlUrl {
    pub address: SocketAddr,
    /// `Host` header value: the authority exactly as the description named it.
    pub host: String,
    pub path: String,
    pub service_type: &'static str,
    /// Bound on every SOAP request, including renewal and deletion.
    pub source: Option<IpAddr>,
}

/// The services a discovered gateway exposes, resolved to control endpoints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gateway {
    /// `WANIPConnection:2`, `WANIPConnection:1`, `WANPPPConnection:1`, then the
    /// DSL Forum names, in that order of preference.
    pub wan: Option<ControlUrl>,
    /// `WANIPv6FirewallControl:1` (IGDv2).
    pub firewall6: Option<ControlUrl>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoapError {
    /// The gateway answered with a UPnP error, RFC 6970 / UPnP-arch §3.2.
    Upnp(u16),
    /// The exchange did not complete: connect, write, read, timeout, or a
    /// response this client could not read as SOAP.
    Transport,
}

/// What an IPv4 search found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Discovery {
    /// The IGD whose external address equals the reflexive address.
    Edge(ControlUrl),
    /// IGDs answered, and every one reported another external address: this
    /// host sits behind a NAT none of them is.
    InnerNat,
    /// No IGD with a usable WAN service answered within the window.
    None,
}

/// Find the IGD that is the edge NAT for `egress`.
///
/// The unicast search goes to the first hop before the multicast ones: some
/// gateways answer only one of the two, and the unicast reply teaches a stateful
/// host firewall to admit the multicast replies from the same address. Answers
/// are taken as they arrive; the first device whose external address equals
/// `reflexive` ends the search. Bounded by `window` (`SSDP_WINDOW` in
/// production), with every HTTP exchange inside it.
pub async fn discover(
    egress: &EgressPath,
    ssdp_port: u16,
    window: Duration,
    reflexive: Ipv4Addr,
) -> Discovery {
    let socket = match ssdp_socket(egress) {
        Ok(socket) => socket,
        Err(error) => {
            debug!("ssdp socket unavailable: {error}");
            return Discovery::None;
        }
    };
    let igd = search_request("239.255.255.250:1900", IGD_SEARCH_TARGET);
    let all = search_request("239.255.255.250:1900", ALL_SEARCH_TARGET);
    if let Some(gateway) = egress.gateway {
        let _ = socket
            .send_to(igd.as_bytes(), SocketAddrV4::new(gateway, ssdp_port))
            .await;
    }
    let group = SocketAddrV4::new(SSDP_GROUP, ssdp_port);
    let _ = socket.send_to(igd.as_bytes(), group).await;
    let _ = socket.send_to(all.as_bytes(), group).await;

    let deadline = tokio::time::Instant::now() + window;
    let mut buf = [0u8; SSDP_RESPONSE_BYTES];
    // Descriptions already fetched this round; a device answers every search.
    let mut seen: Vec<String> = Vec::with_capacity(MAX_DEVICES);
    let mut inner_nat = false;
    let verdict = |inner_nat: bool| {
        if inner_nat {
            Discovery::InnerNat
        } else {
            Discovery::None
        }
    };
    loop {
        let Ok(Ok((len, from))) =
            tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await
        else {
            return verdict(inner_nat);
        };
        let answer = &buf[..len];
        if !contains(answer, IGD_MARKER.as_bytes()) {
            continue;
        }
        let Some(location) = ssdp_location(answer) else {
            continue;
        };
        if seen.iter().any(|known| known == location) {
            continue;
        }
        if seen.len() == MAX_DEVICES {
            return verdict(inner_nat);
        }
        seen.push(location.to_string());
        let Some(url) = parse_http_url(location) else {
            continue;
        };
        debug!(%from, location, "igd: device answered the search");
        let checked = tokio::time::timeout_at(deadline, async {
            let gateway = fetch_description(&url, Some(IpAddr::V4(egress.local_ipv4))).await?;
            let control = gateway.wan?;
            let external = external_address(&control).await.ok()?;
            Some((control, external))
        })
        .await;
        match checked {
            Ok(Some((control, external))) if external == reflexive => {
                return Discovery::Edge(control);
            }
            Ok(Some((_, external))) => {
                info!(
                    location,
                    %external,
                    %reflexive,
                    "igd: device is not the edge NAT; not mapping on it"
                );
                inner_nat = true;
            }
            Ok(None) => debug!(location, "igd: no usable WAN service or external address"),
            Err(_) => return verdict(inner_nat),
        }
    }
}

fn search_request(host: &str, target: &str) -> String {
    let mut search = String::with_capacity(160);
    let _ = write!(
        search,
        "M-SEARCH * HTTP/1.1\r\nHOST: {host}\r\nMAN: \"ssdp:discover\"\r\nMX: {SSDP_MX_SECS}\r\nST: {target}\r\n\r\n"
    );
    search
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn ssdp_socket(egress: &EgressPath) -> std::io::Result<tokio::net::UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.set_nonblocking(true)?;
    // Multicast leaves through the egress interface, not whichever interface
    // the kernel's default multicast route names — on a host with a VPN or a
    // container bridge those are different links.
    socket.set_multicast_if_v4(&egress.local_ipv4)?;
    socket.set_multicast_ttl_v4(2)?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(egress.local_ipv4, 0)).into())?;
    tokio::net::UdpSocket::from_std(socket.into())
}

/// IGDv2 verifies that the HTTP source is the pinhole's InternalClient.
/// IPv4 discovery cannot authorize a pinhole for a global IPv6 address.
pub async fn discover_v6(egress: &super::EgressPath6, window: Duration) -> Option<ControlUrl> {
    use std::net::SocketAddrV6;
    let socket = socket2::Socket::new(
        socket2::Domain::IPV6,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )
    .ok()?;
    socket.set_nonblocking(true).ok()?;
    socket.set_multicast_if_v6(egress.interface_index).ok()?;
    socket.set_multicast_hops_v6(2).ok()?;
    socket
        .bind(&SocketAddr::V6(SocketAddrV6::new(egress.local, 0, 0, 0)).into())
        .ok()?;
    let socket = tokio::net::UdpSocket::from_std(socket.into()).ok()?;
    let target = SocketAddrV6::new("ff02::c".parse().ok()?, SSDP_PORT, 0, egress.interface_index);
    let search = search_request("[ff02::c]:1900", WAN_IPV6_FIREWALL_1);
    socket.send_to(search.as_bytes(), target).await.ok()?;
    let deadline = tokio::time::Instant::now() + window;
    let mut buf = [0u8; SSDP_RESPONSE_BYTES];
    let mut seen = Vec::with_capacity(MAX_DEVICES);
    loop {
        let (len, _) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf))
            .await
            .ok()?
            .ok()?;
        let Some(mut url) = ssdp_location(&buf[..len]).and_then(parse_http_url) else {
            continue;
        };
        if !scope_v6(&mut url.address, egress.interface_index) {
            continue;
        }
        if seen.contains(&url.address) {
            continue;
        }
        if seen.len() == MAX_DEVICES {
            return None;
        }
        seen.push(url.address);
        let Some(gateway) = tokio::time::timeout_at(
            deadline,
            fetch_description(&url, Some(IpAddr::V6(egress.local))),
        )
        .await
        .ok()?
        else {
            continue;
        };
        let Some(mut control) = gateway.firewall6 else {
            continue;
        };
        if scope_v6(&mut control.address, egress.interface_index) {
            return Some(control);
        }
    }
}

fn scope_v6(address: &mut SocketAddr, interface: u32) -> bool {
    let SocketAddr::V6(address) = address else {
        return false;
    };
    if address.ip().is_unicast_link_local() {
        address.set_scope_id(interface);
    }
    true
}

/// The `LOCATION` header of a successful SSDP response, or `None` for
/// anything else. Any HTTP/1.x version is accepted: some devices answer 1.0.
fn ssdp_location(response: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(response).ok()?;
    let status_line = text.split("\r\n").next()?;
    let mut parts = status_line.split(' ');
    if !parts.next()?.starts_with("HTTP/1.") || parts.next()? != "200" {
        return None;
    }
    header_value(text, "location")
}

/// Case-insensitive header lookup over a CRLF-separated head.
fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n").find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// A plain `http://` URL with a literal host, which is all a LAN description
/// location ever is.
#[derive(Clone, Debug, PartialEq, Eq)]
struct HttpUrl {
    address: SocketAddr,
    host: String,
    path: String,
}

fn parse_http_url(url: &str) -> Option<HttpUrl> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    let address = if let Some(bracket) = authority.strip_prefix('[') {
        let (host, tail) = bracket.split_once(']')?;
        let port = if tail.is_empty() {
            80
        } else {
            tail.strip_prefix(':')?.parse().ok()?
        };
        SocketAddr::new(IpAddr::V6(host.parse::<Ipv6Addr>().ok()?), port)
    } else {
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (host, port.parse::<u16>().ok()?),
            None => (authority, 80),
        };
        SocketAddr::new(IpAddr::V4(host.parse::<Ipv4Addr>().ok()?), port)
    };
    Some(HttpUrl {
        address,
        host: authority.to_string(),
        path: path.to_string(),
    })
}

/// Resolve a control URL from the description: absolute, relative to
/// `URLBase`, or relative to the description's own origin.
fn resolve_control_url(base: &HttpUrl, url_base: Option<&str>, control: &str) -> Option<HttpUrl> {
    if control.starts_with("http://") {
        return parse_http_url(control);
    }
    let origin = match url_base.and_then(parse_http_url) {
        Some(base) => base,
        None => base.clone(),
    };
    let path = if control.starts_with('/') {
        control.to_string()
    } else {
        let mut path = origin.path[..origin.path.rfind('/').map_or(0, |at| at + 1)].to_string();
        if path.is_empty() {
            path.push('/');
        }
        path.push_str(control);
        path
    };
    Some(HttpUrl {
        address: origin.address,
        host: origin.host,
        path,
    })
}

async fn fetch_description(url: &HttpUrl, source: Option<IpAddr>) -> Option<Gateway> {
    let mut request = String::with_capacity(96 + url.path.len() + url.host.len());
    let _ = write!(
        request,
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nUser-Agent: merkur-daemon\r\n\r\n",
        url.path, url.host
    );
    let response = http_exchange(url.address, source, request.as_bytes()).await?;
    let (status, body) = split_response(&response)?;
    if status != 200 {
        return None;
    }
    let mut gateway = parse_description(url, &body);
    for control in [&mut gateway.wan, &mut gateway.firewall6]
        .into_iter()
        .flatten()
    {
        control.source = source;
    }
    Some(gateway)
}

/// Scan the description for the services this client speaks.
fn parse_description(location: &HttpUrl, body: &str) -> Gateway {
    let url_base = tag_text(body, "URLBase").filter(|value| !value.is_empty());
    let mut gateway = Gateway {
        wan: None,
        firewall6: None,
    };
    let mut rest = body;
    while let Some(start) = rest.find("<service>") {
        let block = &rest[start..];
        let Some(end) = block.find("</service>") else {
            break;
        };
        let service = &block[..end];
        rest = &block[end + "</service>".len()..];
        let Some(service_type) = tag_text(service, "serviceType") else {
            continue;
        };
        let known: &'static str = match service_type {
            WAN_IP_CONNECTION_2 => WAN_IP_CONNECTION_2,
            WAN_IP_CONNECTION_1 => WAN_IP_CONNECTION_1,
            WAN_PPP_CONNECTION_1 => WAN_PPP_CONNECTION_1,
            LEGACY_WAN_IP_CONNECTION_1 => LEGACY_WAN_IP_CONNECTION_1,
            LEGACY_WAN_PPP_CONNECTION_1 => LEGACY_WAN_PPP_CONNECTION_1,
            WAN_IPV6_FIREWALL_1 => WAN_IPV6_FIREWALL_1,
            _ => continue,
        };
        let Some(control) = tag_text(service, "controlURL") else {
            continue;
        };
        let Some(resolved) = resolve_control_url(location, url_base, control) else {
            continue;
        };
        let control = ControlUrl {
            address: resolved.address,
            host: resolved.host,
            path: resolved.path,
            service_type: known,
            source: None,
        };
        if known == WAN_IPV6_FIREWALL_1 {
            if gateway.firewall6.is_none() {
                gateway.firewall6 = Some(control);
            }
        } else if gateway
            .wan
            .as_ref()
            .is_none_or(|held| wan_rank(known) < wan_rank(held.service_type))
        {
            gateway.wan = Some(control);
        }
    }
    gateway
}

fn wan_rank(service_type: &str) -> u8 {
    match service_type {
        WAN_IP_CONNECTION_2 => 0,
        WAN_IP_CONNECTION_1 => 1,
        WAN_PPP_CONNECTION_1 => 2,
        LEGACY_WAN_IP_CONNECTION_1 => 3,
        _ => 4,
    }
}

/// Text of the first `<tag>…</tag>` in `xml`, trimmed.
fn tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let mut search = xml;
    loop {
        let open_at = search.find(&format!("<{tag}"))?;
        let after_open = &search[open_at + 1 + tag.len()..];
        // `<serviceType>` must not match `<serviceTypeX>`; the next byte must
        // close the tag or start an attribute.
        match after_open.as_bytes().first() {
            Some(b'>') => {
                let inner = &after_open[1..];
                let close = inner.find(&format!("</{tag}>"))?;
                return Some(inner[..close].trim());
            }
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') => {
                let close_tag = after_open.find('>')?;
                let inner = &after_open[close_tag + 1..];
                let close = inner.find(&format!("</{tag}>"))?;
                return Some(inner[..close].trim());
            }
            _ => search = after_open,
        }
    }
}

/// One request, whole response, bounded in time and size.
async fn http_exchange(
    address: SocketAddr,
    source: Option<IpAddr>,
    request: &[u8],
) -> Option<Vec<u8>> {
    let exchange = async {
        let socket = if address.is_ipv6() {
            TcpSocket::new_v6().ok()?
        } else {
            TcpSocket::new_v4().ok()?
        };
        if let Some(source) = source {
            socket.bind(SocketAddr::new(source, 0)).ok()?;
        }
        let mut stream = socket.connect(address).await.ok()?;
        stream.write_all(request).await.ok()?;
        let mut response = Vec::with_capacity(8 * 1024);
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            if response.len() + read > MAX_HTTP_BODY_BYTES {
                return None;
            }
            response.extend_from_slice(&chunk[..read]);
        }
        Some(response)
    };
    tokio::time::timeout(HTTP_TIMEOUT, exchange).await.ok()?
}

/// Status code and body, with `Transfer-Encoding: chunked` unfolded.
fn split_response(response: &[u8]) -> Option<(u16, String)> {
    let head_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&response[..head_end]).ok()?;
    let status: u16 = head.split_once(' ')?.1.split(' ').next()?.parse().ok()?;
    let raw_body = &response[head_end + 4..];
    let chunked = header_value(head, "transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"));
    let body = if chunked {
        dechunk(raw_body)?
    } else {
        raw_body.to_vec()
    };
    Some((status, String::from_utf8_lossy(&body).into_owned()))
}

fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(body.len());
    loop {
        let line_end = body.windows(2).position(|window| window == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
        let size_text = size_text.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if body.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
}

/// POST one SOAP action and return the response body on success.
async fn soap(control: &ControlUrl, action: &str, arguments: &str) -> Result<String, SoapError> {
    let mut body = String::with_capacity(320 + arguments.len() + 2 * action.len());
    let _ = write!(
        body,
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">{arguments}</u:{action}></s:Body></s:Envelope>",
        control.service_type
    );
    let mut request =
        String::with_capacity(256 + control.path.len() + control.host.len() + body.len());
    let _ = write!(
        request,
        "POST {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nUser-Agent: merkur-daemon\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: \"{}#{action}\"\r\nContent-Length: {}\r\n\r\n{body}",
        control.path,
        control.host,
        control.service_type,
        body.len()
    );
    let response = http_exchange(control.address, control.source, request.as_bytes())
        .await
        .ok_or(SoapError::Transport)?;
    let (status, body) = split_response(&response).ok_or(SoapError::Transport)?;
    if status == 200 {
        return Ok(body);
    }
    let code = tag_text(&body, "errorCode")
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or(SoapError::Transport)?;
    Err(SoapError::Upnp(code))
}

/// `GetExternalIPAddress`: the public address this device's WAN side holds.
pub async fn external_address(control: &ControlUrl) -> Result<Ipv4Addr, SoapError> {
    let body = soap(control, "GetExternalIPAddress", "").await?;
    tag_text(&body, "NewExternalIPAddress")
        .and_then(|address| address.parse::<Ipv4Addr>().ok())
        .filter(|address| !address.is_unspecified() && !address.is_loopback())
        .ok_or(SoapError::Transport)
}

/// What `AddPortMapping` granted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Granted {
    pub external_port: u16,
    /// The lease duration the gateway accepted: the one asked for, or 0 when it
    /// grants only permanent leases (renewal then re-asserts the rule).
    pub lease_secs: u32,
}

/// `AddPortMapping` for UDP `internal_port` on `client`, requesting
/// `external_port`.
///
/// Each gateway answer that names its reason gets the one retry that reason
/// allows: 725 (and the 402 some gateways send instead) retries as a permanent
/// lease; 718 retries through `AddAnyPortMapping` on IGDv2, and on a service
/// without it at another unprivileged port, up to `UPNP_CONFLICT_RETRIES`.
pub async fn add_port_mapping(
    control: &ControlUrl,
    client: Ipv4Addr,
    internal_port: u16,
    external_port: u16,
    lease_secs: u32,
) -> Result<Granted, SoapError> {
    let mut lease_secs = lease_secs;
    let mut external_port = external_port;
    let mut conflicts = 0usize;
    loop {
        let arguments = mapping_arguments(client, internal_port, external_port, lease_secs);
        match soap(control, "AddPortMapping", &arguments).await {
            Ok(_) => {
                return Ok(Granted {
                    external_port,
                    lease_secs,
                });
            }
            Err(SoapError::Upnp(ERROR_ONLY_PERMANENT_LEASES | ERROR_INVALID_ARGS))
                if lease_secs != 0 =>
            {
                lease_secs = 0;
            }
            Err(SoapError::Upnp(ERROR_CONFLICT_IN_MAPPING_ENTRY))
                if control.service_type == WAN_IP_CONNECTION_2 =>
            {
                let body = soap(control, "AddAnyPortMapping", &arguments).await?;
                let reserved = tag_text(&body, "NewReservedPort")
                    .and_then(|port| port.parse::<u16>().ok())
                    .filter(|port| *port != 0)
                    .ok_or(SoapError::Transport)?;
                return Ok(Granted {
                    external_port: reserved,
                    lease_secs,
                });
            }
            Err(SoapError::Upnp(ERROR_CONFLICT_IN_MAPPING_ENTRY))
                if conflicts < UPNP_CONFLICT_RETRIES =>
            {
                conflicts += 1;
                external_port = unprivileged_port();
            }
            Err(error) => return Err(error),
        }
    }
}

fn mapping_arguments(client: Ipv4Addr, internal_port: u16, external_port: u16, lease_secs: u32) -> String {
    let mut arguments = String::with_capacity(320);
    let _ = write!(
        arguments,
        "<NewRemoteHost></NewRemoteHost><NewExternalPort>{external_port}</NewExternalPort><NewProtocol>UDP</NewProtocol><NewInternalPort>{internal_port}</NewInternalPort><NewInternalClient>{client}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>Merkur</NewPortMappingDescription><NewLeaseDuration>{lease_secs}</NewLeaseDuration>"
    );
    arguments
}

/// A uniformly chosen port in `FIRST_UNPRIVILEGED_PORT..=u16::MAX`.
fn unprivileged_port() -> u16 {
    let mut bytes = [0u8; 2];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    let span = u32::from(u16::MAX - FIRST_UNPRIVILEGED_PORT) + 1;
    FIRST_UNPRIVILEGED_PORT + (u32::from(u16::from_be_bytes(bytes)) % span) as u16
}

pub async fn delete_port_mapping(
    control: &ControlUrl,
    external_port: u16,
) -> Result<(), SoapError> {
    let mut arguments = String::with_capacity(128);
    let _ = write!(
        arguments,
        "<NewRemoteHost></NewRemoteHost><NewExternalPort>{external_port}</NewExternalPort><NewProtocol>UDP</NewProtocol>"
    );
    soap(control, "DeletePortMapping", &arguments)
        .await
        .map(|_| ())
}

/// IGDv2 `WANIPv6FirewallControl:1` `AddPinhole`: admit UDP from any remote
/// endpoint to `client:port`. Returns the gateway's `UniqueID` for the hole.
pub async fn add_pinhole(
    control: &ControlUrl,
    client: Ipv6Addr,
    internal_port: u16,
    lease_secs: u32,
) -> Result<u16, SoapError> {
    let mut arguments = String::with_capacity(256);
    let _ = write!(
        arguments,
        "<RemoteHost></RemoteHost><RemotePort>0</RemotePort><InternalClient>{client}</InternalClient><InternalPort>{internal_port}</InternalPort><Protocol>17</Protocol><LeaseTime>{lease_secs}</LeaseTime>"
    );
    let body = soap(control, "AddPinhole", &arguments).await?;
    tag_text(&body, "UniqueID")
        .and_then(|id| id.parse::<u16>().ok())
        .ok_or(SoapError::Transport)
}

pub async fn update_pinhole(
    control: &ControlUrl,
    unique_id: u16,
    lease_secs: u32,
) -> Result<(), SoapError> {
    let mut arguments = String::with_capacity(96);
    let _ = write!(
        arguments,
        "<UniqueID>{unique_id}</UniqueID><NewLeaseTime>{lease_secs}</NewLeaseTime>"
    );
    soap(control, "UpdatePinhole", &arguments).await.map(|_| ())
}

pub async fn delete_pinhole(control: &ControlUrl, unique_id: u16) -> Result<(), SoapError> {
    let mut arguments = String::with_capacity(48);
    let _ = write!(arguments, "<UniqueID>{unique_id}</UniqueID>");
    soap(control, "DeletePinhole", &arguments).await.map(|_| ())
}

/// Log helper for the one shape of failure worth an operator's attention: a
/// gateway that speaks the protocol and refuses.
pub fn log_refusal(action: &'static str, error: SoapError) {
    match error {
        SoapError::Upnp(code) => warn!(action, code, "igd: gateway refused"),
        SoapError::Transport => debug!(action, "igd: exchange did not complete"),
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    const DESCRIPTION: &str = r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<URLBase>http://192.168.1.1:5000/</URLBase>
<device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:2</deviceType>
<serviceList>
<service>
<serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
<controlURL>/ctl/L3F</controlURL>
</service>
</serviceList>
<deviceList><device>
<deviceType>urn:schemas-upnp-org:device:WANDevice:2</deviceType>
<deviceList><device>
<deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:2</deviceType>
<serviceList>
<service>
<serviceType>urn:schemas-upnp-org:service:WANIPv6FirewallControl:1</serviceType>
<controlURL>/ctl/IP6FC</controlURL>
</service>
<service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>ctl/IPConn1</controlURL>
</service>
<service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType>
<controlURL>http://192.168.1.1:5000/ctl/IPConn</controlURL>
</service>
</serviceList>
</device></deviceList>
</device></deviceList>
</device>
</root>"#;

    fn location() -> HttpUrl {
        parse_http_url("http://192.168.1.1:1900/rootDesc.xml").unwrap()
    }

    #[test]
    fn the_description_resolves_every_url_form_and_prefers_igdv2() {
        let gateway = parse_description(&location(), DESCRIPTION);
        let wan = gateway.wan.expect("wan service");
        assert_eq!(wan.service_type, WAN_IP_CONNECTION_2, "v2 outranks v1");
        assert_eq!(wan.path, "/ctl/IPConn");
        assert_eq!(wan.address, "192.168.1.1:5000".parse().unwrap());
        let firewall = gateway.firewall6.expect("firewall service");
        assert_eq!(firewall.path, "/ctl/IP6FC");
        assert_eq!(
            firewall.address,
            "192.168.1.1:5000".parse().unwrap(),
            "a root-relative URL resolves against URLBase, not the description's own origin"
        );
        assert_eq!(firewall.host, "192.168.1.1:5000");
    }

    #[test]
    fn a_relative_control_url_without_urlbase_resolves_against_the_description_origin() {
        let body = DESCRIPTION.replace("<URLBase>http://192.168.1.1:5000/</URLBase>", "");
        let gateway = parse_description(&location(), &body);
        let firewall = gateway.firewall6.expect("firewall service");
        assert_eq!(firewall.address, "192.168.1.1:1900".parse().unwrap());
        // `ctl/IPConn1` is relative to the description's directory.
        let body = body.replace(
            "<serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType>",
            "<serviceType>urn:schemas-upnp-org:service:Unknown:9</serviceType>",
        );
        let gateway = parse_description(&location(), &body);
        let wan = gateway.wan.expect("v1 falls in");
        assert_eq!(wan.service_type, WAN_IP_CONNECTION_1);
        assert_eq!(wan.path, "/ctl/IPConn1");
    }

    #[test]
    fn ssdp_and_http_heads_parse_case_insensitively_and_chunked_bodies_unfold() {
        let response = b"HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nLocation: http://10.0.0.1:2869/gatedesc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
        assert_eq!(
            ssdp_location(response),
            Some("http://10.0.0.1:2869/gatedesc.xml")
        );
        assert_eq!(ssdp_location(b"NOTIFY * HTTP/1.1\r\n\r\n"), None);

        let chunked = b"HTTP/1.1 500 Internal Server Error\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n<erro\r\n12\r\nrCode>718</errorCo\r\n3\r\nde>\r\n0\r\n\r\n";
        let (status, body) = split_response(chunked).unwrap();
        assert_eq!(status, 500);
        assert_eq!(tag_text(&body, "errorCode"), Some("718"));
    }

    #[test]
    fn tag_scan_does_not_match_a_longer_tag_name() {
        let xml =
            "<serviceTypeX>wrong</serviceTypeX><serviceType xmlns=\"x\"> right </serviceType>";
        assert_eq!(tag_text(xml, "serviceType"), Some("right"));
        assert_eq!(tag_text("<a></a>", "b"), None);
    }

    /// A fake IGD control endpoint on loopback. `respond` maps the SOAP action
    /// name and request body to a status and response body; every action is
    /// recorded in order. It also serves `GET` for a description, answered with
    /// `description`.
    pub(in super::super) async fn fake_igd(
        description: String,
        respond: impl Fn(&str, &str) -> (u16, String) + Send + Sync + 'static,
    ) -> (SocketAddr, std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = std::sync::Arc::clone(&seen);
        let respond = std::sync::Arc::new(respond);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 16 * 1024];
                let mut len = 0;
                loop {
                    let read = stream.read(&mut buf[len..]).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    len += read;
                    if let Some(head_end) = buf[..len].windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                        let content_length: usize = header_value(&head, "content-length")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);
                        if len >= head_end + 4 + content_length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&buf[..len]).into_owned();
                let (status, body) = if request.starts_with("GET ") {
                    (200, description.clone())
                } else {
                    let action = header_value(&request, "soapaction")
                        .and_then(|value| value.trim_matches('"').rsplit('#').next())
                        .unwrap_or("")
                        .to_string();
                    let body = request
                        .split_once("\r\n\r\n")
                        .map(|(_, body)| body.to_string())
                        .unwrap_or_default();
                    recorded.lock().unwrap().push((action.clone(), body.clone()));
                    respond(&action, &body)
                };
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (address, seen)
    }

    pub(in super::super) fn upnp_error(code: u16) -> (u16, String) {
        (
            500,
            format!("<e><UPnPError><errorCode>{code}</errorCode></UPnPError></e>"),
        )
    }

    fn control(address: SocketAddr, service_type: &'static str) -> ControlUrl {
        ControlUrl {
            source: None,
            address,
            host: address.to_string(),
            path: "/ctl/IPConn".to_string(),
            service_type,
        }
    }

    fn actions(seen: &std::sync::Mutex<Vec<(String, String)>>) -> Vec<String> {
        seen.lock().unwrap().iter().map(|(action, _)| action.clone()).collect()
    }

    /// The SOAP path end to end against a fake gateway: request shape, the
    /// 718 → `AddAnyPortMapping` fallback on IGDv2, and error extraction.
    #[tokio::test]
    async fn a_conflict_on_igdv2_falls_back_to_add_any_port_mapping() {
        let (address, seen) = fake_igd(String::new(), |action, _| match action {
            "AddPortMapping" => upnp_error(718),
            _ => (
                200,
                "<r><u:AddAnyPortMappingResponse><NewReservedPort>51234</NewReservedPort></u:AddAnyPortMappingResponse></r>".into(),
            ),
        })
        .await;
        let granted = add_port_mapping(
            &control(address, WAN_IP_CONNECTION_2),
            Ipv4Addr::new(192, 168, 1, 10),
            44_433,
            44_433,
            3600,
        )
        .await
        .expect("mapped through the fallback");
        assert_eq!(
            granted,
            Granted {
                external_port: 51_234,
                lease_secs: 3600
            }
        );
        assert_eq!(actions(&seen), ["AddPortMapping", "AddAnyPortMapping"]);
    }

    /// A service without `AddAnyPortMapping` answers a conflict by being asked
    /// for another unprivileged port, and a gateway that conflicts with every
    /// port is bounded.
    #[tokio::test]
    async fn a_conflict_on_igdv1_retries_at_another_unprivileged_port() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = std::sync::Arc::clone(&attempts);
        let (address, seen) = fake_igd(String::new(), move |_, _| {
            if counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                upnp_error(718)
            } else {
                (200, String::new())
            }
        })
        .await;
        let granted = add_port_mapping(
            &control(address, WAN_IP_CONNECTION_1),
            Ipv4Addr::new(192, 168, 1, 10),
            44_433,
            44_433,
            3600,
        )
        .await
        .expect("mapped at another port");
        assert!(granted.external_port >= FIRST_UNPRIVILEGED_PORT);
        let recorded = seen.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2);
        assert!(recorded[1].1.contains(&format!(
            "<NewExternalPort>{}</NewExternalPort>",
            granted.external_port
        )));
        assert!(recorded[1].1.contains("<NewInternalPort>44433</NewInternalPort>"));

        let (address, seen) = fake_igd(String::new(), |_, _| upnp_error(718)).await;
        assert_eq!(
            add_port_mapping(
                &control(address, WAN_IP_CONNECTION_1),
                Ipv4Addr::new(192, 168, 1, 10),
                44_433,
                44_433,
                3600,
            )
            .await,
            Err(SoapError::Upnp(718))
        );
        assert_eq!(seen.lock().unwrap().len(), UPNP_CONFLICT_RETRIES + 1);
    }

    /// 725, and the 402 some gateways send instead, retry as a permanent lease;
    /// the grant records that, so renewal asks for the same thing.
    #[tokio::test]
    async fn only_permanent_leases_are_retried_permanent() {
        for code in [ERROR_ONLY_PERMANENT_LEASES, ERROR_INVALID_ARGS] {
            let (address, seen) = fake_igd(String::new(), move |_, body| {
                if body.contains("<NewLeaseDuration>0</NewLeaseDuration>") {
                    (200, String::new())
                } else {
                    upnp_error(code)
                }
            })
            .await;
            let granted = add_port_mapping(
                &control(address, WAN_IP_CONNECTION_1),
                Ipv4Addr::new(192, 168, 1, 10),
                44_433,
                44_433,
                3600,
            )
            .await
            .expect("permanent lease");
            assert_eq!(
                granted,
                Granted {
                    external_port: 44_433,
                    lease_secs: 0
                }
            );
            assert_eq!(seen.lock().unwrap().len(), 2);
        }
    }

    #[tokio::test]
    async fn the_external_address_is_read_and_a_placeholder_is_refused() {
        let (address, _) = fake_igd(String::new(), |_, _| {
            (
                200,
                "<u:GetExternalIPAddressResponse><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse>".into(),
            )
        })
        .await;
        assert_eq!(
            external_address(&control(address, WAN_IP_CONNECTION_2)).await,
            Ok(Ipv4Addr::new(203, 0, 113, 7))
        );
        let (address, _) = fake_igd(String::new(), |_, _| {
            (
                200,
                "<NewExternalIPAddress>0.0.0.0</NewExternalIPAddress>".into(),
            )
        })
        .await;
        assert_eq!(
            external_address(&control(address, WAN_IP_CONNECTION_2)).await,
            Err(SoapError::Transport),
            "an unspecified address is no answer"
        );
    }

    #[test]
    fn an_http_1_0_search_answer_is_accepted_and_a_refusal_is_not() {
        let answer = b"HTTP/1.0 200 OK\r\nLOCATION: http://10.0.0.1:5000/rootDesc.xml\r\n\r\n";
        assert_eq!(ssdp_location(answer), Some("http://10.0.0.1:5000/rootDesc.xml"));
        let refused = b"HTTP/1.1 404 Not Found\r\nLOCATION: http://10.0.0.1/\r\n\r\n";
        assert_eq!(ssdp_location(refused), None);
    }

    /// Real-router descriptions (see `fixtures/NOTICE`): each resolves to the
    /// WAN service a mapping is requested on.
    #[test]
    fn real_router_descriptions_resolve_their_wan_service() {
        let cases: [(&str, &str, &str); 4] = [
            (
                include_str!("fixtures/google-onhub.xml"),
                WAN_IP_CONNECTION_2,
                "/ctl/IPConn",
            ),
            (
                include_str!("fixtures/pfsense.xml"),
                WAN_IP_CONNECTION_1,
                "/ctl/IPConn",
            ),
            (
                include_str!("fixtures/mikrotik.xml"),
                WAN_IP_CONNECTION_1,
                "/upnp/control/yomkmsnooi/wanipconn-1",
            ),
            (
                include_str!("fixtures/huawei-hg531.xml"),
                LEGACY_WAN_PPP_CONNECTION_1,
                "/ctrlt/WANPPPConnection_1",
            ),
        ];
        for (description, service_type, path) in cases {
            let wan = parse_description(&location(), description)
                .wan
                .expect("a WAN service");
            assert_eq!(wan.service_type, service_type);
            assert_eq!(wan.path, path);
        }
    }

    /// Everything on this path parses bytes a LAN device chose. None of it may
    /// panic, whatever arrives.
    #[test]
    fn lan_input_never_panics_the_parsers() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let seeds: [&[u8]; 3] = [
            include_bytes!("fixtures/mikrotik.xml"),
            b"HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.1:5000/d.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n",
            b"HTTP/1.1 500 X\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
        ];
        let mut buf = Vec::with_capacity(4096);
        for round in 0..20_000 {
            buf.clear();
            if round % 2 == 0 {
                let len = (next() % 1500) as usize;
                buf.extend((0..len).map(|_| next() as u8));
            } else {
                let seed = seeds[(next() % seeds.len() as u64) as usize];
                buf.extend_from_slice(seed);
                for _ in 0..(next() % 8) {
                    if buf.is_empty() {
                        break;
                    }
                    let at = (next() % buf.len() as u64) as usize;
                    match next() % 3 {
                        0 => buf[at] = next() as u8,
                        1 => buf.truncate(at),
                        _ => buf.insert(at, next() as u8),
                    }
                }
            }
            let _ = ssdp_location(&buf);
            let _ = split_response(&buf);
            let _ = dechunk(&buf);
            let text = String::from_utf8_lossy(&buf);
            let _ = parse_description(&location(), &text);
            let _ = tag_text(&text, "errorCode");
            if let Some(url) = std::str::from_utf8(&buf).ok().and_then(parse_http_url) {
                let _ = resolve_control_url(&url, None, &text);
            }
        }
    }
}
