//! Finite graphics responses. The terminal owner admits source authority and one
//! response key; CPU processing, the transfer credit, stream credit and FIN
//! acknowledgement live here.

mod replies;

use std::{
    collections::VecDeque,
    sync::{Arc, LazyLock, OnceLock},
};

use merkur_e2e::{
    CONTENT_CHUNK_BYTES, CONTENT_CHUNK_OVERHEAD, CONTENT_MAX_TRANSFERS, ContentDescriptor,
    ContentSendKey, ReplayWindow,
};
use merkur_graphics::{budget::Budget, scene::Image};
use merkur_image_worker::{content::ImageContent, encoding::Pool};
use tokio::sync::{Notify, Semaphore, oneshot, watch};
use wtransport::{Connection, SendStream, VarInt};

use crate::{
    connection::{PeerDisplayState, PeerMap, PeerTransport},
    edge_tunnel::CounterpartState,
    network::{
        peer::{DeliveryMode, PeerMessage},
        protocol::*,
    },
    pty::TerminalState,
};

/// Resource ceiling on simultaneous finite graphics transfers in this process (one terminal):
/// two peers' complete request windows. A credit covers one transfer's exact-length plaintext
/// tile (at most TILE_ENCODED_BYTES plus its owner), the sealed copy queued for its stream until
/// acknowledged FIN, and its task's 16 KiB seal scratch: 588 KiB, 36.75 MiB in total. Requests
/// wait in arrival order and are never refused for capacity; terminal storage is never charged.
/// A waiting request's task is a fixed per-slot allocation, bounded like the reply tasks.
const TRANSFERS: usize = 2 * CONTENT_MAX_TRANSFERS as usize;
static TRANSFER_CREDITS: Semaphore = Semaphore::const_new(TRANSFERS);
pub(crate) static COMPLETED: LazyLock<Notify> = LazyLock::new(Notify::new);
static ENCODERS: OnceLock<watch::Receiver<Option<Option<Pool>>>> = OnceLock::new();

async fn encoders() -> Option<Pool> {
    let mut ready = ENCODERS
        .get_or_init(|| {
            let (tx, rx) = watch::channel(None);
            // Initialization has one independent owner. Cancelling its first caller
            // cannot enqueue another C context initialization or refund its arena.
            tokio::spawn(async move {
                let budget = Budget::new(Pool::charge());
                tx.send_replace(Some(Pool::new(&budget).await));
            });
            rx
        })
        .clone();
    loop {
        if let Some(pool) = ready.borrow_and_update().clone() {
            return pool;
        }
        ready.changed().await.ok()?;
    }
}

#[derive(Clone, Copy)]
struct Request {
    manifest: bool,
    frame: u32,
    level: u8,
    x: u32,
    y: u32,
    id: u64,
    source: [u8; 32],
    range: Option<ContentDescriptor>,
}

impl Request {
    fn decode(body: &[u8]) -> Option<Self> {
        if !matches!(body.len(), 56 | 100) {
            return None;
        }
        let manifest = body[0] == 1;
        let level = body[1];
        if body[0] > 1 || body[2..4] != [0; 2] || level > 14 {
            return None;
        }
        let frame = u32::from_be_bytes(body[4..8].try_into().ok()?);
        let x = u32::from_be_bytes(body[8..12].try_into().ok()?);
        let y = u32::from_be_bytes(body[12..16].try_into().ok()?);
        if manifest && (level != 0 || frame != 0 || x != 0 || y != 0) {
            return None;
        }
        let id = u64::from_be_bytes(body[16..24].try_into().ok()?);
        if id == 0 {
            return None;
        }
        let source = body[24..56].try_into().ok()?;
        let range = if body.len() == 100 {
            Some(ContentDescriptor::decode(&body[16..]).ok()?)
        } else {
            None
        };
        Some(Self {
            manifest,
            frame,
            level,
            x,
            y,
            id,
            source,
            range,
        })
    }
}

/// A selected physical connection, never a lookup that could resolve to a
/// successor after an await. Edge pairing identity survives repeated presence.
pub(crate) struct Carrier {
    pub connection: Arc<Connection>,
    pub counterpart: Option<(watch::Receiver<CounterpartState>, u64)>,
}

