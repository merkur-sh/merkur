//! NIC accounting and crash-conservative monthly reservations.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const CHUNK: u64 = 1 << 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u64)]
pub enum BudgetState {
    Open = 0,
    SignalingOnly = 1,
    Stopped = 2,
}

#[derive(Clone, Copy)]
pub struct BudgetConfig {
    data: u64,
    total: u64,
}

impl BudgetConfig {
    pub fn from_values(data: Option<String>, reserve: Option<String>) -> Result<Self, String> {
        fn bytes(value: Option<String>, name: &str) -> Result<u64, String> {
            value
                .and_then(|s| {
                    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                        return None;
                    }
                    s.parse::<u64>().ok()?.checked_mul(CHUNK)
                })
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    format!("{name} must be a positive integer GiB budget fitting u64 bytes")
                })
        }
        let data = bytes(data, "MERKUR_EDGE_DATA_BUDGET_GB")?;
        let reserve = bytes(reserve, "MERKUR_EDGE_SIGNALING_RESERVE_GB")?;
        let total = data
            .checked_add(reserve)
            .ok_or("combined egress budget overflows u64 bytes")?;
        Ok(Self { data, total })
    }

    fn state(self, used: u64) -> BudgetState {
        if used >= self.total {
            BudgetState::Stopped
        } else if used >= self.data {
            BudgetState::SignalingOnly
        } else {
            BudgetState::Open
        }
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    month: String,
    reserved: u64,
}

impl Ledger {
    fn persist(&self, dir: &Path) -> io::Result<()> {
        let temp = dir.join("egress-ledger.tmp");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)?;
        serde_json::to_writer(&mut file, self)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(temp, dir.join("egress-ledger"))?;
        File::open(dir)?.sync_all()
    }

    fn validate(&self) -> io::Result<()> {
        let bytes = self.month.as_bytes();
        if self.version != 1
            || bytes.len() != 7
            || bytes[4] != b'-'
            || !bytes[..4].iter().all(u8::is_ascii_digit)
            || !matches!(
                &self.month[5..],
                "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
            )
            || !self.reserved.is_multiple_of(CHUNK)
        {
            return Err(io::Error::other("invalid egress ledger"));
        }
        Ok(())
    }
}

pub trait CounterSource {
    fn tx_bytes(&mut self) -> io::Result<u64>;
}

pub struct NicCounter {
    interface: String,
}

impl NicCounter {
    pub fn new(interface: Option<String>) -> io::Result<Self> {
        let interface = interface
            .filter(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            })
            .ok_or_else(|| {
                io::Error::other(
                    "MERKUR_EDGE_EGRESS_INTERFACE is required and must name an interface",
                )
            })?;
        let mut source = Self { interface };
        source.tx_bytes()?;
        Ok(source)
    }
}

impl CounterSource for NicCounter {
    #[cfg(target_os = "linux")]
    fn tx_bytes(&mut self) -> io::Result<u64> {
        fs::read_to_string(format!(
            "/sys/class/net/{}/statistics/tx_bytes",
            self.interface
        ))?
        .trim()
        .parse()
        .map_err(io::Error::other)
    }

