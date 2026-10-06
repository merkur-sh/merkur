//! Send-only side channel on quinn's own UDP socket.
//!
//! Live-socket STUN discovers the mapping through the authenticated receive
//! demultiplexer. This handle refreshes idle NAT state and sends inert punches
//! toward the authenticated browser address. It never reads: quinn and the
//! discovery demultiplexer remain the sole owners of the receive queue.
//!
//! `try_clone` duplicates the descriptor, not the socket. There is no second
//! bind or SO_REUSEPORT receive queue to split QUIC traffic. The traversal
//! owner grants bounded blocking-pool batches; this module owns packet budgets.
//! Mapping keepalives ride the existing heartbeat.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tracing::debug;

use super::{AddressClass, classify_ip};

/// One zero byte: too short for a QUIC packet or STUN message. Our endpoints
/// discard it without a response; no receiving loop or handshake is needed.
/// Packet counters provide diagnostics without embedding a payload signature.
const INERT_PAYLOAD: [u8; 1] = [0x00];

/// Resource bound derived from the cooldown table: every remembered
/// destination may take one full punch per `PER_DEST_COOLDOWN`, so the burst
/// holds one punch for each slot and the refill sustains exactly that rate
/// (32 × 4 packets per 500 ms). Keepalives draw from the same bucket.
const TOKEN_BURST: u64 = (COOLDOWN_SLOTS * PUNCH_PORTS * PACKETS_PER_PORT) as u64;
const TOKEN_RATE_PER_SEC: u64 = TOKEN_BURST * 1000 / PER_DEST_COOLDOWN.as_millis() as u64;

/// Minimum gap between bursts aimed at one address.
const PER_DEST_COOLDOWN: Duration = Duration::from_millis(500);

/// Destinations the cooldown remembers. Bounded by the number of browsers
/// that can be mid-offer at once, which is a handful; a fixed table makes the
/// check a short linear scan with no allocation, where a map grew on every new
/// address and rehashed on the way.
const COOLDOWN_SLOTS: usize = 32;

/// Datagrams per burst, per destination port, for the adjacent-port punch.
const PACKETS_PER_PORT: usize = 2;

/// Destination ports per punch: the length of [`punch_ports`].
const PUNCH_PORTS: usize = 2;

#[derive(Debug, Default)]
pub struct SideChannelStats {
    pub packets_sent: AtomicU64,
    pub send_would_block: AtomicU64,
    pub send_failed: AtomicU64,
    pub keepalives_sent: AtomicU64,
    pub bursts_sent: AtomicU64,
    pub refused_not_global: AtomicU64,
    pub refused_rate_limited: AtomicU64,
}

/// A plain, non-atomic copy of [`SideChannelStats`] for the telemetry path.
///
/// The counters stay `AtomicU64` on the live struct; this exists so the periodic
/// snapshot is one pass rather than seven scattered `Relaxed` loads at each
/// call site, and so the field set is a type the IPC layer can be pinned to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SideChannelStatsSnapshot {
    pub packets_sent: u64,
    pub send_would_block: u64,
    pub send_failed: u64,
    pub keepalives_sent: u64,
    pub bursts_sent: u64,
    pub refused_not_global: u64,
    pub refused_rate_limited: u64,
}

impl SideChannelStats {
    pub fn snapshot(&self) -> SideChannelStatsSnapshot {
        SideChannelStatsSnapshot {
            packets_sent: self.packets_sent.load(Ordering::Relaxed),
            send_would_block: self.send_would_block.load(Ordering::Relaxed),
            send_failed: self.send_failed.load(Ordering::Relaxed),
            keepalives_sent: self.keepalives_sent.load(Ordering::Relaxed),
            bursts_sent: self.bursts_sent.load(Ordering::Relaxed),
            refused_not_global: self.refused_not_global.load(Ordering::Relaxed),
            refused_rate_limited: self.refused_rate_limited.load(Ordering::Relaxed),
        }
    }
}