impl Carrier {
    pub(crate) async fn retired(&mut self) {
        match &mut self.counterpart {
            Some((state, expected)) => loop {
                if *state.borrow_and_update()
                    != (CounterpartState::Attached {
                        attachment_id: *expected,
                    })
                {
                    return;
                }
                tokio::select! {
                    _ = self.connection.closed() => return,
                    changed = state.changed() => {
                        if changed.is_err() { return; }
                    }
                }
            },
            None => {
                self.connection.closed().await;
            }
        }
    }
}

struct Sending(Option<SendStream>);
impl Drop for Sending {
    fn drop(&mut self) {
        if let Some(stream) = &mut self.0 {
            let _ = stream.reset(VarInt::from_u32(0));
        }
    }
}

/// How a transfer task ended. The task never replies; the terminal owner
/// decides what the browser is owed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    /// The next hop acknowledged FIN.
    Delivered,
    /// The browser cancelled the request.
    Cancelled,
    /// The live source cannot serve it: a range or manifest that does not match,
    /// a failed encode, or a refused response key.
    Refused,
    /// The stream or its connection failed. A relay drops a stream when a pairing
    /// on its path ends, and the browser re-asks every unanswered request when a
    /// pairing it uses ends or forms after one that ended, so nothing is owed.
    Carrier,
    /// The source content retired before every byte was queued. The request
    /// keeps its id and re-resolves its root: another live image may hold it, or
    /// a later publication may.
    Retired,
}

/// `work`, unless the source retires first.
async fn unretired<T>(
    source: &ImageContent,
    work: impl std::future::Future<Output = T>,
) -> Result<T, Outcome> {
    tokio::select! {
        biased;
        () = source.retired() => Err(Outcome::Retired),
        value = work => Ok(value),
    }
}

async fn deliver(
    request: Request,
    source: Arc<Image<ImageContent>>,
    key: ContentSendKey,
    connection: &Connection,
) -> Result<(), Outcome> {
    use Outcome::{Carrier, Refused};
    // Until every byte is queued, a retiring source withdraws the response: the
    // next hop cannot have finished the stream, and its reset reaches whoever
    // holds the part already sent. Both branches hold the credit through
    // acknowledged FIN: the tile owns it, and a manifest response keeps it until
    // this function returns.
    let credit = unretired(&source.content, TRANSFER_CREDITS.acquire())
        .await?
        .map_err(|_| Refused)?;
    let tile;
    let (bytes, object, sampling_root) = if request.manifest {
        let manifest = source.content.animation().ok_or(Refused)?.manifest();
        (manifest.bytes(), manifest.root(), manifest.root())
    } else {
        let pool = unretired(&source.content, encoders())
            .await?
            .ok_or(Refused)?;
        let encoding = pool.encode(
            Arc::clone(&source),
            request.frame,
            request.level,
            request.x,
            request.y,
            credit,
        );
        tile = unretired(&source.content, encoding)
            .await?
            .map_err(|_| Refused)?;
        (tile.bytes(), tile.root, tile.source)
    };
    let (first, count) = match request.range {
        Some(range) => {
            if *range.object() != object || range.object_bytes() as usize != bytes.len() {
                return Err(Refused);
            }
            (range.first(), range.count())
        }
        None => (0, bytes.len().div_ceil(CONTENT_CHUNK_BYTES) as u32),
    };
    let descriptor = ContentDescriptor::new(
        request.id,
        sampling_root,
        object,
        bytes.len() as u32,
        first,
        count,
    )
    .map_err(|_| Refused)?;
    let mut sender = key.bind(descriptor).map_err(|_| Refused)?;
    let opening = async {
        let opening = connection.open_uni().await.map_err(|_| Carrier)?;
        opening.await.map_err(|_| Carrier)
    };
    let stream = unretired(&source.content, opening).await??;
    stream.set_priority(wtransport::quinn::EGRESS_IMAGE_PRIORITY);
    let mut owner = Sending(Some(stream));
    let stream = owner.0.as_mut().ok_or(Carrier)?;
    let mut prefix = [0; 5];
    prefix[0] = CHANNEL_GRAPHICS_CONTENT | 0x80;
    prefix[1..].copy_from_slice(&(descriptor.wire_bytes() as u32).to_be_bytes());
    unretired(&source.content, stream.write_all(&prefix))
        .await?
        .map_err(|_| Carrier)?;
    unretired(&source.content, stream.write_all(sender.header()))
        .await?
        .map_err(|_| Carrier)?;
    let mut chunk = [0; CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD];
    for plaintext in bytes[descriptor.range()].chunks(CONTENT_CHUNK_BYTES) {
        let len = sender
            .seal_next(plaintext, &mut chunk)
            .map_err(|_| Refused)?;
        unretired(&source.content, stream.write_all(&chunk[..len]))
            .await?
            .map_err(|_| Carrier)?;
    }
    // Every byte is queued: the source is no longer read, and its storage is not
    // held for the acknowledgement. The next hop may already hold the whole
    // stream, so a retirement can no longer recall it. Only FIN's acknowledgement
    // or the stream's own failure decides from here.
    drop(source);
    stream.finish().await.map_err(|_| Carrier)?;
    owner.0 = None;
    Ok(())
}

