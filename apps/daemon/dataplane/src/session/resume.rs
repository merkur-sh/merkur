//! Display resume: incremental catch-up for returning peers (generation and
//! dimension matched delta replay) with snapshot fallback, plus disconnect
//! frames.

use std::collections::HashMap;
use std::sync::Arc;

use tracing::info;

use crate::connection::{PeerDisplayState, PeerMap, PerPeerDisplayCache};
use crate::pty::CapturedRow;
use crate::ipc::events::*;
use crate::network::peer::PeerMessage;
use crate::send_json_event;
use crate::session::policy::SessionPolicy;

/// Row-hash block: `version(1) | reserved(1) | count(u16) | count * u64`.
pub(crate) const DISPLAY_RESUME_HASHES_VERSION: u8 = 2;
/// Diverged fraction of the grid above which a snapshot beats an incremental
/// repair.
///
/// A repair sends a full row per diverged row, each one framed, prioritized and
/// paced against the others, and the browser paints them as they land. A
/// snapshot is one atomic frame that compresses as a whole and repaints in one
/// step. Past roughly half the screen the repair is both more bytes and more
/// visible tearing, so the claim is still worth having — it is what tells the
/// daemon which case this is — but the answer is a snapshot.
const RESUME_SNAPSHOT_DIVERGENCE_NUMERATOR: usize = 1;
const RESUME_SNAPSHOT_DIVERGENCE_DENOMINATOR: usize = 2;

/// Whether a repair of `diverged` rows out of `rows` is worth doing at all.
fn resume_repair_beats_snapshot(diverged: usize, rows: usize) -> bool {
    rows > 0
        && diverged * RESUME_SNAPSHOT_DIVERGENCE_DENOMINATOR
            <= rows * RESUME_SNAPSHOT_DIVERGENCE_NUMERATOR
}
const DISPLAY_RESUME_HASHES_HEADER_BYTES: usize = 4;
const DISPLAY_RESUME_HASH_BYTES: usize = 8;

/// Resume-relevant state of disconnected peers, parked instead of dropped.
///
/// When every path to an authenticated peer goes dead, its `PeerDisplayState`
/// (display cache, generation, sequence counters, learned RTT) moves here so
/// a later fresh-auth reconnect can splice it back and serve an incremental
/// delta instead of a full snapshot. Entries live for one bounded parked-peer
/// window, and the map is capped: parking beyond the cap evicts the oldest.
pub(crate) struct ParkedPeers {
    entries: HashMap<Arc<str>, ParkedPeer>,
    /// Identities whose parked state became unreachable without being resumed.
    ///
    /// The run-loop drains this before selecting another event and retires the
    /// matching edge/WT ownership. Keeping the notification beside the map
    /// makes cap eviction, TTL pruning, and revocation clearing impossible to
    /// forget at one of the several call sites that can park a peer.
    removed_peer_ids: Vec<Arc<str>>,
}

struct ParkedPeer {
    state: PeerDisplayState,
    parked_at_ms: f64,
}

/// One active client per parked daemon session is the norm; a small multiple
/// covers a user hopping between devices without letting display caches
/// (cols × rows cells each) accumulate unboundedly.
const PARKED_PEERS_CAP: usize = 4;

impl ParkedPeers {
    pub(crate) fn new() -> Self {
        Self {
            entries: HashMap::new(),
            removed_peer_ids: Vec::new(),
        }
    }

    /// Park `state` under the identity it carries: the entry's key is the
    /// peer's own `peer_id`, the same allocation the live map was keyed by.
    pub(crate) fn park(&mut self, state: PeerDisplayState, now_ms: f64) -> Vec<Arc<str>> {
        let peer_id = Arc::clone(&state.peer_id);
        // A same-turn replacement/resume for this identity supersedes any
        // queued retirement notification for its older parked incarnation.
        self.removed_peer_ids.retain(|removed| removed != &peer_id);
        let mut removed = Vec::new();
        if self.entries.len() >= PARKED_PEERS_CAP && !self.entries.contains_key(&peer_id) {
            let oldest = self
                .entries
                .iter()
                .min_by(|a, b| {
                    a.1.parked_at_ms
                        .total_cmp(&b.1.parked_at_ms)
                        .then_with(|| a.0.cmp(b.0))
                })
                .map(|(id, _)| Arc::clone(id));
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
                self.removed_peer_ids.push(Arc::clone(&oldest));
                removed.push(oldest);
            }
        }
        self.entries.insert(
            peer_id,
            ParkedPeer {
                state,
                parked_at_ms: now_ms,
            },
        );
        removed
    }

    pub(crate) fn take(&mut self, peer_id: &str) -> Option<PeerDisplayState> {
        let parked = self.entries.remove(peer_id);
        // Resumption transfers ownership back to the active map; it is not a
        // parked-identity retirement even if an older notification for the
        // same logical id was queued earlier in this owner turn.
        if parked.is_some() {
            self.removed_peer_ids
                .retain(|removed| &**removed != peer_id);
        }
        parked.map(|peer| peer.state)
    }

    pub(crate) fn get_mut(&mut self, peer_id: &str) -> Option<&mut PeerDisplayState> {
        self.entries.get_mut(peer_id).map(|peer| &mut peer.state)
    }

    pub(crate) fn states_mut(&mut self) -> impl ExactSizeIterator<Item = &mut PeerDisplayState> {
        self.entries.values_mut().map(|peer| &mut peer.state)
    }

    pub(crate) fn remove_revoked_delegations(
        &mut self,
        delegation_ids: &std::collections::HashSet<String>,
    ) -> Vec<Arc<str>> {
        let mut removed = self
            .entries
            .iter()
            .filter(|(_, peer)| delegation_ids.contains(&peer.state.delegation_id))
            .map(|(peer_id, _)| Arc::clone(peer_id))
            .collect::<Vec<_>>();
        removed.sort();
        for peer_id in &removed {
            self.entries.remove(peer_id);
            self.removed_peer_ids.retain(|queued| queued != peer_id);
        }
        removed
    }

    /// Drop entries whose bounded fresh-auth reconnect window has elapsed.
    pub(crate) fn prune(&mut self, now_ms: f64) -> Vec<Arc<str>> {
        let mut removed = self
            .entries
            .iter()
            .filter(|(_, peer)| {
                now_ms - peer.parked_at_ms > SessionPolicy::PARKED_PEER_TTL_MS as f64
            })
            .map(|(peer_id, _)| Arc::clone(peer_id))
            .collect::<Vec<_>>();
        removed.sort();
        for peer_id in &removed {
            self.entries.remove(peer_id);
        }
        self.removed_peer_ids.extend(removed.iter().cloned());
        removed
    }

    /// Revocation invalidates all prior authenticated state.
    pub(crate) fn clear(&mut self) -> Vec<Arc<str>> {
        let mut removed = self.entries.keys().cloned().collect::<Vec<_>>();
        removed.sort();
        self.entries.clear();
        self.removed_peer_ids.extend(removed.iter().cloned());
        removed
    }

    /// Drain identities whose parked state was discarded rather than resumed.
    ///
    /// Notifications are deduplicated and suppressed if the identity was
    /// parked again before the owner loop reconciled it.
    pub(crate) fn take_removed_peer_ids(&mut self) -> Vec<Arc<str>> {
        let mut removed = std::mem::take(&mut self.removed_peer_ids);
        removed.sort();
        removed.dedup();
        removed.retain(|peer_id| !self.entries.contains_key(peer_id));
        removed
    }

    /// Peers currently parked awaiting resume. Read by the telemetry emitter to
    /// decide whether a sampling interval is genuinely idle, and by tests.
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Park a peer that disconnected (heartbeat death or transport close) iff it
/// has anything worth resuming: only an authenticated peer with an
/// initialized display cache can be spliced back for an incremental resume.
pub(crate) fn park_disconnected_peer(
    parked: &mut ParkedPeers,
    mut state: PeerDisplayState,
    now_ms: f64,
) {
    // Drop the edge tunnel on disconnect because it is bound to that transport
    // generation. A resume dials a fresh connection, so parked state
    // must never carry a stale tunnel. Close it so its detached receive tasks
    // exit instead of lingering until the edge idle-closes.
    if let Some(tunnel) = state.edge_tunnel.take() {
        tunnel.close();
    }
    // The bulk lane is likewise bound to the (now-gone) conn2; drop + close it so a
    // resume re-dials a fresh one and parked state never carries a stale bulk tunnel.
    if let Some(tunnel) = state.edge_tunnel_bulk.take() {
        tunnel.close();
    }
    state.bulk_delivery_confirmed = false;
    // Parking is the end of the rebind fast path, not a pause in it. A parked
    // peer has no tunnel and no rendezvous, so the chaining secret can no
    // longer be used for anything and must not sit in memory for the
    // half-hour this state lives — the whole point of bounding a lineage is
    // that it expires long before the display cache does.
    state.clear_rebind_material();
    // A parked peer is display/input continuity only. Every replacement carrier
    // performs a fresh ML-KEM and Noise handshake — authenticated by the server
    // capability on this path, or by the rebind chaining secret on the faster
    // one that never reaches parking at all. Retaining any prior connection key
    // or transcript here would turn resume into key reuse.
    state.noise = None;
    state.noise_handshake = None;
    state.clear_hybrid_secret_material();
    state.auth_timeout_at_ms = None;
    // CPU preparation completions are delivered only to the active peer map.
    // Cancel the token before parking so a completion dropped during the
    // disconnected interval cannot leave the resumed peer permanently gated.
    if state.cancel_display_prepare() {
        state.needs_full_diff = true;
    }
    if state.authenticated && state.display_cache.initialized {
        let _ = parked.park(state, now_ms);
    }
}

