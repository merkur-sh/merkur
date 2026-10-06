use std::{cmp, net::SocketAddr};

use tracing::trace;

use super::{
    mtud::MtuDiscovery,
    pacing::{optimal_capacity, Pacer},
    spaces::{PacketSpace, SentPacket},
};
use crate::{congestion, packet::SpaceId, Duration, Instant, TransportConfig, TIMER_GRANULARITY};

/// Most reordering the time threshold admits: one more round trip after the
/// first, RFC 8985's bound of one SRTT on the reordering window.
pub(super) const MAX_TIME_THRESHOLD: f32 = 2.0;

#[cfg(feature = "qlog")]
use qlog::events::quic::MetricsUpdated;

/// Description of a particular network path
pub(super) struct PathData {
    pub(super) remote: SocketAddr,
    pub(super) rtt: RttEstimator,
    /// Whether we're enabling ECN on outgoing packets
    pub(super) sending_ecn: bool,
    /// Congestion controller state
    pub(super) congestion: Box<dyn congestion::Controller>,
    /// Pacing state
    pub(super) pacing: Pacer,
    pub(super) challenge: Option<u64>,
    pub(super) challenge_pending: bool,
    /// Whether we're certain the peer can both send and receive on this address
    ///
    /// Initially equal to `use_stateless_retry` for servers, and becomes false again on every
    /// migration. Always true for clients.
    pub(super) validated: bool,
    /// Total size of all UDP datagrams sent on this path
    pub(super) total_sent: u64,
    /// Total size of all UDP datagrams received on this path
    pub(super) total_recvd: u64,
    /// The state of the MTU discovery process
    pub(super) mtud: MtuDiscovery,
    /// Packet number of the first packet sent after an RTT sample was collected on this path
    ///
    /// Used in persistent congestion determination.
    pub(super) first_packet_after_rtt_sample: Option<(SpaceId, u64)>,
    pub(super) in_flight: InFlight,
    /// Loss detection's packet reordering threshold. Starts at
    /// [`TransportConfig::packet_threshold`] and rises only to the distance a
    /// spurious loss proved (RFC 9002 §6.1).
    pub(super) packet_threshold: u64,
    /// Loss detection's time threshold, a multiple of the conservative RTT.
    /// Starts at [`TransportConfig::time_threshold`] and rises only to cover
    /// a round trip a spurious loss proved, up to [`MAX_TIME_THRESHOLD`].
    pub(super) time_threshold: f32,
    /// Number of the first packet sent on this path
    ///
    /// Used to determine whether a packet was sent on an earlier path. Insufficient to determine if
    /// a packet was sent on a later path.
    first_packet: Option<u64>,

    /// Snapshot of the qlog recovery metrics
    #[cfg(feature = "qlog")]
    recovery_metrics: RecoveryMetrics,

    /// Tag uniquely identifying a path in a connection
    generation: u64,
}

impl PathData {
    pub(super) fn new(
        remote: SocketAddr,
        allow_mtud: bool,
        peer_max_udp_payload_size: Option<u16>,
        generation: u64,
        now: Instant,
        config: &TransportConfig,
    ) -> Self {
        let congestion = config
            .congestion_controller_factory
            .clone()
            .build(now, config.get_initial_mtu());
        Self {
            remote,
            rtt: RttEstimator::new(config.initial_rtt),
            sending_ecn: true,
            pacing: Pacer::new(
                optimal_capacity(
                    config.initial_rtt,
                    congestion.initial_window(),
                    config.get_initial_mtu(),
                ),
                now,
            ),
            congestion,
            challenge: None,
            challenge_pending: false,
            validated: false,
            total_sent: 0,
            total_recvd: 0,
            mtud: config
                .mtu_discovery_config
                .as_ref()
                .filter(|_| allow_mtud)
                .map_or(
                    MtuDiscovery::disabled(config.get_initial_mtu(), config.min_mtu),
                    |mtud_config| {
                        MtuDiscovery::new(
                            config.get_initial_mtu(),
                            config.min_mtu,
                            peer_max_udp_payload_size,
                            mtud_config.clone(),
                        )
                    },
                ),
            first_packet_after_rtt_sample: None,
            in_flight: InFlight::new(),
            packet_threshold: u64::from(config.packet_threshold),
            time_threshold: config.time_threshold,
            first_packet: None,
            #[cfg(feature = "qlog")]
            recovery_metrics: RecoveryMetrics::default(),
            generation,
        }
    }