/// Why a punch was not attempted. Recorded rather than silently dropped so the
/// win rate stays attributable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PunchRefusal {
    /// A private, CGNAT, ULA, loopback or link-local browser address. Same-NAT,
    /// where a LAN host candidate already wins — punching there would add
    /// nothing and would be an internal-scan primitive.
    NotGloballyRoutable,
    /// Global token bucket or the per-destination cooldown.
    RateLimited,
}

struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new() -> Self {
        Self {
            tokens: TOKEN_BURST as f64,
            last_refill: Instant::now(),
        }
    }

    fn try_take(&mut self, want: u64) -> bool {
        let now = Instant::now();
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.last_refill = now;
        self.tokens = (self.tokens + elapsed * TOKEN_RATE_PER_SEC as f64).min(TOKEN_BURST as f64);
        if self.tokens >= want as f64 {
            self.tokens -= want as f64;
            true
        } else {
            false
        }
    }
}

/// A send-only handle on the socket quinn is using.
pub struct SideChannel {
    socket: UdpSocket,
    /// Whether the socket is AF_INET6. Quinn binds `[::]` dual-stack, so an
    /// IPv4 destination has to be handed over v4-mapped; passing a bare
    /// `SocketAddr::V4` to `send_to` on an AF_INET6 socket fails with `EINVAL`.
    /// That failure is silent — a best-effort send counts an error and moves on
    /// — so without this every IPv4 punch and keepalive would be a dead feature
    /// that every gate still passed. Caught by
    /// `a_side_channel_send_uses_quinns_port_and_leaves_the_session_intact`.
    is_ipv6: bool,
    stats: SideChannelStats,
    bucket: Mutex<TokenBucket>,
    last_burst: Mutex<CooldownTable>,
}

/// Per-destination burst timestamps in fixed slots. A full table evicts the
/// oldest entry: it is older than the cooldown by construction whenever more
/// than `COOLDOWN_SLOTS` distinct browsers were offered inside one window.
struct CooldownTable {
    slots: [Option<(IpAddr, Instant)>; COOLDOWN_SLOTS],
}

impl CooldownTable {
    const fn new() -> Self {
        Self {
            slots: [None; COOLDOWN_SLOTS],
        }
    }

    /// Admit a burst to `dest` at `now`, recording it, or refuse because the
    /// previous burst is still inside the cooldown.
    fn admit(&mut self, dest: IpAddr, now: Instant) -> bool {
        let mut free: Option<usize> = None;
        let mut oldest: (usize, Instant) = (0, now);
        for (index, slot) in self.slots.iter_mut().enumerate() {
            match slot {
                Some((held, at)) if *held == dest => {
                    if now.saturating_duration_since(*at) < PER_DEST_COOLDOWN {
                        return false;
                    }
                    *at = now;
                    return true;
                }
                Some((_, at)) => {
                    if *at < oldest.1 {
                        oldest = (index, *at);
                    }
                }
                None => {
                    if free.is_none() {
                        free = Some(index);
                    }
                }
            }
        }
        let index = free.unwrap_or(oldest.0);
        self.slots[index] = Some((dest, now));
        true
    }
}

impl std::fmt::Debug for SideChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SideChannel")
            .field("local_addr", &self.socket.local_addr().ok())
            .finish_non_exhaustive()
    }
}

impl SideChannel {
    /// `socket` must be a `try_clone` of the socket handed to quinn, never an
    /// independently bound one — the whole point is that it shares quinn's
    /// 4-tuple and therefore its NAT mapping.
    pub fn new(socket: UdpSocket) -> std::io::Result<Self> {
        // Shares a file description with quinn's socket, so quinn's own
        // `set_nonblocking` already applies. Setting it explicitly makes the
        // send path's `WouldBlock` handling unconditional rather than
        // dependent on initialization order.
        socket.set_nonblocking(true)?;
        let is_ipv6 = socket.local_addr()?.is_ipv6();
        let bucket = Mutex::new(TokenBucket::new());
        let last_burst = Mutex::new(CooldownTable::new());
        // On Apple targets `std::sync::Mutex` boxes its pthread mutex lazily on
        // the first lock (64 bytes, once per mutex for the process). Take that
        // here, at construction, so the first punch on the offer path is as
        // allocation-free as every later one; Linux uses a futex and never
        // allocates. `a_punch_performs_no_heap_allocation` pins this.
        drop(bucket.lock());
        drop(last_burst.lock());
        Ok(Self {
            socket,
            is_ipv6,
            stats: SideChannelStats::default(),
            bucket,
            last_burst,
        })
    }

