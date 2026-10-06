//! Capacity bottlenecks: one link per role and direction, shared by every relay
//! of that role.
//!
//! A relay is one QUIC connection, and each peer opens several. On a real
//! access link an echo on the interactive connection waits behind whatever the
//! bulk connection queued first, so a link here is shared by all of a role's
//! relays (and its competitor relays), never owned by one.
//!
//! A link serializes packets at its rate on a virtual clock of integer
//! nanoseconds. A packet of `L` bytes (UDP payload plus `LINK_HEADER_BYTES`)
//! arriving at `t` finds `backlog = max(0, busy_until − t)·R/8` bytes ahead of
//! it; it is dropped when `backlog + L` exceeds the buffer (`bottleneckDrops`,
//! never a harness drop) and otherwise departs at `max(t, busy_until) + 8L/R`.
//! With `fq`, each relay owns a flow queue served by deficit round robin with a
//! one-packet quantum, and an overflow drops from the head of the longest flow
//! queue. Every departure follows from arrival times, sizes and the rate
//! schedule alone, so it does not depend on when the link task happens to run;
//! the task only releases each packet at its departure through
//! `wait_until_precise`, and records how late that release was so a run can
//! prove it stayed exact.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::ser::SerializeSeq;
use serde::{Serialize, Serializer};
use tokio::sync::mpsc;
use tokio::time::Instant;

/// IPv6 (40) and UDP (8) headers: what a datagram occupies on a link beyond
/// its payload.
pub const LINK_HEADER_BYTES: u64 = 48;
/// Deficit round robin quantum: one full-size packet on the wire.
pub const FQ_QUANTUM_BYTES: u64 = 1_500;
/// Log2 histogram buckets. Bucket 0 holds zero and bucket `i ≥ 1` holds
/// `[2^(i−1), 2^i)`; the last bucket also holds everything above it (16.7 s,
/// or 16.7 MB).
pub const LOG2_BUCKETS: usize = 26;
/// Slots of the post-step residence trace: 10 ms each, eight seconds.
pub const STEP_TRACE_SLOTS: usize = 800;
pub const STEP_TRACE_SLOT_US: u64 = 10_000;

/// Which peer's access link: the listener a relay arrived on names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Daemon,
    Browser,
}

/// `Up` is the peer's uplink, entered at proxy ingress before the leg's delay.
/// `Down` is its downlink, entered as the leg's delay releases a packet and
/// before the destructive loss site.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkDirection {
    Up,
    Down,
}

/// A rate change `after_mark_ms` after each trace mark or reset. Before the
/// first mark the link runs at its base rate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateStep {
    pub after_mark_ms: u64,
    pub rate_bps: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkConfig {
    pub role: Role,
    pub direction: LinkDirection,
    pub rate_bps: u64,
    pub buffer_bytes: u64,
    pub fq: bool,
    pub step: Option<RateStep>,
}

impl LinkConfig {
    /// Parses `<bit/s>:<bytes>[:fq][@<ms>=<bit/s>]`.
    pub fn parse(role: Role, direction: LinkDirection, spec: &str) -> Result<Self, String> {
        let (head, step) = match spec.split_once('@') {
            Some((head, step)) => (head, Some(step)),
            None => (spec, None),
        };
        let mut fields = head.split(':');
        let rate_bps = parse_positive(fields.next(), "rate bit/s")?;
        let buffer_bytes = parse_positive(fields.next(), "buffer bytes")?;
        let fq = match fields.next() {
            None => false,
            Some("fq") => true,
            Some(other) => return Err(format!("unknown link option {other:?}")),
        };
        if fields.next().is_some() {
            return Err("a link takes at most one option".into());
        }
        let step = step
            .map(|step| {
                let (after, rate) = step
                    .split_once('=')
                    .ok_or_else(|| "a rate step is @<ms>=<bit/s>".to_string())?;
                Ok::<_, String>(RateStep {
                    after_mark_ms: parse_positive(Some(after), "step milliseconds")?,
                    rate_bps: parse_positive(Some(rate), "step rate bit/s")?,
                })
            })
            .transpose()?;
        if buffer_bytes < FQ_QUANTUM_BYTES {
            return Err(format!(
                "a buffer below one {FQ_QUANTUM_BYTES}-byte packet drops every full packet"
            ));
        }
        Ok(Self {
            role,
            direction,
            rate_bps,
            buffer_bytes,
            fq,
            step,
        })
    }

    /// The smallest rate this link ever runs at.
    pub fn lowest_rate_bps(&self) -> u64 {
        self.step
            .map_or(self.rate_bps, |step| step.rate_bps.min(self.rate_bps))
    }
}

