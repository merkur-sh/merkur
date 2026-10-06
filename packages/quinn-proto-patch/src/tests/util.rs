use std::{
    cell::RefCell,
    cmp,
    collections::{HashMap, HashSet, VecDeque},
    env,
    io::{self, Write},
    mem,
    net::{Ipv6Addr, SocketAddr, UdpSocket},
    ops::RangeFrom,
    rc::Rc,
    str,
    sync::{Arc, Mutex},
};

use assert_matches::assert_matches;
use bytes::BytesMut;
use lazy_static::lazy_static;
use rustls::{
    KeyLogFile,
    client::WebPkiServerVerifier,
    pki_types::{CertificateDer, PrivateKeyDer},
};
use tracing::{info_span, trace};

use super::crypto::rustls::{QuicClientConfig, QuicServerConfig, configured_provider};
use super::*;
use crate::{Duration, Instant};

pub(super) const DEFAULT_MTU: usize = 1452;

/// IPv6 and UDP headers: what a datagram occupies on a link beyond its payload.
pub(super) const LINK_HEADER_BYTES: u64 = 48;

/// One direction of a simulated bottleneck on the pairs' virtual clock: a
/// drop-tail FIFO of `rate_bps` behind `buffer_bytes`, then a seeded exact-rate
/// loss site and optional CE marking. A packet of `L` bytes (payload plus
/// `LINK_HEADER_BYTES`) arriving at `t` finds `max(0, busy_until − t)·R/8`
/// bytes ahead, is dropped when that and `L` exceed the buffer, and otherwise
/// departs at `max(t, busy_until) + 8L/R`. A packet the loss site takes still
/// occupied the link. Several pairs can share one link, so a group's members
/// queue behind each other.
pub(super) struct Link {
    rate_bps: u64,
    buffer_bytes: u64,
    busy_until: Option<Instant>,
    loss_percent: u64,
    loss_seed: u64,
    /// CE-mark a packet that finds more than this many bytes ahead.
    ce_above: Option<u64>,
    sequence: u64,
    pub(super) bottleneck_drops: u64,
    pub(super) lost_after_link: u64,
    pub(super) departed_bytes: u64,
    pub(super) ce_marked: u64,
    pub(super) log: Vec<LinkRecord>,
}

/// One packet that crossed a link.
#[derive(Clone, Copy, Debug)]
pub(super) struct LinkRecord {
    pub(super) source: u8,
    pub(super) arrival: Instant,
    pub(super) residence: Duration,
    pub(super) bytes: u64,
    pub(super) delivered: bool,
}

impl Link {
    pub(super) fn new(rate_bps: u64, buffer_bytes: u64) -> Self {
        Self {
            rate_bps,
            buffer_bytes,
            busy_until: None,
            loss_percent: 0,
            loss_seed: 0,
            ce_above: None,
            sequence: 0,
            bottleneck_drops: 0,
            lost_after_link: 0,
            departed_bytes: 0,
            ce_marked: 0,
            log: Vec::new(),
        }
    }

    /// Exactly `percent` of every 100 packets behind the link, chosen by `seed`.
    pub(super) fn with_loss(mut self, percent: u64, seed: u64) -> Self {
        self.loss_percent = percent;
        self.loss_seed = seed;
        self
    }

    pub(super) fn with_ce_above(mut self, bytes: u64) -> Self {
        self.ce_above = Some(bytes);
        self
    }

    pub(super) fn shared(self) -> Rc<RefCell<Self>> {
        Rc::new(RefCell::new(self))
    }

    /// Later services run at `rate_bps`; packets already in service keep theirs.
    pub(super) fn set_rate(&mut self, rate_bps: u64) {
        self.rate_bps = rate_bps;
    }

    pub(super) fn rate_bps(&self) -> u64 {
        self.rate_bps
    }

