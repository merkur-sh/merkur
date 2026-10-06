//! Bounded, owner-granted pinhole punches. The PTY owner never sends one itself.
use std::{net::IpAddr, sync::Arc, time::Duration};

use serde::Serialize;
use tokio::{sync::mpsc, task::JoinHandle, time::Instant};

use super::side_channel::{PunchRefusal, SideChannel};
use crate::connection::PeerMap;

pub const CAPACITY: usize = 32;
/// Mirrors the browser's `RACE_DEADLINE_MS`: a punch that has not left by the
/// time the browser stops dialing opens filter state nobody will use.
const DEADLINE: Duration = Duration::from_millis(2500);
/// Resource bound: one blocking-pool batch in flight, and at least this long
/// between batches, so a burst of manifests cannot occupy the pool back to back.
const PUNCH_PACE: Duration = Duration::from_millis(20);

pub struct Request {
    pub peer: Arc<str>,
    pub session: String,
    pub generation: u64,
    /// The manifest this punch serves; its outcome is reported against it.
    pub manifest_generation: u64,
    pub channel: Arc<SideChannel>,
    pub browser_ip: IpAddr,
    pub ports: [u16; 2],
    pub created: Instant,
}

/// What became of one queued punch. Every request ends in exactly one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PunchOutcome {
    /// The datagrams left.
    Dispatched,
    /// It was not sent and will not be: the peer already has a direct path,
    /// the side channel refused the destination, or the queue was full.
    Refused,
    /// A newer manifest, carrier or session replaced it before it left.
    Superseded,
    /// It had not left by the time the browser's race would have ended.
    Expired,
}

/// One request's outcome, addressed to the manifest it served.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Disposition {
    pub peer: Arc<str>,
    pub manifest_generation: u64,
    pub outcome: PunchOutcome,
}

impl Request {
    fn disposition(&self, outcome: PunchOutcome) -> Disposition {
        Disposition {
            peer: self.peer.clone(),
            manifest_generation: self.manifest_generation,
            outcome,
        }
    }
}

struct Job {
    request: Request,
    finished: Option<PunchOutcome>,
}

/// The one blocking batch in flight, and whom its outcome belongs to.
struct Batch {
    task: JoinHandle<Result<usize, PunchRefusal>>,
    peer: Arc<str>,
    manifest_generation: u64,
}

/// The PTY owner owns both this queue and its one outstanding blocking batch.
/// Idle discovery has no timer. Delayed wakes never accumulate send credit.
pub struct Owner {
    jobs: Vec<Job>,
    next: Instant,
    invalidated: Instant,
    batch: Option<Batch>,
    /// Outcomes not yet reported; the owner drains them after each call.
    dispositions: Vec<Disposition>,
}

impl Owner {
    pub fn new() -> Self {
        Self {
            jobs: Vec::with_capacity(CAPACITY),
            next: Instant::now(),
            invalidated: Instant::now(),
            batch: None,
            dispositions: Vec::new(),
        }
    }

    pub fn enqueue(&mut self, request: Request, peers: &PeerMap) {
        let now = Instant::now();
        if request.created < self.invalidated || now >= request.created + DEADLINE {
            self.dispositions
                .push(request.disposition(PunchOutcome::Expired));
            return;
        }
        let Some(peer) = peers.get(request.peer.as_ref()) else {
            self.dispositions
                .push(request.disposition(PunchOutcome::Superseded));
            return;
        };
        if !peer.authenticated
            || peer.signal_session_id != request.session
            || peer.rebind.as_ref().map_or(0, |state| state.counter) != request.generation
            || peer.manifest_generation != request.manifest_generation
        {
            self.dispositions
                .push(request.disposition(PunchOutcome::Superseded));
            return;
        }
        if peer.paths.webtransport.available {
            self.dispositions
                .push(request.disposition(PunchOutcome::Refused));
            return;
        }
        // A newer manifest to the same peer replaces its queued one; the side
        // channel's per-destination cooldown bounds repeats that already left.
        let (replaced, kept): (Vec<Job>, Vec<Job>) = std::mem::take(&mut self.jobs)
            .into_iter()
            .partition(|job| job.request.peer == request.peer);
        self.jobs = kept;
        self.dispositions.extend(
            replaced
                .iter()
                .map(|job| job.request.disposition(PunchOutcome::Superseded)),
        );
        if self.jobs.len() == CAPACITY {
            self.dispositions
                .push(request.disposition(PunchOutcome::Refused));
            return;
        }
        self.jobs.push(Job {
            request,
            finished: None,
        });
    }

    pub fn active(&self) -> bool {
        self.batch.is_some() || self.jobs.iter().any(|job| job.finished.is_none())
    }

