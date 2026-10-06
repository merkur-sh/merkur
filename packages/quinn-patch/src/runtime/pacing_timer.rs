//! Packet deadlines must not be rounded to Tokio's millisecond wheel: the
//! image pacer's entire burst allowance is one millisecond. A late wake would
//! discard credit, and the bandwidth sampler would measure the timer's rate.
//!
//! One lazily started sleeping thread serves all image pacers. Each live timer
//! owns one reusable indexed-heap slot. Reset, expiry and cancellation allocate
//! nothing; cancellation removes the entry rather than leaving stale deadlines.
//! This service is never created by an ordinary connection timer.

use std::{
    pin::Pin,
    sync::{Condvar, Mutex, OnceLock},
    task::{Context, Poll, Waker},
    time::Instant,
};

use super::AsyncTimer;

pub(super) struct PacingTimer {
    scheduler: &'static Scheduler,
    id: usize,
    deadline: Instant,
}

impl PacingTimer {
    pub(super) fn new(deadline: Instant) -> Self {
        let scheduler = scheduler();
        let id = scheduler.queue.lock().unwrap().allocate(deadline);
        Self {
            scheduler,
            id,
            deadline,
        }
    }
}

impl std::fmt::Debug for PacingTimer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PacingTimer")
            .field("deadline", &self.deadline)
            .finish()
    }
}

impl AsyncTimer for PacingTimer {
    fn reset(mut self: Pin<&mut Self>, deadline: Instant) {
        self.deadline = deadline;
        let mut queue = self.scheduler.queue.lock().unwrap();
        let old_head = queue.head();
        queue.remove(self.id);
        queue.nodes[self.id].deadline = deadline;
        // Poll registers the current driver waker, including after a reset
        // between expiry and the driver's next poll.
        queue.nodes[self.id].waker = None;
        if old_head != queue.head() {
            self.scheduler.changed.notify_one();
        }
    }