    /// Admits a `payload`-byte datagram at `t`: its departure and whether it
    /// was CE-marked, or `None` when the buffer or the loss site took it.
    fn admit(&mut self, t: Instant, payload: usize, source: u8) -> Option<(Instant, bool)> {
        let bytes = payload as u64 + LINK_HEADER_BYTES;
        let ahead = match self.busy_until {
            Some(until) if until > t => {
                u64::try_from((until - t).as_nanos() * u128::from(self.rate_bps) / 8_000_000_000)
                    .unwrap_or(u64::MAX)
            }
            _ => 0,
        };
        if ahead + bytes > self.buffer_bytes {
            self.bottleneck_drops += 1;
            return None;
        }
        let start = self.busy_until.map_or(t, |until| until.max(t));
        let service = Duration::from_nanos(
            (u128::from(bytes) * 8_000_000_000 / u128::from(self.rate_bps)) as u64,
        );
        let departure = start + service;
        self.busy_until = Some(departure);
        self.departed_bytes += bytes;
        let sequence = self.sequence;
        self.sequence += 1;
        let lost = exact_rate_selected(sequence, self.loss_percent, self.loss_seed);
        if lost {
            self.lost_after_link += 1;
        }
        let ce = self.ce_above.is_some_and(|threshold| ahead > threshold);
        if ce {
            self.ce_marked += 1;
        }
        self.log.push(LinkRecord {
            source,
            arrival: t,
            residence: departure - t,
            bytes,
            delivered: !lost,
        });
        (!lost).then_some((departure, ce))
    }
}

fn mix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

/// The delay proxy's selector: every 100-packet window holds exactly
/// `percent` selections, at seed-shuffled positions.
fn exact_rate_selected(sequence: u64, percent: u64, seed: u64) -> bool {
    if percent == 0 {
        return false;
    }
    let window = sequence / 100;
    let slot = sequence % 100;
    let shuffled = mix64(seed ^ window.wrapping_mul(0xd6e8_feb8_6659_fd93));
    const COPRIME_TO_100: [u64; 40] = [
        1, 3, 7, 9, 11, 13, 17, 19, 21, 23, 27, 29, 31, 33, 37, 39, 41, 43, 47, 49, 51, 53, 57, 59,
        61, 63, 67, 69, 71, 73, 77, 79, 81, 83, 87, 89, 91, 93, 97, 99,
    ];
    let multiplier = COPRIME_TO_100[(shuffled as usize) % COPRIME_TO_100.len()];
    let offset = mix64(shuffled ^ 0xa076_1d64_78bd_642f) % 100;
    (slot.wrapping_mul(multiplier).wrapping_add(offset) % 100) < percent
}

/// Drives `pairs` on one virtual clock, each step to the earliest event any
/// of them has, until `until` (or until none has anything left to do).
pub(super) fn drive_pairs_until(pairs: &mut [&mut Pair], until: Instant) {
    loop {
        for pair in pairs.iter_mut() {
            pair.drive_client();
            pair.drive_server();
        }
        let now = pairs
            .iter()
            .map(|pair| pair.time)
            .max()
            .expect("at least one pair");
        let next = pairs.iter().filter_map(|pair| pair.next_wakeup()).min();
        let time = match next {
            Some(next) if next <= until => next.max(now),
            _ => until.max(now),
        };
        for pair in pairs.iter_mut() {
            pair.time = time;
        }
        if next.is_none_or(|next| next > until) {
            for pair in pairs.iter_mut() {
                pair.drive_client();
                pair.drive_server();
            }
            return;
        }
    }
}

pub(super) struct Pair {
    pub(super) server: TestEndpoint,
    pub(super) client: TestEndpoint,
    /// Start time
    epoch: Instant,
    /// Current time
    pub(super) time: Instant,
    /// Simulates the maximum size allowed for UDP payloads by the link (packets exceeding this size will be dropped)
    pub(super) mtu: usize,
    /// Simulates explicit congestion notification
    pub(super) congestion_experienced: bool,
    // One-way
    pub(super) latency: Duration,
    /// Number of spin bit flips
    pub(super) spins: u64,
    last_spin: bool,
    /// Bottlenecks the client's and the server's datagrams cross, in that order.
    pub(super) links: [Option<Rc<RefCell<Link>>>; 2],
    /// Names this pair's packets in its links' logs.
    pub(super) link_source: u8,
    /// Apply propagation before serialization, as the browser downlink proxy does.
    pub(super) propagation_before_link: [bool; 2],
    link_pending: [VecDeque<(Instant, Option<EcnCodepoint>, Bytes)>; 2],
}

impl Pair {
    pub(super) fn default_with_deterministic_pns() -> Self {
        let mut cfg = server_config();
        let mut transport = TransportConfig::default();
        transport.deterministic_packet_numbers(true);
        cfg.transport = Arc::new(transport);
        Self::new(Default::default(), cfg)
    }