    /// Cancellation safe: a selected input event leaves the batch handle owned.
    pub async fn ready(&mut self) {
        if let Some(batch) = &mut self.batch {
            let sent = (&mut batch.task).await;
            let outcome = match sent {
                Ok(Ok(_)) => PunchOutcome::Dispatched,
                Ok(Err(_)) => PunchOutcome::Refused,
                // Aborted by an invalidation before it ran.
                Err(_) => PunchOutcome::Expired,
            };
            self.dispositions.push(Disposition {
                peer: batch.peer.clone(),
                manifest_generation: batch.manifest_generation,
                outcome,
            });
            self.batch = None;
            self.next = Instant::now() + PUNCH_PACE;
        } else {
            tokio::time::sleep_until(self.next).await;
        }
    }

    pub fn advance(&mut self, peers: &PeerMap) {
        let now = Instant::now();
        for job in &mut self.jobs {
            let request = &job.request;
            let peer = peers.get(request.peer.as_ref());
            let live = peer.is_some_and(|peer| {
                peer.authenticated
                    && peer.signal_session_id == request.session
                    && peer.rebind.as_ref().map_or(0, |state| state.counter) == request.generation
                    && peer.manifest_generation == request.manifest_generation
                    && peer.browser_address == Some(request.browser_ip)
            });
            job.finished = if !live {
                Some(PunchOutcome::Superseded)
            } else if peer.is_some_and(|peer| peer.paths.webtransport.available) {
                Some(PunchOutcome::Refused)
            } else if now >= request.created + DEADLINE {
                Some(PunchOutcome::Expired)
            } else {
                None
            };
        }
        let dispositions = &mut self.dispositions;
        self.jobs.retain(|job| match job.finished {
            Some(outcome) => {
                dispositions.push(job.request.disposition(outcome));
                false
            }
            None => true,
        });
        if self.batch.is_some() || now < self.next {
            return;
        }
        if self.jobs.is_empty() {
            return;
        }
        let Request {
            peer,
            manifest_generation,
            channel,
            browser_ip,
            ports,
            ..
        } = self.jobs.remove(0).request;
        self.next = now + PUNCH_PACE;
        // Std mutexes and sends: neither may block the PTY owner.
        self.batch = Some(Batch {
            task: tokio::task::spawn_blocking(move || channel.punch(browser_ip, &ports)),
            peer,
            manifest_generation,
        });
    }

    /// Whether an outcome awaits reporting. The owner's loop reports on this
    /// state, so every producer (enqueue, advance, invalidation) is covered.
    pub fn has_dispositions(&self) -> bool {
        !self.dispositions.is_empty()
    }

    /// Outcomes decided since the last call, oldest first.
    pub fn take_dispositions(&mut self) -> std::vec::Drain<'_, Disposition> {
        self.dispositions.drain(..)
    }

    pub fn invalidate_peer(&mut self, peer: &str) {
        let dispositions = &mut self.dispositions;
        self.jobs.retain(|job| {
            if job.request.peer.as_ref() != peer {
                return true;
            }
            dispositions.push(job.request.disposition(PunchOutcome::Superseded));
            false
        });
    }

    pub fn invalidate(&mut self) {
        self.invalidated = Instant::now();
        self.dispositions.extend(
            self.jobs
                .drain(..)
                .map(|job| job.request.disposition(PunchOutcome::Expired)),
        );
        if let Some(batch) = &self.batch {
            batch.task.abort();
        }
    }

    pub async fn shutdown(&mut self) {
        self.jobs.clear();
        if let Some(batch) = self.batch.take() {
            let _ = batch.task.await;
        }
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        // A running batch cannot be aborted, but it is one four-packet punch.
        if let Some(batch) = &self.batch {
            batch.task.abort();
        }
    }
}

