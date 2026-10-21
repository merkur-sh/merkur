//! The native recorder: site registry, ring pool, thread claims, owner fencing, capture.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use crate::Site;
use crate::clock::{self, Calibration};

/// Resource bound: distinct sites one process can name. Every site is a `static`, so the
/// count is fixed by the code; a site past the bound is refused and counted.
pub const MAX_SITES: usize = 1_024;

/// Resource bound: rings in the production pool, one per thread recording during a capture.
/// The dataplane's recording threads (its Tokio workers, PTY reader and writer, display
/// prepare worker) number well under it; a thread past it is refused and counted.
const POOL_RINGS: usize = 64;

/// Resource bound: words per production ring, 8 MiB. Pages are zero-filled on first touch,
/// so an idle ring costs address space, not memory. One ring holds 55k evidence records or
/// 500k span events.
const POOL_RING_WORDS: usize = 1 << 20;

const PHASE_EVIDENCE: u64 = 0;
pub(crate) const PHASE_BEGIN: u8 = 1;
pub(crate) const PHASE_END: u8 = 2;
pub(crate) const PHASE_MARK: u8 = 3;
/// A claimant's first record: the id of the thread whose records follow in that ring.
const PHASE_THREAD: u64 = 4;

/// Header, `Instant` nanoseconds, ordinal, 16 fields.
const EVIDENCE_WORDS: usize = 19;
/// The longest record: header, counter, value.
const MAX_SPAN_WORDS: usize = 3;

static SITES: [AtomicPtr<Site>; MAX_SITES] =
    [const { AtomicPtr::new(std::ptr::null_mut()) }; MAX_SITES];
static NEXT_SITE: AtomicUsize = AtomicUsize::new(0);

/// The production recorder, created by the first `begin`.
static GLOBAL: OnceLock<&'static Recorder> = OnceLock::new();
/// The production recorder's active owner, mirrored so a disabled span is one load.
static SPAN_OWNER: AtomicU64 = AtomicU64::new(0);
static NEXT_RECORDER: AtomicUsize = AtomicUsize::new(1);

thread_local! {
    /// The ring this thread writes and the recorder it belongs to.
    static CLAIMED: Cell<(usize, *const Ring)> = const { Cell::new((0, std::ptr::null())) };
    /// Returns the claimed ring to its pool when the thread exits.
    static RELEASE: Release = const { Release };
}

struct Release;