    pub(super) fn new(endpoint_config: Arc<EndpointConfig>, server_config: ServerConfig) -> Self {
        let server = Endpoint::new(
            endpoint_config.clone(),
            Some(Arc::new(server_config)),
            true,
            None,
        );
        let client = Endpoint::new(endpoint_config, None, true, None);

        Self::new_from_endpoint(client, server)
    }

    pub(super) fn new_from_endpoint(client: Endpoint, server: Endpoint) -> Self {
        let server_addr = SocketAddr::new(
            Ipv6Addr::LOCALHOST.into(),
            SERVER_PORTS.lock().unwrap().next().unwrap(),
        );
        let client_addr = SocketAddr::new(
            Ipv6Addr::LOCALHOST.into(),
            CLIENT_PORTS.lock().unwrap().next().unwrap(),
        );
        let now = Instant::now();
        Self {
            server: TestEndpoint::new(server, server_addr),
            client: TestEndpoint::new(client, client_addr),
            epoch: now,
            time: now,
            mtu: DEFAULT_MTU,
            latency: Duration::ZERO,
            spins: 0,
            last_spin: false,
            congestion_experienced: false,
            links: [None, None],
            link_source: 0,
            propagation_before_link: [false; 2],
            link_pending: Default::default(),
        }
    }

    /// Returns whether the connection is not idle
    pub(super) fn step(&mut self) -> bool {
        self.drive_client();
        self.drive_server();
        if self.client.is_idle()
            && self.server.is_idle()
            && self.link_pending.iter().all(VecDeque::is_empty)
        {
            return false;
        }
        match self.next_wakeup() {
            Some(t) => {
                if t != self.time {
                    self.time = self.time.max(t);
                    trace!("advancing to {:?}", self.time - self.epoch);
                }
                true
            }
            None => false,
        }
    }

    /// Advance time until both connections are idle
    pub(super) fn drive(&mut self) {
        while self.step() {}
    }

    /// Advance time until both connections are idle, or after 100 steps have been executed
    ///
    /// Returns true if the amount of steps exceeds the bounds, because the connections never became
    /// idle
    pub(super) fn drive_bounded(&mut self) -> bool {
        for _ in 0..100 {
            if !self.step() {
                return false;
            }
        }

        true
    }

    fn next_wakeup(&self) -> Option<Instant> {
        self.link_pending
            .iter()
            .filter_map(|pending| pending.front().map(|packet| packet.0))
            .chain(self.client.next_wakeup())
            .chain(self.server.next_wakeup())
            .min()
    }

    fn release_link(&mut self, direction: usize) {
        while self.link_pending[direction]
            .front()
            .is_some_and(|p| p.0 <= self.time)
        {
            let (arrival, ecn, bytes) = self.link_pending[direction].pop_front().unwrap();
            let crossed = self.links[direction]
                .as_ref()
                .map_or(Some((arrival, false)), |link| {
                    link.borrow_mut()
                        .admit(arrival, bytes.len(), self.link_source)
                });
            if let Some((departure, ce)) = crossed {
                let receiver = if direction == 0 {
                    &mut self.server
                } else {
                    &mut self.client
                };
                receiver.inbound.push_back((
                    departure,
                    set_congestion_experienced(ecn, self.congestion_experienced || ce),
                    bytes.as_ref().into(),
                ));
            }
        }
    }

    pub(super) fn drive_client(&mut self) {
        self.release_link(1);
        let span = info_span!("client");
        let _guard = span.enter();
        self.client.drive(self.time, self.server.addr);
        for (packet, buffer) in self.client.outbound.drain(..) {
            let packet_size = packet_size(&packet, &buffer);
            if packet_size > self.mtu {
                info!(packet_size, "dropping packet (max size exceeded)");
                continue;
            }
            if buffer[0] & packet::LONG_HEADER_FORM == 0 {
                let spin = buffer[0] & packet::SPIN_BIT != 0;
                self.spins += (spin == self.last_spin) as u64;
                self.last_spin = spin;
            }
            if let Some(ref socket) = self.client.socket {
                socket.send_to(&buffer, packet.destination).unwrap();
            }
            if self.server.addr == packet.destination {
                if self.propagation_before_link[0] {
                    let arrival = self.time + self.latency;
                    let pending = &mut self.link_pending[0];
                    let arrival = pending.back().map_or(arrival, |last| arrival.max(last.0));
                    pending.push_back((arrival, packet.ecn, buffer));
                    continue;
                }
                let crossed = match &self.links[0] {
                    None => Some((self.time, false)),
                    Some(link) => {
                        link.borrow_mut()
                            .admit(self.time, buffer.len(), self.link_source)
                    }
                };
                if let Some((departure, ce)) = crossed {
                    let ecn =
                        set_congestion_experienced(packet.ecn, self.congestion_experienced || ce);
                    // This link preserves packet order, including when its
                    // propagation delay changes. The receive timestamp must
                    // describe actual release, not an earlier blocked deadline.
                    let arrival = departure + self.latency;
                    let arrival = self
                        .server
                        .inbound
                        .back()
                        .map_or(arrival, |last| arrival.max(last.0));
                    self.server
                        .inbound
                        .push_back((arrival, ecn, buffer.as_ref().into()));
                }
            }
        }
    }

