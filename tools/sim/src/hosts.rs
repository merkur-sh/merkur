//! Which simulated host the running code belongs to. turmoil gives each host
//! its own tokio runtime but no public way to ask which one is running, and a
//! socket bound to the wildcard address learns its host only as it sends. A
//! host registers its runtime as it boots; a socket reads its host at bind.

use std::net::IpAddr;
use std::sync::Mutex;

use tokio::runtime::{Handle, Id};

static HOSTS: Mutex<Vec<(Id, IpAddr)>> = Mutex::new(Vec::new());
/// Endpoints bound per host: every dial binds one, so a client's count is its
/// dials.
static BINDS: Mutex<Vec<(IpAddr, u64)>> = Mutex::new(Vec::new());

/// Marks the current runtime as host `name`'s. Each boot of a host gets a new
/// runtime, so a host registers on every boot.
pub fn register(name: &str) {
    let id = Handle::current().id();
    let address = turmoil::lookup(name);
    let mut hosts = HOSTS.lock().expect("host registry");
    hosts.retain(|(registered, _)| *registered != id);
    hosts.push((id, address));
}

/// The address of the host whose runtime is running, if it registered.
pub(crate) fn current() -> Option<IpAddr> {
    let id = Handle::try_current().ok()?.id();
    HOSTS
        .lock()
        .expect("host registry")
        .iter()
        .find(|(registered, _)| *registered == id)
        .map(|(_, address)| *address)
}

/// Records one endpoint bound on `host`.
pub(crate) fn bound(host: Option<IpAddr>) {
    let Some(host) = host else { return };
    let mut binds = BINDS.lock().expect("bind count");
    match binds.iter_mut().find(|(bound, _)| *bound == host) {
        Some((_, count)) => *count += 1,
        None => binds.push((host, 1)),
    }
}

/// Endpoints host `name` has bound in this run.
pub fn binds(name: &str) -> u64 {
    let host = turmoil::lookup(name);
    BINDS
        .lock()
        .expect("bind count")
        .iter()
        .find(|(bound, _)| *bound == host)
        .map_or(0, |(_, count)| *count)
}

pub(crate) fn reset() {
    HOSTS.lock().expect("host registry").clear();
    BINDS.lock().expect("bind count").clear();
}