fn parse_positive(field: Option<&str>, name: &str) -> Result<u64, String> {
    let raw = field.ok_or_else(|| format!("missing {name}"))?;
    let value: u64 = raw
        .parse()
        .map_err(|_| format!("{name} must be an unsigned integer, not {raw:?}"))?;
    if value == 0 {
        return Err(format!("{name} must be positive"));
    }
    Ok(value)
}

/// Serialization time of `bytes` at `rate_bps`, rounded up to a nanosecond.
pub fn service_ns(bytes: u64, rate_bps: u64) -> u64 {
    let numerator = u128::from(bytes) * 8 * 1_000_000_000;
    u64::try_from(numerator.div_ceil(u128::from(rate_bps))).unwrap_or(u64::MAX)
}

/// Bytes a link at `rate_bps` serializes in `ns`, rounded up.
fn bytes_in_ns(ns: u64, rate_bps: u64) -> u64 {
    let numerator = u128::from(ns) * u128::from(rate_bps);
    u64::try_from(numerator.div_ceil(8 * 1_000_000_000)).unwrap_or(u64::MAX)
}

fn micros(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Log2Histogram([u64; LOG2_BUCKETS]);

impl Default for Log2Histogram {
    fn default() -> Self {
        Self([0; LOG2_BUCKETS])
    }
}

impl fmt::Debug for Log2Histogram {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.0.iter()).finish()
    }
}

impl Log2Histogram {
    pub fn record(&mut self, value: u64) {
        let bucket = (u64::BITS - value.leading_zeros()) as usize;
        let bucket = bucket.min(LOG2_BUCKETS - 1);
        self.0[bucket] = self.0[bucket].wrapping_add(1);
    }

    pub fn count(&self) -> u64 {
        self.0.iter().sum()
    }

    /// The exclusive upper bound of the bucket holding the `numerator /
    /// denominator` quantile, or zero without samples.
    pub fn quantile_upper(&self, numerator: u64, denominator: u64) -> u64 {
        let count = self.count();
        if count == 0 {
            return 0;
        }
        let target = count.saturating_mul(numerator).div_ceil(denominator);
        let mut cumulative = 0;
        for (bucket, value) in self.0.iter().enumerate() {
            cumulative += value;
            if cumulative >= target {
                return 1 << bucket;
            }
        }
        u64::MAX
    }
}

impl Serialize for Log2Histogram {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(LOG2_BUCKETS))?;
        for value in &self.0 {
            sequence.serialize_element(value)?;
        }
        sequence.end()
    }
}

/// One link's aggregate since the last reset.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTotals {
    pub arrivals: u64,
    pub departures: u64,
    pub bottleneck_drops: u64,
    /// Departed, then dropped by the loss site behind the link.
    pub lost_after_link: u64,
    pub departed_bytes: u64,
    /// Time the link spent serializing, in nanoseconds.
    pub busy_ns: u64,
    /// Services that started at a different rate than the one before.
    pub rate_changes: u64,
    /// Departure minus arrival, on the virtual clock.
    pub residence_log2_us: Log2Histogram,
    /// Bytes ahead of a packet as it arrived: the whole backlog on a FIFO,
    /// its own flow's on `fq`.
    pub bytes_ahead_log2: Log2Histogram,
    /// Actual send minus departure: how late the task released a packet.
    pub release_overshoot_log2_us: Log2Histogram,
}

/// One relay's use of one link since the trace mark.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayLinkStats {
    pub packets: u64,
    /// Bytes whose service started since the mark: the relay's share of the
    /// link's capacity.
    pub bytes: u64,
    pub bottleneck_drops: u64,
    pub max_residence_us: u64,
    pub residence_log2_us: Log2Histogram,
    pub bytes_ahead_log2: Log2Histogram,
}

/// The largest residence of a relay's packets that entered the link in each
/// 10 ms slot after the step, so a run can see how long the queue built
/// before the step took to drain. Zero means no packet entered in that slot.
#[derive(Clone)]
pub struct StepTrace(Box<[u32; STEP_TRACE_SLOTS]>);

impl Default for StepTrace {
    fn default() -> Self {
        Self(Box::new([0; STEP_TRACE_SLOTS]))
    }
}

impl StepTrace {
    fn used(&self) -> &[u32] {
        let used = self
            .0
            .iter()
            .rposition(|value| *value != 0)
            .map_or(0, |last| last + 1);
        &self.0[..used]
    }
}

