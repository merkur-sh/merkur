//! Immutable display ciphertext owners shared by carrier queues and replicas.
use bytes::{Bytes, BytesMut};

// Both native carriers have 64 KiB admission budgets. Retention is lazy and
// bounded independently of how long a stalled/displaced carrier holds a clone.
const RETAINED_BYTES: usize = 2 * 64 * 1024;
const RETAINED_FRAMES: usize = 256;

#[derive(Default)]
pub(crate) struct WirePool {
    retired: Vec<Bytes>,
    bytes: usize,
    next: usize,
}

impl WirePool {
    pub(crate) fn take(&mut self, len: usize) -> BytesMut {
        // Small size classes avoid a cold allocation every time one more cell
        // changes a row's encoded length. The wire owner is truncated separately.
        let len = len.div_ceil(64) * 64;
        // Resume the scan after the last reclaim. Repeated newest-first scans
        // revisit every still-queued member of the same burst (quadratic work).
        // A one-record interactive lane still hits immediately. Never wait on
        // a carrier or recycle memory it still owns.
        let mut index = self.next.min(self.retired.len().saturating_sub(1));
        for _ in 0..self.retired.len() {
            let bytes = &self.retired[index];
            if bytes.len() == len && bytes.is_unique() {
                let bytes = self.retired.swap_remove(index);
                self.bytes -= bytes.len();
                self.next = index + 1;
                return bytes.try_into_mut().expect("the pool held the sole owner");
            }
            index += 1;
            if index == self.retired.len() {
                index = 0;
            }
        }
        let mut bytes = BytesMut::with_capacity(len);
        bytes.resize(len, 0);
        // Establish BytesMut's reusable shared representation once. Freezing
        // a Vec-backed buffer and cloning its Bytes instead would allocate a
        // new Bytes control block on every freeze/reclaim cycle.
        if len > 1 {
            let tail = bytes.split_off(1);
            bytes.unsplit(tail);
        }
        bytes
    }

    pub(crate) fn recycle(&mut self, bytes: Bytes) {
        if bytes.len() > RETAINED_BYTES {
            return;
        }
        while self.retired.len() == RETAINED_FRAMES
            || bytes.len() > RETAINED_BYTES.saturating_sub(self.bytes)
        {
            let Some(index) = self.retired.iter().position(Bytes::is_unique) else {
                return;
            };
            self.bytes -= self.retired.swap_remove(index).len();
        }
        if self.retired.len() < RETAINED_FRAMES
            && bytes.len() <= RETAINED_BYTES.saturating_sub(self.bytes)
        {
            self.bytes += bytes.len();
            self.retired.push(bytes);
        }
    }

    #[cfg(test)]
    pub(crate) fn retained_bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod profile;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge_tunnel::test_allocations;

    #[test]
    fn queued_clones_are_immutable_and_retire_before_reuse() {
        let mut pool = WirePool::default();
        let mut first = pool.take(200);
        first.fill(7);
        let first = first.freeze();
        let original = first.as_ptr();
        let queued = first.clone();
        pool.recycle(first);
        let mut next = pool.take(200);
        assert_ne!(next.as_ptr(), original);
        next.fill(9);
        assert!(queued.iter().all(|&byte| byte == 7));
        drop(next);
        drop(queued);
        for _ in 0..1024 {
            test_allocations::begin_thread();
            let mut buffer = pool.take(200);
            assert_eq!(buffer.as_ptr(), original);
            buffer.fill(11);
            let bytes = buffer.freeze();
            let direct = bytes.clone();
            let edge = bytes.clone();
            pool.recycle(bytes);
            drop(direct);
            drop(edge);
            let tally = test_allocations::end_thread();
            assert_eq!(tally.allocations, 0);
        }
    }

    #[test]
    fn held_and_idle_owners_have_bounded_retention() {
        let mut pool = WirePool::default();
        let held: Vec<_> = (0..1024)
            .map(|_| {
                let bytes = pool.take(1100).freeze();
                pool.recycle(bytes.clone());
                bytes
            })
            .collect();
        assert!(pool.retained_bytes() <= RETAINED_BYTES);
        assert!(pool.retired.len() <= RETAINED_FRAMES);
        drop(pool);
        assert!(held.iter().all(|bytes| bytes.len() == 1152));
    }
}