    #[cfg(target_os = "macos")]
    fn tx_bytes(&mut self) -> io::Result<u64> {
        let name = std::ffi::CString::new(self.interface.as_str())?;
        // SAFETY: the interface name is NUL terminated and lives through the call.
        let index = unsafe { libc::if_nametoindex(name.as_ptr()) };
        if index == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut mib = [
            libc::CTL_NET,
            libc::PF_ROUTE,
            0,
            0,
            libc::NET_RT_IFLIST2,
            index as i32,
        ];
        let mut len = 0;
        // SAFETY: valid MIB and length output; null data asks for its size.
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                6,
                std::ptr::null_mut(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut bytes = vec![0u8; len];
        // SAFETY: the buffer has the capacity requested by sysctl. A changed
        // interface list returns an error, never a guessed or truncated count.
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                6,
                bytes.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        bytes.truncate(len);
        let mut rest = bytes.as_slice();
        while rest.len() >= 4 {
            let size = u16::from_ne_bytes([rest[0], rest[1]]) as usize;
            if size < 4 || size > rest.len() {
                return Err(io::Error::other("invalid interface counter record"));
            }
            if rest[3] == libc::RTM_IFINFO2 as u8 && size >= size_of::<libc::if_msghdr2>() {
                // SAFETY: size checked above; routing records need not be aligned.
                let header = unsafe { rest.as_ptr().cast::<libc::if_msghdr2>().read_unaligned() };
                if u32::from(header.ifm_index) == index {
                    return Ok(header.ifm_data.ifi_obytes);
                }
            }
            rest = &rest[size..];
        }
        Err(io::Error::other("interface has no 64-bit transmit counter"))
    }
}

pub fn utc_month() -> io::Result<String> {
    let seconds: libc::time_t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs()
        .try_into()
        .map_err(io::Error::other)?;
    let mut date = std::mem::MaybeUninit::<libc::tm>::uninit();
    // SAFETY: both pointers are valid; gmtime_r initializes the output on success.
    if unsafe { libc::gmtime_r(&seconds, date.as_mut_ptr()) }.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `gmtime_r` returned non-null, which is its report that it filled
    // the whole `tm` it was given.
    let date = unsafe { date.assume_init() };
    Ok(format!("{:04}-{:02}", date.tm_year + 1900, date.tm_mon + 1))
}

pub struct EgressBudget<C> {
    config: BudgetConfig,
    dir: PathBuf,
    ledger: Ledger,
    used: u64,
    previous: u64,
    counter: C,
    _lock: File,
}

impl<C: CounterSource> EgressBudget<C> {
    pub fn load(
        dir: &Path,
        config: BudgetConfig,
        mut counter: C,
        month: String,
    ) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("egress-ledger.lock"))?;
        lock.try_lock().map_err(io::Error::other)?;
        let ledger = match fs::read(dir.join("egress-ledger")) {
            Ok(bytes) => {
                let ledger: Ledger = serde_json::from_slice(&bytes)?;
                ledger.validate()?;
                ledger
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let ledger = Ledger {
                    version: 1,
                    month: month.clone(),
                    reserved: 0,
                };
                ledger.persist(dir)?;
                tracing::warn!(
                    event = "egress_ledger_initialized",
                    "edge: missing egress ledger initialized"
                );
                crate::metrics::record_egress_ledger_initialized();
                ledger
            }
            Err(error) => return Err(error),
        };
        let previous = counter.tx_bytes()?;
        let mut budget = Self {
            config,
            dir: dir.to_owned(),
            used: ledger.reserved,
            ledger,
            previous,
            counter,
            _lock: lock,
        };
        budget.roll_month(month)?;
        budget.reserve(budget.used)?;
        budget.publish_metrics();
        Ok(budget)
    }

    fn roll_month(&mut self, month: String) -> io::Result<()> {
        if month < self.ledger.month {
            return Err(io::Error::other("UTC month precedes egress ledger"));
        }
        if month != self.ledger.month {
            let ledger = Ledger {
                version: 1,
                month,
                reserved: 0,
            };
            ledger.validate()?;
            ledger.persist(&self.dir)?;
            self.ledger = ledger;
            self.used = 0;
        }
        Ok(())
    }

    fn reserve(&mut self, used: u64) -> io::Result<()> {
        while used >= self.ledger.reserved && self.ledger.reserved < self.config.total {
            let ledger = Ledger {
                version: 1,
                month: self.ledger.month.clone(),
                reserved: self.ledger.reserved + CHUNK,
            };
            ledger.persist(&self.dir)?;
            self.ledger = ledger;
        }
        Ok(())
    }

    pub fn sample(&mut self, month: String) -> io::Result<BudgetState> {
        let current = self.counter.tx_bytes()?;
        // A decreasing 64-bit counter means the interface was reset. The new
        // counter is exactly the bytes transmitted since that reset, not wrap.
        let delta = current.checked_sub(self.previous).unwrap_or(current);
        self.roll_month(month)?;
        // Charge the boundary-straddling sample to the new month in full. We
        // cannot split a NIC observation at a wall-clock instant it did not record.
        let used = self
            .used
            .checked_add(delta)
            .ok_or_else(|| io::Error::other("egress usage overflow"))?;
        // This is sampled enforcement: the NIC reports bytes already emitted.
        // Persist before publishing an extended reservation, never claim an
        // exact wire-byte cap between samples (or while the sampler is stalled).
        self.reserve(used)?;
        self.used = used;
        self.previous = current;
        self.publish_metrics();
        Ok(self.state())
    }

    pub fn state(&self) -> BudgetState {
        self.config.state(self.used)
    }

    fn publish_metrics(&self) {
        crate::metrics::publish_egress(self.used, self.ledger.reserved, self.state() as u64);
    }
}