    pub(super) fn drive_server(&mut self) {
        self.release_link(0);
        let span = info_span!("server");
        let _guard = span.enter();
        self.server.drive(self.time, self.client.addr);
        for (packet, buffer) in self.server.outbound.drain(..) {
            let packet_size = packet_size(&packet, &buffer);
            if packet_size > self.mtu {
                info!(packet_size, "dropping packet (max size exceeded)");
                continue;
            }
            if let Some(ref socket) = self.server.socket {
                socket.send_to(&buffer, packet.destination).unwrap();
            }
            if self.client.addr == packet.destination {
                if self.propagation_before_link[1] {
                    let arrival = self.time + self.latency;
                    let pending = &mut self.link_pending[1];
                    let arrival = pending.back().map_or(arrival, |last| arrival.max(last.0));
                    pending.push_back((arrival, packet.ecn, buffer));
                    continue;
                }
                let crossed = match &self.links[1] {
                    None => Some((self.time, false)),
                    Some(link) => {
                        link.borrow_mut()
                            .admit(self.time, buffer.len(), self.link_source)
                    }
                };
                if let Some((departure, ce)) = crossed {
                    let ecn =
                        set_congestion_experienced(packet.ecn, self.congestion_experienced || ce);
                    // This link preserves packet order, including when its
                    // propagation delay changes. The receive timestamp must
                    // describe actual release, not an earlier blocked deadline.
                    let arrival = departure + self.latency;
                    let arrival = self
                        .client
                        .inbound
                        .back()
                        .map_or(arrival, |last| arrival.max(last.0));
                    self.client
                        .inbound
                        .push_back((arrival, ecn, buffer.as_ref().into()));
                }
            }
        }
    }

    pub(super) fn connect(&mut self) -> (ConnectionHandle, ConnectionHandle) {
        self.connect_with(client_config())
    }

    pub(super) fn connect_with(
        &mut self,
        config: ClientConfig,
    ) -> (ConnectionHandle, ConnectionHandle) {
        info!("connecting");
        let client_ch = self.begin_connect(config);
        self.drive();
        let server_ch = self.server.assert_accept();
        self.finish_connect(client_ch, server_ch);
        (client_ch, server_ch)
    }

    /// Just start connecting the client
    pub(super) fn begin_connect(&mut self, config: ClientConfig) -> ConnectionHandle {
        let span = info_span!("client");
        let _guard = span.enter();
        let (client_ch, client_conn) = self
            .client
            .connect(self.time, config, self.server.addr, "localhost")
            .unwrap();
        self.client.connections.insert(client_ch, client_conn);
        client_ch
    }

    fn finish_connect(&mut self, client_ch: ConnectionHandle, server_ch: ConnectionHandle) {
        assert_matches!(
            self.client_conn_mut(client_ch).poll(),
            Some(Event::HandshakeDataReady)
        );
        assert_matches!(
            self.client_conn_mut(client_ch).poll(),
            Some(Event::Connected)
        );
        assert_matches!(
            self.server_conn_mut(server_ch).poll(),
            Some(Event::HandshakeDataReady)
        );
        assert_matches!(
            self.server_conn_mut(server_ch).poll(),
            Some(Event::Connected)
        );
    }

    pub(super) fn client_conn_mut(&mut self, ch: ConnectionHandle) -> &mut Connection {
        self.client.connections.get_mut(&ch).unwrap()
    }

