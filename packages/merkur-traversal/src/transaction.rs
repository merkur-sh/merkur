//! RFC 8489 UDP transaction timing for native checks and source observations.

use tokio::time::Duration;

/// RFC 8489 Rc: seven transmissions when no response is received.
pub(crate) const SENDS: u32 = 7;
/// RFC 8489 initial RTO in the absence of a measured peer RTT.
const INITIAL_RTO: Duration = Duration::from_millis(500);
/// RFC 8489 Rm: sixteen initial RTOs after the final transmission.
const FINAL_RTO_MULTIPLIER: u32 = 16;

pub(crate) const BUDGET: Duration =
    INITIAL_RTO.saturating_mul(((1 << (SENDS - 1)) - 1) + FINAL_RTO_MULTIPLIER);

pub(crate) fn wait(attempt: u32) -> Duration {
    INITIAL_RTO
        * if attempt + 1 == SENDS {
            FINAL_RTO_MULTIPLIER
        } else {
            1 << attempt
        }
}