/// Filesystem durability runs outside Tokio's relay workers. The process owns
/// this thread until exit; an unreadable counter or unwritable ledger is fatal.
pub fn spawn_sampler(
    mut budget: EgressBudget<NicCounter>,
    state: tokio::sync::watch::Sender<BudgetState>,
) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            match utc_month().and_then(|month| budget.sample(month)) {
                Ok(next) => {
                    state.send_if_modified(|current| {
                        if *current == next {
                            return false;
                        }
                        *current = next;
                        true
                    });
                }
                Err(error) => {
                    state.send_replace(BudgetState::Stopped);
                    crate::metrics::publish_egress(
                        budget.used,
                        budget.ledger.reserved,
                        BudgetState::Stopped as u64,
                    );
                    tracing::error!(%error, "edge: egress accounting failed; stopping");
                    std::process::exit(1);
                }
            }
        }
    });
}

#[cfg(test)]
pub fn test_open_budget() -> tokio::sync::watch::Receiver<BudgetState> {
    static OPEN: std::sync::LazyLock<tokio::sync::watch::Sender<BudgetState>> =
        std::sync::LazyLock::new(|| tokio::sync::watch::channel(BudgetState::Open).0);
    OPEN.subscribe()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "merkur-egress-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).expect("unique test directory");
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove test directory");
        }
    }
    #[derive(Clone, Default)]
    struct FakeCounter(Arc<AtomicU64>);
    impl CounterSource for FakeCounter {
        fn tx_bytes(&mut self) -> io::Result<u64> {
            Ok(self.0.load(Ordering::Relaxed))
        }
    }
    fn config() -> BudgetConfig {
        BudgetConfig {
            data: 3 * CHUNK,
            total: 5 * CHUNK,
        }
    }
    fn load(dir: &TempDir) -> EgressBudget<FakeCounter> {
        EgressBudget::load(&dir.0, config(), FakeCounter::default(), "2026-09".into()).unwrap()
    }

    #[test]
    fn ledger_round_trip_and_missing_initialization() {
        let dir = TempDir::new();
        let budget = load(&dir);
        assert_eq!(budget.used, 0);
        let stored: Ledger =
            serde_json::from_slice(&fs::read(dir.0.join("egress-ledger")).unwrap()).unwrap();
        assert_eq!(stored, budget.ledger);
        assert_eq!(stored.reserved, CHUNK);
    }

    #[test]
    fn crash_forfeits_outstanding_reservation() {
        let dir = TempDir::new();
        drop(load(&dir));
        let budget = load(&dir);
        assert_eq!(budget.used, CHUNK);
        assert_eq!(budget.ledger.reserved, 2 * CHUNK);
        drop(budget);
        assert_eq!(load(&dir).used, 2 * CHUNK);
    }

    #[test]
    fn corrupt_ledger_refuses() {
        let dir = TempDir::new();
        for body in [
            "broken",
            r#"{"version":2,"month":"2026-09","reserved":0}"#,
            r#"{"version":1,"month":"2026-99","reserved":0}"#,
        ] {
            fs::write(dir.0.join("egress-ledger"), body).unwrap();
            assert!(
                EgressBudget::load(&dir.0, config(), FakeCounter::default(), "2026-09".into())
                    .is_err()
            );
        }
    }

    #[test]
    fn month_rollover_resets_durably_and_backward_clock_refuses() {
        let dir = TempDir::new();
        drop(load(&dir));
        let mut budget = load(&dir);
        budget.roll_month("2026-10".into()).unwrap();
        assert_eq!(budget.used, 0);
        assert_eq!(budget.ledger.reserved, 0);
        let stored: Ledger =
            serde_json::from_slice(&fs::read(dir.0.join("egress-ledger")).unwrap()).unwrap();
        assert_eq!(stored, budget.ledger);
        assert!(budget.roll_month("2026-09".into()).is_err());
    }

    #[test]
    fn thresholds_and_config_validation() {
        assert_eq!(config().state(3 * CHUNK - 1), BudgetState::Open);
        assert_eq!(config().state(3 * CHUNK), BudgetState::SignalingOnly);
        assert_eq!(config().state(5 * CHUNK - 1), BudgetState::SignalingOnly);
        assert_eq!(config().state(5 * CHUNK), BudgetState::Stopped);
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("-1"),
            Some("1.5"),
            Some("18446744073709551615"),
        ] {
            assert!(BudgetConfig::from_values(value.map(str::to_owned), Some("1".into())).is_err());
            assert!(BudgetConfig::from_values(Some("1".into()), value.map(str::to_owned)).is_err());
        }
        assert!(BudgetConfig::from_values(Some("2400".into()), Some("100".into())).is_ok());
    }

    #[test]
    fn persist_failure_does_not_extend_reservation() {
        let dir = TempDir::new();
        let mut budget = load(&dir);
        budget.used = CHUNK;
        fs::create_dir(dir.0.join("egress-ledger.tmp")).unwrap();
        assert!(budget.reserve(budget.used).is_err());
        assert_eq!(budget.ledger.reserved, CHUNK);
        fs::remove_dir(dir.0.join("egress-ledger.tmp")).unwrap();
        budget.reserve(budget.used).unwrap();
        let stored: Ledger =
            serde_json::from_slice(&fs::read(dir.0.join("egress-ledger")).unwrap()).unwrap();
        assert_eq!(stored.reserved, 2 * CHUNK);
        assert_eq!(budget.ledger, stored);
    }

    #[test]
    fn ledger_has_one_owner() {
        let dir = TempDir::new();
        let _owner = load(&dir);
        assert!(
            EgressBudget::load(&dir.0, config(), FakeCounter::default(), "2026-09".into()).is_err()
        );
    }

    #[test]
    fn counter_reset_and_rollover_charge_exact_observed_deltas() {
        let dir = TempDir::new();
        let counter = FakeCounter::default();
        counter.0.store(100, Ordering::Relaxed);
        let mut budget =
            EgressBudget::load(&dir.0, config(), counter.clone(), "2026-09".into()).unwrap();
        counter.0.store(140, Ordering::Relaxed);
        budget.sample("2026-09".into()).unwrap();
        assert_eq!(budget.used, 40);
        counter.0.store(7, Ordering::Relaxed);
        budget.sample("2026-09".into()).unwrap();
        assert_eq!(budget.used, 47);
        counter.0.store(17, Ordering::Relaxed);
        budget.sample("2026-10".into()).unwrap();
        assert_eq!(budget.used, 10);
        assert_eq!(budget.ledger.month, "2026-10");
        assert_eq!(budget.ledger.reserved, CHUNK);
    }

    #[test]
    fn reads_native_64_bit_loopback_counter() {
        let interface = if cfg!(target_os = "macos") {
            "lo0"
        } else {
            "lo"
        };
        NicCounter::new(Some(interface.into()))
            .unwrap()
            .tx_bytes()
            .unwrap();
        assert!(NicCounter::new(Some("merkur-no-such-nic".into())).is_err());
    }
}