impl fmt::Debug for StepTrace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.used().iter()).finish()
    }
}

impl Serialize for StepTrace {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Trailing empty slots carry nothing.
        let used = self.used();
        let mut sequence = serializer.serialize_seq(Some(used.len()))?;
        for value in used {
            sequence.serialize_element(value)?;
        }
        sequence.end()
    }
}

struct RelaySlot {
    admission_seq: u64,
    stats: RelayLinkStats,
    step_trace: Option<StepTrace>,
}

/// What the control plane reads and resets.
struct Shared {
    totals: LinkTotals,
    relays: Vec<Option<RelaySlot>>,
    /// The last trace mark or reset: the rate schedule counts from it.
    origin: Option<Instant>,
    /// Rate of the most recently started service.
    rate_bps: u64,
}

impl Shared {
    fn relay(&mut self, slot: usize, admission_seq: u64) -> &mut RelaySlot {
        let entry = &mut self.relays[slot];
        if entry
            .as_ref()
            .is_none_or(|relay| relay.admission_seq != admission_seq)
        {
            *entry = Some(RelaySlot {
                admission_seq,
                stats: RelayLinkStats::default(),
                step_trace: None,
            });
        }
        entry.as_mut().expect("just filled")
    }
}

/// A packet offered to a link. `slot` and `admission_seq` name its relay: the
/// flow on `fq` and the owner of its per-relay counters.
pub struct Arrival<P> {
    pub at: Instant,
    pub slot: usize,
    pub admission_seq: u64,
    pub bytes: u64,
    pub payload: P,
}

struct Waiting<P> {
    arrival: Arrival<P>,
}

struct Flow<P> {
    queue: VecDeque<Waiting<P>>,
    queued_bytes: u64,
    deficit: u64,
}

impl<P> Default for Flow<P> {
    fn default() -> Self {
        Self {
            queue: VecDeque::new(),
            queued_bytes: 0,
            deficit: 0,
        }
    }
}

/// A packet whose service has started: it leaves at `departure`.
pub struct Committed<P> {
    pub departure: Instant,
    pub payload: P,
}

/// One started service, for the link's counters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Started {
    pub slot: usize,
    pub admission_seq: u64,
    pub arrival: Instant,
    pub departure: Instant,
    pub bytes: u64,
    pub rate_bps: u64,
}

/// Why an arrival or a waiting packet never reached the wire.
pub struct Dropped<P> {
    pub slot: usize,
    pub admission_seq: u64,
    pub payload: P,
}

/// What admission found and did.
pub struct Admission<P> {
    /// Bytes ahead of the arrival: the whole backlog on a FIFO, its own flow's
    /// on `fq`.
    pub ahead: u64,
    /// The arrival itself, when the buffer could not hold it, and every packet
    /// a longest-queue drop pushed out of a longer flow.
    pub dropped: Vec<Dropped<P>>,
    pub queued: bool,
}

/// The link's queues on the virtual clock. Pure: every decision follows from
/// arrival times, sizes and the rate schedule, never from when it is called.
///
/// Invariant: after `advance(t)`, either the link is busy past `t` or nothing
/// waits. So at every commit point every waiting packet has already arrived,
/// and the round robin chooses among exactly the flows that were backlogged.
pub struct LinkQueue<P> {
    config: LinkConfig,
    flows: Vec<Flow<P>>,
    /// Backlogged flows in round-robin order; the front's turn is running when
    /// `turn_started`.
    active: VecDeque<usize>,
    turn_started: bool,
    queued_bytes: u64,
    /// Departure of the packet in service, or of the last one served.
    busy_until: Option<Instant>,
    /// Rate the packet in service is serialized at.
    service_rate_bps: u64,
    committed: VecDeque<Committed<P>>,
    started: Vec<Started>,
    origin: Option<Instant>,
}

impl<P> LinkQueue<P> {
    pub fn new(config: LinkConfig, flows: usize) -> Self {
        Self {
            config,
            flows: (0..if config.fq { flows } else { 1 })
                .map(|_| Flow::default())
                .collect(),
            active: VecDeque::new(),
            turn_started: false,
            queued_bytes: 0,
            busy_until: None,
            service_rate_bps: config.rate_bps,
            committed: VecDeque::new(),
            started: Vec::new(),
            origin: None,
        }
    }

    /// Restarts the rate schedule: the base rate from `at`, the step after its
    /// delay.
    pub fn restart_schedule(&mut self, at: Instant) {
        self.origin = Some(at);
    }