    pub(super) fn client_streams(&mut self, ch: ConnectionHandle) -> Streams<'_> {
        self.client_conn_mut(ch).streams()
    }

    pub(super) fn client_send(&mut self, ch: ConnectionHandle, s: StreamId) -> SendStream<'_> {
        self.client_conn_mut(ch).send_stream(s)
    }

    pub(super) fn client_recv(&mut self, ch: ConnectionHandle, s: StreamId) -> RecvStream<'_> {
        self.client_conn_mut(ch).recv_stream(s)
    }

    pub(super) fn client_datagrams(&mut self, ch: ConnectionHandle) -> Datagrams<'_> {
        self.client_conn_mut(ch).datagrams()
    }

    pub(super) fn server_conn_mut(&mut self, ch: ConnectionHandle) -> &mut Connection {
        self.server.connections.get_mut(&ch).unwrap()
    }

    pub(super) fn server_streams(&mut self, ch: ConnectionHandle) -> Streams<'_> {
        self.server_conn_mut(ch).streams()
    }

    pub(super) fn server_send(&mut self, ch: ConnectionHandle, s: StreamId) -> SendStream<'_> {
        self.server_conn_mut(ch).send_stream(s)
    }

    pub(super) fn server_recv(&mut self, ch: ConnectionHandle, s: StreamId) -> RecvStream<'_> {
        self.server_conn_mut(ch).recv_stream(s)
    }

    pub(super) fn server_datagrams(&mut self, ch: ConnectionHandle) -> Datagrams<'_> {
        self.server_conn_mut(ch).datagrams()
    }

    /// Replace the server with a fresh endpoint on the same address: a restarted
    /// process that remembers none of its connections.
    pub(super) fn restart_server(&mut self, endpoint_config: Arc<EndpointConfig>) {
        let endpoint = Endpoint::new(endpoint_config, Some(Arc::new(server_config())), true, None);
        self.server = TestEndpoint::new(endpoint, self.server.addr);
    }
}

impl Default for Pair {
    fn default() -> Self {
        Self::new(Default::default(), server_config())
    }
}

pub(super) struct TestEndpoint {
    pub(super) endpoint: Endpoint,
    pub(super) addr: SocketAddr,
    socket: Option<UdpSocket>,
    timeout: Option<Instant>,
    pub(super) outbound: VecDeque<(Transmit, Bytes)>,
    delayed: VecDeque<(Transmit, Bytes)>,
    pub(super) inbound: VecDeque<(Instant, Option<EcnCodepoint>, BytesMut)>,
    accepted: Option<Result<ConnectionHandle, ConnectionError>>,
    pub(super) connections: HashMap<ConnectionHandle, Connection>,
    conn_events: HashMap<ConnectionHandle, VecDeque<ConnectionEvent>>,
    pub(super) captured_packets: Vec<Vec<u8>>,
    pub(super) capture_inbound_packets: bool,
    pub(super) handle_incoming: Box<dyn FnMut(&Incoming) -> IncomingConnectionBehavior>,
    pub(super) waiting_incoming: Vec<Incoming>,
}

#[derive(Debug, Copy, Clone)]
pub(super) enum IncomingConnectionBehavior {
    Accept,
    Reject,
    Retry,
    Wait,
}

pub(super) fn validate_incoming(incoming: &Incoming) -> IncomingConnectionBehavior {
    if incoming.remote_address_validated() {
        IncomingConnectionBehavior::Accept
    } else {
        IncomingConnectionBehavior::Retry
    }
}

impl TestEndpoint {
    fn new(endpoint: Endpoint, addr: SocketAddr) -> Self {
        let socket = if env::var_os("SSLKEYLOGFILE").is_some() {
            let socket = UdpSocket::bind(addr).expect("failed to bind UDP socket");
            socket
                .set_read_timeout(Some(Duration::from_millis(10)))
                .unwrap();
            Some(socket)
        } else {
            None
        };
        Self {
            endpoint,
            addr,
            socket,
            timeout: None,
            outbound: VecDeque::new(),
            delayed: VecDeque::new(),
            inbound: VecDeque::new(),
            accepted: None,
            connections: HashMap::default(),
            conn_events: HashMap::default(),
            captured_packets: Vec::new(),
            capture_inbound_packets: false,
            handle_incoming: Box::new(|_| IncomingConnectionBehavior::Accept),
            waiting_incoming: Vec::new(),
        }
    }

    pub(super) fn drive(&mut self, now: Instant, remote: SocketAddr) {
        self.drive_incoming(now, remote);
        self.drive_outgoing(now);
    }

