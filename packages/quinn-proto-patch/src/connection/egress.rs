//! Optional packet admission shared by one application's concrete data attachments.
//!
//! Recovery and packet numbers remain connection-local. The group receives actual
//! packet-byte retirement, not application write completion. No packet owns an Arc
//! or a second ledger entry; the connection's existing SentPacket map is the ledger.
//!
//! The group owns one model of its path (`congestion/egress_model.rs`): image-only
//! packets answer to it alone (its bulk cap, pacer and image window), while
//! interactive packets keep their own connection's CUBIC and pacer and answer to
//! the model's window only as a bound. Rate samples, rounds and losses are the
//! group's, whichever member carried the bytes.
use std::{
    cell::Cell,
    fmt,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    task::Waker,
};

use super::{pacing::Pacer, paths::RttEstimator};
use crate::{
    Duration, Instant,
    congestion::{
        delivery::{DeliveryState, PacketRate},
        egress_model::{EgressModel, RttSample},
    },
};

pub use crate::congestion::egress_model::{EgressModelCounters, EgressPhase};

/// Stream priority reserved for independently cancellable image objects.
pub const EGRESS_IMAGE_PRIORITY: i32 = -2;

/// The two concrete data attachments coordinated by an egress owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EgressClass {
    /// Input, control and ordinary display. Admitted against its own flight
    /// alone and never paced by the group: bulk state cannot delay it.
    Interactive,
    /// Bulk data. Pays for everything interactive sends, yields while
    /// interactive work is queued, and leaves one interactive packet of both
    /// window and pacing tokens unspent.
    Bulk,
}
impl EgressClass {
    fn index(self) -> usize {
        match self {
            Self::Interactive => 0,
            Self::Bulk => 1,
        }
    }
}

/// One path model and pacer for a concrete attachment pair, independent of
/// signaling.
///
/// A caller supplies attachment identity by holding this handle only within one
/// authenticated peer/path owner. Sharing it is a conservative scheduling policy,
/// not a claim that two Internet paths have the same physical bottleneck.
#[derive(Clone)]
pub struct EgressGroup(Arc<Mutex<State>>);
impl fmt::Debug for EgressGroup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EgressGroup")
            .field("stats", &self.stats())
            .finish()
    }
}

/// Exact aggregate credit, including packet construction reservations, and the
/// model that issues it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EgressStats {
    /// Process-unique identity of this group. Its refusal counters are
    /// cumulative per group, so a consumer differences snapshots of one group.
    pub group: u64,
    /// Unique model generation, replaced whenever the path resets.
    pub model_epoch: u64,
    /// The window interactive packets answer to, before subtracting flight or
    /// reservations.
    pub congestion_window: u64,
    /// QUIC bytes in outstanding congestion-controlled packets.
    pub bytes_in_flight: u64,
    /// Credit atomically reserved by packet builders but not yet sent.
    pub reserved_bytes: u64,
    /// Full interactive packet, including QUIC framing and authentication.
    pub interactive_reserve: u64,
    /// Refused admissions of input, control and ordinary display packets.
    pub interactive: EgressAdmissions,
    /// Refused admissions of image packets, whichever attachment builds them.
    pub bulk: EgressAdmissions,
    /// The model's bandwidth, bytes per second.
    pub bw: u64,
    /// The model's RTprop, microseconds.
    pub rtprop_us: u64,
    /// The group pacer's rate for bulk, bytes per second.
    pub pacing_rate: u64,
    /// The flight bulk may bring the group to.
    pub bulk_cap: u64,
    /// One pacing burst, bytes.
    pub quantum: u64,
    /// Where the model's control law is.
    pub phase: EgressPhase,
    /// The model's cumulative events.
    pub model: EgressModelCounters,
}

/// Cumulative refusals of one traffic class over the group's lifetime. A
/// refusal opens a wait at its admission decision and the class's next
/// admitted packet closes it, so `waited` is exact refused time, never sampled.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EgressAdmissions {
    /// Refused for aggregate credit, or bulk yielding to queued interactive work.
    pub blocked: u64,
    /// Refused by the shared pacer; the builder waits for the pacing timer.
    pub paced: u64,
    /// Closed waits: first refusal decision to the next admitted packet.
    pub waited: Duration,
}

/// Admission cannot silently change a live attachment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EgressError {
    /// Closed connections cannot acquire live packet credit.
    #[error("egress attachment is closed")]
    Closed,
    /// The group already has this attachment class.
    #[error("egress attachment class is occupied")]
    Occupied,
    /// An attachment identity cannot be reused.
    #[error("egress attachment identities exhausted")]
    Exhausted,
}

/// Source of `EgressStats::group`.
static NEXT_GROUP: AtomicU64 = AtomicU64::new(1);

