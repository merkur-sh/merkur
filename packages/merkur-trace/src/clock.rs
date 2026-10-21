//! The span counter and its mapping onto the anchor clock: the clock `Instant` reads and
//! samply's samples are stamped against (`CLOCK_UPTIME_RAW` on macOS, which samply names
//! `startTimeAsMachAbsoluteTimeNanoseconds`; `CLOCK_MONOTONIC` on Linux, which perf reads).
//!
//! On Apple silicon a span reads `cntvct_el0` directly: one instruction where
//! `mach_absolute_time` is a call, and with no `isb`, so the read may move a few
//! nanoseconds against its neighbours. The counter and `CLOCK_UPTIME_RAW` tick at
//! different rates (1 GHz against 24 MHz on M4) and differ by an offset the kernel moves
//! when the machine sleeps, so a capture brackets the anchor between two counter reads at
//! its start and again at its end; a moved offset is a clock discontinuity.

/// One counter read bracketed against the anchor clock: `anchor_ns` was read between two
/// counter reads `error_ns` (converted) apart, so the mapping is exact within `error_ns`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Calibration {
    anchor_ticks: u64,
    anchor_ns: u64,
    pub(crate) error_ns: u64,
}

/// Brackets taken per calibration. The narrowest wins; each costs three clock reads.
const BRACKETS: usize = 16;

impl Calibration {
    pub(crate) fn measure() -> Self {
        let mut best: Option<(u64, u64, u64)> = None;
        for _ in 0..BRACKETS {
            let before = platform::ticks();
            let anchor = platform::anchor_ns();
            let after = platform::ticks();
            let width = after.wrapping_sub(before);
            if best.is_none_or(|(_, _, narrowest)| width < narrowest) {
                best = Some((before.wrapping_add(width / 2), anchor, width));
            }
        }
        let (anchor_ticks, anchor_ns, width) = best.unwrap_or((0, 0, 0));
        Self {
            anchor_ticks,
            anchor_ns,
            error_ns: platform::ticks_to_ns(width / 2 + 1)
                .saturating_add(platform::ANCHOR_QUANTUM_NS),
        }
    }

    /// Anchor-clock nanoseconds of a counter read.
    pub(crate) fn to_anchor_ns(self, ticks: u64) -> u64 {
        if ticks >= self.anchor_ticks {
            self.anchor_ns
                .saturating_add(platform::ticks_to_ns(ticks - self.anchor_ticks))
        } else {
            self.anchor_ns
                .saturating_sub(platform::ticks_to_ns(self.anchor_ticks - ticks))
        }
    }

    /// Whether `later` contradicts this mapping by more than both brackets allow: the
    /// counter-to-anchor offset moved, which on macOS means the machine slept.
    pub(crate) fn discontinuous(self, later: Self) -> bool {
        let predicted = self.to_anchor_ns(later.anchor_ticks);
        predicted.abs_diff(later.anchor_ns) > self.error_ns.saturating_add(later.error_ns)
    }
}

/// Anchor-clock nanoseconds now.
pub(crate) fn anchor_ns() -> u64 {
    platform::anchor_ns()
}

/// The anchor's resolution: the most two adjacent anchor reads can disagree by.
pub(crate) const ANCHOR_QUANTUM_NS: u64 = platform::ANCHOR_QUANTUM_NS;

/// Which anchor clock a capture's times are on, as the capture file names it.
pub(crate) const DOMAIN: u64 = platform::DOMAIN;