/// Arm a snapshot because the client asked for one, and clear the send-failure
/// backoff so the next flush can actually deliver it.
///
/// Clearing `snapshot_retry_at_ms` is what makes this safe rather than merely
/// faster. `needs_snapshot` excludes the peer from the delta loop
/// (`can_send_delta`), and `peer_snapshot_due` refuses to send while
/// `snapshot_retry_at_ms` is in the future — so arming the flag without clearing
/// the deadline leaves the peer eligible for *neither*, and it produces nothing
/// at all for the length of the backoff (up to five seconds). The client is in
/// its own resync drop-state for exactly that interval, discarding every frame
/// it receives and re-asking on a five-second timer, so the two states hold each
/// other open: a mutual stall the screen shows as a freeze.
///
/// The backoff exists to space out retries of a *failing send*. A client request
/// is new information, not a retry, so it earns one immediate attempt.
/// `snapshot_consecutive_failures` is deliberately left alone: if that attempt
/// also fails, the next backoff still escalates from the true failure count.
/// This mirrors `arm_display_seq_rollover_snapshots`, the other site that arms a
/// snapshot from evidence rather than from a retry.
pub(crate) fn handle_display_snapshot_request(msg: &PeerMessage, peers: &mut PeerMap) {
    if let Some(peer) = peers.get_mut(&*msg.peer_node_id) {
        info!("display snapshot requested by peer: {}", peer.peer_id);
        peer.needs_snapshot = true;
        peer.snapshot_retry_at_ms = 0.0;
    }
}

/// How one row of a resume claim is answered.
enum ResumeRowClaim<'a> {
    /// The acknowledged baseline and comparable live grid name this hash — or the row index is
    /// unaddressable, which the 256-row protocol bound makes unreachable.
    /// Either way there is nothing to send and nothing to credit.
    InSync,
    /// The claim is the live grid's hash for this row and the owner loop's
    /// capture of it fits this cache: credit it rather than repair it.
    Adoptable(&'a CapturedRow),
    /// The live row differs, or neither baseline explains the claim: repair it.
    Diverged(u16),
}

/// Answer one claimed row without touching the cache.
///
/// The two passes in [`handle_display_resume`] must agree exactly, and this is
/// what makes that structural rather than argued: the only cache state it reads
/// that adoption writes is the claimed row's own acked hash, and no row is
/// classified twice.
fn classify_resume_row<'a>(
    cache: &PerPeerDisplayCache,
    adopt_from_grid: bool,
    current_row_hashes: &[u64],
    current_row_captures: &'a HashMap<u16, CapturedRow>,
    row: usize,
    client_hash: u64,
) -> ResumeRowClaim<'a> {
    // Refusing display during an outage deliberately leaves dirty rows unsent.
    // The browser can match our old ACK baseline while differing from the live
    // grid. Those rows must belong to the repair marker, not arrive as ordinary
    // deltas after an empty marker has already released the browser's hold.
    if cache.acked_row_hashes.get(row).copied() == Some(client_hash)
        && (!adopt_from_grid || current_row_hashes.get(row).copied() == Some(client_hash))
    {
        return ResumeRowClaim::InSync;
    }
    let Ok(row) = u16::try_from(row) else {
        return ResumeRowClaim::InSync;
    };
    // The peer is displaying exactly what the daemon has: adopt it as the
    // acknowledged baseline, cells included, so the flush does not re-send a
    // row the peer already holds. Neither diverged nor repaired — there is
    // nothing to repair.
    if adopt_from_grid
        && current_row_hashes.get(usize::from(row)).copied() == Some(client_hash)
        && let Some(captured) = current_row_captures.get(&row)
        && captured.hash == client_hash
        && cache.can_adopt_peer_row(captured)
    {
        return ResumeRowClaim::Adoptable(captured);
    }
    ResumeRowClaim::Diverged(row)
}

