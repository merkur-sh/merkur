/**
 * Shared retention and host-side wake, issuance, and candidate-race policy.
 *
 * Every timing value here is either derived from a measured input with a
 * documented floor/ceiling, or expressed as a ratio of another named value —
 * no free-standing magic numbers at call sites. The Rust mirror lives in
 * packages/merkur-client/src/session/policy.rs; values that must agree across
 * languages carry a mirror comment on both sides.
 */

/** Remote rebind retention policy, mirrored by the edge and daemon. */
export const REBIND_WINDOW_MS = 60_000;

/** Rebind generations permitted per server-authorized epoch. */
export const MAX_REBIND_GENERATIONS = 8;

/**
 * Suspension evidence that starts a non-displacing authenticated candidate.
 * Page suspension does not prove that the browser network process stopped or
 * that either remote peer's rebind retention clock has elapsed.
 */
export const CARRIER_IDLE_DEATH_MS = 4_000;

/**
 * Wake-detector tick spacing. The detector only acts on visible documents,
 * which are exempt from intensive background-timer throttling, so a 2 s tick
 * fires reliably; it is also one heartbeat interval, so the detector never
 * outpaces the liveness machinery it feeds.
 */
export const WAKE_TICK_MS = 2_000;

/**
 * A wake-detector tick arriving this much late means the machine slept or
 * the page was suspended — not timer jitter. Five tick intervals: ordinary
 * main-thread stalls and GC pauses stay far below it, while any real
 * suspend/resume gap (seconds to hours) clears it easily.
 */
export const WAKE_CLOCK_JUMP_MS = 5 * WAKE_TICK_MS;

/**
 * Absolute ceiling on a WebTransport candidate race. Slightly above the
 * worst acceptable handshake (RTO ceiling shared with the daemon policy is
 * 3 s; the race gives up just before it) — anything slower loses to staying
 * on the edge-relayed WebTransport path.
 */
export const RACE_DEADLINE_MS = 2_500;

const GRACE_FLOOR_MS = 80;
const GRACE_CEILING_MS = 400;
const GRACE_MULTIPLIER = 3;

/**
 * Maximum grace after the first candidate handshake succeeds:
 * `3 × firstHandshakeMs` (clamped) for a better candidate before committing.
 * Three handshake times covers a same-network candidate that started up to
 * two interleave slots later; the floor absorbs timer jitter on LAN
 * handshakes and the ceiling bounds time-to-direct-path on slow networks.
 * The race ends sooner when no pending handshake can improve the winner.
 */
export function raceGraceMs(firstHandshakeMs: number): number {
  return Math.min(
    GRACE_CEILING_MS,
    Math.max(GRACE_FLOOR_MS, Math.round(firstHandshakeMs * GRACE_MULTIPLIER)),
  );
}

/**
 * Deadline for the access-token-gated session issuance request. The server's
 * daemon command acknowledgement is bounded to 5 s, so twice that window leaves
 * room for the HTTPS round trip and scheduling while still ensuring a fetch
 * stranded by a Wi-Fi transition cannot pin browser reconnect attempt 1
 * forever. The Effect owner interrupts the request on expiry, which aborts the
 * underlying fetch.
 */
export const SESSION_ISSUANCE_REQUEST_TIMEOUT_MS = 10_000;