/// One live request id. It holds its slot from admission until it is delivered,
/// refused, or its cancellation is acknowledged; a retiring source never frees it.
struct Slot {
    request: Request,
    via: PeerTransport,
    stage: Stage,
}

enum Stage {
    /// Admitted while its root is absent from the live namespace or no carrier
    /// can take its response. It holds no Noise key, egress group, transfer
    /// credit or task.
    Parked,
    Active {
        cancel: Option<oneshot::Sender<()>>,
        result: oneshot::Receiver<Outcome>,
    },
}

/// Publish before waking, including unwinding. A panicking job cannot leave a
/// permanently occupied slot waiting for an unrelated terminal event.
struct Completion(Option<oneshot::Sender<Outcome>>);
impl Completion {
    fn publish(mut self, outcome: Outcome) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(outcome);
        }
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(Outcome::Refused);
        }
        COMPLETED.notify_one();
    }
}

/// Wakes the terminal owner when a graphics task ends, however it ends.
struct Wake;
impl Drop for Wake {
    fn drop(&mut self) {
        COMPLETED.notify_one();
    }
}

/// Allocated only after the first asset request. Fixed slots share the crypto
/// domain's limit, parked requests included, so the browser's own window bounds
/// them. Request identity is supplied by the authenticated client; response
/// nonces use the independent, non-reused crypto transfer identity. Do not
/// require request arrival order across independent physical carriers.
pub(crate) struct Requests {
    slots: [Option<Slot>; CONTENT_MAX_TRANSFERS as usize],
    replies: [Option<replies::Reply>; CONTENT_MAX_TRANSFERS as usize],
    /// The browser may consume one complete window before its FIN ACKs reach
    /// these tasks. Its next window waits here, without keys or transfer credit.
    /// Allocate only on that race; never on the ordinary request path.
    waiting: VecDeque<(Request, PeerTransport)>,
    /// Every request id this Noise session has heard of: as a request, or as the
    /// cancel of an id no slot held, which may have overtaken its request on
    /// another carrier. An id is admitted once, never after its cancel was
    /// answered. The browser spends an id only on a request it seals, in id
    /// order and before any cancel of it, on the one CTRL lane. So an id this
    /// window has passed also trails that lane's replay window, which has the
    /// same size, and could not be opened any more.
    heard: ReplayWindow,
    /// Wakes the owner once the interactive tunnel's browser half attaches,
    /// while a request is parked for want of a carrier.
    carrier_wait: Option<tokio::task::AbortHandle>,
}

impl Drop for Requests {
    fn drop(&mut self) {
        if let Some(wait) = &self.carrier_wait {
            wait.abort();
        }
    }
}

/// What a browser cancel found.
#[derive(Debug, PartialEq, Eq)]
enum Cancel {
    /// A task owns the response; its retirement acknowledges the cancel.
    Active,
    /// A parked request, now freed; acknowledge it at once.
    Parked,
    Unknown,
}

