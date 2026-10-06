//! Pacing of packet transmissions.

use crate::{Duration, Instant};

use tracing::warn;

/// A token-bucket pacer at an explicit rate.
///
/// A connection paces at 5/4 of its congestion window per smoothed RTT
/// (`connection_rate`), in bursts of `optimal_capacity`, as recommended in
/// <https://tools.ietf.org/html/draft-ietf-quic-recovery-34#section-7.7>. An
/// egress group paces bulk at its model's rate, in bursts of its quantum.
/// Once the bucket is empty, further transmission is blocked.
#[derive(Clone)]
pub(super) struct Pacer {
    capacity: u64,
    tokens: u64,
    /// Bytes admitted past an empty bucket by a sender that does not wait on
    /// it. Refills repay it before any token can be spent, so an unpaced
    /// sender borrows from the paced ones and never adds to the average rate.
    debt: u64,
    prev: Instant,
}

impl Pacer {
    /// Obtains a new [`Pacer`] with a full bucket of `capacity` bytes.
    pub(super) fn new(capacity: u64, now: Instant) -> Self {
        Self {
            capacity,
            tokens: capacity,
            debt: 0,
            prev: now,
        }
    }

    /// Record that a packet has been transmitted.
    pub(super) fn on_transmit(&mut self, packet_length: u16) {
        self.debit(packet_length.into())
    }

    /// Charge a bounded batch of construction reservations after a path reset.
    pub(super) fn debit(&mut self, bytes: u64) {
        self.tokens = self.tokens.saturating_sub(bytes);
    }

    /// Spend `bytes` without waiting: whatever the bucket cannot cover becomes
    /// debt that refills repay before any paced sender may spend again.
    pub(super) fn charge(&mut self, bytes: u64) {
        let covered = self.tokens.min(bytes);
        self.tokens -= covered;
        self.debt = self.debt.saturating_add(bytes - covered);
    }

    /// Return unused packet-construction tokens, repaying debt first. Never
    /// grows the burst capacity.
    pub(super) fn refund(&mut self, bytes: u64) {
        let repaid = self.debt.min(bytes);
        self.debt -= repaid;
        self.tokens = self
            .tokens
            .saturating_add(bytes - repaid)
            .min(self.capacity);
    }

    /// Return how long we need to wait before sending `bytes_to_send` at `rate`
    /// bytes per second, in bursts of up to `capacity` bytes.
    ///
    /// If we can send a packet right away, this returns `None`. Otherwise, returns
    /// `Some(t)`: the bucket is full again at `t`, when this should be called again.
    pub(super) fn delay(
        &mut self,
        rate: u64,
        capacity: u64,
        bytes_to_send: u64,
        now: Instant,
    ) -> Option<Instant> {
        self.delay_refill(
            rate,
            capacity,
            bytes_to_send,
            capacity.max(bytes_to_send),
            now,
        )
    }

    /// A model's short quantum cannot wait for a whole refill: rounding that
    /// deadline to a runtime tick discards nearly a quantum on every wake.
    /// Wake as soon as the next packet has earned credit; the same capacity
    /// still bounds the burst, and interactive debt is still repaid first.
    pub(super) fn delay_packet(
        &mut self,
        rate: u64,
        capacity: u64,
        bytes_to_send: u64,
        now: Instant,
    ) -> Option<Instant> {
        self.delay_refill(rate, capacity, bytes_to_send, bytes_to_send, now)
    }

