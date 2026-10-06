//! Deterministic session-liveness and token-lifecycle policy.
//!
//! Every timing value here is either derived from measured per-path RTT
//! state (RFC 6298 style: SRTT + 4·RTTVAR, with documented floor/ceiling)
//! or expressed as a ratio of another named value. The per-path
//! `rtt_ewma_ms`/`jitter_ewma_ms` maintained in `connection.rs` are the
//! SRTT/RTTVAR inputs. Display-throughput policy (flush delays, pacing,
//! FEC sizing) stays in `display/policy.rs`; this module owns session
//! liveness, auth, and resume timing.

pub struct SessionPolicy;

impl SessionPolicy {
    /// RFC 6298 retransmission-timeout floor. Round trips below this are
    /// indistinguishable from scheduler/event-loop noise, so no derived
    /// timeout may be tighter. Mirrors packages/shared/src/rtt-estimator.ts.
    pub const RTO_FLOOR_MS: f64 = 250.0;
    /// RFC 6298 RTO ceiling. For an interactive terminal a path slower
    /// than this is already unusable; waiting longer only delays failover.
    /// Mirrors packages/shared/src/rtt-estimator.ts.
    pub const RTO_CEIL_MS: f64 = 3_000.0;

    /// Cadence of the run-loop heartbeat/liveness timer. This is the
    /// daemon's probe-granularity floor: a suspect path is re-pinged at
    /// most once per tick, so probe spacing is `max(RTO, tick)`.
    pub const HEARTBEAT_TICK_MS: u64 = 2_000;

    /// Unanswered probes (sent at probe spacing once a path goes suspect)
    /// before the path is declared dead. Daemon-only: this verdict retires a
    /// path the daemon has alternatives to, whereas the browser's ladder
    /// (apps/web/src/session/session-heartbeat.ts) never counts probes into a
    /// verdict, because giving up its only carrier needs a proven replacement
    /// or a failed dial, not silence.
    pub const PROBE_COUNT: u32 = 3;

    /// Per-path heartbeat cadence. Edge and direct WebTransport each send one
    /// PING at this interval when available, so we can attribute the PONG
    /// to a specific path and update per-path RTT/availability. This is the
    /// steady-state bandwidth knob, not the detection-latency knob —
    /// staleness is judged against `PATH_STALE_THRESHOLD_MS`.
    /// Mirrors packages/shared/src/transport.ts heartbeat usage.
    pub const PATH_HEARTBEAT_INTERVAL_MS: f64 = 5_000.0;

    /// A path with no inbound activity (ACK, PONG, anything) for this
    /// duration is considered stale and unavailable. Three heartbeat
    /// intervals: two consecutive lost PINGs plus the round trip of the
    /// third — quiet-but-alive paths always answer one of three pings.
    pub const PATH_STALE_THRESHOLD_MS: f64 = 3.0 * Self::PATH_HEARTBEAT_INTERVAL_MS;

    /// After N consecutive `try_send` failures on a path, mark it
    /// unavailable. Reset to zero on the next successful send (which
    /// happens automatically when an ACK arrives or the path's send
    /// channel drains).
    pub const PATH_SEND_FAILURE_THRESHOLD: u32 = 3;

    /// Event-loop/scheduler slack added on top of a round trip when the
    /// awaited message is already expected to be in flight.
    pub const SCHED_SLACK_MS: f64 = 10.0;
    /// Floor for the awaiting-resume gate: even on a LAN, the client needs
    /// one event-loop turn to parse session_ready and emit display_resume.
    pub const AWAITING_RESUME_FLOOR_MS: f64 = 30.0;
    /// Ceiling for the awaiting-resume gate: past this, holding back the
    /// safety-net snapshot hurts a client that never sends display_resume
    /// more than the gate helps one that does.
    pub const AWAITING_RESUME_CEIL_MS: f64 = 250.0;

    /// Client-side crypto slack for ML-KEM decapsulation and the mandatory
    /// Noise handshake on a throttled background tab or low-end mobile device.
    pub const AUTH_CRYPTO_SLACK_MS: f64 = 2_000.0;

