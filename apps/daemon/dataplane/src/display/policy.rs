const BYTES_PER_KIB: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayWorkload {
    Interactive,
    Stream,
    Bulk,
}

/// The display ACK's width is a wire fact, shared with every client through
/// `merkur-wire`. The window is wide enough that a whole redraw's datagrams
/// are still inside it when a client acknowledges them at render cadence, so
/// no sequence ever has to be treated as "unknown" on a healthy path.
pub use merkur_wire::protocol::{DISPLAY_ACK_MASK_WINDOW, DISPLAY_ACK_MASK_WORDS};

/// Sequences that must be acknowledged ABOVE an unacknowledged one before it is
/// declared lost rather than merely outstanding.
///
/// This is QUIC's packet threshold (RFC 9002 §6.1.1) and it is the reason the
/// re-send deadline is now a backstop rather than the primary signal: three
/// later datagrams arriving is *evidence*, available in well under the time any
/// deadline could safely use, and it does not need an estimator to interpret.
/// The deadline still exists for the tail of a burst, where no later datagram
/// is coming and only a clock can resolve the question.
pub const LOSS_PACKET_THRESHOLD: u32 = 3;

/// Display datagrams a browser's WebTransport receive queue holds by default.
///
/// Mirrored from `DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH` in `packages/shared`,
/// which carries the derivation and the production evidence. This is only the
/// default: a browser reports the depth it actually accepted in its transport
/// hint, and the flush is bounded by that. The constant is what the daemon uses
/// before the first hint arrives, and when a browser cannot read its own depth
/// back.
pub const DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH: u16 = 256;

pub struct DisplayPolicy;

impl DisplayPolicy {
    pub const BULK_ROW_RATIO: f64 = 0.35;
    pub const BACKPRESSURE_SCORE_MAX: u32 = 8;
    pub const LARGE_DELTA_CHUNK_MULTIPLIER: usize = 4;
    pub const INTERACTIVE_CHUNK_MULTIPLIER: usize = 2;

    // Row-hash heartbeat cadence.
    pub const HEARTBEAT_FRAME_INTERVAL: u32 = 10;
    pub const HEARTBEAT_TIME_INTERVAL_MS: f64 = 1000.0;

    // Sized to fit under the smallest WebTransport `max_datagram_size` we've
    // seen in production — iOS Safari has been observed negotiating ~1160-1185
    // bytes, so 1100 gives ~60+ bytes of headroom for path-MTU shifts
    // (carrier handoff, dual-stack). Sends at 1199 bytes were being silently
    // rejected by iOS WT before this cap.
    pub const DATAGRAM_MAX_PAYLOAD_BYTES: usize = 1100;
    /// Largest data shard that still leaves room for one fixed-block repair
    /// shard in a datagram. A repair carries a 16-byte header, so 1084 is the
    /// exact boundary: 16 + 1084 = 1100; 16 + 1085 cannot use this lane.
    ///
    /// Delta batching targets this value. A single indivisible row may still
    /// occupy the ordinary 1100-byte data cap, but it is then deliberately
    /// unprotected rather than promoted to the reliable lane.
    pub const FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES: usize =
        Self::DATAGRAM_MAX_PAYLOAD_BYTES - merkur_codec::DISPLAY_FEC_HEADER_BYTES;
    pub const SENT_DATAGRAM_PRUNE_AGE_MS: f64 = 2000.0;
    /// Hard object-count bound for immutable send-time ACK/NACK snapshots.
    /// At the 1ms interactive flush floor this retains roughly one second of
    /// history—well beyond normal mobile RTT—while preventing a stalled peer
    /// or clock anomaly from growing the per-peer BTreeMap without limit.
    pub const SENT_DATAGRAM_MAX_ENTRIES: usize = 1024;
    /// Ceiling on the re-send interval for a row whose current content is
    /// already on the wire unacknowledged.
    ///
    /// The interval is NOT a recovery timeout — recovery is idempotent
    /// re-selection, which needs no timer. It is pure rate control: re-sending
    /// identical content sooner than one round trip cannot be a response to new
    /// information, because the ACK has not had time to arrive. Without it a
    /// 50 ms path re-sends its whole unACKed working set roughly six times per
    /// round trip, and the resulting offered load is itself what drives the
    /// impaired tail.
    ///
    /// New content is never subject to this: a row whose hash changed is sent
    /// on the next flush regardless, so interactive latency is untouched.
    ///
    /// There is deliberately no constant floor. The old `ROW_RESEND_MIN_MS =
    /// 25.0` sat below one round trip on every path but a LAN, and before the
    /// first display-ACK sample the confirmation estimate was a blind 20 ms, so
    /// production re-sent the same redraw up to five times at 25-40 ms spacing
    /// on a 55 ms path and 25-63% of applied datagrams changed no pixel. The
    /// floor is now the physical one: the path's own measured round trip, which
    /// the heartbeat knows before the first display datagram is ever sent.
    pub const ROW_RESEND_MAX_MS: f64 = 400.0;
    /// Whole-millisecond timer resolution of the owner loop. A re-send deadline
    /// below this cannot be scheduled any earlier than this anyway.
    pub const ROW_RESEND_TIMER_RESOLUTION_MS: f64 = 1.0;
    /// The one known re-send interval the deterministic fixtures stamp on a
    /// sent row so a virtual clock can be advanced past it. Production derives
    /// the interval from measurements; nothing outside tests reads this.
    #[cfg(test)]
    pub const ROW_RESEND_TEST_INTERVAL_MS: f64 = 25.0;

