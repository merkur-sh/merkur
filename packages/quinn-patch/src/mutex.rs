use std::{
    fmt::Debug,
    ops::{Deref, DerefMut},
};

/// State that completes its own bookkeeping before its lock is released,
/// whichever caller locked it
pub(crate) trait Unlock {
    /// Runs as the guard drops, while the lock is still held
    fn before_unlock(&mut self);
}

/// Finish an unwinding-free critical section. A panicking holder leaves the
/// state to poisoning rather than running bookkeeping on it.
fn release<T: Unlock>(value: &mut T) {
    if !std::thread::panicking() {
        value.before_unlock();
    }
}

/// Acquire `mutex`. Only an acquisition another thread's hold makes wait is
/// timed, and only on a thread that asked; an uncontended one reads no clock.
fn acquire<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::WouldBlock) => {
            contention::wait(|| mutex.lock().expect("connection state lock poisoned"))
        }
        Err(std::sync::TryLockError::Poisoned(poisoned)) => {
            panic!("connection state lock poisoned: {poisoned}")
        }
    }
}

/// Per-thread wait for connection state another thread held.
///
/// A latency-critical owner thread turns this on for itself while it is
/// profiled, and differences [`waited`] across the intervals it attributes.
/// No thread pays for it otherwise: the check sits on the contended path only.
pub mod contention {
    use crate::{Duration, Instant};
    use std::cell::Cell;

    thread_local! {
        static OBSERVED: Cell<bool> = const { Cell::new(false) };
        static WAITED_NS: Cell<u64> = const { Cell::new(0) };
    }

    pub(crate) fn wait<R>(acquire: impl FnOnce() -> R) -> R {
        if !OBSERVED.with(Cell::get) {
            return acquire();
        }
        let started = Instant::now();
        let acquired = acquire();
        let waited = u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
        WAITED_NS.with(|total| total.set(total.get().saturating_add(waited)));
        acquired
    }

    /// Charge the calling thread's contended acquisitions to [`waited`] from
    /// now on, or stop.
    pub fn observe(enabled: bool) {
        OBSERVED.with(|observed| observed.set(enabled));
    }

    /// Everything the calling thread has waited while observed, since it
    /// started. Monotonic: callers difference two readings.
    pub fn waited() -> Duration {
        Duration::from_nanos(WAITED_NS.with(Cell::get))
    }
}

#[cfg(feature = "lock_tracking")]
mod tracking {
    use super::*;
    use crate::{Duration, Instant};
    use std::collections::VecDeque;
    use tracing::warn;

    #[derive(Debug)]
    struct Inner<T> {
        last_lock_owner: VecDeque<(&'static str, Duration)>,
        value: T,
    }

    /// A Mutex which optionally allows to track the time a lock was held and
    /// emit warnings in case of excessive lock times
    pub(crate) struct Mutex<T: Unlock> {
        inner: std::sync::Mutex<Inner<T>>,
    }

    impl<T: Unlock + Debug> std::fmt::Debug for Mutex<T> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            std::fmt::Debug::fmt(&self.inner, f)
        }
    }

    impl<T: Unlock> Mutex<T> {
        pub(crate) fn new(value: T) -> Self {
            Self {
                inner: std::sync::Mutex::new(Inner {
                    last_lock_owner: VecDeque::new(),
                    value,
                }),
            }
        }

        /// Acquires the lock for a certain purpose
        ///
        /// The purpose will be recorded in the list of last lock owners
        pub(crate) fn lock(&self, purpose: &'static str) -> MutexGuard<'_, T> {
            // We don't bother dispatching through Runtime::now because they're pure performance
            // diagnostics.
            let now = Instant::now();
            let guard = acquire(&self.inner);

            let lock_time = Instant::now();
            let elapsed = lock_time.duration_since(now);

            if elapsed > Duration::from_millis(1) {
                warn!(
                    "Locking the connection for {} took {:?}. Last owners: {:?}",
                    purpose, elapsed, guard.last_lock_owner
                );
            }

            MutexGuard {
                guard,
                start_time: lock_time,
                purpose,
            }
        }

        /// Whether another holder has the lock right now. Tests only: a real
        /// caller could not act on the answer.
        #[cfg(test)]
        pub(crate) fn is_locked(&self) -> bool {
            matches!(
                self.inner.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            )
        }
    }

    pub(crate) struct MutexGuard<'a, T: Unlock> {
        guard: std::sync::MutexGuard<'a, Inner<T>>,
        start_time: Instant,
        purpose: &'static str,
    }

    impl<T: Unlock> Drop for MutexGuard<'_, T> {
        fn drop(&mut self) {
            release(&mut self.guard.value);
            if self.guard.last_lock_owner.len() == MAX_LOCK_OWNERS {
                self.guard.last_lock_owner.pop_back();
            }

            let duration = self.start_time.elapsed();

            if duration > Duration::from_millis(1) {
                warn!(
                    "Utilizing the connection for {} took {:?}",
                    self.purpose, duration
                );
            }

            self.guard
                .last_lock_owner
                .push_front((self.purpose, duration));
        }
    }

    impl<T: Unlock> Deref for MutexGuard<'_, T> {
        type Target = T;

        fn deref(&self) -> &Self::Target {
            &self.guard.value
        }
    }

    impl<T: Unlock> DerefMut for MutexGuard<'_, T> {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.guard.value
        }
    }

    const MAX_LOCK_OWNERS: usize = 20;
}

#[cfg(feature = "lock_tracking")]
pub(crate) use tracking::Mutex;

#[cfg(not(feature = "lock_tracking"))]
mod non_tracking {
    use super::*;

    /// A Mutex which optionally allows to track the time a lock was held and
    /// emit warnings in case of excessive lock times
    #[derive(Debug)]
    pub(crate) struct Mutex<T: Unlock> {
        inner: std::sync::Mutex<T>,
    }

    impl<T: Unlock> Mutex<T> {
        pub(crate) fn new(value: T) -> Self {
            Self {
                inner: std::sync::Mutex::new(value),
            }
        }

        /// Acquires the lock for a certain purpose
        ///
        /// The purpose will be recorded in the list of last lock owners
        pub(crate) fn lock(&self, _purpose: &'static str) -> MutexGuard<'_, T> {
            MutexGuard {
                guard: acquire(&self.inner),
            }
        }

        /// Whether another holder has the lock right now. Tests only: a real
        /// caller could not act on the answer.
        #[cfg(test)]
        pub(crate) fn is_locked(&self) -> bool {
            matches!(
                self.inner.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            )
        }
    }

    pub(crate) struct MutexGuard<'a, T: Unlock> {
        guard: std::sync::MutexGuard<'a, T>,
    }

    impl<T: Unlock> Drop for MutexGuard<'_, T> {
        fn drop(&mut self) {
            release(self.guard.deref_mut());
        }
    }

    impl<T: Unlock> Deref for MutexGuard<'_, T> {
        type Target = T;

        fn deref(&self) -> &Self::Target {
            self.guard.deref()
        }
    }

    impl<T: Unlock> DerefMut for MutexGuard<'_, T> {
        fn deref_mut(&mut self) -> &mut Self::Target {
            self.guard.deref_mut()
        }
    }
}

#[cfg(not(feature = "lock_tracking"))]
pub(crate) use non_tracking::Mutex;