    fn poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<()> {
        let mut queue = self.scheduler.queue.lock().unwrap();
        let old_head = queue.head();
        let ready = Instant::now() >= self.deadline;
        if ready {
            queue.remove(self.id);
            queue.nodes[self.id].waker = None;
        } else {
            queue.arm(self.id, cx.waker());
        }
        if old_head != queue.head() {
            self.scheduler.changed.notify_one();
        }
        if ready {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

impl Drop for PacingTimer {
    fn drop(&mut self) {
        let mut queue = self.scheduler.queue.lock().unwrap();
        let old_head = queue.head();
        queue.remove(self.id);
        queue.nodes[self.id].waker = None;
        queue.free.push(self.id);
        if old_head != queue.head() {
            self.scheduler.changed.notify_one();
        }
    }
}

struct Scheduler {
    queue: Mutex<Queue>,
    changed: Condvar,
}

fn scheduler() -> &'static Scheduler {
    static SCHEDULER: OnceLock<&'static Scheduler> = OnceLock::new();
    SCHEDULER.get_or_init(|| {
        let scheduler = Box::leak(Box::new(Scheduler {
            queue: Mutex::new(Queue::default()),
            changed: Condvar::new(),
        }));
        std::thread::Builder::new()
            .name("quinn-image-pacer".into())
            .spawn(|| scheduler.run())
            .expect("create image pacing timer thread");
        scheduler
    })
}

impl Scheduler {
    fn run(&self) {
        let mut queue = self.queue.lock().unwrap();
        loop {
            if let Some((deadline, id)) = queue.head() {
                if deadline <= Instant::now() {
                    queue.remove(id);
                    let waker = queue.nodes[id].waker.take();
                    // Driver polling can acquire this queue; never wake under its lock.
                    drop(queue);
                    if let Some(waker) = waker {
                        waker.wake();
                    }
                    queue = self.queue.lock().unwrap();
                    continue;
                }
            }
            queue = match queue.head() {
                Some((deadline, _)) => {
                    self.changed
                        .wait_timeout(queue, deadline.saturating_duration_since(Instant::now()))
                        .unwrap()
                        .0
                }
                None => self.changed.wait(queue).unwrap(),
            };
        }
    }
}

#[derive(Default)]
struct Queue {
    nodes: Vec<Node>,
    free: Vec<usize>,
    heap: Vec<usize>,
}

struct Node {
    deadline: Instant,
    position: Option<usize>,
    waker: Option<Waker>,
}

impl Queue {
    fn allocate(&mut self, deadline: Instant) -> usize {
        if let Some(id) = self.free.pop() {
            self.nodes[id].deadline = deadline;
            return id;
        }
        let id = self.nodes.len();
        self.nodes.push(Node {
            deadline,
            position: None,
            waker: None,
        });
        // Growth is connection setup work, never timer arm/drop work.
        self.heap
            .reserve(self.nodes.len().saturating_sub(self.heap.len()));
        self.free
            .reserve(self.nodes.len().saturating_sub(self.free.len()));
        id
    }

    fn head(&self) -> Option<(Instant, usize)> {
        self.heap.first().map(|&id| (self.nodes[id].deadline, id))
    }

    fn earlier(&self, a: usize, b: usize) -> bool {
        (self.nodes[self.heap[a]].deadline, self.heap[a])
            < (self.nodes[self.heap[b]].deadline, self.heap[b])
    }

    fn swap(&mut self, a: usize, b: usize) {
        self.heap.swap(a, b);
        self.nodes[self.heap[a]].position = Some(a);
        self.nodes[self.heap[b]].position = Some(b);
    }

    fn up(&mut self, mut pos: usize) -> usize {
        while pos > 0 && self.earlier(pos, (pos - 1) / 2) {
            let parent = (pos - 1) / 2;
            self.swap(pos, parent);
            pos = parent;
        }
        pos
    }

    fn down(&mut self, mut pos: usize) {
        loop {
            let left = pos * 2 + 1;
            if left >= self.heap.len() {
                return;
            }
            let right = left + 1;
            let child = if right < self.heap.len() && self.earlier(right, left) {
                right
            } else {
                left
            };
            if !self.earlier(child, pos) {
                return;
            }
            self.swap(pos, child);
            pos = child;
        }
    }

    fn arm(&mut self, id: usize, waker: &Waker) {
        let node = &mut self.nodes[id];
        if node.waker.as_ref().is_none_or(|old| !old.will_wake(waker)) {
            node.waker = Some(waker.clone());
        }
        if node.position.is_some() {
            return;
        }
        node.position = Some(self.heap.len());
        self.heap.push(id);
        self.up(self.heap.len() - 1);
    }

    fn remove(&mut self, id: usize) {
        let Some(pos) = self.nodes[id].position.take() else {
            return;
        };
        self.heap.swap_remove(pos);
        if pos < self.heap.len() {
            self.nodes[self.heap[pos]].position = Some(pos);
            if self.up(pos) == pos {
                self.down(pos);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::poll_fn, time::Duration};

    #[test]
    fn arbitrary_cancellation_and_rearm_preserve_deadline_order() {
        let mut queue = Queue::default();
        let start = Instant::now();
        for i in 0..257 {
            let id = queue.allocate(start + Duration::from_micros((i * 113 % 257) as u64));
            queue.arm(id, Waker::noop());
        }
        let capacity = queue.heap.capacity();
        for round in 0..10_000 {
            let id = round * 73 % 257;
            queue.remove(id);
            if round % 3 != 0 {
                queue.nodes[id].deadline = start + Duration::from_micros((round * 31 % 997) as u64);
                queue.arm(id, Waker::noop());
            }
            let expected = queue
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, node)| node.position.is_some())
                .map(|(id, node)| (node.deadline, id))
                .min();
            assert_eq!(queue.head(), expected);
            for (pos, &entry) in queue.heap.iter().enumerate() {
                assert_eq!(queue.nodes[entry].position, Some(pos));
                if pos > 0 {
                    assert!(!queue.earlier(pos, (pos - 1) / 2));
                }
            }
        }
        assert_eq!(queue.heap.capacity(), capacity);
        while let Some((_, id)) = queue.head() {
            queue.remove(id);
        }
        assert!(queue.nodes.iter().all(|node| node.position.is_none()));
    }

    #[tokio::test]
    async fn reset_to_an_earlier_deadline_wakes_the_sleeping_scheduler() {
        let mut timer = Box::pin(PacingTimer::new(Instant::now() + Duration::from_secs(10)));
        poll_fn(|cx| {
            assert!(timer.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        let deadline = Instant::now() + Duration::from_millis(2);
        timer.as_mut().reset(deadline);
        tokio::time::timeout(
            Duration::from_secs(1),
            poll_fn(|cx| timer.as_mut().poll(cx)),
        )
        .await
        .unwrap();
        assert!(Instant::now() >= deadline);
        let queue = timer.scheduler.queue.lock().unwrap();
        assert!(queue.nodes[timer.id].position.is_none());
    }

    #[tokio::test]
    async fn dropped_timers_leave_no_pending_deadlines() {
        let scheduler = Box::leak(Box::new(Scheduler {
            queue: Mutex::new(Queue::default()),
            changed: Condvar::new(),
        }));
        let mut timers: Vec<_> = (0..128)
            .map(|_| {
                let deadline = Instant::now() + Duration::from_secs(10);
                let id = scheduler.queue.lock().unwrap().allocate(deadline);
                Box::pin(PacingTimer {
                    scheduler,
                    id,
                    deadline,
                })
            })
            .collect();
        let ids: Vec<_> = timers.iter().map(|timer| timer.id).collect();
        poll_fn(|cx| {
            for timer in &mut timers {
                assert!(timer.as_mut().poll(cx).is_pending());
            }
            Poll::Ready(())
        })
        .await;
        drop(timers);
        let queue = scheduler.queue.lock().unwrap();
        for id in ids {
            assert!(queue.nodes[id].position.is_none());
            assert!(queue.nodes[id].waker.is_none());
        }
    }
}