    /// After token-resumed auth with a usable display cache, the daemon
    /// holds the auto-snapshot until the client's `MSG_TYPE_DISPLAY_RESUME`
    /// arrives and drives snapshot-vs-delta. One round trip (SRTT plus
    /// dispersion) plus scheduler slack: the legitimate client always wins
    /// the race, and if the resume frame never comes the snapshot fires as
    /// a safety net at most one clamped RTT late.
    pub fn awaiting_resume_timeout_ms(srtt_ms: f64, rttvar_ms: f64) -> f64 {
        (srtt_ms + 4.0 * rttvar_ms + Self::SCHED_SLACK_MS).clamp(
            Self::AWAITING_RESUME_FLOOR_MS,
            Self::AWAITING_RESUME_CEIL_MS,
        )
    }

    /// Budget for hybrid authentication plus mandatory Noise: two round trips
    /// at the RTO ceiling plus client crypto slack.
    /// RTT is unmeasured this early, so the ceiling stands in for SRTT.
    pub fn session_auth_timeout_ms() -> f64 {
        2.0 * Self::RTO_CEIL_MS + Self::AUTH_CRYPTO_SLACK_MS
    }

    /// Maximum lifetime of preserved display state awaiting a replacement
    /// connection that completes fresh hybrid authentication.
    pub const PARKED_PEER_TTL_MS: u64 = 30 * 60 * 1000;

    /// How long a single carrier gap may last before the daemon gives up on a
    /// rebind, closes the retained edge tunnel, and parks the peer.
    ///
    /// Equal, not merely comparable, to three constants it must not exceed:
    /// the edge's `UNPAIRED_SESSION_TTL` (the half-paired slot lifetime, so no
    /// side needs a timer the other does not have), the browser's
    /// `DORMANT_GRACE_MS` (the same policy stated on the other side — if they
    /// differed, one side would keep hoping after the other gave up), and
    /// `EDGE_PREAUTH_LEASE_TTL_MS`. It also stays well inside the server's
    /// 300 s Redis session claim, so a rebound session id is still claimed for
    /// the whole window.
    ///
    /// Mirrored by `REBIND_WINDOW_MS` in
    /// `packages/config/src/reconnect-policy.ts`.
    pub const REBIND_WINDOW_MS: u64 = 60 * 1000;

    /// Fixture lifetime for the default server-signed capability. Production
    /// admission reads the actual signed deadline from AuthorizationEpoch.
    #[cfg(test)]
    pub const TEST_AUTHORIZATION_LIFETIME_MS: u64 = 5 * 60 * 1000;

    /// Rebind generations permitted per server-authorized epoch.
    pub const MAX_REBIND_GENERATIONS: u64 = 8;

    /// How long a carrier gap may run before the peer is parked instead.
    ///
    /// One tick inside [`Self::REBIND_WINDOW_MS`] so the daemon gives up first
    /// and the edge's half-paired slot empties cleanly, rather than racing the
    /// edge's own prune. Shared by every site that arms a gap window from
    /// nothing but its own clock, so the two cannot drift: the lane-close path
    /// in `main.rs` and the liveness sweep in `session/liveness.rs`.
    /// `reconcile_rebind_windows` deliberately does NOT use this — it has the
    /// edge's own statement of what remains and must not overwrite it.
    pub fn carrier_gap_window_ms() -> f64 {
        (Self::REBIND_WINDOW_MS as f64 - Self::HEARTBEAT_TICK_MS as f64).max(0.0)
    }

    /// How stale the daemon's server control link may be and still admit a
    /// rebind.
    ///
    /// A rebind skips the server, so the daemon becomes the sole enforcement
    /// point for delegation revocation. Revocation is pushed over the control
    /// link and answered on the Redis lease, which renews every 20 s — so two
    /// lease periods plus slack means a single missed renewal does not force a
    /// full re-authentication, while a genuinely disconnected daemon fails
    /// closed and stops admitting rebinds it cannot vouch for.
    pub const REBIND_CONTROL_FRESHNESS_MS: u64 = 45 * 1000;

