//! Each account's password-attempt budget, which keyd keeps itself.
//!
//! Every OPRF evaluation under an account's key is a password guess to whoever
//! holds the reply, so keyd spends one attempt before it answers one, whatever
//! the caller says. A verified sign-in hands its attempt back. Nothing the
//! application server can write (Redis, the database) feeds this: the budget
//! must hold against a server that has been taken over.
//!
//! Attempts are appended to a log and fsynced before the reply leaves, and the
//! log is replayed at start, so neither a restart nor a crash resets a count.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use ring::digest;

/// Attempts one account may take in any minute. Owner policy; matches the
/// application server's per-name sign-in limit.
pub const MINUTE_LIMIT: usize = 10;
pub const MINUTE_MS: u64 = 60_000;
/// Attempts one account may take and not hand back in any 24 hours. Owner policy.
pub const DAY_LIMIT: usize = 20;
pub const DAY_MS: u64 = 86_400_000;
/// Resource bound: accounts tracked at once. Any name costs an entry, so a
/// spray of made-up names could otherwise grow this without limit. At the
/// bound a new name is refused, never an old entry evicted: eviction would
/// hand a caller a way to reset an account's count.
pub const MAX_TRACKED_ACCOUNTS: usize = 1 << 20;

const KEY_BYTES: usize = 16;
const RECORD_BYTES: usize = 1 + KEY_BYTES + 8;
const SPEND: u8 = 1;
const REFUND: u8 = 2;
/// Resource bound on the log between compactions: appended records beyond
/// four times what is live, with a floor so a quiet log is not rewritten often.
const COMPACTION_FLOOR: usize = 65_536;

type AccountKey = [u8; KEY_BYTES];

#[derive(Clone, Copy)]
struct Attempt {
    at_ms: u64,
    refunded: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Admitted,
    Exhausted { retry_after_ms: u64 },
}

pub struct Budget {
    accounts: HashMap<AccountKey, VecDeque<Attempt>>,
    path: PathBuf,
    log: File,
    appended: usize,
}

