//! Deadline-aware display representation planning.
//!
//! The planner compares complete packet schedules, never `bytes / bandwidth`.
//! It keeps bounded empirical posteriors for sender service, achieved ratio,
//! receiver incremental service, and carrier loss. All state is fixed-capacity
//! and allocation-free after construction.

use crate::display::policy::DisplayPolicy;

pub const SIZE_CLASSES: usize = 6;
pub const RATIO_CLASSES: usize = 4;
pub const MAX_PLANNED_ROWS: usize = merkur_codec::MAX_TERMINAL_ROWS;
pub const DICTIONARY_CLASSES: usize = 2;
const CONTENT_CLASSES: usize = 3;
const EXECUTION_LANES: usize = 3;
const POSTERIOR_SAMPLES: usize = 32;
const POSTERIOR_WARM_SAMPLES: u8 = 8;
const RELIABLE_RECORD_LENGTH_BYTES: usize = std::mem::size_of::<u32>();
const TAIL_PERCENTILE: f64 = 0.95;
const GROUP_LENGTHS: usize = merkur_fec::FEC_MAX_DATA + 1;
const SHARD_SIZES: usize = DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES + 1;
const MAX_FRONTIER_STATES: usize = GROUP_LENGTHS * SHARD_SIZES;
const CANDIDATE_DIRTY_WORDS: usize = MAX_FRONTIER_STATES.div_ceil(u64::BITS as usize);
const MAX_PLANNER_STATES: usize = 1 + MAX_PLANNED_ROWS * MAX_FRONTIER_STATES;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DictionaryClass {
    Plain,
    Finalized,
}

impl DictionaryClass {
    #[inline]
    pub const fn index(self) -> usize {
        match self {
            Self::Plain => 0,
            Self::Finalized => 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentClass {
    Sparse,
    Text,
    Color,
}

impl ContentClass {
    #[inline]
    pub(crate) const fn index(self) -> usize {
        match self {
            Self::Sparse => 0,
            Self::Text => 1,
            Self::Color => 2,
        }
    }
}

const CONTENT_CLASS_BY_INDEX: [ContentClass; CONTENT_CLASSES] = [
    ContentClass::Sparse,
    ContentClass::Text,
    ContentClass::Color,
];

/// Cell census of one encoded row span, taken once at capture. It classifies
/// the row; the planner then reasons about spans by the bytes each class
/// contributes, never by re-counting cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ContentEvidence {
    pub(crate) cells: u32,
    pub(crate) visible: u32,
    pub(crate) styled: u32,
}

impl ContentEvidence {
    pub(crate) fn observe(&mut self, cells: &[merkur_codec::CellRepr]) {
        for cell in cells {
            self.cells += 1;
            if cell.codepoint != 0 && cell.codepoint != u32::from(b' ') {
                self.visible += 1;
            }
            if cell.fg != merkur_codec::CellRepr::BLANK.fg
                || cell.bg != merkur_codec::CellRepr::BLANK.bg
            {
                self.styled += 1;
            }
        }
    }

    pub(crate) fn class(self) -> ContentClass {
        if self.visible.saturating_mul(4) < self.cells {
            ContentClass::Sparse
        } else if self.styled.saturating_mul(4) > self.visible.max(1) {
            ContentClass::Color
        } else {
            ContentClass::Text
        }
    }
}

/// One captured row as the partition planner sees it: its encoded bytes and
/// the class its own census selected.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PlannedRow {
    pub(crate) bytes: usize,
    pub(crate) class: ContentClass,
}

impl PlannedRow {
    pub(crate) const EMPTY: Self = Self {
        bytes: 0,
        class: ContentClass::Sparse,
    };

    #[cfg(test)]
    pub(crate) const fn of(bytes: usize, class: ContentClass) -> Self {
        Self { bytes, class }
    }
}

/// Bytes each class contributes to rows `start..end`, from a prefix sum.
#[inline]
fn span_class_bytes(
    prefix: &[[u32; CONTENT_CLASSES]],
    start: usize,
    end: usize,
) -> [usize; CONTENT_CLASSES] {
    std::array::from_fn(|class| (prefix[end][class] - prefix[start][class]) as usize)
}

/// The class whose bytes dominate a span. A span mixes classes only when the
/// planner priced the mix cheaper than a cut, and its evidence — achieved
/// ratio, sender and receiver service — belongs to the content that made up
/// most of it. Ties go to the harder class, so an even mix never inherits the
/// easier posterior.
#[inline]
pub(crate) fn content_class_by_bytes(bytes: [usize; CONTENT_CLASSES]) -> ContentClass {
    let mut major = 0;
    for (class, &class_bytes) in bytes.iter().enumerate() {
        if class_bytes >= bytes[major] {
            major = class;
        }
    }
    CONTENT_CLASS_BY_INDEX[major]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionLane {
    Inline,
    Interactive,
    Bulk,
}

impl ExecutionLane {
    #[inline]
    const fn index(self) -> usize {
        match self {
            Self::Inline => 0,
            Self::Interactive => 1,
            Self::Bulk => 2,
        }
    }
}

#[derive(Clone, Copy)]
struct BoundedPosterior {
    samples: [f64; POSTERIOR_SAMPLES],
    cursor: u8,
    count: u8,
}

impl Default for BoundedPosterior {
    fn default() -> Self {
        Self {
            samples: [0.0; POSTERIOR_SAMPLES],
            cursor: 0,
            count: 0,
        }
    }
}

impl BoundedPosterior {
    #[inline]
    fn observe(&mut self, value: f64) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        self.samples[usize::from(self.cursor)] = value;
        self.cursor = (usize::from(self.cursor) + 1).wrapping_rem(POSTERIOR_SAMPLES) as u8;
        self.count = self.count.saturating_add(1).min(POSTERIOR_SAMPLES as u8);
    }

    #[inline]
    fn reset(&mut self) {
        self.cursor = 0;
        self.count = 0;
    }

    /// One Welford update with the sample at `index`, the recurrence both
    /// `moments` and `predictive_uppers` run.
    #[inline]
    fn welford_step(mean: &mut f64, m2: &mut f64, index: usize, sample: f64) {
        let delta = sample - *mean;
        *mean += delta / (index + 1) as f64;
        *m2 += delta * (sample - *mean);
    }

    #[inline]
    fn welford_moments(count: usize, mean: f64, m2: f64) -> (f64, f64) {
        let variance = if count > 1 {
            m2 / (count - 1) as f64
        } else {
            0.0
        };
        (mean, variance.max(0.0))
    }

    fn moments(&self) -> Option<(f64, f64)> {
        let count = usize::from(self.count);
        if count == 0 {
            return None;
        }
        let mut mean = 0.0;
        let mut m2 = 0.0;
        for (index, sample) in self.samples[..count].iter().copied().enumerate() {
            Self::welford_step(&mut mean, &mut m2, index, sample);
        }
        Some(Self::welford_moments(count, mean, m2))
    }

    /// One window's bound from a fresh scan: the reference every production
    /// read reproduces bit for bit.
    #[cfg(test)]
    fn predictive_upper(&self, cold_upper: f64) -> f64 {
        self.upper_from_moments(self.moments(), cold_upper)
    }

    /// `predictive_upper` of several windows at once. Each window's scan is
    /// one chain of dependent divisions; stepping independent windows together
    /// overlaps the chains while each window performs the same operations in
    /// the same order, so every bound is bit-identical. Kept out of line so its
    /// unrolled steps do not reshape the caller's code.
    #[inline(never)]
    fn predictive_uppers<const N: usize>(windows: [&Self; N], cold_uppers: [f64; N]) -> [f64; N] {
        let mut mean = [0.0; N];
        let mut m2 = [0.0; N];
        let longest = windows
            .iter()
            .map(|window| usize::from(window.count))
            .max()
            .unwrap_or(0);
        for index in 0..longest {
            for (lane, window) in windows.iter().enumerate() {
                if index < usize::from(window.count) {
                    Self::welford_step(
                        &mut mean[lane],
                        &mut m2[lane],
                        index,
                        window.samples[index],
                    );
                }
            }
        }
        std::array::from_fn(|lane| {
            let count = usize::from(windows[lane].count);
            let moments = (count > 0).then(|| Self::welford_moments(count, mean[lane], m2[lane]));
            windows[lane].upper_from_moments(moments, cold_uppers[lane])
        })
    }

    /// The predictive bound from this window's `moments`, however obtained.
    #[inline]
    fn upper_from_moments(&self, moments: Option<(f64, f64)>, cold_upper: f64) -> f64 {
        let Some((mean, variance)) = moments else {
            return cold_upper;
        };
        let n = f64::from(self.count.max(1));
        let empirical = mean + 1.645 * (variance * (1.0 + 1.0 / n)).sqrt();
        // A single low observation has zero sample variance and is not enough
        // evidence to erase the cold upper bound. Keep the prior as a floor
        // until the bounded window is warm; upward steps remain visible on the
        // very first sample through `empirical`.
        if self.count < POSTERIOR_WARM_SAMPLES {
            empirical.max(cold_upper)
        } else {
            empirical
        }
    }
}

/// A window read many times per write. Every mutation refreshes its moments
/// with the same scan `moments` performs, so a read costs the tail formula
/// alone and returns the bound a fresh scan would, bit for bit.
#[derive(Clone, Copy, Default)]
struct ReadMostlyPosterior {
    window: BoundedPosterior,
    moments: Option<(f64, f64)>,
}

impl ReadMostlyPosterior {
    #[inline]
    fn observe(&mut self, value: f64) {
        self.window.observe(value);
        self.moments = self.window.moments();
    }

    #[inline]
    fn reset(&mut self) {
        self.window.reset();
        self.moments = None;
    }

