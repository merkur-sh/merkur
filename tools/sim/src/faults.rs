//! Faults below quinn that turmoil's link controls cannot express: a host's
//! outbound datagrams lost from an exact packet onward, and a NAT that rebinds
//! a host's mappings. Sweeping the lost packet over an exchange kills a carrier
//! at every boundary of it; [`count`] measures how many boundaries an exchange
//! has.
//!
//! The plan is process-wide, like the trace, and every run starts without one.

use std::net::IpAddr;
use std::sync::Mutex;

use tokio::sync::Notify;

struct Cut {
    host: IpAddr,
    /// Datagrams the host may still send before the cut takes effect.
    remaining: u64,
}

static CUT: Mutex<Option<Cut>> = Mutex::new(None);
/// The probability that any datagram is lost on its way, independently, drawn
/// from the run's entropy so a seed loses the same datagrams every time.
static LOSS: Mutex<f64> = Mutex::new(0.0);
/// The host whose sent datagrams are being counted, and the count.
static COUNT: Mutex<Option<(IpAddr, u64)>> = Mutex::new(None);
/// How many times each host's NAT has rebound its mappings.
static NAT_REBINDS: Mutex<Vec<(IpAddr, u64)>> = Mutex::new(Vec::new());
/// Wakes every socket waiting to receive when a NAT rebinds, so one waiting on
/// a port its NAT no longer maps moves to its new one.
static NAT_REBOUND: Notify = Notify::const_new();

/// `host`'s NAT drops every mapping it holds: datagrams to the ports it had
/// mapped are lost, and each of the host's sockets sends and receives on a new
/// port from now on, as the next packet through such a NAT is mapped afresh.
/// The host's own sockets see no change.
pub fn rebind_nat(host: &str) {
    let host = turmoil::lookup(host);
    let mut rebinds = NAT_REBINDS.lock().expect("fault plan");
    match rebinds.iter_mut().find(|(rebound, _)| *rebound == host) {
        Some((_, count)) => *count += 1,
        None => rebinds.push((host, 1)),
    }
    NAT_REBOUND.notify_waiters();
}

/// How many times `host`'s NAT has rebound.
pub(crate) fn nat_rebinds(host: Option<IpAddr>) -> u64 {
    NAT_REBINDS
        .lock()
        .expect("fault plan")
        .iter()
        .find(|(rebound, _)| Some(*rebound) == host)
        .map_or(0, |(_, count)| *count)
}

/// Resolves at the next NAT rebinding of any host.
pub(crate) fn nat_rebound() -> tokio::sync::futures::Notified<'static> {
    NAT_REBOUND.notified()
}

/// From now on, `host` sends `datagrams` more datagrams, then nothing reaches
/// the network until [`restore`]. Its receive side is untouched.
pub fn cut_after(host: &str, datagrams: u64) {
    *CUT.lock().expect("fault plan") = Some(Cut {
        host: turmoil::lookup(host),
        remaining: datagrams,
    });
}

/// Ends any cut.
pub fn restore() {
    *CUT.lock().expect("fault plan") = None;
}

/// Counts the datagrams `host` sends from now on.
pub fn count(host: &str) {
    *COUNT.lock().expect("fault plan") = Some((turmoil::lookup(host), 0));
}

/// Datagrams the counted host has sent since [`count`].
pub fn counted() -> u64 {
    COUNT
        .lock()
        .expect("fault plan")
        .map_or(0, |(_, sent)| sent)
}

/// Loses each datagram any host sends with probability `rate`, from now on.
pub fn set_loss(rate: f64) {
    *LOSS.lock().expect("fault plan") = rate;
}

pub(crate) fn reset() {
    restore();
    *COUNT.lock().expect("fault plan") = None;
    set_loss(0.0);
    NAT_REBINDS.lock().expect("fault plan").clear();
}

fn lost() -> bool {
    let rate = *LOSS.lock().expect("fault plan");
    if rate <= 0.0 {
        return false;
    }
    let mut draw = [0u8; 4];
    assert!(
        crate::entropy::fill(&mut draw),
        "datagrams are sent inside a run"
    );
    f64::from(u32::from_le_bytes(draw)) < rate * f64::from(u32::MAX)
}

/// Whether a datagram a socket on `host` sends reaches the network.
pub(crate) fn admits(host: Option<IpAddr>) -> bool {
    if lost() {
        return false;
    }
    let admitted = {
        let mut cut = CUT.lock().expect("fault plan");
        match cut.as_mut().filter(|cut| Some(cut.host) == host) {
            None => true,
            Some(cut) if cut.remaining == 0 => false,
            Some(cut) => {
                cut.remaining -= 1;
                true
            }
        }
    };
    if admitted
        && let Some((counted, sent)) = COUNT.lock().expect("fault plan").as_mut()
        && Some(*counted) == host
    {
        *sent += 1;
    }
    admitted
}