    fn delay_refill(
        &mut self,
        rate: u64,
        capacity: u64,
        bytes_to_send: u64,
        refill_target: u64,
        now: Instant,
    ) -> Option<Instant> {
        debug_assert_ne!(rate, 0, "a zero pacing rate is nonsense");
        if capacity != self.capacity {
            self.capacity = capacity;
            self.tokens = self.tokens.min(capacity);
        }

        // if we can already send a packet, there is no need for delay
        if self.tokens >= bytes_to_send {
            return None;
        }

        let time_elapsed = now.checked_duration_since(self.prev).unwrap_or_else(|| {
            warn!("received a timestamp early than a previous recorded time, ignoring");
            Default::default()
        });

        let new_tokens = u64::try_from(u128::from(rate) * time_elapsed.as_nanos() / 1_000_000_000)
            .unwrap_or(u64::MAX);
        let repaid = self.debt.min(new_tokens);
        self.debt -= repaid;
        self.tokens = self
            .tokens
            .saturating_add(new_tokens - repaid)
            .min(self.capacity);

        self.prev = now;

        // if we can already send a packet, there is no need for delay
        if self.tokens >= bytes_to_send {
            return None;
        }

        // Outstanding debt is repaid before the bucket refills.
        let missing = (refill_target - self.tokens).saturating_add(self.debt);
        let nanos = (u128::from(missing) * 1_000_000_000).div_ceil(u128::from(rate.max(1)));
        Some(self.prev + Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX)))
    }
}

/// A connection's pacing rate in bytes per second: 5/4 of its window per
/// smoothed RTT. `None` disables pacing: no RTT yet, or a window too large to
/// pace.
pub(super) fn connection_rate(window: u64, smoothed_rtt: Duration) -> Option<u64> {
    if window > u64::from(u32::MAX) || smoothed_rtt.is_zero() {
        return None;
    }
    let rate = u128::from(window) * 5 * 1_000_000_000 / (4 * smoothed_rtt.as_nanos());
    Some(u64::try_from(rate).unwrap_or(u64::MAX).max(1))
}

/// An unvalidated Careful Resume jump's pacing (RFC 9959 §4.3.2): rate and
/// burst capacity in bytes. The jump per current RTT, one packet every
/// `rtt × MTU / jump`, in bursts no larger than the initial window.
pub(super) fn jump_pacing(
    jump: u64,
    current_rtt: Duration,
    initial_window: u64,
    mtu: u16,
) -> (u64, u64) {
    let rate = u128::from(jump) * 1_000_000_000 / current_rtt.as_nanos().max(1);
    let capacity = optimal_capacity(current_rtt, jump, mtu).min(initial_window.max(u64::from(mtu)));
    (u64::try_from(rate).unwrap_or(u64::MAX).max(1), capacity)
}

/// Calculates a pacer capacity for a certain window and RTT
///
/// The goal is to emit a burst (of size `capacity`) in timer intervals
/// which compromise between
/// - ideally distributing datagrams over time
/// - constantly waking up the connection to produce additional datagrams
///
/// Too short burst intervals means we will never meet them since the timer
/// accuracy in user-space is not high enough. If we miss the interval by more
/// than 25%, we will lose that part of the congestion window since no additional
/// tokens for the extra-elapsed time can be stored.
///
/// Too long burst intervals make pacing less effective.
pub(super) fn optimal_capacity(smoothed_rtt: Duration, window: u64, mtu: u16) -> u64 {
    let rtt = smoothed_rtt.as_nanos().max(1);

    let capacity = ((window as u128 * BURST_INTERVAL_NANOS) / rtt) as u64;

    // Small bursts are less efficient (no GSO), could increase latency and don't effectively
    // use the channel's buffer capacity. Large bursts might block the connection on sending.
    capacity.clamp(MIN_BURST_SIZE * mtu as u64, MAX_BURST_SIZE * mtu as u64)
}

/// The burst interval
///
/// The capacity will we refilled in 4/5 of that time.
/// 2ms is chosen here since framework timers might have 1ms precision.
/// If kernel-level pacing is supported later a higher time here might be
/// more applicable.
const BURST_INTERVAL_NANOS: u128 = 2_000_000; // 2ms

/// Allows some usage of GSO, and doesn't slow down the handshake.
const MIN_BURST_SIZE: u64 = 10;

/// Creating 256 packets took 1ms in a benchmark, so larger bursts don't make sense.
const MAX_BURST_SIZE: u64 = 256;

#[cfg(test)]
mod tests {
    use super::*;

