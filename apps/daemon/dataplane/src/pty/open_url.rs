//! `merkur open` requests the browsers have not acknowledged.
//!
//! A request is delivered when a browser says so. Admission to a reliable lane
//! is not enough: after a page reload the daemon still counts the old page as
//! a peer until it notices the page is gone, and a request sealed to it is lost
//! while the program that asked waits on a login page. So every request carries
//! an id, is offered to each browser that can hear it, and leaves the queue
//! only when one acknowledges it (`MSG_TYPE_OPEN_URL_ACK`).

use std::collections::VecDeque;

/// Most unacknowledged requests held. A resource bound: each URL may be 2 MiB,
/// and a program looping on `$BROWSER` with nobody attached must not grow the
/// daemon. The newest are kept, because they are the ones a returning user
/// acts on.
pub const OPEN_URL_PENDING_MAX: usize = 16;

pub struct PendingOpenUrl {
    pub seq: u32,
    pub url: Box<str>,
}

pub struct OpenUrlQueue {
    /// Random per dataplane process, so `(epoch, seq)` never names a request of
    /// an earlier process to a browser that outlived it.
    epoch: u32,
    next_seq: u32,
    /// Ascending by `seq`.
    pending: VecDeque<PendingOpenUrl>,
}

impl OpenUrlQueue {
    pub fn new() -> Self {
        let mut epoch = [0u8; 4];
        // Without entropy every process shares epoch 0: a browser that outlives
        // a daemon restart may then take a new request for one it already
        // handled and acknowledge it unopened. That is the whole cost.
        let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut epoch);
        Self {
            epoch: u32::from_be_bytes(epoch),
            next_seq: 1,
            pending: VecDeque::new(),
        }
    }

    /// Queue a request. Past `u32::MAX` requests in one process, new ones are
    /// dropped rather than reusing an id.
    pub fn push(&mut self, url: Box<str>) {
        let seq = self.next_seq;
        let Some(next_seq) = seq.checked_add(1) else {
            return;
        };
        self.next_seq = next_seq;
        if self.pending.len() == OPEN_URL_PENDING_MAX {
            self.pending.pop_front();
        }
        self.pending.push_back(PendingOpenUrl { seq, url });
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    /// Newest unacknowledged id, or `None` when nothing is waiting.
    pub fn newest_seq(&self) -> Option<u32> {
        self.pending.back().map(|request| request.seq)
    }

    /// Unacknowledged requests issued after `seq`, ascending.
    pub fn after(&self, seq: u32) -> impl Iterator<Item = &PendingOpenUrl> {
        let start = self.pending.partition_point(|request| request.seq <= seq);
        self.pending.range(start..)
    }

    /// A browser handled `(epoch, seq)`; no other browser needs offering it.
    pub fn acknowledge(&mut self, epoch: u32, seq: u32) {
        if epoch != self.epoch {
            return;
        }
        if let Ok(index) = self.pending.binary_search_by_key(&seq, |request| request.seq) {
            self.pending.remove(index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls<'a>(requests: impl Iterator<Item = &'a PendingOpenUrl>) -> Vec<(u32, &'a str)> {
        requests.map(|request| (request.seq, &*request.url)).collect()
    }

    #[test]
    fn requests_wait_until_acknowledged_and_keep_only_the_newest() {
        let mut queue = OpenUrlQueue::new();
        for index in 0..OPEN_URL_PENDING_MAX + 4 {
            queue.push(format!("https://a.example/{index}").into());
        }
        let newest = u32::try_from(OPEN_URL_PENDING_MAX + 4).unwrap();
        assert_eq!(queue.newest_seq(), Some(newest));
        assert_eq!(queue.after(0).count(), OPEN_URL_PENDING_MAX);
        assert_eq!(queue.after(0).next().map(|request| request.seq), Some(5));
        assert_eq!(urls(queue.after(newest - 1)), [(newest, "https://a.example/19")]);

        queue.acknowledge(queue.epoch().wrapping_add(1), newest);
        assert_eq!(queue.newest_seq(), Some(newest), "another process's id changes nothing");
        queue.acknowledge(queue.epoch(), newest);
        assert_eq!(queue.newest_seq(), Some(newest - 1));
        for request in 5..newest {
            queue.acknowledge(queue.epoch(), request);
        }
        assert_eq!(queue.newest_seq(), None);
    }
}