impl Drop for Release {
    fn drop(&mut self) {
        if let Ok((_, ring)) = CLAIMED.try_with(|claimed| claimed.replace((0, std::ptr::null())))
            && !ring.is_null()
        {
            // SAFETY: a claimed ring lives in a leaked, `'static` recorder's pool.
            unsafe { &*ring }.claimed.store(false, Ordering::Release);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub owner: u64,
}

#[derive(Clone, Debug)]
pub struct Owner {
    pub owner: u64,
    pub peer_id: String,
    pub session_id: String,
    pub observation_epoch: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Evidence {
    pub ordinal: u64,
    /// Nanoseconds since the recorder's origin `Instant`.
    pub at_ns: u64,
    pub site: u32,
    pub fields: [u64; 16],
}

#[derive(Clone, Copy, Debug)]
pub struct SpanEvent {
    /// The writing thread's system id (`pthread_threadid_np`, `gettid`).
    pub thread: u64,
    pub site: u32,
    pub phase: u8,
    /// Nanoseconds since the recorder's origin, mapped from the span counter.
    pub at_ns: u64,
    pub arg: u64,
}

pub struct Snapshot {
    pub owner: Owner,
    /// Sorted by ordinal.
    pub evidence: Vec<Evidence>,
    /// Grouped by thread, each thread's events in the order it wrote them.
    pub spans: Vec<SpanEvent>,
    /// Current-owner records refused: a full ring, an exhausted pool or site table.
    pub dropped: u64,
    /// Records of earlier owners: informational, never current loss.
    pub stale: u64,
    /// The span counter's offset moved during the capture (the machine slept), so span
    /// times after the move are wrong. A capture with it set proves nothing about timing.
    pub discontinuous: bool,
    pub(crate) sites: Vec<Option<&'static str>>,
    /// The origin `Instant` on the anchor clock, within `clock_error_ns`.
    pub(crate) origin_anchor_ns: u64,
    pub(crate) clock_error_ns: u64,
}

impl Snapshot {
    pub fn site_name(&self, site: u32) -> Option<&'static str> {
        let index = usize::try_from(site).ok()?.checked_sub(1)?;
        self.sites.get(index).copied().flatten()
    }
}

struct Ring {
    words: Box<[AtomicU64]>,
    mask: usize,
    /// Advanced only by the claiming thread.
    head: AtomicUsize,
    /// Advanced only under the recorder's metadata lock.
    tail: AtomicUsize,
    claimed: AtomicBool,
    /// The thread that wrote the record at `tail`, from the last thread marker drained.
    /// Metadata lock held. A released ring keeps its unread records, so one ring can hold
    /// several threads' runs, each opened by its marker.
    reader_tid: AtomicU64,
}

impl Ring {
    fn new(words: usize) -> Self {
        assert!(words.is_power_of_two(), "ring words must be a power of two");
        Self {
            words: zeroed_words(words),
            mask: words - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
            claimed: AtomicBool::new(false),
            reader_tid: AtomicU64::new(0),
        }
    }

    fn is_empty(&self) -> bool {
        self.head.load(Ordering::Acquire) == self.tail.load(Ordering::Acquire)
    }

    #[inline(always)]
    fn push<const N: usize>(&self, record: &[u64; N]) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        if head.wrapping_sub(tail) + N > self.words.len() {
            return false;
        }
        for (offset, word) in record.iter().enumerate() {
            if let Some(slot) = self.words.get(head.wrapping_add(offset) & self.mask) {
                slot.store(*word, Ordering::Relaxed);
            }
        }
        self.head.store(head.wrapping_add(N), Ordering::Release);
        true
    }

    /// Hands each published record and its writer's thread id to `visit`, and frees it.
    /// Metadata lock held.
    fn drain(&self, mut visit: impl FnMut(u64, &[u64])) {
        let head = self.head.load(Ordering::Acquire);
        let mut tail = self.tail.load(Ordering::Relaxed);
        let mut tid = self.reader_tid.load(Ordering::Relaxed);
        let mut record = [0u64; EVIDENCE_WORDS];
        while tail != head {
            let word = |offset: usize| {
                self.words
                    .get(tail.wrapping_add(offset) & self.mask)
                    .map_or(0, |slot| slot.load(Ordering::Relaxed))
            };
            let header = word(0);
            let len = usize::try_from(header & 0xff).unwrap_or(0);
            if len == 0 || len > record.len() || len > head.wrapping_sub(tail) {
                // Unreachable for records this module wrote; stop rather than misparse.
                break;
            }
            for (offset, slot) in record.iter_mut().enumerate().take(len) {
                *slot = word(offset);
            }
            if (header >> 8) & 0xff == PHASE_THREAD {
                tid = record.get(1).copied().unwrap_or(0);
            } else {
                visit(tid, record.get(..len).unwrap_or(&[]));
            }
            tail = tail.wrapping_add(len);
        }
        self.reader_tid.store(tid, Ordering::Relaxed);
        self.tail.store(head, Ordering::Release);
    }
}

fn zeroed_words(len: usize) -> Box<[AtomicU64]> {
    let layout = std::alloc::Layout::array::<AtomicU64>(len)
        .unwrap_or_else(|_| std::alloc::handle_alloc_error(std::alloc::Layout::new::<u64>()));
    // SAFETY: `layout` has a non-zero size, because a ring holds at least one word.
    let memory = unsafe { std::alloc::alloc_zeroed(layout) };
    if memory.is_null() {
        std::alloc::handle_alloc_error(layout);
    }
    let words = std::ptr::slice_from_raw_parts_mut(memory.cast::<AtomicU64>(), len);
    // SAFETY: `words` is a fresh allocation of `len` `AtomicU64`s with this exact layout,
    // and all-zero bits are a valid `AtomicU64`, so the box owns initialized values.
    unsafe { Box::from_raw(words) }
}

#[inline(always)]
fn header(owner: u64, site: u32, phase: u64, len: usize) -> u64 {
    (owner << 32) | (u64::from(site) << 16) | (phase << 8) | len as u64
}

fn low_word(value: u64) -> u32 {
    u32::try_from(value & u64::from(u32::MAX)).unwrap_or(u32::MAX)
}

fn site_of(header: u64) -> u32 {
    u32::try_from((header >> 16) & 0xffff).unwrap_or(0)
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

fn site_id(site: &'static Site) -> Option<u32> {
    let id = site.id.load(Ordering::Relaxed);
    if id != 0 {
        return Some(id);
    }
    register_site(site)
}

#[cold]
fn register_site(site: &'static Site) -> Option<u32> {
    let slot = NEXT_SITE.fetch_add(1, Ordering::Relaxed);
    let entry = SITES.get(slot)?;
    let id = u32::try_from(slot + 1).ok()?;
    match site
        .id
        .compare_exchange(0, id, Ordering::AcqRel, Ordering::Acquire)
    {
        Ok(_) => {
            entry.store(std::ptr::from_ref(site).cast_mut(), Ordering::Release);
            Some(id)
        }
        // Another thread named this site first; its id stands and this slot stays empty.
        Err(existing) => Some(existing),
    }
}

/// Every named site, indexed by id minus one; an unclaimed slot is `None`.
fn site_names() -> Vec<Option<&'static str>> {
    let count = NEXT_SITE.load(Ordering::Acquire).min(MAX_SITES);
    SITES
        .iter()
        .take(count)
        .map(|entry| {
            let site = entry.load(Ordering::Acquire);
            // SAFETY: a non-null entry points to the `'static` site that stored it.
            (!site.is_null()).then(|| unsafe { &*site }.name)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn thread_id() -> u64 {
    unsafe extern "C" {
        fn pthread_threadid_np(thread: usize, id: *mut u64) -> i32;
    }
    let mut id = 0;
    // SAFETY: a null thread names the calling thread; `id` is a valid, writable `u64`.
    unsafe { pthread_threadid_np(0, &raw mut id) };
    id
}

#[cfg(target_os = "linux")]
fn thread_id() -> u64 {
    // SAFETY: `gettid` has no preconditions.
    u64::try_from(unsafe { libc::gettid() }).unwrap_or(0)
}

struct State {
    owner: Option<Owner>,
    stale_baseline: u64,
    reset_discarded: u64,
    calibration: Option<Calibration>,
}

pub(crate) struct Recorder {
    id: usize,
    origin: Instant,
    origin_anchor_ns: u64,
    origin_error_ns: u64,
    active: AtomicU64,
    next_owner: AtomicU64,
    next_ordinal: AtomicU64,
    /// High word = exact process observation owner, low word = full refusals.
    /// Atomic tagging prevents a delayed old producer crediting new-owner loss.
    /// Owner allocation fails before u32 wrap; refusal counts saturate at
    /// u32::MAX per capture, which is always a positive incompleteness verdict.
    full_drops: AtomicU64,
    stale: AtomicU64,
    state: Mutex<State>,
    rings: Box<[Ring]>,
    /// Whether this is the production recorder, whose owner `SPAN_OWNER` mirrors.
    global: bool,
}

impl Recorder {
    pub(crate) fn leak(rings: usize, words: usize, global: bool) -> &'static Self {
        let before = clock::anchor_ns();
        let origin = Instant::now();
        let after = clock::anchor_ns();
        Box::leak(Box::new(Self {
            id: NEXT_RECORDER.fetch_add(1, Ordering::Relaxed),
            origin,
            origin_anchor_ns: before + after.saturating_sub(before) / 2,
            origin_error_ns: after.saturating_sub(before) / 2 + clock::ANCHOR_QUANTUM_NS,
            active: AtomicU64::new(0),
            next_owner: AtomicU64::new(1),
            next_ordinal: AtomicU64::new(1),
            full_drops: AtomicU64::new(0),
            stale: AtomicU64::new(0),
            state: Mutex::new(State {
                owner: None,
                stale_baseline: 0,
                reset_discarded: 0,
                calibration: None,
            }),
            rings: (0..rings).map(|_| Ring::new(words)).collect(),
            global,
        }))
    }

    #[inline(always)]
    fn ring(&'static self) -> Option<&'static Ring> {
        let (recorder, ring) = CLAIMED.try_with(Cell::get).ok()?;
        if recorder == self.id && !ring.is_null() {
            // SAFETY: the claimed ring lives in this leaked, `'static` recorder's pool.
            return Some(unsafe { &*ring });
        }
        self.claim()
    }

    #[cold]
    fn claim(&'static self) -> Option<&'static Ring> {
        // An empty ring first: a released ring keeps its unread records, and a claimant
        // appending to them shares that ring's capacity with the thread that left them.
        let tid = thread_id();
        let ring = [true, false].into_iter().find_map(|empty_only| {
            self.rings.iter().find(|ring| {
                (!empty_only || ring.is_empty())
                    && ring
                        .claimed
                        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
                        .is_ok()
                    && (ring.push(&[header(0, 0, PHASE_THREAD, 2), tid]) || {
                        ring.claimed.store(false, Ordering::Release);
                        false
                    })
            })
        })?;
        // First touch registers the exit hook that returns the ring. A thread already
        // tearing down its locals gets none, and returns the ring at once.
        let Ok(previous) = RELEASE
            .try_with(|_| ())
            .and_then(|()| CLAIMED.try_with(|claimed| claimed.replace((self.id, ring))))
        else {
            ring.claimed.store(false, Ordering::Release);
            return None;
        };
        if !previous.1.is_null() {
            // A thread writing a second recorder (tests only) returns its first ring.
            // SAFETY: a claimed ring lives in a leaked, `'static` recorder's pool.
            unsafe { &*previous.1 }
                .claimed
                .store(false, Ordering::Release);
        }
        Some(ring)
    }

    pub(crate) fn begin(&'static self, peer_id: &str, session_id: &str, epoch: u32) -> Token {
        // Only the owner loop starts observations. No producer takes this
        // metadata lock; old work retains its exact token through a reset.
        self.set_active(0);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let owner = self.next_owner.fetch_add(1, Ordering::Relaxed);
        assert!(owner <= u64::from(u32::MAX), "native trace owner exhausted");
        let mut discarded = 0u64;
        for ring in &self.rings {
            ring.drain(|_, _| discarded += 1);
        }
        let previous_loss = low_word(self.full_drops.swap(owner << 32, Ordering::AcqRel));
        // Reset censoring is informational stale evidence, never missing
        // records of the successor observation. It cannot become "dropped".
        state.reset_discarded = state
            .reset_discarded
            .saturating_add(discarded)
            .saturating_add(u64::from(previous_loss));
        state.stale_baseline = self.stale.load(Ordering::Relaxed);
        state.owner = Some(Owner {
            owner,
            peer_id: peer_id.to_owned(),
            session_id: session_id.to_owned(),
            observation_epoch: epoch,
        });
        state.calibration = Some(Calibration::measure());
        self.set_active(owner);
        Token { owner }
    }

    fn set_active(&self, owner: u64) {
        self.active.store(owner, Ordering::Release);
        if self.global {
            SPAN_OWNER.store(owner, Ordering::Release);
        }
    }

    pub(crate) fn end(&self, token: Token) -> bool {
        let ended = self
            .active
            .compare_exchange(token.owner, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        if ended && self.global {
            SPAN_OWNER.store(0, Ordering::Release);
        }
        ended
    }

    pub(crate) fn record(
        &'static self,
        token: Token,
        at: Instant,
        site: &'static Site,
        fields: [u64; 16],
    ) {
        if self.active.load(Ordering::Acquire) != token.owner {
            self.stale.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let Some(id) = site_id(site) else {
            self.note_full(token);
            return;
        };
        let ordinal = self.next_ordinal.fetch_add(1, Ordering::Relaxed);
        let mut words = [0u64; EVIDENCE_WORDS];
        let (head, body) = words.split_at_mut(3);
        head.copy_from_slice(&[
            header(token.owner, id, PHASE_EVIDENCE, EVIDENCE_WORDS),
            nanos(at.saturating_duration_since(self.origin)),
            ordinal,
        ]);
        body.copy_from_slice(&fields);
        if !self.ring().is_some_and(|ring| ring.push(&words)) {
            self.note_full(token);
        }
    }

    #[inline(always)]
    fn push_span<const N: usize>(&'static self, owner: u64, words: &[u64; N]) -> bool {
        let pushed = self.ring().is_some_and(|ring| ring.push(words));
        if !pushed {
            self.note_full(Token { owner });
        }
        pushed
    }

    pub(crate) fn note_full(&self, token: Token) {
        if self
            .full_drops
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |state| {
                (state >> 32 == token.owner).then(|| {
                    (state & !u64::from(u32::MAX)) | u64::from(low_word(state).saturating_add(1))
                })
            })
            .is_err()
        {
            self.stale.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn capture(&'static self) -> Option<Snapshot> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let owner = state.owner.clone()?;
        let ended = Calibration::measure();
        let started = state.calibration.unwrap_or(ended);
        // One bounded drain, not an in-flight-producer barrier. A producer can
        // reserve a lower ordinal and publish it into the following capture.
        // Consumers must join all retained identities, not infer chronology
        // or completeness from capture order or ordinal range subtraction.
        let mut evidence = Vec::new();
        let mut spans = Vec::new();
        let mut filtered = 0u64;
        for ring in &self.rings {
            ring.drain(|thread, record| {
                let Some(&head) = record.first() else {
                    return;
                };
                if head >> 32 != owner.owner {
                    filtered += 1;
                    return;
                }
                match record {
                    [_, at_ns, ordinal, rest @ ..] if (head >> 8) & 0xff == PHASE_EVIDENCE => {
                        let mut fields = [0; 16];
                        for (field, value) in fields.iter_mut().zip(rest) {
                            *field = *value;
                        }
                        evidence.push(Evidence {
                            ordinal: *ordinal,
                            at_ns: *at_ns,
                            site: site_of(head),
                            fields,
                        });
                    }
                    [_, ticks, rest @ ..] => spans.push(SpanEvent {
                        thread,
                        site: site_of(head),
                        phase: u8::try_from((head >> 8) & 0xff).unwrap_or(0),
                        at_ns: started
                            .to_anchor_ns(*ticks)
                            .saturating_sub(self.origin_anchor_ns),
                        arg: rest.first().copied().unwrap_or(0),
                    }),
                    _ => filtered += 1,
                }
            });
        }
        evidence.sort_unstable_by_key(|record| record.ordinal);
        let dropped = u64::from(low_word(
            self.full_drops.swap(owner.owner << 32, Ordering::AcqRel),
        ));
        let stale_total = self.stale.load(Ordering::Relaxed);
        let stale = stale_total
            .saturating_sub(state.stale_baseline)
            .saturating_add(filtered)
            .saturating_add(std::mem::take(&mut state.reset_discarded));
        state.stale_baseline = stale_total;
        Some(Snapshot {
            owner,
            evidence,
            spans,
            dropped,
            stale,
            discontinuous: started.discontinuous(ended),
            sites: site_names(),
            origin_anchor_ns: self.origin_anchor_ns,
            clock_error_ns: self
                .origin_error_ns
                .saturating_add(started.error_ns.max(ended.error_ns)),
        })
    }
}

fn global() -> &'static Recorder {
    GLOBAL.get_or_init(|| Recorder::leak(POOL_RINGS, POOL_RING_WORDS, true))
}

/// Starts a new observation, discarding every unread record of the previous one.
pub fn begin(peer_id: &str, session_id: &str, epoch: u32) -> Token {
    global().begin(peer_id, session_id, epoch)
}

/// Ends `token`'s observation; `false` when a newer one already replaced it.
pub fn end(token: Token) -> bool {
    GLOBAL.get().is_some_and(|recorder| recorder.end(token))
}

pub fn active_token() -> Option<Token> {
    let owner = GLOBAL.get()?.active.load(Ordering::Acquire);
    (owner != 0).then_some(Token { owner })
}

/// Records one evidence record stamped `at`, refused as stale unless `token` is current.
pub fn record(token: Token, at: Instant, site: &'static Site, fields: [u64; 16]) {
    if let Some(recorder) = GLOBAL.get() {
        recorder.record(token, at, site, fields);
    }
}

/// Microseconds from the recorder's origin to `at`, the time base of evidence records.
pub fn elapsed_us(at: Instant) -> u64 {
    GLOBAL.get().map_or(0, |recorder| {
        u64::try_from(at.saturating_duration_since(recorder.origin).as_micros()).unwrap_or(u64::MAX)
    })
}

/// Drains the current observation. `None` before the first `begin`.
pub fn capture() -> Option<Snapshot> {
    GLOBAL.get()?.capture()
}

/// Claims this thread's ring before its first record, so the claim and the exit hook's
/// registration stay off whatever it records first. A thread that skips it claims lazily.
pub fn claim_thread() {
    if let Some(recorder) = GLOBAL.get() {
        recorder.ring();
    }
}

/// Closes its span when dropped.
pub struct SpanGuard {
    recorder: &'static Recorder,
    owner: u64,
    site: u32,
}

impl Drop for SpanGuard {
    #[inline(always)]
    fn drop(&mut self) {
        self.recorder.push_span(
            self.owner,
            &[
                header(self.owner, self.site, PHASE_END.into(), 2),
                clock::ticks(),
            ],
        );
    }
}

#[inline(always)]
fn span_owner() -> Option<(u64, &'static Recorder)> {
    let owner = SPAN_OWNER.load(Ordering::Relaxed);
    if owner == 0 {
        return None;
    }
    Some((owner, *GLOBAL.get()?))
}

/// Opens a span on `site`; `None` while no observation is active or the record is refused.
#[inline(always)]
pub fn span(site: &'static Site) -> Option<SpanGuard> {
    let (owner, recorder) = span_owner()?;
    let id = site_id(site)?;
    recorder
        .push_span(
            owner,
            &[header(owner, id, PHASE_BEGIN.into(), 2), clock::ticks()],
        )
        .then_some(SpanGuard {
            recorder,
            owner,
            site: id,
        })
}

/// Opens a span on `site` that carries `arg`.
#[inline(always)]
pub fn span_arg(site: &'static Site, arg: u64) -> Option<SpanGuard> {
    let (owner, recorder) = span_owner()?;
    let id = site_id(site)?;
    recorder
        .push_span(
            owner,
            &[
                header(owner, id, PHASE_BEGIN.into(), MAX_SPAN_WORDS),
                clock::ticks(),
                arg,
            ],
        )
        .then_some(SpanGuard {
            recorder,
            owner,
            site: id,
        })
}

/// Records an instant on `site` carrying `arg`, such as one end of a channel hop.
#[inline(always)]
pub fn mark(site: &'static Site, arg: u64) {
    let Some((owner, recorder)) = span_owner() else {
        return;
    };
    let Some(id) = site_id(site) else {
        return;
    };
    recorder.push_span(
        owner,
        &[
            header(owner, id, PHASE_MARK.into(), MAX_SPAN_WORDS),
            clock::ticks(),
            arg,
        ],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    static DISPLAY_ATTEMPT: Site = Site::new("display_attempt");
    static DISPLAY_MEMBER: Site = Site::new("display_member");

    /// One ring of 64 words holds three evidence records (57 words).
    fn small() -> &'static Recorder {
        Recorder::leak(1, 64, false)
    }

    fn attempt(recorder: &'static Recorder, token: Token) {
        recorder.record(token, Instant::now(), &DISPLAY_ATTEMPT, [0; 16]);
    }

    /// Writes an evidence record as a producer that passed its owner check before a reset
    /// would: straight into this thread's ring, under any owner and ordinal.
    fn publish(recorder: &'static Recorder, owner: u64, ordinal: u64) {
        let id = site_id(&DISPLAY_ATTEMPT).unwrap();
        let mut words = [0u64; EVIDENCE_WORDS];
        words[0] = header(owner, id, PHASE_EVIDENCE, EVIDENCE_WORDS);
        words[1] = ordinal;
        words[2] = ordinal;
        assert!(recorder.ring().unwrap().push(&words));
    }

    #[test]
    fn bounded_records_report_only_actual_full_refusals() {
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        for _ in 0..4 {
            attempt(recorder, token);
        }
        {
            let _held = recorder.state.lock().unwrap();
            attempt(recorder, token);
        }
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.evidence.len(), 3);
        assert_eq!(snapshot.dropped, 2);
        assert_eq!(recorder.capture().unwrap().dropped, 0);
    }

    #[test]
    fn producers_never_take_the_cold_metadata_lock() {
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        {
            let _held = recorder.state.lock().unwrap();
            attempt(recorder, token);
        }
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.evidence.len(), 1);
        assert_eq!(snapshot.dropped, 0);
    }

    #[test]
    fn old_owner_refusal_cannot_increment_the_successor_drop_count() {
        let recorder = small();
        let old = recorder.begin("peer", "old", 1);
        let current = recorder.begin("peer", "new", 2);
        // The old producer passed its active check before reset but reached
        // a full ring afterward. The tagged compare-update is the race fence.
        recorder.note_full(old);
        recorder.note_full(current);
        recorder.note_full(old);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.dropped, 1);
        assert_eq!(snapshot.stale, 2);
        assert_eq!(snapshot.owner.owner, current.owner);
        assert_eq!(recorder.capture().unwrap().dropped, 0);
    }

    #[test]
    fn reset_discard_and_late_old_publication_are_informational_not_current_loss() {
        let recorder = small();
        let old = recorder.begin("peer", "old", 1);
        attempt(recorder, old);
        let current = recorder.begin("peer", "new", 2);
        // A producer whose owner check preceded the reset publishes afterward.
        // Capture must not relabel its owner.
        publish(recorder, old.owner, 2);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.owner.owner, current.owner);
        assert!(snapshot.evidence.is_empty());
        assert_eq!(snapshot.stale, 2);
        assert_eq!(snapshot.dropped, 0);
    }

    #[test]
    fn capture_preserves_late_reserved_ordinals_without_a_producer_barrier() {
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        publish(recorder, token.owner, 3);
        publish(recorder, token.owner, 2);
        let first = recorder.capture().unwrap();
        let ordinals: Vec<_> = first.evidence.iter().map(|record| record.ordinal).collect();
        assert_eq!(ordinals, [2, 3]);
        publish(recorder, token.owner, 1);
        let second = recorder.capture().unwrap();
        assert_eq!(second.evidence[0].ordinal, 1);
        assert_eq!(second.dropped, 0);
    }

    #[test]
    fn refusal_counter_saturates_instead_of_corrupting_its_owner_tag() {
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        recorder
            .full_drops
            .store((token.owner << 32) | u64::from(u32::MAX), Ordering::Relaxed);
        recorder.note_full(token);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.dropped, u64::from(u32::MAX));
        assert_eq!(
            recorder.full_drops.load(Ordering::Relaxed),
            token.owner << 32
        );
    }

    #[test]
    fn stale_tokens_cannot_write_or_disable_successor_observations() {
        let recorder = small();
        let old = recorder.begin("peer", "old", 1);
        let current = recorder.begin("peer", "new", 2);
        recorder.record(old, Instant::now(), &DISPLAY_MEMBER, [0; 16]);
        recorder.record(current, Instant::now(), &DISPLAY_MEMBER, [0; 16]);
        assert!(!recorder.end(old));
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.owner.session_id, "new");
        assert_eq!(snapshot.evidence.len(), 1);
        assert_eq!(
            snapshot.site_name(snapshot.evidence[0].site),
            Some("display_member")
        );
        assert!(recorder.end(current));
    }

    #[test]
    fn evidence_keeps_its_instant_and_fields_exactly() {
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        let at = recorder.origin + Duration::from_nanos(123_456);
        let mut fields = [0; 16];
        fields[0] = 9;
        fields[15] = u64::MAX;
        recorder.record(token, at, &DISPLAY_MEMBER, fields);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.evidence[0].at_ns, 123_456);
        assert_eq!(snapshot.evidence[0].fields, fields);
    }

