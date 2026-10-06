//! External cell anchors owned by one grid. Ring rotation does not touch anchors.

use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;

const RETIRED: u64 = u64::MAX;

/// Coalesced authoritative changes. A tag names the latest attachment state,
/// not a sequence of intermediate positions. Ring/view remapping is one event,
/// independent of the number of attachments in history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnchorEvent {
    Changed(NonZeroU64),
    Retired(NonZeroU64),
    Remapped,
}

/// Wire-independent image bounds in unsigned 32.32 cells, relative to its origin.
/// Keeping the extent with the attachment lets grid mutations distinguish an
/// image crossing a margin from a cell which happens to be inside that margin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageAnchorBounds {
    pub left: u64,
    pub top: u64,
    pub right: u64,
    pub bottom: u64,
}

/// Permanent vertical scissor relative to the original image origin. The grid
/// attachment follows the first surviving row; subtract `top >> 32` to recover
/// the original sampling origin. Endpoints are unsigned 32.32 cells. Scrolling
/// never stretches the remaining pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageAnchorClip {
    pub top: u64,
    pub bottom: u64,
}

pub(super) struct ImageAnchorState {
    pub bounds: ImageAnchorBounds,
    pub clip: ImageAnchorClip,
    source_top: (u64, u64),
    source_bottom: (u64, u64),
    /// Intrusive temporary ownership during a grid mutation, never a second
    /// allocation or a queue which can outlive that mutation.
    pub next: Option<Arc<AnchorState>>,
    pub target_line: i32,
}

impl ImageAnchorState {
    pub fn new(bounds: ImageAnchorBounds) -> Option<Self> {
        if bounds.left >= bounds.right || bounds.top >= bounds.bottom || bounds.top >= 1 << 32 {
            return None;
        }
        Some(Self {
            bounds,
            clip: ImageAnchorClip {
                top: bounds.top,
                bottom: bounds.bottom,
            },
            source_top: (0, 1),
            source_bottom: (1, 1),
            next: None,
            target_line: 0,
        })
    }

    pub fn vertical(&self, line: i32) -> (i128, i128) {
        let origin = (i128::from(line) - i128::from(self.clip.top >> 32)) << 32;
        (
            origin + i128::from(self.clip.top),
            origin + i128::from(self.clip.bottom),
        )
    }

    pub fn resize(&mut self, bounds: ImageAnchorBounds) -> bool {
        if Self::new(bounds).is_none() {
            return false;
        }
        let new_height = u128::from(bounds.bottom - bounds.top);
        // Preserve the source interval, including a fractional cut, when cell
        // metrics change. Full-image endpoints remain exact under every resize.
        let top = bounds.top
            + (u128::from(self.source_top.0) * new_height).div_ceil(u128::from(self.source_top.1))
                as u64;
        let bottom = bounds.top
            + ((u128::from(self.source_bottom.0) * new_height) / u128::from(self.source_bottom.1))
                as u64;
        if top >= bottom {
            return false;
        }
        self.clip = ImageAnchorClip { top, bottom };
        self.bounds = bounds;
        true
    }

    pub fn record_clip(&mut self) {
        let height = self.bounds.bottom - self.bounds.top;
        self.source_top = (self.clip.top - self.bounds.top, height);
        self.source_bottom = (self.clip.bottom - self.bounds.top, height);
    }
}

/// A cell attachment which follows row movement and column reflow.
///
/// Cloning a grid copies text, but does not copy authority over these handles.
#[derive(Clone, Debug)]
pub struct GridAnchor {
    pub(super) domain: Arc<AnchorDomain>,
    pub(super) state: Arc<AnchorState>,
}

impl GridAnchor {
    /// Retirement is independent of which screen is currently active.
    pub fn is_retired(&self) -> bool {
        self.state.position().is_none()
    }

    pub fn image_clip(&self) -> Option<ImageAnchorClip> {
        self.state.image.as_ref().map(|image| image.lock().clip)
    }
}

