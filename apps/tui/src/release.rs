//! The terminal client runs exactly its server's release, as the daemon does: a client of
//! another release cannot read what that server's machines send (docs/releases.md,
//! Convergence). It learns the release from the server before it signs in or dials a session,
//! while a stored account's machine list loads, has the install converge with `merkur update`
//! beside it, and replaces itself with the converged client.

use std::io;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;

use merkur_client_native::account::Account;

/// This build's release: the tag a release build stamps, or `dev` from source.
pub fn own_release() -> &'static str {
    option_env!("MERKUR_VERSION").unwrap_or("dev")
}

/// A release check in flight, beside the account's other first requests.
pub type Check = tokio::task::JoinHandle<io::Result<Option<PathBuf>>>;

/// Starts [`converged_client`] at once. A stored account opens its machine list while it
/// runs, and no session dials before it answers.
pub fn check(account: &std::sync::Arc<Account>) -> Check {
    let account = std::sync::Arc::clone(account);
    tokio::spawn(async move { converged_client(&account).await })
}

/// The client of the server's release, when it is not this one: installed first, through the
/// `merkur update` of this install. `None` when this client is the server's release.
pub async fn converged_client(account: &Account) -> io::Result<Option<PathBuf>> {
    let own = own_release();
    if own == "dev" {
        return Ok(None);
    }
    let release = account
        .release()
        .await
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    if release == own {
        return Ok(None);
    }
    let executable = std::env::current_exe()?.canonicalize()?;
    let version_directory = executable
        .parent()
        .ok_or_else(|| io::Error::other("the client has no install directory"))?;
    let install_root = version_directory
        .parent()
        .filter(|versions| versions.file_name().is_some_and(|name| name == "versions"))
        .and_then(|versions| versions.parent())
        .ok_or_else(|| outdated(own, &release))?;
    let updated = tokio::process::Command::new(version_directory.join("merkur"))
        .arg("update")
        .status()
        .await?;
    let successor = install_root
        .join("current")
        .join("merkur-tui")
        .canonicalize()?;
    let successor_release = successor
        .parent()
        .and_then(|directory| directory.file_name())
        .and_then(|name| name.to_str());
    if !updated.success() || successor_release != Some(release.as_str()) {
        return Err(outdated(own, &release));
    }
    Ok(Some(successor))
}

/// Replaces this process with `successor`, keeping the arguments. Returns only on failure.
pub fn replace(successor: &PathBuf) -> io::Error {
    std::process::Command::new(successor)
        .args(std::env::args_os().skip(1))
        .exec()
}

fn outdated(own: &str, release: &str) -> io::Error {
    io::Error::other(format!(
        "this client is {own} and the server runs {release}; run `merkur update`"
    ))
}