    #[test]
    fn a_thread_returns_its_ring_when_it_exits() {
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        for _ in 0..2 {
            std::thread::spawn(move || attempt(recorder, token))
                .join()
                .unwrap();
        }
        let snapshot = recorder.capture().unwrap();
        assert_eq!(
            snapshot.evidence.len(),
            2,
            "the second thread reused the first one's ring"
        );
        assert_eq!(snapshot.dropped, 0);
    }

    #[test]
    fn a_reused_ring_attributes_each_run_to_the_thread_that_wrote_it() {
        static STEP: Site = Site::new("test.step");
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        let tids: Vec<u64> = (0..2)
            .map(|_| {
                std::thread::spawn(move || {
                    let id = site_id(&STEP).unwrap();
                    recorder.push_span(
                        token.owner,
                        &[
                            header(token.owner, id, PHASE_MARK.into(), 3),
                            clock::ticks(),
                            1,
                        ],
                    );
                    thread_id()
                })
                .join()
                .unwrap()
            })
            .collect();
        assert_ne!(tids[0], tids[1]);
        let snapshot = recorder.capture().unwrap();
        let threads: Vec<_> = snapshot.spans.iter().map(|event| event.thread).collect();
        assert_eq!(
            threads, tids,
            "both runs share the one ring, each under its own thread"
        );
    }