/// Retirement reuses the already admitted anchor allocation as a queue node.
/// There is no allocation, capacity growth, or live-anchor scan on grid erasure.
#[derive(Debug, Default)]
pub(super) struct AnchorDomain {
    pub images: AtomicUsize,
    pending: AtomicBool,
    head: Mutex<Option<Arc<AnchorState>>>,
    pub remapped: AtomicBool,
}

impl AnchorDomain {
    pub(super) fn take_event(&self) -> Option<AnchorEvent> {
        if self.remapped.swap(false, Ordering::AcqRel) {
            return Some(AnchorEvent::Remapped);
        }
        if !self.pending.load(Ordering::Acquire) {
            return None;
        }
        let mut head = self.head.lock();
        while let Some(state) = head.take() {
            let retirement = state.retirement.as_ref().expect("queued tagged anchor");
            let mut queued = retirement.queue.lock();
            *head = queued.next.take();
            retirement.queued.store(false, Ordering::Release);
            self.pending.store(head.is_some(), Ordering::Release);
            if queued.notify {
                return Some(if state.position().is_some() {
                    AnchorEvent::Changed(retirement.tag)
                } else {
                    AnchorEvent::Retired(retirement.tag)
                });
            }
        }
        None
    }
}

impl Drop for AnchorDomain {
    fn drop(&mut self) {
        // A discarded grid may still have queued notifications. Unlink iteratively
        // so dropping a whole scrollback cannot recurse through thousands of nodes.
        let mut head = self.head.get_mut().take();
        while let Some(state) = head {
            head = state
                .retirement
                .as_ref()
                .and_then(|retirement| retirement.queue.lock().next.take());
        }
    }
}

struct Retirement {
    domain: Weak<AnchorDomain>,
    tag: NonZeroU64,
    queue: Mutex<Notification>,
    queued: AtomicBool,
}

#[derive(Default)]
struct Notification {
    next: Option<Arc<AnchorState>>,
    notify: bool,
}

pub(super) struct AnchorState {
    position: AtomicU64,
    retirement: Option<Retirement>,
    pub image: Option<Mutex<ImageAnchorState>>,
}

impl std::fmt::Debug for AnchorState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never follow the intrusive queue in diagnostics: it can contain every
        // anchor in scrollback and must not consume one stack frame per node.
        formatter
            .debug_struct("AnchorState")
            .field("position", &self.position())
            .field(
                "tag",
                &self.retirement.as_ref().map(|retirement| retirement.tag),
            )
            .finish()
    }
}

impl AnchorState {
    pub(super) fn new(
        slot: u32,
        column: u32,
        domain: &Arc<AnchorDomain>,
        tag: Option<NonZeroU64>,
    ) -> Self {
        Self {
            position: AtomicU64::new((u64::from(slot) << 32) | u64::from(column)),
            retirement: tag.map(|tag| Retirement {
                domain: Arc::downgrade(domain),
                tag,
                queue: Mutex::new(Notification::default()),
                queued: AtomicBool::new(false),
            }),
            image: None,
        }
    }

    pub(super) fn position(&self) -> Option<(usize, usize)> {
        let position = self.position.load(Ordering::Relaxed);
        (position != RETIRED).then_some(((position >> 32) as usize, position as u32 as usize))
    }

    fn column(&self) -> usize {
        self.position.load(Ordering::Relaxed) as u32 as usize
    }

    fn set_column(self: &Arc<Self>, column: usize) {
        let column = u32::try_from(column).expect("grid column fits an anchor");
        let old = self.position.load(Ordering::Relaxed);
        let next = (old & !u64::from(u32::MAX)) | u64::from(column);
        if old != next {
            self.position.store(next, Ordering::Relaxed);
            self.changed();
        }
    }

    pub(super) fn set_slot(self: &Arc<Self>, slot: u32) {
        let old = self.position.load(Ordering::Relaxed);
        let next = (u64::from(slot) << 32) | (old & u64::from(u32::MAX));
        if old != next {
            self.position.store(next, Ordering::Relaxed);
            self.changed();
        }
    }