    pub(super) fn from_previous(
        remote: SocketAddr,
        prev: &Self,
        generation: u64,
        now: Instant,
    ) -> Self {
        let congestion = prev.congestion.clone_box();
        let smoothed_rtt = prev.rtt.get();
        Self {
            remote,
            rtt: prev.rtt,
            pacing: Pacer::new(
                optimal_capacity(smoothed_rtt, congestion.window(), prev.current_mtu()),
                now,
            ),
            sending_ecn: true,
            congestion,
            challenge: None,
            challenge_pending: false,
            validated: false,
            total_sent: 0,
            total_recvd: 0,
            mtud: prev.mtud.clone(),
            first_packet_after_rtt_sample: prev.first_packet_after_rtt_sample,
            in_flight: InFlight::new(),
            packet_threshold: prev.packet_threshold,
            time_threshold: prev.time_threshold,
            first_packet: None,
            #[cfg(feature = "qlog")]
            recovery_metrics: prev.recovery_metrics.clone(),
            generation,
        }
    }

    /// Resets RTT, congestion control and MTU states.
    ///
    /// This is useful when it is known the underlying path has changed.
    pub(super) fn reset(&mut self, now: Instant, config: &TransportConfig) {
        self.rtt = RttEstimator::new(config.initial_rtt);
        self.congestion = config
            .congestion_controller_factory
            .clone()
            .build(now, config.get_initial_mtu());
        self.mtud.reset(config.get_initial_mtu(), config.min_mtu);
        self.packet_threshold = u64::from(config.packet_threshold);
        self.time_threshold = config.time_threshold;
    }

    /// `packet`, declared lost when `largest_acked` was acknowledged, arrived
    /// after all: its acknowledgment came `round_trip` after it was sent.
    /// Raise each reordering threshold just enough that it would not have
    /// been declared.
    pub(super) fn on_spurious_loss(&mut self, packet: u64, largest_acked: u64, round_trip: Duration) {
        self.packet_threshold = self
            .packet_threshold
            .max(largest_acked.saturating_sub(packet) + 1);
        let rtt = self.rtt.conservative().max(TIMER_GRANULARITY);
        let needed = (round_trip.as_secs_f64() / rtt.as_secs_f64()) as f32;
        self.time_threshold = self.time_threshold.max(needed.min(MAX_TIME_THRESHOLD));
    }

    /// Indicates whether we're a server that hasn't validated the peer's address and hasn't
    /// received enough data from the peer to permit sending `bytes_to_send` additional bytes
    pub(super) fn anti_amplification_blocked(&self, bytes_to_send: u64) -> bool {
        !self.validated && self.total_recvd * 3 < self.total_sent + bytes_to_send
    }

    /// Returns the path's current MTU
    pub(super) fn current_mtu(&self) -> u16 {
        self.mtud.current_mtu()
    }

    /// Account for transmission of `packet` with number `pn` in `space`
    ///
    /// Returns a packet the space forgot to make room, so its egress sample
    /// and ledger credit can be released by the connection.
    pub(super) fn sent(
        &mut self,
        pn: u64,
        packet: SentPacket,
        space: &mut PacketSpace,
    ) -> Option<SentPacket> {
        self.in_flight.insert(&packet);
        if self.first_packet.is_none() {
            self.first_packet = Some(pn);
        }
        let forgotten = space.sent(pn, packet)?;
        self.remove_in_flight(&forgotten);
        Some(forgotten)
    }

    /// Remove `packet` with number `pn` from this path's congestion control counters, or return
    /// `false` if `pn` was sent before this path was established.
    pub(super) fn remove_in_flight(&mut self, packet: &SentPacket) -> bool {
        if packet.path_generation != self.generation {
            return false;
        }
        self.in_flight.remove(packet);
        true
    }

