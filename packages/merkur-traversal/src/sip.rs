//! Short helper offers with full SIP headers and correlated allocation hints. A quote is never admission authority.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use tokio::io::{Interest, unix::AsyncFd};

/// Resource bound: one helper observation gets the same two-second network
/// exchange budget as admission STUN. Expiry ends observation, not reachability.
pub const OBSERVATION_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);
/// Resource bound: an offer and its quoted headers fit in one ordinary path MTU.
const MAX_QUOTE: usize = 1500;

pub fn offer(local: SocketAddr, media: SocketAddr, browser: IpAddr, nonce: &[u8; 16]) -> Vec<u8> {
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let host = |ip: IpAddr| match ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let family = if media.is_ipv4() { "IP4" } else { "IP6" };
    let ip = media.ip();
    let body = format!(
        "v=0\r\no=m 1 1 IN {family} {ip}\r\ns=m\r\nc=IN {family} {ip}\r\nt=0 0\r\nm=audio {} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n",
        media.port()
    );
    let tag = &nonce[..8];
    let local_host = host(local.ip());
    let remote = host(browser);
    format!("INVITE sip:merkur-{nonce}@{remote} SIP/2.0\r\nVia: SIP/2.0/UDP {local_host}:{};branch=z9hG4bK-{nonce}\r\nFrom: <sip:m@{local_host}>;tag={tag}\r\nTo: <sip:merkur@{remote}>\r\nCall-ID: {nonce}\r\nCSeq: 1 INVITE\r\nContact: <sip:merkur@{local_host}:{}>\r\nMax-Forwards: 1\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{body}", local.port(), local.port(), body.len()).into_bytes()
}

/// Accept complete SDP lines under the exact offer ID, on the separately
/// observed public address. NATs may rewrite headers and quote only part of SDP.
pub fn allocation(payload: &[u8], nonce: &[u8; 16], public: Ipv4Addr) -> Option<SocketAddr> {
    let text = std::str::from_utf8(payload).ok()?;
    let (headers, body) = text.split_once("\r\n\r\n")?;
    if !headers.starts_with("INVITE sip:") {
        return None;
    }
    if !matches_offer(headers, nonce) {
        return None;
    }
    let mut address = None;
    let mut port = None;
    for line in body.split_inclusive("\r\n") {
        let Some(line) = line.strip_suffix("\r\n") else {
            break;
        };
        if let Some(ip) = line.strip_prefix("c=IN IP4 ") {
            if address.replace(ip.parse::<Ipv4Addr>().ok()?).is_some() {
                return None;
            }
        } else if let Some(media) = line.strip_prefix("m=audio ") {
            let (number, format) = media.split_once(' ')?;
            if format != "RTP/AVP 0" || !number.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let number = number.parse::<u16>().ok()?;
            if number == 0 || !number.is_multiple_of(2) || port.replace(number).is_some() {
                return None;
            }
        }
    }
    (address? == public).then_some(SocketAddr::new(IpAddr::V4(public), port?))
}

fn matches_offer(headers: &str, nonce: &[u8; 16]) -> bool {
    let expected: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut ids = headers
        .split("\r\n")
        .filter_map(|line| line.strip_prefix("Call-ID: "));
    let Some(id) = ids.next() else {
        return false;
    };
    ids.next().is_none() && id == expected
}

pub struct Observation {
    socket: AsyncFd<UdpSocket>,
    local: SocketAddr,
    browser: SocketAddr,
}

