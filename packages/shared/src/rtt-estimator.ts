/**
 * RFC 6298 round-trip-time estimator (Jacobson/Karels).
 *
 * SRTT and RTTVAR are maintained with the standard gains (α = 1/8,
 * β = 1/4); the retransmission timeout is SRTT + 4·RTTVAR clamped to
 * [RTO_FLOOR_MS, RTO_CEIL_MS]. The floor/ceiling mirror the daemon's
 * session policy (apps/daemon/dataplane/src/session/policy.rs) so both
 * sides of a path agree on what "too quiet" means.
 */

/** Round trips below this are indistinguishable from timer/scheduler noise. */
export const RTO_FLOOR_MS = 250;
/** A path slower than this is unusable for an interactive terminal. */
export const RTO_CEIL_MS = 3_000;
/** RFC 6298 §2.1: the RTO before any sample exists. */
export const RTO_INITIAL_MS = 1_000;

const ALPHA = 1 / 8;
const BETA = 1 / 4;
const K = 4;

export interface RttEstimator {
  observe(rttMs: number): void;
  srttMs(): number | null;
  rttvarMs(): number | null;
  /** Current retransmission timeout; RTO_INITIAL_MS before the first sample. */
  rtoMs(): number;
}

export function createRttEstimator(): RttEstimator {
  let srtt: number | null = null;
  let rttvar = 0;

  return {
    observe(rttMs: number): void {
      if (!Number.isFinite(rttMs) || rttMs < 0) return;
      if (srtt === null) {
        // RFC 6298 §2.2: first measurement.
        srtt = rttMs;
        rttvar = rttMs / 2;
        return;
      }
      // RFC 6298 §2.3: RTTVAR before SRTT, each from the prior SRTT.
      rttvar = (1 - BETA) * rttvar + BETA * Math.abs(srtt - rttMs);
      srtt = (1 - ALPHA) * srtt + ALPHA * rttMs;
    },

    srttMs(): number | null {
      return srtt;
    },

    rttvarMs(): number | null {
      return srtt === null ? null : rttvar;
    },

    rtoMs(): number {
      if (srtt === null) return RTO_INITIAL_MS;
      return Math.min(RTO_CEIL_MS, Math.max(RTO_FLOOR_MS, srtt + K * rttvar));
    },
  };
}