    /// How long a row's newest send is given to land before that row may be
    /// covered by a hash digest. This is the ONLY remaining time constant on
    /// the display path, and it is a diagnostic settling window, not a
    /// retransmit timer: nothing waits on it to put bytes on the wire.
    pub const DIGEST_ROW_SETTLE_MS: f64 = 600.0;

    /// Data shards per FEC group. The burst group is defined as exactly this,
    /// so parity protects precisely the datagrams emitted back to back and
    /// lands immediately behind the data it covers.
    pub const FEC_GROUP_MAX_SIZE: usize = 4;
    pub const FEC_SINGLE_RECOVERY_SHARD_COUNT: usize = 1;
    pub const FEC_RECOVERY_SHARD_COUNT: usize = 2;

    /// Re-send pacing for identical, still-unacknowledged row content.
    ///
    /// Two measurements, and the deadline is the larger of them:
    ///
    /// - the peer's measured *confirmation* delay — send to display-ACK, the
    ///   quantity this deadline is predicting. See `DisplayConfirmDelay` for
    ///   why neither `network_rtt_ewma_ms` nor `rtt_ewma_ms` is that number;
    /// - the selected path's heartbeat round trip. A datagram physically
    ///   cannot be confirmed in less than one round trip, so this is a bound
    ///   rather than an estimate, and it is known before the first display
    ///   datagram is sent. It is what stops the blind first round from
    ///   duplicating every row it sends.
    ///
    /// Each term adds twice its own jitter EWMA. A re-send earlier than the
    /// result is provably wasted, because the ACK cannot have arrived yet. The
    /// only floor is the owner loop's timer resolution.
    #[inline]
    pub fn row_resend_interval_ms(
        confirm_ewma_ms: f64,
        confirm_jitter_ewma_ms: f64,
        path_rtt_ewma_ms: f64,
        path_jitter_ewma_ms: f64,
    ) -> f64 {
        let confirm = confirm_ewma_ms + 2.0 * confirm_jitter_ewma_ms;
        let round_trip = path_rtt_ewma_ms + 2.0 * path_jitter_ewma_ms;
        confirm
            .max(round_trip)
            .clamp(Self::ROW_RESEND_TIMER_RESOLUTION_MS, Self::ROW_RESEND_MAX_MS)
    }
}

pub const TRANSPORT_POLICY_CHUNK_TARGET_MIN_BYTES: usize = 4 * BYTES_PER_KIB;
pub const TRANSPORT_POLICY_CHUNK_TARGET_MAX_BYTES: usize = 64 * BYTES_PER_KIB;
pub const TRANSPORT_POLICY_SNAPSHOT_TARGET_DEFAULT_BYTES: usize = 8 * BYTES_PER_KIB * BYTES_PER_KIB;

pub fn compute_display_workload(
    payload_bytes: usize,
    rows: u16,
    dirty_rows: u16,
    chunk_target_bytes: usize,
    snapshot_target_bytes: usize,
    recent_input: bool,
    backpressured: bool,
) -> DisplayWorkload {
    let dirty_ratio = if rows == 0 {
        1.0
    } else {
        f64::from(dirty_rows) / f64::from(rows)
    };
    let large_delta =
        payload_bytes >= chunk_target_bytes * DisplayPolicy::LARGE_DELTA_CHUNK_MULTIPLIER;

    if recent_input
        && dirty_ratio < DisplayPolicy::BULK_ROW_RATIO
        && payload_bytes <= chunk_target_bytes * DisplayPolicy::INTERACTIVE_CHUNK_MULTIPLIER
    {
        return DisplayWorkload::Interactive;
    }

    if (dirty_ratio >= DisplayPolicy::BULK_ROW_RATIO && large_delta)
        || payload_bytes >= snapshot_target_bytes
        || backpressured
    {
        return DisplayWorkload::Bulk;
    }

    DisplayWorkload::Stream
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Before the first display-ACK sample the confirmation estimate carries
    /// no information; the path round trip is the physical floor and wins.
    #[test]
    fn a_blind_confirmation_estimate_never_resends_inside_one_round_trip() {
        assert_eq!(DisplayPolicy::row_resend_interval_ms(0.0, 0.0, 55.0, 0.0), 55.0);
        assert_eq!(DisplayPolicy::row_resend_interval_ms(0.0, 0.0, 55.0, 4.0), 63.0);
    }

    /// Once the confirmation delay is measured it is the larger term: it
    /// includes the browser's apply and ACK cadence on top of the round trip.
    #[test]
    fn a_measured_confirmation_delay_outranks_the_round_trip() {
        assert_eq!(DisplayPolicy::row_resend_interval_ms(90.0, 5.0, 55.0, 4.0), 100.0);
    }

    /// The only floor is the timer's own resolution; the only ceiling is the
    /// bound on how long a lost datagram may go unrepaired by the deadline.
    #[test]
    fn the_interval_is_clamped_only_by_resolution_and_the_ceiling() {
        assert_eq!(
            DisplayPolicy::row_resend_interval_ms(0.2, 0.0, 0.3, 0.0),
            DisplayPolicy::ROW_RESEND_TIMER_RESOLUTION_MS
        );
        assert_eq!(
            DisplayPolicy::row_resend_interval_ms(900.0, 0.0, 55.0, 0.0),
            DisplayPolicy::ROW_RESEND_MAX_MS
        );
    }
}
