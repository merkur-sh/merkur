/** Redis lease duration for a daemon's current control-plane presence. */
export const DAEMON_ONLINE_TTL_MS = 60_000;

/**
 * How long a suspended presence survives after its carrier drops before the
 * expiry scheduler retires it. This is the user-visible `degraded` window, not
 * the control carrier's cryptographic resume TTL — a daemon that takes longer
 * than this to reattach genuinely was offline and should read that way.
 *
 * Half of `DAEMON_ONLINE_TTL_MS`, so suspending always shortens a lease.
 */
export const DAEMON_CONTROL_RESUME_GRACE_MS = 30_000;