#[inline(always)]
pub(crate) fn ticks() -> u64 {
    platform::ticks()
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod platform {
    unsafe extern "C" {
        fn clock_gettime_nsec_np(clock_id: u32) -> u64;
    }

    /// `CLOCK_UPTIME_RAW` in `<time.h>`: the clock `Instant` reads on macOS.
    const CLOCK_UPTIME_RAW: u32 = 8;

    /// File value for `CLOCK_UPTIME_RAW` nanoseconds.
    pub(super) const DOMAIN: u64 = 1;

    /// `CLOCK_UPTIME_RAW` counts mach ticks, 125/3 ns each on Apple silicon.
    pub(super) const ANCHOR_QUANTUM_NS: u64 = 42;

    #[inline(always)]
    pub(super) fn ticks() -> u64 {
        let value: u64;
        // SAFETY: EL0 may read the virtual counter on Apple silicon; the read has no side
        // effects and touches no memory.
        unsafe {
            core::arch::asm!(
                "mrs {value}, cntvct_el0",
                value = out(reg) value,
                options(nomem, nostack, preserves_flags),
            );
        }
        value
    }

    fn frequency() -> u64 {
        let value: u64;
        // SAFETY: EL0 may read the counter frequency register; the read has no side effects.
        unsafe {
            core::arch::asm!(
                "mrs {value}, cntfrq_el0",
                value = out(reg) value,
                options(nomem, nostack, preserves_flags),
            );
        }
        value.max(1)
    }

    pub(super) fn ticks_to_ns(ticks: u64) -> u64 {
        let ns = u128::from(ticks) * 1_000_000_000 / u128::from(frequency());
        u64::try_from(ns).unwrap_or(u64::MAX)
    }

    pub(super) fn anchor_ns() -> u64 {
        // SAFETY: `clock_gettime_nsec_np` reads a clock by id and has no preconditions.
        unsafe { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
    }
}

#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
mod platform {
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    unsafe extern "C" {
        fn mach_absolute_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> i32;
        fn clock_gettime_nsec_np(clock_id: u32) -> u64;
    }

    /// `CLOCK_UPTIME_RAW` in `<time.h>`: the clock `Instant` reads on macOS.
    const CLOCK_UPTIME_RAW: u32 = 8;

    /// File value for `CLOCK_UPTIME_RAW` nanoseconds.
    pub(super) const DOMAIN: u64 = 1;

    /// Intel Macs count mach ticks in nanoseconds.
    pub(super) const ANCHOR_QUANTUM_NS: u64 = 1;

    #[inline(always)]
    pub(super) fn ticks() -> u64 {
        // SAFETY: `mach_absolute_time` has no preconditions.
        unsafe { mach_absolute_time() }
    }

    pub(super) fn ticks_to_ns(ticks: u64) -> u64 {
        let mut info = Timebase { numer: 1, denom: 1 };
        // SAFETY: `info` is a valid, writable `mach_timebase_info_data_t`.
        unsafe { mach_timebase_info(&raw mut info) };
        let ns = u128::from(ticks) * u128::from(info.numer) / u128::from(info.denom.max(1));
        u64::try_from(ns).unwrap_or(u64::MAX)
    }

    pub(super) fn anchor_ns() -> u64 {
        // SAFETY: `clock_gettime_nsec_np` reads a clock by id and has no preconditions.
        unsafe { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    /// File value for `CLOCK_MONOTONIC` nanoseconds.
    pub(super) const DOMAIN: u64 = 2;

    /// The vDSO clock reports nanoseconds.
    pub(super) const ANCHOR_QUANTUM_NS: u64 = 1;

    /// Spans read the anchor clock itself: no counter on Linux maps onto `CLOCK_MONOTONIC`
    /// exactly, because NTP slews it.
    #[inline(always)]
    pub(super) fn ticks() -> u64 {
        anchor_ns()
    }

    pub(super) fn ticks_to_ns(ticks: u64) -> u64 {
        ticks
    }

    pub(super) fn anchor_ns() -> u64 {
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `now` is a valid, writable `timespec`; CLOCK_MONOTONIC always exists.
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut now) };
        let seconds = u64::try_from(now.tv_sec).unwrap_or(0);
        let nanos = u64::try_from(now.tv_nsec).unwrap_or(0);
        seconds.saturating_mul(1_000_000_000).saturating_add(nanos)
    }
}
