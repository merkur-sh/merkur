//! Physical destruction has its own owner. A retained allocation preallocates
//! its intrusive queue node before publication; dropping it neither allocates
//! nor wipes pixels, and its lease travels with the allocation until destruction.
//! An allocation released by another's destruction retires inside it, so one
//! completion covers the whole subtree that destruction released.
use merkur_graphics::budget::Lease;
use std::{
    cell::Cell,
    ops::Deref,
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;

// Resource bound for the one lazy process-wide reclaimer thread. Its linked
// queue has no independent capacity: each node is precharged to a live object.
const STACK_BYTES: usize = 256 * 1024;
static QUEUE: OnceLock<Option<Queue>> = OnceLock::new();

thread_local! {
    /// Set only on the reclaimer thread, where every release belongs to the
    /// destruction in progress rather than to the queue.
    static RETIRING: Cell<bool> = const { Cell::new(false) };
    /// Allocations released by the destruction in progress, linked through the
    /// same preallocated nodes: no lock, count or notification.
    static NESTED: Cell<Option<Box<dyn Allocation>>> = const { Cell::new(None) };
}

trait Allocation: Send + Sync {
    fn replace_next(&mut self, next: Option<Box<dyn Allocation>>) -> Option<Box<dyn Allocation>>;
    fn destroy(self: Box<Self>) -> (Arc<Completion>, Lease);
}

struct Node<T> {
    value: T,
    next: Option<Box<dyn Allocation>>,
    completion: Arc<Completion>,
    lease: Lease,
}

impl<T: Send + Sync> Allocation for Node<T> {
    fn replace_next(&mut self, next: Option<Box<dyn Allocation>>) -> Option<Box<dyn Allocation>> {
        std::mem::replace(&mut self.next, next)
    }

    fn destroy(self: Box<Self>) -> (Arc<Completion>, Lease) {
        let Self {
            value,
            next,
            completion,
            lease,
        } = *self;
        debug_assert!(next.is_none());
        drop(value);
        // Both payload and node allocation are gone when the caller receives
        // the lease. Type erasure needs no second payload box or unsafe code.
        (completion, lease)
    }
}

pub struct Completion {
    done: AtomicBool,
    wake: Notify,
}

impl Completion {
    pub async fn wait(&self) {
        let wake = self.wake.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        if !self.done.load(Ordering::Acquire) {
            wake.await;
        }
    }

    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }
}

#[derive(Default)]
struct Pending {
    head: Option<Box<dyn Allocation>>,
    count: usize,
}

struct State {
    pending: Mutex<Pending>,
    ready: Condvar,
    drained: Condvar,
}

struct Queue(Arc<State>);

impl Queue {
    fn new() -> Option<Self> {
        let state = Arc::new(State {
            pending: Mutex::new(Pending::default()),
            ready: Condvar::new(),
            drained: Condvar::new(),
        });
        // The pinned std pthread implementation allocates these primitives on
        // first use. Initialize them on this processing owner, before a published
        // source can enqueue its retirement from the terminal owner.
        drop(state.pending.lock().ok()?);
        state.ready.notify_one();
        state.drained.notify_all();
        let worker = Arc::clone(&state);
        std::thread::Builder::new()
            .name("image-retirement".into())
            .stack_size(STACK_BYTES)
            .spawn(move || -> ! {
                RETIRING.set(true);
                loop {
                    let mut batch = {
                        let mut pending = worker.pending.lock().unwrap_or_else(|e| e.into_inner());
                        while pending.head.is_none() {
                            pending = worker
                                .ready
                                .wait(pending)
                                .unwrap_or_else(|e| e.into_inner());
                        }
                        pending.head.take()
                    };
                    // Producers push in constant time. Reverse this detached batch
                    // off-owner so old allocations retire before newer allocations.
                    let mut ordered = None;
                    while let Some(mut node) = batch {
                        batch = node.replace_next(ordered);
                        ordered = Some(node);
                    }
                    while let Some(mut node) = ordered {
                        ordered = node.replace_next(None);
                        retire(node);
                        let mut pending = worker.pending.lock().unwrap_or_else(|e| e.into_inner());
                        pending.count -= 1;
                        if pending.count == 0 {
                            worker.drained.notify_all();
                        }
                    }
                }
            })
            .ok()?;
        Some(Self(state))
    }

    fn push<T: Send + Sync + 'static>(&self, mut node: Box<Node<T>>) {
        if RETIRING.get() {
            node.next = NESTED.take();
            NESTED.set(Some(node));
            return;
        }
        let mut pending = self.0.pending.lock().unwrap_or_else(|e| e.into_inner());
        node.next = pending.head.take();
        pending.head = Some(node);
        pending.count += 1;
        self.0.ready.notify_one();
    }
}

/// Destroys one allocation, then every allocation its destruction released, and
/// only then refunds and completes it. Depth is the ownership nesting: animation
/// storage, frame root, pixels.
fn retire(node: Box<dyn Allocation>) {
    let siblings = NESTED.take();
    let (completion, lease) = node.destroy();
    while let Some(mut nested) = NESTED.take() {
        NESTED.set(nested.replace_next(None));
        retire(nested);
    }
    NESTED.set(siblings);
    drop(lease);
    completion.done.store(true, Ordering::Release);
    completion.wake.notify_waiters();
}

