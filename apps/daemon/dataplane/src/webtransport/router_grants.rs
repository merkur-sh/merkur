//! Router resources stay owned through publication, provider use, and acknowledged deletion.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::task::JoinHandle;

use super::{discovery_socket::DiscoverySocket, portmap};

/// Each admitted physical session retains its one family's grant. The listener
/// publishes two, and its single maintenance cohort can acquire two replacements.
const GRANT_CAPACITY: usize = super::MAX_CONCURRENT_SESSIONS + 4;

type Lanes = Arc<Mutex<HashMap<SocketAddr, Weak<Lane>>>>;

struct Lane {
    waiting: AtomicBool,
}

#[derive(Clone)]
pub(crate) struct Factory {
    sender: mpsc::UnboundedSender<Cleanup>,
    permits: Arc<Semaphore>,
    lanes: Lanes,
    retired: watch::Sender<u64>,
    capacity_waiting: Arc<AtomicBool>,
}

pub(crate) struct Owner {
    factory: Factory,
    retired: watch::Receiver<u64>,
    task: JoinHandle<Result<(), usize>>,
}

impl Owner {
    pub(crate) fn new() -> Self {
        Self::with_capacity(GRANT_CAPACITY)
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (retired, observations) = watch::channel(0);
        Self {
            factory: Factory {
                sender,
                permits: Arc::new(Semaphore::new(capacity)),
                lanes: Arc::new(Mutex::new(HashMap::new())),
                retired,
                capacity_waiting: Arc::new(AtomicBool::new(false)),
            },
            retired: observations,
            task: tokio::spawn(cleanup(receiver)),
        }
    }

    pub(crate) fn factory(&self) -> Factory {
        self.factory.clone()
    }

    /// A deferred allocation is retried only after a real resource retirement.
    pub(crate) async fn retired(&mut self) {
        if self.retired.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    pub(crate) async fn shutdown(self) -> Result<(), String> {
        drop(self.factory);
        self.task
            .await
            .map_err(|error| format!("router cleanup owner failed: {error}"))?
            .map_err(|count| format!("{count} router grant deletions were not acknowledged"))
    }
}

pub(crate) struct Reservation {
    lane: Option<Arc<Lane>>,
    permit: Option<OwnedSemaphorePermit>,
    _socket: Arc<DiscoverySocket>,
    lanes: Lanes,
    capacity_waiting: Arc<AtomicBool>,
    retired: watch::Sender<u64>,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let _lanes = self
            .lanes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lane_waiting = self
            .lane
            .as_ref()
            .is_some_and(|lane| lane.waiting.swap(false, Ordering::AcqRel));
        drop(self.lane.take());
        drop(self.permit.take());
        let capacity_waiting = self.capacity_waiting.swap(false, Ordering::AcqRel);
        if lane_waiting || capacity_waiting {
            self.retired
                .send_modify(|sequence| *sequence = sequence.wrapping_add(1));
        }
    }
}

impl Factory {
    /// The lane covers the real internal tuple. NAT-PMP deletion has no nonce,
    /// and an anycast PCP address may name the same backend as the first hop.
    pub(crate) fn reserve(
        &self,
        source: IpAddr,
        port: u16,
        socket: Arc<DiscoverySocket>,
    ) -> Option<Reservation> {
        if self.sender.is_closed() {
            return None;
        }
        let key = SocketAddr::new(source.to_canonical(), port);
        let mut lanes = self
            .lanes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        lanes.retain(|_, lane| lane.strong_count() != 0);
        if let Some(lane) = lanes.get(&key).and_then(Weak::upgrade) {
            lane.waiting.store(true, Ordering::Release);
            return None;
        }
        let permit = match self.permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                self.capacity_waiting.store(true, Ordering::Release);
                return None;
            }
        };
        let lane = Arc::new(Lane {
            waiting: AtomicBool::new(false),
        });
        lanes.insert(key, Arc::downgrade(&lane));
        Some(Reservation {
            lane: Some(lane),
            permit: Some(permit),
            _socket: socket,
            lanes: self.lanes.clone(),
            capacity_waiting: self.capacity_waiting.clone(),
            retired: self.retired.clone(),
        })
    }

    pub(crate) fn lease(&self, value: portmap::Lease, reservation: Reservation) -> Lease {
        Grant::new(
            value.clone(),
            Resource::Lease(value),
            reservation,
            self.sender.clone(),
        )
    }

    pub(crate) fn pinhole(&self, value: portmap::Pinhole, reservation: Reservation) -> Pinhole {
        Grant::new(
            value.clone(),
            Resource::Pinhole(value),
            reservation,
            self.sender.clone(),
        )
    }
}