    /// Put a destination into the form this socket's family can actually send to.
    fn normalize(&self, dst: SocketAddr) -> SocketAddr {
        match dst {
            SocketAddr::V4(v4) if self.is_ipv6 => {
                SocketAddr::new(IpAddr::V6(v4.ip().to_ipv6_mapped()), v4.port())
            }
            other => other,
        }
    }

    pub fn stats(&self) -> &SideChannelStats {
        &self.stats
    }

    /// Test-only: the assertion that this shares quinn's port is the whole
    /// point of the design, so it needs a way to read it.
    #[cfg(test)]
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.socket.local_addr().ok()
    }

    /// One datagram, best effort.
    ///
    /// Single attempt by design. Retrying — or worse, registering for write
    /// readiness — would contend with quinn's driver for the same socket. The
    /// next scheduled send is the retry.
    fn send_one(&self, dst: SocketAddr) -> bool {
        let dst = self.normalize(dst);
        match self.socket.send_to(&INERT_PAYLOAD, dst) {
            Ok(_) => {
                self.stats.packets_sent.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                self.stats.send_would_block.fetch_add(1, Ordering::Relaxed);
                false
            }
            Err(error) => {
                self.stats.send_failed.fetch_add(1, Ordering::Relaxed);
                debug!("side-channel send to {dst} failed: {error}");
                false
            }
        }
    }

    /// Refresh the NAT mapping by sending one inert datagram to a STUN vantage
    /// point.
    ///
    /// The vantage point is chosen because it is known to silently drop
    /// anything that is not a valid, authenticated STUN message — so this
    /// refreshes the binding and provokes no reply. It also works while the STUN
    /// ticket is expired, which matters: the mapping must not be allowed to
    /// lapse merely because a ticket rotated late.
    pub fn keepalive(&self, vantage: SocketAddr) {
        if !self.take_tokens(1) {
            return;
        }
        self.stats.keepalives_sent.fetch_add(1, Ordering::Relaxed);
        self.send_one(vantage);
    }

    /// Open this daemon's own NAT/firewall filter state toward `browser_ip`.
    ///
    /// An address-restricted NAT admits inbound from any port of an address it
    /// has already sent to, so this is what lets the browser's unsolicited QUIC
    /// Initial through. A **port**-restricted NAT additionally needs the
    /// browser's future ephemeral source port, which is unknowable, and a
    /// symmetric NAT cannot work at all — the advertised external port is not
    /// the one the browser would reach. Both are out of scope for this
    /// mechanism; see the caller's eligibility gate.
    ///
    /// Deliberately not a port spray. That is often described as a birthday
    /// paradox, which it is not: the paradox needs *both* sides drawing from the
    /// space, whereas here the daemon sprays `k` ports and the browser draws at
    /// most one per candidate it dials. Collision probability is therefore
    /// linear (~`5k/N`), not quadratic — 256 packets against a ~28 000-port
    /// ephemeral range buys about 4.5% while reading as a port scan to any IDS.
    pub fn punch(&self, browser_ip: IpAddr, ports: &[u16]) -> Result<usize, PunchRefusal> {
        if !is_globally_routable(&browser_ip) {
            self.stats
                .refused_not_global
                .fetch_add(1, Ordering::Relaxed);
            return Err(PunchRefusal::NotGloballyRoutable);
        }

        let wanted = (ports.len() * PACKETS_PER_PORT) as u64;
        if !self.check_dest_cooldown(browser_ip) || !self.take_tokens(wanted) {
            self.stats
                .refused_rate_limited
                .fetch_add(1, Ordering::Relaxed);
            return Err(PunchRefusal::RateLimited);
        }

        let mut sent = 0usize;
        for &port in ports {
            for _ in 0..PACKETS_PER_PORT {
                self.send_one(SocketAddr::new(browser_ip, port));
                sent += 1;
            }
        }
        self.stats.bursts_sent.fetch_add(1, Ordering::Relaxed);
        Ok(sent)
    }

    fn take_tokens(&self, want: u64) -> bool {
        match self.bucket.lock() {
            Ok(mut bucket) => bucket.try_take(want),
            // A poisoned bucket must not become an unbounded send path.
            Err(_) => false,
        }
    }

    fn check_dest_cooldown(&self, dest: IpAddr) -> bool {
        match self.last_burst.lock() {
            Ok(mut table) => table.admit(dest, Instant::now()),
            // A poisoned table must not become an unbounded send path.
            Err(_) => false,
        }
    }
}