    /// A connection's pacing at `window` over `rtt`, as `poll_transmit` asks.
    fn connection_delay(
        pacer: &mut Pacer,
        rtt: Duration,
        bytes: u64,
        mtu: u16,
        window: u64,
        now: Instant,
    ) -> Option<Instant> {
        let rate = connection_rate(window, rtt)?;
        pacer.delay(rate, optimal_capacity(rtt, window, mtu), bytes, now)
    }

    #[test]
    fn a_fractional_token_deadline_always_makes_progress() {
        let now = Instant::now();
        let mut pacer = Pacer::new(2400, now);
        pacer.charge(1200);
        let at = pacer.delay(274_230, 2400, 2400, now).unwrap();
        assert!(pacer.delay(274_230, 2400, 2400, at).is_none());
    }

    #[test]
    fn does_not_panic_on_bad_instant() {
        let old_instant = Instant::now();
        let new_instant = old_instant + Duration::from_micros(15);
        let rtt = Duration::from_micros(400);

        let capacity = optimal_capacity(rtt, 30000, 1500);
        assert!(
            Pacer::new(capacity, new_instant)
                .delay(1, capacity, 0, old_instant)
                .is_none()
        );
        assert!(
            Pacer::new(capacity, new_instant)
                .delay(1_000_000, capacity, 1600, old_instant)
                .is_none()
        );
        assert!(
            Pacer::new(capacity, new_instant)
                .delay(1_000_000, capacity, 1500, old_instant)
                .is_none()
        );
    }

    #[test]
    fn a_connection_without_an_rtt_or_with_a_huge_window_is_not_paced() {
        assert_eq!(connection_rate(30_000, Duration::ZERO), None);
        assert_eq!(
            connection_rate(u64::from(u32::MAX) + 1, Duration::from_millis(50)),
            None
        );
        // 5/4 of 100 KB per 100 ms.
        assert_eq!(
            connection_rate(100_000, Duration::from_millis(100)),
            Some(1_250_000)
        );
    }

    #[test]
    fn derives_initial_capacity() {
        let window = 2_000_000;
        let mtu = 1500;
        let rtt = Duration::from_millis(50);

        assert_eq!(
            optimal_capacity(rtt, window, mtu),
            (window as u128 * BURST_INTERVAL_NANOS / rtt.as_nanos()) as u64
        );
        assert_eq!(
            optimal_capacity(Duration::from_millis(0), window, mtu),
            MAX_BURST_SIZE * mtu as u64
        );
        assert_eq!(optimal_capacity(rtt, 1, mtu), MIN_BURST_SIZE * mtu as u64);
    }

    #[test]
    fn adjusts_capacity() {
        let window = 2_000_000;
        let mtu = 1500;
        let rtt = Duration::from_millis(50);
        let now = Instant::now();

        let mut pacer = Pacer::new(optimal_capacity(rtt, window, mtu), now);
        assert_eq!(
            pacer.capacity,
            (window as u128 * BURST_INTERVAL_NANOS / rtt.as_nanos()) as u64
        );
        assert_eq!(pacer.tokens, pacer.capacity);
        let initial_tokens = pacer.tokens;

        connection_delay(&mut pacer, rtt, mtu as u64, mtu, window * 2, now);
        assert_eq!(
            pacer.capacity,
            (2 * window as u128 * BURST_INTERVAL_NANOS / rtt.as_nanos()) as u64
        );
        assert_eq!(pacer.tokens, initial_tokens);

        connection_delay(&mut pacer, rtt, mtu as u64, mtu, window / 2, now);
        assert_eq!(
            pacer.capacity,
            (window as u128 / 2 * BURST_INTERVAL_NANOS / rtt.as_nanos()) as u64
        );
        assert_eq!(pacer.tokens, initial_tokens / 2);

        connection_delay(&mut pacer, rtt, mtu as u64, mtu * 2, window, now);
        assert_eq!(
            pacer.capacity,
            (window as u128 * BURST_INTERVAL_NANOS / rtt.as_nanos()) as u64
        );

        connection_delay(&mut pacer, rtt, mtu as u64, 20_000, window, now);
        assert_eq!(pacer.capacity, 20_000_u64 * MIN_BURST_SIZE);
    }