pub fn channel() -> (mpsc::Sender<Request>, mpsc::Receiver<Request>) {
    mpsc::channel(CAPACITY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{PeerDisplayState, PeerTransport};

    fn fixture() -> (Owner, PeerMap, Arc<SideChannel>) {
        let mut peer = PeerDisplayState::new("browser".into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.browser_address = Some("203.0.113.7".parse().unwrap());
        peer.manifest_generation = 1;
        peer.signal_session_id = "session".into();
        let channel =
            Arc::new(SideChannel::new(std::net::UdpSocket::bind("0.0.0.0:0").unwrap()).unwrap());
        (
            Owner::new(),
            PeerMap::from([("browser".into(), peer)]),
            channel,
        )
    }

    fn request(channel: &Arc<SideChannel>) -> Request {
        Request {
            peer: "browser".into(),
            session: "session".into(),
            generation: 0,
            manifest_generation: 1,
            channel: channel.clone(),
            browser_ip: "203.0.113.7".parse().unwrap(),
            ports: [44433, 44434],
            created: Instant::now(),
        }
    }

    fn outcomes(owner: &mut Owner) -> Vec<PunchOutcome> {
        owner
            .take_dispositions()
            .map(|disposition| disposition.outcome)
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn a_punch_is_owned_background_work_and_reports_its_dispatch() {
        let (mut owner, peers, channel) = fixture();
        owner.enqueue(request(&channel), &peers);
        owner.advance(&peers);
        assert!(owner.batch.is_some());
        assert!(
            outcomes(&mut owner).is_empty(),
            "nothing is decided before it runs"
        );
        owner.ready().await;
        assert!(!owner.active());
        assert_eq!(channel.stats().snapshot().packets_sent, 4);
        let reported: Vec<_> = owner.take_dispositions().collect();
        assert_eq!(
            reported,
            [Disposition {
                peer: "browser".into(),
                manifest_generation: 1,
                outcome: PunchOutcome::Dispatched,
            }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_newer_manifest_supersedes_the_queued_punch_for_that_peer() {
        let (mut owner, peers, channel) = fixture();
        owner.enqueue(request(&channel), &peers);
        owner.enqueue(request(&channel), &peers);
        assert_eq!(owner.jobs.len(), 1);
        assert_eq!(outcomes(&mut owner), [PunchOutcome::Superseded]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_adopted_path_refuses_and_a_departed_peer_supersedes_queued_work() {
        let (mut owner, mut peers, channel) = fixture();
        owner.enqueue(request(&channel), &peers);
        peers
            .get_mut("browser")
            .unwrap()
            .paths
            .webtransport
            .available = true;
        owner.advance(&peers);
        assert!(!owner.active());
        assert_eq!(outcomes(&mut owner), [PunchOutcome::Refused]);
        owner.enqueue(request(&channel), &peers);
        assert_eq!(outcomes(&mut owner), [PunchOutcome::Refused]);
        peers
            .get_mut("browser")
            .unwrap()
            .paths
            .webtransport
            .available = false;
        owner.enqueue(request(&channel), &peers);
        peers.clear();
        owner.advance(&peers);
        assert!(!owner.active());
        assert_eq!(outcomes(&mut owner), [PunchOutcome::Superseded]);
        assert_eq!(channel.stats().snapshot().packets_sent, 0);
    }

    /// The browser moved or a newer manifest went out: a punch aimed at the
    /// old address or for the old manifest must not leave.
    #[tokio::test(start_paused = true)]
    async fn a_moved_browser_or_a_newer_manifest_supersedes_the_punch() {
        let (mut owner, mut peers, channel) = fixture();
        owner.enqueue(request(&channel), &peers);
        peers.get_mut("browser").unwrap().browser_address = Some("198.51.100.4".parse().unwrap());
        owner.advance(&peers);
        assert_eq!(outcomes(&mut owner), [PunchOutcome::Superseded]);

        peers.get_mut("browser").unwrap().browser_address = Some("203.0.113.7".parse().unwrap());
        owner.enqueue(request(&channel), &peers);
        peers.get_mut("browser").unwrap().manifest_generation = 2;
        owner.advance(&peers);
        assert_eq!(outcomes(&mut owner), [PunchOutcome::Superseded]);
        assert_eq!(channel.stats().snapshot().packets_sent, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn obsolete_and_expired_requests_cannot_send_and_report_expiry() {
        let (mut owner, peers, channel) = fixture();
        let old = request(&channel);
        tokio::time::advance(Duration::from_millis(1)).await;
        owner.invalidate();
        owner.enqueue(old, &peers);
        assert!(!owner.active());
        let late = request(&channel);
        tokio::time::advance(DEADLINE).await;
        owner.enqueue(late, &peers);
        assert!(!owner.active());
        assert_eq!(channel.stats().snapshot().packets_sent, 0);
        assert_eq!(
            outcomes(&mut owner),
            [PunchOutcome::Expired, PunchOutcome::Expired]
        );
    }

    #[test]
    fn a_punch_outcome_has_the_wire_name_the_browser_reads() {
        for (outcome, wire) in [
            (PunchOutcome::Dispatched, "\"dispatched\""),
            (PunchOutcome::Refused, "\"refused\""),
            (PunchOutcome::Superseded, "\"superseded\""),
            (PunchOutcome::Expired, "\"expired\""),
        ] {
            assert_eq!(serde_json::to_string(&outcome).unwrap(), wire);
        }
    }
}