pub(crate) type Lease = Grant<portmap::Lease>;
pub(crate) type Pinhole = Grant<portmap::Pinhole>;

pub(crate) struct Grant<T> {
    snapshot: Arc<T>,
    authority: Arc<Authority>,
}

impl<T> Clone for Grant<T> {
    fn clone(&self) -> Self {
        Self {
            snapshot: self.snapshot.clone(),
            authority: self.authority.clone(),
        }
    }
}

impl<T> Deref for Grant<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.snapshot
    }
}

impl<T> Grant<T> {
    fn new(
        value: T,
        resource: Resource,
        reservation: Reservation,
        sender: mpsc::UnboundedSender<Cleanup>,
    ) -> Self {
        Self {
            snapshot: Arc::new(value),
            authority: Arc::new(Authority {
                sender,
                held: Mutex::new(Some((resource, reservation))),
                renewing: AtomicBool::new(false),
            }),
        }
    }

    fn updated(&self, value: T, resource: Resource) -> Self {
        let mut held = self
            .authority
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((current, _)) = held.as_mut() {
            *current = resource;
        }
        Self {
            snapshot: Arc::new(value),
            authority: self.authority.clone(),
        }
    }

    pub(crate) fn renewing(&self) -> Option<Renewal> {
        let held = self
            .authority
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        held.as_ref()?;
        self.authority.renewing.store(true, Ordering::Release);
        Some(Renewal(self.authority.clone()))
    }

    pub(crate) fn is_owned(&self) -> bool {
        self.authority
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// A verified gateway reset removed the allocation; no delayed Delete may
    /// target its successor even while an old provider retains its metadata.
    pub(crate) fn forget(&self) {
        let mut held = self
            .authority
            .held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.authority.renewing.load(Ordering::Acquire) {
            drop(held.take());
        }
    }

    pub(crate) fn pin(&self) -> Pin {
        Pin {
            _authority: self.authority.clone(),
        }
    }
}

impl Lease {
    pub(crate) fn renewed(&self, value: portmap::Lease) -> Self {
        self.updated(value.clone(), Resource::Lease(value))
    }
}

impl Pinhole {
    pub(crate) fn renewed(&self, value: portmap::Pinhole) -> Self {
        self.updated(value.clone(), Resource::Pinhole(value))
    }
}

pub(crate) struct Pin {
    _authority: Arc<Authority>,
}

pub(crate) struct Renewal(Arc<Authority>);

impl Drop for Renewal {
    fn drop(&mut self) {
        self.0.renewing.store(false, Ordering::Release);
    }
}

struct Authority {
    renewing: AtomicBool,
    sender: mpsc::UnboundedSender<Cleanup>,
    held: Mutex<Option<(Resource, Reservation)>>,
}

impl Drop for Authority {
    fn drop(&mut self) {
        let held = self
            .held
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some((resource, reservation)) = held
            && self
                .sender
                .send(Cleanup {
                    resource,
                    _reservation: reservation,
                })
                .is_err()
        {
            tracing::error!("router cleanup owner stopped before its last grant");
        }
    }
}

enum Resource {
    Lease(portmap::Lease),
    Pinhole(portmap::Pinhole),
}

struct Cleanup {
    resource: Resource,
    _reservation: Reservation,
}

async fn cleanup(mut receiver: mpsc::UnboundedReceiver<Cleanup>) -> Result<(), usize> {
    let mut pending = FuturesUnordered::new();
    let mut unresolved = Vec::new();
    let mut closed = false;
    while !closed || !pending.is_empty() {
        tokio::select! {
            next = receiver.recv(), if !closed => match next {
                Some(cleanup) => pending.push(async move {
                    let Cleanup { resource, _reservation: reservation } = cleanup;
                    let acknowledged = match resource {
                        Resource::Lease(lease) => portmap::release(lease).await,
                        Resource::Pinhole(pinhole) => portmap::release_pinhole(pinhole).await,
                    };
                    (acknowledged, reservation)
                }),
                None => closed = true,
            },
            result = pending.next(), if !pending.is_empty() => {
                if let Some((acknowledged, reservation)) = result {
                    if acknowledged { drop(reservation); }
                    else { unresolved.push(reservation); }
                }
            }
        }
    }
    if unresolved.is_empty() {
        Ok(())
    } else {
        Err(unresolved.len())
    }
}

#[cfg(all(test, not(merkur_sim)))]
#[path = "router_grants_tests.rs"]
mod tests;