impl Requests {
    fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| None),
            replies: std::array::from_fn(|_| None),
            waiting: VecDeque::new(),
            heard: ReplayWindow::default(),
            carrier_wait: None,
        }
    }
    /// Record `id`; false if it was heard already or trails the window.
    fn hear(&mut self, id: u64) -> bool {
        if !self.heard.check(id) {
            return false;
        }
        self.heard.advance(id);
        true
    }
    fn cancel(&mut self, id: u64, via: PeerTransport) -> Cancel {
        if let Some(index) = self
            .waiting
            .iter()
            .position(|(request, _)| request.id == id)
        {
            self.waiting.remove(index);
            return Cancel::Parked;
        }
        let Some(entry) = self
            .slots
            .iter_mut()
            .find(|entry| entry.as_ref().is_some_and(|slot| slot.request.id == id))
        else {
            // Its request may still be in flight on another carrier; this answer
            // retires the id, so that request must never be admitted.
            self.hear(id);
            return Cancel::Unknown;
        };
        let Some(slot) = entry.as_mut() else {
            return Cancel::Unknown;
        };
        match &mut slot.stage {
            Stage::Active { cancel, .. } => {
                slot.via = via;
                cancel.take();
                Cancel::Active
            }
            Stage::Parked => {
                *entry = None;
                Cancel::Parked
            }
        }
    }
    fn park(&mut self, index: usize, request: Request, via: PeerTransport) {
        self.slots[index] = Some(Slot {
            request,
            via,
            stage: Stage::Parked,
        });
    }
    fn start(
        &mut self,
        index: usize,
        request: Request,
        source: Arc<Image<ImageContent>>,
        key: ContentSendKey,
        connection: Arc<Connection>,
        via: PeerTransport,
    ) {
        let (cancel, cancelled) = oneshot::channel();
        let (result, received) = oneshot::channel();
        self.slots[index] = Some(Slot {
            request,
            via,
            stage: Stage::Active {
                cancel: Some(cancel),
                result: received,
            },
        });
        tokio::spawn(async move {
            let completion = Completion(Some(result));
            // No pairing report pre-empts the stream: the edge forwards it to the
            // browser attachment paired when it arrives, which a report still in
            // flight may name, and stops it when none is.
            let outcome = tokio::select! {
                biased;
                _ = cancelled => Outcome::Cancelled,
                delivered = deliver(request, source, key, &connection) => {
                    delivered.err().unwrap_or(Outcome::Delivered)
                }
            };
            // A cancellation acknowledgment grants the browser permission to
            // spend this admission again. The source reference and this transfer's
            // credit (dropped with `deliver`) are retired before completion is
            // published, including when another runtime thread wakes the owner.
            drop(connection);
            completion.publish(outcome);
        });
    }
    /// The next finished transfer whose slot is freed: its id, the carrier the
    /// browser last spoke on, and whether an UNAVAILABLE is owed. A transfer
    /// whose source retired keeps its slot, parked, for the owner to re-resolve.
    fn completed(&mut self) -> Option<(u64, PeerTransport, bool)> {
        for entry in &mut self.slots {
            let Some(slot) = entry.as_mut() else {
                continue;
            };
            let Stage::Active { cancel, result } = &mut slot.stage else {
                continue;
            };
            let outcome = match result.try_recv() {
                Ok(outcome) => outcome,
                Err(oneshot::error::TryRecvError::Closed) => Outcome::Refused,
                Err(oneshot::error::TryRecvError::Empty) => continue,
            };
            let acknowledged = cancel.is_none();
            if outcome == Outcome::Retired && !acknowledged {
                slot.stage = Stage::Parked;
                continue;
            }
            let done = (
                slot.request.id,
                slot.via,
                acknowledged || outcome == Outcome::Refused,
            );
            *entry = None;
            return Some(done);
        }
        None
    }
    fn wait(&mut self, request: Request, via: PeerTransport) -> bool {
        // Only executing transfers can owe FIN or task-completion delivery. A
        // window entirely parked on absent roots/carriers cannot have delivered
        // a tile for which the browser legitimately reuses admission.
        if self.waiting.len() == CONTENT_MAX_TRANSFERS as usize
            || !self
                .slots
                .iter()
                .flatten()
                .any(|slot| matches!(slot.stage, Stage::Active { .. }))
        {
            return false;
        }
        if self.waiting.capacity() == 0 {
            self.waiting.reserve_exact(CONTENT_MAX_TRANSFERS as usize);
        }
        self.waiting.push_back((request, via));
        true
    }

    fn parked(&self) -> bool {
        self.slots
            .iter()
            .flatten()
            .any(|slot| matches!(slot.stage, Stage::Parked))
    }
}

