//! Count and resident-byte ownership across native adapter queues.
use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

#[derive(Clone)]
pub(crate) struct Credit {
    records: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    byte_limit: usize,
}

/// Dropping an unread record or a retired forwarding queue releases both.
#[derive(Debug)]
pub struct Lease {
    _record: OwnedSemaphorePermit,
    _bytes: OwnedSemaphorePermit,
}

impl Credit {
    pub(crate) fn new(records: usize, bytes: usize) -> Self {
        Self {
            records: Arc::new(Semaphore::new(records)),
            bytes: Arc::new(Semaphore::new(bytes)),
            byte_limit: bytes,
        }
    }

    pub(crate) fn try_reserve(&self, bytes: usize) -> Result<Lease, TryAcquireError> {
        if bytes > self.byte_limit {
            return Err(TryAcquireError::NoPermits);
        }
        let record = Arc::clone(&self.records).try_acquire_owned()?;
        let bytes = Arc::clone(&self.bytes).try_acquire_many_owned(bytes as u32)?;
        Ok(Lease {
            _record: record,
            _bytes: bytes,
        })
    }

    pub(crate) async fn reserve(&self, bytes: usize) -> Option<Lease> {
        if bytes > self.byte_limit {
            return None;
        }
        let record = Arc::clone(&self.records).acquire_owned().await.ok()?;
        let bytes = Arc::clone(&self.bytes)
            .acquire_many_owned(bytes as u32)
            .await
            .ok()?;
        Some(Lease {
            _record: record,
            _bytes: bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credits_follow_forwarded_owners_and_retirement_releases_them() {
        let credit = Credit::new(2, 8);
        let one = credit.try_reserve(5).unwrap();
        let two = credit.try_reserve(3).unwrap();
        assert!(credit.try_reserve(0).is_err());
        let (forward, mut incoming) = tokio::sync::mpsc::unbounded_channel();
        forward.send(one).unwrap();
        // Removing from the producer's queue did not release its destination credit.
        assert!(credit.try_reserve(1).is_err());
        drop(incoming.recv().await);
        let replacement = credit.try_reserve(5).unwrap();
        forward.send(replacement).unwrap();
        drop(incoming);
        drop(two);
        assert!(credit.try_reserve(8).is_ok());
    }

    #[tokio::test]
    async fn byte_wait_is_an_exact_readiness_event_and_cancellation_releases_count() {
        let credit = Credit::new(2, 8);
        let held = credit.try_reserve(8).unwrap();
        let mut waiting = Box::pin(credit.reserve(1));
        assert!(futures::poll!(&mut waiting).is_pending());
        drop(waiting);
        drop(held);
        assert!(credit.try_reserve(8).is_ok());
    }
}