    #[cfg(feature = "qlog")]
    pub(super) fn qlog_recovery_metrics(&mut self, pto_count: u32) -> Option<MetricsUpdated> {
        let controller_metrics = self.congestion.metrics();

        let metrics = RecoveryMetrics {
            min_rtt: Some(self.rtt.min),
            smoothed_rtt: Some(self.rtt.get()),
            latest_rtt: Some(self.rtt.latest),
            rtt_variance: Some(self.rtt.var),
            pto_count: Some(pto_count),
            bytes_in_flight: Some(self.in_flight.bytes),
            packets_in_flight: Some(self.in_flight.ack_eliciting),

            congestion_window: Some(controller_metrics.congestion_window),
            ssthresh: controller_metrics.ssthresh,
            pacing_rate: controller_metrics.pacing_rate,
        };

        let event = metrics.to_qlog_event(&self.recovery_metrics);
        self.recovery_metrics = metrics;
        event
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }
}

/// Congestion metrics as described in [`recovery_metrics_updated`].
///
/// [`recovery_metrics_updated`]: https://datatracker.ietf.org/doc/html/draft-ietf-quic-qlog-quic-events.html#name-recovery_metrics_updated
#[cfg(feature = "qlog")]
#[derive(Default, Clone, PartialEq)]
#[non_exhaustive]
struct RecoveryMetrics {
    pub min_rtt: Option<Duration>,
    pub smoothed_rtt: Option<Duration>,
    pub latest_rtt: Option<Duration>,
    pub rtt_variance: Option<Duration>,
    pub pto_count: Option<u32>,
    pub bytes_in_flight: Option<u64>,
    pub packets_in_flight: Option<u64>,
    pub congestion_window: Option<u64>,
    pub ssthresh: Option<u64>,
    pub pacing_rate: Option<u64>,
}

#[cfg(feature = "qlog")]
impl RecoveryMetrics {
    /// Retain only values that have been updated since the last snapshot.
    fn retain_updated(&self, previous: &Self) -> Self {
        macro_rules! keep_if_changed {
            ($name:ident) => {
                if previous.$name == self.$name {
                    None
                } else {
                    self.$name
                }
            };
        }

        Self {
            min_rtt: keep_if_changed!(min_rtt),
            smoothed_rtt: keep_if_changed!(smoothed_rtt),
            latest_rtt: keep_if_changed!(latest_rtt),
            rtt_variance: keep_if_changed!(rtt_variance),
            pto_count: keep_if_changed!(pto_count),
            bytes_in_flight: keep_if_changed!(bytes_in_flight),
            packets_in_flight: keep_if_changed!(packets_in_flight),
            congestion_window: keep_if_changed!(congestion_window),
            ssthresh: keep_if_changed!(ssthresh),
            pacing_rate: keep_if_changed!(pacing_rate),
        }
    }

    /// Emit a `MetricsUpdated` event containing only updated values
    fn to_qlog_event(&self, previous: &Self) -> Option<MetricsUpdated> {
        let updated = self.retain_updated(previous);

        if updated == Self::default() {
            return None;
        }

        Some(MetricsUpdated {
            min_rtt: updated.min_rtt.map(|rtt| rtt.as_secs_f32()),
            smoothed_rtt: updated.smoothed_rtt.map(|rtt| rtt.as_secs_f32()),
            latest_rtt: updated.latest_rtt.map(|rtt| rtt.as_secs_f32()),
            rtt_variance: updated.rtt_variance.map(|rtt| rtt.as_secs_f32()),
            pto_count: updated
                .pto_count
                .map(|count| count.try_into().unwrap_or(u16::MAX)),
            bytes_in_flight: updated.bytes_in_flight,
            packets_in_flight: updated.packets_in_flight,
            congestion_window: updated.congestion_window,
            ssthresh: updated.ssthresh,
            pacing_rate: updated.pacing_rate,
        })
    }
}