    /// RFC 6298: RTO = SRTT + 4·RTTVAR, clamped. The per-path
    /// `rtt_ewma_ms`/`jitter_ewma_ms` EWMAs from `connection.rs` are the
    /// SRTT/RTTVAR inputs.
    pub fn rto_ms(srtt_ms: f64, rttvar_ms: f64) -> f64 {
        (srtt_ms + 4.0 * rttvar_ms).clamp(Self::RTO_FLOOR_MS, Self::RTO_CEIL_MS)
    }

    /// Probe spacing for a suspect path: one RTO, floored at the heartbeat
    /// tick (the daemon cannot probe faster than its liveness timer runs).
    pub fn probe_interval_ms(rto_ms: f64) -> f64 {
        rto_ms.max(Self::HEARTBEAT_TICK_MS as f64)
    }

    /// The quiet term: a path is suspect when it has said nothing for one
    /// heartbeat interval plus one RTO — the last steady-state ping has had a
    /// full round trip to come back.
    fn quiet_suspect_after_ms(rto_ms: f64) -> f64 {
        Self::PATH_HEARTBEAT_INTERVAL_MS + rto_ms
    }

    /// How old this path's silence must be before it is suspect.
    ///
    /// Two terms, and the earlier wins. The quiet term above is bounded below by
    /// `PATH_HEARTBEAT_INTERVAL_MS`: the daemon will not begin to doubt a path
    /// until its own 5 s clock comes round, however much it has put on the wire
    /// meanwhile. That is a timer standing in for evidence, and it is the same
    /// wait-for-a-clock defect the browser's ladder had. A path that is being
    /// TALKED to answers on the traffic's schedule, so an ack-eliciting send
    /// that has gone unanswered for a full RTO is suspicion available now
    /// rather than seconds from now.
    ///
    /// `oldest_unanswered_send_ms` is 0.0 when nothing is outstanding, and then
    /// this is exactly the quiet term. That case is not a fallback but the
    /// common one: an idle terminal emits no display datagrams at all, so on a
    /// quiet session there is nothing to reason from and quiet time is the only
    /// detector there is.
    pub fn path_suspect_after_ms(rto_ms: f64, now_ms: f64, oldest_unanswered_send_ms: f64) -> f64 {
        let quiet = Self::quiet_suspect_after_ms(rto_ms);
        if oldest_unanswered_send_ms <= 0.0 {
            return quiet;
        }
        let send_age_ms = now_ms - oldest_unanswered_send_ms;
        if send_age_ms < rto_ms {
            return quiet;
        }
        // Stated as an equivalent silence age so every caller keeps comparing
        // one quantity against `now - last_ack_at_ms`.
        quiet.min(send_age_ms)
    }