    pub(super) fn drive_incoming(&mut self, now: Instant, remote: SocketAddr) {
        if let Some(ref socket) = self.socket {
            loop {
                let mut buf = [0; 8192];
                if socket.recv_from(&mut buf).is_err() {
                    break;
                }
            }
        }
        let buffer_size = self.endpoint.config().get_max_udp_payload_size() as usize;
        let mut buf = Vec::with_capacity(buffer_size);

        while self.inbound.front().is_some_and(|x| x.0 <= now) {
            let (recv_time, ecn, packet) = self.inbound.pop_front().unwrap();
            if let Some(event) = self
                .endpoint
                .handle(recv_time, remote, None, ecn, packet, &mut buf)
            {
                match event {
                    DatagramEvent::NewConnection(incoming) => {
                        match (self.handle_incoming)(&incoming) {
                            IncomingConnectionBehavior::Accept => {
                                let _ = self.try_accept(incoming, now);
                            }
                            IncomingConnectionBehavior::Reject => {
                                self.reject(incoming);
                            }
                            IncomingConnectionBehavior::Retry => {
                                self.retry(incoming);
                            }
                            IncomingConnectionBehavior::Wait => {
                                self.waiting_incoming.push(incoming);
                            }
                        }
                    }
                    DatagramEvent::ConnectionEvent(ch, event) => {
                        if self.capture_inbound_packets {
                            let packet = self.connections[&ch].decode_packet(&event);
                            self.captured_packets.extend(packet);
                        }

                        self.conn_events.entry(ch).or_default().push_back(event);
                    }
                    DatagramEvent::Response(transmit) => {
                        let size = transmit.size;
                        self.outbound.extend(split_transmit(transmit, &buf[..size]));
                        buf.clear();
                    }
                }
            }
        }
    }

    pub(super) fn drive_outgoing(&mut self, now: Instant) {
        let buffer_size = self.endpoint.config().get_max_udp_payload_size() as usize;
        let mut buf = Vec::with_capacity(buffer_size);

        loop {
            let mut endpoint_events: Vec<(ConnectionHandle, EndpointEvent)> = vec![];
            for (ch, conn) in self.connections.iter_mut() {
                if self.timeout.is_some_and(|x| x <= now) {
                    self.timeout = None;
                    conn.handle_timeout(now);
                }

                for (_, mut events) in self.conn_events.drain() {
                    for event in events.drain(..) {
                        conn.handle_event(event);
                    }
                }

                while let Some(event) = conn.poll_endpoint_events() {
                    endpoint_events.push((*ch, event));
                }
                while let Some(transmit) = conn.poll_transmit(now, MAX_DATAGRAMS, &mut buf) {
                    let size = transmit.size;
                    self.outbound.extend(split_transmit(transmit, &buf[..size]));
                    buf.clear();
                }
                self.timeout = conn.poll_timeout();
            }

            if endpoint_events.is_empty() {
                break;
            }

            for (ch, event) in endpoint_events {
                if let Some(event) = self.handle_event(ch, event) {
                    if let Some(conn) = self.connections.get_mut(&ch) {
                        conn.handle_event(event);
                    }
                }
            }
        }
    }

    pub(super) fn next_wakeup(&self) -> Option<Instant> {
        let next_inbound = self.inbound.front().map(|x| x.0);
        min_opt(self.timeout, next_inbound)
    }

    fn is_idle(&self) -> bool {
        self.connections.values().all(|x| x.is_idle())
    }

    pub(super) fn delay_outbound(&mut self) {
        assert!(self.delayed.is_empty());
        mem::swap(&mut self.delayed, &mut self.outbound);
    }

    pub(super) fn finish_delay(&mut self) {
        self.outbound.extend(self.delayed.drain(..));
    }

    pub(super) fn try_accept(
        &mut self,
        incoming: Incoming,
        now: Instant,
    ) -> Result<ConnectionHandle, ConnectionError> {
        let mut buf = Vec::new();
        match self.endpoint.accept(incoming, now, &mut buf, None) {
            Ok((ch, conn)) => {
                self.connections.insert(ch, conn);
                self.accepted = Some(Ok(ch));
                Ok(ch)
            }
            Err(error) => {
                if let Some(transmit) = error.response {
                    let size = transmit.size;
                    self.outbound.extend(split_transmit(transmit, &buf[..size]));
                }
                self.accepted = Some(Err(error.cause.clone()));
                Err(error.cause)
            }
        }
    }

    pub(super) fn retry(&mut self, incoming: Incoming) {
        let mut buf = Vec::new();
        let transmit = self.endpoint.retry(incoming, &mut buf).unwrap();
        let size = transmit.size;
        self.outbound.extend(split_transmit(transmit, &buf[..size]));
    }