pub(crate) fn handle(
    msg: &PeerMessage,
    kind: u8,
    body: &[u8],
    peer: &mut PeerDisplayState,
    terminal: &TerminalState,
    now_ms: f64,
) {
    if msg.delivery != DeliveryMode::Stream || !peer.authenticated || peer.noise.is_none() {
        return;
    }
    replies::reap(peer);
    if kind == MSG_TYPE_GRAPHICS_CANCEL {
        if let Ok(id) = <[u8; 8]>::try_from(body) {
            let id = u64::from_be_bytes(id);
            if requests(peer).cancel(id, msg.via_transport) != Cancel::Active {
                unavailable(peer, id, msg.via_transport, now_ms);
                admit_waiting(peer, terminal, now_ms);
            }
        }
        return;
    }
    let Some(request) = Request::decode(body) else {
        return;
    };
    // Reliable carrier recovery may redeliver an earlier request: its first copy
    // owns the id, and an UNAVAILABLE here would revoke that owner. A request
    // whose cancel overtook it on another carrier was answered by that cancel.
    if !requests(peer).hear(request.id) {
        return;
    }
    let mut vacancy = requests(peer).slots.iter().position(Option::is_none);
    if vacancy.is_none() || !requests(peer).waiting.is_empty() {
        // Completions may already be published before the owner's next reap.
        // Only a full window or its waiting successor needs this extra scan;
        // older waiting requests must consume released capacity first.
        reap_peer(peer, terminal, now_ms);
        vacancy = requests(peer).slots.iter().position(Option::is_none);
    }
    let admitted = match vacancy {
        Some(index) => admit(peer, terminal, index, request, msg.via_transport),
        None if requests(peer).wait(request, msg.via_transport) => Ok(()),
        None => Err(()),
    };
    if admitted.is_err() {
        unavailable(peer, request.id, msg.via_transport, now_ms);
    }
}

/// Serve `request` from slot `index`, or park it there while its root is absent
/// from the live namespace or no carrier can take its response. Err refuses it:
/// it is invalid for its live root, or its egress or key admission failed. The
/// slot is then left as it was.
fn admit(
    peer: &mut PeerDisplayState,
    terminal: &TerminalState,
    index: usize,
    request: Request,
    via: PeerTransport,
) -> Result<(), ()> {
    let Some(source) = terminal.graphics_source(&request.source) else {
        requests(peer).park(index, request, via);
        return Ok(());
    };
    if request.manifest {
        source.content.animation().ok_or(())?;
    } else {
        let raster = source.content.raster(request.frame).ok_or(())?;
        merkur_image_worker::tile::level_shape(&raster, request.level, request.x, request.y)
            .ok_or(())?;
    }
    let Some((carrier, interactive)) = carrier(peer, via) else {
        requests(peer).park(index, request, via);
        await_carrier(peer, via);
        return Ok(());
    };
    // Only a valid, admitted image request activates shared packet scheduling.
    let group = interactive
        .quic_connection()
        .start_egress_group()
        .map_err(|_| ())?;
    if carrier.stable_id() != interactive.stable_id() {
        carrier
            .quic_connection()
            .join_egress_group(&group, wtransport::quinn::EgressClass::Bulk)
            .map_err(|_| ())?;
    }
    let key = peer
        .noise
        .as_mut()
        .ok_or(())?
        .reserve_content_sender()
        .map_err(|_| ())?;
    requests(peer).start(index, request, source, key, carrier, via);
    Ok(())
}

fn requests(peer: &mut PeerDisplayState) -> &mut Requests {
    peer.graphics_requests
        .get_or_insert_with(|| Box::new(Requests::new()))
}

/// The response connection for a request that arrived on `via`, and the
/// interactive connection that owns its egress group. Both are the peer's own
/// handles: selection waits on no registry lock.
fn carrier(peer: &PeerDisplayState, via: PeerTransport) -> Option<(Arc<Connection>, Arc<Connection>)> {
    match via {
        PeerTransport::Edge => {
            let interactive = peer.edge_tunnel.as_ref()?.content_carrier()?.connection;
            // A confirmed bulk tunnel keeps its confirmation after its browser
            // half detaches, until the next data claim replaces it. The edge
            // drops content sent there; the interactive pairing still delivers.
            let selected = peer
                .reliable_edge_tunnel()
                .and_then(|tunnel| tunnel.content_carrier())
                .map_or_else(|| Arc::clone(&interactive), |bulk| bulk.connection);
            Some((selected, interactive))
        }
        PeerTransport::WebTransport => {
            let connection = Arc::clone(peer.open_direct_session()?);
            Some((Arc::clone(&connection), connection))
        }
    }
}