struct State {
    id: u64,
    model: EgressModel,
    delivery: DeliveryState,
    pacing: Pacer,
    members: [Option<Slot>; 2],
    /// Indexed by traffic class, not attachment: a replaced member keeps history.
    admissions: [Ledger; 2],
    next_id: u64,
    /// ACK/loss history predating a path reset cannot feed its new model.
    epoch: u64,
}
#[derive(Default)]
struct Ledger {
    stats: EgressAdmissions,
    refused_at: Option<Instant>,
}
impl Ledger {
    fn refuse(&mut self, now: Instant, paced: bool) {
        if paced {
            self.stats.paced += 1;
        } else {
            self.stats.blocked += 1;
        }
        self.refused_at.get_or_insert(now);
    }
    fn admit(&mut self, now: Instant) {
        if let Some(refused_at) = self.refused_at.take() {
            self.stats.waited += now.saturating_duration_since(refused_at);
        }
    }
}
struct Slot {
    id: u64,
    /// Indexed by traffic class, like `reserved`: a direct connection's
    /// image-only packets are bulk's even though its one member is interactive.
    flight: [u64; 2],
    reserved: [u64; 2],
    mtu: u16,
    rtt: RttEstimator,
    ready: bool,
    /// The member's last transmit found nothing it could send while neither
    /// the group's credit nor its pacer held it: an empty queue, or stream,
    /// connection, edge or image-window credit.
    app_limited: bool,
    blocked: bool,
    waiter: Option<Waker>,
}

pub(super) struct Member {
    group: EgressGroup,
    class: EgressClass,
    id: u64,
    // The connection driver owns registration. An unchanged task takes no
    // group lock, including text-only polls after an earlier image transfer.
    waker: Option<Waker>,
}
/// One poll's packet reservations. Drop refunds unused construction credit on
/// every return, including empty packets, pacing, anti-amplification and errors.
pub(super) struct Batch {
    ready_after: Cell<bool>,
    group: EgressGroup,
    class: EgressClass,
    id: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Admission {
    Ready { images: bool },
    Blocked,
    Paced(Instant),
}

impl EgressClass {
    /// The ledger a packet is charged to: its member's class, except that an
    /// image-only packet is bulk's whichever member builds it.
    fn of_packet(self, images_only: bool) -> Self {
        if images_only { Self::Bulk } else { self }
    }
}

impl State {
    fn flight(&self) -> u64 {
        self.members.iter().flatten().flat_map(|m| m.flight).sum()
    }
    fn reserved(&self) -> u64 {
        self.members.iter().flatten().flat_map(|m| m.reserved).sum()
    }
    fn reserve(&self) -> u64 {
        self.members[0].as_ref().map_or(0, |m| m.mtu.into())
    }
    /// Bulk spends only what every packet in flight or under construction, of
    /// either class, leaves under the model's bulk cap, less one full
    /// interactive packet.
    fn bulk_available(&self) -> u64 {
        self.model
            .bulk_cap()
            .saturating_sub(self.flight())
            .saturating_sub(self.reserved())
            .saturating_sub(self.reserve())
    }
    /// Interactive answers only to its own packets, under the model's window.
    /// Image flight never delays it, on either member; what it sends is
    /// charged to bulk through `bulk_available`, so the aggregate exceeds the
    /// model by at most interactive's own flight, and only until bulk's next
    /// admission gives the difference back.
    fn interactive_available(&self) -> u64 {
        let own: u64 = self
            .members
            .iter()
            .flatten()
            .map(|m| {
                let class = EgressClass::Interactive.index();
                m.flight[class].saturating_add(m.reserved[class])
            })
            .sum();
        self.model.cwnd().saturating_sub(own)
    }
    /// No interactive packet in flight or under construction, and no member
    /// with interactive work queued: the only round start a probe may take.
    fn interactive_quiet(&self) -> bool {
        let class = EgressClass::Interactive.index();
        self.members
            .iter()
            .flatten()
            .all(|m| m.flight[class] == 0 && m.reserved[class] == 0 && !m.ready)
    }
    fn max_mtu(&self) -> u16 {
        self.members
            .iter()
            .flatten()
            .map(|m| m.mtu)
            .max()
            .expect("live member")
    }
    fn slot(&mut self, class: EgressClass, id: u64) -> &mut Slot {
        self.members[class.index()]
            .as_mut()
            .filter(|m| m.id == id)
            .expect("live egress member")
    }
}
// A caller-supplied waker may reenter the connection. Publish under the mutex,
// then wake at most two drivers after releasing it; no heap queue is needed.
struct StateGuard<'a> {
    state: Option<MutexGuard<'a, State>>,
    wake: bool,
}
impl std::ops::Deref for StateGuard<'_> {
    type Target = State;
    fn deref(&self) -> &State {
        self.state.as_deref().expect("live state guard")
    }
}
impl std::ops::DerefMut for StateGuard<'_> {
    fn deref_mut(&mut self) -> &mut State {
        self.state.as_deref_mut().expect("live state guard")
    }
}
impl StateGuard<'_> {
    fn wake(&mut self) {
        self.wake = true;
    }
}
impl Drop for StateGuard<'_> {
    fn drop(&mut self) {
        let waiters: [Option<Waker>; 2] = if self.wake {
            std::array::from_fn(|i| {
                self.members[i]
                    .as_ref()
                    .filter(|slot| slot.blocked)
                    .and_then(|slot| slot.waiter.clone())
            })
        } else {
            [None, None]
        };
        drop(self.state.take());
        for waiter in waiters.into_iter().flatten() {
            waiter.wake();
        }
    }
}

