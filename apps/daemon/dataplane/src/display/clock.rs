//! The display path's single source of scheduling time.
//!
//! Two different questions get asked of a clock in this file's neighbours, and
//! they pull in opposite directions:
//!
//! * *What time is it?* — asked to decide whether a peer is due, how a burst
//!   paces, or when a heartbeat fires. Nothing about these answers needs to be
//!   real; they need to be **consistent**, and a test needs to be able to say
//!   what they are.
//! * *How long did that take?* — asked to attribute CPU cost in
//!   [`crate::perf_timing`] and in the prepare worker. These must stay real
//!   even under simulation, or the telemetry is a lie.
//!
//! This type answers only the first question. The measurement sites keep their
//! own [`Instant`]s on purpose.
//!
//! Reaching for an enum rather than a trait is deliberate. `flush_display` is a
//! large `async fn`, so a generic parameter would monomorphize its whole future
//! twice for no runtime gain, and a `&dyn` clock would put a vtable call in
//! front of a ~45 ns read and block inlining. The simulated arm is `cfg(test)`,
//! so a release build has exactly one variant, the `match` folds away, and this
//! compiles to the same `elapsed()` the code performed before it existed.

use std::time::Instant;

/// Milliseconds since the daemon's monotonic epoch.
#[derive(Debug, Clone)]
pub(crate) enum FlushClock {
    /// Production: the process-wide `start_instant` the owner loop already owns.
    Epoch(Instant),
    /// Simulation: time is whatever the simulator says it is.
    ///
    /// `step_ms` is how far each read advances the clock. Zero freezes time for
    /// the whole flush, which is the default and what every determinism test
    /// wants. A positive step makes time pass *inside* a single flush, which is
    /// the only way to reach `display_owner_should_defer`'s turn-budget branch
    /// without depending on how busy the machine is.
    #[cfg(test)]
    Virtual {
        now_ms: std::cell::Cell<f64>,
        step_ms: f64,
    },
}

#[cfg(test)]
impl FlushClock {
    /// A clock that reports the same instant for the whole flush.
    pub(crate) fn frozen(now_ms: f64) -> Self {
        Self::Virtual {
            now_ms: std::cell::Cell::new(now_ms),
            step_ms: 0.0,
        }
    }

    /// A clock where every read advances time by `step_ms`.
    pub(crate) fn stepping(now_ms: f64, step_ms: f64) -> Self {
        debug_assert!(step_ms >= 0.0, "simulated time never runs backwards");
        Self::Virtual {
            now_ms: std::cell::Cell::new(now_ms),
            step_ms,
        }
    }
}

impl FlushClock {
    #[inline(always)]
    pub(crate) fn now_ms(&self) -> f64 {
        match self {
            Self::Epoch(start) => start.elapsed().as_secs_f64() * 1_000.0,
            #[cfg(test)]
            Self::Virtual { now_ms, step_ms } => {
                let value = now_ms.get();
                now_ms.set(value + step_ms);
                value
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frozen clock is a value, not a reading: it cannot drift.
    #[test]
    fn a_virtual_clock_answers_the_same_instant_every_time() {
        let clock = FlushClock::frozen(1_234.5);
        let first = clock.now_ms();
        for _ in 0..1_000 {
            assert_eq!(clock.now_ms(), first, "virtual time advanced on its own");
        }
    }

    /// A stepping clock advances by exactly its step, once per read.
    #[test]
    fn a_stepping_clock_advances_once_per_read() {
        let clock = FlushClock::stepping(100.0, 0.5);
        for tick in 0..64u32 {
            let expected = 100.0 + f64::from(tick) * 0.5;
            let seen = clock.now_ms();
            assert!(
                (seen - expected).abs() < f64::EPSILON,
                "read {tick} reported {seen}, expected {expected}"
            );
        }
    }

    /// The production arm is monotonic and anchored to its epoch.
    #[test]
    fn an_epoch_clock_advances_from_zero() {
        let clock = FlushClock::Epoch(Instant::now());
        let first = clock.now_ms();
        assert!(first >= 0.0, "epoch clock read before its own epoch");
        let mut last = first;
        for _ in 0..1_000 {
            let next = clock.now_ms();
            assert!(next >= last, "epoch clock went backwards: {next} < {last}");
            last = next;
        }
    }
}