/// Hard off switch, mirroring `MERKUR_DISABLE_WT_UPGRADE`.
///
/// Read once: the environment cannot change under a running process, and
/// `env::var` allocates on every call. This one sits on the manifest path, which
/// runs per peer per session and again on every change of candidates or address.
pub fn punch_disabled() -> bool {
    static DISABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DISABLED.get_or_init(|| {
        std::env::var_os("MERKUR_DISABLE_NAT_PUNCH").is_some_and(|value| value == "1")
    })
}

/// Only globally routable unicast addresses are punchable.
///
/// A private, CGNAT or ULA `browser_ip` means the browser shares this daemon's
/// network, where a LAN host candidate already wins outright. Punching there
/// would buy nothing and would turn the daemon into an internal-scan primitive.
pub fn is_globally_routable(ip: &IpAddr) -> bool {
    if ip.is_loopback() || ip.is_multicast() || ip.is_unspecified() {
        return false;
    }
    matches!(
        classify_ip(ip),
        AddressClass::Ipv4Global | AddressClass::Ipv6Global
    )
}

/// Destination ports for a punch burst: the daemon's own pinned port, plus one
/// adjacent so a single policed or lost packet does not lose the whole burst.
///
/// Semantically defensible ("I am talking to you about WebTransport") and near
/// certainly closed on a browser host, which is what keeps this from looking
/// like reconnaissance.
pub fn punch_ports(daemon_port: u16) -> [u16; PUNCH_PORTS] {
    [daemon_port, daemon_port.saturating_add(1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dual-stack, matching how quinn binds. Binding v4 here would hide the
    /// v4-mapped requirement that `normalize` exists for.
    fn loopback_channel() -> SideChannel {
        let socket = UdpSocket::bind("[::]:0").expect("bind test socket");
        SideChannel::new(socket).expect("side channel")
    }

    #[test]
    fn private_and_cgnat_browser_addresses_are_never_punched() {
        for addr in [
            "192.168.1.10",
            "10.0.0.4",
            "172.16.101.48",
            "100.64.0.5",
            "127.0.0.1",
        ] {
            assert!(
                !is_globally_routable(&addr.parse().unwrap()),
                "{addr} must not be punchable"
            );
        }
        assert!(!is_globally_routable(&"fd00::1".parse().unwrap()));
        assert!(!is_globally_routable(&"fe80::1".parse().unwrap()));
    }

    #[test]
    fn global_addresses_are_punchable() {
        assert!(is_globally_routable(&"152.233.43.33".parse().unwrap()));
        assert!(is_globally_routable(&"2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn a_private_destination_is_refused_before_any_packet_leaves() {
        let channel = loopback_channel();
        let outcome = channel.punch("192.168.1.10".parse().unwrap(), &punch_ports(44433));

        assert_eq!(outcome, Err(PunchRefusal::NotGloballyRoutable));
        assert_eq!(channel.stats().packets_sent.load(Ordering::Relaxed), 0);
    }

    /// Carrier pools are wider than /24, so a browser's public address can end
    /// in `.0` or `.255` and is still a host.
    #[test]
    fn a_public_browser_address_ending_in_0_or_255_is_punched() {
        let channel = loopback_channel();
        for browser in ["198.51.100.0", "198.51.100.255"] {
            assert_eq!(
                channel.punch(browser.parse().unwrap(), &punch_ports(44433)),
                Ok(4),
                "{browser}"
            );
        }
    }

    #[test]
    fn a_second_burst_to_one_address_is_refused_by_the_cooldown() {
        let channel = loopback_channel();
        let target: IpAddr = "203.0.113.9".parse().unwrap();

        let first = channel.punch(target, &punch_ports(44433));
        assert_eq!(first, Ok(4));

        let second = channel.punch(target, &punch_ports(44433));
        assert_eq!(second, Err(PunchRefusal::RateLimited));
        // The refusal must not have cost packets.
        assert_eq!(channel.stats().packets_sent.load(Ordering::Relaxed), 4);
    }

    /// The bucket holds exactly one punch per cooldown slot: that many distinct
    /// browsers are punched back to back, and the next is refused until refill.
    #[test]
    fn the_token_bucket_holds_one_punch_per_cooldown_slot() {
        let channel = loopback_channel();
        for host in 1..=COOLDOWN_SLOTS {
            let target: IpAddr = format!("203.0.113.{host}").parse().unwrap();
            assert_eq!(channel.punch(target, &punch_ports(44433)), Ok(4), "{host}");
        }
        let extra: IpAddr = "203.0.113.200".parse().unwrap();
        assert_eq!(
            channel.punch(extra, &punch_ports(44433)),
            Err(PunchRefusal::RateLimited)
        );
    }

    /// Runs on the offer path's blocking batch; the bucket, the cooldown table
    /// and the sends all use stack state.
    #[test]
    fn a_punch_performs_no_heap_allocation() {
        let channel = loopback_channel();
        let target: IpAddr = "203.0.113.77".parse().unwrap();
        crate::edge_tunnel::test_allocations::begin_thread();
        let sent = channel.punch(target, &punch_ports(44433));
        let refused = channel.punch(target, &punch_ports(44433));
        let tally = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(sent, Ok(4));
        assert_eq!(refused, Err(PunchRefusal::RateLimited));
        assert_eq!(
            tally.allocations, 0,
            "punch allocated {} times / {} bytes",
            tally.allocations, tally.allocated_bytes
        );
    }

    /// The cooldown table admits a fresh address, refuses the same one inside
    /// the window, and evicts the oldest entry rather than growing.
    #[test]
    fn the_cooldown_table_is_fixed_size_and_evicts_the_oldest() {
        let mut table = CooldownTable::new();
        let base = Instant::now();
        for host in 0..COOLDOWN_SLOTS {
            let ip: IpAddr = format!("203.0.113.{host}").parse().unwrap();
            assert!(table.admit(ip, base + Duration::from_millis(host as u64)));
        }
        let first: IpAddr = "203.0.113.0".parse().unwrap();
        assert!(
            !table.admit(first, base + Duration::from_millis(100)),
            "inside the cooldown"
        );
        // A 33rd address evicts the oldest (host 0), which is then admitted
        // again as a new entry.
        let extra: IpAddr = "203.0.113.200".parse().unwrap();
        assert!(table.admit(extra, base + Duration::from_millis(200)));
        assert!(table.admit(first, base + Duration::from_millis(201)));
        assert!(
            table.admit(first, base + PER_DEST_COOLDOWN + Duration::from_millis(300)),
            "past the cooldown the same address is admitted again"
        );
    }

    #[test]
    fn an_ipv4_destination_is_sent_v4_mapped_from_a_dual_stack_socket() {
        let channel = loopback_channel();
        let scratch = UdpSocket::bind("127.0.0.1:0").expect("scratch bind");
        scratch
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");

        channel.keepalive(scratch.local_addr().expect("scratch addr"));

        let mut buf = [0u8; 4];
        let (len, _) = scratch
            .recv_from(&mut buf)
            .expect("an IPv4 destination must be reachable from the dual-stack socket");
        assert_eq!(len, 1);
        assert_eq!(buf[0], 0x00);
        assert_eq!(channel.stats().send_failed.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn punch_ports_never_wrap_past_the_port_space() {
        assert_eq!(punch_ports(44433), [44433, 44434]);
        assert_eq!(punch_ports(u16::MAX), [u16::MAX, u16::MAX]);
    }
}