/// Called after terminal/transport owners have released their references during
/// process shutdown. It waits for actual wiping, including nested frame and pixel
/// releases. It never initializes image resources in a process that has not used them.
pub fn drain() {
    let Some(Some(queue)) = QUEUE.get() else {
        return;
    };
    let mut pending = queue.0.pending.lock().unwrap_or_else(|e| e.into_inner());
    while pending.count != 0 {
        pending = queue
            .0
            .drained
            .wait(pending)
            .unwrap_or_else(|e| e.into_inner());
    }
}

pub(crate) struct Retained<T: Send + Sync + 'static> {
    node: Option<Box<Node<T>>>,
    queue: &'static Queue,
}

impl<T: Send + Sync + 'static> Retained<T> {
    pub(crate) const METADATA_BYTES: usize =
        size_of::<Node<T>>() + size_of::<Completion>() + 2 * size_of::<usize>();

    /// Construct only on the processing owner, after reserving metadata and all
    /// payload bytes. Queue/thread initialization is also confined to this path.
    pub(crate) fn new(value: T, lease: Lease) -> Option<Self> {
        // Tuple fields drop in declaration order. Failed admission or thread
        // initialization must destroy the payload before refunding its lease.
        let admitted = (value, lease);
        if admitted.1.charge().bytes < Self::METADATA_BYTES || admitted.1.charge().objects < 1 {
            return None;
        }
        let queue = QUEUE.get_or_init(Queue::new).as_ref()?;
        let (value, lease) = admitted;
        Some(Self {
            queue,
            node: Some(Box::new(Node {
                value,
                next: None,
                completion: Arc::new(Completion {
                    done: AtomicBool::new(false),
                    wake: Notify::new(),
                }),
                lease,
            })),
        })
    }

    pub(crate) fn completion(&self) -> Arc<Completion> {
        // The terminal owner holds one completion per removed source until it
        // lands: one small signal can outlive the refunded node.
        Arc::clone(&self.node.as_ref().expect("live retirement node").completion)
    }
}

impl<T: Send + Sync + 'static> Deref for Retained<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.node.as_ref().expect("live retained allocation").value
    }
}

impl<T: Send + Sync + 'static> Drop for Retained<T> {
    fn drop(&mut self) {
        let node = self.node.take().expect("single retirement");
        self.queue.push(node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_graphics::budget::{Budget, Usage};

    #[test]
    fn refused_metadata_admission_destroys_payload_before_refunding_its_reservation() {
        struct Payload(Budget);
        impl Drop for Payload {
            fn drop(&mut self) {
                assert_eq!(
                    self.0.used(),
                    Some(Usage {
                        bytes: 1,
                        objects: 1
                    })
                );
            }
        }
        let charge = Usage {
            bytes: 1,
            objects: 1,
        };
        let budget = Budget::new(charge);
        assert!(Retained::new(Payload(budget.clone()), budget.reserve(charge).unwrap()).is_none());
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[tokio::test]
    async fn destruction_runs_off_owner_and_refunds_only_after_physical_release() {
        struct Held {
            started: std::sync::mpsc::SyncSender<std::thread::ThreadId>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl Drop for Held {
            fn drop(&mut self) {
                self.started.send(std::thread::current().id()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
        }
        let charge = Usage {
            bytes: 4096,
            objects: 1,
        };
        let budget = Budget::new(charge);
        let (started, wait) = std::sync::mpsc::sync_channel(1);
        let (release, receiver) = std::sync::mpsc::sync_channel(1);
        let retained = Retained::new(
            Held {
                started,
                release: Mutex::new(receiver),
            },
            budget.reserve(charge).unwrap(),
        )
        .unwrap();
        let completion = retained.completion();
        drop(retained);
        assert_ne!(wait.recv().unwrap(), std::thread::current().id());
        assert_eq!(budget.used(), Some(charge));
        assert!(!completion.done.load(Ordering::Acquire));
        release.send(()).unwrap();
        completion.wait().await;
        drop(completion);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[tokio::test]
    async fn completion_follows_every_allocation_its_destruction_released() {
        /// Records, on the reclaimer, whether the outermost release had already
        /// completed when this innermost allocation was destroyed.
        struct Leaf {
            outer: Arc<OnceLock<Arc<Completion>>>,
            late: Arc<AtomicBool>,
        }
        impl Drop for Leaf {
            fn drop(&mut self) {
                let late = self.outer.get().is_none_or(|outer| outer.is_done());
                self.late.store(late, Ordering::Release);
            }
        }
        struct Inner {
            _leaf: Retained<Leaf>,
        }
        struct Outer {
            _inner: Retained<Inner>,
        }
        let charge = Usage {
            bytes: 4096,
            objects: 1,
        };
        let budget = Budget::new(Usage {
            bytes: 3 * charge.bytes,
            objects: 3,
        });
        let outer_released = Arc::new(OnceLock::new());
        let late = Arc::new(AtomicBool::new(false));
        let leaf = Leaf {
            outer: Arc::clone(&outer_released),
            late: Arc::clone(&late),
        };
        let leaf = Retained::new(leaf, budget.reserve(charge).unwrap()).unwrap();
        let leaf_released = leaf.completion();
        let inner = Retained::new(Inner { _leaf: leaf }, budget.reserve(charge).unwrap()).unwrap();
        let inner_released = inner.completion();
        let outer =
            Retained::new(Outer { _inner: inner }, budget.reserve(charge).unwrap()).unwrap();
        let released = outer.completion();
        assert!(outer_released.set(Arc::clone(&released)).is_ok());
        drop(outer);
        // No drain: the outer completion alone implies the whole nested subtree.
        released.wait().await;
        assert!(leaf_released.is_done());
        assert!(inner_released.is_done());
        assert!(!late.load(Ordering::Acquire));
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }
}