    pub(super) fn reject(&mut self, incoming: Incoming) {
        let mut buf = Vec::new();
        let transmit = self.endpoint.refuse(incoming, &mut buf);
        let size = transmit.size;
        self.outbound.extend(split_transmit(transmit, &buf[..size]));
    }

    pub(super) fn assert_accept(&mut self) -> ConnectionHandle {
        self.accepted
            .take()
            .expect("server didn't try connecting")
            .expect("server experienced error connecting")
    }

    pub(super) fn assert_accept_error(&mut self) -> ConnectionError {
        self.accepted
            .take()
            .expect("server didn't try connecting")
            .expect_err("server did unexpectedly connect without error")
    }

    pub(super) fn assert_no_accept(&self) {
        assert!(self.accepted.is_none(), "server did unexpectedly connect")
    }
}

impl ::std::ops::Deref for TestEndpoint {
    type Target = Endpoint;
    fn deref(&self) -> &Endpoint {
        &self.endpoint
    }
}

impl ::std::ops::DerefMut for TestEndpoint {
    fn deref_mut(&mut self) -> &mut Endpoint {
        &mut self.endpoint
    }
}

pub(super) fn subscribe() -> tracing::subscriber::DefaultGuard {
    let builder = tracing_subscriber::FmtSubscriber::builder()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(|| TestWriter);
    // tracing uses std::time to trace time, which panics in wasm.
    #[cfg(all(target_family = "wasm", target_os = "unknown"))]
    let builder = builder.without_time();
    tracing::subscriber::set_default(builder.finish())
}

struct TestWriter;

impl Write for TestWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        print!(
            "{}",
            str::from_utf8(buf).expect("tried to log invalid UTF-8")
        );
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        io::stdout().flush()
    }
}

pub(super) fn server_config() -> ServerConfig {
    let mut config = ServerConfig::with_crypto(Arc::new(server_crypto()));
    if !cfg!(feature = "bloom") {
        config
            .validation_token
            .sent(2)
            .log(Arc::new(SimpleTokenLog::default()));
    }
    config
}

pub(super) fn server_config_with_cert(
    cert: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
) -> ServerConfig {
    let mut config = ServerConfig::with_crypto(Arc::new(server_crypto_with_cert(cert, key)));
    config
        .validation_token
        .sent(2)
        .log(Arc::new(SimpleTokenLog::default()));
    config
}

pub(super) fn server_crypto() -> QuicServerConfig {
    server_crypto_inner(None, None)
}

pub(super) fn server_crypto_with_alpn(alpn: Vec<Vec<u8>>) -> QuicServerConfig {
    server_crypto_inner(None, Some(alpn))
}

pub(super) fn server_crypto_with_cert(
    cert: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
) -> QuicServerConfig {
    server_crypto_inner(Some((cert, key)), None)
}

fn server_crypto_inner(
    identity: Option<(CertificateDer<'static>, PrivateKeyDer<'static>)>,
    alpn: Option<Vec<Vec<u8>>>,
) -> QuicServerConfig {
    let (cert, key) = identity.unwrap_or_else(|| {
        (
            CERTIFIED_KEY.cert.der().clone(),
            PrivateKeyDer::Pkcs8(CERTIFIED_KEY.signing_key.serialize_der().into()),
        )
    });

    let mut config = QuicServerConfig::inner(vec![cert], key).unwrap();
    if let Some(alpn) = alpn {
        config.alpn_protocols = alpn;
    }

    config.try_into().unwrap()
}

pub(super) fn client_config() -> ClientConfig {
    ClientConfig::new(Arc::new(client_crypto()))
}

pub(super) fn client_config_with_deterministic_pns() -> ClientConfig {
    let mut cfg = ClientConfig::new(Arc::new(client_crypto()));
    let mut transport = TransportConfig::default();
    transport.deterministic_packet_numbers(true);
    cfg.transport = Arc::new(transport);
    cfg
}

pub(super) fn client_config_with_certs(certs: Vec<CertificateDer<'static>>) -> ClientConfig {
    ClientConfig::new(Arc::new(client_crypto_inner(Some(certs), None)))
}

pub(super) fn client_crypto() -> QuicClientConfig {
    client_crypto_inner(None, None)
}

