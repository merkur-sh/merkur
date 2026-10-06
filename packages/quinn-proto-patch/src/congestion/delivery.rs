//! Delivery rate samples for an egress group, after
//! draft-cheng-iccrg-delivery-rate-estimation.
//!
//! One `DeliveryState` spans every member of a group, because every member
//! crosses the same pair of hosts: a round, a delivery rate and a loss count
//! are the group's, whichever connection carried the bytes. Every input is a
//! byte counter or a timestamp, and "application limited" is the group
//! ledger's own state, so a sample is exact rather than inferred.

use crate::{Duration, Instant};

/// A packet's snapshot of the group's delivery state at its send. Full counters
/// and timestamps preserve samples even when another member delivers more than
/// 4 GiB before this packet is acknowledged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PacketRate {
    /// Exact model identity, replaced on a route reset or group replacement.
    pub(crate) epoch: u64,
    /// Group bytes delivered when the packet was sent.
    delivered: u64,
    /// Group bytes lost when the packet was sent.
    lost: u64,
    /// Group bytes in flight before this packet: zero means nothing of the
    /// group's was ahead of it.
    tx_in_flight: u64,
    /// When `delivered` last advanced.
    delivered_time: Instant,
    /// When this packet's flight began.
    first_send_time: Instant,
    /// Sent while the group had nothing more it was allowed to send.
    app_limited: bool,
}

impl PacketRate {
    pub(crate) fn tx_in_flight(&self) -> u64 {
        self.tx_in_flight
    }

    #[cfg(test)]
    pub(crate) fn app_limited(&self) -> bool {
        self.app_limited
    }

    /// Group bytes lost since this packet's send, given the group's total now.
    pub(crate) fn lost_since(&self, lost_total: u64) -> u64 {
        lost_total - self.lost
    }

    #[cfg(test)]
    pub(crate) fn for_test(tx_in_flight: u64, lost: u64, app_limited: bool) -> Self {
        Self {
            epoch: 0,
            delivered: 0,
            lost,
            tx_in_flight,
            delivered_time: Instant::now(),
            first_send_time: Instant::now(),
            app_limited,
        }
    }
}

/// One ACK frame's rate sample: the most recently sent packet it acknowledged
/// against the delivery state that packet saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RateSample {
    /// Bytes per second, over `interval`.
    pub(crate) delivery_rate: u64,
    /// Bytes delivered over `interval`.
    pub(crate) delivered: u64,
    pub(crate) interval: Duration,
    /// Group bytes delivered when the sampled packet was sent.
    pub(crate) prior_delivered: u64,
    pub(crate) app_limited: bool,
    /// Group flight before the sampled packet.
    pub(crate) tx_in_flight: u64,
    /// Bytes this ACK frame newly acknowledged.
    pub(crate) newly_acked: u64,
}

#[derive(Clone, Copy, Debug)]
struct Pending {
    prior_delivered: u64,
    send_elapsed: Duration,
    prior_delivered_time: Instant,
    sent: Instant,
    app_limited: bool,
    tx_in_flight: u64,
}

/// The group's delivery counters.
#[derive(Clone, Debug)]
pub(crate) struct DeliveryState {
    delivered: u64,
    delivered_time: Instant,
    first_send_time: Instant,
    lost: u64,
    /// Nonzero while the group is application limited: the delivered count
    /// at which every packet sent before the limit has been delivered.
    app_limited_until: u64,
    /// Each member can process an ACK frame concurrently. Counters span the
    /// group; partial frames must remain owned by their originating member.
    pending: [Option<Pending>; 2],
    newly_acked: [u64; 2],
}

