//! The run's datagram trace: every send as (simulated time, source,
//! destination, length), folded into one hash, so two runs of one seed can be
//! compared exactly.

use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// FNV-1a: fixed, unseeded and order-sensitive, unlike `std`'s hasher.
struct Fnv(u64);

impl Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0 ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Summary {
    pub datagrams: u64,
    pub hash: u64,
}

static TRACE: Mutex<Option<(u64, Fnv)>> = Mutex::new(None);

/// Runs started in this process; names each run's dump file.
static RUNS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn start() {
    RUNS.fetch_add(1, Ordering::Relaxed);
    *TRACE.lock().expect("trace lock") = Some((0, Fnv(0xcbf2_9ce4_8422_2325)));
}

pub(crate) fn finish() -> Summary {
    let (datagrams, hash) = TRACE
        .lock()
        .expect("trace lock")
        .take()
        .expect("a started trace");
    Summary {
        datagrams,
        hash: hash.finish(),
    }
}

pub(crate) fn sent(source: SocketAddr, destination: SocketAddr, len: usize) {
    let at = turmoil::sim_elapsed().unwrap_or_default();
    if let Some((datagrams, hash)) = TRACE.lock().expect("trace lock").as_mut() {
        *datagrams += 1;
        at.as_nanos().hash(hash);
        source.hash(hash);
        destination.hash(hash);
        len.hash(hash);
        // `MERKUR_SIM_TRACE=<dir>` writes every datagram, to diff two runs.
        if let Some(directory) = std::env::var_os("MERKUR_SIM_TRACE") {
            let run = RUNS.load(Ordering::Relaxed);
            let path = Path::new(&directory).join(format!("run-{run:03}.trace"));
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .expect("a trace file");
            writeln!(file, "{} {source} {destination} {len}", at.as_nanos()).expect("a trace line");
        }
    }
}
