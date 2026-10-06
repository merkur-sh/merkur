//! Shared support for the edge profiling harnesses: allocation-request
//! counting and a loopback HTTP sink.
//!
//! The edge test binary already owns its `#[global_allocator]`
//! (`relay_ownership_tests`), and a binary can have only one. Every Rust
//! allocation it makes still reaches the platform `malloc`, so these harnesses
//! count at that layer instead: libmalloc calls `malloc_logger`, when set, for
//! every allocate, reallocate and free on every thread. Counting is gated to
//! one thread at a time, compared by `pthread_self`, so a runtime worker's own
//! traffic stays out of a measurement. The gate cannot be a Rust thread-local:
//! a new thread's first thread-local access allocates its block through this
//! same hook. macOS only.

use std::sync::Once;
use std::sync::atomic::{AtomicUsize, Ordering};

type Logger = unsafe extern "C" fn(u32, usize, usize, usize, usize, u32);

unsafe extern "C" {
    static mut malloc_logger: Option<Logger>;
    fn pthread_self() -> usize;
}

/// libmalloc's `MALLOC_LOG_TYPE_ALLOCATE` and `MALLOC_LOG_TYPE_DEALLOCATE`.
const LOG_ALLOCATE: u32 = 2;
const LOG_DEALLOCATE: u32 = 4;

/// `pthread_self` of the counted thread, or zero.
static COUNTED_THREAD: AtomicUsize = AtomicUsize::new(0);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);
static INSTALL: Once = Once::new();

unsafe extern "C" fn log(
    kind: u32,
    _zone: usize,
    size_or_old: usize,
    new_size: usize,
    _: usize,
    _: u32,
) {
    if kind & LOG_ALLOCATE == 0 {
        return;
    }
    let counted = COUNTED_THREAD.load(Ordering::Relaxed);
    // SAFETY: reads the calling thread's own handle; never allocates.
    if counted == 0 || counted != unsafe { pthread_self() } {
        return;
    }
    ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    // A reallocation logs allocate|deallocate with the new size third.
    let size = if kind & LOG_DEALLOCATE != 0 {
        new_size
    } else {
        size_or_old
    };
    ALLOCATED_BYTES.fetch_add(size, Ordering::Relaxed);
}

/// Requests and requested bytes counted so far on every opted-in thread.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub allocations: usize,
    pub bytes: usize,
}

impl std::ops::Sub for Tally {
    type Output = Tally;
    fn sub(self, earlier: Tally) -> Tally {
        Tally {
            allocations: self.allocations - earlier.allocations,
            bytes: self.bytes - earlier.bytes,
        }
    }
}

pub fn install() {
    INSTALL.call_once(|| {
        // SAFETY: libmalloc reads this pointer before each logged operation;
        // it is written once, before any measured work, and never cleared.
        unsafe { malloc_logger = Some(log) };
    });
}

/// Count allocations made on the calling thread from now on, and on no other.
pub fn count_this_thread(enabled: bool) {
    install();
    // SAFETY: the calling thread's own handle.
    let this = unsafe { pthread_self() };
    COUNTED_THREAD.store(if enabled { this } else { 0 }, Ordering::Relaxed);
}

pub fn snapshot() -> Tally {
    Tally {
        allocations: ALLOCATIONS.load(Ordering::Relaxed),
        bytes: ALLOCATED_BYTES.load(Ordering::Relaxed),
    }
}

/// Run `work` with this thread counted and return what it requested.
pub fn measured<T>(work: impl FnOnce() -> T) -> (T, Tally) {
    count_this_thread(true);
    let before = snapshot();
    let result = work();
    let after = snapshot();
    count_this_thread(false);
    (result, after - before)
}

/// A loopback HTTP/1.1 sink that answers every request `204`, keeping each
/// connection alive unless `close` is set. Returns its address and a counter of
/// the requests whose target is `path`. Requests are read to their full
/// `Content-Length`, and each is counted before its answer is written, so a
/// client that holds its answer has already been counted.
pub fn http_sink(
    close: bool,
    path: &'static str,
) -> (std::net::SocketAddr, std::sync::Arc<AtomicUsize>) {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind sink");
    let address = listener.local_addr().expect("sink address");
    let requests = std::sync::Arc::new(AtomicUsize::new(0));
    let counter = std::sync::Arc::clone(&requests);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let counter = std::sync::Arc::clone(&counter);
            std::thread::spawn(move || {
                let mut writer = stream.try_clone().expect("clone stream");
                let mut reader = BufReader::new(stream);
                loop {
                    let mut content_length = 0usize;
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    // The request line: `POST /v1/metrics HTTP/1.1`.
                    let counted = line.split(' ').nth(1) == Some(path);
                    loop {
                        line.clear();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let header = line.trim_end();
                        if header.is_empty() {
                            break;
                        }
                        if let Some((name, value)) = header.split_once(':')
                            && name.eq_ignore_ascii_case("content-length")
                        {
                            content_length = value.trim().parse().unwrap_or(0);
                        }
                    }
                    let mut body = vec![0u8; content_length];
                    if reader.read_exact(&mut body).is_err() {
                        return;
                    }
                    if counted {
                        counter.fetch_add(1, Ordering::Release);
                    }
                    let response: &[u8] = if close {
                        b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n"
                    } else {
                        b"HTTP/1.1 204 No Content\r\n\r\n"
                    };
                    if writer.write_all(response).is_err() {
                        return;
                    }
                    if close {
                        return;
                    }
                }
            });
        }
    });
    (address, requests)
}

pub fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index]
}

#[test]
#[ignore = "profiling harness self-check; run explicitly with --ignored"]
fn malloc_logger_counts_this_thread_only() {
    let (vectors, tally) = measured(|| {
        (0..10)
            .map(|index| vec![0u8; 100 + index])
            .collect::<Vec<Vec<u8>>>()
    });
    assert_eq!(vectors.len(), 10);
    // Ten payloads plus the collected vector's single exact-size allocation.
    assert_eq!(tally.allocations, 11);
    let other = std::thread::spawn(|| vec![0u8; 64]);
    let (_, idle) = measured(|| std::thread::sleep(std::time::Duration::from_millis(5)));
    assert_eq!(other.join().expect("join").len(), 64);
    assert_eq!(idle.allocations, 0);
}