/// RTT estimation for a particular network path
#[derive(Copy, Clone)]
pub struct RttEstimator {
    /// The most recent RTT measurement made when receiving an ack for a previously unacked packet
    latest: Duration,
    /// The smoothed RTT of the connection, computed as described in RFC6298
    smoothed: Option<Duration>,
    /// The RTT variance, computed as described in RFC6298
    var: Duration,
    /// The minimum RTT seen in the connection, ignoring ack delay.
    min: Duration,
}

impl RttEstimator {
    pub(crate) fn new(initial_rtt: Duration) -> Self {
        Self {
            latest: initial_rtt,
            smoothed: None,
            var: initial_rtt / 2,
            min: initial_rtt,
        }
    }

    /// The current best RTT estimation.
    pub fn get(&self) -> Duration {
        self.smoothed.unwrap_or(self.latest)
    }

    /// Conservative estimate of RTT
    ///
    /// Takes the maximum of smoothed and latest RTT, as recommended
    /// in 6.1.2 of the recovery spec (draft 29).
    pub fn conservative(&self) -> Duration {
        self.get().max(self.latest)
    }

    /// Minimum RTT registered so far for this estimator.
    pub fn min(&self) -> Duration {
        self.min
    }

    /// The most recent RTT sample
    pub(crate) fn latest(&self) -> Duration {
        self.latest
    }

    // PTO computed as described in RFC9002#6.2.1
    pub(crate) fn pto_base(&self) -> Duration {
        self.get() + cmp::max(4 * self.var, TIMER_GRANULARITY)
    }

    /// Return the same RFC 9002 adjusted sample used by the path estimator.
    pub(crate) fn update(&mut self, ack_delay: Duration, rtt: Duration) -> Duration {
        self.latest = rtt;
        // min_rtt ignores ack delay.
        self.min = cmp::min(self.min, self.latest);
        // Based on RFC6298.
        if let Some(smoothed) = self.smoothed {
            let adjusted_rtt = if self.min + ack_delay <= self.latest {
                self.latest - ack_delay
            } else {
                self.latest
            };
            let var_sample = smoothed.abs_diff(adjusted_rtt);
            self.var = (3 * self.var + var_sample) / 4;
            self.smoothed = Some((7 * smoothed + adjusted_rtt) / 8);
            adjusted_rtt
        } else {
            self.smoothed = Some(self.latest);
            self.var = self.latest / 2;
            self.min = self.latest;
            self.latest
        }
    }
}

#[derive(Default)]
pub(crate) struct PathResponses {
    pending: Vec<PathResponse>,
}

impl PathResponses {
    pub(crate) fn push(&mut self, packet: u64, token: u64, remote: SocketAddr) {
        /// Arbitrary permissive limit to prevent abuse
        const MAX_PATH_RESPONSES: usize = 16;
        let response = PathResponse {
            packet,
            token,
            remote,
        };
        let existing = self.pending.iter_mut().find(|x| x.remote == remote);
        if let Some(existing) = existing {
            // Update a queued response
            if existing.packet <= packet {
                *existing = response;
            }
            return;
        }
        if self.pending.len() < MAX_PATH_RESPONSES {
            self.pending.push(response);
        } else {
            // We don't expect to ever hit this with well-behaved peers, so we don't bother dropping
            // older challenges.
            trace!("ignoring excessive PATH_CHALLENGE");
        }
    }

    pub(crate) fn pop_off_path(&mut self, remote: SocketAddr) -> Option<(u64, SocketAddr)> {
        let response = *self.pending.last()?;
        if response.remote == remote {
            // We don't bother searching further because we expect that the on-path response will
            // get drained in the immediate future by a call to `pop_on_path`
            return None;
        }
        self.pending.pop();
        Some((response.token, response.remote))
    }