    /// The rate a service starting at `start` runs at.
    pub fn rate_at(&self, start: Instant) -> u64 {
        match (self.config.step, self.origin) {
            (Some(step), Some(origin))
                if start >= origin + Duration::from_millis(step.after_mark_ms) =>
            {
                step.rate_bps
            }
            _ => self.config.rate_bps,
        }
    }

    fn flow_of(&self, slot: usize) -> usize {
        if self.config.fq { slot } else { 0 }
    }

    /// Bytes the packet in service still has to serialize at `at`.
    fn in_service_bytes(&self, at: Instant) -> u64 {
        match self.busy_until {
            Some(until) if until > at => bytes_in_ns(nanos(until - at), self.service_rate_bps),
            _ => 0,
        }
    }

    /// Starts every service due by `at`.
    pub fn advance(&mut self, at: Instant) {
        while self.busy_until.is_none_or(|until| until <= at) && self.queued_bytes != 0 {
            let head_arrival = self
                .flows
                .iter()
                .filter_map(|flow| flow.queue.front().map(|head| head.arrival.at))
                .min()
                .expect("waiting bytes mean a waiting packet");
            if head_arrival > at {
                return;
            }
            self.start_next();
        }
    }

    /// Serves the next waiting packet as soon as the link is free.
    fn start_next(&mut self) {
        let flow = self.next_flow();
        let Arrival {
            at: arrival,
            slot,
            admission_seq,
            bytes,
            payload,
        } = self.take_head(flow).arrival;
        let start = self
            .busy_until
            .map_or(arrival, |until| until.max(arrival));
        let rate_bps = self.rate_at(start);
        let departure = start + Duration::from_nanos(service_ns(bytes, rate_bps));
        self.busy_until = Some(departure);
        self.service_rate_bps = rate_bps;
        self.started.push(Started {
            slot,
            admission_seq,
            arrival,
            departure,
            bytes,
            rate_bps,
        });
        self.committed.push_back(Committed { departure, payload });
    }

    /// Admits `arrival` at its own time, after starting every service due
    /// before it.
    pub fn admit(&mut self, arrival: Arrival<P>) -> Admission<P> {
        self.advance(arrival.at);
        let flow = self.flow_of(arrival.slot);
        let backlog = self.queued_bytes + self.in_service_bytes(arrival.at);
        let ahead = if self.config.fq {
            self.flows[flow].queued_bytes
        } else {
            backlog
        };
        let mut dropped = Vec::new();
        let mut total = backlog;
        while total + arrival.bytes > self.config.buffer_bytes {
            // The longest flow loses a packet from its head; the arriving flow
            // loses the arrival itself when it is the longest. A FIFO has one
            // flow, so this is drop-tail.
            let longest = (0..self.flows.len())
                .max_by_key(|&index| {
                    let own = if index == flow { arrival.bytes } else { 0 };
                    (self.flows[index].queued_bytes + own, index == flow)
                })
                .expect("a link has at least one flow");
            if longest == flow || self.flows[longest].queued_bytes == 0 {
                dropped.push(Dropped {
                    slot: arrival.slot,
                    admission_seq: arrival.admission_seq,
                    payload: arrival.payload,
                });
                return Admission {
                    ahead,
                    dropped,
                    queued: false,
                };
            }
            let victim = self.take_head(longest).arrival;
            total -= victim.bytes;
            dropped.push(Dropped {
                slot: victim.slot,
                admission_seq: victim.admission_seq,
                payload: victim.payload,
            });
        }
        let bytes = arrival.bytes;
        let target = &mut self.flows[flow];
        if target.queue.is_empty() {
            target.deficit = 0;
            self.active.push_back(flow);
        }
        target.queue.push_back(Waiting { arrival });
        target.queued_bytes += bytes;
        self.queued_bytes += bytes;
        Admission {
            ahead,
            dropped,
            queued: true,
        }
    }

    /// The flow whose head is served next: deficit round robin.
    fn next_flow(&mut self) -> usize {
        loop {
            let flow = *self
                .active
                .front()
                .expect("waiting bytes mean a backlogged flow");
            let single = self.active.len() == 1;
            let state = &mut self.flows[flow];
            if !self.turn_started {
                state.deficit += FQ_QUANTUM_BYTES;
                self.turn_started = true;
            }
            let head = state
                .queue
                .front()
                .expect("an active flow is backlogged")
                .arrival
                .bytes;
            // A lone backlogged flow (always, on a FIFO) never waits for its
            // deficit: the round robin has nobody else to serve.
            if head <= state.deficit || single {
                state.deficit = state.deficit.saturating_sub(head);
                return flow;
            }
            self.active.rotate_left(1);
            self.turn_started = false;
        }
    }