    #[inline]
    fn predictive_upper(&self, cold_upper: f64) -> f64 {
        self.window.upper_from_moments(self.moments, cold_upper)
    }
}

#[inline]
pub const fn size_class(bytes: usize) -> usize {
    if bytes <= 512 {
        0
    } else if bytes <= 1_024 {
        1
    } else if bytes <= 2_048 {
        2
    } else if bytes <= 4_096 {
        3
    } else if bytes <= 8_192 {
        4
    } else {
        5
    }
}

#[inline]
pub fn ratio_class(ratio: f64) -> usize {
    if ratio <= 0.125 {
        0
    } else if ratio <= 0.25 {
        1
    } else if ratio <= 0.5 {
        2
    } else {
        3
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CarrierDeliveryQuote {
    pub one_way_us: f64,
    pub jitter_upper_us: f64,
    pub congestion_window_bytes: u64,
    pub bytes_in_flight: u64,
    pub send_buffer_occupied_bytes: usize,
    pub mtu_bytes: usize,
    /// Congestion controller's current pacer rate. Zero means the controller
    /// does not expose one and the cwnd/RTT quote is used.
    pub pacing_rate_bps: u64,
    pub loss_upper: f64,
    /// Exact ordered hops for a relayed carrier. Aggregate public fields remain
    /// useful telemetry, while scheduling must not collapse two independent
    /// queues/cwnd/pacers into one fictitious bottleneck.
    pub(crate) serial_hops: Option<[CarrierHopQuote; 2]>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct CarrierHopQuote {
    one_way_us: f64,
    jitter_upper_us: f64,
    congestion_window_bytes: u64,
    bytes_in_flight: u64,
    send_buffer_occupied_bytes: usize,
    mtu_bytes: usize,
    pacing_rate_bps: u64,
}

impl Default for CarrierDeliveryQuote {
    fn default() -> Self {
        Self {
            one_way_us: 10_000.0,
            jitter_upper_us: 0.0,
            congestion_window_bytes: 12_000,
            bytes_in_flight: 0,
            send_buffer_occupied_bytes: 0,
            mtu_bytes: 1_200,
            pacing_rate_bps: 0,
            loss_upper: 0.0,
            serial_hops: None,
        }
    }
}

impl CarrierDeliveryQuote {
    fn as_hop(self) -> CarrierHopQuote {
        CarrierHopQuote {
            one_way_us: self.one_way_us,
            jitter_upper_us: self.jitter_upper_us,
            congestion_window_bytes: self.congestion_window_bytes,
            bytes_in_flight: self.bytes_in_flight,
            send_buffer_occupied_bytes: self.send_buffer_occupied_bytes,
            mtu_bytes: self.mtu_bytes,
            pacing_rate_bps: self.pacing_rate_bps,
        }
    }

    pub(crate) fn serial(upstream: Self, downstream: Self) -> Self {
        let pacing_rate_bps = match (upstream.pacing_rate_bps, downstream.pacing_rate_bps) {
            (0, right) => right,
            (left, 0) => left,
            (left, right) => left.min(right),
        };
        Self {
            one_way_us: upstream.one_way_us + downstream.one_way_us,
            jitter_upper_us: upstream.jitter_upper_us + downstream.jitter_upper_us,
            congestion_window_bytes: upstream
                .congestion_window_bytes
                .min(downstream.congestion_window_bytes),
            bytes_in_flight: upstream
                .bytes_in_flight
                .saturating_add(downstream.bytes_in_flight),
            send_buffer_occupied_bytes: upstream
                .send_buffer_occupied_bytes
                .saturating_add(downstream.send_buffer_occupied_bytes),
            mtu_bytes: upstream.mtu_bytes.min(downstream.mtu_bytes),
            pacing_rate_bps,
            loss_upper: 1.0
                - (1.0 - upstream.loss_upper.clamp(0.0, 1.0))
                    * (1.0 - downstream.loss_upper.clamp(0.0, 1.0)),
            serial_hops: Some([upstream.as_hop(), downstream.as_hop()]),
        }
    }

    fn hop_pacing_bytes_per_us(hop: CarrierHopQuote) -> f64 {
        let rtt_us = (hop.one_way_us * 2.0).max(1.0);
        let cwnd = hop.congestion_window_bytes.max(hop.mtu_bytes.max(1) as u64);
        if hop.pacing_rate_bps > 0 {
            hop.pacing_rate_bps as f64 / 8_000_000.0
        } else {
            cwnd as f64 * 1.25 / rtt_us
        }
        .max(0.001)
    }

    fn hop_fixed_delivery_us(hop: CarrierHopQuote) -> f64 {
        let cwnd = hop.congestion_window_bytes.max(hop.mtu_bytes.max(1) as u64);
        let debt = hop
            .bytes_in_flight
            .saturating_add(hop.send_buffer_occupied_bytes as u64);
        hop.one_way_us
            + hop.jitter_upper_us
            + debt.saturating_sub(cwnd) as f64 / Self::hop_pacing_bytes_per_us(hop)
    }

    fn hop_serialization_us(hop: CarrierHopQuote, wire_bytes: usize) -> f64 {
        wire_bytes as f64 / Self::hop_pacing_bytes_per_us(hop)
    }

    /// Preparation can overlap bytes already waiting ahead of this plan.
    pub fn preparation_slack_us(&self) -> f64 {
        let hop = self
            .serial_hops
            .map_or_else(|| self.as_hop(), |hops| hops[0]);
        let cwnd = hop.congestion_window_bytes.max(hop.mtu_bytes.max(1) as u64);
        hop.bytes_in_flight
            .saturating_add(hop.send_buffer_occupied_bytes as u64)
            .saturating_sub(cwnd) as f64
            / Self::hop_pacing_bytes_per_us(hop)
    }

    #[inline]
    pub(crate) fn fixed_delivery_us(&self) -> f64 {
        self.serial_hops.map_or_else(
            || Self::hop_fixed_delivery_us(self.as_hop()),
            |hops| {
                let hop_network_us: f64 = hops
                    .iter()
                    .map(|hop| hop.one_way_us + hop.jitter_upper_us)
                    .sum();
                let exact_hops: f64 = hops.into_iter().map(Self::hop_fixed_delivery_us).sum();
                // `carrier_quote` replaces the aggregate network term with a
                // bounded recent posterior. Preserve exact hop queues/pacers,
                // then add only the posterior's positive end-to-end tail.
                let learned_network_tail =
                    (self.one_way_us + self.jitter_upper_us - hop_network_us).max(0.0);
                exact_hops + learned_network_tail
            },
        )
    }

    #[inline]
    pub(crate) fn serialization_us(&self, wire_bytes: usize) -> f64 {
        self.serial_hops.map_or_else(
            || Self::hop_serialization_us(self.as_hop(), wire_bytes),
            |hops| {
                hops.into_iter()
                    .map(|hop| Self::hop_serialization_us(hop, wire_bytes))
                    .sum()
            },
        )
    }

    /// Predicted p95/CVaR-like delivery time for the complete remaining plan.
    pub fn earliest_delivery_us(&self, data_bytes: usize, packet_count: usize) -> f64 {
        // `loss_upper` is already the end-to-end probability (the exact
        // `1-(1-up)(1-down)` quote, or its bounded recent posterior). Applying
        // each hop's loss again would double-count a relayed loss. A failed
        // logical delivery costs one end-to-end confirmation/retry cycle.
        let packets = self.serial_hops.map_or(packet_count, |hops| {
            hops.into_iter().fold(packet_count, |count, hop| {
                count.max(data_bytes.div_ceil(hop.mtu_bytes.max(1)))
            })
        });
        let failure = 1.0
            - (1.0 - self.loss_upper.clamp(0.0, 1.0)).powi(packets.min(i32::MAX as usize) as i32);
        let recovery_cycle_us = self.serial_hops.map_or_else(
            || (self.one_way_us * 2.0).max(1.0),
            |hops| (hops.into_iter().map(|hop| hop.one_way_us).sum::<f64>() * 2.0).max(1.0),
        );
        let loss_tail = geometric_tail_cvar_cycles(failure, TAIL_PERCENTILE) * recovery_cycle_us;
        self.fixed_delivery_us() + self.serialization_us(data_bytes) + loss_tail
    }

    /// Sufficient dominance for every raw/compressed partition and recovery
    /// shape. A faster small-packet quote alone is insufficient: propagation
    /// and serialization can trade places as a repaint grows. Compare each
    /// monotone cost term, including MTU and both retry-cycle interpretations.
    fn dominates(self, other: Self) -> bool {
        let retry_cycle = |quote: Self| {
            quote.serial_hops.map_or(quote.one_way_us, |hops| {
                hops.into_iter().map(|hop| hop.one_way_us).sum()
            })
        };
        self.fixed_delivery_us() <= other.fixed_delivery_us()
            && self.serialization_us(1) <= other.serialization_us(1)
            && self.loss_upper <= other.loss_upper
            && self.one_way_us <= other.one_way_us
            && retry_cycle(self) <= retry_cycle(other)
            && self.mtu_bytes >= other.mtu_bytes
            && self.preparation_slack_us() >= other.preparation_slack_us()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PlanningContext {
    pub carrier: CarrierDeliveryQuote,
    /// The other live carrier, when present. Representation and partition
    /// choice must compare complete schedules on both, before discarding raw
    /// bytes or paying for compression against a small-packet surrogate.
    pub alternate_carrier: Option<CarrierDeliveryQuote>,
    /// Largest plaintext accepted by the datagram lane. The protected planner
    /// target may be smaller; an indivisible row between the two remains one
    /// unprotected datagram, not a fictitious reliable record.
    pub datagram_max_payload_bytes: usize,
    pub fec_group_size: usize,
    pub fec_enabled: bool,
    /// Actual open adjacent group emitted by an earlier adaptive sizing pass.
    /// Feeding it back makes iterative compression sizing and parity precompute
    /// use identical 1/2/4/5 group boundaries.
    pub initial_fec_group_len: usize,
    pub initial_fec_group_max_bytes: usize,
    pub receiver_service_debt_us: f64,
    /// Earliest raw send relative to now. Compression service before this is
    /// hidden under work/pacing that had to happen anyway.
    pub earliest_uncompressed_send_us: f64,
    /// Higher-priority preparation jobs delayed by occupying the selected
    /// lane. The planner multiplies this by the candidate's own compression
    /// service, so a multi-batch request neither prices every candidate as the
    /// whole request nor charges an opportunity cost when compression is not
    /// selected.
    pub higher_priority_preparation_jobs: usize,
}

impl Default for PlanningContext {
    fn default() -> Self {
        Self {
            carrier: CarrierDeliveryQuote::default(),
            alternate_carrier: None,
            datagram_max_payload_bytes: 1_100,
            fec_group_size: 4,
            fec_enabled: true,
            initial_fec_group_len: 0,
            initial_fec_group_max_bytes: 0,
            receiver_service_debt_us: 0.0,
            earliest_uncompressed_send_us: 0.0,
            higher_priority_preparation_jobs: 0,
        }
    }
}

impl PlanningContext {
    fn alternate(self) -> Option<Self> {
        self.alternate_carrier.map(|carrier| Self {
            carrier,
            alternate_carrier: None,
            earliest_uncompressed_send_us: carrier.preparation_slack_us(),
            ..self
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Representation {
    Raw,
    Compressed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeliveryLane {
    Datagram,
    Reliable,
}

#[derive(Clone, Copy, Debug)]
pub struct PacketPlan {
    #[cfg(test)]
    pub data_packets: usize,
    #[cfg(test)]
    pub repair_packets: usize,
    #[cfg(test)]
    pub wire_bytes: usize,
    pub tail_latency_us: f64,
}

/// Physical bytes admitted for one display datagram. The channel byte is
/// outside Noise and every sealed record carries the fixed Noise framing.
#[inline]
pub(crate) const fn display_datagram_wire_len(plaintext_len: usize) -> usize {
    1 + plaintext_len + crate::e2e::FRAME_OVERHEAD
}

/// Physical bytes contributed by one record on an already-open persistent
/// reliable lane. Stream binding is paid once per carrier generation, not once
/// per record; a record owns only its u32 length and Noise-sealed body.
#[inline]
pub(crate) const fn display_reliable_record_wire_len(plaintext_len: usize) -> usize {
    RELIABLE_RECORD_LENGTH_BYTES + plaintext_len + crate::e2e::FRAME_OVERHEAD
}

/// Datagram repair width for one adjacent group at its widest plaintext data
/// shard. Two recovery shards are useful only while both plus the exact FEC
/// header fit one physical datagram. A k=1 group has no algebraic parity.
#[inline]
pub(crate) const fn fec_recovery_shard_count(group_len: usize, shard_size: usize) -> usize {
    if group_len < 2 || shard_size == 0 {
        return 0;
    }
    let available = DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES
        .saturating_sub(merkur_codec::DISPLAY_FEC_HEADER_BYTES);
    if shard_size <= available / DisplayPolicy::FEC_RECOVERY_SHARD_COUNT {
        DisplayPolicy::FEC_RECOVERY_SHARD_COUNT
    } else if shard_size <= available {
        DisplayPolicy::FEC_SINGLE_RECOVERY_SHARD_COUNT
    } else {
        0
    }
}

#[inline]
fn binomial_probability_more_than(trials: usize, recoverable: usize, probability: f64) -> f64 {
    let p = probability.clamp(0.0, 1.0);
    if trials == 0 || p == 0.0 || recoverable >= trials {
        return 0.0;
    }
    if p == 1.0 {
        return 1.0;
    }
    let mut probability_at = (1.0 - p).powi(trials.min(i32::MAX as usize) as i32);
    let mut covered = probability_at;
    for losses in 1..=recoverable {
        probability_at *= (trials + 1 - losses) as f64 / losses as f64 * p / (1.0 - p);
        covered += probability_at;
    }
    (1.0 - covered).clamp(0.0, 1.0)
}

/// Upper-tail number of extra delivery rounds for a geometric retry process.
/// This is the exact discrete CVaR at `percentile`: unlike `p * RTT`, it keeps
/// a 9% one-packet tail visible at p95 and accounts for repeated tail loss.
fn geometric_tail_cvar_cycles(failure_probability: f64, percentile: f64) -> f64 {
    let q = failure_probability.clamp(0.0, 1.0);
    if q == 0.0 {
        return 0.0;
    }
    if q >= 1.0 {
        return f64::INFINITY;
    }
    let tail_mass = (1.0 - percentile.clamp(0.0, 0.999_999)).max(f64::EPSILON);
    let mut value_at_risk = 0usize;
    while q.powi((value_at_risk + 1).min(i32::MAX as usize) as i32) > tail_mass {
        value_at_risk += 1;
        if value_at_risk == 1_024 {
            return f64::INFINITY;
        }
    }
    let beyond_mass = q.powi((value_at_risk + 1) as i32);
    let beyond_weighted = beyond_mass * (value_at_risk as f64 + 1.0 + q / (1.0 - q));
    let at_var_mass = (tail_mass - beyond_mass).max(0.0);
    (at_var_mass * value_at_risk as f64 + beyond_weighted) / tail_mass
}

#[inline]
fn datagram_group_failure_probability(group_len: usize, recovery: usize, loss: f64) -> f64 {
    let p = loss.clamp(0.0, 1.0);
    if group_len == 0 {
        return 0.0;
    }
    if recovery == 0 {
        return 1.0 - (1.0 - p).powi(group_len.min(i32::MAX as usize) as i32);
    }
    // All recovery shards ride one repair datagram. If that datagram is lost,
    // any data loss is fatal; otherwise up to `recovery` data losses recover.
    let any_data_loss = 1.0 - (1.0 - p).powi(group_len.min(i32::MAX as usize) as i32);
    let too_many_data_losses = binomial_probability_more_than(group_len, recovery, p);
    (p * any_data_loss + (1.0 - p) * too_many_data_losses).clamp(0.0, 1.0)
}

fn single_record_plan(
    plaintext_bytes: usize,
    receiver_incremental_us: f64,
    context: PlanningContext,
) -> PacketPlan {
    let datagram = plaintext_bytes <= context.datagram_max_payload_bytes.max(1);
    let data_wire_bytes = if datagram {
        display_datagram_wire_len(plaintext_bytes)
    } else {
        display_reliable_record_wire_len(plaintext_bytes)
    };
    let data_packets = if datagram {
        1
    } else {
        data_wire_bytes.div_ceil(context.carrier.mtu_bytes.max(1))
    };
    let (_repair_packets, _complete_wire_bytes, delivery) = if datagram {
        let group_size = planned_fec_group_size(context);
        let group_len = context
            .initial_fec_group_len
            .min(group_size.saturating_sub(1))
            + 1;
        let shard_size = context.initial_fec_group_max_bytes.max(plaintext_bytes);
        let recovery = recovery_class(group_len, shard_size, context);
        let repair_packets = usize::from(recovery > 0);
        let repair_wire_bytes = if recovery == 0 {
            0
        } else {
            display_datagram_wire_len(
                merkur_codec::DISPLAY_FEC_HEADER_BYTES + recovery * shard_size,
            )
        };
        let complete_wire_bytes = data_wire_bytes.saturating_add(repair_wire_bytes);
        let incomplete =
            datagram_group_failure_probability(group_len, recovery, context.carrier.loss_upper);
        let delivery = context.carrier.fixed_delivery_us()
            + context.carrier.serialization_us(complete_wire_bytes)
            + geometric_tail_cvar_cycles(incomplete, TAIL_PERCENTILE)
                * (context.carrier.one_way_us * 2.0).max(1.0);
        (repair_packets, complete_wire_bytes, delivery)
    } else {
        (
            0,
            data_wire_bytes,
            context
                .carrier
                .earliest_delivery_us(data_wire_bytes, data_packets),
        )
    };
    PacketPlan {
        #[cfg(test)]
        data_packets,
        #[cfg(test)]
        repair_packets: _repair_packets,
        #[cfg(test)]
        wire_bytes: _complete_wire_bytes,
        tail_latency_us: delivery + context.receiver_service_debt_us + receiver_incremental_us,
    }
}

fn best_single_record_plan(
    plaintext_bytes: usize,
    receiver_incremental_us: f64,
    context: PlanningContext,
) -> PacketPlan {
    let primary = single_record_plan(plaintext_bytes, receiver_incremental_us, context);
    let Some(alternate) = context.alternate() else {
        return primary;
    };
    let alternate = single_record_plan(plaintext_bytes, receiver_incremental_us, alternate);
    if alternate.tail_latency_us < primary.tail_latency_us {
        alternate
    } else {
        primary
    }
}

#[derive(Clone, Copy, Debug)]
struct BatchCandidate {
    plaintext_bytes: usize,
    lane: DeliveryLane,
    representation: Representation,
    sender_service_us: f64,
    receiver_service_us: f64,
}

/// Exact prices for a span census within one carrier/profile invocation.
/// Row count selects a slot, but only equal byte censuses may reuse its price.
#[derive(Clone, Copy)]
struct SpanCostEntry {
    class_bytes: [usize; CONTENT_CLASSES],
    raw_bytes: usize,
    choices: [Option<(BatchCandidate, f64)>; 2],
}

#[derive(Clone, Copy, Debug)]
struct PlannerState {
    score_us: f64,
    open_group_len: u8,
    open_group_max: u16,
    predecessor: u32,
    end: u16,
    representation: Representation,
    /// Minimum base score up to this width in its retained open-length group.
    /// This u32 fits the state's existing alignment padding.
    prefix_best: u32,
}

impl PlannerState {
    const INVALID: Self = Self {
        score_us: f64::INFINITY,
        open_group_len: 0,
        open_group_max: 0,
        predecessor: 0,
        end: 0,
        representation: Representation::Raw,
        prefix_best: 0,
    };
}

/// Capacity-stable state for the exact partition search. The outer vectors are
/// fixed by the protocol row cap; their allocations are retained by the one
/// prepare-thread scratch across flushes. Every frontier is finite because an
/// open FEC group has at most four members and every shard is at most 1,084 B.
pub struct PlannerWorkspace {
    prefix: [usize; MAX_PLANNED_ROWS + 1],
    /// Per-class byte prefix sums, so a span's mix is one subtraction. u32 is
    /// exact for every legal frame and keeps the workspace under its bound.
    class_prefix: [[u32; CONTENT_CLASSES]; MAX_PLANNED_ROWS + 1],
    states: Vec<PlannerState>,
    frontier_starts: [u32; MAX_PLANNED_ROWS + 1],
    frontier_ends: [u32; MAX_PLANNED_ROWS + 1],
    frontier_groups: [[u32; GROUP_LENGTHS + 1]; MAX_PLANNED_ROWS + 1],
    suffix_lower_bound_us: [f64; MAX_PLANNED_ROWS + 1],
    suffix_ends: [u16; MAX_PLANNED_ROWS + 1],
    suffix_representations: [Representation; MAX_PLANNED_ROWS + 1],
    candidates: Vec<PlannerState>,
    /// Dense `(open_group_len, open_group_max)` scratch. It is fixed-size but
    /// heap-backed so embedding a planner in `DisplayScratch` does not put a
    /// 100+ KiB array on every owner/simulator construction stack. The box is
    /// allocated once with the workspace and never changes identity.
    candidate_best: Box<[PlannerState]>,
    /// Indexed occupancy preserves ascending group/shard traversal while
    /// clearing only touched candidates. Full resets walked 132 KiB twice per
    /// row even when the frontier had only a handful of reachable states.
    candidate_dirty: [u64; CANDIDATE_DIRTY_WORDS],
    group_close_cost_us: [[f64; SHARD_SIZES]; GROUP_LENGTHS],
    span_costs: Vec<Option<SpanCostEntry>>,
}

impl Default for PlannerWorkspace {
    fn default() -> Self {
        Self {
            prefix: [0; MAX_PLANNED_ROWS + 1],
            class_prefix: [[0; CONTENT_CLASSES]; MAX_PLANNED_ROWS + 1],
            states: Vec::with_capacity(MAX_PLANNED_ROWS * 8),
            frontier_starts: [0; MAX_PLANNED_ROWS + 1],
            frontier_ends: [0; MAX_PLANNED_ROWS + 1],
            frontier_groups: [[0; GROUP_LENGTHS + 1]; MAX_PLANNED_ROWS + 1],
            suffix_lower_bound_us: [0.0; MAX_PLANNED_ROWS + 1],
            suffix_ends: [0; MAX_PLANNED_ROWS + 1],
            suffix_representations: [Representation::Raw; MAX_PLANNED_ROWS + 1],
            candidates: Vec::with_capacity(MAX_PLANNED_ROWS * 4),
            candidate_best: vec![PlannerState::INVALID; GROUP_LENGTHS * SHARD_SIZES]
                .into_boxed_slice(),
            candidate_dirty: [0; CANDIDATE_DIRTY_WORDS],
            group_close_cost_us: [[0.0; SHARD_SIZES]; GROUP_LENGTHS],
            span_costs: vec![None; MAX_PLANNED_ROWS + 1],
        }
    }
}

/// Fixed-capacity result of the short-horizon partition dynamic program.
/// `ends[..count]` are exclusive row offsets in ascending order.
#[derive(Clone)]
pub struct BatchPartitionPlan {
    ends: [u16; MAX_PLANNED_ROWS],
    representations: [Representation; MAX_PLANNED_ROWS],
    count: usize,
    score_us: f64,
    /// Model-only gain from refining the relaxed partition's exact replay.
    /// Test attribution keeps this separate from actual solver CPU duration.
    #[cfg(test)]
    pub refinement_gain_us: f64,
    #[cfg(test)]
    pub relaxed_gap_us: f64,
}

impl Default for BatchPartitionPlan {
    fn default() -> Self {
        Self {
            ends: [0; MAX_PLANNED_ROWS],
            representations: [Representation::Raw; MAX_PLANNED_ROWS],
            count: 0,
            score_us: f64::INFINITY,
            #[cfg(test)]
            refinement_gain_us: 0.0,
            #[cfg(test)]
            relaxed_gap_us: 0.0,
        }
    }
}

impl BatchPartitionPlan {
    pub fn clear(&mut self) {
        self.count = 0;
        self.score_us = f64::INFINITY;
        #[cfg(test)]
        {
            self.refinement_gain_us = 0.0;
            self.relaxed_gap_us = 0.0;
        }
    }

    pub fn push(&mut self, end: usize, representation: Representation) {
        if self.count < self.ends.len() {
            self.ends[self.count] = end.min(u16::MAX as usize) as u16;
            self.representations[self.count] = representation;
            self.count += 1;
        }
    }

    pub fn reverse(&mut self) {
        self.ends[..self.count].reverse();
        self.representations[..self.count].reverse();
    }

    #[cfg(test)]
    fn iter(&self) -> impl Iterator<Item = (usize, Representation)> + '_ {
        self.ends[..self.count]
            .iter()
            .zip(&self.representations[..self.count])
            .map(|(end, representation)| (usize::from(*end), *representation))
    }

    pub fn get(&self, index: usize) -> Option<(usize, Representation)> {
        (index < self.count).then(|| (usize::from(self.ends[index]), self.representations[index]))
    }

    #[cfg(test)]
    fn score_us(&self) -> f64 {
        self.score_us
    }
}

pub struct GlobalDisplayPlanningModel {
    /// Exact cost input for packetization fixtures; production always measures.
    #[cfg(test)]
    pub(crate) sender_service_us_for_test: Option<f64>,
    /// A compression attempt writes one window; every solve reads its lane's
    /// eighteen.
    sender_service: [ReadMostlyPosterior;
        EXECUTION_LANES * SIZE_CLASSES * CONTENT_CLASSES * DICTIONARY_CLASSES],
}

impl Default for GlobalDisplayPlanningModel {
    fn default() -> Self {
        Self {
            #[cfg(test)]
            sender_service_us_for_test: None,
            sender_service: [ReadMostlyPosterior::default();
                EXECUTION_LANES * SIZE_CLASSES * CONTENT_CLASSES * DICTIONARY_CLASSES],
        }
    }
}

impl GlobalDisplayPlanningModel {
    fn sender_index(
        lane: ExecutionLane,
        bytes: usize,
        content: ContentClass,
        dictionary: DictionaryClass,
    ) -> usize {
        (((lane.index() * SIZE_CLASSES + size_class(bytes)) * CONTENT_CLASSES + content.index())
            * DICTIONARY_CLASSES)
            + dictionary.index()
    }

    pub fn observe_sender_service(
        &mut self,
        lane: ExecutionLane,
        bytes: usize,
        content: ContentClass,
        dictionary: DictionaryClass,
        service_us: f64,
    ) {
        #[cfg(test)]
        let service_us = self.sender_service_us_for_test.unwrap_or(service_us);
        self.sender_service[Self::sender_index(lane, bytes, content, dictionary)]
            .observe(service_us);
    }

    pub fn sender_service_upper_us(
        &self,
        lane: ExecutionLane,
        bytes: usize,
        content: ContentClass,
        dictionary: DictionaryClass,
    ) -> f64 {
        // Cold state is conservative but finite; the first real attempt
        // replaces it for this machine/lane/content class.
        let cold = 20.0 + bytes as f64 * 0.01;
        self.sender_service[Self::sender_index(lane, bytes, content, dictionary)]
            .predictive_upper(cold)
    }
}

#[inline]
fn recovery_class(group_len: usize, shard_size: usize, context: PlanningContext) -> usize {
    if context.fec_enabled {
        fec_recovery_shard_count(group_len, shard_size)
    } else {
        0
    }
}

#[inline]
fn planned_fec_group_size(context: PlanningContext) -> usize {
    context.fec_group_size.clamp(1, merkur_fec::FEC_MAX_DATA)
}

pub(crate) fn group_close_cost_us(
    carrier: CarrierDeliveryQuote,
    context: PlanningContext,
    group_len: usize,
    shard_size: usize,
) -> f64 {
    if group_len == 0 {
        return 0.0;
    }
    let recovery = recovery_class(group_len, shard_size, context);
    let repair_wire_bytes = if recovery == 0 {
        0
    } else {
        display_datagram_wire_len(
            merkur_codec::DISPLAY_FEC_HEADER_BYTES + recovery.saturating_mul(shard_size),
        )
    };
    let incomplete = datagram_group_failure_probability(group_len, recovery, carrier.loss_upper);
    carrier.serialization_us(repair_wire_bytes)
        + geometric_tail_cvar_cycles(incomplete, TAIL_PERCENTILE)
            * (carrier.one_way_us * 2.0).max(1.0)
}

/// Debug builds mark every close-table width a solve did not fill with this
/// NaN. No arithmetic produces its payload, so reading it means the solve's
/// width bound missed a width it reads.
#[cfg(debug_assertions)]
const UNFILLED_GROUP_CLOSE_COST_US: f64 = f64::from_bits(0x7ff8_0000_0bad_c105);

/// Widths above every candidate record that `state_dominates` still reads:
/// the recovery-tier breakpoints of its piecewise proof.
#[inline]
fn dominance_breakpoints(context: PlanningContext) -> [usize; 7] {
    let protected = DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES;
    let two_shard = protected / DisplayPolicy::FEC_RECOVERY_SHARD_COUNT;
    [
        two_shard.saturating_sub(1),
        two_shard,
        two_shard.saturating_add(1),
        protected.saturating_sub(1),
        protected,
        protected.saturating_add(1),
        context.datagram_max_payload_bytes,
    ]
}

/// Fill every width a solve can read: `0..=widest` (no record or inherited
/// group is wider) plus the dominance breakpoints. Other widths keep whatever
/// an earlier solve left there.
fn fill_group_close_cost_cache(
    cache: &mut [[f64; SHARD_SIZES]; GROUP_LENGTHS],
    carrier: CarrierDeliveryQuote,
    context: PlanningContext,
    widest: usize,
) {
    // Shard width changes serialization, but its loss distribution has only
    // three recovery classes. A suffix replan must not recompute the same
    // binomial/CVaR tail for every possible byte width.
    let tails: [[f64; DisplayPolicy::FEC_RECOVERY_SHARD_COUNT + 1]; GROUP_LENGTHS] =
        std::array::from_fn(|group_len| {
            std::array::from_fn(|recovery| {
                let incomplete =
                    datagram_group_failure_probability(group_len, recovery, carrier.loss_upper);
                geometric_tail_cvar_cycles(incomplete, TAIL_PERCENTILE)
                    * (carrier.one_way_us * 2.0).max(1.0)
            })
        });
    // A one-member group has no parity at any width.
    let lone = carrier.serialization_us(0) + tails[1][0];
    // From two members on, recovery depends only on the width, so each width
    // prices its repair datagram once for every longer group.
    let mut fill = |shard_size: usize| {
        cache[0][shard_size] = 0.0;
        cache[1][shard_size] = lone;
        let recovery = recovery_class(2, shard_size, context);
        let repair_wire_bytes = if recovery == 0 {
            0
        } else {
            display_datagram_wire_len(
                merkur_codec::DISPLAY_FEC_HEADER_BYTES + recovery * shard_size,
            )
        };
        let repair_us = carrier.serialization_us(repair_wire_bytes);
        for (costs, group_tails) in cache[2..].iter_mut().zip(&tails[2..]) {
            costs[shard_size] = repair_us + group_tails[recovery];
        }
    };
    for shard_size in 0..=widest.min(SHARD_SIZES - 1) {
        fill(shard_size);
    }
    for shard_size in dominance_breakpoints(context) {
        fill(shard_size.min(SHARD_SIZES - 1));
    }
}

#[inline]
fn cached_group_close_cost_us(
    cache: &[[f64; SHARD_SIZES]; GROUP_LENGTHS],
    group_len: usize,
    shard_size: usize,
) -> f64 {
    let cost = cache[group_len.min(GROUP_LENGTHS - 1)][shard_size.min(SHARD_SIZES - 1)];
    #[cfg(debug_assertions)]
    assert_ne!(
        cost.to_bits(),
        UNFILLED_GROUP_CLOSE_COST_US.to_bits(),
        "group close cost read at width {shard_size}, which this solve did not fill"
    );
    cost
}

#[inline]
fn candidate_base_cost_us(
    candidate: BatchCandidate,
    carrier: CarrierDeliveryQuote,
    context: PlanningContext,
) -> f64 {
    let wire_bytes = match candidate.lane {
        DeliveryLane::Datagram => display_datagram_wire_len(candidate.plaintext_bytes),
        DeliveryLane::Reliable => display_reliable_record_wire_len(candidate.plaintext_bytes),
    };
    let reliable_loss_tail_us = if candidate.lane == DeliveryLane::Reliable {
        let packets = wire_bytes.div_ceil(carrier.mtu_bytes.max(1));
        let incomplete = 1.0
            - (1.0 - carrier.loss_upper.clamp(0.0, 1.0))
                .powi(packets.min(i32::MAX as usize) as i32);
        geometric_tail_cvar_cycles(incomplete, TAIL_PERCENTILE)
            * (carrier.one_way_us * 2.0).max(1.0)
    } else {
        0.0
    };
    candidate.receiver_service_us
        + candidate.sender_service_us
            * (1 + context.higher_priority_preparation_jobs) as f64
        + carrier.serialization_us(wire_bytes)
        + reliable_loss_tail_us
        // Stable ties prefer fewer records, then fewer physical bytes.
        + 1e-6
        + wire_bytes as f64 * 1e-9
}

/// Actual encoded record cost used by dispatch, after representation and sender
/// CPU are sunk. Receiver work is identical on both carriers and cancels here.
pub(crate) fn encoded_record_cost_us(
    plaintext_bytes: usize,
    carrier: CarrierDeliveryQuote,
    context: PlanningContext,
) -> f64 {
    candidate_base_cost_us(
        BatchCandidate {
            plaintext_bytes,
            lane: if plaintext_bytes <= context.datagram_max_payload_bytes {
                DeliveryLane::Datagram
            } else {
                DeliveryLane::Reliable
            },
            representation: Representation::Raw,
            sender_service_us: 0.0,
            receiver_service_us: 0.0,
        },
        carrier,
        context,
    )
}

fn transition_state(
    predecessor: PlannerState,
    predecessor_index: usize,
    end: usize,
    candidate: BatchCandidate,
    base_cost_us: f64,
    context: PlanningContext,
    group_close_cost_cache: &[[f64; SHARD_SIZES]; GROUP_LENGTHS],
) -> PlannerState {
    let mut score_us = predecessor.score_us + base_cost_us;
    let mut open_group_len = usize::from(predecessor.open_group_len);
    let mut open_group_max = usize::from(predecessor.open_group_max);
    match candidate.lane {
        DeliveryLane::Datagram => {
            open_group_len += 1;
            open_group_max = open_group_max.max(candidate.plaintext_bytes);
            if open_group_len == planned_fec_group_size(context) {
                score_us += cached_group_close_cost_us(
                    group_close_cost_cache,
                    open_group_len,
                    open_group_max,
                );
                open_group_len = 0;
                open_group_max = 0;
            }
        }
        DeliveryLane::Reliable => {
            score_us +=
                cached_group_close_cost_us(group_close_cost_cache, open_group_len, open_group_max);
            open_group_len = 0;
            open_group_max = 0;
        }
    }
    PlannerState {
        score_us,
        open_group_len: open_group_len as u8,
        open_group_max: open_group_max.min(u16::MAX as usize) as u16,
        predecessor: predecessor_index.min(u32::MAX as usize) as u32,
        end: end.min(u16::MAX as usize) as u16,
        representation: candidate.representation,
        prefix_best: 0,
    }
}

#[inline]
fn state_dominates(
    left: PlannerState,
    right: PlannerState,
    context: PlanningContext,
    group_close_cost_cache: &[[f64; SHARD_SIZES]; GROUP_LENGTHS],
) -> bool {
    if left.open_group_len != right.open_group_len || left.score_us > right.score_us {
        return false;
    }
    if left.open_group_max == right.open_group_max {
        return true;
    }
    if !context.fec_enabled {
        return true;
    }
    // The only future-visible state is the widest shard in this open group.
    // Repair cost is piecewise linear with breaks where two shards become one
    // and one becomes zero. Comparing every endpoint of those pieces (plus
    // both current maxima) proves dominance for every possible future shard;
    // it is exact and collapses the frontier without a heuristic state cap.
    let left_max = usize::from(left.open_group_max);
    let right_max = usize::from(right.open_group_max);
    // Within one recovery-width tier, widening a shard is monotone and the
    // loss term is constant. Future widths either shrink this difference or
    // cross the same tier boundary for both states. Most real frontiers live
    // in one tier; avoid the general breakpoint proof for each such pair.
    if fec_recovery_shard_count(2, left_max) == fec_recovery_shard_count(2, right_max) {
        if left_max <= right_max {
            return true;
        }
        let open_len = usize::from(left.open_group_len);
        return (open_len..=planned_fec_group_size(context)).all(|group_len| {
            left.score_us + cached_group_close_cost_us(group_close_cost_cache, group_len, left_max)
                <= right.score_us
                    + cached_group_close_cost_us(group_close_cost_cache, group_len, right_max)
        });
    }
    let [a, b, c, d, e, f, g] = dominance_breakpoints(context);
    let points = [0, left_max, right_max, a, b, c, d, e, f, g];
    let open_len = usize::from(left.open_group_len);
    let remaining = planned_fec_group_size(context).saturating_sub(open_len);
    (0..=remaining).all(|future_count| {
        let group_len = open_len + future_count;
        points.into_iter().all(|future_max| {
            left.score_us
                + cached_group_close_cost_us(
                    group_close_cost_cache,
                    group_len,
                    left_max.max(future_max),
                )
                <= right.score_us
                    + cached_group_close_cost_us(
                        group_close_cost_cache,
                        group_len,
                        right_max.max(future_max),
                    )
        })
    })
}

fn retain_nondominated_candidate(
    candidates: &mut Vec<PlannerState>,
    group_start: usize,
    tier_start: &mut usize,
    candidate: PlannerState,
    context: PlanningContext,
    group_close_cost_cache: &[[f64; SHARD_SIZES]; GROUP_LENGTHS],
) {
    // Occupancy traversal supplies strictly increasing widths. Within one
    // recovery tier, surviving scores strictly decrease with width; therefore
    // only the last state can dominate the new widest state's base score.
    // Repair cost in a tier has one non-negative linear width coefficient
    // (zero for a one-member close). Its adjusted-cost skyline is increasing,
    // so a new state can remove only a suffix. Cross-tier discontinuities keep
    // the complete breakpoint proof; they cannot use this monotonic shortcut.
    if candidates.len() > *tier_start
        && candidates
            .last()
            .is_some_and(|last| last.score_us <= candidate.score_us)
    {
        return;
    }
    if candidates[group_start..*tier_start]
        .iter()
        .copied()
        .any(|existing| state_dominates(existing, candidate, context, group_close_cost_cache))
    {
        return;
    }
    let mut write = group_start;
    for read in group_start..*tier_start {
        let existing = candidates[read];
        if !state_dominates(candidate, existing, context, group_close_cost_cache) {
            candidates[write] = existing;
            write += 1;
        }
    }
    if write < *tier_start {
        let len = candidates.len();
        candidates.copy_within(*tier_start..len, write);
        candidates.truncate(write + len - *tier_start);
        *tier_start = write;
    }
    while candidates.len() > *tier_start
        && state_dominates(
            candidate,
            *candidates.last().expect("non-empty recovery tier"),
            context,
            group_close_cost_cache,
        )
    {
        candidates.pop();
    }
    candidates.push(candidate);
}

/// Emit only predecessors that can produce distinct or minimum-cost outputs.
/// A new width folds every smaller maximum into one output; a group close
/// folds every maximum into the empty group. The retained sorted skyline has
/// decreasing base scores and increasing width-adjusted scores within each
/// recovery tier, so a close needs only each tier's first suffix state.
#[inline]
fn visit_distinct_predecessors(
    states: &[PlannerState],
    groups: &[u32; GROUP_LENGTHS + 1],
    choice: BatchCandidate,
    context: PlanningContext,
    mut visit: impl FnMut(usize, PlannerState),
) {
    for group_len in 0..planned_fec_group_size(context) {
        let begin = groups[group_len] as usize;
        let end = groups[group_len + 1] as usize;
        if begin == end {
            continue;
        }
        let mut suffix = begin;
        if choice.lane == DeliveryLane::Reliable {
            if group_len <= 1 || !context.fec_enabled {
                let best = states[end - 1].prefix_best as usize;
                visit(best, states[best]);
                continue;
            }
        } else {
            suffix += states[begin..end].partition_point(|state| {
                usize::from(state.open_group_max) <= choice.plaintext_bytes
            });
            if suffix > begin {
                let best = states[suffix - 1].prefix_best as usize;
                visit(best, states[best]);
            }
            if group_len + 1 < planned_fec_group_size(context) {
                for (offset, state) in states[suffix..end].iter().copied().enumerate() {
                    visit(suffix + offset, state);
                }
                continue;
            }
        }
        while suffix < end {
            let state = states[suffix];
            visit(suffix, state);
            let tier = fec_recovery_shard_count(2, usize::from(state.open_group_max));
            suffix += states[suffix..end].partition_point(|candidate| {
                fec_recovery_shard_count(2, usize::from(candidate.open_group_max)) == tier
            });
        }
    }
}

/// The raw and predicted-compressed candidates for one span.
///
/// A span's compressed size is predicted per class: each class's bytes at its
/// own learned ratio for this size bucket, summed, with the frame header
/// priced at the dominant class's ratio. A span mixing an incompressible color
/// row with compressible text therefore predicts the sum of both parts, which
/// is what zstd produces, rather than one class's ratio over both. Service
/// posteriors are per class, so the dominant class prices sender and receiver
/// work and receives the achieved ratio afterwards.
fn batch_candidates(
    profiles: &[PeerPlanningSnapshot; CONTENT_CLASSES],
    sender_upper_by_size: &[[f64; SIZE_CLASSES]; CONTENT_CLASSES],
    class_bytes: [usize; CONTENT_CLASSES],
    raw_bytes: usize,
    singleton: bool,
    wire_cap: usize,
    datagram_max_payload_bytes: usize,
) -> [Option<BatchCandidate>; 2] {
    let major = content_class_by_bytes(class_bytes).index();
    let peer = profiles[major];
    let sender_upper_by_size = &sender_upper_by_size[major];
    let counted: usize = class_bytes.iter().sum();
    let header_bytes = raw_bytes.saturating_sub(counted);
    let predicted = class_bytes
        .iter()
        .zip(profiles)
        .map(|(bytes, profile)| *bytes as f64 * profile.ratio(raw_bytes))
        .sum::<f64>()
        + header_bytes as f64 * peer.ratio(raw_bytes);
    let raw_lane =
        if raw_bytes <= wire_cap || (singleton && raw_bytes <= datagram_max_payload_bytes) {
            Some(DeliveryLane::Datagram)
        } else if singleton {
            Some(DeliveryLane::Reliable)
        } else {
            None
        };
    let raw = raw_lane.map(|lane| BatchCandidate {
        plaintext_bytes: raw_bytes,
        lane,
        representation: Representation::Raw,
        sender_service_us: 0.0,
        receiver_service_us: 0.0,
    });
    let predicted_bytes = predicted.ceil().max(1.0) as usize;
    let compressed_lane = if predicted_bytes < raw_bytes
        && (predicted_bytes <= wire_cap
            || (singleton && predicted_bytes <= datagram_max_payload_bytes))
    {
        Some(DeliveryLane::Datagram)
    } else if predicted_bytes < raw_bytes && singleton {
        Some(DeliveryLane::Reliable)
    } else {
        None
    };
    let compressed = compressed_lane.map(|lane_kind| BatchCandidate {
        plaintext_bytes: predicted_bytes,
        lane: lane_kind,
        representation: Representation::Compressed,
        sender_service_us: sender_upper_by_size[size_class(raw_bytes)],
        receiver_service_us: peer
            .receiver_upper_us(raw_bytes, predicted_bytes as f64 / raw_bytes.max(1) as f64),
    });
    [raw, compressed]
}

/// Conservative upper bound on a feasible multirow raw body across every
/// independent ratio bucket. Ratios need not be monotone: take each bucket's
/// own intersection with its size interval before taking the maximum. The
/// extra byte protects floating-point division at an exact boundary; actual
/// candidate construction still decides feasibility.
fn multirow_raw_limit(peer: PeerPlanningSnapshot, wire_cap: usize) -> usize {
    let lower = [0, 513, 1_025, 2_049, 4_097, 8_193];
    let upper = [512, 1_024, 2_048, 4_096, 8_192, usize::MAX];
    let mut limit = wire_cap;
    for class in 0..SIZE_CLASSES {
        let ratio = peer.ratio_by_size[class];
        let compressed_limit = ((wire_cap as f64 / ratio).ceil() as usize).saturating_add(1);
        let candidate_limit = compressed_limit.min(upper[class]);
        if candidate_limit >= lower[class] {
            limit = limit.max(candidate_limit);
        }
    }
    limit
}

fn plan_for_carrier(
    global: &GlobalDisplayPlanningModel,
    profiles: &[PeerPlanningSnapshot; CONTENT_CLASSES],
    lane: ExecutionLane,
    dictionary: DictionaryClass,
    context: PlanningContext,
    rows: &[PlannedRow],
    header_bytes: usize,
    wire_cap: usize,
    carrier: CarrierDeliveryQuote,
    incumbent_score_us: f64,
    workspace: &mut PlannerWorkspace,
    out: &mut BatchPartitionPlan,
) {
    let count = rows.len().min(MAX_PLANNED_ROWS);
    // A span's class is decided by its summed census, so the feasibility bound
    // must admit whichever class's ratios reach furthest.
    let multirow_limit = profiles
        .iter()
        .map(|profile| multirow_raw_limit(*profile, wire_cap))
        .max()
        .unwrap_or(wire_cap);
    let sender_upper_by_size: [[f64; SIZE_CLASSES]; CONTENT_CLASSES] =
        std::array::from_fn(|content| {
            std::array::from_fn(|class| {
                let bytes = [512, 768, 1_536, 3_072, 6_144, 12_288][class];
                global.sender_service_upper_us(
                    lane,
                    bytes,
                    CONTENT_CLASS_BY_INDEX[content],
                    dictionary,
                )
            })
        });
    // The loop writes every prefix 1..=count a solve reads; entries past
    // `count` are an earlier, longer solve's and are never read.
    workspace.prefix[0] = 0;
    workspace.class_prefix[0] = [0; CONTENT_CLASSES];
    for (index, row) in rows[..count].iter().enumerate() {
        workspace.prefix[index + 1] = workspace.prefix[index].saturating_add(row.bytes);
        let mut classes = workspace.class_prefix[index];
        classes[row.class.index()] =
            classes[row.class.index()].saturating_add(row.bytes.min(u32::MAX as usize) as u32);
        workspace.class_prefix[index + 1] = classes;
    }
    // Profiles and the carrier are immutable for this invocation. Identical
    // span censuses have identical representation, service and loss prices,
    // regardless of their position. Reuse those prices in both DP passes;
    // reset at every replan so new compression observations take effect.
    // A span is at most `count` rows, so no longer slot can be read.
    workspace.span_costs[..=count].fill(None);
    let mut price_span = |start: usize, end: usize| {
        let raw_bytes = header_bytes
            .saturating_add(workspace.prefix[end].saturating_sub(workspace.prefix[start]));
        let class_bytes = span_class_bytes(&workspace.class_prefix, start, end);
        let slot = &mut workspace.span_costs[end - start];
        if let Some(entry) = slot
            && entry.raw_bytes == raw_bytes
            && entry.class_bytes == class_bytes
        {
            return entry.choices;
        }
        let choices = batch_candidates(
            profiles,
            &sender_upper_by_size,
            class_bytes,
            raw_bytes,
            end == start + 1,
            wire_cap,
            context.datagram_max_payload_bytes,
        )
        .map(|choice| {
            choice.map(|choice| (choice, candidate_base_cost_us(choice, carrier, context)))
        });
        *slot = Some(SpanCostEntry {
            class_bytes,
            raw_bytes,
            choices,
        });
        choices
    };
    // Solve the relaxed partition problem without parity/tail costs first.
    // Every omitted term is non-negative, so this is a proven suffix lower
    // bound, not a heuristic. Its own partition is a feasible full schedule;
    // adding its exact group costs supplies an upper bound. Together they
    // prune only states that cannot beat an already feasible solution, avoiding
    // millions of irrelevant open-group transitions on tiny-row screens.
    workspace.suffix_lower_bound_us[count] = 0.0;
    for start in (0..count).rev() {
        let mut best = f64::INFINITY;
        for end in start + 1..=count {
            let raw_bytes = header_bytes
                .saturating_add(workspace.prefix[end].saturating_sub(workspace.prefix[start]));
            if end > start + 1 && raw_bytes > multirow_limit {
                break;
            }
            for (choice, base_cost_us) in price_span(start, end).into_iter().flatten() {
                let cost = base_cost_us + workspace.suffix_lower_bound_us[end];
                if cost < best {
                    best = cost;
                    workspace.suffix_ends[start] = end as u16;
                    workspace.suffix_representations[start] = choice.representation;
                }
            }
        }
        workspace.suffix_lower_bound_us[start] = best;
    }
    let fixed_cost_us = carrier.fixed_delivery_us() + context.receiver_service_debt_us;
    if fixed_cost_us + workspace.suffix_lower_bound_us[0]
        > incumbent_score_us + (1.0 + incumbent_score_us.abs()) * 1e-10
    {
        // Even the relaxed optimum loses to the other carrier's complete
        // schedule. No FEC frontier on this carrier can change the winner.
        out.clear();
        return;
    }
    // A reliable singleton cannot join an FEC group and its complete recovery
    // cost is already in the base term. If the relaxed optimum contains only
    // these records, and there is no inherited open group to close, the lower
    // bound is itself an exact feasible optimum. In particular, maximum-sized
    // styled rows must not rebuild every FEC width's cache and frontier after
    // each singleton's new compression observation.
    let mut reliable_only = context.initial_fec_group_len == 0;
    let mut start = 0;
    while reliable_only && start < count {
        let end = usize::from(workspace.suffix_ends[start]);
        reliable_only = price_span(start, end)
            .into_iter()
            .flatten()
            .find(|(choice, _)| choice.representation == workspace.suffix_representations[start])
            .is_some_and(|(choice, _)| choice.lane == DeliveryLane::Reliable);
        start = end;
    }
    if reliable_only {
        out.score_us = fixed_cost_us + workspace.suffix_lower_bound_us[0];
        let mut start = 0;
        while start < count {
            let end = usize::from(workspace.suffix_ends[start]);
            out.push(end, workspace.suffix_representations[start]);
            start = end;
        }
        return;
    }
    // A state's widest shard is its inherited group's or one of its datagram
    // records'. No record is wider than its span's raw body, the frontier
    // visits only singletons and spans within `multirow_limit`, and the
    // datagram lane caps every record. So no state is wider than `widest`,
    // and only `state_dominates` reads past it, at its breakpoints.
    let widest_row = rows[..count].iter().map(|row| row.bytes).max().unwrap_or(0);
    let widest_span = header_bytes.saturating_add(widest_row).max(if count > 1 {
        multirow_limit.min(header_bytes.saturating_add(workspace.prefix[count]))
    } else {
        0
    });
    let widest = context
        .initial_fec_group_max_bytes
        .max(widest_span.min(wire_cap.max(context.datagram_max_payload_bytes)));
    #[cfg(debug_assertions)]
    for costs in &mut workspace.group_close_cost_us {
        costs.fill(UNFILLED_GROUP_CLOSE_COST_US);
    }
    fill_group_close_cost_cache(&mut workspace.group_close_cost_us, carrier, context, widest);
    let mut feasible = PlannerState {
        score_us: 0.0,
        open_group_len: context
            .initial_fec_group_len
            .min(planned_fec_group_size(context).saturating_sub(1)) as u8,
        open_group_max: context.initial_fec_group_max_bytes.min(u16::MAX as usize) as u16,
        ..PlannerState::INVALID
    };
    let mut start = 0;
    while start < count {
        let end = usize::from(workspace.suffix_ends[start]);
        let (choice, base_cost_us) = price_span(start, end)
            .into_iter()
            .flatten()
            .find(|(choice, _)| choice.representation == workspace.suffix_representations[start])
            .expect("the relaxed partition is feasible");
        feasible = transition_state(
            feasible,
            0,
            end,
            choice,
            base_cost_us,
            context,
            &workspace.group_close_cost_us,
        );
        start = end;
    }
    let upper_bound_us = feasible.score_us
        + cached_group_close_cost_us(
            &workspace.group_close_cost_us,
            usize::from(feasible.open_group_len),
            usize::from(feasible.open_group_max),
        );
    // Summing the same positive terms in suffix order can round upward by a
    // few ulps. Leave a conservative numerical margin; it only retains extra
    // states and cannot discard a lower-cost schedule.
    let prune_above_us = upper_bound_us + (1.0 + upper_bound_us.abs()) * 1e-10;
    workspace.states.clear();
    // Each frontier 1..=count is written below before any read of it; the
    // bounds past `count` are an earlier, longer solve's and are never read.
    workspace.frontier_starts[0] = 0;
    workspace.states.push(PlannerState {
        score_us: 0.0,
        open_group_len: context
            .initial_fec_group_len
            .min(planned_fec_group_size(context).saturating_sub(1)) as u8,
        open_group_max: context.initial_fec_group_max_bytes.min(u16::MAX as usize) as u16,
        predecessor: 0,
        end: 0,
        representation: Representation::Raw,
        prefix_best: 0,
    });
    workspace.frontier_ends[0] = 1;
    workspace.frontier_groups[0].fill(1);
    workspace.frontier_groups[0][0] = 0;

    for end in 1..=count {
        for start in (0..end).rev() {
            let raw_bytes = header_bytes
                .saturating_add(workspace.prefix[end].saturating_sub(workspace.prefix[start]));
            if end > start + 1 && raw_bytes > multirow_limit {
                break;
            }
            for (choice, base_cost_us) in price_span(start, end).into_iter().flatten() {
                visit_distinct_predecessors(
                    &workspace.states,
                    &workspace.frontier_groups[start],
                    choice,
                    context,
                    |predecessor_index, predecessor| {
                        let candidate = transition_state(
                            predecessor,
                            predecessor_index,
                            end,
                            choice,
                            base_cost_us,
                            context,
                            &workspace.group_close_cost_us,
                        );
                        if candidate.score_us + workspace.suffix_lower_bound_us[end]
                            > prune_above_us
                        {
                            return;
                        }
                        let candidate_index = usize::from(candidate.open_group_len) * SHARD_SIZES
                            + usize::from(candidate.open_group_max);
                        let slot = &mut workspace.candidate_best[candidate_index];
                        if candidate.score_us < slot.score_us {
                            *slot = candidate;
                            workspace.candidate_dirty[candidate_index / u64::BITS as usize] |=
                                1u64 << (candidate_index % u64::BITS as usize);
                        }
                    },
                );
            }
        }
        workspace.candidates.clear();
        let mut group_len = 0usize;
        let mut group_start = 0usize;
        let mut recovery_tier = usize::MAX;
        let mut tier_start = 0usize;
        for (word_index, word) in workspace.candidate_dirty.iter_mut().enumerate() {
            let mut bits = std::mem::take(word);
            while bits != 0 {
                let bit = bits.trailing_zeros() as usize;
                bits &= bits - 1;
                let candidate_index = word_index * u64::BITS as usize + bit;
                let candidate = std::mem::replace(
                    &mut workspace.candidate_best[candidate_index],
                    PlannerState::INVALID,
                );
                let next_group = candidate_index / SHARD_SIZES;
                if next_group != group_len {
                    group_len = next_group;
                    group_start = workspace.candidates.len();
                    recovery_tier = usize::MAX;
                }
                let next_tier = if context.fec_enabled {
                    fec_recovery_shard_count(2, usize::from(candidate.open_group_max))
                } else {
                    0
                };
                if next_tier != recovery_tier {
                    recovery_tier = next_tier;
                    tier_start = workspace.candidates.len();
                }
                retain_nondominated_candidate(
                    &mut workspace.candidates,
                    group_start,
                    &mut tier_start,
                    candidate,
                    context,
                    &workspace.group_close_cost_us,
                );
            }
        }
        // A prefix may be wholly pruned when no globally competitive schedule
        // ends a record there. The relaxed partition supplies a feasible full
        // schedule, so only the final frontier must remain non-empty.
        assert!(end < count || !workspace.candidates.is_empty());
        assert!(workspace.candidates.len() <= MAX_FRONTIER_STATES);
        let frontier_start = workspace.states.len();
        workspace.states.extend_from_slice(&workspace.candidates);
        let mut best = frontier_start;
        for index in frontier_start..workspace.states.len() {
            if workspace.states[index].open_group_len != workspace.states[best].open_group_len
                || workspace.states[index].score_us < workspace.states[best].score_us
            {
                best = index;
            }
            workspace.states[index].prefix_best = best as u32;
        }
        for group in 0..=GROUP_LENGTHS {
            workspace.frontier_groups[end][group] = (frontier_start
                + workspace
                    .candidates
                    .partition_point(|state| usize::from(state.open_group_len) < group))
                as u32;
        }
        assert!(workspace.states.len() <= MAX_PLANNER_STATES);
        workspace.frontier_starts[end] = frontier_start.min(u32::MAX as usize) as u32;
        workspace.frontier_ends[end] = workspace.states.len().min(u32::MAX as usize) as u32;
    }

    let final_start = usize::try_from(workspace.frontier_starts[count]).unwrap_or(0);
    let final_end = usize::try_from(workspace.frontier_ends[count]).unwrap_or(0);
    let fixed = carrier.fixed_delivery_us() + context.receiver_service_debt_us;
    let Some((mut selected_index, selected_score)) = (final_start..final_end)
        .map(|index| {
            let state = workspace.states[index];
            let score = fixed
                + state.score_us
                + cached_group_close_cost_us(
                    &workspace.group_close_cost_us,
                    usize::from(state.open_group_len),
                    usize::from(state.open_group_max),
                );
            (index, score)
        })
        .min_by(|left, right| left.1.total_cmp(&right.1))
    else {
        return;
    };
    out.score_us = selected_score;
    #[cfg(test)]
    {
        out.refinement_gain_us = (fixed_cost_us + upper_bound_us - selected_score).max(0.0);
        out.relaxed_gap_us = (upper_bound_us - workspace.suffix_lower_bound_us[0]).max(0.0);
    }
    while selected_index != 0 {
        let state = workspace.states[selected_index];
        out.push(usize::from(state.end), state.representation);
        selected_index = usize::try_from(state.predecessor).unwrap_or(0);
    }
    out.reverse();
}

/// Choose all batch boundaries jointly across both non-dominated live carriers.
/// One fixed one-way/queue term is charged once for the coherent schedule; per-record serialization,
/// exact sealed/channel/FEC bytes, receiver service, compression service and
/// p95-CVaR loss tails are additive. Adjacent datagrams share the same FEC
/// groups the sender will build, while a jumbo is one persistent-lane record
/// that closes (and never joins) a datagram group. Every candidate span is
/// classified by its own summed cell census and priced with that class's
/// profile, so rows of different classes join one record whenever that is the
/// cheaper schedule: a class change between two rows is never a boundary.
pub fn plan_batch_partitions(
    global: &GlobalDisplayPlanningModel,
    profiles: &[PeerPlanningSnapshot; CONTENT_CLASSES],
    lane: ExecutionLane,
    dictionary: DictionaryClass,
    mut context: PlanningContext,
    rows: &[PlannedRow],
    header_bytes: usize,
    wire_cap: usize,
    workspace: &mut PlannerWorkspace,
    out: &mut BatchPartitionPlan,
) {
    out.clear();
    let count = rows.len().min(MAX_PLANNED_ROWS);
    if count == 0 {
        return;
    }
    if let Some(alternate) = context.alternate() {
        if context.carrier.dominates(alternate.carrier) {
            context.alternate_carrier = None;
        } else if alternate.carrier.dominates(context.carrier) {
            context = alternate;
        }
    }
    plan_for_carrier(
        global,
        profiles,
        lane,
        dictionary,
        context,
        &rows[..count],
        header_bytes,
        wire_cap,
        context.carrier,
        f64::INFINITY,
        workspace,
        out,
    );
    if let Some(alternate) = context.alternate() {
        // The result is fixed-size stack storage; both searches reuse the same
        // retained frontier arena. Only genuinely crossing carrier quotes pay
        // a second search, and the comparison uses the entire FEC-aware plan.
        let mut alternative = BatchPartitionPlan::default();
        plan_for_carrier(
            global,
            profiles,
            lane,
            dictionary,
            alternate,
            &rows[..count],
            header_bytes,
            wire_cap,
            alternate.carrier,
            out.score_us,
            workspace,
            &mut alternative,
        );
        if alternative.score_us < out.score_us {
            *out = alternative;
        }
    }
}

pub struct PeerDisplayPlanningModel {
    ratio: [BoundedPosterior; SIZE_CLASSES * CONTENT_CLASSES * DICTIONARY_CLASSES],
    receiver: [ReceiverCostPosterior; SIZE_CLASSES * RATIO_CLASSES * DICTIONARY_CLASSES],
    receiver_service_debt_us: f64,
    receiver_profile_revision: u32,
    /// Written once per flush per carrier and read by every quote, about ten
    /// a flush.
    carrier_network_delivery: [ReadMostlyPosterior; 2],
    carrier_loss: [ReadMostlyPosterior; 2],
    carrier_quotes: [Option<CarrierDeliveryQuote>; 2],
}

#[derive(Clone, Copy, Default)]
struct ReceiverCostPosterior {
    mean_us: f64,
    variance_us2: f64,
    upper_us: f64,
    sample_count: u16,
}

impl ReceiverCostPosterior {
    fn replace(&mut self, bucket: ReceiverProfileBucket, age_uncertainty: f64) {
        let count = f64::from(bucket.sample_count.max(1));
        let mean = f64::from(bucket.mean_us);
        let variance = f64::from(bucket.variance_us2);
        let derived_upper = mean + 1.645 * (variance * (1.0 + 1.0 / count)).sqrt();
        self.mean_us = mean;
        self.variance_us2 = variance;
        self.upper_us = f64::from(bucket.upper_us)
            .max(derived_upper)
            .mul_add(age_uncertainty, 0.0);
        self.sample_count = bucket.sample_count;
    }

    fn predictive_upper(self, cold_upper: f64) -> f64 {
        if self.sample_count == 0 {
            cold_upper
        } else {
            self.upper_us
        }
    }
}

#[derive(Clone, Copy)]
pub struct PeerPlanningSnapshot {
    ratio_by_size: [f64; SIZE_CLASSES],
    receiver_upper_by_surface: [f64; SIZE_CLASSES * RATIO_CLASSES],
    receiver_service_debt_us: f64,
}

impl PeerPlanningSnapshot {
    #[inline]
    pub(crate) fn ratio(&self, bytes: usize) -> f64 {
        self.ratio_by_size[size_class(bytes)]
    }

    #[inline]
    pub(crate) fn receiver_upper_us(&self, bytes: usize, ratio: f64) -> f64 {
        self.receiver_upper_by_surface[size_class(bytes) * RATIO_CLASSES + ratio_class(ratio)]
    }

    pub(crate) fn observe_actual_ratio(&mut self, bytes: usize, ratio: f64) {
        // A neighboring row can change from blank text to high-entropy color;
        // compression ratio is not monotone across larger prefixes. Keep the
        // feedback in its size bucket, lower its upper estimate slowly, and
        // accept a worse observation immediately. This bounds one heterogeneous
        // batch's influence while still adapting within a long homogeneous
        // redraw.
        let observed = ratio.clamp(0.01, 1.0);
        let class = size_class(bytes);
        let prediction = &mut self.ratio_by_size[class];
        *prediction = if observed >= *prediction {
            observed
        } else {
            (*prediction * 0.875 + observed * 0.125).clamp(observed, *prediction)
        };
        // Permit one bounded exploratory step into the adjacent size bucket.
        // A 15% reduction is enough to cross an MTU boundary after a strongly
        // compressible sample, yet a completely unrelated incompressible tail
        // can overshoot the target by at most that bounded optimism before the
        // fitter performs one measured correction. Evidence never cascades
        // beyond the immediately adjacent bucket.
        if observed < *prediction && class + 1 < SIZE_CLASSES {
            let adjacent = &mut self.ratio_by_size[class + 1];
            *adjacent = (*adjacent * 0.85).max(observed);
        }
    }
}

impl Default for PeerDisplayPlanningModel {
    fn default() -> Self {
        Self {
            ratio: [BoundedPosterior::default();
                SIZE_CLASSES * CONTENT_CLASSES * DICTIONARY_CLASSES],
            receiver: [ReceiverCostPosterior::default();
                SIZE_CLASSES * RATIO_CLASSES * DICTIONARY_CLASSES],
            receiver_service_debt_us: 0.0,
            receiver_profile_revision: 0,
            carrier_network_delivery: [ReadMostlyPosterior::default(); 2],
            carrier_loss: [ReadMostlyPosterior::default(); 2],
            carrier_quotes: [None; 2],
        }
    }
}

impl PeerDisplayPlanningModel {
    fn ratio_index(bytes: usize, content: ContentClass, dictionary: DictionaryClass) -> usize {
        ((size_class(bytes) * CONTENT_CLASSES + content.index()) * DICTIONARY_CLASSES)
            + dictionary.index()
    }

    fn receiver_index(bytes: usize, ratio: f64, dictionary: DictionaryClass) -> usize {
        ((size_class(bytes) * RATIO_CLASSES + ratio_class(ratio)) * DICTIONARY_CLASSES)
            + dictionary.index()
    }

    pub fn observe_ratio(
        &mut self,
        raw_bytes: usize,
        content: ContentClass,
        dictionary: DictionaryClass,
        ratio: f64,
    ) {
        self.ratio[Self::ratio_index(raw_bytes, content, dictionary)]
            .observe(ratio.clamp(0.0, 1.0));
    }

    pub fn apply_receiver_profile(
        &mut self,
        revision: u32,
        age_ms: u32,
        service_debt_us: u32,
        buckets: &[ReceiverProfileBucket],
    ) {
        let current_revision = self.receiver_profile_revision;
        if revision == 0
            || (current_revision != 0
                && (revision == current_revision
                    || revision.wrapping_sub(current_revision) >= 0x8000_0000))
        {
            return;
        }
        self.receiver_profile_revision = revision;
        self.receiver_service_debt_us = if age_ms <= 2_000 {
            f64::from(service_debt_us)
        } else {
            0.0
        };
        let age_uncertainty = (1.0 + f64::from(age_ms) / 60_000.0).min(4.0);
        for bucket in buckets {
            let wire_ratio = f64::from(bucket.wire_ratio_ppm) / 1_000_000.0;
            if bucket.size_class >= SIZE_CLASSES
                || bucket.ratio_class >= RATIO_CLASSES
                || bucket.dictionary_class >= DICTIONARY_CLASSES
                || bucket.wire_ratio_ppm == 0
                || bucket.wire_ratio_ppm > 1_000_000
                || ratio_class(wire_ratio) != bucket.ratio_class
            {
                continue;
            }
            let index = ((bucket.size_class * RATIO_CLASSES + bucket.ratio_class)
                * DICTIONARY_CLASSES)
                + bucket.dictionary_class;
            self.receiver[index].replace(*bucket, age_uncertainty);
        }
    }

    pub fn receiver_upper_us(&self, bytes: usize, ratio: f64, dictionary: DictionaryClass) -> f64 {
        // No profile means compression must win without assuming a fast
        // browser. 250us is bounded and is rapidly replaced by authenticated
        // device evidence.
        self.receiver[Self::receiver_index(bytes, ratio, dictionary)].predictive_upper(250.0)
    }

    pub fn receiver_service_debt_us(&self) -> f64 {
        self.receiver_service_debt_us
    }

    pub fn observe_carrier_quote(&mut self, carrier: usize, quote: CarrierDeliveryQuote) {
        let carrier = carrier.min(1);
        self.carrier_network_delivery[carrier].observe(quote.one_way_us + quote.jitter_upper_us);
        self.carrier_loss[carrier].observe(quote.loss_upper.clamp(0.0, 1.0));
        self.carrier_quotes[carrier] = Some(quote);
    }

    /// Forget delivery evidence when a concrete carrier attachment is retired.
    /// Callers must do this at the same owner-loop transition that replaces or
    /// detaches that attachment; bounded recent history must not leak into the
    /// next QUIC congestion/loss epoch.
    pub fn reset_carrier_observations(&mut self, carrier: usize) {
        let carrier = carrier.min(1);
        self.carrier_network_delivery[carrier].reset();
        self.carrier_loss[carrier].reset();
        self.carrier_quotes[carrier] = None;
    }

    /// Predict forward delivery from transport observations only. A display ACK
    /// includes an independently routed return trip and receiver ACK cadence;
    /// admission-to-confirmation time cannot identify a forward-path residual.
    pub fn carrier_quote(
        &self,
        carrier: usize,
        fallback: CarrierDeliveryQuote,
    ) -> CarrierDeliveryQuote {
        let carrier = carrier.min(1);
        let mut quote = self.carrier_quotes[carrier].unwrap_or(fallback);
        quote.one_way_us = self.carrier_network_delivery[carrier]
            .predictive_upper(quote.one_way_us + quote.jitter_upper_us);
        quote.jitter_upper_us = 0.0;
        quote.loss_upper = self.carrier_loss[carrier]
            .predictive_upper(quote.loss_upper)
            .clamp(0.0, 1.0);
        quote
    }

    pub fn snapshot(
        &self,
        content: ContentClass,
        dictionary: DictionaryClass,
    ) -> PeerPlanningSnapshot {
        // Representative value strictly inside each bucket.
        let representative = [512, 768, 1_536, 3_072, 6_144, 12_288];
        // Each bucket's compression ratio, its six windows read together.
        // Compression ratio is a sender/content property. The neutral prior
        // permits bounded cold exploration; only achieved daemon compression
        // observations may replace it. Browser calibration ratios describe its
        // synthetic decode-cost surface and must not predict the peer's
        // terminal content.
        let ratio_by_size = BoundedPosterior::predictive_uppers(
            representative.map(|bytes| &self.ratio[Self::ratio_index(bytes, content, dictionary)]),
            [0.5; SIZE_CLASSES],
        )
        .map(|ratio| ratio.clamp(0.01, 1.0));
        let mut receiver_upper_by_surface = [250.0; SIZE_CLASSES * RATIO_CLASSES];
        for (class, bytes) in representative.into_iter().enumerate() {
            for (ratio_index, ratio) in [0.1, 0.2, 0.375, 0.75].into_iter().enumerate() {
                receiver_upper_by_surface[class * RATIO_CLASSES + ratio_index] =
                    self.receiver_upper_us(bytes, ratio, dictionary);
            }
        }
        PeerPlanningSnapshot {
            ratio_by_size,
            receiver_upper_by_surface,
            receiver_service_debt_us: self.receiver_service_debt_us,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ReceiverProfileBucket {
    pub dictionary_class: usize,
    pub size_class: usize,
    pub ratio_class: usize,
    pub sample_count: u16,
    pub wire_ratio_ppm: u32,
    pub mean_us: u32,
    pub variance_us2: u32,
    pub upper_us: u32,
}

pub fn should_attempt_compression(
    global: &GlobalDisplayPlanningModel,
    peer: PeerPlanningSnapshot,
    lane: ExecutionLane,
    raw_bytes: usize,
    content: ContentClass,
    dictionary: DictionaryClass,
    mut context: PlanningContext,
) -> bool {
    let predicted_bytes = (raw_bytes as f64 * peer.ratio(raw_bytes)).ceil() as usize;
    if predicted_bytes >= raw_bytes {
        return false;
    }
    context.receiver_service_debt_us = peer.receiver_service_debt_us;
    let raw = best_single_record_plan(raw_bytes, 0.0, context);
    let receiver_us =
        peer.receiver_upper_us(raw_bytes, predicted_bytes as f64 / raw_bytes.max(1) as f64);
    let sender_service = global.sender_service_upper_us(lane, raw_bytes, content, dictionary);
    let compressed_finish = |context: PlanningContext| {
        let compressed = single_record_plan(predicted_bytes, receiver_us, context);
        let critical_path = (sender_service - context.earliest_uncompressed_send_us).max(0.0)
            + sender_service * context.higher_priority_preparation_jobs as f64;
        compressed.tail_latency_us + critical_path
    };
    let primary_finish = compressed_finish(context);
    let best_finish = context.alternate().map_or(primary_finish, |alternate| {
        primary_finish.min(compressed_finish(alternate))
    });
    best_finish < raw.tail_latency_us
}

pub fn choose_after_compression(
    peer: PeerPlanningSnapshot,
    raw_bytes: usize,
    compressed_bytes: usize,
    _dictionary: DictionaryClass,
    mut context: PlanningContext,
) -> Representation {
    if compressed_bytes >= raw_bytes {
        return Representation::Raw;
    }
    context.receiver_service_debt_us = peer.receiver_service_debt_us;
    let raw = best_single_record_plan(raw_bytes, 0.0, context);
    let compressed = best_single_record_plan(
        compressed_bytes,
        peer.receiver_upper_us(raw_bytes, compressed_bytes as f64 / raw_bytes.max(1) as f64),
        context,
    );
    if compressed.tail_latency_us < raw.tail_latency_us {
        Representation::Compressed
    } else {
        Representation::Raw
    }
}

#[cfg(test)]
mod profile;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorted_recovery_tier_frontier_matches_complete_pairwise_dominance() {
        assert_eq!(std::mem::size_of::<PlannerState>(), 24);
        for loss_upper in [0.0, 0.01, 0.03, 0.09] {
            for fec_enabled in [false, true] {
                for fec_group_size in 1..=4 {
                    for open_group_len in 0..fec_group_size as u8 {
                        for (one_way_us, pacing_rate_bps, send_buffer_occupied_bytes) in
                            [(500.0, 1_000_000_000, 0), (100_000.0, 1_000_000, 20_000)]
                        {
                            let carrier = CarrierDeliveryQuote {
                                loss_upper,
                                one_way_us,
                                pacing_rate_bps,
                                send_buffer_occupied_bytes,
                                ..CarrierDeliveryQuote::default()
                            };
                            let context = PlanningContext {
                                carrier,
                                fec_enabled,
                                fec_group_size,
                                ..PlanningContext::default()
                            };
                            let mut cache = [[0.0; SHARD_SIZES]; GROUP_LENGTHS];
                            fill_group_close_cost_cache(
                                &mut cache,
                                carrier,
                                context,
                                SHARD_SIZES - 1,
                            );
                            // Random fronts plus long deliberately decreasing-score
                            // skylines exercise removals within and across both FEC
                            // discontinuities, including exact equal-score ties.
                            for population in 0..4 {
                                let mut exact: Vec<PlannerState> = Vec::new();
                                let mut sorted = Vec::new();
                                let mut tier = usize::MAX;
                                let mut tier_start = 0;
                                let mut random = 0x243f6a88u32;
                                for width in 0..SHARD_SIZES {
                                    if open_group_len == 0 && width != 0 {
                                        break;
                                    }
                                    random ^= random << 13;
                                    random ^= random >> 17;
                                    random ^= random << 5;
                                    let score_us = match population {
                                        0 => f64::from(random % 10_000),
                                        1 => 100_000.0 - width as f64 * 0.25,
                                        2 => 100_000.0 - width as f64 * 20.0,
                                        _ => f64::from(random % 7) * 1_000.0,
                                    };
                                    let candidate = PlannerState {
                                        score_us,
                                        open_group_len,
                                        open_group_max: width as u16,
                                        ..PlannerState::INVALID
                                    };
                                    if !exact.iter().copied().any(|existing| {
                                        state_dominates(existing, candidate, context, &cache)
                                    }) {
                                        exact.retain(|existing| {
                                            !state_dominates(candidate, *existing, context, &cache)
                                        });
                                        exact.push(candidate);
                                    }
                                    let next_tier = if fec_enabled {
                                        fec_recovery_shard_count(2, width)
                                    } else {
                                        0
                                    };
                                    if tier != next_tier {
                                        tier = next_tier;
                                        tier_start = sorted.len();
                                    }
                                    retain_nondominated_candidate(
                                        &mut sorted,
                                        0,
                                        &mut tier_start,
                                        candidate,
                                        context,
                                        &cache,
                                    );
                                    let signature = |states: &[PlannerState]| {
                                        states
                                            .iter()
                                            .map(|state| {
                                                (state.open_group_max, state.score_us.to_bits())
                                            })
                                            .collect::<Vec<_>>()
                                    };
                                    assert_eq!(
                                        signature(&sorted),
                                        signature(&exact),
                                        "loss={loss_upper} fec={fec_enabled} len={open_group_len} population={population} width={width}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn width_class_cache_preserves_every_exact_group_cost() {
        for loss_upper in [0.0, 0.01, 0.03, 0.09] {
            for fec_enabled in [false, true] {
                let carrier = CarrierDeliveryQuote {
                    loss_upper,
                    ..CarrierDeliveryQuote::default()
                };
                let context = PlanningContext {
                    carrier,
                    fec_enabled,
                    ..PlanningContext::default()
                };
                let mut cache = [[0.0; SHARD_SIZES]; GROUP_LENGTHS];
                fill_group_close_cost_cache(&mut cache, carrier, context, SHARD_SIZES - 1);
                for (group_len, costs) in cache.iter().enumerate() {
                    for (shard_size, cost) in costs.iter().enumerate() {
                        assert_eq!(
                            cost.to_bits(),
                            group_close_cost_us(carrier, context, group_len, shard_size).to_bits()
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_keystroke_echo_prices_only_the_close_widths_it_can_read() {
        // One prompt row, planned inline on a protected carrier.
        let header_bytes =
            merkur_codec::STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES;
        let row = PlannedRow::of(146, ContentClass::Text);
        let planning = context();
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        // A width the solve leaves alone keeps this NaN; debug builds replace
        // it with their own unfilled marker, which is a NaN too.
        for costs in &mut workspace.group_close_cost_us {
            costs.fill(f64::NAN);
        }
        plan_batch_partitions(
            &GlobalDisplayPlanningModel::default(),
            &cold_profiles(),
            ExecutionLane::Inline,
            DictionaryClass::Plain,
            planning,
            &[row],
            header_bytes,
            DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
            &mut workspace,
            &mut plan,
        );
        assert!(
            !workspace.states.is_empty(),
            "a datagram echo builds the FEC frontier"
        );
        let widest = header_bytes + row.bytes;
        let breakpoints = dominance_breakpoints(planning);
        assert!(breakpoints.iter().all(|&width| width > widest));
        let mut priced = 0;
        for (group_len, costs) in workspace.group_close_cost_us.iter().enumerate() {
            for (shard_size, cost) in costs.iter().enumerate() {
                if shard_size <= widest || breakpoints.contains(&shard_size) {
                    assert_eq!(
                        cost.to_bits(),
                        group_close_cost_us(planning.carrier, planning, group_len, shard_size)
                            .to_bits()
                    );
                    priced += 1;
                } else {
                    assert!(
                        cost.is_nan(),
                        "priced width {shard_size} of a {group_len}-group"
                    );
                }
            }
        }
        // 5 x 205 of the table's 5 x 1,101 entries.
        assert_eq!(priced, GROUP_LENGTHS * (widest + 1 + breakpoints.len()));
    }

    #[test]
    fn a_short_solve_after_a_long_one_touches_only_its_own_rows() {
        let global = GlobalDisplayPlanningModel::default();
        let profiles = cold_profiles();
        let solve = |workspace: &mut PlannerWorkspace, rows: &[PlannedRow]| {
            let mut plan = BatchPartitionPlan::default();
            plan_batch_partitions(
                &global,
                &profiles,
                ExecutionLane::Interactive,
                DictionaryClass::Plain,
                context(),
                rows,
                48,
                DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
                workspace,
                &mut plan,
            );
            assert!(!workspace.states.is_empty(), "both solves build a frontier");
            (plan.score_us().to_bits(), plan.iter().collect::<Vec<_>>())
        };
        let long: Vec<PlannedRow> = (0..40)
            .map(|row| PlannedRow::of(14 + row % 3 * 9, ContentClass::Sparse))
            .collect();
        let short = [
            PlannedRow::of(160, ContentClass::Text),
            PlannedRow::of(14, ContentClass::Sparse),
        ];
        let mut reused = PlannerWorkspace::default();
        solve(&mut reused, &long);
        let span_census = |workspace: &PlannerWorkspace| {
            workspace.span_costs[short.len() + 1..=long.len()]
                .iter()
                .map(|entry| entry.map(|entry| entry.raw_bytes))
                .collect::<Vec<_>>()
        };
        let long_prefix = reused.prefix;
        let long_frontier = (reused.frontier_starts, reused.frontier_ends);
        let long_spans = span_census(&reused);
        assert!(long_spans.iter().all(Option::is_some));
        // The long solve's leftovers cannot change the short plan.
        assert_eq!(
            solve(&mut reused, &short),
            solve(&mut PlannerWorkspace::default(), &short)
        );
        // Nor does the short solve clear them: it writes rows 0..=2 only.
        let past = short.len() + 1..=long.len();
        assert_eq!(reused.prefix[past.clone()], long_prefix[past.clone()]);
        assert_eq!(
            reused.frontier_starts[past.clone()],
            long_frontier.0[past.clone()]
        );
        assert_eq!(reused.frontier_ends[past.clone()], long_frontier.1[past]);
        assert_eq!(span_census(&reused), long_spans);
    }

    #[test]
    fn read_mostly_posterior_matches_a_fresh_window_scan_bitwise() {
        let mut random = 0x2545_f491u32;
        let mut cached = ReadMostlyPosterior::default();
        let mut plain = BoundedPosterior::default();
        for step in 0..5_000 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            match random % 97 {
                0 => {
                    cached.reset();
                    plain.reset();
                }
                selector => {
                    // Rejected samples must leave both windows unchanged.
                    let value = match selector {
                        1 => f64::NAN,
                        2 => -1.0,
                        _ => f64::from(random % 1_000_000) / 13.0,
                    };
                    cached.observe(value);
                    plain.observe(value);
                }
            }
            let cold = f64::from(step % 11) * 17.5;
            assert_eq!(
                cached.predictive_upper(cold).to_bits(),
                plain.predictive_upper(cold).to_bits(),
                "step {step}"
            );
        }
    }

    #[test]
    fn a_read_mostly_read_does_not_rescan_its_window() {
        let mut cached = ReadMostlyPosterior::default();
        for sample in 0..POSTERIOR_SAMPLES {
            cached.observe(100.0 + sample as f64);
        }
        let bound = cached.predictive_upper(1.0);
        // A read applies the tail formula to the moments the last write
        // stored; it never walks the samples again.
        cached.window.samples = [1e9; POSTERIOR_SAMPLES];
        assert_eq!(cached.predictive_upper(1.0).to_bits(), bound.to_bits());
    }

    #[test]
    fn stepped_posterior_reads_match_single_reads_bitwise() {
        let mut random = 0x9e37_79b9u32;
        for trial in 0..2_000 {
            // 0-69 samples per window: empty, cold, warm and wrapped windows
            // of unequal lengths in one step.
            let windows: [BoundedPosterior; 6] = std::array::from_fn(|lane| {
                let mut window = BoundedPosterior::default();
                for _ in 0..(trial * 7 + lane * 13) % 70 {
                    random ^= random << 13;
                    random ^= random >> 17;
                    random ^= random << 5;
                    window.observe(f64::from(random % 100_000) / 97.0);
                }
                window
            });
            let colds: [f64; 6] = std::array::from_fn(|lane| lane as f64 * 3.5 + 0.25);
            let stepped = BoundedPosterior::predictive_uppers(windows.each_ref(), colds);
            for lane in 0..6 {
                assert_eq!(
                    stepped[lane].to_bits(),
                    windows[lane].predictive_upper(colds[lane]).to_bits(),
                    "trial {trial} lane {lane}"
                );
            }
        }
    }

    #[test]
    fn a_class_snapshot_reads_each_ratio_bucket_like_a_fresh_scan() {
        let mut peer = PeerDisplayPlanningModel::default();
        let representative = [512, 768, 1_536, 3_072, 6_144, 12_288];
        // Buckets from empty through wrapped, so cold, floored and warm
        // bounds meet in one snapshot.
        for (class, bytes) in representative.into_iter().enumerate() {
            for sample in 0..class * 7 {
                let ratio = 0.05 + 0.13 * ((sample * 7 + class) % 11) as f64 / 11.0;
                peer.observe_ratio(bytes, ContentClass::Text, DictionaryClass::Plain, ratio);
            }
        }
        let snapshot = peer.snapshot(ContentClass::Text, DictionaryClass::Plain);
        for (class, bytes) in representative.into_iter().enumerate() {
            let window = &peer.ratio[PeerDisplayPlanningModel::ratio_index(
                bytes,
                ContentClass::Text,
                DictionaryClass::Plain,
            )];
            assert_eq!(
                snapshot.ratio_by_size[class].to_bits(),
                window.predictive_upper(0.5).clamp(0.01, 1.0).to_bits(),
                "class {class}"
            );
        }
    }

    #[test]
    fn multirow_feasibility_bound_respects_nonmonotone_size_buckets() {
        let cap = DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES;
        let mut peer = PeerDisplayPlanningModel::default()
            .snapshot(ContentClass::Color, DictionaryClass::Plain);
        for class in 0..SIZE_CLASSES {
            for ratio in [0.01, 0.125, 0.5, 0.999, 1.0] {
                peer.ratio_by_size = [1.0; SIZE_CLASSES];
                peer.ratio_by_size[class] = ratio;
                let limit = multirow_raw_limit(peer, cap);
                for bytes in limit.saturating_sub(2)..=cap * 101 {
                    let mut class_bytes = [0; CONTENT_CLASSES];
                    class_bytes[ContentClass::Color.index()] = bytes;
                    let feasible = batch_candidates(
                        &[peer; CONTENT_CLASSES],
                        &[[0.0; SIZE_CLASSES]; CONTENT_CLASSES],
                        class_bytes,
                        bytes,
                        false,
                        cap,
                        DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES,
                    )
                    .into_iter()
                    .any(|candidate| candidate.is_some());
                    assert!(!feasible || bytes <= limit);
                }
            }
        }
    }

    fn brute_force_plan(
        global: &GlobalDisplayPlanningModel,
        profiles: &[PeerPlanningSnapshot; CONTENT_CLASSES],
        lane: ExecutionLane,
        dictionary: DictionaryClass,
        context: PlanningContext,
        rows: &[PlannedRow],
        header_bytes: usize,
        wire_cap: usize,
    ) -> (f64, Vec<(usize, Representation)>) {
        struct Search<'a> {
            profiles: [PeerPlanningSnapshot; CONTENT_CLASSES],
            context: PlanningContext,
            rows: &'a [PlannedRow],
            prefix: Vec<usize>,
            class_prefix: Vec<[u32; CONTENT_CLASSES]>,
            sender_upper_by_size: [[f64; SIZE_CLASSES]; CONTENT_CLASSES],
            group_close_cost_us: [[f64; SHARD_SIZES]; GROUP_LENGTHS],
            header_bytes: usize,
            wire_cap: usize,
            best_score: f64,
            best_schedule: Vec<(usize, Representation)>,
        }

        impl Search<'_> {
            fn visit(
                &mut self,
                start: usize,
                state: PlannerState,
                schedule: &mut Vec<(usize, Representation)>,
            ) {
                if start == self.rows.len() {
                    let score = self.context.carrier.fixed_delivery_us()
                        + self.context.receiver_service_debt_us
                        + state.score_us
                        + cached_group_close_cost_us(
                            &self.group_close_cost_us,
                            usize::from(state.open_group_len),
                            usize::from(state.open_group_max),
                        );
                    if score < self.best_score {
                        self.best_score = score;
                        self.best_schedule.clone_from(schedule);
                    }
                    return;
                }
                for end in start + 1..=self.rows.len() {
                    let raw_bytes =
                        self.header_bytes + self.prefix[end].saturating_sub(self.prefix[start]);
                    let class_bytes = span_class_bytes(&self.class_prefix, start, end);
                    for choice in batch_candidates(
                        &self.profiles,
                        &self.sender_upper_by_size,
                        class_bytes,
                        raw_bytes,
                        end == start + 1,
                        self.wire_cap,
                        self.context.datagram_max_payload_bytes,
                    )
                    .into_iter()
                    .flatten()
                    {
                        schedule.push((end, choice.representation));
                        let base_cost_us =
                            candidate_base_cost_us(choice, self.context.carrier, self.context);
                        let next = transition_state(
                            state,
                            0,
                            end,
                            choice,
                            base_cost_us,
                            self.context,
                            &self.group_close_cost_us,
                        );
                        self.visit(end, next, schedule);
                        schedule.pop();
                    }
                }
            }
        }

        let mut prefix = vec![0usize; rows.len() + 1];
        let mut class_prefix = vec![[0u32; CONTENT_CLASSES]; rows.len() + 1];
        for (index, row) in rows.iter().enumerate() {
            prefix[index + 1] = prefix[index] + row.bytes;
            let mut classes = class_prefix[index];
            classes[row.class.index()] += row.bytes as u32;
            class_prefix[index + 1] = classes;
        }
        let sender_upper_by_size = std::array::from_fn(|content| {
            std::array::from_fn(|class| {
                let bytes = [512, 768, 1_536, 3_072, 6_144, 12_288][class];
                global.sender_service_upper_us(
                    lane,
                    bytes,
                    CONTENT_CLASS_BY_INDEX[content],
                    dictionary,
                )
            })
        });
        let mut group_close_cost_us = [[0.0; SHARD_SIZES]; GROUP_LENGTHS];
        fill_group_close_cost_cache(
            &mut group_close_cost_us,
            context.carrier,
            context,
            SHARD_SIZES - 1,
        );
        let mut search = Search {
            profiles: *profiles,
            context,
            rows,
            prefix,
            class_prefix,
            sender_upper_by_size,
            group_close_cost_us,
            header_bytes,
            wire_cap,
            best_score: f64::INFINITY,
            best_schedule: Vec::new(),
        };
        search.visit(
            0,
            PlannerState {
                score_us: 0.0,
                open_group_len: context
                    .initial_fec_group_len
                    .min(planned_fec_group_size(context).saturating_sub(1))
                    as u8,
                open_group_max: context.initial_fec_group_max_bytes as u16,
                predecessor: 0,
                end: 0,
                representation: Representation::Raw,
                prefix_best: 0,
            },
            &mut Vec::new(),
        );
        (search.best_score, search.best_schedule)
    }

    #[test]
    fn forward_planning_storage_layout() {
        println!(
            "forward-planning-layout pointer_bytes={} posterior_bytes={} hop_quote_bytes={} carrier_quote_bytes={} optional_carrier_quote_bytes={} planning_context_bytes={} peer_model_bytes={} peer_state_bytes={}",
            std::mem::size_of::<usize>(),
            std::mem::size_of::<BoundedPosterior>(),
            std::mem::size_of::<CarrierHopQuote>(),
            std::mem::size_of::<CarrierDeliveryQuote>(),
            std::mem::size_of::<Option<CarrierDeliveryQuote>>(),
            std::mem::size_of::<PlanningContext>(),
            std::mem::size_of::<PeerDisplayPlanningModel>(),
            std::mem::size_of::<crate::connection::PeerDisplayState>(),
        );
    }

    fn context() -> PlanningContext {
        PlanningContext {
            carrier: CarrierDeliveryQuote {
                one_way_us: 10_000.0,
                jitter_upper_us: 1_000.0,
                congestion_window_bytes: 4_800,
                bytes_in_flight: 4_000,
                send_buffer_occupied_bytes: 0,
                mtu_bytes: 1_200,
                pacing_rate_bps: 0,
                loss_upper: 0.01,
                serial_hops: None,
            },
            alternate_carrier: None,
            datagram_max_payload_bytes: 1_100,
            fec_group_size: 4,
            fec_enabled: true,
            initial_fec_group_len: 0,
            initial_fec_group_max_bytes: 0,
            receiver_service_debt_us: 0.0,
            earliest_uncompressed_send_us: 0.0,
            higher_priority_preparation_jobs: 0,
        }
    }

    #[test]
    fn a_reliable_only_relaxed_optimum_skips_fec_work_but_not_an_inherited_group() {
        let global = GlobalDisplayPlanningModel::default();
        let peer = PeerPlanningSnapshot {
            ratio_by_size: [0.75; SIZE_CLASSES],
            receiver_upper_by_surface: [0.0; SIZE_CLASSES * RATIO_CLASSES],
            receiver_service_debt_us: 0.0,
        };
        let rows =
            [4_000, 5_000, 6_000, 7_000].map(|bytes| PlannedRow::of(bytes, ContentClass::Color));
        for initial_fec_group_len in [0, 1, 2, 3] {
            let context = PlanningContext {
                initial_fec_group_len,
                initial_fec_group_max_bytes: 300,
                ..context()
            };
            let mut workspace = PlannerWorkspace::default();
            let mut plan = BatchPartitionPlan::default();
            plan_batch_partitions(
                &global,
                &[peer; CONTENT_CLASSES],
                ExecutionLane::Bulk,
                DictionaryClass::Plain,
                context,
                &rows,
                merkur_codec::STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES,
                500,
                &mut workspace,
                &mut plan,
            );
            let (expected_score, _) = brute_force_plan(
                &global,
                &[peer; CONTENT_CLASSES],
                ExecutionLane::Bulk,
                DictionaryClass::Plain,
                context,
                &rows,
                merkur_codec::STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES,
                500,
            );
            assert!((plan.score_us - expected_score).abs() < 1e-8);
            assert_eq!(plan.count, rows.len());
            assert_eq!(workspace.states.is_empty(), initial_fec_group_len == 0);
            assert_eq!(
                workspace.group_close_cost_us[2][300] == 0.0,
                initial_fec_group_len == 0
            );
        }
    }

    #[test]
    fn packet_boundary_can_decide_a_post_attempt_plan() {
        let mut peer = PeerDisplayPlanningModel::default();
        peer.apply_receiver_profile(
            1,
            0,
            0,
            &[ReceiverProfileBucket {
                dictionary_class: 0,
                size_class: size_class(1_101),
                ratio_class: ratio_class(0.999),
                sample_count: 32,
                wire_ratio_ppm: 999_000,
                mean_us: 1,
                variance_us2: 0,
                upper_us: 1,
            }],
        );
        assert_eq!(
            choose_after_compression(
                peer.snapshot(ContentClass::Sparse, DictionaryClass::Plain),
                1_101,
                1_100,
                DictionaryClass::Plain,
                context(),
            ),
            Representation::Compressed,
        );
    }

    #[test]
    fn sender_cost_is_only_charged_past_the_raw_send_time() {
        let mut global = GlobalDisplayPlanningModel::default();
        let mut peer = PeerDisplayPlanningModel::default();
        for _ in 0..8 {
            global.observe_sender_service(
                ExecutionLane::Bulk,
                4_000,
                ContentClass::Text,
                DictionaryClass::Plain,
                100.0,
            );
            peer.observe_ratio(4_000, ContentClass::Text, DictionaryClass::Plain, 0.2);
        }
        let mut hidden = context();
        hidden.earliest_uncompressed_send_us = 200.0;
        assert!(should_attempt_compression(
            &global,
            peer.snapshot(ContentClass::Text, DictionaryClass::Plain),
            ExecutionLane::Bulk,
            4_000,
            ContentClass::Text,
            DictionaryClass::Plain,
            hidden,
        ));
    }

    #[test]
    fn opportunity_cost_is_the_candidates_service_per_waiting_higher_priority_job() {
        let mut global = GlobalDisplayPlanningModel::default();
        let mut peer = PeerDisplayPlanningModel::default();
        for _ in 0..8 {
            global.observe_sender_service(
                ExecutionLane::Bulk,
                4_000,
                ContentClass::Text,
                DictionaryClass::Plain,
                100.0,
            );
            peer.observe_ratio(4_000, ContentClass::Text, DictionaryClass::Plain, 0.2);
        }
        let profile = peer.snapshot(ContentClass::Text, DictionaryClass::Plain);
        let mut unopposed = context();
        unopposed.carrier.pacing_rate_bps = 50_000_000;
        unopposed.carrier.one_way_us = 100.0;
        unopposed.carrier.jitter_upper_us = 0.0;
        unopposed.carrier.loss_upper = 0.0;
        assert!(should_attempt_compression(
            &global,
            profile,
            ExecutionLane::Bulk,
            4_000,
            ContentClass::Text,
            DictionaryClass::Plain,
            unopposed,
        ));
        let opposed = PlanningContext {
            higher_priority_preparation_jobs: 100,
            ..unopposed
        };
        assert!(!should_attempt_compression(
            &global,
            profile,
            ExecutionLane::Bulk,
            4_000,
            ContentClass::Text,
            DictionaryClass::Plain,
            opposed,
        ));
    }

    #[test]
    fn receiver_cost_is_conditioned_on_wire_ratio() {
        let mut peer = PeerDisplayPlanningModel::default();
        peer.apply_receiver_profile(
            1,
            0,
            0,
            &[
                ReceiverProfileBucket {
                    dictionary_class: 0,
                    size_class: size_class(2_000),
                    ratio_class: ratio_class(0.1),
                    sample_count: 32,
                    wire_ratio_ppm: 100_000,
                    mean_us: 3,
                    variance_us2: 0,
                    upper_us: 3,
                },
                ReceiverProfileBucket {
                    dictionary_class: 0,
                    size_class: size_class(2_000),
                    ratio_class: ratio_class(0.75),
                    sample_count: 32,
                    wire_ratio_ppm: 750_000,
                    mean_us: 40,
                    variance_us2: 0,
                    upper_us: 40,
                },
            ],
        );
        assert_eq!(
            peer.receiver_upper_us(2_000, 0.1, DictionaryClass::Plain),
            3.0
        );
        assert_eq!(
            peer.receiver_upper_us(2_000, 0.75, DictionaryClass::Plain),
            40.0
        );
    }

    #[test]
    fn receiver_calibration_ratio_never_predicts_content_compression() {
        let mut peer = PeerDisplayPlanningModel::default();
        peer.apply_receiver_profile(
            1,
            0,
            0,
            &[ReceiverProfileBucket {
                dictionary_class: DictionaryClass::Plain.index(),
                size_class: size_class(2_000),
                ratio_class: ratio_class(0.1),
                sample_count: 32,
                wire_ratio_ppm: 100_000,
                mean_us: 3,
                variance_us2: 0,
                upper_us: 3,
            }],
        );
        assert_eq!(
            peer.snapshot(ContentClass::Text, DictionaryClass::Plain)
                .ratio(2_000),
            0.5
        );
        for _ in 0..POSTERIOR_WARM_SAMPLES {
            peer.observe_ratio(2_000, ContentClass::Text, DictionaryClass::Plain, 0.2);
        }
        assert_eq!(
            peer.snapshot(ContentClass::Text, DictionaryClass::Plain)
                .ratio(2_000),
            0.2
        );
    }

    #[test]
    fn one_fast_sample_cannot_erase_the_cold_upper_and_a_slow_step_is_immediate() {
        let mut posterior = BoundedPosterior::default();
        posterior.observe(10.0);
        assert_eq!(posterior.predictive_upper(100.0), 100.0);
        for _ in 1..POSTERIOR_WARM_SAMPLES {
            posterior.observe(10.0);
        }
        assert_eq!(posterior.predictive_upper(100.0), 10.0);
        posterior.observe(400.0);
        assert!(
            posterior.predictive_upper(100.0) > 100.0,
            "the first slow sample after a network step must widen the tail"
        );
        posterior.reset();
        assert_eq!(posterior.predictive_upper(100.0), 100.0);
    }

    #[test]
    fn adaptive_redraw_ratio_is_size_conditioned_and_worsens_without_hysteresis() {
        let peer = PeerDisplayPlanningModel::default()
            .snapshot(ContentClass::Color, DictionaryClass::Plain);
        let mut blank_then_color = peer;
        blank_then_color.observe_actual_ratio(500, 0.05);
        assert!(blank_then_color.ratio(500) < peer.ratio(500));
        assert_eq!(
            blank_then_color.ratio(2_000),
            peer.ratio(2_000),
            "a compressible prefix cannot predict a high-entropy larger class"
        );
        blank_then_color.observe_actual_ratio(500, 0.95);
        assert_eq!(blank_then_color.ratio(500), 0.95);

        let mut color_then_blank = peer;
        color_then_blank.observe_actual_ratio(2_000, 0.95);
        color_then_blank.observe_actual_ratio(500, 0.05);
        assert_eq!(color_then_blank.ratio(2_000), 0.95);
        assert!(color_then_blank.ratio(500) < peer.ratio(500));
    }

    #[test]
    fn carrier_epoch_reset_discards_recent_loss_and_delivery_history() {
        let mut peer = PeerDisplayPlanningModel::default();
        let mut quote = context().carrier;
        quote.one_way_us = 200_000.0;
        quote.loss_upper = 0.09;
        for _ in 0..POSTERIOR_WARM_SAMPLES {
            peer.observe_carrier_quote(1, quote);
        }
        let observed = peer.carrier_quote(1, CarrierDeliveryQuote::default());
        assert!(observed.one_way_us >= 200_000.0);
        assert!(observed.loss_upper >= 0.09);

        peer.reset_carrier_observations(1);
        let fallback = CarrierDeliveryQuote::default();
        let reset = peer.carrier_quote(1, fallback);
        assert_eq!(reset.one_way_us, fallback.one_way_us);
        assert_eq!(reset.loss_upper, fallback.loss_upper);
    }

    #[test]
    fn learned_network_tail_changes_a_serial_carrier_without_double_counting_hops() {
        let hop = |one_way_us: f64, loss_upper: f64| CarrierDeliveryQuote {
            one_way_us,
            jitter_upper_us: 0.0,
            congestion_window_bytes: 12_000,
            bytes_in_flight: 0,
            send_buffer_occupied_bytes: 0,
            mtu_bytes: 1_200,
            pacing_rate_bps: 96_000_000,
            loss_upper,
            serial_hops: None,
        };
        let fast = CarrierDeliveryQuote::serial(hop(5_000.0, 0.0), hop(5_000.0, 0.0));
        let slow_lossy = CarrierDeliveryQuote::serial(hop(40_000.0, 0.03), hop(60_000.0, 0.06));
        let mut peer = PeerDisplayPlanningModel::default();
        for _ in 0..POSTERIOR_WARM_SAMPLES {
            peer.observe_carrier_quote(1, slow_lossy);
        }
        // The attachment's newest instantaneous quote recovered, but bounded
        // recent network/loss evidence must remain active in this generation.
        peer.observe_carrier_quote(1, fast);
        let predicted = peer.carrier_quote(1, fast);
        assert!(predicted.one_way_us > fast.one_way_us);
        assert!(predicted.loss_upper > fast.loss_upper);
        assert!(
            predicted.earliest_delivery_us(2_400, 2) > fast.earliest_delivery_us(2_400, 2),
            "learned serial-carrier tails must affect the planner objective"
        );
    }

    #[test]
    fn completion_objective_never_trades_lower_total_latency_for_utility_weighting() {
        let mut carrier = context().carrier;
        carrier.pacing_rate_bps = 8_000_000;
        let context = PlanningContext {
            carrier,
            ..context()
        };
        let cpu_heavy = BatchCandidate {
            plaintext_bytes: 100,
            lane: DeliveryLane::Datagram,
            representation: Representation::Compressed,
            sender_service_us: 100.0,
            receiver_service_us: 0.0,
        };
        let lower_completion = BatchCandidate {
            plaintext_bytes: 150,
            lane: DeliveryLane::Datagram,
            representation: Representation::Raw,
            sender_service_us: 0.0,
            receiver_service_us: 0.0,
        };
        assert!(
            candidate_base_cost_us(lower_completion, carrier, context)
                < candidate_base_cost_us(cpu_heavy, carrier, context),
            "utility scheduling happens outside a single domain plan; its cost is actual completion"
        );
    }

    #[test]
    fn an_older_receiver_profile_cannot_replace_newer_authenticated_evidence() {
        let bucket = |upper_us| ReceiverProfileBucket {
            dictionary_class: DictionaryClass::Plain.index(),
            size_class: size_class(2_000),
            ratio_class: ratio_class(0.2),
            sample_count: 32,
            wire_ratio_ppm: 200_000,
            mean_us: upper_us,
            variance_us2: 0,
            upper_us,
        };
        let mut peer = PeerDisplayPlanningModel::default();
        peer.apply_receiver_profile(2, 0, 0, &[bucket(40)]);
        peer.apply_receiver_profile(1, 0, 0, &[bucket(3)]);
        assert_eq!(
            peer.receiver_upper_us(2_000, 0.2, DictionaryClass::Plain),
            40.0,
        );
    }

    #[test]
    fn packet_plan_uses_the_carrier_selected_by_the_owner() {
        let mut context = context();
        context.carrier.one_way_us = 1_000.0;
        let plan = single_record_plan(1_000, 0.0, context);
        assert!(plan.tail_latency_us < 5_000.0);
    }

    fn crossing_carrier_context() -> PlanningContext {
        let direct = CarrierDeliveryQuote {
            one_way_us: 1_000.0,
            pacing_rate_bps: 8_000_000,
            ..CarrierDeliveryQuote::default()
        };
        let edge = CarrierDeliveryQuote {
            one_way_us: 2_500.0,
            pacing_rate_bps: 80_000_000,
            ..direct
        };
        assert!(direct.earliest_delivery_us(1_084, 1) < edge.earliest_delivery_us(1_084, 1));
        assert!(!direct.dominates(edge));
        assert!(!edge.dominates(direct));
        PlanningContext {
            carrier: direct,
            alternate_carrier: Some(edge),
            ..PlanningContext::default()
        }
    }

    #[test]
    fn raw_on_the_other_carrier_beats_compression_on_the_small_packet_winner() {
        let context = crossing_carrier_context();
        let peer = PeerPlanningSnapshot {
            ratio_by_size: [0.2; SIZE_CLASSES],
            receiver_upper_by_surface: [2_000.0; SIZE_CLASSES * RATIO_CLASSES],
            receiver_service_debt_us: 0.0,
        };
        let small_packet_winner_only = PlanningContext {
            alternate_carrier: None,
            ..context
        };
        assert_eq!(
            choose_after_compression(
                peer,
                5_000,
                1_000,
                DictionaryClass::Plain,
                small_packet_winner_only
            ),
            Representation::Compressed,
        );
        assert_eq!(
            choose_after_compression(peer, 5_000, 1_000, DictionaryClass::Plain, context),
            Representation::Raw,
        );
        let global = GlobalDisplayPlanningModel::default();
        assert!(!should_attempt_compression(
            &global,
            peer,
            ExecutionLane::Bulk,
            5_000,
            ContentClass::Text,
            DictionaryClass::Plain,
            context,
        ));
        let raw_edge = single_record_plan(5_000, 0.0, context.alternate().unwrap());
        let compressed_direct = single_record_plan(1_000, 2_000.0, context);
        assert!(raw_edge.tail_latency_us + 900.0 < compressed_direct.tail_latency_us);
    }

    #[test]
    fn crossing_carrier_partition_choice_matches_both_complete_single_carrier_optima() {
        let context = crossing_carrier_context();
        let global = GlobalDisplayPlanningModel::default();
        let mut workspace = PlannerWorkspace::default();
        for (receiver_us, rows) in [
            (0.0, &[PlannedRow::of(5_000, ContentClass::Text)][..]),
            (2_000.0, &[PlannedRow::of(5_000, ContentClass::Text)][..]),
            (0.0, &[PlannedRow::of(600, ContentClass::Text); 8][..]),
            (2_000.0, &[PlannedRow::of(600, ContentClass::Text); 8][..]),
        ] {
            let peer = PeerPlanningSnapshot {
                ratio_by_size: [0.2; SIZE_CLASSES],
                receiver_upper_by_surface: [receiver_us; SIZE_CLASSES * RATIO_CLASSES],
                receiver_service_debt_us: 0.0,
            };
            let mut primary = BatchPartitionPlan::default();
            let mut alternate = BatchPartitionPlan::default();
            let mut combined = BatchPartitionPlan::default();
            for (planning, result) in [
                (
                    PlanningContext {
                        alternate_carrier: None,
                        ..context
                    },
                    &mut primary,
                ),
                (context.alternate().unwrap(), &mut alternate),
                (context, &mut combined),
            ] {
                plan_batch_partitions(
                    &global,
                    &[peer; CONTENT_CLASSES],
                    ExecutionLane::Bulk,
                    DictionaryClass::Plain,
                    planning,
                    rows,
                    0,
                    1_084,
                    &mut workspace,
                    result,
                );
            }
            let expected = if receiver_us == 0.0 {
                &primary
            } else {
                &alternate
            };
            assert_eq!(combined.score_us(), expected.score_us());
            assert_eq!(combined.get(0), expected.get(0));
            assert_eq!(
                combined.score_us(),
                primary.score_us().min(alternate.score_us()),
            );
            assert_eq!(
                combined.get(0),
                Some((
                    if receiver_us == 0.0 { rows.len() } else { 1 },
                    if receiver_us == 0.0 {
                        Representation::Compressed
                    } else {
                        Representation::Raw
                    }
                )),
            );
        }
    }

    #[test]
    fn carrier_dominance_requires_every_monotone_schedule_term() {
        let mut worse = CarrierDeliveryQuote::default();
        worse.one_way_us *= 2.0;
        let better = CarrierDeliveryQuote::default();
        assert!(better.dominates(worse));
        assert!(!worse.dominates(better));
        worse.pacing_rate_bps = 1_000_000_000;
        assert!(!better.dominates(worse));
        worse = better;
        worse.loss_upper = 0.01;
        assert!(better.dominates(worse));
        assert!(!worse.dominates(better));
        worse = better;
        worse.mtu_bytes -= 1;
        assert!(better.dominates(worse));
        assert!(!worse.dominates(better));
    }

    #[test]
    fn exact_wire_shape_distinguishes_datagram_fec_and_one_reliable_record() {
        assert_eq!(
            display_datagram_wire_len(1_084),
            1_084 + 1 + crate::e2e::FRAME_OVERHEAD
        );
        assert_eq!(
            display_reliable_record_wire_len(1_085),
            1_085 + std::mem::size_of::<u32>() + crate::e2e::FRAME_OVERHEAD,
        );
        let mut planning = context();
        planning.datagram_max_payload_bytes = 1_084;
        let jumbo = single_record_plan(2_500, 0.0, planning);
        assert_eq!(jumbo.repair_packets, 0);
        assert_eq!(jumbo.wire_bytes, display_reliable_record_wire_len(2_500));
        assert_eq!(
            jumbo.data_packets,
            jumbo.wire_bytes.div_ceil(planning.carrier.mtu_bytes),
        );

        let recovery = fec_recovery_shard_count(4, 500);
        assert_eq!(recovery, 2);
        let repair_plaintext = merkur_codec::DISPLAY_FEC_HEADER_BYTES + recovery * 500;
        assert!(repair_plaintext <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES);
        assert_eq!(
            display_datagram_wire_len(repair_plaintext),
            1 + repair_plaintext + crate::e2e::FRAME_OVERHEAD,
        );
    }

    #[test]
    fn single_record_compression_choice_prices_the_open_adjacent_fec_group() {
        let mut planning = context();
        planning.initial_fec_group_len = 1;
        planning.initial_fec_group_max_bytes = 500;
        let plan = single_record_plan(400, 0.0, planning);
        let repair_plaintext =
            merkur_codec::DISPLAY_FEC_HEADER_BYTES + DisplayPolicy::FEC_RECOVERY_SHARD_COUNT * 500;
        assert_eq!(plan.data_packets, 1);
        assert_eq!(plan.repair_packets, 1);
        assert_eq!(
            plan.wire_bytes,
            display_datagram_wire_len(400) + display_datagram_wire_len(repair_plaintext),
        );
    }

    #[test]
    fn p95_cvar_loss_tail_is_profile_sensitive_and_fec_group_aware() {
        let one_percent = geometric_tail_cvar_cycles(0.01, TAIL_PERCENTILE);
        let three_percent = geometric_tail_cvar_cycles(0.03, TAIL_PERCENTILE);
        let nine_percent = geometric_tail_cvar_cycles(0.09, TAIL_PERCENTILE);
        assert!(one_percent > 0.0);
        assert!(one_percent < three_percent);
        assert!(three_percent < nine_percent);
        assert!(nine_percent >= 1.0, "9% loss belongs in the p95 tail");

        let unprotected = datagram_group_failure_probability(4, 0, 0.09);
        let protected = datagram_group_failure_probability(4, 2, 0.09);
        assert!(protected < unprotected);
        assert!(
            protected > 0.0,
            "the single repair datagram can itself be lost"
        );
    }

    fn cold_profiles() -> [PeerPlanningSnapshot; CONTENT_CLASSES] {
        let model = PeerDisplayPlanningModel::default();
        [
            model.snapshot(ContentClass::Sparse, DictionaryClass::Plain),
            model.snapshot(ContentClass::Text, DictionaryClass::Plain),
            model.snapshot(ContentClass::Color, DictionaryClass::Plain),
        ]
    }

    #[test]
    fn a_class_change_between_rows_is_priced_and_never_forced_into_a_boundary() {
        // Shell output in a wide terminal alternates mostly-blank rows with rows
        // of text. Measured on 2026-09-07, cutting every class change produced
        // one datagram per row; the planner must instead span classes whenever
        // the summed-census class prices the span cheaper.
        let global = GlobalDisplayPlanningModel::default();
        let profiles = cold_profiles();
        let rows: Vec<PlannedRow> = (0..40)
            .map(|row| {
                if row % 2 == 0 {
                    PlannedRow::of(14, ContentClass::Sparse)
                } else {
                    PlannedRow::of(160, ContentClass::Text)
                }
            })
            .collect();
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        plan_batch_partitions(
            &global,
            &profiles,
            ExecutionLane::Bulk,
            DictionaryClass::Plain,
            context(),
            &rows,
            48,
            DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
            &mut workspace,
            &mut plan,
        );
        let ends = plan.iter().map(|(end, _)| end).collect::<Vec<_>>();
        let mut start = 0;
        for end in &ends {
            assert!(end - start >= 2, "every record spans both classes: ends={ends:?}");
            start = *end;
        }
        assert!(ends.len() <= 4, "forty alternating rows pack into a few records: ends={ends:?}");
        // The prefix arithmetic returns every row's own bytes under its own class
        // and prices the whole span by its byte-dominant class.
        for (index, row) in rows.iter().enumerate() {
            let bytes = span_class_bytes(&workspace.class_prefix, index, index + 1);
            assert_eq!(bytes[row.class.index()], row.bytes);
            assert_eq!(bytes.iter().sum::<usize>(), row.bytes);
        }
        assert_eq!(
            content_class_by_bytes(span_class_bytes(&workspace.class_prefix, 0, rows.len())),
            ContentClass::Text
        );
    }

    #[test]
    fn exact_partition_dp_matches_a_brute_force_oracle_across_content_classes() {
        let rows = [
            PlannedRow::of(137, ContentClass::Text),
            PlannedRow::of(14, ContentClass::Sparse),
            PlannedRow::of(89, ContentClass::Color),
            PlannedRow::of(377, ContentClass::Text),
            PlannedRow::of(14, ContentClass::Sparse),
            PlannedRow::of(263, ContentClass::Color),
        ];
        let global = GlobalDisplayPlanningModel::default();
        let mut profiles = cold_profiles();
        // Distinct learned ratios per class make a wrong class selection score
        // differently from the oracle instead of coinciding by symmetry.
        profiles[ContentClass::Sparse.index()].ratio_by_size = [0.15; SIZE_CLASSES];
        profiles[ContentClass::Text.index()].ratio_by_size = [0.35; SIZE_CLASSES];
        profiles[ContentClass::Color.index()].ratio_by_size = [0.7; SIZE_CLASSES];
        for loss in [0.0, 0.03] {
            let mut planning = context();
            planning.carrier.loss_upper = loss;
            planning.carrier.pacing_rate_bps = 3_000_000;
            planning.datagram_max_payload_bytes = 700;
            planning.fec_group_size = 3;
            let mut workspace = PlannerWorkspace::default();
            let mut plan = BatchPartitionPlan::default();
            plan_batch_partitions(
                &global,
                &profiles,
                ExecutionLane::Bulk,
                DictionaryClass::Plain,
                planning,
                &rows,
                48,
                700,
                &mut workspace,
                &mut plan,
            );
            let (oracle_score, _) = brute_force_plan(
                &global,
                &profiles,
                ExecutionLane::Bulk,
                DictionaryClass::Plain,
                planning,
                &rows,
                48,
                700,
            );
            assert!(
                (plan.score_us() - oracle_score).abs() < 1e-6,
                "loss={loss} plan={} oracle={oracle_score}",
                plan.score_us()
            );
        }
    }

    #[test]
    fn repeated_span_prices_follow_census_and_each_replan_profile() {
        let global = GlobalDisplayPlanningModel::default();
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        for classes in [
            [ContentClass::Text; 6],
            [
                ContentClass::Text,
                ContentClass::Color,
                ContentClass::Sparse,
                ContentClass::Text,
                ContentClass::Sparse,
                ContentClass::Color,
            ],
        ] {
            let rows = classes.map(|class| PlannedRow::of(180, class));
            for ratio in [0.1, 0.9, 0.3] {
                let mut profiles = cold_profiles();
                profiles[ContentClass::Text.index()].ratio_by_size = [ratio; SIZE_CLASSES];
                profiles[ContentClass::Color.index()].ratio_by_size = [0.75; SIZE_CLASSES];
                for loss in [0.0, 0.09] {
                    let mut planning = context();
                    planning.carrier.loss_upper = loss;
                    planning.carrier.pacing_rate_bps = 3_000_000;
                    plan_batch_partitions(
                        &global,
                        &profiles,
                        ExecutionLane::Bulk,
                        DictionaryClass::Plain,
                        planning,
                        &rows,
                        48,
                        700,
                        &mut workspace,
                        &mut plan,
                    );
                    let (score, _) = brute_force_plan(
                        &global,
                        &profiles,
                        ExecutionLane::Bulk,
                        DictionaryClass::Plain,
                        planning,
                        &rows,
                        48,
                        700,
                    );
                    assert!((plan.score_us() - score).abs() < 1e-6);
                }
            }
        }
    }

    #[test]
    fn exact_partition_dp_matches_a_brute_force_small_n_oracle() {
        let rows =
            [137, 211, 89, 377, 144, 263].map(|bytes| PlannedRow::of(bytes, ContentClass::Color));
        let global = GlobalDisplayPlanningModel::default();
        let peer = PeerDisplayPlanningModel::default()
            .snapshot(ContentClass::Color, DictionaryClass::Plain);
        let mut planning = context();
        planning.carrier.loss_upper = 0.09;
        planning.carrier.pacing_rate_bps = 3_000_000;
        planning.datagram_max_payload_bytes = 700;
        planning.fec_group_size = 3;
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        plan_batch_partitions(
            &global,
            &[peer; CONTENT_CLASSES],
            ExecutionLane::Bulk,
            DictionaryClass::Plain,
            planning,
            &rows,
            48,
            700,
            &mut workspace,
            &mut plan,
        );
        let (oracle_score, oracle_schedule) = brute_force_plan(
            &global,
            &[peer; CONTENT_CLASSES],
            ExecutionLane::Bulk,
            DictionaryClass::Plain,
            planning,
            &rows,
            48,
            700,
        );
        assert!((plan.score_us() - oracle_score).abs() < 1e-6);
        assert_eq!(plan.iter().collect::<Vec<_>>(), oracle_schedule);
    }

    #[test]
    fn partition_dp_matches_the_oracle_with_open_and_unprotected_groups() {
        let global = GlobalDisplayPlanningModel::default();
        let peer = PeerDisplayPlanningModel::default()
            .snapshot(ContentClass::Color, DictionaryClass::Plain);
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        for rows in [
            [17, 21, 19, 7, 14, 13],
            [137, 211, 89, 377, 144, 263],
            [1_040, 211, 1_600, 377, 144, 263],
        ]
        .map(|rows| rows.map(|bytes| PlannedRow::of(bytes, ContentClass::Color)))
        {
            for loss in [0.0, 0.01, 0.03, 0.09] {
                for fec_group_size in 1..=4 {
                    for open in 0..fec_group_size {
                        for (one_way_us, pacing_rate_bps) in
                            [(500.0, 1_000_000_000), (100_000.0, 1_000_000)]
                        {
                            let mut planning = context();
                            planning.carrier.loss_upper = loss;
                            planning.carrier.one_way_us = one_way_us;
                            planning.carrier.pacing_rate_bps = pacing_rate_bps;
                            planning.fec_group_size = fec_group_size;
                            planning.initial_fec_group_len = open;
                            planning.initial_fec_group_max_bytes = if open == 0 { 0 } else { 700 };
                            plan_batch_partitions(
                                &global,
                                &[peer; CONTENT_CLASSES],
                                ExecutionLane::Bulk,
                                DictionaryClass::Plain,
                                planning,
                                &rows,
                                47,
                                DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
                                &mut workspace,
                                &mut plan,
                            );
                            let (score, _) = brute_force_plan(
                                &global,
                                &[peer; CONTENT_CLASSES],
                                ExecutionLane::Bulk,
                                DictionaryClass::Plain,
                                planning,
                                &rows,
                                47,
                                DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
                            );
                            assert!(
                                (plan.score_us() - score).abs() < 1e-6,
                                "rows={rows:?} loss={loss} group={fec_group_size} open={open}"
                            );
                            // Equal-cost partitions can place their internal
                            // cut at different rows. Verify the complete chosen
                            // schedule is feasible and replays to the oracle's
                            // optimum, rather than imposing its DFS tie order.
                            let mut cache = [[0.0; SHARD_SIZES]; GROUP_LENGTHS];
                            fill_group_close_cost_cache(
                                &mut cache,
                                planning.carrier,
                                planning,
                                SHARD_SIZES - 1,
                            );
                            let sender = std::array::from_fn(|class| {
                                global.sender_service_upper_us(
                                    ExecutionLane::Bulk,
                                    [512, 768, 1_536, 3_072, 6_144, 12_288][class],
                                    ContentClass::Color,
                                    DictionaryClass::Plain,
                                )
                            });
                            let mut state = PlannerState {
                                score_us: 0.0,
                                open_group_len: open as u8,
                                open_group_max: planning.initial_fec_group_max_bytes as u16,
                                ..PlannerState::INVALID
                            };
                            let mut start = 0;
                            for (end, representation) in plan.iter() {
                                assert!(end > start && end <= rows.len());
                                let span_bytes =
                                    rows[start..end].iter().map(|row| row.bytes).sum::<usize>();
                                let raw_bytes = 47 + span_bytes;
                                let mut class_bytes = [0; CONTENT_CLASSES];
                                class_bytes[ContentClass::Color.index()] = span_bytes;
                                let choice = batch_candidates(
                                    &[peer; CONTENT_CLASSES],
                                    &[sender; CONTENT_CLASSES],
                                    class_bytes,
                                    raw_bytes,
                                    end == start + 1,
                                    DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES,
                                    planning.datagram_max_payload_bytes,
                                )
                                .into_iter()
                                .flatten()
                                .find(|choice| choice.representation == representation)
                                .expect("chosen representation must fit its complete record");
                                state = transition_state(
                                    state,
                                    0,
                                    end,
                                    choice,
                                    candidate_base_cost_us(choice, planning.carrier, planning),
                                    planning,
                                    &cache,
                                );
                                start = end;
                            }
                            assert_eq!(start, rows.len());
                            let replayed = state.score_us
                                + planning.carrier.fixed_delivery_us()
                                + planning.receiver_service_debt_us
                                + cached_group_close_cost_us(
                                    &cache,
                                    usize::from(state.open_group_len),
                                    usize::from(state.open_group_max),
                                );
                            assert!((replayed - score).abs() < 1e-6);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn maximum_row_plan_is_bounded_and_monotonic() {
        let rows = [PlannedRow::of(7, ContentClass::Text); MAX_PLANNED_ROWS];
        let global = GlobalDisplayPlanningModel::default();
        let peer = PeerDisplayPlanningModel::default()
            .snapshot(ContentClass::Text, DictionaryClass::Plain);
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        let started = std::time::Instant::now();
        plan_batch_partitions(
            &global,
            &[peer; CONTENT_CLASSES],
            ExecutionLane::Bulk,
            DictionaryClass::Plain,
            context(),
            &rows,
            48,
            1_084,
            &mut workspace,
            &mut plan,
        );
        let first_elapsed = started.elapsed();
        let ends = plan.iter().map(|(end, _)| end).collect::<Vec<_>>();
        let warmed_state_capacity = workspace.states.capacity();
        let warmed_candidate_capacity = workspace.candidates.capacity();
        let candidate_best_ptr = workspace.candidate_best.as_ptr();
        let first_score = plan.score_us();
        plan_batch_partitions(
            &global,
            &[peer; CONTENT_CLASSES],
            ExecutionLane::Bulk,
            DictionaryClass::Plain,
            context(),
            &rows,
            48,
            1_084,
            &mut workspace,
            &mut plan,
        );
        eprintln!(
            "MAX_ROWS planner: elapsed={:?} states={} max_frontier={}",
            first_elapsed,
            workspace.states.len(),
            (0..=MAX_PLANNED_ROWS)
                .map(|index| workspace.frontier_ends[index] - workspace.frontier_starts[index])
                .max()
                .unwrap_or(0),
        );
        assert_eq!(ends.last(), Some(&MAX_PLANNED_ROWS));
        assert_eq!(plan.score_us(), first_score);
        assert_eq!(workspace.states.capacity(), warmed_state_capacity);
        assert_eq!(workspace.candidates.capacity(), warmed_candidate_capacity);
        assert_eq!(workspace.candidate_best.as_ptr(), candidate_best_ptr);
        assert_eq!(workspace.candidate_best.len(), GROUP_LENGTHS * SHARD_SIZES);
        assert!(workspace.candidate_dirty.iter().all(|word| *word == 0));
        assert!(
            workspace
                .candidate_best
                .iter()
                .all(|candidate| !candidate.score_us.is_finite())
        );
        assert!(
            std::mem::size_of::<PlannerWorkspace>() < 64 * 1024,
            "the retained planner must not overflow small owner/simulator stacks",
        );
        assert!(workspace.states.len() <= MAX_PLANNER_STATES);
        assert!(ends.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(
            first_elapsed < std::time::Duration::from_secs(1),
            "MAX_ROWS planning exceeded its bounded off-owner budget: {:?}",
            first_elapsed,
        );
    }

    /// Release-mode tail and allocation oracle for the maximum protocol row
    /// count. It runs alone because the counting allocator is process-wide.
    #[test]
    #[ignore = "production performance workload; the counting allocator is process-wide"]
    fn production_maximum_row_partition_planner_benchmark() {
        use crate::edge_tunnel::test_allocations;

        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(200)
            .max(100);
        let global = GlobalDisplayPlanningModel::default();
        let peer = PeerDisplayPlanningModel::default()
            .snapshot(ContentClass::Text, DictionaryClass::Plain);
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        let crossing = crossing_carrier_context();
        let single = PlanningContext {
            alternate_carrier: None,
            ..crossing
        };
        let dominated = PlanningContext {
            alternate_carrier: Some(CarrierDeliveryQuote {
                one_way_us: 2_500.0,
                ..crossing.carrier
            }),
            ..single
        };
        for (row_count, row_bytes) in [(40, 180), (MAX_PLANNED_ROWS, 7)] {
            let rows = vec![PlannedRow::of(row_bytes, ContentClass::Text); row_count];
            for (scenario, planning) in [
                ("single", single),
                ("dominated", dominated),
                ("crossing", crossing),
            ] {
                for _ in 0..20 {
                    plan_batch_partitions(
                        &global,
                        &[peer; CONTENT_CLASSES],
                        ExecutionLane::Bulk,
                        DictionaryClass::Plain,
                        planning,
                        &rows,
                        48,
                        1_084,
                        &mut workspace,
                        &mut plan,
                    );
                }
                let schedule = plan.iter().collect::<Vec<_>>();
                let mut elapsed_us = Vec::with_capacity(samples);
                test_allocations::begin();
                for _ in 0..samples {
                    let started = std::time::Instant::now();
                    plan_batch_partitions(
                        &global,
                        &[peer; CONTENT_CLASSES],
                        ExecutionLane::Bulk,
                        DictionaryClass::Plain,
                        planning,
                        &rows,
                        48,
                        1_084,
                        &mut workspace,
                        &mut plan,
                    );
                    elapsed_us.push(started.elapsed().as_secs_f64() * 1_000_000.0);
                    std::hint::black_box(plan.score_us());
                }
                let tally = test_allocations::end();
                assert_eq!(tally.allocations, 0, "a warmed plan must not allocate");
                assert_eq!(
                    tally.allocated_bytes, 0,
                    "a warmed plan must request no heap bytes"
                );
                assert!(plan.iter().eq(schedule.iter().copied()));
                elapsed_us.sort_by(f64::total_cmp);
                let nearest_rank = |percentile: f64| {
                    let rank = (percentile * samples as f64).ceil().max(1.0) as usize - 1;
                    elapsed_us[rank.min(samples - 1)]
                };
                eprintln!(
                    "PLANNER release: scenario={scenario} rows={row_count} samples={samples} batches={} p50_us={:.3} p95_us={:.3} p99_us={:.3} max_us={:.3} allocations=0 allocated_bytes=0",
                    schedule.len(),
                    nearest_rank(0.50),
                    nearest_rank(0.95),
                    nearest_rank(0.99),
                    elapsed_us[samples - 1],
                );
            }
        }
    }
}