impl Budget {
    /// Replays the log at `path`, then rewrites it holding only what is live.
    /// A torn final record (a crash mid-append) is dropped; any other damage
    /// refuses to start, since a budget read wrong is a budget reset.
    pub fn open(path: &Path, now_ms: u64) -> io::Result<Self> {
        let mut accounts = HashMap::new();
        match File::open(path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                for record in bytes.as_chunks::<RECORD_BYTES>().0 {
                    let (kind, key, at_ms) = parse_record(record)?;
                    match kind {
                        SPEND => spend_into(&mut accounts, key, at_ms),
                        REFUND => refund_into(&mut accounts, key, at_ms),
                        _ => unreachable!("parse_record admits only the two kinds"),
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        accounts.retain(|_, attempts| {
            prune(attempts, now_ms);
            !attempts.is_empty()
        });
        let log = write_compacted(path, &accounts)?;
        Ok(Self {
            accounts,
            path: path.to_path_buf(),
            log,
            appended: 0,
        })
    }

    /// Spends one attempt for `user_id`, durably, or says when one frees up.
    pub fn spend(&mut self, user_id: &str, now_ms: u64) -> io::Result<Admission> {
        let key = account_key(user_id);
        if let Some(attempts) = self.accounts.get_mut(&key) {
            prune(attempts, now_ms);
            if let Some(retry_after_ms) = exhausted(attempts, now_ms) {
                return Ok(Admission::Exhausted { retry_after_ms });
            }
        } else if self.accounts.len() >= MAX_TRACKED_ACCOUNTS {
            self.accounts.retain(|_, attempts| {
                prune(attempts, now_ms);
                !attempts.is_empty()
            });
            if self.accounts.len() >= MAX_TRACKED_ACCOUNTS {
                return Ok(Admission::Exhausted {
                    retry_after_ms: MINUTE_MS,
                });
            }
        }
        self.append(SPEND, &key, now_ms)?;
        spend_into(&mut self.accounts, key, now_ms);
        Ok(Admission::Admitted)
    }

    /// Hands back the account's newest attempt not yet handed back.
    pub fn refund(&mut self, user_id: &str, now_ms: u64) -> io::Result<()> {
        let key = account_key(user_id);
        let held = self
            .accounts
            .get(&key)
            .is_some_and(|attempts| attempts.iter().any(|attempt| !attempt.refunded));
        if !held {
            return Ok(());
        }
        self.append(REFUND, &key, now_ms)?;
        refund_into(&mut self.accounts, key, now_ms);
        Ok(())
    }

    fn append(&mut self, kind: u8, key: &AccountKey, at_ms: u64) -> io::Result<()> {
        let mut record = [0u8; RECORD_BYTES];
        record[0] = kind;
        record[1..1 + KEY_BYTES].copy_from_slice(key);
        record[1 + KEY_BYTES..].copy_from_slice(&at_ms.to_le_bytes());
        self.log.write_all(&record)?;
        self.log.sync_data()?;
        self.appended += 1;
        let live: usize = self.accounts.values().map(VecDeque::len).sum();
        if self.appended > COMPACTION_FLOOR.max(live.saturating_mul(4)) {
            self.accounts.retain(|_, attempts| {
                prune(attempts, at_ms);
                !attempts.is_empty()
            });
            self.log = write_compacted(&self.path, &self.accounts)?;
            self.appended = 0;
        }
        Ok(())
    }
}

/// A domain-separated digest of the user id, so the log does not spell out account ids.
fn account_key(user_id: &str) -> AccountKey {
    let mut context = digest::Context::new(&digest::SHA256);
    context.update(b"merkur-keyd-budget\0");
    context.update(user_id.as_bytes());
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&context.finish().as_ref()[..KEY_BYTES]);
    key
}

fn spend_into(accounts: &mut HashMap<AccountKey, VecDeque<Attempt>>, key: AccountKey, at_ms: u64) {
    let attempts = accounts.entry(key).or_default();
    prune(attempts, at_ms);
    attempts.push_back(Attempt {
        at_ms,
        refunded: false,
    });
}

fn refund_into(accounts: &mut HashMap<AccountKey, VecDeque<Attempt>>, key: AccountKey, at_ms: u64) {
    if let Some(attempts) = accounts.get_mut(&key) {
        prune(attempts, at_ms);
        if let Some(attempt) = attempts.iter_mut().rev().find(|attempt| !attempt.refunded) {
            attempt.refunded = true;
        }
    }
}

/// Drops what no window still counts: a handed-back attempt after a minute,
/// any attempt after a day. A clock that stepped back keeps everything.
fn prune(attempts: &mut VecDeque<Attempt>, now_ms: u64) {
    attempts.retain(|attempt| {
        let age = now_ms.saturating_sub(attempt.at_ms);
        age < if attempt.refunded { MINUTE_MS } else { DAY_MS }
    });
}

/// When the next attempt is allowed, if not now.
fn exhausted(attempts: &VecDeque<Attempt>, now_ms: u64) -> Option<u64> {
    let in_minute = attempts
        .iter()
        .filter(|attempt| now_ms.saturating_sub(attempt.at_ms) < MINUTE_MS);
    let minute = (in_minute.clone().count() >= MINUTE_LIMIT)
        .then(|| in_minute.map(|attempt| attempt.at_ms).min())
        .flatten()
        .map(|oldest| (oldest + MINUTE_MS).saturating_sub(now_ms));
    let held = attempts.iter().filter(|attempt| !attempt.refunded);
    let day = (held.clone().count() >= DAY_LIMIT)
        .then(|| held.map(|attempt| attempt.at_ms).min())
        .flatten()
        .map(|oldest| (oldest + DAY_MS).saturating_sub(now_ms));
    match (minute, day) {
        (None, None) => None,
        (minute, day) => Some(minute.unwrap_or(0).max(day.unwrap_or(0)).max(1)),
    }
}

fn parse_record(record: &[u8; RECORD_BYTES]) -> io::Result<(u8, AccountKey, u64)> {
    let kind = record[0];
    if kind != SPEND && kind != REFUND {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "attempt log holds an unknown record",
        ));
    }
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&record[1..1 + KEY_BYTES]);
    let mut at = [0u8; 8];
    at.copy_from_slice(&record[1 + KEY_BYTES..]);
    Ok((kind, key, u64::from_le_bytes(at)))
}