pub(super) fn client_crypto_with_alpn(protocols: Vec<Vec<u8>>) -> QuicClientConfig {
    client_crypto_inner(None, Some(protocols))
}

fn client_crypto_inner(
    certs: Option<Vec<CertificateDer<'static>>>,
    alpn: Option<Vec<Vec<u8>>>,
) -> QuicClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    for cert in certs.unwrap_or_else(|| vec![CERTIFIED_KEY.cert.der().clone()]) {
        roots.add(cert).unwrap();
    }

    let mut inner = QuicClientConfig::inner(
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), configured_provider())
            .build()
            .unwrap(),
    );
    inner.key_log = Arc::new(KeyLogFile::new());
    if let Some(alpn) = alpn {
        inner.alpn_protocols = alpn;
    }

    inner.try_into().unwrap()
}

pub(super) fn min_opt<T: Ord>(x: Option<T>, y: Option<T>) -> Option<T> {
    match (x, y) {
        (Some(x), Some(y)) => Some(cmp::min(x, y)),
        (Some(x), _) => Some(x),
        (_, Some(y)) => Some(y),
        _ => None,
    }
}

/// The maximum of datagrams TestEndpoint will produce via `poll_transmit`
const MAX_DATAGRAMS: usize = 10;

fn split_transmit(transmit: Transmit, buffer: &[u8]) -> Vec<(Transmit, Bytes)> {
    let mut buffer = Bytes::copy_from_slice(buffer);
    let segment_size = match transmit.segment_size {
        Some(segment_size) => segment_size,
        _ => return vec![(transmit, buffer)],
    };

    let mut transmits = Vec::new();
    while !buffer.is_empty() {
        let end = segment_size.min(buffer.len());

        let contents = buffer.split_to(end);
        transmits.push((
            Transmit {
                destination: transmit.destination,
                size: contents.len(),
                ecn: transmit.ecn,
                segment_size: None,
                src_ip: transmit.src_ip,
            },
            contents,
        ));
    }

    transmits
}

fn packet_size(transmit: &Transmit, buffer: &Bytes) -> usize {
    if transmit.segment_size.is_some() {
        panic!("This transmit is meant to be split into multiple packets!");
    }

    buffer.len()
}

fn set_congestion_experienced(
    x: Option<EcnCodepoint>,
    congestion_experienced: bool,
) -> Option<EcnCodepoint> {
    x.map(|codepoint| match congestion_experienced {
        true => EcnCodepoint::Ce,
        false => codepoint,
    })
}

lazy_static! {
    pub static ref SERVER_PORTS: Mutex<RangeFrom<u16>> = Mutex::new(4433..);
    pub static ref CLIENT_PORTS: Mutex<RangeFrom<u16>> = Mutex::new(44433..);
    pub(crate) static ref CERTIFIED_KEY: rcgen::CertifiedKey<rcgen::KeyPair> =
        rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
}

#[derive(Default)]
struct SimpleTokenLog(Mutex<HashSet<u128>>);

impl TokenLog for SimpleTokenLog {
    fn check_and_insert(
        &self,
        nonce: u128,
        _issued: SystemTime,
        _lifetime: Duration,
    ) -> Result<(), TokenReuseError> {
        if self.0.lock().unwrap().insert(nonce) {
            Ok(())
        } else {
            Err(TokenReuseError)
        }
    }
}

#[test]
fn fifo_propagation_before_a_link_compresses_a_perfectly_paced_sender() {
    let start = Instant::now();
    let mut link = Link::new(25_000_000, 640_000);
    let mut previous_arrival = start;
    // 1,500 wire bytes every 600 us: exactly 80% of this link's capacity.
    // There is no controller and no sender scheduling jitter in this control.
    for n in 0..20_000u64 {
        let sent = start + Duration::from_micros(n * 600);
        let tick = n * 600 / 1_000 + 1;
        let delay = Duration::from_micros(26_250 + (tick * 7_919 + 11) % 7_501);
        let arrival = (sent + delay).max(previous_arrival);
        previous_arrival = arrival;
        assert!(link.admit(arrival, 1452, 0).is_some());
    }
    let mut residence: Vec<_> = link
        .log
        .iter()
        .filter(|packet| packet.arrival >= start + Duration::from_secs(2))
        .map(|packet| packet.residence)
        .collect();
    residence.sort_unstable();
    let p95 = residence[residence.len() * 95 / 100];
    assert!(p95 > Duration::from_millis(3));
    assert!(p95 < Duration::from_micros(7_500));
}