    #[test]
    fn an_exhausted_pool_refuses_and_counts() {
        let recorder = small();
        let token = recorder.begin("peer", "session", 1);
        let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            attempt(recorder, token);
            claimed_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        claimed_rx.recv().unwrap();
        std::thread::spawn(move || attempt(recorder, token))
            .join()
            .unwrap();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.evidence.len(), 1);
        assert_eq!(snapshot.dropped, 1);
    }

    #[test]
    fn producer_recording_allocates_nothing_after_its_claim() {
        let recorder = Recorder::leak(1, 1 << 15, false);
        let token = recorder.begin("peer", "session", 1);
        let at = Instant::now();
        recorder.ring().unwrap();
        site_id(&DISPLAY_ATTEMPT).unwrap();
        let before = allocations::count();
        for _ in 0..1_024 {
            recorder.record(token, at, &DISPLAY_ATTEMPT, [0; 16]);
        }
        assert_eq!(allocations::count(), before);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.evidence.len(), 1_024);
        assert_eq!(snapshot.dropped, 0);
    }

    #[test]
    fn concurrent_producers_keep_every_record_once() {
        const PER_PRODUCER: u64 = 2_000;
        let recorder = Recorder::leak(8, 1 << 16, false);
        let token = recorder.begin("probe", "probe-session", 1);
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let producers: Vec<_> = (0..4u64)
            .map(|producer| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    for index in 0..PER_PRODUCER {
                        let mut fields = [0; 16];
                        fields[0] = producer;
                        fields[1] = index;
                        recorder.record(token, Instant::now(), &DISPLAY_ATTEMPT, fields);
                    }
                })
            })
            .collect();
        for producer in producers {
            producer.join().unwrap();
        }
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.dropped, 0);
        assert_eq!(snapshot.evidence.len() as u64, 4 * PER_PRODUCER);
        let mut seen = std::collections::HashSet::new();
        for record in &snapshot.evidence {
            assert!(
                seen.insert((record.fields[0], record.fields[1])),
                "duplicate record"
            );
        }
        assert!(
            snapshot
                .evidence
                .windows(2)
                .all(|pair| pair[0].ordinal < pair[1].ordinal)
        );
    }

    /// The production recorder is process-wide; tests that drive it take turns.
    static GLOBAL_TURN: Mutex<()> = Mutex::new(());

    #[test]
    fn spans_record_on_the_calling_thread_in_order_and_stop_with_the_observation() {
        let _turn = GLOBAL_TURN.lock().unwrap_or_else(PoisonError::into_inner);
        let token = begin("peer", "session", 1);
        {
            let _outer = crate::span!("test.outer");
            let _inner = crate::span!("test.inner", 42);
            mark(&DISPLAY_MEMBER, 7);
        }
        assert!(end(token));
        assert!(crate::span!("test.after").is_none());
        let snapshot = capture().unwrap();
        let names: Vec<_> = snapshot
            .spans
            .iter()
            .map(|event| {
                (
                    snapshot.site_name(event.site).unwrap(),
                    event.phase,
                    event.arg,
                )
            })
            .collect();
        assert_eq!(
            names,
            [
                ("test.outer", PHASE_BEGIN, 0),
                ("test.inner", PHASE_BEGIN, 42),
                ("display_member", PHASE_MARK, 7),
                ("test.inner", PHASE_END, 0),
                ("test.outer", PHASE_END, 0),
            ]
        );
        assert!(
            snapshot
                .spans
                .windows(2)
                .all(|pair| pair[0].at_ns <= pair[1].at_ns)
        );
        assert!(
            snapshot
                .spans
                .iter()
                .all(|event| event.thread == snapshot.spans[0].thread)
        );
        assert!(!snapshot.discontinuous);
    }

    #[test]
    fn span_times_land_on_the_evidence_time_base() {
        let _turn = GLOBAL_TURN.lock().unwrap_or_else(PoisonError::into_inner);
        let token = begin("peer", "session", 1);
        let before = Instant::now();
        {
            let _span = crate::span!("test.timed");
            std::hint::black_box((0..10_000u64).sum::<u64>());
        }
        let after = Instant::now();
        record(token, before, &DISPLAY_ATTEMPT, [0; 16]);
        record(token, after, &DISPLAY_ATTEMPT, [0; 16]);
        end(token);
        let snapshot = capture().unwrap();
        let [first, second] = snapshot.evidence.as_slice() else {
            panic!("two evidence records");
        };
        let slack = snapshot.clock_error_ns;
        for event in &snapshot.spans {
            assert!(
                event.at_ns + slack >= first.at_ns,
                "span starts after its bracket opened"
            );
            assert!(
                event.at_ns <= second.at_ns + slack,
                "span ends before its bracket closed"
            );
        }
        assert!(slack < 1_000, "clock mapping error {slack} ns");
    }

    #[test]
    fn the_clock_mapping_is_continuous_while_awake() {
        let first = Calibration::measure();
        let second = Calibration::measure();
        assert!(!first.discontinuous(second));
        assert!(first.error_ns < 1_000);
        let ticks = clock::ticks();
        assert!(first.to_anchor_ns(ticks) >= first.to_anchor_ns(ticks.saturating_sub(1_000)));
    }

    mod allocations {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;

        thread_local! {
            static COUNT: Cell<u64> = const { Cell::new(0) };
        }

        struct Counting;

        // SAFETY: forwards to the system allocator unchanged; the counter is thread-local.
        unsafe impl GlobalAlloc for Counting {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                COUNT.with(|count| count.set(count.get() + 1));
                // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract.
                unsafe { System.alloc(layout) }
            }

            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                // SAFETY: the caller upholds `GlobalAlloc::dealloc`'s contract.
                unsafe { System.dealloc(ptr, layout) }
            }
        }

        #[global_allocator]
        static ALLOCATOR: Counting = Counting;

        pub(super) fn count() -> u64 {
            COUNT.with(Cell::get)
        }
    }
}