/// Wake the owner when the interactive tunnel's browser half attaches. A request
/// can arrive on a new pairing before the edge's report of that pairing does.
/// With no tunnel, or a closed one, linking the next tunnel wakes it instead
/// (`edge_ready`); a lost direct path makes the browser cancel.
fn await_carrier(peer: &mut PeerDisplayState, via: PeerTransport) {
    if via != PeerTransport::Edge {
        return;
    }
    let Some(tunnel) = peer.edge_tunnel.clone() else {
        return;
    };
    if !tunnel.can_pair() {
        return;
    }
    let mut counterpart = tunnel.counterpart_changes();
    let requests = requests(peer);
    if requests
        .carrier_wait
        .as_ref()
        .is_some_and(|wait| !wait.is_finished())
    {
        return;
    }
    requests.carrier_wait = Some(
        tokio::spawn(async move {
            let _wake = Wake;
            while tunnel.content_carrier().is_none() {
                if counterpart.changed().await.is_err() {
                    return;
                }
            }
        })
        .abort_handle(),
    );
}

/// Re-resolve this peer's parked requests: start each whose root is live and
/// whose carrier exists, and refuse each that its live root cannot serve.
fn unpark_peer(peer: &mut PeerDisplayState, terminal: &TerminalState, now_ms: f64) {
    if !peer.authenticated || peer.noise.is_none() {
        return;
    }
    for index in 0..CONTENT_MAX_TRANSFERS as usize {
        let Some((request, via)) = peer
            .graphics_requests
            .as_ref()
            .and_then(|requests| requests.slots[index].as_ref())
            .filter(|slot| matches!(slot.stage, Stage::Parked))
            .map(|slot| (slot.request, slot.via))
        else {
            continue;
        };
        if admit(peer, terminal, index, request, via).is_err() {
            requests(peer).slots[index] = None;
            unavailable(peer, request.id, via, now_ms);
        }
    }
}

/// A source root was published: requests parked for it may start.
pub(crate) fn unpark(peers: &mut PeerMap, terminal: &TerminalState, now_ms: f64) {
    for peer in peers.values_mut() {
        unpark_peer(peer, terminal, now_ms);
    }
}

/// The interactive DATA rendezvous completed: start replies parked for want of a
/// tunnel, and wake the owner for requests parked for want of a carrier.
pub(crate) fn edge_ready(peer: &mut PeerDisplayState) {
    replies::edge_ready(peer);
    if peer
        .graphics_requests
        .as_ref()
        .is_some_and(|requests| requests.parked())
    {
        COMPLETED.notify_one();
    }
}

fn unavailable(peer: &mut PeerDisplayState, id: u64, via: PeerTransport, _now_ms: f64) {
    replies::enqueue(peer, id, via);
}

pub(crate) fn reap(peers: &mut PeerMap, terminal: &TerminalState, now_ms: f64) {
    for peer in peers.values_mut() {
        crate::geometry::reap(peer);
        reap_peer(peer, terminal, now_ms);
    }
}

fn reap_peer(peer: &mut PeerDisplayState, terminal: &TerminalState, now_ms: f64) {
    replies::reap(peer);
    while let Some((id, via, owed)) = peer
        .graphics_requests
        .as_mut()
        .and_then(|requests| requests.completed())
    {
        if owed {
            unavailable(peer, id, via, now_ms);
        }
    }
    // A retired source may still be live under another image, and a returning
    // carrier wakes this reap. Transfer retirement also grants physical capacity
    // to requests from the browser's next window, in their arrival order.
    unpark_peer(peer, terminal, now_ms);
    admit_waiting(peer, terminal, now_ms);
}

fn admit_waiting(peer: &mut PeerDisplayState, terminal: &TerminalState, now_ms: f64) {
    if !peer.authenticated || peer.noise.is_none() {
        return;
    }
    loop {
        let Some(requests) = peer.graphics_requests.as_mut() else {
            return;
        };
        let Some(index) = requests.slots.iter().position(Option::is_none) else {
            return;
        };
        let Some((request, via)) = requests.waiting.pop_front() else {
            return;
        };
        if admit(peer, terminal, index, request, via).is_err() {
            unavailable(peer, request.id, via, now_ms);
        }
    }
}

#[cfg(test)]
mod tests;