impl DeliveryState {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            delivered: 0,
            delivered_time: now,
            first_send_time: now,
            lost: 0,
            app_limited_until: 0,
            pending: [None; 2],
            newly_acked: [0; 2],
        }
    }

    pub(crate) fn delivered(&self) -> u64 {
        self.delivered
    }

    pub(crate) fn lost(&self) -> u64 {
        self.lost
    }

    pub(crate) fn is_app_limited(&self) -> bool {
        self.app_limited_until != 0
    }

    /// Snapshot for a packet sent at `now` behind `flight_before` group bytes.
    pub(crate) fn on_send(&mut self, now: Instant, flight_before: u64) -> PacketRate {
        if flight_before == 0 {
            // A flight starts from idle: its intervals count from here.
            self.first_send_time = now;
            self.delivered_time = now;
        }
        PacketRate {
            epoch: 0,
            delivered: self.delivered,
            lost: self.lost,
            tx_in_flight: flight_before,
            delivered_time: self.delivered_time,
            first_send_time: self.first_send_time,
            app_limited: self.is_app_limited(),
        }
    }

    /// The group has nothing it may send with `flight` bytes outstanding:
    /// samples of packets sent until those bytes are delivered cannot show
    /// the path's capacity.
    pub(crate) fn mark_app_limited(&mut self, flight: u64) {
        self.app_limited_until = self.delivered.saturating_add(flight).max(1);
    }

    /// A packet of `bytes` sent at `sent` with `rate` was acknowledged at `now`.
    pub(crate) fn on_ack(
        &mut self,
        member: usize,
        now: Instant,
        sent: Instant,
        rate: &PacketRate,
        bytes: u64,
    ) {
        let prior_delivered = rate.delivered;
        self.delivered += bytes;
        self.delivered_time = self.delivered_time.max(now);
        self.newly_acked[member] += bytes;
        // The most recently sent packet the frame acknowledges gives the
        // sample: it has the most recent view of the flight.
        if self.pending[member].is_none_or(|pending| {
            (prior_delivered, sent) >= (pending.prior_delivered, pending.sent)
        }) {
            self.pending[member] = Some(Pending {
                prior_delivered,
                send_elapsed: sent.saturating_duration_since(rate.first_send_time),
                prior_delivered_time: rate.delivered_time,
                sent,
                app_limited: rate.app_limited,
                tx_in_flight: rate.tx_in_flight(),
            });
            self.first_send_time = self.first_send_time.max(sent);
        }
    }

    pub(crate) fn on_loss(&mut self, bytes: u64) {
        self.lost += bytes;
    }

    /// Ends one ACK frame. `None` when it acknowledged nothing, or when the
    /// sample's interval is shorter than `min_rtt`: an interval that short can
    /// only be compressed ACKs, never the path's rate.
    pub(crate) fn take_sample(&mut self, member: usize, min_rtt: Duration) -> Option<RateSample> {
        if self.app_limited_until != 0 && self.delivered > self.app_limited_until {
            self.app_limited_until = 0;
        }
        let newly_acked = std::mem::take(&mut self.newly_acked[member]);
        let pending = self.pending[member].take()?;
        let interval = pending.send_elapsed.max(
            self.delivered_time
                .saturating_duration_since(pending.prior_delivered_time),
        );
        let delivered = self.delivered - pending.prior_delivered;
        if interval < min_rtt || interval.is_zero() {
            return None;
        }
        let delivery_rate =
            u64::try_from(u128::from(delivered) * 1_000_000_000 / interval.as_nanos().max(1))
                .unwrap_or(u64::MAX);
        Some(RateSample {
            delivery_rate,
            delivered,
            interval,
            prior_delivered: pending.prior_delivered,
            app_limited: pending.app_limited,
            tx_in_flight: pending.tx_in_flight,
            newly_acked,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    /// Ten packets sent back to back, one per millisecond, each acknowledged one
    /// RTT (100 ms) after its send: the sample covers the whole flight.
    #[test]
    fn a_paced_flight_samples_its_own_rate() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        let sent: Vec<(Instant, PacketRate)> = (0..10u64)
            .map(|index| {
                let at = t0 + MS * index as u32;
                (at, state.on_send(at, index * 1_000))
            })
            .collect();
        let mut last = None;
        for (index, (at, rate)) in sent.iter().enumerate() {
            state.on_ack(0, t0 + MS * (100 + index as u32), *at, rate, 1_000);
            last = state.take_sample(0, Duration::from_millis(50));
        }
        // The last sample spans the flight: 10 packets over the 109 ms from
        // its start to the last acknowledgment.
        let sample = last.expect("a full-RTT interval is a valid sample");
        assert_eq!(sample.delivered, 10_000);
        assert_eq!(sample.interval, MS * 109);
        assert_eq!(sample.delivery_rate, 10_000 * 1_000 / 109);
        assert_eq!(sample.prior_delivered, 0);
        assert!(!sample.app_limited);
    }

    /// The interval is the larger of the send and ACK intervals, so a burst of
    /// compressed ACKs cannot inflate the rate above what was sent.
    #[test]
    fn compressed_acks_are_bounded_by_the_send_interval() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        // One delivered packet gives later packets a baseline.
        let first = state.on_send(t0, 0);
        state.on_ack(0, t0 + MS * 100, t0, &first, 1_000);
        let _ = state.take_sample(0, Duration::ZERO);
        // Four packets sent 10 ms apart, all acknowledged in one burst.
        let sent: Vec<(Instant, PacketRate)> = (0..4u64)
            .map(|index| {
                let at = t0 + MS * (100 + 10 * index as u32);
                (at, state.on_send(at, index * 1_000))
            })
            .collect();
        for (at, rate) in &sent {
            state.on_ack(0, t0 + MS * 230, *at, rate, 1_000);
        }
        let sample = state.take_sample(0, Duration::ZERO).expect("sample");
        // Send elapsed 30 ms (first to last of the flight), ACK elapsed 130 ms
        // from the baseline's delivery: the ACK interval governs here.
        assert_eq!(sample.interval, MS * 130);
        assert_eq!(sample.delivered, 4_000);
        assert_eq!(sample.newly_acked, 4_000);
    }

    #[test]
    fn an_interval_shorter_than_min_rtt_is_no_sample() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        let rate = state.on_send(t0, 0);
        state.on_ack(0, t0 + MS * 5, t0, &rate, 1_000);
        assert_eq!(state.take_sample(0, MS * 10), None);
        // The bytes still count as delivered.
        assert_eq!(state.delivered(), 1_000);
    }

    /// Packets sent while application limited mark their samples, and the mark
    /// clears once everything sent before it has been delivered.
    #[test]
    fn app_limited_marks_samples_until_its_flight_is_delivered() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        let before = state.on_send(t0, 0);
        state.mark_app_limited(1_000);
        let during = state.on_send(t0 + MS, 1_000);
        assert!(!before.app_limited());
        assert!(during.app_limited());
        state.on_ack(0, t0 + MS * 100, t0, &before, 1_000);
        let _ = state.take_sample(0, Duration::ZERO);
        assert!(
            state.is_app_limited(),
            "delivered 1000 is not past the mark"
        );
        state.on_ack(0, t0 + MS * 101, t0 + MS, &during, 1_000);
        let sample = state.take_sample(0, Duration::ZERO).expect("sample");
        assert!(sample.app_limited);
        assert!(!state.is_app_limited());
    }

    #[test]
    fn a_packet_sent_from_idle_restarts_the_flight() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        let first = state.on_send(t0, 0);
        state.on_ack(0, t0 + MS * 100, t0, &first, 1_000);
        let _ = state.take_sample(0, Duration::ZERO);
        // Idle for a second, then a new flight.
        let resumed = state.on_send(t0 + MS * 1_100, 0);
        assert_eq!(resumed.first_send_time, t0 + MS * 1_100);
        assert_eq!(resumed.delivered_time, t0 + MS * 1_100);
        assert_eq!(resumed.tx_in_flight(), 0);
        state.on_loss(500);
        let later = state.on_send(t0 + MS * 1_101, 1_000);
        assert_eq!(later.lost_since(state.lost() + 700), 700);
        assert_eq!(later.first_send_time, t0 + MS * 1_100);
    }

    /// Full snapshots stay exact across counters' low-word wrap.
    #[test]
    fn snapshots_difference_exactly_across_a_32_bit_wrap() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        state.delivered = u64::from(u32::MAX) - 500;
        let rate = state.on_send(t0, 0);
        state.delivered += 2_000;
        state.on_ack(0, t0 + MS * 100, t0, &rate, 1_000);
        let sample = state.take_sample(0, Duration::ZERO).expect("sample");
        assert_eq!(sample.prior_delivered, u64::from(u32::MAX) - 500);
        assert_eq!(sample.delivered, 3_000);
    }
    #[test]
    fn snapshots_preserve_more_than_four_gib_between_send_and_ack() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        state.delivered = 17;
        state.lost = 23;
        let rate = state.on_send(t0, 1u64 << 33);
        state.delivered += 1u64 << 33;
        state.on_loss((1u64 << 33) + 71);
        state.on_ack(0, t0 + MS * 100, t0, &rate, 1_000);
        let sample = state.take_sample(0, Duration::ZERO).expect("sample");
        assert_eq!(sample.prior_delivered, 17);
        assert_eq!(sample.delivered, (1u64 << 33) + 1_000);
        assert_eq!(sample.tx_in_flight, 1u64 << 33);
        assert_eq!(rate.lost_since(state.lost()), (1u64 << 33) + 71);
    }

    #[test]
    fn interleaved_member_acks_keep_their_own_frames_and_a_group_interval() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        let high = state.on_send(t0, 0);
        let low = state.on_send(t0 + MS, 1_000);
        state.on_ack(0, t0 + MS * 100, t0, &high, 1_000);
        state.on_ack(1, t0 + MS * 110, t0 + MS, &low, 2_000);
        let low_sample = state.take_sample(1, Duration::ZERO).expect("bulk sample");
        let high_sample = state
            .take_sample(0, Duration::ZERO)
            .expect("interactive sample");
        assert_eq!(low_sample.newly_acked, 2_000);
        assert_eq!(high_sample.newly_acked, 1_000);
        for sample in [low_sample, high_sample] {
            assert_eq!(sample.delivered, 3_000);
            assert_eq!(sample.interval, MS * 110);
            assert_eq!(sample.delivery_rate, 3_000 * 1_000 / 110);
        }
        assert_eq!(state.take_sample(0, Duration::ZERO), None);
        assert_eq!(state.take_sample(1, Duration::ZERO), None);
    }

    #[test]
    fn long_flights_do_not_truncate_the_send_interval() {
        let t0 = Instant::now();
        let mut state = DeliveryState::new(t0);
        let first = state.on_send(t0, 0);
        let elapsed = Duration::from_secs(5_000);
        let last = state.on_send(t0 + elapsed, 1_000);
        state.on_ack(0, t0 + elapsed + MS, t0, &first, 1_000);
        state.on_ack(0, t0 + elapsed + MS, t0 + elapsed, &last, 1_000);
        let sample = state.take_sample(0, Duration::ZERO).expect("sample");
        assert_eq!(sample.interval, elapsed + MS);
    }
}
