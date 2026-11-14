//! merkur-keyd: the keys the application server must use but must not hold.
//!
//! It holds the OPAQUE server setup, the ML-DSA-87 key that signs session
//! capabilities, and the web-push VAPID key, and performs a fixed set of
//! operations with them over a Unix socket (`wire`). The server, which parses
//! untrusted input, never sees a key byte; taken over, it can ask for an
//! operation, but cannot take a key away, and every password guess it asks
//! for spends the account's attempt budget (`budget`).
//!
//! It takes no arguments: its keys come from $CREDENTIALS_DIRECTORY, its attempt log lives in
//! $STATE_DIRECTORY, and it listens on $MERKUR_KEYD_SOCKET. Logs go to stderr; stdout carries
//! one line, `keyd: listening`, once it serves.

mod budget;
mod keys;
mod ops;
mod server;
mod wire;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();
    let result = if std::env::args().len() == 1 {
        serve()
    } else {
        Err("merkur-keyd takes no arguments".to_string())
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            tracing::error!("keyd: {message}");
            ExitCode::FAILURE
        }
    }
}

fn serve() -> Result<(), String> {
    harden()?;
    let credentials = required_path("CREDENTIALS_DIRECTORY")?;
    let state = required_path("STATE_DIRECTORY")?;
    let socket = required_path("MERKUR_KEYD_SOCKET")?;
    let keys = keys::load(&credentials).map_err(|error| error.to_string())?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "the clock is before 1970".to_string())?
        .as_millis();
    let budget = budget::Budget::open(
        &state.join("budget.log"),
        u64::try_from(now_ms).map_err(|_| "the clock is out of range".to_string())?,
    )
    .map_err(|error| format!("attempt log: {error}"))?;
    let service = Arc::new(ops::Service::new(keys, budget));
    server::serve(service, &socket).map_err(|error| format!("socket: {error}"))
}

fn required_path(name: &str) -> Result<PathBuf, String> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("{name} is not set"))
}

/// Before any key is read: no core file, and on Linux no ptrace or
/// /proc/<pid>/mem by the same user, and no page of this process swapped out.
fn harden() -> Result<(), String> {
    let none = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: setrlimit reads one initialized rlimit for the duration of the call.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) } != 0 {
        return Err(format!(
            "core dumps could not be disabled: {}",
            std::io::Error::last_os_error()
        ));
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: PR_SET_DUMPABLE takes one integer argument and touches no memory.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err(format!(
                "the process could not be made undumpable: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: mlockall takes flags only. ONFAULT locks pages as they are
        // touched, so idle thread stacks are not populated to be locked.
        if unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE | libc::MCL_ONFAULT) } != 0
        {
            return Err(format!(
                "memory could not be locked (raise LimitMEMLOCK): {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}