impl EgressGroup {
    pub(super) fn new(model: EgressModel, pacing: Pacer, now: Instant) -> Self {
        Self(Arc::new(Mutex::new(State {
            id: NEXT_GROUP.fetch_add(1, Ordering::Relaxed),
            model,
            delivery: DeliveryState::new(now),
            pacing,
            members: [None, None],
            admissions: Default::default(),
            next_id: 1,
            epoch: NEXT_GROUP.fetch_add(1, Ordering::Relaxed),
        })))
    }
    /// A fresh group identity: it seeds the model's probe schedule.
    pub(super) fn next_id() -> u64 {
        NEXT_GROUP.load(Ordering::Relaxed)
    }
    fn lock(&self) -> StateGuard<'_> {
        StateGuard {
            state: Some(self.0.lock().expect("egress state poisoned")),
            wake: false,
        }
    }
    /// Read exact aggregate accounting; this does not issue or reserve credit.
    pub fn stats(&self) -> EgressStats {
        let s = self.lock();
        EgressStats {
            group: s.id,
            model_epoch: s.epoch,
            congestion_window: s.model.cwnd(),
            bytes_in_flight: s.flight(),
            reserved_bytes: s.reserved(),
            interactive_reserve: s.reserve(),
            interactive: s.admissions[EgressClass::Interactive.index()].stats,
            bulk: s.admissions[EgressClass::Bulk.index()].stats,
            bw: s.model.bw(),
            rtprop_us: u64::try_from(s.model.min_rtt().as_micros()).unwrap_or(u64::MAX),
            pacing_rate: s.model.pacing_rate(),
            bulk_cap: s.model.bulk_cap(),
            quantum: s.model.quantum(),
            phase: s.model.phase(),
            model: s.model.counters(),
        }
    }
    /// `flight` is the joining connection's outstanding packet bytes: ordinary
    /// packets first, image-only packets second.
    pub(super) fn attach(
        &self,
        class: EgressClass,
        flight: [u64; 2],
        mtu: u16,
        rtt: RttEstimator,
    ) -> Result<Member, EgressError> {
        let mut s = self.lock();
        if s.members[class.index()].is_some() {
            return Err(EgressError::Occupied);
        }
        let id = s.next_id;
        s.next_id = id.checked_add(1).ok_or(EgressError::Exhausted)?;
        let mut ledgers = [0u64; 2];
        ledgers[class.of_packet(false).index()] += flight[0];
        ledgers[class.of_packet(true).index()] += flight[1];
        s.members[class.index()] = Some(Slot {
            id,
            flight: ledgers,
            reserved: [0; 2],
            mtu,
            rtt,
            ready: false,
            app_limited: true,
            blocked: false,
            waiter: None,
        });
        s.wake();
        Ok(Member {
            group: self.clone(),
            class,
            id,
            waker: None,
        })
    }
}
impl Member {
    pub(super) fn matches(&self, group: &EgressGroup, class: EgressClass) -> bool {
        self.class == class && Arc::ptr_eq(&self.group.0, &group.0)
    }
    pub(super) fn group(&self) -> EgressGroup {
        self.group.clone()
    }
    pub(super) fn batch(&self) -> Batch {
        debug_assert_eq!(self.group.lock().slot(self.class, self.id).reserved, [0; 2]);
        Batch {
            ready_after: Cell::new(false),
            group: self.group.clone(),
            class: self.class,
            id: self.id,
        }
    }
    pub(super) fn register(&mut self, waker: &Waker) {
        if self
            .waker
            .as_ref()
            .is_some_and(|known| known.will_wake(waker))
        {
            return;
        }
        self.waker = Some(waker.clone());
        self.group.lock().slot(self.class, self.id).waiter = Some(waker.clone());
    }
    pub(super) fn ready(&self, ready: bool) {
        let mut s = self.group.lock();
        let slot = s.slot(self.class, self.id);
        if slot.ready != ready {
            slot.ready = ready;
            if !ready {
                s.wake();
            }
        }
    }
    /// The end of one transmit: the member's MTU and RTT, and whether it
    /// found nothing it could send. Returns the image window members apply.
    pub(super) fn update(&self, mtu: u16, rtt: RttEstimator, app_limited: bool) -> u64 {
        let mut s = self.group.lock();
        let slot = s.slot(self.class, self.id);
        slot.mtu = mtu;
        slot.rtt = rtt;
        slot.app_limited = app_limited;
        let mtu = s.max_mtu();
        s.model.on_mtu_update(mtu);
        // Every member has nothing it may send: the samples of what is sent
        // until the current flight is delivered cannot show the path's rate.
        if s.members.iter().flatten().all(|m| m.app_limited) {
            let flight = s.flight();
            s.delivery.mark_app_limited(flight);
        }
        s.model.image_window()
    }
    /// The image window, as the model holds it now.
    pub(super) fn image_window(&self) -> u64 {
        self.group.lock().model.image_window()
    }
    /// Charge a packet of `bytes` to the ledger its admission named and return
    /// its rate snapshot. `images_only` is the packet's admission: an
    /// image-only packet is charged to bulk's ledger even when the interactive
    /// member built it.
    pub(super) fn sent(&self, now: Instant, bytes: u16, images_only: bool) -> Option<PacketRate> {
        if bytes == 0 {
            return None;
        }
        let ledger = self.class.of_packet(images_only).index();
        let mut s = self.group.lock();
        let flight_before = s.flight();
        let mut rate = s.delivery.on_send(now, flight_before);
        rate.epoch = s.epoch;
        let slot = s.slot(self.class, self.id);
        let reserved = slot.reserved[ledger].min(u64::from(bytes));
        slot.reserved[ledger] -= reserved;
        slot.flight[ledger] = slot.flight[ledger]
            .checked_add(bytes.into())
            .expect("bounded QUIC flight");
        // Recovery probes may bypass congestion admission. They still incur
        // exact flight, and their tokens become debt bulk repays; no synthetic
        // capacity is added.
        s.pacing.charge(u64::from(bytes) - reserved);
        if ledger == EgressClass::Bulk.index() {
            s.model.on_bulk_sent(u64::from(bytes));
        }
        Some(rate)
    }
    /// Retire a packet from the ledger its `sent` charged.
    pub(super) fn retired(&self, bytes: u16, images_only: bool) {
        if bytes == 0 {
            return;
        }
        let ledger = self.class.of_packet(images_only).index();
        let mut s = self.group.lock();
        let slot = s.slot(self.class, self.id);
        slot.flight[ledger] = slot.flight[ledger]
            .checked_sub(bytes.into())
            .expect("packet retires exactly once");
        s.wake();
    }
    /// A packet this member sent was acknowledged. A packet from before the
    /// path's last reset only retires flight; it feeds no model.
    pub(super) fn acked(&self, now: Instant, sent: Instant, bytes: u16, rate: Option<&PacketRate>) {
        let Some(rate) = rate else {
            return;
        };
        let mut s = self.group.lock();
        if rate.epoch != s.epoch {
            return;
        }
        s.delivery
            .on_ack(self.class.index(), now, sent, rate, bytes.into());
    }
    /// One ACK frame ended: the model reads its rate sample and the frame's
    /// RTT sample. Returns the image window members apply.
    pub(super) fn end_acks(
        &self,
        now: Instant,
        rtt: Option<RttSample>,
        rate: Option<&PacketRate>,
    ) -> u64 {
        let mut s = self.group.lock();
        let rtt = rtt.filter(|_| rate.is_some_and(|rate| rate.epoch == s.epoch));
        let min_rtt = s.model.min_rtt();
        let sample = s.delivery.take_sample(self.class.index(), min_rtt);
        let flight = s.flight();
        let quiet = s.interactive_quiet();
        let delivered = s.delivery.delivered();
        s.model
            .on_end_acks(now, sample, rtt, flight, quiet, delivered);
        if s.model.is_measurement_limited() {
            s.delivery.mark_app_limited(flight);
        }
        s.wake();
        s.model.image_window()
    }
    /// Packets this member sent were declared lost: `bytes` in all, `ranges`
    /// discontiguous runs, `largest` the most recently sent of them.
    pub(super) fn lost(
        &self,
        _sent: Instant,
        bytes: u64,
        largest: Option<&PacketRate>,
        ranges: u64,
        persistent: bool,
    ) {
        let mut s = self.group.lock();
        let Some(rate) = largest.filter(|rate| rate.epoch == s.epoch) else {
            return;
        };
        s.delivery.on_loss(bytes);
        let lost = s.delivery.lost();
        s.model.on_loss(bytes, rate, lost, ranges, persistent);
        s.wake();
    }
    /// The peer's CE count rose for packets from this model.
    pub(super) fn ce(&self, rate: Option<&PacketRate>) {
        let mut s = self.group.lock();
        if rate.is_none_or(|rate| rate.epoch != s.epoch) {
            return;
        }
        s.model.on_ce();
        s.wake();
    }
    pub(super) fn epoch(&self) -> u64 {
        self.group.lock().epoch
    }
    pub(super) fn reset_path(&self, model: EgressModel, pacing: Pacer, now: Instant) {
        let mut s = self.group.lock();
        s.model = model;
        s.delivery = DeliveryState::new(now);
        s.pacing = pacing;
        let reserved = s.reserved();
        s.pacing.debit(reserved);
        s.epoch = NEXT_GROUP.fetch_add(1, Ordering::Relaxed);
        // Outstanding packets and reservations remain debt. Old ACKs only
        // retire it; they cannot feed the fresh route's model.
        s.wake();
    }
}
impl Batch {
    pub(super) fn ready_after(&self, ready: bool) {
        self.ready_after.set(ready);
    }
    pub(super) fn admit(&self, now: Instant, bytes: u16, images_only: bool) -> Admission {
        let mut s = self.group.lock();
        let bulk = images_only || self.class == EgressClass::Bulk;
        // Refusals are charged to the traffic class, so a direct connection's
        // image-only packets never read as interactive waits.
        let class = if bulk {
            EgressClass::Bulk
        } else {
            EgressClass::Interactive
        };
        let refused = if bulk {
            s.members[0]
                .as_ref()
                .is_some_and(|m| m.ready && m.id != self.id)
                || u64::from(bytes) > s.bulk_available()
        } else {
            u64::from(bytes) > s.interactive_available()
        };
        if refused {
            s.admissions[class.index()].refuse(now, false);
            s.slot(self.class, self.id).blocked = true;
            return Admission::Blocked;
        }
        let images = u64::from(bytes) <= s.bulk_available();
        if bulk {
            // Interactive packets bypass this pacer and charge their bytes as
            // debt. Reserving unspendable tokens for them here would shrink
            // every image burst without improving interactive admission.
            let paced = u64::from(bytes);
            let rate = s.model.pacing_rate();
            let quantum = s.model.quantum().max(paced);
            if let Some(at) = s.pacing.delay_packet(rate, quantum, paced, now) {
                s.admissions[class.index()].refuse(now, true);
                s.slot(self.class, self.id).blocked = true;
                return Admission::Paced(at);
            }
            s.pacing.on_transmit(bytes);
        } else {
            // Interactive never waits on the shared pacer: a pacing wake is a
            // coarse timer, and bulk's debt must not become an input's delay.
            // Its tokens are still spent, as debt when bulk emptied the
            // bucket, and bulk repays that before its next packet. A probe
            // meant a queue this packet would wait behind: it ends here.
            s.pacing.charge(bytes.into());
            s.model.interactive_admitted(now);
        }
        s.admissions[class.index()].admit(now);
        let slot = s.slot(self.class, self.id);
        slot.reserved[class.index()] = slot.reserved[class.index()]
            .checked_add(bytes.into())
            .expect("bounded packet reservation");
        slot.blocked = false;
        Admission::Ready { images }
    }
}
impl Drop for Batch {
    fn drop(&mut self) {
        let mut s = self.group.lock();
        let slot = s.slot(self.class, self.id);
        let unused: u64 = std::mem::take(&mut slot.reserved).into_iter().sum();
        let was_ready = slot.ready;
        slot.ready = self.ready_after.get();
        let released_priority = was_ready && !slot.ready;
        s.pacing.refund(unused);
        if unused != 0 || released_priority {
            s.wake();
        }
    }
}
impl Drop for Member {
    fn drop(&mut self) {
        let mut s = self.group.lock();
        let slot = s.members[self.class.index()]
            .take()
            .expect("live egress member");
        assert_eq!(slot.id, self.id);
        assert_eq!(
            slot.reserved, [0; 2],
            "packet batch must retire before connection membership"
        );
        s.wake();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Duration;

    /// A group whose model holds `window` in Startup (its bulk cap is the
    /// seeded window) and paces at `2.77·window/srtt`.
    fn group_with(window: u64, srtt: Duration) -> (Instant, EgressGroup, Member, Member) {
        let now = Instant::now();
        let model = EgressModel::new(now, 1200, srtt, window, srtt, 1);
        let rtt = RttEstimator::new(srtt);
        let pacing = Pacer::new(model.quantum(), now);
        let group = EgressGroup::new(model, pacing, now);
        let interactive = group
            .attach(EgressClass::Interactive, [0; 2], 1200, rtt)
            .unwrap();
        let bulk = group.attach(EgressClass::Bulk, [0; 2], 1200, rtt).unwrap();
        (now, group, interactive, bulk)
    }

    /// The ledger tests: a 1 ms seed makes the quantum far larger than any
    /// burst they admit, so pacing never decides them.
    fn group(window: u64) -> (Instant, EgressGroup, Member, Member) {
        group_with(window, Duration::from_millis(1))
    }

    #[test]
    fn construction_reservations_and_actual_packets_share_one_window() {
        let (now, group, interactive, bulk) = group(4800);
        let batch = bulk.batch();
        for _ in 0..3 {
            assert_eq!(
                batch.admit(now, 1200, true),
                Admission::Ready { images: true }
            );
        }
        assert_eq!(group.stats().reserved_bytes, 3600);
        assert_eq!(batch.admit(now, 1, true), Admission::Blocked);
        let urgent = interactive.batch();
        assert_eq!(
            urgent.admit(now, 1200, false),
            Admission::Ready { images: false }
        );
        for _ in 0..3 {
            bulk.sent(now, 1000, true);
        }
        interactive.sent(now, 100, false);
        assert_eq!(group.stats().bytes_in_flight, 3100);
        assert_eq!(group.stats().reserved_bytes, 1700);
        drop((batch, urgent));
        assert_eq!(group.stats().reserved_bytes, 0);
        for _ in 0..3 {
            bulk.retired(1000, true);
        }
        interactive.retired(100, false);
        assert_eq!(group.stats().bytes_in_flight, 0);
    }

    #[test]
    fn interactive_is_never_paced_by_the_group_and_bulk_repays_its_tokens() {
        // 120 KB over 100 ms paces Startup at 3,290,760 B/s: a 3,290-byte
        // quantum. Bulk can spend every token; interactive can borrow as debt.
        let (now, group, interactive, bulk) = group_with(120_000, Duration::from_millis(100));
        assert_eq!(group.stats().quantum, 3_290);
        let batch = bulk.batch();
        assert_eq!(
            batch.admit(now, 1200, true),
            Admission::Ready { images: true }
        );
        bulk.sent(now, 1200, true);
        bulk.retired(1200, true);
        assert_eq!(
            batch.admit(now, 1200, true),
            Admission::Ready { images: true }
        );
        bulk.sent(now, 1200, true);
        bulk.retired(1200, true);
        // 890 tokens left: less than one packet.
        assert!(matches!(batch.admit(now, 1200, true), Admission::Paced(_)));
        // An input, its reliable twin and the echo leave at once; the bucket
        // covers part of the first, and the rest is debt.
        for _ in 0..3 {
            let urgent = interactive.batch();
            assert!(matches!(
                urgent.admit(now, 1200, false),
                Admission::Ready { .. }
            ));
            interactive.sent(now, 1200, false);
            interactive.retired(1200, false);
        }
        let admissions = group.stats().interactive;
        assert_eq!((admissions.blocked, admissions.paced), (0, 0));
        // Bulk first repays 2,710 bytes of debt, then needs 1,200 tokens:
        // 3,910 bytes at 3,290,760 B/s is 1.19 ms.
        assert!(matches!(
            batch.admit(now + Duration::from_millis(1), 1200, true),
            Admission::Paced(_)
        ));
        assert!(matches!(
            batch.admit(now + Duration::from_millis(2), 1200, true),
            Admission::Ready { images: true }
        ));
    }

    #[test]
    fn interactive_admits_every_packet_while_bulk_fills_the_window() {
        let (now, group, interactive, bulk) = group(12_000);
        let batch = bulk.batch();
        while matches!(batch.admit(now, 1200, true), Admission::Ready { .. }) {
            bulk.sent(now, 1200, true);
        }
        drop(batch);
        assert_eq!(
            group.stats().bytes_in_flight,
            10_800,
            "bulk leaves one interactive packet of the window"
        );
        // An input, its reliable twin and the echo each find room while bulk
        // holds the window: only interactive's own flight bounds it.
        for sent in 1..=3 {
            let urgent = interactive.batch();
            assert_eq!(
                urgent.admit(now, 1200, false),
                Admission::Ready { images: false }
            );
            interactive.sent(now, 1200, false);
            drop(urgent);
            assert_eq!(group.stats().bytes_in_flight, 10_800 + sent * 1200);
        }
        // Everything interactive sent is charged to bulk, which now waits.
        assert_eq!(bulk.batch().admit(now, 1, true), Admission::Blocked);
        // Interactive's own flight still has the whole window as its bound.
        for _ in 3..10 {
            let urgent = interactive.batch();
            assert!(matches!(
                urgent.admit(now, 1200, false),
                Admission::Ready { .. }
            ));
            interactive.sent(now, 1200, false);
        }
        assert_eq!(interactive.batch().admit(now, 1, false), Admission::Blocked);
        assert_eq!(group.stats().interactive.blocked, 1);
    }

    #[test]
    fn a_direct_members_image_packets_never_hold_its_interactive_admission() {
        // Direct transport: one interactive member builds both classes.
        let (now, group, interactive, bulk) = group(12_000);
        drop(bulk);
        let batch = interactive.batch();
        while matches!(batch.admit(now, 1200, true), Admission::Ready { .. }) {
            interactive.sent(now, 1200, true);
        }
        drop(batch);
        assert_eq!(
            group.stats().bytes_in_flight,
            10_800,
            "images leave one interactive packet of the window"
        );
        // An input, its reliable twin and the echo each find room: the
        // member's own image flight is bulk's, not interactive's.
        for sent in 1..=3 {
            let urgent = interactive.batch();
            assert_eq!(
                urgent.admit(now, 1200, false),
                Admission::Ready { images: false }
            );
            interactive.sent(now, 1200, false);
            drop(urgent);
            assert_eq!(group.stats().bytes_in_flight, 10_800 + sent * 1200);
        }
        assert_eq!(group.stats().interactive.blocked, 0);
        // Images still pay for interactive's flight, and each packet retires
        // from the ledger it was charged to.
        assert_eq!(interactive.batch().admit(now, 1, true), Admission::Blocked);
        for _ in 0..3 {
            interactive.retired(1200, false);
        }
        for _ in 0..9 {
            interactive.retired(1200, true);
        }
        assert_eq!(group.stats().bytes_in_flight, 0);
    }

    #[test]
    fn urgent_publication_preempts_bulk_and_reserves_real_mtu() {
        let (now, group, interactive, bulk) = group(4800);
        interactive.ready(true);
        let batch = bulk.batch();
        assert_eq!(batch.admit(now, 1200, true), Admission::Blocked);
        interactive.ready(false);
        assert_eq!(
            batch.admit(now, 1200, true),
            Admission::Ready { images: true }
        );
        bulk.sent(now, 1200, true);
        interactive.update(2400, RttEstimator::new(Duration::from_millis(100)), false);
        assert_eq!(group.stats().interactive_reserve, 2400);
        assert_eq!(batch.admit(now, 1201, true), Admission::Blocked);
        assert_eq!(
            batch.admit(now, 1200, true),
            Admission::Ready { images: true }
        );
        drop(batch);
    }

    #[test]
    fn concurrent_builders_cannot_double_spend_credit() {
        let (now, group, interactive, bulk) = group(2400);
        let start = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let batch = bulk.batch();
                start.wait();
                if matches!(batch.admit(now, 1200, true), Admission::Ready { .. }) {
                    bulk.sent(now, 1200, true);
                }
            });
            let batch = interactive.batch();
            start.wait();
            assert!(matches!(
                batch.admit(now, 1200, false),
                Admission::Ready { .. }
            ));
            interactive.sent(now, 1200, false);
        });
        assert!(group.stats().bytes_in_flight <= 2400);
        assert_eq!(group.stats().reserved_bytes, 0);
    }

    #[test]
    fn probes_and_path_reset_preserve_debt_without_importing_old_feedback() {
        let (now, group, interactive, bulk) = group(4800);
        // A recovery probe is allowed to exceed the window.
        let probe = bulk
            .sent(now, 5000, true)
            .expect("an in-flight packet has a rate");
        assert_eq!(group.stats().bytes_in_flight, 5000);
        // The probe is bulk's debt: bulk waits on it, interactive does not.
        assert_eq!(bulk.batch().admit(now, 1, true), Admission::Blocked);
        assert!(matches!(
            interactive.batch().admit(now, 1, false),
            Admission::Ready { .. }
        ));
        // Even a reset at the same clock tick must reject old feedback.
        let reset = now;
        let fresh = EgressModel::new(
            reset,
            1200,
            Duration::from_millis(100),
            12_000,
            Duration::from_millis(100),
            2,
        );
        let window = fresh.cwnd();
        let pacing = Pacer::new(fresh.quantum(), reset);
        let previous_epoch = group.stats().model_epoch;
        bulk.reset_path(fresh, pacing, reset);
        assert_ne!(group.stats().model_epoch, previous_epoch);
        assert_eq!(group.stats().bytes_in_flight, 5000);
        bulk.update(1200, RttEstimator::new(Duration::from_millis(100)), false);
        // Feedback about packets sent before the reset only retires flight.
        bulk.acked(reset, now, 5000, Some(&probe));
        bulk.lost(now, 5000, Some(&probe), 1, true);
        bulk.ce(Some(&probe));
        bulk.end_acks(
            reset,
            Some(RttSample {
                sent: now,
                rtt: Duration::from_micros(1),
                quiescent: true,
            }),
            Some(&probe),
        );
        assert_eq!(group.lock().delivery.delivered(), 0);
        assert_eq!(group.lock().delivery.lost(), 0);
        assert_eq!(group.stats().rtprop_us, 100_000);
        assert_eq!(group.stats().congestion_window, window);
        bulk.retired(5000, true);
        assert_eq!(group.stats().bytes_in_flight, 0);
        bulk.sent(reset, 1000, true);
        drop(bulk);
        assert_eq!(group.stats().bytes_in_flight, 0);
        assert!(
            group
                .attach(
                    EgressClass::Bulk,
                    [0; 2],
                    1200,
                    RttEstimator::new(Duration::from_millis(100))
                )
                .is_ok()
        );
    }

    #[test]
    fn an_unchanged_driver_registers_without_the_group_lock_and_replacement_wakes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Count(AtomicUsize);
        impl std::task::Wake for Count {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let (now, group, interactive, mut bulk) = group(2400);
        let first = Arc::new(Count(AtomicUsize::new(0)));
        let second = Arc::new(Count(AtomicUsize::new(0)));
        let waker = Waker::from(Arc::clone(&first));
        bulk.register(&waker);
        let guard = group.lock();
        std::thread::scope(|scope| {
            let (sent, received) = std::sync::mpsc::channel();
            let member = &mut bulk;
            let driver = &waker;
            let task = scope.spawn(move || {
                member.register(driver);
                sent.send(()).unwrap();
            });
            let registered = received.recv_timeout(Duration::from_secs(1));
            // Release even on failure, so a regression fails instead of hanging.
            drop(guard);
            task.join().unwrap();
            assert!(
                registered.is_ok(),
                "unchanged registration acquired the group lock"
            );
        });
        bulk.register(&Waker::from(Arc::clone(&second)));
        interactive.ready(true);
        assert_eq!(bulk.batch().admit(now, 1200, true), Admission::Blocked);
        interactive.ready(false);
        assert_eq!(first.0.load(Ordering::Relaxed), 0);
        assert_eq!(second.0.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn wake_runs_after_unlock_and_path_reset_preserves_construction_tokens() {
        struct Reentrant(EgressGroup);
        impl std::task::Wake for Reentrant {
            fn wake(self: Arc<Self>) {
                assert_eq!(self.0.stats().reserved_bytes, 0);
            }
        }
        let (now, group, interactive, mut bulk) = group(2400);
        let waker = Waker::from(Arc::new(Reentrant(group.clone())));
        bulk.register(&waker);
        interactive.ready(true);
        assert_eq!(bulk.batch().admit(now, 1200, true), Admission::Blocked);
        interactive.ready(false); // Calls a waker which synchronously reads the group.

        let batch = bulk.batch();
        assert!(matches!(
            batch.admit(now, 1200, true),
            Admission::Ready { .. }
        ));
        let fresh = EgressModel::new(
            now,
            1200,
            Duration::from_millis(100),
            12_000,
            Duration::from_millis(100),
            3,
        );
        let mut pacing = Pacer::new(12_000, now);
        pacing.debit(10_800); // Exactly one packet remains before importing reservations.
        interactive.reset_path(fresh, pacing, now);
        // The imported reservation spent that packet. Interactive still leaves
        // at once, on debt, and returning its unused credit repays that debt.
        assert!(matches!(
            interactive.batch().admit(now, 1200, false),
            Admission::Ready { .. }
        ));
        // Bulk's next packet still waits: the reservation's tokens are gone.
        assert!(matches!(batch.admit(now, 1200, true), Admission::Paced(_)));
        drop(batch);
    }

    #[test]
    fn refusals_open_a_wait_that_the_next_admission_of_their_class_closes() {
        let (now, group, interactive, bulk) = group(4800);
        let batch = bulk.batch();
        for _ in 0..3 {
            assert!(matches!(
                batch.admit(now, 1200, true),
                Admission::Ready { .. }
            ));
        }
        // Two refusals, one wait: the interval starts at the first decision.
        assert_eq!(batch.admit(now, 1200, true), Admission::Blocked);
        let later = now + Duration::from_millis(1);
        assert_eq!(batch.admit(later, 1200, true), Admission::Blocked);
        // An interactive admission does not close the bulk wait.
        let urgent = interactive.batch();
        assert!(matches!(
            urgent.admit(later, 1200, false),
            Admission::Ready { .. }
        ));
        drop((batch, urgent));
        let admitted = now + Duration::from_millis(5);
        assert!(matches!(
            bulk.batch().admit(admitted, 1200, true),
            Admission::Ready { .. }
        ));
        let stats = group.stats();
        assert_eq!(
            stats.bulk,
            EgressAdmissions {
                blocked: 2,
                paced: 0,
                waited: Duration::from_millis(5),
            }
        );
        assert_eq!(stats.interactive, EgressAdmissions::default());
    }

    #[test]
    fn pacer_refusals_are_counted_apart_from_credit_refusals() {
        let (now, group, _interactive, bulk) = group(120_000);
        let batch = bulk.batch();
        while matches!(batch.admit(now, 1200, true), Admission::Ready { .. }) {
            bulk.sent(now, 1200, true);
            bulk.retired(1200, true);
        }
        let stats = group.stats().bulk;
        assert_eq!((stats.blocked, stats.paced), (0, 1));
        assert_eq!(stats.waited, Duration::ZERO);
    }

    #[test]
    fn loss_on_either_member_is_the_groups_one_delivery_state() {
        let (now, group, interactive, bulk) = group(12_000);
        let bulk_packet = bulk.sent(now, 1200, true).expect("in flight");
        let input = interactive.sent(now, 1200, false).expect("in flight");
        bulk.retired(1200, true);
        interactive.retired(1200, false);
        bulk.lost(now, 1200, Some(&bulk_packet), 1, false);
        interactive.lost(now, 1200, Some(&input), 1, false);
        assert_eq!(group.lock().delivery.lost(), 2400);
        // A later packet's snapshot sees both.
        assert_eq!(
            bulk.sent(now, 1200, true).map(|rate| rate.lost_since(2400)),
            Some(0)
        );
    }

    /// The group is application limited only when every member found nothing
    /// it could send, whatever held it: its queue, flow control, the edge's
    /// credit or the image window.
    #[test]
    fn only_a_group_whose_every_member_is_idle_marks_its_samples_app_limited() {
        let (now, group, interactive, bulk) = group(12_000);
        let rtt = RttEstimator::new(Duration::from_millis(1));
        // Bulk has data, input has none: the group can still show its rate.
        bulk.update(1200, rtt, false);
        interactive.update(1200, rtt, true);
        assert_eq!(
            bulk.sent(now, 1200, true).map(|rate| rate.app_limited()),
            Some(false)
        );
        bulk.update(1200, rtt, true);
        assert!(group.lock().delivery.is_app_limited());
        assert_eq!(
            bulk.sent(now, 1200, true).map(|rate| rate.app_limited()),
            Some(true)
        );
    }
}