impl Observation {
    /// Install before sending. Linux reads only this UDP socket's error queue;
    /// Darwin uses its unprivileged ICMP datagram socket and checks the full tuple.
    pub fn new(signal: &UdpSocket, interface: u32, browser: IpAddr) -> io::Result<Self> {
        let local = signal.local_addr()?;
        if !local.is_ipv4() {
            return Err(io::ErrorKind::Unsupported.into());
        }
        #[cfg(target_os = "linux")]
        let (socket, interest) = {
            use std::os::fd::AsRawFd;
            let enabled: libc::c_int = 1;
            // SAFETY: the live UDP descriptor and initialized integer match IP_RECVERR's ABI.
            if unsafe {
                libc::setsockopt(
                    signal.as_raw_fd(),
                    libc::SOL_IP,
                    libc::IP_RECVERR,
                    (&enabled as *const libc::c_int).cast(),
                    libc::socklen_t::try_from(std::mem::size_of_val(&enabled))
                        .map_err(io::Error::other)?,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            let _ = interface;
            (signal.try_clone()?, Interest::ERROR)
        };
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        let (socket, interest) = {
            use std::os::fd::AsRawFd;
            let socket = socket2::Socket::new(
                socket2::Domain::IPV4,
                socket2::Type::DGRAM,
                Some(socket2::Protocol::ICMPV4),
            )?;
            // SAFETY: IP_BOUND_IF reads one initialized interface index from a live socket.
            if unsafe {
                libc::setsockopt(
                    socket.as_raw_fd(),
                    libc::IPPROTO_IP,
                    libc::IP_BOUND_IF,
                    (&interface as *const u32).cast(),
                    libc::socklen_t::try_from(std::mem::size_of_val(&interface))
                        .map_err(io::Error::other)?,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            socket.bind(&SocketAddr::new(local.ip(), 0).into())?;
            (UdpSocket::from(socket), Interest::READABLE)
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
        return Err(io::ErrorKind::Unsupported.into());
        socket.set_nonblocking(true)?;
        // SAFETY: this owned UdpSocket keeps one stable, open descriptor until
        // AsyncFd drops it; no operation replaces or independently closes it.
        let socket = unsafe { AsyncFd::register_with_interest(socket, interest) }
            .map_err(io::Error::from)?;
        Ok(Self {
            socket,
            local,
            browser: SocketAddr::new(browser, 5060),
        })
    }

    pub async fn receive(
        &self,
        nonce: &[u8; 16],
        public: Ipv4Addr,
    ) -> io::Result<Option<SocketAddr>> {
        let mut buffer = [0; MAX_QUOTE];
        loop {
            #[cfg(target_os = "linux")]
            let interest = Interest::ERROR;
            #[cfg(not(target_os = "linux"))]
            let interest = Interest::READABLE;
            let packet = self
                .socket
                .async_io(interest, |socket| self.read(socket, &mut buffer))
                .await?;
            if let Some(length) = packet {
                let payload = &buffer[..length];
                if std::str::from_utf8(payload)
                    .ok()
                    .is_some_and(|text| matches_offer(text, nonce))
                {
                    return Ok(allocation(payload, nonce, public));
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn read(&self, socket: &UdpSocket, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        use std::os::fd::AsRawFd;
        // Ancillary storage is aligned for cmsghdr and sock_extended_err.
        let mut control = [0usize; 16];
        // SAFETY: an all-zero sockaddr_in is initialized storage for recvmsg to fill.
        let mut destination: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        let mut vector = libc::iovec {
            iov_base: buffer.as_mut_ptr().cast(),
            iov_len: buffer.len(),
        };
        // SAFETY: zero initializes the optional msghdr pointers and flags before assigning buffers.
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_name = (&mut destination as *mut libc::sockaddr_in).cast();
        message.msg_namelen = libc::socklen_t::try_from(std::mem::size_of_val(&destination))
            .map_err(io::Error::other)?;
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control);
        // SAFETY: every writable pointer names live, sized storage for this synchronous syscall.
        let length = unsafe {
            libc::recvmsg(
                socket.as_raw_fd(),
                &mut message,
                libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT,
            )
        };
        if length < 0 {
            return Err(io::Error::last_os_error());
        }
        if message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
            || destination.sin_family != libc::AF_INET as u16
            || Ipv4Addr::from(destination.sin_addr.s_addr.to_ne_bytes()) != self.browser.ip()
            || u16::from_be(destination.sin_port) != self.browser.port()
        {
            return Ok(None);
        }
        let error_size = u32::try_from(std::mem::size_of::<libc::sock_extended_err>())
            .map_err(io::Error::other)?;
        // SAFETY: the fixed error structure fits CMSG_LEN's length argument.
        let required = unsafe { libc::CMSG_LEN(error_size) } as usize;
        // SAFETY: recvmsg initialized message's control buffer and returned its valid length.
        let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        // SAFETY: each nonnull pointer comes from libc's traversal of that same live buffer.
        while let Some(fields) = unsafe { header.as_ref() } {
            if fields.cmsg_level == libc::SOL_IP
                && fields.cmsg_type == libc::IP_RECVERR
                && fields.cmsg_len >= required
            {
                // SAFETY: this initialized control message contains the checked error structure.
                let data = unsafe { libc::CMSG_DATA(header) };
                // SAFETY: the checked payload holds a complete error, without assuming alignment.
                let error = unsafe { data.cast::<libc::sock_extended_err>().read_unaligned() };
                if error.ee_origin == libc::SO_EE_ORIGIN_ICMP
                    && error.ee_type == 3
                    && error.ee_code == 3
                {
                    let _ = self.local;
                    return Ok(Some(usize::try_from(length).map_err(io::Error::other)?));
                }
            }
            // SAFETY: header and message still refer to the same initialized control buffer.
            header = unsafe { libc::CMSG_NXTHDR(&message, header) };
        }
        Ok(None)
    }

    #[cfg(not(target_os = "linux"))]
    fn read(&self, socket: &UdpSocket, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        let (length, _) = socket.recv_from(buffer)?;
        let Some(payload) = quoted_payload(&buffer[..length], self.local, self.browser) else {
            return Ok(None);
        };
        let start = length - payload.len();
        buffer.copy_within(start..length, 0);
        Ok(Some(length - start))
    }
}

#[cfg(any(test, not(target_os = "linux")))]
fn quoted_payload(packet: &[u8], local: SocketAddr, browser: SocketAddr) -> Option<&[u8]> {
    if packet.first()? >> 4 != 4 {
        return None;
    }
    let outer = usize::from(packet[0] & 15) * 4;
    if outer < 20 || packet.get(9) != Some(&1) || packet.get(outer..outer + 2)? != [3, 3] {
        return None;
    }
    let inner = packet.get(outer + 8..)?;
    if inner.first()? >> 4 != 4 {
        return None;
    }
    let ihl = usize::from(inner[0] & 15) * 4;
    if ihl < 20 || inner.get(9) != Some(&17) || inner.get(6)? & 0x1f != 0 || *inner.get(7)? != 0 {
        return None;
    }
    let (IpAddr::V4(source), IpAddr::V4(destination)) = (local.ip(), browser.ip()) else {
        return None;
    };
    if inner.get(12..16)? != source.octets() || inner.get(16..20)? != destination.octets() {
        return None;
    }
    let udp = inner.get(ihl..)?;
    if udp.get(..2)? != local.port().to_be_bytes() || udp.get(2..4)? != browser.port().to_be_bytes()
    {
        return None;
    }
    let length = usize::from(u16::from_be_bytes(udp.get(4..6)?.try_into().ok()?));
    if length < 8 {
        return None;
    }
    udp.get(8..length.min(udp.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "requires an explicitly owned router and external experiment peer"]
    async fn physical_router_sip_observation() {
        let local: Ipv4Addr = std::env::var("MERKUR_SIP_TEST_LOCAL")
            .unwrap()
            .parse()
            .unwrap();
        let public: Ipv4Addr = std::env::var("MERKUR_SIP_TEST_PUBLIC")
            .unwrap()
            .parse()
            .unwrap();
        let browser: IpAddr = std::env::var("MERKUR_SIP_TEST_PEER")
            .unwrap()
            .parse()
            .unwrap();
        // SAFETY: the static C string is NUL-terminated and lives through this call.
        let interface = unsafe { libc::if_nametoindex(c"en0".as_ptr()) };
        assert_ne!(interface, 0);
        for trial in 0..3 {
            let (media, _companion) = loop {
                let media = UdpSocket::bind((local, 0)).unwrap();
                let port = media.local_addr().unwrap().port();
                if port.is_multiple_of(2)
                    && let Ok(companion) = UdpSocket::bind((local, port + 1))
                {
                    break (media, companion);
                }
            };
            let signal = UdpSocket::bind((local, 0)).unwrap();
            let observation = Observation::new(&signal, interface, browser).unwrap();
            let mut nonce = [0; 16];
            ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce).unwrap();
            let payload = offer(
                signal.local_addr().unwrap(),
                media.local_addr().unwrap(),
                browser,
                &nonce,
            );
            let began = std::time::Instant::now();
            signal
                .send_to(&payload, SocketAddr::new(browser, 5060))
                .unwrap();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                observation.receive(&nonce, public),
            )
            .await;
            let status = match result {
                Ok(Ok(Some(_))) => "observed_allocation",
                Ok(Ok(None)) => "matched_quote_without_accepted_allocation",
                Ok(Err(_)) => "receive_error",
                Err(_) => "no_matching_quote_within_budget",
            };
            println!(
                "MERKUR_SIP_OBSERVATION trial={trial} status={status} payload_bytes={} elapsed_ms={:.3}",
                payload.len(),
                began.elapsed().as_secs_f64() * 1000.0
            );
        }
    }

    #[test]
    fn an_icmp_quote_must_match_the_owned_signaling_tuple_and_cannot_be_a_fragment() {
        let local = "10.10.0.2:33000".parse().unwrap();
        let peer = "198.51.100.2:5060".parse().unwrap();
        let mut packet = vec![0; 56];
        packet[0] = 0x45;
        packet[9] = 1;
        packet[20] = 3;
        packet[21] = 3;
        packet[28] = 0x45;
        packet[37] = 17;
        packet[40..44].copy_from_slice(&[10, 10, 0, 2]);
        packet[44..48].copy_from_slice(&[198, 51, 100, 2]);
        packet[48..50].copy_from_slice(&33000u16.to_be_bytes());
        packet[50..52].copy_from_slice(&5060u16.to_be_bytes());
        packet.extend_from_slice(b"quoted offer");
        let length = u16::try_from(packet.len() - 48).unwrap();
        packet[52..54].copy_from_slice(&length.to_be_bytes());
        assert_eq!(
            quoted_payload(&packet, local, peer),
            Some(b"quoted offer".as_slice())
        );
        assert_eq!(
            quoted_payload(&packet, "10.10.0.2:33001".parse().unwrap(), peer),
            None
        );
        assert_eq!(
            quoted_payload(&packet, local, "198.51.100.3:5060".parse().unwrap()),
            None
        );
        for size in 0..56 {
            assert_eq!(quoted_payload(&packet[..size], local, peer), None);
        }
        packet[35] = 1;
        assert_eq!(quoted_payload(&packet, local, peer), None);
    }

    #[test]
    fn a_quote_names_only_a_complete_correlated_media_tuple_on_the_observed_address() {
        let nonce = [0x42; 16];
        let public = "198.51.100.1".parse().unwrap();
        let endpoint = "198.51.100.1:45002".parse().unwrap();
        let packet = offer(
            "198.51.100.1:33000".parse().unwrap(),
            endpoint,
            "198.51.100.2".parse().unwrap(),
            &nonce,
        );
        let longest = offer(
            "123.123.123.123:65534".parse().unwrap(),
            "123.123.123.123:65534".parse().unwrap(),
            "123.123.123.124".parse().unwrap(),
            &nonce,
        );
        let last_media = b"m=audio 65534 RTP/AVP 0\r\n";
        let longest_required = longest
            .windows(last_media.len())
            .position(|bytes| bytes == last_media)
            .unwrap()
            + last_media.len();
        assert!(longest_required <= 520);
        let text = std::str::from_utf8(&packet).unwrap();
        assert!(text.starts_with(&format!("INVITE sip:merkur-{}@", "42".repeat(16))));
        assert!(text.contains(&format!(";tag={}\r\n", "42".repeat(4))));
        let other_offer = offer(
            "10.0.0.2:40000".parse().unwrap(),
            endpoint,
            "198.51.100.2".parse().unwrap(),
            &[0x43; 16],
        );
        assert!(
            std::str::from_utf8(&other_offer)
                .unwrap()
                .contains(&format!(";tag={}\r\n", "43".repeat(4)))
        );
        assert_eq!(allocation(&packet, &nonce, public), Some(endpoint));
        assert_eq!(allocation(&packet, &[0x43; 16], public), None);
        assert_eq!(allocation(&packet, &nonce, Ipv4Addr::LOCALHOST), None);
        let line = b"m=audio 45002 RTP/AVP 0\r\n";
        let media_end = packet
            .windows(line.len())
            .position(|bytes| bytes == line)
            .unwrap()
            + line.len();
        for size in 0..media_end {
            assert_eq!(allocation(&packet[..size], &nonce, public), None);
        }
        for size in media_end..=packet.len() {
            assert_eq!(allocation(&packet[..size], &nonce, public), Some(endpoint));
        }
        let duplicate = [packet.as_slice(), b"m=audio 45004 RTP/AVP 0\r\n"].concat();
        assert_eq!(allocation(&duplicate, &nonce, public), None);
        let odd = String::from_utf8(packet).unwrap().replace("45002", "45003");
        assert_eq!(allocation(odd.as_bytes(), &nonce, public), None);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn an_unprivileged_udp_error_queue_returns_the_original_offer_without_reading_quic() {
        let destination = UdpSocket::bind("127.0.0.1:0").unwrap();
        let peer = destination.local_addr().unwrap();
        drop(destination);
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let mut observation = Observation::new(&socket, 0, peer.ip()).unwrap();
        observation.browser = peer;
        let nonce = [0x24; 16];
        let endpoint = "127.0.0.1:45000".parse().unwrap();
        let packet = offer(socket.local_addr().unwrap(), endpoint, peer.ip(), &nonce);
        socket.send_to(&packet, peer).unwrap();
        assert_eq!(
            tokio::time::timeout(
                OBSERVATION_BUDGET,
                observation.receive(&nonce, Ipv4Addr::LOCALHOST)
            )
            .await
            .unwrap()
            .unwrap(),
            Some(endpoint)
        );
    }
}