    #[test]
    fn computes_pause_correctly() {
        let window = 2_000_000u64;
        let mtu = 1000;
        let rtt = Duration::from_millis(50);
        let old_instant = Instant::now();

        let mut pacer = Pacer::new(optimal_capacity(rtt, window, mtu), old_instant);
        let packet_capacity = pacer.capacity / mtu as u64;

        for _ in 0..packet_capacity {
            assert_eq!(
                connection_delay(&mut pacer, rtt, mtu as u64, mtu, window, old_instant),
                None,
                "When capacity is available packets should be sent immediately"
            );

            pacer.on_transmit(mtu);
        }

        let pace_duration = Duration::from_nanos((BURST_INTERVAL_NANOS * 4 / 5) as u64);

        assert_eq!(
            connection_delay(&mut pacer, rtt, mtu as u64, mtu, window, old_instant)
                .expect("Send must be delayed")
                .duration_since(old_instant),
            pace_duration
        );

        // Refill half of the tokens
        assert_eq!(
            connection_delay(
                &mut pacer,
                rtt,
                mtu as u64,
                mtu,
                window,
                old_instant + pace_duration / 2
            ),
            None
        );
        assert_eq!(pacer.tokens, pacer.capacity / 2);

        for _ in 0..packet_capacity / 2 {
            assert_eq!(
                connection_delay(&mut pacer, rtt, mtu as u64, mtu, window, old_instant),
                None,
                "When capacity is available packets should be sent immediately"
            );

            pacer.on_transmit(mtu);
        }

        // Refill all capacity by waiting more than the expected duration
        assert_eq!(
            connection_delay(
                &mut pacer,
                rtt,
                mtu as u64,
                mtu,
                window,
                old_instant + pace_duration * 3 / 2
            ),
            None
        );
        assert_eq!(pacer.tokens, pacer.capacity);
    }

    /// A group paces at its model's rate in quanta: one quantum leaves at
    /// once, the next a quantum's time later.
    #[test]
    fn a_rate_paces_in_quanta_and_repays_debt_first() {
        let now = Instant::now();
        // 1.25 MB/s in 1,250-byte quanta: one per millisecond.
        let mut pacer = Pacer::new(1_250, now);
        assert_eq!(pacer.delay(1_250_000, 1_250, 1_250, now), None);
        pacer.on_transmit(1_250);
        assert_eq!(
            pacer.delay(1_250_000, 1_250, 1_250, now),
            Some(now + Duration::from_millis(1))
        );
        // An unpaced sender's 2,500 bytes are debt: two more milliseconds.
        pacer.charge(2_500);
        assert_eq!(
            pacer.delay(1_250_000, 1_250, 1_250, now + Duration::from_millis(1)),
            Some(now + Duration::from_millis(3))
        );
    }
    #[test]
    fn a_model_quantum_keeps_its_rate_with_millisecond_timer_wakes() {
        let start = Instant::now();
        let rate = 3_125_000;
        let capacity = 3_125;
        let mut pacer = Pacer::new(capacity, start);
        let mut now = start;
        let mut sent = 0u64;
        while now < start + Duration::from_secs(1) {
            let mut burst = 0;
            loop {
                match pacer.delay_packet(rate, capacity, 1452, now) {
                    None => {
                        pacer.on_transmit(1452);
                        sent += 1452;
                        burst += 1452;
                    }
                    Some(deadline) => {
                        assert!(burst <= capacity);
                        // A millisecond timer rounds up; dispatch runs 100 us
                        // after that tick. No real sleeps or scheduler noise.
                        let micros = (deadline - start).as_micros().div_ceil(1_000) * 1_000 + 100;
                        now = start + Duration::from_micros(micros as u64);
                        break;
                    }
                }
            }
        }
        assert!(sent >= rate * 90 / 100, "only {sent} of {rate} bytes paced");
        assert!(sent <= rate + capacity, "pacing minted capacity: {sent}");
    }
}