    pub(super) fn changed(self: &Arc<Self>) {
        let Some(retirement) = &self.retirement else {
            return;
        };
        // A pending tag already represents the latest state. Repeated grid swaps
        // need neither the domain's reference count nor either queue lock.
        if retirement.queued.load(Ordering::Acquire) {
            return;
        }
        let Some(domain) = retirement.domain.upgrade() else {
            return;
        };
        self.notify(&domain, retirement, true);
    }

    fn notify(self: &Arc<Self>, domain: &AnchorDomain, retirement: &Retirement, notify: bool) {
        let mut head = domain.head.lock();
        let mut queued = retirement.queue.lock();
        queued.notify = notify;
        if !notify || retirement.queued.load(Ordering::Relaxed) {
            return;
        }
        queued.next = head.take();
        retirement.queued.store(true, Ordering::Release);
        *head = Some(Arc::clone(self));
        domain.pending.store(true, Ordering::Release);
    }

    pub(super) fn retire(self: &Arc<Self>, notify: bool) {
        if self.position.swap(RETIRED, Ordering::Relaxed) == RETIRED {
            return;
        }
        let Some(retirement) = &self.retirement else {
            return;
        };
        let Some(domain) = retirement.domain.upgrade() else {
            return;
        };
        if self.image.is_some() {
            domain.images.fetch_sub(1, Ordering::Relaxed);
        }
        self.notify(&domain, retirement, notify);
    }
}

/// Optional per-row metadata; cells and unanchored rows allocate nothing for anchors.
/// Tree storage contracts with live membership. A mostly deleted vector would
/// retain peak capacity after the deleted placements refunded their leases.
#[derive(Debug, Default)]
pub(super) struct Anchors(BTreeMap<usize, Arc<AnchorState>>);

impl Anchors {
    pub(super) fn extract_images(&mut self, mut visit: impl FnMut(&Arc<AnchorState>) -> bool) {
        self.0
            .retain(|_, state| state.image.is_none() || !visit(state));
    }

    pub(super) fn retire_intersecting_images(&mut self, line: i32, top: i32, bottom: i32) {
        self.0.retain(|_, state| {
            let intersects = state.image.as_ref().is_some_and(|image| {
                let (first, last) = image.lock().vertical(line);
                first < (i128::from(bottom) << 32) && last > (i128::from(top) << 32)
            });
            if intersects {
                state.retire(true);
            }
            !intersects
        });
    }

    pub(super) fn add(&mut self, state: Arc<AnchorState>) {
        self.0.insert(Arc::as_ptr(&state) as usize, state);
    }

    pub(super) fn remove(&mut self, state: &Arc<AnchorState>) -> bool {
        let Some(state) = self.0.remove(&(Arc::as_ptr(state) as usize)) else {
            return false;
        };
        state.retire(false);
        true
    }

    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(super) fn extent(&self) -> usize {
        self.0
            .values()
            .map(|state| state.column() + 1)
            .max()
            .unwrap_or(0)
    }

    pub(super) fn set_slot(&self, slot: usize) {
        let slot = u32::try_from(slot).expect("grid storage fits an anchor");
        for state in self.0.values() {
            state.set_slot(slot);
        }
    }

    pub(super) fn shift(&self, columns: usize) {
        for state in self.0.values() {
            state.set_column(state.column() + columns);
        }
    }

    pub(super) fn split(&mut self, column: usize) -> Self {
        let mut tail = Self::default();
        self.0.retain(|key, state| {
            if state.column() >= column {
                state.set_column(state.column() - column);
                tail.0.insert(*key, Arc::clone(state));
                false
            } else {
                true
            }
        });
        tail
    }

    pub(super) fn append(&mut self, other: &mut Self, offset: usize) {
        other.shift(offset);
        self.0.append(&mut other.0);
    }
}

impl Drop for Anchors {
    fn drop(&mut self) {
        for state in self.0.values() {
            state.retire(true);
        }
    }
}