/// `current_row_hashes` and `current_row_captures` are the owner loop's view of
/// the live grid, both written by the same `refresh_flush_row_captures` pass, so
/// a row's hash and its cells are one fact rather than two that could disagree.
pub(crate) fn handle_display_resume(
    msg: &PeerMessage,
    body: &[u8],
    peers: &mut PeerMap,
    current_row_hashes: &[u64],
    current_row_captures: &HashMap<u16, CapturedRow>,
) {
    // Resume payload: generation(4) | last_seq(4) | repair_id(4) |
    // cols(2) | rows(2). The repair id distinguishes consecutive preserved
    // reconnects whose display generation deliberately stays unchanged.
    // The cols/rows let the daemon decide synchronously between
    // delta-replay (cache matches client's viewport) and snapshot
    // (dimensions or generation diverged) without racing against
    // an in-flight snapshot.
    let Some(base) = body.get(..16) else {
        return;
    };
    let requested_gen = u32::from_be_bytes([base[0], base[1], base[2], base[3]]);
    let requested_last_seq = u32::from_be_bytes([base[4], base[5], base[6], base[7]]);
    let repair_id = u32::from_be_bytes([base[8], base[9], base[10], base[11]]);
    let requested_cols = u16::from_be_bytes([base[12], base[13]]);
    let requested_rows = u16::from_be_bytes([base[14], base[15]]);
    let Some(client_row_hashes) = parse_resume_row_hashes(body, requested_rows) else {
        return;
    };
    let Some(peer) = peers.get_mut(&*msg.peer_node_id) else {
        return;
    };
    // The deadline snapshot may win the owner-loop select against an already
    // queued resume frame. Once that snapshot succeeds, it clears both the gate
    // and `needs_snapshot`; the old-generation resume is then stale and must not
    // arm a redundant second snapshot. A genuine cache-resume decision still has
    // an awaiting gate, while a fresh/rejected path still needs its snapshot.
    if peer.awaiting_resume_until_ms.is_none() && !peer.needs_snapshot {
        info!(
            "ignoring duplicate/late display resume after decision: peer={}",
            peer.peer_id
        );
        return;
    }
    // Resume gate cleared either way — the resume handler is now
    // driving the decision instead of the awaiting_resume timer.
    peer.awaiting_resume_until_ms = None;

    // The one place the daemon learns whether the peer preserved its display.
    //
    // The browser publishes row hashes exactly when its epoch fence preserved
    // the grid, and it keeps its compression dictionary under exactly the same
    // condition. So a claim WITHOUT hashes is the peer stating it threw both
    // away, and a dictionary held here would describe bytes it no longer has. A
    // claim WITH hashes means it kept them, and the dictionary survives the
    // carrier swap with the grid — which is why `carrier_boundary` no longer
    // drops it, and what saves a readiness/install/ack round trip plus cold
    // compression on the very frames the user is waiting for.
    //
    // Deliberately about what the PEER kept, not about which way the decision
    // below goes: a snapshot forced by divergence still leaves the browser
    // holding the dictionary it just told us about.
    if client_row_hashes.is_none() {
        peer.discard_dictionary_for_snapshot();
    }

    // Coordinates identify which retained cache we *could* compare, but only
    // the browser's complete row-hash claim proves that cache still describes
    // its grid. A claimless resume means the browser discarded its terminal
    // state. Treating matching generation/dimensions alone as reusable would
    // select an empty full diff against the daemon's already-acked baseline,
    // leaving the reset browser blank indefinitely.
    let cache_usable = client_row_hashes.is_some()
        && peer.display_cache.initialized
        && peer.generation == requested_gen
        && peer.display_cache.cols == requested_cols
        && peer.display_cache.rows == requested_rows;

    if cache_usable {
        // Incremental resume: the daemon's acknowledged row state is the client's
        // last-known view. needs_full_diff = true makes the flush
        // loop walk every row whose current hash differs from the
        // acked baseline; arming the reliable window on every row
        // routes those rows through the reliable stream so the
        // catch-up delta is guaranteed delivery (we're recovering
        // from a network gap; we don't trust unreliable datagrams
        // here).
        peer.needs_full_diff = true;
        peer.needs_snapshot = false;
        // Exact per-row comparison. The client sends one hash per row, so the
        // repair set is precisely the rows that diverged — a 16-row Merkle
        // branch used to drag up to fifteen in-sync rows into every repair, and
        // a full row costs far more on the wire than the eight bytes proving it.
        //
        // Each claim is answered against BOTH baselines, because a rebind has
        // already destroyed one of them: `carrier_boundary` disowns every row
        // whose newest send was still in flight, zeroing its acked hash. A TUI
        // repainting per keystroke holds most of the screen in flight at any
        // instant, so comparing against the acked baseline alone read a screen
        // the browser had fully applied as a screen-wide divergence and paid for
        // a snapshot on every carrier swap.
        let mut mismatched_rows = Vec::new();
        let mut adopted_rows = 0usize;
        if let Some(client_row_hashes) = client_row_hashes {
            // Adoption reads the live grid, so it is sound only while the live
            // grid IS this cache's screen. `handle_resize_request` resizes the
            // terminal and arms `needs_snapshot` on every peer WITHOUT resizing
            // their caches, and this handler still runs in that state — an
            // armed `needs_snapshot` is exactly what holds the gate open above
            // — so the hash vector can describe a screen of a different height.
            // One comparison, hoisted out of the loop; when it fails every
            // non-acked-matching row is diverged, which is where this code
            // started.
            let adopt_from_grid = current_row_hashes.len() == usize::from(peer.display_cache.rows);
            // Two passes: one decides, one credits. `resume_repair_beats_snapshot`
            // can still answer "snapshot", and a snapshot resets the whole cache
            // on send — so nothing may be credited before the answer is known.
            // Adopting first left the cache half-credited on exactly the branch
            // that abandons it, making correctness depend on the snapshot send's
            // retry/backoff eventually succeeding. Neither pass allocates; the
            // claim is bounded at 256 rows, so classifying twice is cheaper than
            // remembering the first answer.
            let mut diverged_rows = 0usize;
            let mut adoptable_rows = 0usize;
            for (row, chunk) in client_row_hashes
                .chunks_exact(DISPLAY_RESUME_HASH_BYTES)
                .enumerate()
            {
                let client_hash = u64::from_be_bytes(chunk.try_into().unwrap_or([0; 8]));
                match classify_resume_row(
                    &peer.display_cache,
                    adopt_from_grid,
                    current_row_hashes,
                    current_row_captures,
                    row,
                    client_hash,
                ) {
                    ResumeRowClaim::InSync => {}
                    ResumeRowClaim::Adoptable(_) => adoptable_rows += 1,
                    ResumeRowClaim::Diverged(_) => diverged_rows += 1,
                }
            }
            if !resume_repair_beats_snapshot(diverged_rows, usize::from(requested_rows)) {
                // Most of the screen diverged. Repairing it row by row would
                // cost more bytes than a snapshot and would repaint
                // progressively; the snapshot is one atomic frame. The cache is
                // reset by `next_generation` on the snapshot send, and the pass
                // above touched nothing, so it is still exactly as the outage
                // left it.
                peer.needs_snapshot = true;
                peer.needs_full_diff = false;
                info!(
                    "incremental resume declined for a snapshot: peer={} generation={} rows={} diverged_rows={} adoptable_rows={}",
                    peer.peer_id, requested_gen, requested_rows, diverged_rows, adoptable_rows,
                );
                return;
            }
            // The deciding pass already counted them, so the repair set costs
            // one exactly-sized allocation instead of a growth sequence.
            mismatched_rows.reserve_exact(diverged_rows);
            for (row, chunk) in client_row_hashes
                .chunks_exact(DISPLAY_RESUME_HASH_BYTES)
                .enumerate()
            {
                let client_hash = u64::from_be_bytes(chunk.try_into().unwrap_or([0; 8]));
                match classify_resume_row(
                    &peer.display_cache,
                    adopt_from_grid,
                    current_row_hashes,
                    current_row_captures,
                    row,
                    client_hash,
                ) {
                    ResumeRowClaim::InSync => {}
                    ResumeRowClaim::Adoptable(captured) => {
                        peer.display_cache.adopt_peer_row(captured);
                        adopted_rows += 1;
                    }
                    ResumeRowClaim::Diverged(row) => mismatched_rows.push(row),
                }
            }
            debug_assert_eq!(mismatched_rows.len(), diverged_rows);
            debug_assert_eq!(adopted_rows, adoptable_rows);
            // The browser holds its paint until every one of these has landed,
            // so the repaint is one step rather than a row-by-row reveal of a
            // screen that changed during the outage.
            if !peer
                .display_cache
                .begin_resume_repair(repair_id, &mismatched_rows)
            {
                // The 256-row protocol bound plus the half-screen decision
                // above proves this cannot happen for a valid viewport. Keep
                // the failure explicit: an incomplete membership marker would
                // let the browser expose a partial repair, while a snapshot is
                // an already-supported authoritative replacement.
                peer.needs_snapshot = true;
                peer.needs_full_diff = false;
                return;
            }
            peer.display_cache.invalidate_rows(&mismatched_rows);
        }
        info!(
            "incremental resume accepted: peer={} generation={} last_seq={} cols={} rows={} hashes={} repaired_rows={} adopted_rows={}",
            peer.peer_id,
            requested_gen,
            requested_last_seq,
            requested_cols,
            requested_rows,
            client_row_hashes.is_some(),
            mismatched_rows.len(),
            adopted_rows,
        );
    } else {
        // Generation rollover, dimensions changed, or cache never
        // initialized — fall back to a fresh snapshot. The flush
        // path will pick this up on the next tick.
        //
        // Fast-forward past the client's generation first. After a
        // daemon restart our counter restarts low while the client
        // keeps per-generation duplicate tracking from the previous
        // run; if our counter later walks through the client's
        // current generation, fresh low seqs are silently dropped as
        // duplicates and never acked. Jumping to requested_gen here makes the
        // snapshot send's next_generation() land after it in serial-number
        // order, including requested_gen=u32::MAX -> generation 1. If our live
        // counter is already numerically higher, keep it: the authenticated
        // resume starts a fresh browser display epoch, so the reliable seq-zero
        // snapshot may legitimately reuse the requested generation at the
        // MAX -> 1 edge.
        if peer.generation < requested_gen {
            peer.generation = requested_gen;
        }
        peer.needs_snapshot = true;
        peer.needs_full_diff = false;
        info!(
            "incremental resume rejected (falling back to snapshot): peer={} requested(gen={} cols={} rows={}) daemon(gen={} cols={} rows={} initialized={})",
            peer.peer_id,
            requested_gen,
            requested_cols,
            requested_rows,
            peer.generation,
            peer.display_cache.cols,
            peer.display_cache.rows,
            peer.display_cache.initialized,
        );
    }
}