/// Writes the live attempts beside the log, fsyncs, renames over it, fsyncs the
/// directory, and returns the new log open for appending.
fn write_compacted(
    path: &Path,
    accounts: &HashMap<AccountKey, VecDeque<Attempt>>,
) -> io::Result<File> {
    let staged = path.with_extension("log.new");
    let mut bytes = Vec::new();
    for (key, attempts) in accounts {
        for attempt in attempts {
            for kind in [SPEND, REFUND] {
                if kind == REFUND && !attempt.refunded {
                    continue;
                }
                bytes.push(kind);
                bytes.extend_from_slice(key);
                bytes.extend_from_slice(&attempt.at_ms.to_le_bytes());
            }
        }
    }
    {
        let mut file = File::create(&staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&staged, path)?;
    if let Some(directory) = path.parent() {
        File::open(directory)?.sync_all()?;
    }
    OpenOptions::new().append(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("merkur-keyd-budget-{name}-{}", std::process::id()));
            if dir.exists() {
                fs::remove_dir_all(&dir).unwrap();
            }
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn log(&self) -> PathBuf {
            self.0.join("budget.log")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove the test's scratch directory");
        }
    }

    const T0: u64 = 1_800_000_000_000;

    #[test]
    fn the_eleventh_attempt_in_a_minute_waits_for_the_oldest() {
        let scratch = Scratch::new("minute");
        let mut budget = Budget::open(&scratch.log(), T0).unwrap();
        for i in 0..MINUTE_LIMIT as u64 {
            assert_eq!(budget.spend("user", T0 + i).unwrap(), Admission::Admitted);
            budget.refund("user", T0 + i).unwrap();
        }
        assert_eq!(
            budget.spend("user", T0 + 100).unwrap(),
            Admission::Exhausted {
                retry_after_ms: MINUTE_MS - 100
            }
        );
        assert_eq!(
            budget.spend("other", T0 + 100).unwrap(),
            Admission::Admitted
        );
        assert_eq!(
            budget.spend("user", T0 + MINUTE_MS).unwrap(),
            Admission::Admitted
        );
    }

    #[test]
    fn twenty_failures_hold_the_account_for_a_day_and_a_success_hands_one_back() {
        let scratch = Scratch::new("day");
        let mut budget = Budget::open(&scratch.log(), T0).unwrap();
        for i in 0..DAY_LIMIT as u64 {
            let at = T0 + i * MINUTE_MS;
            assert_eq!(budget.spend("user", at).unwrap(), Admission::Admitted);
        }
        let later = T0 + DAY_LIMIT as u64 * MINUTE_MS;
        assert_eq!(
            budget.spend("user", later).unwrap(),
            Admission::Exhausted {
                retry_after_ms: T0 + DAY_MS - later
            }
        );
        budget.refund("user", later).unwrap();
        assert_eq!(budget.spend("user", later).unwrap(), Admission::Admitted);
    }

    #[test]
    fn a_restart_replays_the_count() {
        let scratch = Scratch::new("replay");
        {
            let mut budget = Budget::open(&scratch.log(), T0).unwrap();
            for i in 0..DAY_LIMIT as u64 {
                budget.spend("user", T0 + i * MINUTE_MS).unwrap();
            }
            budget
                .refund("user", T0 + DAY_LIMIT as u64 * MINUTE_MS)
                .unwrap();
        }
        let later = T0 + DAY_LIMIT as u64 * MINUTE_MS + 1;
        let mut budget = Budget::open(&scratch.log(), later).unwrap();
        assert_eq!(budget.spend("user", later).unwrap(), Admission::Admitted);
        assert!(matches!(
            budget.spend("user", later + 1).unwrap(),
            Admission::Exhausted { .. }
        ));
        drop(budget);
        let budget = Budget::open(&scratch.log(), T0 + DAY_MS + DAY_MS).unwrap();
        assert!(budget.accounts.is_empty(), "a day later nothing is held");
    }

    #[test]
    fn a_torn_final_record_is_dropped_and_other_damage_refuses_to_start() {
        let scratch = Scratch::new("torn");
        {
            let mut budget = Budget::open(&scratch.log(), T0).unwrap();
            budget.spend("user", T0).unwrap();
        }
        OpenOptions::new()
            .append(true)
            .open(scratch.log())
            .unwrap()
            .write_all(&[SPEND, 1, 2])
            .unwrap();
        let budget = Budget::open(&scratch.log(), T0 + 1).unwrap();
        assert_eq!(budget.accounts.len(), 1);
        drop(budget);
        let mut bytes = fs::read(scratch.log()).unwrap();
        bytes[0] = 9;
        fs::write(scratch.log(), bytes).unwrap();
        assert!(Budget::open(&scratch.log(), T0 + 2).is_err());
    }

    #[test]
    fn a_refund_without_a_held_attempt_writes_nothing() {
        let scratch = Scratch::new("refund");
        let mut budget = Budget::open(&scratch.log(), T0).unwrap();
        budget.refund("user", T0).unwrap();
        assert_eq!(fs::metadata(scratch.log()).unwrap().len(), 0);
    }
}