    fn take_head(&mut self, flow: usize) -> Waiting<P> {
        let state = &mut self.flows[flow];
        let entry = state
            .queue
            .pop_front()
            .expect("taking from a backlogged flow");
        state.queued_bytes -= entry.arrival.bytes;
        self.queued_bytes -= entry.arrival.bytes;
        if state.queue.is_empty() {
            state.deficit = 0;
            if let Some(position) = self.active.iter().position(|&active| active == flow) {
                self.active.remove(position);
                if position == 0 {
                    self.turn_started = false;
                }
            }
        }
        entry
    }

    /// When the next packet leaves, starting a service first if the link has
    /// gone idle with packets waiting.
    pub fn next_departure(&mut self) -> Option<Instant> {
        if self.committed.is_empty() && self.queued_bytes != 0 {
            self.start_next();
        }
        self.committed.front().map(|entry| entry.departure)
    }

    pub fn pop_departure(&mut self) -> Option<Committed<P>> {
        self.committed.pop_front()
    }

    /// Services started since the last call.
    pub fn take_started(&mut self) -> Vec<Started> {
        std::mem::take(&mut self.started)
    }
}

/// A running link: its arrival channel and the counters the control plane
/// reads.
pub struct Link<P> {
    config: LinkConfig,
    arrivals: mpsc::UnboundedSender<Arrival<P>>,
    shared: Arc<Mutex<Shared>>,
}

impl<P> Clone for Link<P> {
    fn clone(&self) -> Self {
        Self {
            config: self.config,
            arrivals: self.arrivals.clone(),
            shared: self.shared.clone(),
        }
    }
}

/// The control plane's view of one link.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub config: LinkConfig,
    pub rate_bps: u64,
    pub totals: LinkTotals,
    /// Upper bound of the p99 release lateness bucket.
    pub release_overshoot_p99_upper_us: u64,
    /// One full-size packet's time at the link's lowest rate: a run is valid
    /// only while the p99 release lateness stays below it.
    pub lowest_rate_packet_us: u64,
}

/// One relay's view of one link, since the mark.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayLinkStatus {
    pub direction: LinkDirection,
    pub stats: RelayLinkStats,
    /// Present only on a link that steps its rate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_trace_max_residence_us: Option<StepTrace>,
}

impl<P: Send + 'static> Link<P> {
    /// Starts the link's task. `release` sends a departed packet on, after its
    /// departure instant and in departure order, and says whether it reached
    /// the wire (`false`: the loss site behind the link took it).
    pub fn spawn<F, Fut>(config: LinkConfig, flows: usize, mut release: F) -> Self
    where
        F: FnMut(P, Instant) -> Fut + Send + 'static,
        Fut: Future<Output = bool> + Send,
    {
        let (arrivals, mut rx) = mpsc::unbounded_channel::<Arrival<P>>();
        let shared = Arc::new(Mutex::new(Shared {
            totals: LinkTotals::default(),
            relays: (0..flows).map(|_| None).collect(),
            origin: None,
            rate_bps: config.rate_bps,
        }));
        let task_shared = shared.clone();
        tokio::spawn(async move {
            let mut queue = LinkQueue::new(config, flows);
            let mut closed = false;
            loop {
                // Take everything already offered, each at its own time.
                let mut next = None;
                loop {
                    match rx.try_recv() {
                        Ok(arrival) => admit(&mut queue, &task_shared, arrival),
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            closed = true;
                            break;
                        }
                    }
                }
                if let Some(departure) = queue.next_departure() {
                    next = Some(departure);
                }
                record_started(&mut queue, &task_shared);
                let Some(departure) = next else {
                    if closed {
                        return;
                    }
                    match rx.recv().await {
                        Some(arrival) => admit(&mut queue, &task_shared, arrival),
                        None => closed = true,
                    }
                    continue;
                };
                super::wait_until_precise(departure).await;
                let sent_at = Instant::now();
                let committed = queue
                    .pop_departure()
                    .expect("a departure was just scheduled");
                let delivered = release(committed.payload, departure).await;
                let mut shared = task_shared.lock().expect("link state poisoned");
                shared.totals.departures += 1;
                if !delivered {
                    shared.totals.lost_after_link += 1;
                }
                shared
                    .totals
                    .release_overshoot_log2_us
                    .record(micros(sent_at.saturating_duration_since(departure)));
            }
        });
        Self {
            config,
            arrivals,
            shared,
        }
    }

    /// Offers a packet. `false` once the link task is gone.
    pub fn offer(&self, arrival: Arrival<P>) -> bool {
        self.arrivals.send(arrival).is_ok()
    }
}