/// Split the optional per-row hash block off a resume body.
///
/// `Some(None)` is a claimless resume — a normal state, not a fallback: the
/// peer simply gets a snapshot. `None` rejects the frame outright, because a
/// row-hash block that does not describe exactly `rows` rows would let the
/// daemon skip repairing rows nobody actually described.
fn parse_resume_row_hashes(body: &[u8], rows: u16) -> Option<Option<&[u8]>> {
    const FIXED_BYTES: usize = 16;
    if body.len() == FIXED_BYTES {
        return Some(None);
    }
    let hash_bytes = usize::from(rows) * DISPLAY_RESUME_HASH_BYTES;
    let expected = FIXED_BYTES + DISPLAY_RESUME_HASHES_HEADER_BYTES + hash_bytes;
    if body.len() != expected
        || body[FIXED_BYTES] != DISPLAY_RESUME_HASHES_VERSION
        || body[FIXED_BYTES + 1] != 0
        || u16::from_be_bytes([body[FIXED_BYTES + 2], body[FIXED_BYTES + 3]]) != rows
    {
        return None;
    }
    Some(Some(
        &body[FIXED_BYTES + DISPLAY_RESUME_HASHES_HEADER_BYTES..],
    ))
}

pub(crate) fn handle_peer_disconnect(
    msg: &PeerMessage,
    body: &[u8],
    peers: &mut PeerMap,
    event_tx: &EventSink,
) {
    let reason_code = if !body.is_empty() { body[0] } else { 0 };
    info!(
        "peer disconnect message: peer={} reason={}",
        msg.peer_node_id, reason_code
    );
    if let Some(mut peer) = peers.remove(&*msg.peer_node_id) {
        if let Some(tunnel) = peer.edge_tunnel.take() {
            tunnel.close();
        }
        if let Some(tunnel) = peer.edge_tunnel_bulk.take() {
            tunnel.close();
        }
    }
    send_json_event(
        event_tx,
        EVT_PEER_DISCONNECTED,
        &PeerDisconnectedEvt {
            peer_node_id: msg.peer_node_id.to_string(),
            reason: format!("disconnect (code {})", reason_code),
        },
    );
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use merkur_codec::CellRepr;

    use super::*;
    use crate::connection::{PeerTransport, SentRow};

    fn resumable_peer(id: &str, generation: u32) -> PeerDisplayState {
        let mut peer = PeerDisplayState::new(id.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.generation = generation;
        peer.display_cache.resize(2, 1);
        peer.display_cache.initialized = true;
        peer
    }

    /// Build a resume body carrying one exact hash per row.
    fn resume_body(generation: u32, cols: u16, rows: u16, hashes: Option<&[u64]>) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&generation.to_be_bytes());
        body.extend_from_slice(&50u32.to_be_bytes());
        body.extend_from_slice(&91u32.to_be_bytes());
        body.extend_from_slice(&cols.to_be_bytes());
        body.extend_from_slice(&rows.to_be_bytes());
        if let Some(hashes) = hashes {
            body.push(DISPLAY_RESUME_HASHES_VERSION);
            body.push(0);
            body.extend_from_slice(&rows.to_be_bytes());
            for hash in hashes {
                body.extend_from_slice(&hash.to_be_bytes());
            }
        }
        body
    }

    fn resume_message(peer_id: &str) -> PeerMessage {
        PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from(peer_id),
            channel_id: 0,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        }
    }

    fn peer_with_acked_rows(id: &str, generation: u32, cols: u16, rows: u16) -> PeerDisplayState {
        let mut peer = resumable_peer(id, generation);
        peer.display_cache.resize(cols, rows);
        peer.display_cache.initialized = true;
        for (index, hash) in peer.display_cache.acked_row_hashes.iter_mut().enumerate() {
            *hash = u64::try_from(index + 1).unwrap();
        }
        peer.display_cache.acked_row_exact.fill(true);
        peer
    }

    /// A capture whose cells are distinct per hash, so an adoption that
    /// installed the wrong row's cells is visible rather than accidentally
    /// equal to the right ones.
    fn row_capture(cols: u16, row: u16, hash: u64) -> CapturedRow {
        let mut cells = vec![CellRepr::BLANK; usize::from(cols)];
        if let Some(first) = cells.first_mut() {
            first.codepoint = u32::try_from(hash & 0xffff).unwrap();
        }
        CapturedRow {
            graphics: merkur_codec::PreparedGraphics::EMPTY,
            row,
            hash,
            cells: cells.into(),
        }
    }

    /// The owner loop's live-grid view: the hash vector and the per-row
    /// captures, which one `refresh_flush_row_captures` pass writes together.
    fn current_grid(rows: &[CapturedRow]) -> (Vec<u64>, HashMap<u16, CapturedRow>) {
        (
            rows.iter().map(|row| row.hash).collect(),
            rows.iter().map(|row| (row.row, row.clone())).collect(),
        )
    }

    /// The grid nothing touched during the outage: every row still exactly what
    /// the daemon last acknowledged, so a claim that diverges from the acked
    /// baseline diverges from the live grid too.
    fn unchanged_grid(peer: &PeerDisplayState, cols: u16) -> (Vec<u64>, HashMap<u16, CapturedRow>) {
        let rows: Vec<CapturedRow> = peer
            .display_cache
            .acked_row_hashes
            .iter()
            .enumerate()
            .map(|(row, &hash)| row_capture(cols, u16::try_from(row).unwrap(), hash))
            .collect();
        current_grid(&rows)
    }

    /// The repair set is exactly the rows that diverged.
    ///
    /// This is the whole point of sending per-row hashes: a 16-row branch made
    /// one changed row invalidate sixteen, and a full row on the wire costs far
    /// more than the eight bytes that prove it did not need to be sent.
    #[test]
    fn a_row_hash_resume_invalidates_only_the_rows_that_diverged() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let (current_hashes, captures) = unchanged_grid(&peer, COLS);
        let mut client_hashes = peer.display_cache.acked_row_hashes.clone();
        client_hashes[20] ^= 0x55;

        let body = resume_body(7, COLS, ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        let cache = &peers["browser-1"].display_cache;
        for row in 0..usize::from(ROWS) {
            let expected = if row == 20 {
                0
            } else {
                u64::try_from(row + 1).unwrap()
            };
            assert_eq!(cache.acked_row_hashes[row], expected, "row {row}");
        }
        assert!(!peers["browser-1"].needs_snapshot);
        assert!(peers["browser-1"].needs_full_diff);
    }

    /// A claim that matches everywhere repairs nothing, so a reconnect after a
    /// quiet outage costs no rows at all.
    #[test]
    fn a_matching_row_hash_resume_repairs_nothing() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let (current_hashes, captures) = unchanged_grid(&peer, COLS);
        let client_hashes = peer.display_cache.acked_row_hashes.clone();
        let before = client_hashes.clone();

        let body = resume_body(7, COLS, ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        assert_eq!(peers["browser-1"].display_cache.acked_row_hashes, before);
        assert!(!peers["browser-1"].needs_snapshot);
    }

    #[test]
    fn outage_rows_never_offered_to_a_carrier_still_belong_to_resume_repair() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let client_hashes = peer.display_cache.acked_row_hashes.clone();
        let (mut current_hashes, mut captures) = unchanged_grid(&peer, COLS);
        for row in [3u16, 7, 12] {
            let hash = 1_000 + u64::from(row);
            current_hashes[usize::from(row)] = hash;
            captures.insert(row, row_capture(COLS, row, hash));
        }
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &resume_body(7, COLS, ROWS, Some(&client_hashes)),
            &mut peers,
            &current_hashes,
            &captures,
        );
        let peer = &peers["browser-1"];
        assert!(!peer.needs_snapshot);
        assert!(peer.needs_full_diff);
        assert!(
            peer.display_cache.completed_resume_repair().is_none(),
            "an old ACK is not permission to finish before unsent outage rows arrive"
        );
        for (row, &client_hash) in client_hashes.iter().enumerate() {
            assert_eq!(
                peer.display_cache.acked_row_hashes[row],
                if [3, 7, 12].contains(&row) {
                    0
                } else {
                    client_hash
                },
                "row {row}"
            );
        }
    }

    /// A body whose hash block does not describe exactly `rows` rows is refused
    /// outright. Accepting a short block would let the daemon skip repairing
    /// rows the client never described.
    #[test]
    fn a_row_hash_block_that_does_not_cover_every_row_is_refused() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        for corrupt in ["short", "long", "bad-version", "bad-count"] {
            let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
            let before = peer.display_cache.acked_row_hashes.clone();
            let mut hashes = before.clone();
            hashes[0] ^= 0x55;
            let mut body = resume_body(7, COLS, ROWS, Some(&hashes));
            match corrupt {
                "short" => {
                    body.truncate(body.len() - 8);
                }
                "long" => body.extend_from_slice(&[0; 8]),
                "bad-version" => body[16] = DISPLAY_RESUME_HASHES_VERSION + 1,
                // Low byte: `rows` is 40, so the high byte is already zero and
                // zeroing it would corrupt nothing.
                _ => body[19] = body[19].wrapping_add(1),
            }

            let mut peers = PeerMap::from([("browser-1".into(), peer)]);
            handle_display_resume(
                &resume_message("browser-1"),
                &body,
                &mut peers,
                &[],
                &HashMap::new(),
            );

            // Refused before any decision: the awaiting gate still stands, so
            // the deadline snapshot remains the recovery path.
            assert_eq!(
                peers["browser-1"].display_cache.acked_row_hashes, before,
                "{corrupt}"
            );
        }
    }

    /// Past half the screen a repair is both more bytes and more visible
    /// tearing than the snapshot it is an optimization over.
    #[test]
    fn a_mostly_diverged_grid_takes_the_snapshot_instead_of_a_repair() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let (current_hashes, captures) = unchanged_grid(&peer, COLS);
        let mut client_hashes = peer.display_cache.acked_row_hashes.clone();
        let before = client_hashes.clone();
        for hash in client_hashes.iter_mut().take(21) {
            *hash ^= 0x55;
        }

        let body = resume_body(7, COLS, ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        assert!(peers["browser-1"].needs_snapshot);
        assert!(!peers["browser-1"].needs_full_diff);
        // Nothing invalidated: the snapshot resets the cache wholesale.
        assert_eq!(peers["browser-1"].display_cache.acked_row_hashes, before);
    }

    /// Exactly at the boundary the repair still wins, so the threshold is a
    /// decision rather than an off-by-one.
    #[test]
    fn a_half_diverged_grid_still_repairs() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let (current_hashes, captures) = unchanged_grid(&peer, COLS);
        let mut client_hashes = peer.display_cache.acked_row_hashes.clone();
        for hash in client_hashes.iter_mut().take(20) {
            *hash ^= 0x55;
        }

        let body = resume_body(7, COLS, ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        assert!(!peers["browser-1"].needs_snapshot);
        assert!(peers["browser-1"].needs_full_diff);
        let cache = &peers["browser-1"].display_cache;
        assert!(cache.acked_row_hashes[..20].iter().all(|hash| *hash == 0));
        assert!(cache.acked_row_hashes[20..].iter().all(|hash| *hash != 0));
    }

    /// The rebind case this whole comparison exists for.
    ///
    /// A TUI repainting per keystroke has most of the screen in flight at any
    /// instant. `carrier_boundary` disowns every one of those rows — no ACK for
    /// them can ever arrive — which zeroes their acked hash. The browser applied
    /// them before the carrier died and says so in its claim, so measuring
    /// divergence against the acked baseline alone declared a fully in-sync
    /// screen diverged and bought a snapshot on every carrier swap.
    #[test]
    fn rows_the_browser_applied_while_their_ack_died_with_the_carrier_are_not_divergence() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        let mut peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        // A whole-screen repaint, on the wire and unacknowledged when the
        // carrier breaks.
        let repaint: Vec<CapturedRow> = (0..ROWS)
            .map(|row| row_capture(COLS, row, 0x9000 + u64::from(row)))
            .collect();
        let sent: Vec<SentRow> = repaint.iter().map(SentRow::from).collect();
        peer.display_cache.record_sent_rows(9, sent.iter(), 0.0, 8.0);
        assert_eq!(peer.carrier_boundary(), usize::from(ROWS));
        assert!(
            peer.display_cache
                .acked_row_hashes
                .iter()
                .all(|hash| *hash == 0),
            "the carrier boundary disowns every in-flight row"
        );

        let (current_hashes, captures) = current_grid(&repaint);
        let client_hashes = current_hashes.clone();
        let body = resume_body(7, COLS, ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        let peer = &peers["browser-1"];
        assert!(
            !peer.needs_snapshot,
            "nothing diverged, so nothing to reset"
        );
        assert!(peer.needs_full_diff);
        assert_eq!(
            peer.display_cache.acked_row_hashes, client_hashes,
            "the claim is the acknowledged baseline now"
        );
        assert_eq!(peer.display_cache.repair_pending_rows, 0);
        let (repair_id, members) = peer
            .display_cache
            .completed_resume_repair()
            .expect("a zero-row repair completes immediately");
        assert_eq!(repair_id, 91);
        assert!(members.is_empty(), "no row is repaired");
        assert!(
            !peer
                .display_cache
                .has_selectable_rows(&current_hashes, f64::INFINITY),
            "an adopted row must not be re-sent"
        );
        // The cells baseline moved with the hash: a later delta for this row
        // diffs against what the peer is actually holding.
        for (row, sent) in repaint.iter().enumerate() {
            assert_eq!(
                &peer.display_cache.acked_row_cells[row][..],
                &sent.cells[..],
                "row {row}"
            );
        }
    }

    /// The acked baseline is not the only truth: a row can equal the live grid
    /// while the daemon still holds an older acknowledged hash for it.
    #[test]
    fn a_row_equal_to_the_current_grid_is_adopted_even_when_the_acked_baseline_holds_an_older_hash()
    {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let (mut current_hashes, mut captures) = unchanged_grid(&peer, COLS);
        // Row 3 advanced past the acked baseline and the browser has it.
        let advanced = row_capture(COLS, 3, 0x7700);
        current_hashes[3] = advanced.hash;
        captures.insert(advanced.row, advanced.clone());
        let mut client_hashes = peer.display_cache.acked_row_hashes.clone();
        client_hashes[3] = advanced.hash;

        let body = resume_body(7, COLS, ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        let cache = &peers["browser-1"].display_cache;
        assert!(!peers["browser-1"].needs_snapshot);
        assert_eq!(cache.acked_row_hashes, client_hashes);
        assert_eq!(cache.repair_pending_rows, 0);
        assert!(cache.acked_row_exact[3]);
        assert!(cache.sent_row_confirmed[3]);
        assert!(!cache.sent_row_force_full_until_confirmed[3]);
        assert_eq!(&cache.acked_row_cells[3][..], &advanced.cells[..]);
    }

    /// The live grid is only evidence about this peer when it IS this peer's
    /// screen.
    ///
    /// `handle_resize_request` resizes the terminal and arms `needs_snapshot`
    /// on every peer without resizing their display caches, and an armed
    /// `needs_snapshot` is exactly what keeps the resume gate open — so a
    /// resume can arrive while the owner loop's hash vector describes a taller
    /// grid than the cache the claim is being compared against. Adopting out of
    /// it would credit rows at indices that no longer mean the same thing.
    #[test]
    fn a_live_grid_taller_than_the_peer_cache_is_never_adopted_out_of() {
        const COLS: u16 = 80;
        const CACHE_ROWS: u16 = 24;
        const LIVE_ROWS: u16 = 50;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, CACHE_ROWS);
        let live: Vec<CapturedRow> = (0..LIVE_ROWS)
            .map(|row| row_capture(COLS, row, 0x9000 + u64::from(row)))
            .collect();
        let (current_hashes, captures) = current_grid(&live);
        // Every claimed hash is present in the live grid at the very index the
        // claim names it, so without the row-count comparison the whole screen
        // would be adopted out of a grid that is not this peer's.
        let client_hashes = current_hashes[..usize::from(CACHE_ROWS)].to_vec();
        let before = peer.display_cache.acked_row_hashes.clone();

        let body = resume_body(7, COLS, CACHE_ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        let peer = &peers["browser-1"];
        assert!(
            peer.needs_snapshot,
            "with nothing adoptable the whole claim diverged"
        );
        assert!(!peer.needs_full_diff);
        assert_eq!(peer.display_cache.acked_row_hashes, before);
    }

    /// The decision comes before the credit.
    ///
    /// A claim can hold adoptable rows and still lose the snapshot comparison.
    /// Adopting as it classified left the cache half-credited on exactly the
    /// branch that abandons it, so recovery then depended on the snapshot
    /// send's retry/backoff actually succeeding; a failed send would leave rows
    /// marked acknowledged that the peer never received.
    #[test]
    fn a_claim_that_loses_to_a_snapshot_adopts_nothing() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        const DIVERGED: usize = 21;
        const ADOPTABLE: usize = 4;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let before = peer.display_cache.acked_row_hashes.clone();
        let (mut current_hashes, mut captures) = unchanged_grid(&peer, COLS);
        let mut client_hashes = before.clone();
        // Past the half-screen threshold, so the answer is a snapshot.
        for hash in client_hashes.iter_mut().take(DIVERGED) {
            *hash ^= 0x55;
        }
        // ... and yet these four rows are exactly what the live grid holds.
        for row in DIVERGED..DIVERGED + ADOPTABLE {
            let index = u16::try_from(row).unwrap();
            let advanced = row_capture(COLS, index, 0x7700 + u64::from(index));
            current_hashes[row] = advanced.hash;
            client_hashes[row] = advanced.hash;
            captures.insert(index, advanced);
        }

        let body = resume_body(7, COLS, ROWS, Some(&client_hashes));
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        let cache = &peers["browser-1"].display_cache;
        assert!(peers["browser-1"].needs_snapshot);
        assert!(!peers["browser-1"].needs_full_diff);
        assert_eq!(
            cache.acked_row_hashes, before,
            "the deciding pass must not have credited anything"
        );
        assert_ne!(
            cache.acked_row_cells[DIVERGED][..],
            captures[&u16::try_from(DIVERGED).unwrap()].cells[..],
            "an adoptable row's cells must not have been installed either"
        );
        assert_eq!(cache.repair_pending_rows, 0, "no repair was armed");
    }

    /// A claimless resume is a normal state, not a fallback: the peer takes a
    /// snapshot, which is what the claim is an optimization over.
    #[test]
    fn a_claimless_resume_requires_a_snapshot_even_when_cache_coordinates_match() {
        const COLS: u16 = 80;
        const ROWS: u16 = 40;
        let peer = peer_with_acked_rows("browser-1", 7, COLS, ROWS);
        let before = peer.display_cache.acked_row_hashes.clone();

        let (current_hashes, captures) = unchanged_grid(&peer, COLS);
        let body = resume_body(7, COLS, ROWS, None);
        let mut peers = PeerMap::from([("browser-1".into(), peer)]);
        handle_display_resume(
            &resume_message("browser-1"),
            &body,
            &mut peers,
            &current_hashes,
            &captures,
        );

        assert_eq!(peers["browser-1"].display_cache.acked_row_hashes, before);
        assert!(!peers["browser-1"].needs_full_diff);
        assert!(peers["browser-1"].needs_snapshot);
        assert_eq!(peers["browser-1"].awaiting_resume_until_ms, None);
    }

    #[test]
    fn park_take_roundtrip_preserves_resume_state() {
        let mut parked = ParkedPeers::new();
        park_disconnected_peer(&mut parked, resumable_peer("browser-1", 7), 100.0);

        let restored = parked.take("browser-1").expect("peer should be parked");
        assert_eq!(restored.generation, 7);
        assert!(restored.display_cache.initialized);
        assert_eq!(restored.display_cache.cols, 2);
        assert!(parked.take("browser-1").is_none());
    }

    #[test]
    fn parking_cancels_detached_display_preparation_and_rearms_diff() {
        let mut parked = ParkedPeers::new();
        let mut peer = resumable_peer("browser-1", 7);
        peer.display_prepare_in_flight = Some(42);
        peer.needs_full_diff = false;

        park_disconnected_peer(&mut parked, peer, 100.0);

        let restored = parked.take("browser-1").expect("peer should be parked");
        assert_eq!(restored.display_prepare_in_flight, None);
        assert!(restored.needs_full_diff);
    }

    #[test]
    fn parking_skips_peers_with_nothing_to_resume() {
        let mut parked = ParkedPeers::new();
        // Unauthenticated peer: never spliceable.
        let unauth = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        park_disconnected_peer(&mut parked, unauth, 100.0);
        // Authenticated but no display cache yet: a snapshot is needed anyway.
        let mut no_cache = PeerDisplayState::new("browser-2".into(), PeerTransport::Edge);
        no_cache.authenticated = true;
        park_disconnected_peer(&mut parked, no_cache, 100.0);

        assert_eq!(parked.len(), 0);
    }

    #[test]
    fn cap_evicts_the_oldest_entry() {
        let mut parked = ParkedPeers::new();
        for i in 0..5 {
            let id = format!("browser-{i}");
            park_disconnected_peer(&mut parked, resumable_peer(&id, i), f64::from(i));
        }

        assert_eq!(parked.len(), 4);
        // browser-0 (oldest) was evicted; the rest survive.
        assert!(parked.take("browser-0").is_none());
        assert!(parked.take("browser-4").is_some());
        assert_eq!(parked.take_removed_peer_ids(), [Arc::from("browser-0")]);
    }

    #[test]
    fn prune_drops_entries_past_the_token_ttl() {
        let mut parked = ParkedPeers::new();
        park_disconnected_peer(&mut parked, resumable_peer("browser-1", 1), 0.0);

        let ttl = SessionPolicy::PARKED_PEER_TTL_MS as f64;
        assert!(
            parked.prune(ttl).is_empty(),
            "exactly at the boundary remains reachable"
        );
        assert_eq!(parked.len(), 1);
        assert_eq!(parked.prune(ttl + 1.0), [Arc::from("browser-1")]);
        assert_eq!(parked.len(), 0);
        assert_eq!(parked.take_removed_peer_ids(), [Arc::from("browser-1")]);
    }

    #[test]
    fn rejected_resume_fast_forwards_generation_past_the_client() {
        let mut peers = HashMap::new();
        // Fresh post-restart daemon: low generation, cache not initialized.
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.generation = 4;
        peers.insert("browser-1".into(), peer);

        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from("browser-1"),
            channel_id: 0,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        // generation=6 | last_seq=50 | cols=86 | rows=42 — the client's
        // tracking from a previous daemon run.
        let mut body = Vec::new();
        body.extend_from_slice(&6u32.to_be_bytes());
        body.extend_from_slice(&50u32.to_be_bytes());
        body.extend_from_slice(&91u32.to_be_bytes());
        body.extend_from_slice(&86u16.to_be_bytes());
        body.extend_from_slice(&42u16.to_be_bytes());

        handle_display_resume(&msg, &body, &mut peers, &[], &HashMap::new());

        let peer = peers.get_mut("browser-1").unwrap();
        assert!(peer.needs_snapshot);
        assert_eq!(peer.generation, 6);
        // The snapshot send bumps once more, landing strictly above the
        // client's generation so its stale-duplicate tracking can't
        // swallow the fresh frames.
        assert_eq!(peer.next_generation(), 7);
    }

    #[test]
    fn rejected_resume_never_rolls_the_generation_backwards() {
        let mut peers = HashMap::new();
        let mut peer = resumable_peer("browser-1", 9);
        // Force rejection via dimension mismatch despite the higher gen.
        peer.display_cache.resize(2, 1);
        peers.insert("browser-1".into(), peer);

        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from("browser-1"),
            channel_id: 0,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        let mut body = Vec::new();
        body.extend_from_slice(&6u32.to_be_bytes());
        body.extend_from_slice(&50u32.to_be_bytes());
        body.extend_from_slice(&91u32.to_be_bytes());
        body.extend_from_slice(&86u16.to_be_bytes());
        body.extend_from_slice(&42u16.to_be_bytes());

        handle_display_resume(&msg, &body, &mut peers, &[], &HashMap::new());

        let peer = peers.get("browser-1").unwrap();
        assert!(peer.needs_snapshot);
        assert_eq!(peer.generation, 9);
    }

    #[test]
    fn rejected_resume_wraps_serially_past_a_max_generation_client() {
        let mut peers = HashMap::new();
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.generation = 1;
        peers.insert("browser-1".into(), peer);

        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from("browser-1"),
            channel_id: 0,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        let mut body = Vec::new();
        body.extend_from_slice(&u32::MAX.to_be_bytes());
        body.extend_from_slice(&50u32.to_be_bytes());
        body.extend_from_slice(&91u32.to_be_bytes());
        body.extend_from_slice(&86u16.to_be_bytes());
        body.extend_from_slice(&42u16.to_be_bytes());

        handle_display_resume(&msg, &body, &mut peers, &[], &HashMap::new());

        let peer = peers.get_mut("browser-1").unwrap();
        assert!(peer.needs_snapshot);
        assert_eq!(peer.generation, u32::MAX);
        assert_eq!(peer.next_generation(), 1);
    }

    #[test]
    fn rejected_resume_at_max_may_reuse_client_one_in_the_fresh_epoch() {
        let mut peers = HashMap::new();
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.generation = u32::MAX;
        peers.insert("browser-1".into(), peer);

        let msg = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::from("browser-1"),
            channel_id: 0,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        let mut body = Vec::new();
        body.extend_from_slice(&1u32.to_be_bytes());
        body.extend_from_slice(&50u32.to_be_bytes());
        body.extend_from_slice(&91u32.to_be_bytes());
        body.extend_from_slice(&86u16.to_be_bytes());
        body.extend_from_slice(&42u16.to_be_bytes());

        handle_display_resume(&msg, &body, &mut peers, &[], &HashMap::new());

        let peer = peers.get_mut("browser-1").unwrap();
        assert!(peer.needs_snapshot);
        assert_eq!(peer.generation, u32::MAX);
        // Session authentication reset the browser's display epoch, and the
        // reliable seq-zero snapshot is the authority that establishes it.
        assert_eq!(peer.next_generation(), 1);
    }

    #[test]
    fn clear_empties_everything() {
        let mut parked = ParkedPeers::new();
        park_disconnected_peer(&mut parked, resumable_peer("browser-1", 1), 0.0);
        assert_eq!(parked.clear(), [Arc::from("browser-1")]);
        assert_eq!(parked.len(), 0);
        assert_eq!(parked.take_removed_peer_ids(), [Arc::from("browser-1")]);
    }

    /// A client snapshot request must leave the peer eligible for a snapshot on
    /// the very next flush, even when an earlier failed send armed a backoff.
    ///
    /// `needs_snapshot` on its own excludes the peer from the delta loop
    /// (`can_send_delta`); a future `snapshot_retry_at_ms` on its own excludes
    /// it from the snapshot path (`peer_snapshot_due`). Set together they
    /// exclude it from *both*, and the daemon emits nothing at all until the
    /// deadline passes — up to five seconds, which is exactly the interval the
    /// client spends in its own resync drop-state discarding every frame and
    /// re-asking. The two stalls hold each other open and the screen freezes.
    #[test]
    fn a_client_snapshot_request_clears_the_send_failure_backoff() {
        let mut peers = HashMap::new();
        let mut peer = resumable_peer("browser-1", 7);
        // Exactly as a failed snapshot send leaves it: the retry parked in the
        // future, alongside the failure count that produced that delay.
        peer.snapshot_retry_at_ms = 5_000.0;
        peer.snapshot_consecutive_failures = 3;
        peers.insert("browser-1".into(), peer);

        handle_display_snapshot_request(&resume_message("browser-1"), &mut peers);

        let peer = &peers["browser-1"];
        assert!(peer.needs_snapshot, "the request arms a snapshot");
        // The deadline is the only term that can leave the peer eligible for
        // neither path, so clearing it is what makes the stall unreachable.
        assert_eq!(
            peer.snapshot_retry_at_ms, 0.0,
            "a client request is new information, not a retry of a failed send",
        );
        // The escalation ladder survives: this buys one immediate attempt, and
        // if that attempt also fails the next backoff still counts from three.
        assert_eq!(
            peer.snapshot_consecutive_failures, 3,
            "a request must not erase the failure history that spaces retries",
        );
    }

    /// The request path must not silently start skipping absent peers.
    #[test]
    fn a_snapshot_request_for_an_unknown_peer_is_ignored() {
        let mut peers = HashMap::new();
        handle_display_snapshot_request(&resume_message("browser-missing"), &mut peers);
        assert!(peers.is_empty());
    }
}
