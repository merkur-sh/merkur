//! Simulated clocks under every reader in the simulator binary.
//!
//! The technique is madsim's, as `mad-turmoil` packages it for turmoil: this
//! binary defines `clock_gettime` itself, and the standard library, linked
//! statically into the same binary, resolves `Instant::now()` and
//! `SystemTime::now()` to it. Production code therefore reads simulated time
//! through its ordinary clock calls; nothing in it knows about the simulator.
//!
//! While a run is active, a reader inside a host gets that host's paused tokio
//! clock, so `std` and tokio instants agree exactly. A reader outside every
//! host (setup, or an OS thread) gets the last simulated reading. Monotonic
//! time starts far from zero, so code that subtracts from an instant cannot
//! underflow; wall time starts at a fixed instant, so a certificate or token
//! minted inside the run is valid inside it. Outside a run every reader gets
//! the system clock.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Where simulated monotonic time starts.
const MONOTONIC_EPOCH: Duration = Duration::from_secs(1_000_000);
/// Where simulated wall time starts: 2026-09-01T00:00:00Z.
const WALL_EPOCH: Duration = Duration::from_secs(1_788_220_800);

static ACTIVE: AtomicBool = AtomicBool::new(false);
/// The latest simulated reading, as nanoseconds past `MONOTONIC_EPOCH`.
static LAST_NANOS: AtomicU64 = AtomicU64::new(0);
/// The `std` instant that reads as `MONOTONIC_EPOCH` in the current run.
static ANCHOR: OnceLock<Instant> = OnceLock::new();

/// Simulated clocks for the guard's lifetime.
pub struct Clocks(());

impl Clocks {
    /// Starts simulated time at its epochs. One run at a time per process.
    pub fn start() -> Self {
        assert!(
            !ACTIVE.swap(true, Ordering::AcqRel),
            "one simulated run at a time"
        );
        LAST_NANOS.store(0, Ordering::Release);
        // Outside every host this reads as the epoch, which makes it the anchor.
        let anchor = Instant::now();
        assert_eq!(
            *ANCHOR.get_or_init(|| anchor),
            anchor,
            "the epoch never moves"
        );
        Self(())
    }
}

impl Drop for Clocks {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

/// Simulated time past the monotonic epoch.
fn simulated_elapsed() -> Duration {
    let Some(anchor) = ANCHOR.get() else {
        return Duration::ZERO;
    };
    if tokio::runtime::Handle::try_current().is_ok() {
        // A turmoil host's runtime is paused, so this reads no clock itself.
        let elapsed = tokio::time::Instant::now()
            .into_std()
            .duration_since(*anchor);
        let nanos = u64::try_from(elapsed.as_nanos()).expect("a run shorter than 584 years");
        LAST_NANOS.fetch_max(nanos, Ordering::AcqRel);
        elapsed
    } else {
        Duration::from_nanos(LAST_NANOS.load(Ordering::Acquire))
    }
}

fn timespec(duration: Duration) -> libc::timespec {
    libc::timespec {
        tv_sec: libc::time_t::try_from(duration.as_secs()).expect("a representable time"),
        tv_nsec: libc::c_long::from(duration.subsec_nanos()),
    }
}

fn monotonic(clock: libc::clockid_t) -> bool {
    #[cfg(target_os = "macos")]
    if clock == libc::CLOCK_UPTIME_RAW {
        return true;
    }
    #[cfg(target_os = "linux")]
    if clock == libc::CLOCK_BOOTTIME || clock == libc::CLOCK_MONOTONIC_COARSE {
        return true;
    }
    clock == libc::CLOCK_MONOTONIC || clock == libc::CLOCK_MONOTONIC_RAW
}

type ClockGettime = unsafe extern "C" fn(libc::clockid_t, *mut libc::timespec) -> libc::c_int;

/// The C library's own `clock_gettime`, which this binary's definition hides.
fn system_clock_gettime() -> ClockGettime {
    static SYSTEM: OnceLock<ClockGettime> = OnceLock::new();
    *SYSTEM.get_or_init(|| {
        // SAFETY: RTLD_NEXT names the next image's definition, the C library's.
        let symbol = unsafe { libc::dlsym(libc::RTLD_NEXT, c"clock_gettime".as_ptr()) };
        assert!(!symbol.is_null(), "the C library defines clock_gettime");
        // SAFETY: the symbol is `clock_gettime`, whose signature this is.
        unsafe { std::mem::transmute::<*mut libc::c_void, ClockGettime>(symbol) }
    })
}

/// # Safety
///
/// `tp` must be valid for a write of one `timespec`, as the C function requires.
#[unsafe(no_mangle)]
#[inline(never)]
pub unsafe extern "C" fn clock_gettime(
    clock: libc::clockid_t,
    tp: *mut libc::timespec,
) -> libc::c_int {
    if ACTIVE.load(Ordering::Acquire) {
        let base = if monotonic(clock) {
            Some(MONOTONIC_EPOCH)
        } else if clock == libc::CLOCK_REALTIME {
            Some(WALL_EPOCH)
        } else {
            None
        };
        if let Some(base) = base {
            // SAFETY: the caller's contract.
            unsafe { tp.write(timespec(base + simulated_elapsed())) };
            return 0;
        }
    }
    // SAFETY: the caller's contract, forwarded unchanged.
    unsafe { system_clock_gettime()(clock, tp) }
}