impl<P> Link<P> {
    pub fn config(&self) -> &LinkConfig {
        &self.config
    }

    /// A trace mark: restart per-relay counters and the rate schedule.
    pub fn mark(&self, at: Instant) {
        let mut shared = self.shared.lock().expect("link state poisoned");
        shared.origin = Some(at);
        for relay in shared.relays.iter_mut().flatten() {
            relay.stats = RelayLinkStats::default();
            relay.step_trace = None;
        }
    }

    /// A reset: a mark that also clears the link's totals.
    pub fn reset(&self, at: Instant) {
        self.mark(at);
        self.shared.lock().expect("link state poisoned").totals = LinkTotals::default();
    }

    pub fn status(&self) -> LinkStatus {
        let shared = self.shared.lock().expect("link state poisoned");
        LinkStatus {
            config: self.config,
            rate_bps: shared.rate_bps,
            totals: shared.totals,
            release_overshoot_p99_upper_us: shared
                .totals
                .release_overshoot_log2_us
                .quantile_upper(99, 100),
            lowest_rate_packet_us: service_ns(FQ_QUANTUM_BYTES, self.config.lowest_rate_bps())
                / 1_000,
        }
    }

    /// Bottleneck drops of the relay in `slot` since the mark.
    pub fn relay_drops(&self, slot: usize, admission_seq: u64) -> u64 {
        let shared = self.shared.lock().expect("link state poisoned");
        shared.relays[slot]
            .as_ref()
            .filter(|relay| relay.admission_seq == admission_seq)
            .map_or(0, |relay| relay.stats.bottleneck_drops)
    }

    pub fn relay_status(&self, slot: usize, admission_seq: u64) -> Option<RelayLinkStatus> {
        let shared = self.shared.lock().expect("link state poisoned");
        let relay = shared.relays[slot]
            .as_ref()
            .filter(|relay| relay.admission_seq == admission_seq)?;
        Some(RelayLinkStatus {
            direction: self.config.direction,
            stats: relay.stats,
            step_trace_max_residence_us: self.config.step.map(|_| {
                relay.step_trace.clone().unwrap_or_default()
            }),
        })
    }
}

fn admit<P>(queue: &mut LinkQueue<P>, shared: &Mutex<Shared>, arrival: Arrival<P>) {
    let slot = arrival.slot;
    let admission_seq = arrival.admission_seq;
    {
        // A mark moves the rate schedule; the queue learns it before this
        // arrival starts anything.
        let origin = shared.lock().expect("link state poisoned").origin;
        if let Some(origin) = origin
            && queue.origin != Some(origin)
        {
            queue.restart_schedule(origin);
        }
    }
    let admission = queue.admit(arrival);
    record_started(queue, shared);
    let mut shared = shared.lock().expect("link state poisoned");
    shared.totals.arrivals += 1;
    shared.totals.bytes_ahead_log2.record(admission.ahead);
    let relay = shared.relay(slot, admission_seq);
    relay.stats.bytes_ahead_log2.record(admission.ahead);
    if admission.queued {
        relay.stats.packets += 1;
    }
    for dropped in admission.dropped {
        shared
            .relay(dropped.slot, dropped.admission_seq)
            .stats
            .bottleneck_drops += 1;
        shared.totals.bottleneck_drops += 1;
        // The payload holds the relay's packet lease; dropping it here is the
        // packet's end.
        drop(dropped.payload);
    }
}