    pub(crate) fn pop_on_path(&mut self, remote: SocketAddr) -> Option<u64> {
        let response = *self.pending.last()?;
        if response.remote != remote {
            // We don't bother searching further because we expect that the off-path response will
            // get drained in the immediate future by a call to `pop_off_path`
            return None;
        }
        self.pending.pop();
        Some(response.token)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[derive(Copy, Clone)]
struct PathResponse {
    /// The packet number the corresponding PATH_CHALLENGE was received in
    packet: u64,
    token: u64,
    /// The address the corresponding PATH_CHALLENGE was received from
    remote: SocketAddr,
}

/// Summary statistics of packets that have been sent on a particular path, but which have not yet
/// been acked or deemed lost
pub(super) struct InFlight {
    /// Sum of the sizes of all sent packets considered "in flight" by congestion control
    ///
    /// The size does not include IP or UDP overhead. Packets only containing ACK frames do not
    /// count towards this to ensure congestion control does not impede congestion feedback.
    pub(super) bytes: u64,
    /// Number of packets in flight containing frames other than ACK and PADDING
    ///
    /// This can be 0 even when bytes is not 0 because PADDING frames cause a packet to be
    /// considered "in flight" by congestion control. However, if this is nonzero, bytes will always
    /// also be nonzero.
    pub(super) ack_eliciting: u64,
    /// The part of `bytes` an egress group admitted image-only. The group, not
    /// this connection's own window and pacer, answers for those packets.
    pub(super) images: u64,
}

impl InFlight {
    fn new() -> Self {
        Self {
            bytes: 0,
            ack_eliciting: 0,
            images: 0,
        }
    }

    fn insert(&mut self, packet: &SentPacket) {
        self.bytes += u64::from(packet.size);
        self.ack_eliciting += u64::from(packet.ack_eliciting);
        if packet.egress_images_only {
            self.images += u64::from(packet.size);
        }
    }

    /// Update counters to account for a packet becoming acknowledged, lost, or abandoned
    fn remove(&mut self, packet: &SentPacket) {
        self.bytes -= u64::from(packet.size);
        self.ack_eliciting -= u64::from(packet.ack_eliciting);
        if packet.egress_images_only {
            self.images -= u64::from(packet.size);
        }
    }
}

#[cfg(test)]
mod rtt_tests {
    use super::*;

    #[test]
    fn adjusted_samples_never_subtract_below_the_observed_path_minimum() {
        let ms = Duration::from_millis;
        let mut estimator = RttEstimator::new(ms(333));
        // The first observation establishes the minimum, without ACK adjustment.
        assert_eq!(estimator.update(ms(25), ms(60)), ms(60));
        assert_eq!(estimator.min(), ms(60));
        // A legal delayed ACK can explain the excess above that minimum.
        assert_eq!(estimator.update(ms(10), ms(75)), ms(65));
        // A peer's claimed delay cannot invent a path faster than we observed.
        assert_eq!(estimator.update(ms(25), ms(65)), ms(65));
        // A genuinely faster raw sample establishes a new minimum unchanged.
        assert_eq!(estimator.update(ms(25), ms(50)), ms(50));
        assert_eq!(estimator.min(), ms(50));
        assert_eq!(estimator.update(ms(10), ms(60)), ms(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spurious_loss_raises_each_threshold_just_enough_and_no_further() {
        let config = TransportConfig::default();
        let now = Instant::now();
        let remote = "[::1]:4433".parse().unwrap();
        let mut path = PathData::new(remote, false, None, 0, now, &config);
        path.rtt.update(Duration::ZERO, Duration::from_millis(100));
        // Declared lost with four acknowledged ahead of it; acknowledged 150 ms after send.
        path.on_spurious_loss(10, 14, Duration::from_millis(150));
        assert_eq!(path.packet_threshold, 5);
        assert!((path.time_threshold - 1.5).abs() < 1e-6);
        // A closer, faster one lowers neither.
        path.on_spurious_loss(20, 21, Duration::from_millis(110));
        assert_eq!(path.packet_threshold, 5);
        assert!((path.time_threshold - 1.5).abs() < 1e-6);
        // A round trip beyond one more is admitted only up to that bound.
        path.on_spurious_loss(30, 31, Duration::from_millis(900));
        assert_eq!(path.time_threshold, MAX_TIME_THRESHOLD);
        path.reset(now, &config);
        assert_eq!(path.packet_threshold, 3);
        assert!((path.time_threshold - 9.0 / 8.0).abs() < 1e-6);
    }
}