    /// A path is dead when quiet past the suspect point plus a full probe
    /// budget: PROBE_COUNT probes at probe spacing, all unanswered.
    ///
    /// The budget is unchanged; only the point it is measured from can move,
    /// and only when there is an unanswered send to move it.
    pub fn path_dead_after_ms(rto_ms: f64, now_ms: f64, oldest_unanswered_send_ms: f64) -> f64 {
        Self::path_suspect_after_ms(rto_ms, now_ms, oldest_unanswered_send_ms)
            + f64::from(Self::PROBE_COUNT) * Self::probe_interval_ms(rto_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn awaiting_resume_gate_tracks_measured_rtt() {
        // Default path baseline (50 ms SRTT, no jitter samples yet):
        // one RTT + scheduler slack.
        assert_eq!(SessionPolicy::awaiting_resume_timeout_ms(50.0, 0.0), 60.0);
        // LAN round trips clamp at the event-loop floor.
        assert_eq!(
            SessionPolicy::awaiting_resume_timeout_ms(2.0, 1.0),
            SessionPolicy::AWAITING_RESUME_FLOOR_MS
        );
        // High-latency, high-jitter paths clamp at the snapshot-safety ceiling.
        assert_eq!(
            SessionPolicy::awaiting_resume_timeout_ms(400.0, 100.0),
            SessionPolicy::AWAITING_RESUME_CEIL_MS
        );
        // Jitter widens the gate fourfold per RFC 6298 dispersion weighting.
        assert_eq!(SessionPolicy::awaiting_resume_timeout_ms(50.0, 20.0), 140.0);
    }

    #[test]
    fn session_auth_timeout_is_two_ceiling_round_trips_plus_crypto() {
        assert_eq!(SessionPolicy::session_auth_timeout_ms(), 8_000.0);
    }

    #[test]
    fn path_staleness_is_three_heartbeat_intervals() {
        assert_eq!(SessionPolicy::PATH_STALE_THRESHOLD_MS, 15_000.0);
    }

    #[test]
    fn rto_follows_rfc_6298_with_clamps() {
        // Default path baseline: 50 ms SRTT, no jitter — floor wins.
        assert_eq!(SessionPolicy::rto_ms(50.0, 0.0), 250.0);
        // Jittery WAN path: SRTT + 4·RTTVAR in the linear region.
        assert_eq!(SessionPolicy::rto_ms(200.0, 100.0), 600.0);
        // Pathological path clamps at the ceiling.
        assert_eq!(SessionPolicy::rto_ms(2_000.0, 500.0), 3_000.0);
    }

    #[test]
    fn path_death_is_suspect_point_plus_probe_budget() {
        // Low-RTT path with nothing outstanding: probes paced by the heartbeat
        // tick (2 s), so death lands at 5000 + 250 + 3·2000 = 11.25 s —
        // derived, and strictly tighter than the old flat 15 s.
        let rto = SessionPolicy::rto_ms(20.0, 5.0);
        assert_eq!(SessionPolicy::path_suspect_after_ms(rto, 0.0, 0.0), 5_250.0);
        assert_eq!(SessionPolicy::path_dead_after_ms(rto, 0.0, 0.0), 11_250.0);
        // Ceiling-RTO path: probes at RTO spacing, death at
        // 5000 + 3000 + 3·3000 = 17 s.
        assert_eq!(
            SessionPolicy::path_dead_after_ms(3_000.0, 0.0, 0.0),
            17_000.0
        );
    }

    /// The idle session is the case the quiet term exists for, and it must be
    /// completely unaffected: no display datagram is emitted at a prompt, so
    /// there is never an outstanding send to reason from.
    #[test]
    fn an_idle_path_keeps_the_quiet_verdict_exactly() {
        let rto = SessionPolicy::rto_ms(20.0, 5.0);
        for now_ms in [0.0, 1_000.0, 60_000.0, 3_600_000.0] {
            assert_eq!(
                SessionPolicy::path_suspect_after_ms(rto, now_ms, 0.0),
                SessionPolicy::path_suspect_after_ms(rto, 0.0, 0.0)
            );
        }
    }

    /// An unanswered send younger than one round trip is not yet evidence of
    /// anything — that is simply a frame still in flight.
    #[test]
    fn an_in_flight_send_does_not_move_the_verdict() {
        let rto = SessionPolicy::rto_ms(20.0, 5.0);
        let sent_at = 10_000.0;
        assert_eq!(
            SessionPolicy::path_suspect_after_ms(rto, sent_at + rto / 2.0, sent_at),
            5_250.0
        );
    }

    /// Past one RTO the send is unanswered rather than in flight, and suspicion
    /// is available now instead of when the 5 s clock next comes round.
    #[test]
    fn an_unanswered_send_moves_the_suspect_point_earlier() {
        let rto = SessionPolicy::rto_ms(20.0, 5.0);
        let sent_at = 10_000.0;
        // One RTO after the send: suspect at the send's own age, far below the
        // 5_250 ms the quiet term would have required.
        let now = sent_at + rto;
        assert_eq!(SessionPolicy::path_suspect_after_ms(rto, now, sent_at), rto);
        // The probe budget is untouched; only its origin moved.
        assert_eq!(
            SessionPolicy::path_dead_after_ms(rto, now, sent_at),
            rto + 3.0 * SessionPolicy::probe_interval_ms(rto)
        );
    }

    /// It may only ever move the verdict EARLIER. A send outstanding for longer
    /// than the quiet threshold must not push the deadline out past it.
    #[test]
    fn an_old_unanswered_send_never_delays_the_verdict() {
        let rto = SessionPolicy::rto_ms(20.0, 5.0);
        let sent_at = 1_000.0;
        let now = sent_at + 30_000.0;
        assert_eq!(
            SessionPolicy::path_suspect_after_ms(rto, now, sent_at),
            5_250.0
        );
    }
}