fn record_started<P>(queue: &mut LinkQueue<P>, shared: &Mutex<Shared>) {
    let started = queue.take_started();
    if started.is_empty() {
        return;
    }
    let step_at = match (queue.config.step, queue.origin) {
        (Some(step), Some(origin)) => Some(origin + Duration::from_millis(step.after_mark_ms)),
        _ => None,
    };
    let mut shared = shared.lock().expect("link state poisoned");
    for service in started {
        if service.rate_bps != shared.rate_bps {
            shared.totals.rate_changes += 1;
            shared.rate_bps = service.rate_bps;
        }
        let residence_us = micros(service.departure - service.arrival);
        shared.totals.busy_ns = shared
            .totals
            .busy_ns
            .saturating_add(service_ns(service.bytes, service.rate_bps));
        shared.totals.departed_bytes += service.bytes;
        shared.totals.residence_log2_us.record(residence_us);
        let relay = shared.relay(service.slot, service.admission_seq);
        relay.stats.bytes += service.bytes;
        relay.stats.residence_log2_us.record(residence_us);
        relay.stats.max_residence_us = relay.stats.max_residence_us.max(residence_us);
        if let Some(step_at) = step_at
            && service.arrival >= step_at
        {
            let index = usize::try_from(micros(service.arrival - step_at) / STEP_TRACE_SLOT_US)
                .unwrap_or(usize::MAX);
            if index < STEP_TRACE_SLOTS {
                let trace = relay.step_trace.get_or_insert_with(StepTrace::default);
                let value = u32::try_from(residence_us).unwrap_or(u32::MAX);
                trace.0[index] = trace.0[index].max(value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fifo(rate_bps: u64, buffer_bytes: u64) -> LinkQueue<u32> {
        LinkQueue::new(
            LinkConfig {
                role: Role::Browser,
                direction: LinkDirection::Down,
                rate_bps,
                buffer_bytes,
                fq: false,
                step: None,
            },
            16,
        )
    }

    fn arrival(at: Instant, slot: usize, bytes: u64, payload: u32) -> Arrival<u32> {
        Arrival {
            at,
            slot,
            admission_seq: slot as u64 + 1,
            bytes,
            payload,
        }
    }

    fn drain(queue: &mut LinkQueue<u32>) -> Vec<(Instant, u32)> {
        let mut out = Vec::new();
        while queue.next_departure().is_some() {
            let committed = queue.pop_departure().expect("scheduled");
            out.push((committed.departure, committed.payload));
        }
        out
    }

    #[test]
    fn parses_rate_buffer_fq_and_step() {
        let link = LinkConfig::parse(Role::Browser, LinkDirection::Down, "25000000:640000")
            .expect("plain link");
        assert_eq!((link.rate_bps, link.buffer_bytes, link.fq), (25_000_000, 640_000, false));
        assert_eq!(link.step, None);
        let link = LinkConfig::parse(
            Role::Browser,
            LinkDirection::Down,
            "25000000:640000:fq@2000=5000000",
        )
        .expect("fq with a step");
        assert!(link.fq);
        assert_eq!(
            link.step,
            Some(RateStep {
                after_mark_ms: 2_000,
                rate_bps: 5_000_000
            })
        );
        assert_eq!(link.lowest_rate_bps(), 5_000_000);
        for invalid in ["", "0:1500", "1000:0", "1000:1500:fifo", "1000:1500@2", "1000:100"] {
            assert!(
                LinkConfig::parse(Role::Daemon, LinkDirection::Up, invalid).is_err(),
                "{invalid:?} must not parse"
            );
        }
    }

    #[test]
    fn a_fifo_serializes_at_its_rate_and_drops_what_its_buffer_cannot_hold() {
        // 10 Mbit/s: a 1,250-byte packet takes exactly one millisecond.
        let mut queue = fifo(10_000_000, 3_000);
        let t0 = Instant::now();
        let mut ahead = Vec::new();
        for payload in 0..4 {
            let admission = queue.admit(arrival(t0, 0, 1_250, payload));
            ahead.push((admission.ahead, admission.queued));
        }
        // Two fit behind nothing and one; a third would make 3,750 > 3,000.
        assert_eq!(
            ahead,
            vec![(0, true), (1_250, true), (2_500, false), (2_500, false)]
        );
        let departures = drain(&mut queue);
        assert_eq!(
            departures,
            vec![
                (t0 + Duration::from_millis(1), 0),
                (t0 + Duration::from_millis(2), 1)
            ]
        );
        // Half a packet later the backlog is one and a half packets.
        let mut queue = fifo(10_000_000, 1_000_000);
        let _ = queue.admit(arrival(t0, 0, 1_250, 0));
        let _ = queue.admit(arrival(t0, 0, 1_250, 1));
        let later = queue.admit(arrival(t0 + Duration::from_micros(500), 0, 1_250, 2));
        assert_eq!(later.ahead, 625 + 1_250);
        assert_eq!(
            drain(&mut queue).last(),
            Some(&(t0 + Duration::from_millis(3), 2))
        );
    }

    #[test]
    fn one_fifo_is_shared_by_every_relay_that_crosses_it() {
        // An echo on one relay waits behind the bulk relay's queue.
        let mut queue = fifo(10_000_000, 1_000_000);
        let t0 = Instant::now();
        for payload in 0..10 {
            assert!(queue.admit(arrival(t0, 1, 1_250, payload)).queued);
        }
        let echo = queue.admit(arrival(t0 + Duration::from_micros(10), 0, 100, 99));
        // Nine waiting packets and 990 µs of the one in service.
        assert_eq!(echo.ahead, 9 * 1_250 + 1_238);
        let departures = drain(&mut queue);
        let (echo_departure, _) = departures
            .iter()
            .find(|(_, payload)| *payload == 99)
            .expect("the echo departs");
        assert_eq!(*echo_departure, t0 + Duration::from_micros(10_080));
    }

    #[test]
    fn an_idle_link_starts_each_arrival_at_its_own_time_whenever_it_is_admitted() {
        let mut queue = fifo(10_000_000, 1_000_000);
        let t0 = Instant::now();
        let _ = queue.admit(arrival(t0, 0, 1_250, 0));
        let _ = queue.admit(arrival(t0 + Duration::from_millis(5), 0, 1_250, 1));
        assert_eq!(
            drain(&mut queue),
            vec![
                (t0 + Duration::from_millis(1), 0),
                (t0 + Duration::from_millis(6), 1)
            ]
        );
    }

    #[test]
    fn fq_serves_flows_round_robin_and_drops_from_the_longest() {
        let mut queue = LinkQueue::new(
            LinkConfig {
                role: Role::Browser,
                direction: LinkDirection::Down,
                rate_bps: 12_000_000,
                buffer_bytes: 8 * 1_500,
                fq: true,
                step: None,
            },
            16,
        );
        let t0 = Instant::now();
        // Bulk fills the buffer: 8 packets, the first already in service.
        for payload in 0..8 {
            assert!(queue.admit(arrival(t0, 3, 1_500, payload)).queued);
        }
        // An echo from another flow pushes out bulk's head, not itself, and
        // leaves after the one bulk packet in service.
        let echo = queue.admit(arrival(t0, 0, 100, 99));
        assert!(echo.queued);
        assert_eq!(echo.ahead, 0);
        assert_eq!(echo.dropped.len(), 1);
        // Round robin: bulk's turn comes first, then the echo's, not after
        // bulk's whole queue. A 1,500-byte packet takes 1 ms at 12 Mbit/s and
        // the 100-byte echo 66.667 µs.
        let departures = drain(&mut queue);
        assert_eq!(
            departures[..3],
            [
                (t0 + Duration::from_millis(1), 0),
                (t0 + Duration::from_millis(2), 2),
                (t0 + Duration::from_nanos(2_066_667), 99),
            ]
        );
        // The pushed-out packet was bulk's oldest waiting one.
        assert!(departures.iter().all(|(_, payload)| *payload != 1));
        assert_eq!(departures.len(), 8);
    }

    #[test]
    fn a_rate_step_applies_to_services_starting_after_the_mark_plus_its_delay() {
        let mut queue = LinkQueue::new(
            LinkConfig {
                role: Role::Browser,
                direction: LinkDirection::Down,
                rate_bps: 10_000_000,
                buffer_bytes: 1_000_000,
                fq: false,
                step: Some(RateStep {
                    after_mark_ms: 2,
                    rate_bps: 5_000_000,
                }),
            },
            16,
        );
        let t0 = Instant::now();
        // Before any mark the base rate holds indefinitely.
        let _ = queue.admit(arrival(t0, 0, 1_250, 0));
        assert_eq!(queue.next_departure(), Some(t0 + Duration::from_millis(1)));
        let _ = queue.pop_departure();
        let mark = t0 + Duration::from_millis(10);
        queue.restart_schedule(mark);
        for payload in 1..5 {
            let _ = queue.admit(arrival(mark, 0, 1_250, payload));
        }
        // Services start at +0, +1 ms (base rate), +2 ms (stepped: 2 ms each).
        assert_eq!(
            drain(&mut queue),
            vec![
                (mark + Duration::from_millis(1), 1),
                (mark + Duration::from_millis(2), 2),
                (mark + Duration::from_millis(4), 3),
                (mark + Duration::from_millis(6), 4),
            ]
        );
    }

    #[test]
    fn log2_buckets_hold_powers_of_two() {
        let mut histogram = Log2Histogram::default();
        for value in [0, 1, 2, 3, 4, 1_000_000_000] {
            histogram.record(value);
        }
        assert_eq!(histogram.0[0], 1);
        assert_eq!(histogram.0[1], 1);
        assert_eq!(histogram.0[2], 2);
        assert_eq!(histogram.0[3], 1);
        assert_eq!(histogram.0[LOG2_BUCKETS - 1], 1);
        assert_eq!(histogram.quantile_upper(50, 100), 4);
    }
}
