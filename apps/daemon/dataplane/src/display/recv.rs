//! Display receive path: ACKs, resync, and client transport hints.
//!
//! There is no loss-recovery handler here. Recovery is the send path's
//! idempotent re-selection: a row that differs from the acknowledged baseline
//! is simply chosen again on a later flush.

use std::sync::Arc;
#[cfg(test)]
use std::time::Instant;

use tracing::debug;

#[cfg(test)]
use crate::connection::DisplayDatagramProtection;
use crate::connection::{
    DisplayDatagramOutcome, PeerDisplayState, PeerMap, PeerTransport, PerPeerDisplayCache, SentRow,
    TransportHint,
};
use crate::display::planner::ReceiverProfileBucket;
use crate::display::policy::{DISPLAY_ACK_MASK_WINDOW, DISPLAY_ACK_MASK_WORDS, LOSS_PACKET_THRESHOLD};
use crate::network::peer::PeerMessage;
#[cfg(test)]
use merkur_wire::protocol::DISPLAY_ACK_PAYLOAD_BYTES;
use merkur_wire::protocol::DisplayAckPayload;

/// What one acknowledgement says about a single display sequence.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum DisplayAckResolution {
    /// The browser applied it.
    Applied,
    /// Inside the window, not applied, with three newer applied datagrams.
    /// This is loss evidence, not proof that a late reordered copy cannot arrive.
    Lost,
    /// Inside the window, not applied, but recent enough to still be in
    /// flight. Says nothing either way.
    Outstanding,
    /// Sent after the newest sequence this acknowledgement describes.
    Ahead,
    /// Older than the bounded window this acknowledgement can still describe.
    Expired,
}

/// A selective display acknowledgement.
///
/// `received_mask` is anchored at `largest_seq` and counts DOWN: bit `n` of
/// word `w` reports that `largest_seq - (w * 32 + n)` was applied. Word 0 bit 0
/// is `largest_seq` itself.
///
/// The predecessor was a single cumulative sequence, and a cumulative sequence
/// cannot describe a hole. When datagrams 10-12 were lost and 13-36 arrived,
/// the browser reported 36 and this daemon credited 10-12 as delivered: the
/// acknowledged baseline gained rows the browser had never seen, re-selection
/// found nothing to re-send, and the divergence survived until the ~1s digest
/// backstop. Anchoring at the head rather than at a cumulative floor also keeps
/// the window from wedging — a floor cannot advance past a sequence that is
/// never coming.
#[derive(Clone, Copy)]
pub(crate) struct DisplayAck {
    generation: u32,
    largest_seq: u32,
    received_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    recovered_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    // First offset below three actual applied bits. Allocated-but-unadmitted
    // sequence gaps are not packet-threshold evidence. Derived once per ACK,
    // keeping the per-row and per-attempt resolution hot path constant time.
    loss_threshold_offset: u32,
    /// The browser's cumulative display grant for `generation`
    /// (`display::credit`). Independent of the applied window: a grant-only
    /// ACK repeats the window unchanged.
    grant: u32,
}

impl DisplayAck {
    #[cfg(test)]
    pub(crate) fn new(
        generation: u32,
        largest_seq: u32,
        received_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    ) -> Self {
        Self::with_recovered(
            generation,
            largest_seq,
            received_mask,
            [0; DISPLAY_ACK_MASK_WORDS],
        )
    }

    pub(crate) fn with_recovered(
        generation: u32,
        largest_seq: u32,
        received_mask: [u32; DISPLAY_ACK_MASK_WORDS],
        recovered_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    ) -> Self {
        Self {
            generation,
            largest_seq,
            received_mask,
            recovered_mask,
            loss_threshold_offset: Self::loss_threshold_offset(&received_mask),
            grant: 0,
        }
    }

    /// Attach the browser's cumulative display grant. Zero is below every
    /// generation's implicit first grant and so grants nothing.
    pub(crate) fn with_grant(mut self, grant: u32) -> Self {
        self.grant = grant;
        self
    }

    fn loss_threshold_offset(mask: &[u32; DISPLAY_ACK_MASK_WORDS]) -> u32 {
        let mut remaining = LOSS_PACKET_THRESHOLD;
        for (word_index, &word) in mask.iter().enumerate() {
            let count = word.count_ones();
            if count < remaining {
                remaining -= count;
                continue;
            }
            let mut bits = word;
            for _ in 1..remaining {
                bits &= bits - 1;
            }
            return word_index as u32 * 32 + bits.trailing_zeros() + 1;
        }
        DISPLAY_ACK_MASK_WINDOW
    }

    /// A window in which every sequence is reported applied.
    #[cfg(test)]
    pub(crate) fn dense(generation: u32, largest_seq: u32) -> Self {
        Self::new(generation, largest_seq, [u32::MAX; DISPLAY_ACK_MASK_WORDS])
    }

    fn resolution(&self, seq: u32) -> DisplayAckResolution {
        // Wrapping: a sequence above `largest_seq` produces a huge offset and
        // falls out of the window, which is the correct answer for one this
        // acknowledgement cannot have seen.
        let offset = self.largest_seq.wrapping_sub(seq);
        if offset >= DISPLAY_ACK_MASK_WINDOW {
            return if display_seq_is_older(self.largest_seq, seq) {
                DisplayAckResolution::Ahead
            } else {
                DisplayAckResolution::Expired
            };
        }
        let word = (offset >> 5) as usize;
        if self.received_mask[word] & (1u32 << (offset & 31)) != 0 {
            return DisplayAckResolution::Applied;
        }
        if offset >= self.loss_threshold_offset {
            DisplayAckResolution::Lost
        } else {
            DisplayAckResolution::Outstanding
        }
    }

    fn was_recovered(&self, seq: u32) -> bool {
        let offset = self.largest_seq.wrapping_sub(seq);
        if offset >= DISPLAY_ACK_MASK_WINDOW {
            return false;
        }
        self.recovered_mask[(offset >> 5) as usize] & (1u32 << (offset & 31)) != 0
    }
}

pub(crate) fn handle_display_resync_rows(
    msg: &PeerMessage,
    body: &[u8],
    peers: &mut PeerMap,
    _current_row_hashes: &[u64],
) {
    let generation = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    let row_count = u16::from_be_bytes([body[4], body[5]]) as usize;
    let expected_len = 6 + row_count * 2;
    if body.len() != expected_len {
        return;
    }
    let mut rows: Vec<u16> = Vec::with_capacity(row_count);
    for i in 0..row_count {
        let off = 6 + i * 2;
        rows.push(u16::from_be_bytes([body[off], body[off + 1]]));
    }
    let Some(peer) = peers.get_mut(&*msg.peer_node_id) else {
        return;
    };
    if peer.generation != generation || rows.is_empty() {
        return;
    }
    // The hash-digest backstop is now the ONLY loss signal that needs handling,
    // and its handling is trivial: disown the named rows and let the next flush
    // re-send them complete. There is no repair route to choose, no pacing
    // penalty to apply, and no distinction to draw between wire loss and state
    // divergence — the response to both is the same idempotent re-send, so the
    // daemon no longer has to guess which one it is looking at.
    peer.display_cache.invalidate_rows(&rows);
    peer.display_cache.waste.resync_rows_requested += rows.len() as u64;
    // Disowned rows are no longer overdue repairs, and the state that last
    // carried them may be one the browser is still counting as outstanding.
    let generation = peer.generation;
    peer.display_credit.bootstrap(generation);
    peer.needs_full_diff = true;
    debug!(
        "client resync: peer={} rows={} — rows disowned, next flush re-sends",
        peer.peer_id,
        rows.len(),
    );
}

pub(crate) fn handle_transport_hint(msg: &PeerMessage, body: &[u8], peers: &mut PeerMap) {
    let profile = body[0];
    let chunk_bytes = u16::from_be_bytes([body[1], body[2]]) as usize;
    let snapshot_bytes = u32::from_be_bytes([body[3], body[4], body[5], body[6]]) as usize;
    let receive_queue_datagrams = u16::from_be_bytes([body[7], body[8]]);
    let presentation_period_ms = u16::from_be_bytes([body[9], body[10]]) as f64 / 1_000.0;
    if let Some(peer) = peers.get_mut(&*msg.peer_node_id) {
        peer.apply_transport_hint(TransportHint {
            profile,
            chunk_bytes,
            snapshot_bytes,
            receive_queue_datagrams,
            presentation_period_ms,
        });
    }
}

/// Apply a bounded receiver-cost posterior delivered over authenticated CTRL.
/// The record stays off the selective-ACK datagram path.
pub(crate) fn handle_display_receiver_profile(msg: &PeerMessage, body: &[u8], peers: &mut PeerMap) {
    const HEADER_BYTES: usize = 13;
    const BUCKET_BYTES: usize = 20;
    const MAX_BUCKETS: usize = 48;
    const MAX_AGE_MS: u32 = 30 * 24 * 60 * 60 * 1_000;
    const MAX_SERVICE_DEBT_US: u32 = 5_000_000;
    const MAX_RECEIVER_COST_US: u32 = 1_000_000;
    if body.len() < HEADER_BYTES {
        return;
    }
    let revision = read_u32_be(body, 0);
    let age_ms = read_u32_be(body, 4);
    let service_debt_us = read_u32_be(body, 8).min(MAX_SERVICE_DEBT_US);
    let count = usize::from(body[12]);
    if revision == 0
        || age_ms > MAX_AGE_MS
        || count > MAX_BUCKETS
        || body.len() != HEADER_BYTES + count * BUCKET_BYTES
    {
        return;
    }
    let mut buckets = [ReceiverProfileBucket {
        dictionary_class: 0,
        size_class: 0,
        ratio_class: 0,
        sample_count: 0,
        wire_ratio_ppm: 1_000_000,
        mean_us: MAX_RECEIVER_COST_US,
        variance_us2: 0,
        upper_us: MAX_RECEIVER_COST_US,
    }; MAX_BUCKETS];
    let mut accepted = 0usize;
    for index in 0..count {
        let at = HEADER_BYTES + index * BUCKET_BYTES;
        let dictionary_class = usize::from(body[at]);
        let size_class = usize::from(body[at + 1]);
        let ratio_class = usize::from(body[at + 2]);
        let sample_count = u16::from(body[at + 3]);
        let wire_ratio_ppm = read_u32_be(body, at + 4);
        let mean_us = read_u32_be(body, at + 8).min(MAX_RECEIVER_COST_US);
        let variance_us2 = read_u32_be(body, at + 12);
        let upper_us = read_u32_be(body, at + 16).min(MAX_RECEIVER_COST_US);
        if dictionary_class >= 2
            || size_class >= 6
            || ratio_class >= 4
            || sample_count == 0
            || sample_count > 32
            || wire_ratio_ppm == 0
            || wire_ratio_ppm > 1_000_000
        {
            continue;
        }
        buckets[accepted] = ReceiverProfileBucket {
            dictionary_class,
            size_class,
            ratio_class,
            sample_count,
            wire_ratio_ppm,
            mean_us,
            variance_us2,
            upper_us,
        };
        accepted += 1;
    }
    if let Some(peer) = peers.get_mut(&*msg.peer_node_id) {
        peer.display_planning.apply_receiver_profile(
            revision,
            age_ms,
            service_debt_us,
            &buckets[..accepted],
        );
    }
}

/// One parser for both lanes, the wire codec every client encodes with.
pub(crate) fn parse_display_ack(body: &[u8]) -> Option<DisplayAck> {
    let ack = DisplayAckPayload::parse(body)?;
    Some(
        DisplayAck::with_recovered(ack.generation, ack.largest_seq, ack.received, ack.recovered)
            .with_grant(ack.grant),
    )
}

/// A display ACK body, so a harness can close the ACK loop.
#[cfg(test)]
pub(crate) fn encode_display_ack(
    generation: u32,
    largest_seq: u32,
    received_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    recovered_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    grant: u32,
) -> [u8; DISPLAY_ACK_PAYLOAD_BYTES] {
    DisplayAckPayload {
        generation,
        largest_seq,
        received: received_mask,
        recovered: recovered_mask,
        grant,
    }
    .encode()
}

pub(crate) fn read_u32_be(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

/// Handle a reliable selective display ACK arriving on the CTRL lane. It is the
/// loss-proof backstop to the datagram `displayAck`: because it rides the
/// reliable ctrl stream, its received and FEC-recovered masks reach the same
/// `handle_display_ack` path even when every datagram ACK is lost. Sequence
/// outcomes are still resolved against retained per-attempt path provenance;
/// reliable delivery changes only how the ACK reaches the daemon.
pub(crate) fn handle_reliable_display_ack(
    peer: &mut PeerDisplayState,
    ack: DisplayAck,
    now_ms: f64,
    via_transport: PeerTransport,
    current_row_hashes: &[u64],
    terminal_dirty: bool,
) {
    handle_display_ack(
        peer,
        ack,
        now_ms,
        via_transport,
        current_row_hashes,
        terminal_dirty,
    );
}

/// `terminal_dirty` is the terminal's damage no flush has captured yet: a peer
/// waiting on its browser's grant never flushes, so its own row census cannot
/// see output that arrived while it waited.
pub(crate) fn handle_display_ack(
    peer: &mut PeerDisplayState,
    ack: DisplayAck,
    now_ms: f64,
    via_transport: PeerTransport,
    current_row_hashes: &[u64],
    terminal_dirty: bool,
) {
    if peer.generation != ack.generation {
        // Stale ACK from a superseded generation (e.g. an in-flight ACK for the
        // pre-resize/pre-resume grid); nothing to advance.
        return;
    }

    if ack.largest_seq != 0 {
        let sent_high_water = peer.last_display_seq_sent;
        if sent_high_water == 0
            || (ack.largest_seq != sent_high_water
                && !display_seq_is_older(ack.largest_seq, sent_high_water))
        {
            // An ACK cannot name a sequence not exposed by an admitted original
            // or reconstructing repair. Reject it before granting liveness,
            // congestion credit, or mutating retained delivery provenance:
            // otherwise one malformed future ACK can promote every in-flight
            // row to the acknowledged baseline, after which re-selection sees
            // nothing to re-send and the rows are stranded.
            return;
        }
    }

    peer.has_receiver_ack = true;

    // The ACK is evidence the via_transport path is alive. Liveness is
    // attributed to the arrival path; the RTT sample is NOT (see below).
    let path = peer.paths.get_mut(via_transport);
    path.record_authenticated_activity(now_ms);

    // The grant is independent of the applied window, including a
    // generation-only ACK: the browser may grant before any delta of this
    // generation has applied. New credit is the exact wakeup for display work
    // that was waiting on it; the owner re-evaluates the flush after every
    // peer message.
    if peer.display_credit.grant_is_new(peer.generation, ack.grant) {
        let waiting = terminal_dirty
            || peer.display_prepare_in_flight.is_some()
            || peer
                .display_cache
                .has_selectable_rows(current_row_hashes, now_ms);
        if peer
            .display_credit
            .observe_grant(peer.generation, ack.grant, waiting)
            && waiting
        {
            peer.needs_full_diff = true;
        }
    }

    if ack.largest_seq == 0 {
        // Generation-only liveness ACK (no datagram applied); nothing to
        // advance.
        peer.record_backpressure(false);
        return;
    }
    // The applied high-water is what ends an output run's free window: from
    // here the browser has seen the run, and its grants can reflect it.
    peer.display_credit
        .note_acknowledged(peer.generation, ack.largest_seq);

    // Preserve a generation-local, wrapping-aware applied high-water after the
    // heavier per-datagram provenance below is drained. Out-of-order ACKs must
    // not move it backwards, or a late duplicate would retract credit the peer
    // has already confirmed.
    let previous_applied = peer.display_cache.last_applied_ack_seq;
    if previous_applied == 0
        || (ack.largest_seq != previous_applied
            && ack.largest_seq.wrapping_sub(previous_applied) < 0x8000_0000)
    {
        peer.display_cache.last_applied_ack_seq = ack.largest_seq;
    }

    // Selective ACK. The browser reports its newest applied sequence plus a
    // bitmap of the window below it, so each sequence resolves to exactly one
    // of five states and every one of them has a defined response.
    //
    // Applied  -> credit it. Every still-mapped datagram carries the exact
    //             immutable row snapshot for its own sequence, which is the
    //             only safe way to advance a row that has changed again since.
    // Lost     -> disown its rows. Three later sequences have already applied
    //             above it, providing bounded reordering evidence; the next
    //             flush re-sends those rows' CURRENT content, which is better
    //             than the datagram that was lost. This is the fast path that
    //             the re-send deadline used to be the only route to.
    // Outstanding / Ahead -> leave the entry alone. Expired records become an
    //             explicit unknown outcome: their bounded receiver evidence can
    //             no longer classify them. Current rows are still retried by
    //             their per-row attempt provenance. The deadline
    //             covers unresolved attempts with insufficient applied evidence,
    //             including tails and sparse allocated-but-unadmitted gaps.
    //
    // The predecessor credited every sequence at or below the acknowledged one,
    // which meant a hole was indistinguishable from delivery: rows the browser
    // never received were promoted to the acknowledged baseline and re-selection
    // then had nothing to re-send.
    peer.display_ack_drain_scratch.clear();
    let carrier_evidence = &mut peer.display_cache.applied_carrier_evidence;
    carrier_evidence.advance(ack.largest_seq);
    peer.display_ack_drain_scratch
        .extend(
            peer.display_cache
                .sent_datagrams
                .extract_if(.., |&seq, sent| {
                    let resolution = ack.resolution(seq);
                    if resolution == DisplayAckResolution::Applied
                        && !sent.reliable
                        && !ack.was_recovered(seq)
                        && let Some(path) = sent.sent_via.sole_path()
                    {
                        // FEC may arrive on a different carrier from its lost
                        // original, and a dual send cannot identify its winner.
                        // Neither proves progress on this sole physical path.
                        carrier_evidence.observe(seq, path);
                    }
                    matches!(
                        resolution,
                        DisplayAckResolution::Applied
                            | DisplayAckResolution::Lost
                            | DisplayAckResolution::Expired
                    )
                }),
        );
    let path_ack = |path| {
        let (head, mask) = carrier_evidence.window(path);
        DisplayAck::with_recovered(ack.generation, head, mask, [0; DISPLAY_ACK_MASK_WORDS])
    };
    let direct_ack = path_ack(PeerTransport::WebTransport);
    let edge_ack = path_ack(PeerTransport::Edge);
    for (seq, sent) in peer.display_ack_drain_scratch.drain(..) {
        let resolution = ack.resolution(seq);
        let outcome = match resolution {
            DisplayAckResolution::Applied if ack.was_recovered(seq) => {
                DisplayDatagramOutcome::Recovered
            }
            DisplayAckResolution::Applied => DisplayDatagramOutcome::Received,
            DisplayAckResolution::Lost => {
                let same_path_loss = sent.sent_via.sole_path().is_some_and(|path| {
                    let evidence = match path {
                        PeerTransport::WebTransport => &direct_ack,
                        PeerTransport::Edge => &edge_ack,
                    };
                    evidence.resolution(seq) == DisplayAckResolution::Lost
                });
                if same_path_loss {
                    DisplayDatagramOutcome::Lost
                } else {
                    // Three global applied successors justify row re-selection
                    // below, but a faster different carrier does not prove loss
                    // on this original's path or train its FEC policy.
                    DisplayDatagramOutcome::Unknown
                }
            }
            DisplayAckResolution::Expired => DisplayDatagramOutcome::Unknown,
            DisplayAckResolution::Outstanding | DisplayAckResolution::Ahead => {
                unreachable!("the drain retains unresolved display datagrams")
            }
        };
        peer.display_cache.record_datagram_outcome(&sent, outcome);
        if resolution == DisplayAckResolution::Lost {
            // Retire the entry, but do NOT disown its rows from here. A row this
            // datagram carried may already have been re-sent at a newer sequence
            // that is still in flight, and zeroing its send state would forget
            // that and put the row on the wire a third time. The per-row pass
            // below decides, because it reads each row's LATEST send rather than
            // this datagram's membership.
            continue;
        }
        if resolution == DisplayAckResolution::Expired {
            continue;
        }
        // Reaching here means `ack.resolution(seq)` was `Applied` — the other
        // drained states (`Lost` and `Expired`) took their `continue` arms. The
        // browser's 128-bit received bitmap therefore proved THIS exact
        // sequence was applied, which is precisely what "exact" means, so the
        // rows it carried are cell-exact regardless of whether this sequence
        // also happens to be the newest one the ACK names.
        if peer.display_admission_retry.until_ms > 0.0 {
            // Fresh delivery proves progress beyond the queue observation
            // that armed this deadline. Duplicate/liveness-only ACKs never
            // reach this branch and cannot manufacture retry wakeups.
            peer.display_admission_retry = Default::default();
        }
        advance_acked_rows_from_sent_snapshot(
            &mut peer.display_cache,
            seq,
            &sent.rows,
            sent.reliable,
            true,
        );
        // Every newly-applied row-bearing datagram is one uncensored sample of
        // the quantity the duplicate deadline predicts. Header-only frames are
        // dual-pathed control updates and reliable frames include stream HOL;
        // neither describes confirmation of a row-bearing datagram burst.
        // A repair-only exposure has no physical original admission sample.
        if !sent.reliable && !sent.header_only && sent.sent_via.any() {
            let rtt_sample_ms = (now_ms - sent.sent_at_ms).max(1.0);
            peer.display_confirm.record(rtt_sample_ms);
        }
        // The existing path confirmation RTT remains newest-only.
        // It must not train the forward carrier quote: the independently routed
        // ACK return and receiver cadence are not forward-delivery evidence.
        if seq == ack.largest_seq && !sent.reliable {
            let rtt_sample_ms = (now_ms - sent.sent_at_ms).max(1.0);
            if let Some(sent_path) = sent.sent_via.sole_path() {
                peer.paths
                    .get_mut(sent_path)
                    .record_rtt_sample(rtt_sample_ms);
            }
        }
    }

    let (current_differs, declared_lost_rows) =
        advance_acked_rows_from_ack(peer, &ack, current_row_hashes);
    peer.display_cache.waste.rows_declared_lost += declared_lost_rows;
    // OR-in, never overwrite: an ACK confirms delivery of some rows but must
    // NOT clear a repair already armed by a NACK/resync that raced ahead of it.
    // A NACK invalidates its rows (zeroing their sent_seq/expiry) and sets
    // `needs_full_diff`; the advance below skips those invalidated rows, so both
    // terms here are false for them, and a plain assignment flipped the flag
    // back off — the flush never fired and the repair was silently dropped until
    // the ~1s digest backstop. `needs_full_diff` is edge-triggered wakeup state
    // cleared only by the flush once it has actually re-encoded the rows.
    peer.needs_full_diff = peer.needs_full_diff
        || current_differs
        || declared_lost_rows > 0
        || peer.display_cache.has_sendable_rows(now_ms);

    peer.record_backpressure(false);
}

/// Advance the acknowledged baseline from one immutable send-time snapshot.
///
/// The newest speculative row may already have moved beyond `seq`; this exact
/// snapshot is therefore the only safe way to make forward progress for a
/// continuously-changing row. Stale/out-of-order ACKs cannot overwrite a newer
/// acknowledged row.
pub(crate) fn advance_acked_rows_from_sent_snapshot<'a>(
    cache: &mut PerPeerDisplayCache,
    seq: u32,
    rows: impl IntoIterator<Item = &'a SentRow>,
    reliable: bool,
    ack_is_exact: bool,
) -> usize {
    if seq == 0 {
        return 0;
    }
    let cols = usize::from(cache.cols);
    let row_count = usize::from(cache.rows);
    let mut advanced = 0usize;
    for sent in rows {
        let row = usize::from(sent.row);
        if row >= row_count || sent.cells.len() != cols {
            continue;
        }
        let acked_seq = cache.acked_row_seq.get(row).copied().unwrap_or(0);
        if acked_seq != 0
            && (display_seq_is_older(seq, acked_seq)
                || (acked_seq == seq && cache.acked_row_exact.get(row).copied().unwrap_or(false)))
        {
            continue;
        }
        let semantic_baseline_changed = cache
            .acked_row_cells
            .get(row)
            .is_none_or(|current| !Arc::ptr_eq(current, &sent.cells))
            || cache.acked_row_graphics[row] != sent.graphics
            || cache.acked_row_exact.get(row).copied() != Some(ack_is_exact);
        if let Some(slot) = cache.acked_row_cells.get_mut(row) {
            *slot = Arc::clone(&sent.cells);
        } else {
            continue;
        }
        if let Some(slot) = cache.acked_row_hashes.get_mut(row) {
            cache.acked_row_graphics[row] = sent.graphics;
            *slot = sent.hash;
        }
        if let Some(slot) = cache.acked_row_seq.get_mut(row) {
            *slot = seq;
        }
        if let Some(slot) = cache.acked_row_exact.get_mut(row) {
            *slot = ack_is_exact;
        }
        if let Some(slot) = cache.acked_row_reliable.get_mut(row) {
            *slot = reliable;
        }
        if semantic_baseline_changed && let Some(revision) = cache.acked_row_revisions.get_mut(row)
        {
            *revision = revision.wrapping_add(1);
        }
        advanced += 1;
    }
    advanced
}

/// Newest attempt of this row's current sent content that this ACK proves was
/// applied. The attempt bitmap is sparse in practice, so walking only its set
/// bits costs one four-word scan and one resolution per actual retry.
fn newest_applied_current_attempt(
    cache: &PerPeerDisplayCache,
    row: usize,
    ack: &DisplayAck,
) -> Option<(u32, bool)> {
    let latest = cache.sent_row_latest_seq.get(row).copied().unwrap_or(0);
    if latest == 0 {
        return None;
    }
    let attempts = cache.sent_row_attempt_mask.get(row)?;
    let reliable_attempts = cache.sent_row_attempt_reliable_mask.get(row)?;
    for (word_index, &word) in attempts.iter().enumerate() {
        let mut bits = word;
        while bits != 0 {
            let bit = bits.trailing_zeros();
            let offset = (word_index as u32) * 32 + bit;
            let seq = latest.wrapping_sub(offset);
            if seq != 0 && ack.resolution(seq) == DisplayAckResolution::Applied {
                let reliable = reliable_attempts[word_index] & (1u32 << bit) != 0;
                return Some((seq, reliable));
            }
            bits &= bits - 1;
        }
    }
    None
}

fn advance_current_sent_row(
    cache: &mut PerPeerDisplayCache,
    row: usize,
    seq: u32,
    reliable: bool,
) -> bool {
    if seq == 0 {
        return false;
    }
    let acked_seq = cache.acked_row_seq.get(row).copied().unwrap_or(0);
    if acked_seq != 0 {
        if display_seq_is_older(seq, acked_seq) {
            return false;
        }
        if acked_seq == seq && cache.acked_row_exact.get(row).copied().unwrap_or(false) {
            // The exact immutable datagram snapshot is advanced before this
            // per-row provenance tier runs. Seeing the same exact sequence is
            // therefore not a no-op when it is also an attempt of the current
            // content lineage: it is the evidence that retires that lineage's
            // resend deadline. Returning before setting this bit made a fully
            // acknowledged row wake and spin forever at its deadline.
            if cache.acked_row_hashes.get(row) == cache.sent_row_hashes.get(row) {
                if let Some(slot) = cache.sent_row_confirmed.get_mut(row) {
                    *slot = true;
                }
                if let Some(slot) = cache.sent_row_force_full_until_confirmed.get_mut(row) {
                    *slot = false;
                }
            }
            return false;
        }
    }
    let semantic_baseline_changed = cache
        .acked_row_cells
        .get(row)
        .zip(cache.sent_row_cells.get(row))
        .is_none_or(|(acked, sent)| !Arc::ptr_eq(acked, sent))
        || cache.acked_row_graphics[row] != cache.sent_row_graphics[row]
        || cache.acked_row_exact.get(row).copied() != Some(true);
    if let (Some(acked), Some(sent)) = (
        cache.acked_row_cells.get_mut(row),
        cache.sent_row_cells.get(row),
    ) {
        *acked = Arc::clone(sent);
        cache.acked_row_graphics[row] = cache.sent_row_graphics[row];
    } else {
        return false;
    }
    if let (Some(acked), Some(&sent)) = (
        cache.acked_row_hashes.get_mut(row),
        cache.sent_row_hashes.get(row),
    ) {
        *acked = sent;
    }
    if let Some(slot) = cache.acked_row_seq.get_mut(row) {
        *slot = seq;
    }
    if let Some(slot) = cache.acked_row_exact.get_mut(row) {
        *slot = true;
    }
    if let Some(slot) = cache.acked_row_reliable.get_mut(row) {
        *slot = reliable;
    }
    if let Some(slot) = cache.sent_row_confirmed.get_mut(row) {
        *slot = true;
    }
    if let Some(slot) = cache.sent_row_force_full_until_confirmed.get_mut(row) {
        *slot = false;
    }
    if semantic_baseline_changed && let Some(revision) = cache.acked_row_revisions.get_mut(row) {
        *revision = revision.wrapping_add(1);
    }
    true
}

/// Advance the acked grid from the retained per-row sent state, resolving every
/// row against one selective acknowledgement.
///
/// This is the second tier of crediting. The first works from the exact
/// per-datagram snapshots in `sent_datagrams`, but that map is age- and
/// size-capped: on a busy screen a row's entry is often gone by the time the
/// acknowledgement covering it lands, and without this tier the acked baseline
/// froze and `classify_flush_rows` re-sent the whole screen every flush — the
/// original "line-by-line" repaint.
///
/// Every row is resolved against the same four-state answer the drain above
/// uses, so a row whose carrying datagram the browser proved it never applied
/// is disowned here too rather than silently credited. Returns whether any
/// advanced row's CURRENT terminal content already differs from what was acked
/// (i.e. the row changed again after that send and still needs to go out), and
/// how many rows were disowned because their datagram was declared lost.
///
/// `current_row_hashes` is the owner loop's live per-row hash baseline — the
/// same vector the flush maintains and the scheduler already reads. It is
/// passed in rather than recomputed because this function used to ask the
/// terminal for each advanced row's hash, which is a full grid walk plus a full
/// row hash **per row, per acknowledgement**, for a value the flush had already
/// computed.
pub(crate) fn advance_acked_rows_from_ack(
    peer: &mut PeerDisplayState,
    ack: &DisplayAck,
    current_row_hashes: &[u64],
) -> (bool, u64) {
    let rows = usize::from(peer.display_cache.rows);
    let cache = &mut peer.display_cache;
    let mut current_differs = false;
    let mut declared_lost_rows = 0u64;
    for r in 0..rows {
        let latest_seq = match cache.sent_row_latest_seq.get(r).copied() {
            Some(seq) if seq != 0 => seq,
            _ => continue,
        };
        let sent_hash = cache.sent_row_hashes.get(r).copied().unwrap_or(0);
        let current_hash = current_row_hashes.get(r).copied();

        // Exact confirmation of this content may have arrived through any
        // retained datagram snapshot drained immediately above — including an
        // OLDER attempt of the same bytes whose sequence has already left the
        // per-row attempt window. `sent_row_seq` pins the first send of the
        // current content, so an exact acknowledgement at or after it proves
        // the browser applied this lineage and nothing of another content has
        // been sent since; that retires the lineage's re-send deadline
        // whatever the newest attempt's own fate. An exact acknowledgement
        // from BEFORE the lineage proves only that the browser once held
        // these bytes — a different version may have landed since — and is
        // deliberately not enough. Leaving a lineage-confirmed row
        // unconfirmed made it selectable at its deadline while capture had
        // nothing to send, which with same-turn scheduling is a spin. Test it
        // before reading a Lost verdict for an older retry of the same bytes.
        let lineage_first_seq = cache.sent_row_seq.get(r).copied().unwrap_or(0);
        let acked_seq = cache.acked_row_seq.get(r).copied().unwrap_or(0);
        let lineage_acknowledged = acked_seq != 0
            && lineage_first_seq != 0
            && !display_seq_is_older(acked_seq, lineage_first_seq);
        if cache.acked_row_exact.get(r).copied().unwrap_or(false)
            && cache.acked_row_hashes.get(r).copied() == Some(sent_hash)
            && (cache.sent_row_confirmed.get(r).copied().unwrap_or(false) || lineage_acknowledged)
        {
            if let Some(slot) = cache.sent_row_confirmed.get_mut(r) {
                *slot = true;
            }
            if let Some(slot) = cache.sent_row_force_full_until_confirmed.get_mut(r) {
                *slot = false;
            }
            current_differs |= current_hash.is_some_and(|current| current != sent_hash);
            continue;
        }

        // The retained record may have aged out even while one of this current
        // content version's attempts remains in the ACK window. The per-row
        // bitmap is the allocation-free second provenance tier.
        if let Some((applied_seq, reliable)) = newest_applied_current_attempt(cache, r, ack) {
            advance_current_sent_row(cache, r, applied_seq, reliable);
            current_differs |= current_hash.is_some_and(|current| current != sent_hash);
            continue;
        }

        let latest_reliable = cache
            .sent_row_latest_reliable
            .get(r)
            .copied()
            .unwrap_or(false);
        let has_reliable_attempt = cache
            .sent_row_has_reliable_attempt
            .get(r)
            .copied()
            .unwrap_or(false);
        match ack.resolution(latest_seq) {
            DisplayAckResolution::Applied => {
                advance_current_sent_row(cache, r, latest_seq, latest_reliable);
                current_differs |= current_hash.is_some_and(|current| current != sent_hash);
            }
            DisplayAckResolution::Lost => {
                if !has_reliable_attempt {
                    // Preserve the last exact browser baseline. Only the newest
                    // unreliable attempt was lost; clearing attempt state makes
                    // the current sent bytes immediately selectable without
                    // widening their next delta from a baseline the browser
                    // still demonstrably owns.
                    cache.clear_current_sent_attempt(r);
                    declared_lost_rows += 1;
                }
            }
            DisplayAckResolution::Expired => {
                if !has_reliable_attempt {
                    // This ACK can no longer provide evidence about the newest
                    // attempt. Re-send, but do not call an unknown outcome loss.
                    cache.clear_current_sent_attempt(r);
                }
            }
            DisplayAckResolution::Outstanding | DisplayAckResolution::Ahead => {}
        }
    }
    (current_differs, declared_lost_rows)
}

pub(crate) fn display_seq_is_older(seq: u32, reference: u32) -> bool {
    seq != reference && seq.wrapping_sub(reference) > 0x8000_0000
}

#[cfg(test)]
mod tests {
    use crate::display::policy::DisplayPolicy;

    use crossbeam_channel::unbounded;
    use merkur_codec::CellRepr;

    use super::*;
    use crate::connection::{SentDatagram, SentPaths, SentRow, SentRows};
    use crate::pty::{RowCaptureScratch, TerminalState};

    #[test]
    fn display_ack_round_trips_received_and_recovered_windows() {
        let received = [0x0123_4567, 0x89ab_cdef, 0x1357_9bdf, 0x2468_ace0];
        let recovered = [0x0000_0001, 0x0000_0100, 0x0001_0000, 0x1000_0000];
        let body = encode_display_ack(7, 99, received, recovered, 0x0102_0304);
        assert_eq!(body.len(), 44);
        let ack = parse_display_ack(&body).expect("current ACK body");
        assert_eq!(ack.generation, 7);
        assert_eq!(ack.largest_seq, 99);
        assert_eq!(ack.received_mask, received);
        assert_eq!(ack.recovered_mask, recovered);
        assert_eq!(ack.grant, 0x0102_0304);
        assert_eq!(&body[40..], &[1, 2, 3, 4]);
        assert!(parse_display_ack(&body[..24]).is_none());
        assert!(parse_display_ack(&body[..40]).is_none());
    }

    /// The per-row hash baseline the owner loop would be holding for this
    /// terminal. Production maintains it incrementally across flushes; a test
    /// only needs the whole thing, which is what the terminal's own test-only
    /// reader produces.
    fn terminal_row_hashes(terminal: &mut TerminalState) -> Vec<u64> {
        let mut hashes = Vec::new();
        terminal.current_row_hashes_into(&mut hashes);
        hashes
    }

    /// One cell whose glyph is `glyph`, in a one-column grid.
    fn glyph_cells(glyph: u8) -> Arc<[CellRepr]> {
        vec![CellRepr {
            codepoint: u32::from(glyph),
            ..CellRepr::BLANK
        }]
        .into()
    }

    /// ACK bits alone cannot attribute a success to a physical carrier. Loss
    /// tests retain the actual admitted header sends that supply that proof.
    fn put_edge_header_in_flight(peer: &mut PeerDisplayState, seq: u32, sent_at_ms: f64) {
        assert_ne!(seq, 0);
        peer.display_cache.insert_sent_datagram(
            seq,
            SentDatagram {
                sent_at_ms,
                rows: SentRows::default(),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: true,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );
    }

    /// The hash each of the eight in-flight rows was sent with, which is also
    /// the terminal's current hash for it: nothing changed after the send.
    const SENT_ROW_HASHES: [u64; 8] = [100, 101, 102, 103, 104, 105, 106, 107];

    /// Put rows `0..8` of a one-column, eight-row peer in flight: row `r` on its
    /// own datagram at sequence `r + 1`, then sequence 9 re-carrying rows
    /// `0..4` with identical content, so the datagram map holds memberships an
    /// invalidation has to prune from more than one record per row.
    fn put_eight_rows_in_flight(peer: &mut PeerDisplayState) {
        for row in 0..8u16 {
            let sent = SentRow {
                graphics: None,
                row,
                hash: 100 + u64::from(row),
                cells: glyph_cells(b'a' + row as u8),
            };
            let seq = u32::from(row) + 1;
            let sent_at_ms = 10.0 * f64::from(seq);
            peer.display_cache.record_sent_rows(
                seq,
                std::slice::from_ref(&sent),
                sent_at_ms,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
            peer.display_cache.insert_sent_datagram(
                seq,
                SentDatagram {
                    sent_at_ms,
                    rows: SentRows::from_iter([sent]),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: false,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }
        let resend: Vec<SentRow> = (0..4u16)
            .map(|row| SentRow {
                graphics: None,
                row,
                hash: 100 + u64::from(row),
                cells: glyph_cells(b'a' + row as u8),
            })
            .collect();
        peer.display_cache.record_sent_rows(
            9,
            &resend,
            95.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        peer.display_cache.insert_sent_datagram(
            9,
            SentDatagram {
                sent_at_ms: 95.0,
                rows: SentRows::from_iter(resend),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );
    }

    fn eight_row_peer_in_flight() -> PeerDisplayState {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 8);
        let grid = vec![CellRepr::BLANK; 8];
        peer.display_cache
            .prime_from_snapshot(&grid, &[1, 2, 3, 4, 5, 6, 7, 8], &[]);
        put_eight_rows_in_flight(&mut peer);
        peer
    }

    /// An acknowledgement anchored at 12 that applied 12, 11, 10 and 8, 7, 6:
    /// sequences 1..=5 sit at least `LOSS_PACKET_THRESHOLD` below three applied
    /// sequences without a bit of their own, so rows `0..5` resolve `Lost`;
    /// rows `5..8` resolve `Applied`.
    fn ack_losing_the_first_five_rows() -> DisplayAck {
        DisplayAck::new(1, 12, [0b0111_0111, 0, 0, 0])
    }

    /// Which rows each retained datagram record still carries, in sequence
    /// order.
    fn sent_datagram_memberships(cache: &PerPeerDisplayCache) -> Vec<(u32, Vec<u16>)> {
        cache
            .sent_datagrams
            .iter()
            .map(|(seq, sent)| (*seq, sent.rows.iter().map(|row| row.row).collect()))
            .collect()
    }

    /// Loss clears only the current version's attempt lineage. The browser's
    /// last exact baseline remains valid, and the retained datagram records are
    /// retired by their own ACK resolution rather than rewritten row by row.
    #[test]
    fn a_lossy_ack_preserves_the_acked_baseline_and_clears_attempts() {
        let mut peer = eight_row_peer_in_flight();
        let calls_before = peer.display_cache.invalidate_calls;
        let acked_hashes_before = peer.display_cache.acked_row_hashes.clone();
        let memberships_before = sent_datagram_memberships(&peer.display_cache);

        let (current_differs, declared_lost_rows) = advance_acked_rows_from_ack(
            &mut peer,
            &ack_losing_the_first_five_rows(),
            &SENT_ROW_HASHES,
        );

        assert_eq!(declared_lost_rows, 5);
        assert!(!current_differs);
        assert_eq!(
            peer.display_cache.invalidate_calls - calls_before,
            0,
            "packet loss must not invalidate the browser's exact baseline"
        );
        assert_eq!(
            peer.display_cache.acked_row_seq,
            vec![0, 0, 0, 0, 0, 6, 7, 8],
            "rows 5..8 credited at their sequences; lost rows retain their prior baseline"
        );
        assert_eq!(
            &peer.display_cache.acked_row_hashes[..5],
            &acked_hashes_before[..5],
            "loss must preserve the browser's prior exact row hashes"
        );
        assert_eq!(
            peer.display_cache.sent_row_seq,
            vec![0, 0, 0, 0, 0, 6, 7, 8]
        );
        assert_eq!(
            peer.display_cache.sent_row_latest_seq,
            vec![0, 0, 0, 0, 0, 6, 7, 8]
        );
        assert_eq!(
            sent_datagram_memberships(&peer.display_cache),
            memberships_before,
            "the per-row pass must not rewrite retained immutable snapshots"
        );
    }

    /// The same acknowledgement, counted: clearing five fixed-width attempt
    /// lineages allocates nothing.
    ///
    /// Ignored because the counting allocator is process-wide: run it alone,
    /// in release, with `--exact --nocapture`.
    #[test]
    #[ignore = "exact allocation oracle; the counting allocator is process-wide"]
    fn a_lossy_ack_clears_attempts_without_allocating() {
        use crate::edge_tunnel::test_allocations;
        let hashes = SENT_ROW_HASHES;
        let mut peer = eight_row_peer_in_flight();
        // Warm the drain scratch, then put the same rows back in flight.
        advance_acked_rows_from_ack(&mut peer, &ack_losing_the_first_five_rows(), &hashes);
        put_eight_rows_in_flight(&mut peer);
        assert_eq!(
            peer.display_cache.sent_row_seq,
            vec![1, 2, 3, 4, 5, 6, 7, 8]
        );

        test_allocations::begin();
        let (_, declared_lost_rows) =
            advance_acked_rows_from_ack(&mut peer, &ack_losing_the_first_five_rows(), &hashes);
        let tally = test_allocations::end();

        assert_eq!(declared_lost_rows, 5);
        println!(
            "lossy ack: {} allocations, {} bytes",
            tally.allocations, tally.allocated_bytes
        );
        assert_eq!(
            tally.allocations, 0,
            "clearing five attempt lineages must not allocate once the drain scratch is warm"
        );
    }

    #[test]
    fn transport_hint_updates_peer_adaptive_state() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);

        peer.apply_transport_hint(TransportHint {
            profile: 1,
            chunk_bytes: 32768,
            snapshot_bytes: 4194304,
            receive_queue_datagrams: 256,
            presentation_period_ms: 1_000.0 / 120.0,
        });

        assert_eq!(peer.adaptive.profile, 1);
        assert_eq!(peer.adaptive.chunk_target_bytes, 32768);
        assert_eq!(peer.adaptive.snapshot_target_bytes, 4194304);
        assert_eq!(peer.adaptive.presentation_period_ms, 1_000.0 / 120.0);
    }

    fn receive_transport_hint(mut peer: PeerDisplayState, profile: u8) -> PeerDisplayState {
        let peer_id = Arc::clone(&peer.peer_id);
        for transport in [PeerTransport::WebTransport, PeerTransport::Edge] {
            let path = peer.paths.get_mut(transport);
            path.available = true;
            path.last_ack_at_ms = 0.0;
        }
        let mut peers = PeerMap::from([(Arc::clone(&peer_id), peer)]);
        let message = PeerMessage {
            input_permit: None,
            peer_node_id: Arc::clone(&peer_id),
            channel_id: crate::network::protocol::CHANNEL_CTRL,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::Edge,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        let mut body = [0u8; crate::TRANSPORT_HINT_PAYLOAD_BYTES];
        body[0] = profile;
        body[1..3].copy_from_slice(&8_192u16.to_be_bytes());
        body[3..7].copy_from_slice(&65_536u32.to_be_bytes());
        body[7..9].copy_from_slice(&128u16.to_be_bytes());
        body[9..11].copy_from_slice(&8_333u16.to_be_bytes());
        handle_transport_hint(&message, &body, &mut peers);
        peers.remove(&peer_id).expect("same peer owns hint")
    }

    /// The wire hint is receiver facts only — its refresh period and the queue
    /// depth it actually holds. Nothing in it is a pacing request, so nothing
    /// the daemon has measured about the path or the display-ACK return can
    /// change what it installs.
    #[test]
    fn transport_hint_installs_receiver_facts_regardless_of_path_measurements() {
        for network_rtt_ms in [50.0, 120.0, 200.0] {
            for profile in [0u8, 1, 2] {
                for ack_path in [PeerTransport::WebTransport, PeerTransport::Edge] {
                    for (return_ms, cadence_ms) in
                        [(25.0, 0.0), (60.0, 0.0), (25.0, 20.0), (60.0, 20.0)]
                    {
                        let mut peer = ack_test_peer(SentPaths::single(PeerTransport::Edge));
                        for transport in [PeerTransport::WebTransport, PeerTransport::Edge] {
                            peer.paths.get_mut(transport).seed_rtt(network_rtt_ms);
                        }
                        let confirmation_ms = network_rtt_ms / 2.0 + return_ms + cadence_ms;
                        handle_display_ack(
                            &mut peer,
                            DisplayAck::new(1, 1, [1, 0, 0, 0]),
                            confirmation_ms,
                            ack_path,
                            &[7],
                            false,
                        );
                        assert_eq!(peer.display_cache.acked_row_hashes, [7]);
                        assert_eq!(peer.display_confirm.ewma_ms, confirmation_ms);
                        let hinted = receive_transport_hint(peer, profile);
                        assert_eq!(hinted.adaptive.profile, profile);
                        assert_eq!(hinted.adaptive.chunk_target_bytes, 8_192);
                        assert_eq!(hinted.adaptive.snapshot_target_bytes, 65_536);
                        assert_eq!(hinted.adaptive.presentation_period_ms, 8.333);
                        assert_eq!(hinted.adaptive.receive_queue_datagrams, 128);
                        assert!(hinted.adaptive.flush_hint_active);
                    }
                }
            }
        }
    }

    /// A hole in the acknowledgement must never be read as delivery.
    ///
    /// This is the defect the selective ACK exists to fix. The browser applies
    /// out of order after a loss — sequence 1 never arrives, 2 does — and the
    /// predecessor reported only "highest applied = 2", which this daemon read
    /// as "1 and 2 both arrived". Row 0's baseline advanced to content the
    /// browser had never seen, so `classify_flush_rows` found nothing to
    /// re-send and the divergence survived until the ~1s digest backstop.
    /// A browser that could not get the receive queue it asked for must bound
    /// the flush, not be papered over by the shared default.
    ///
    /// The queue-limit setters are an optional browser capability. Both ends
    /// agreeing on `DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH` by convention is not
    /// a guarantee, and a browser quietly keeping a shallower queue would drop
    /// the tail of every large redraw with nothing on either side able to say
    /// so. Reporting the depth it actually accepted turns that into a bound.
    #[test]
    fn a_shallow_receive_queue_is_taken_from_the_browser_not_assumed() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        let hint = |depth: u16| TransportHint {
            profile: 1,
            chunk_bytes: 32768,
            snapshot_bytes: 4_194_304,
            receive_queue_datagrams: depth,
            presentation_period_ms: 1_000.0 / 120.0,
        };

        peer.apply_transport_hint(hint(8));
        assert_eq!(peer.adaptive.receive_queue_datagrams, 8);

        // Zero is "this browser cannot read its own depth back", which is not
        // evidence of a shallow queue — fall back to what it was asked for.
        peer.apply_transport_hint(hint(0));
        assert_eq!(
            peer.adaptive.receive_queue_datagrams,
            crate::display::policy::DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH
        );
    }

    #[test]
    fn a_hole_in_the_acknowledgement_is_not_credited_as_delivery() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 2);
        let lost_cell = CellRepr {
            codepoint: 'a' as u32,
            ..CellRepr::BLANK
        };
        let applied_cell = CellRepr {
            codepoint: 'b' as u32,
            ..CellRepr::BLANK
        };
        peer.display_cache.record_sent_rows(
            1,
            &[SentRow {
                graphics: None,
                row: 0,
                hash: 11,
                cells: vec![lost_cell].into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        peer.display_cache.record_sent_rows(
            2,
            &[SentRow {
                graphics: None,
                row: 1,
                hash: 22,
                cells: vec![applied_cell].into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );

        // Sequences 2..=4 applied; 1 never did, and three later sequences above
        // it is the packet threshold, so it is declared lost rather than
        // outstanding.
        let mut received_mask = [0u32; DISPLAY_ACK_MASK_WORDS];
        received_mask[0] = 0b0111;
        let ack = DisplayAck::new(1, 4, received_mask);

        let current_row_hashes = vec![0u64; usize::from(peer.display_cache.rows)];
        let (_differs, declared_lost) =
            advance_acked_rows_from_ack(&mut peer, &ack, &current_row_hashes);

        assert_eq!(
            declared_lost, 1,
            "the row carried by the missing sequence must be disowned"
        );
        assert_eq!(
            peer.display_cache.acked_row_seq[0], 0,
            "row 0 rode the sequence the browser never applied; crediting it \
             strands the row until the digest backstop"
        );
        assert_eq!(
            peer.display_cache.acked_row_seq[1], 2,
            "row 1 rode a sequence the browser did apply and must be credited"
        );
    }

    /// A row already re-sent at a newer sequence must not be disowned by the
    /// loss of the older datagram that also carried it.
    ///
    /// The lost datagram's membership list is the wrong question — it is a
    /// snapshot of who rode it, not of who is still waiting on it. Disowning
    /// from that list forgets a send that is currently in flight and puts the
    /// row on the wire a third time. The per-row pass asks the right question:
    /// what was this row's LATEST send, and what did the browser say about it.
    #[test]
    fn a_row_resent_at_a_newer_sequence_survives_the_older_datagram_being_lost() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 9;
        peer.display_cache.resize(1, 1);
        let row = |hash: u64, glyph: char| SentRow {
            graphics: None,
            row: 0,
            hash,
            cells: vec![CellRepr {
                codepoint: glyph as u32,
                ..CellRepr::BLANK
            }]
            .into(),
        };
        // Sent at 1, then CHANGED and sent again at 9 before any
        // acknowledgement arrived. `record_sent_rows` pins the sequence to the
        // first send of identical content, so the row's latest send is only 9
        // because the content actually moved.
        peer.display_cache.record_sent_rows(
            1,
            &[row(11, 'a')],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        peer.display_cache.record_sent_rows(
            9,
            &[row(22, 'b')],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        peer.display_cache.insert_sent_datagram(
            1,
            SentDatagram {
                sent_at_ms: 0.0,
                rows: SentRows::from_iter([row(11, 'a')]),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );

        // 2..=8 applied; 1 is inside the window, unacknowledged, and far enough
        // behind to be declared lost. 9 is still outstanding.
        for seq in 2..=8 {
            put_edge_header_in_flight(&mut peer, seq, f64::from(seq));
        }
        let mut received_mask = [0u32; DISPLAY_ACK_MASK_WORDS];
        for offset in 0..7 {
            received_mask[0] |= 1 << offset;
        }
        let ack = DisplayAck::new(1, 8, received_mask);

        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        handle_display_ack(
            &mut peer,
            ack,
            50.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(
            peer.display_cache.sent_row_seq[0], 9,
            "the row's in-flight send at 9 must survive the loss of 1"
        );
        assert_eq!(
            peer.display_cache.waste.rows_declared_lost, 0,
            "a row whose latest send is still outstanding is not a lost row"
        );
        assert_eq!(
            peer.display_cache.datagram_outcomes.edge.declared_lost, 1,
            "the datagram itself is still counted as lost"
        );
    }

    #[test]
    fn an_applied_retry_confirms_current_content_before_an_older_attempt_is_lost() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 5;
        peer.display_cache.resize(1, 1);
        let sent = SentRow {
            graphics: None,
            row: 0,
            hash: 77,
            cells: glyph_cells(b'x'),
        };
        for seq in [1, 5] {
            peer.display_cache.record_sent_rows(
                seq,
                std::slice::from_ref(&sent),
                0.0,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
            peer.display_cache.insert_sent_datagram(
                seq,
                SentDatagram {
                    sent_at_ms: 0.0,
                    rows: SentRows::from_iter([sent.clone()]),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: false,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }

        let mut mask = [0u32; DISPLAY_ACK_MASK_WORDS];
        mask[0] = 1; // retry 5 applied; original attempt 1 is a proven hole.
        handle_display_ack(
            &mut peer,
            DisplayAck::new(1, 5, mask),
            50.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(peer.display_cache.acked_row_hashes, vec![77]);
        assert_eq!(peer.display_cache.acked_row_seq, vec![5]);
        assert!(peer.display_cache.acked_row_exact[0]);
        assert!(
            peer.display_cache.sent_row_confirmed[0],
            "the immutable snapshot and current-attempt tiers must agree that retry 5 confirmed the current lineage"
        );
        assert_eq!(peer.display_cache.sent_row_latest_seq, vec![5]);
        assert_eq!(
            peer.display_cache.waste.rows_declared_lost, 0,
            "an older lost attempt cannot disown content confirmed by its retry"
        );
    }

    #[test]
    fn a_pruned_middle_attempt_can_confirm_current_content() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 1);
        let sent = SentRow {
            graphics: None,
            row: 0,
            hash: 88,
            cells: glyph_cells(b'y'),
        };
        for seq in [1, 3, 5] {
            peer.display_cache.record_sent_rows(
                seq,
                std::slice::from_ref(&sent),
                0.0,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
        }
        assert!(peer.display_cache.sent_datagrams.is_empty());

        let mut mask = [0u32; DISPLAY_ACK_MASK_WORDS];
        mask[0] = 0b11; // 4 and the middle attempt 3 applied; 5 is ahead.
        let (_differs, lost) =
            advance_acked_rows_from_ack(&mut peer, &DisplayAck::new(1, 4, mask), &[88]);

        assert_eq!(lost, 0);
        assert_eq!(peer.display_cache.acked_row_hashes, vec![88]);
        assert_eq!(peer.display_cache.acked_row_seq, vec![3]);
        assert!(peer.display_cache.acked_row_exact[0]);
        assert_eq!(peer.display_cache.sent_row_latest_seq, vec![5]);
    }

    #[test]
    fn a_lost_latest_attempt_preserves_the_last_exact_baseline() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 1);
        peer.display_cache
            .prime_from_snapshot(&[CellRepr::BLANK], &[10], &[]);
        let acked_before = Arc::clone(&peer.display_cache.acked_row_cells[0]);
        let sent = SentRow {
            graphics: None,
            row: 0,
            hash: 20,
            cells: glyph_cells(b'z'),
        };
        peer.display_cache.record_sent_rows(
            1,
            std::slice::from_ref(&sent),
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        let mut mask = [0u32; DISPLAY_ACK_MASK_WORDS];
        mask[0] = 0b0111; // 4, 3, 2 applied; attempt 1 is lost.

        let (_differs, lost) =
            advance_acked_rows_from_ack(&mut peer, &DisplayAck::new(1, 4, mask), &[20]);

        assert_eq!(lost, 1);
        assert_eq!(peer.display_cache.acked_row_hashes, vec![10]);
        assert_eq!(
            peer.display_cache.acked_row_cells[0].as_ref(),
            &[CellRepr::BLANK]
        );
        assert!(Arc::ptr_eq(
            &peer.display_cache.acked_row_cells[0],
            &acked_before
        ));
        assert!(peer.display_cache.acked_row_exact[0]);
        assert_eq!(peer.display_cache.sent_row_hashes, vec![20]);
        assert_eq!(peer.display_cache.sent_row_latest_seq, vec![0]);
        assert!(peer.display_cache.has_selectable_rows(&[20], 0.0));
        assert!(
            peer.display_cache.row_repair_due(0, 0.0),
            "selective loss evidence repairs an already admitted row without a grant"
        );
        peer.display_cache.invalidate_rows(&[0]);
        assert!(
            !peer.display_cache.row_repair_due(0, 0.0),
            "disowned state is handled by boundary admission, not invented send provenance"
        );
    }

    #[test]
    fn a_reliable_hole_never_disowns_current_content() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 1);
        let sent = SentRow {
            graphics: None,
            row: 0,
            hash: 99,
            cells: glyph_cells(b'r'),
        };
        peer.display_cache.record_reliable_sent_rows(
            1,
            std::slice::from_ref(&sent),
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        peer.display_cache.record_sent_rows(
            2,
            std::slice::from_ref(&sent),
            1.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        let mut mask = [0u32; DISPLAY_ACK_MASK_WORDS];
        mask[0] = 0b0111;

        let (_differs, lost) =
            advance_acked_rows_from_ack(&mut peer, &DisplayAck::new(1, 5, mask), &[99]);

        assert_eq!(lost, 0);
        assert_eq!(peer.display_cache.sent_row_latest_seq, vec![2]);
        assert!(!peer.display_cache.sent_row_latest_reliable[0]);
        assert!(peer.display_cache.sent_row_has_reliable_attempt[0]);
        assert!(!peer.display_cache.has_selectable_rows(&[99], f64::INFINITY));
    }

    /// A sequence stays declared-lost in every acknowledgement until it ages out
    /// of the window, so the loss count must not grow with acknowledgement rate.
    #[test]
    fn a_lost_sequence_is_counted_once_however_many_acknowledgements_repeat_it() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 20;
        peer.display_cache.resize(1, 1);
        peer.display_cache.insert_sent_datagram(
            3,
            SentDatagram {
                sent_at_ms: 0.0,
                rows: SentRows::default(),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: true,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );

        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);

        // Sequences 3 and 4 never applied; only 3 has a retained admitted-send
        // record. Four therefore models a refused send's raw sequence hole.
        // Three successive acknowledgements all describe both holes.
        for seq in 5..=10 {
            put_edge_header_in_flight(&mut peer, seq, f64::from(seq));
        }
        for largest in [8u32, 9, 10] {
            let mut received_mask = [0u32; DISPLAY_ACK_MASK_WORDS];
            for seq in 5..=largest {
                let offset = largest - seq;
                received_mask[(offset >> 5) as usize] |= 1u32 << (offset & 31);
            }
            handle_display_ack(
                &mut peer,
                DisplayAck::new(1, largest, received_mask),
                50.0,
                PeerTransport::Edge,
                &terminal_row_hashes(&mut terminal),
                false,
            );
        }

        assert_eq!(
            peer.display_cache.datagram_outcomes.edge.declared_lost, 1,
            "only the retained admitted send is loss; repeated ACKs and raw holes add nothing"
        );
    }

    /// Retained send provenance remains attributable across display-sequence
    /// wrap; no numeric hole scan is involved.
    #[test]
    fn retained_loss_classification_survives_a_display_sequence_wrap() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.display_cache.resize(1, 1);

        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);

        // Twelve distinct cohorts cross MAX→1 with monotonically admitted,
        // nonzero identities. Each loses one actual original and receives its
        // three actual same-carrier successors. No earlier ACKed ID is reused.
        let mut next = u32::MAX - 6;
        let mut applied = Vec::new();
        for cohort in 0..12u32 {
            let mut largest = 0;
            for member in 0..4 {
                let seq = next;
                next = next.wrapping_add(1).max(1);
                largest = seq;
                put_edge_header_in_flight(&mut peer, seq, f64::from(cohort * 4 + member));
                if member != 0 {
                    applied.push(seq);
                }
            }
            peer.last_display_seq_sent = largest;
            let mut received_mask = [0u32; DISPLAY_ACK_MASK_WORDS];
            for &seq in &applied {
                let offset = largest.wrapping_sub(seq);
                if offset < DISPLAY_ACK_MASK_WINDOW {
                    received_mask[(offset >> 5) as usize] |= 1 << (offset & 31);
                }
            }
            let ack = DisplayAck::new(1, largest, received_mask);
            for duplicate in 0..2 {
                handle_display_ack(
                    &mut peer,
                    ack,
                    100.0 + f64::from(cohort * 2 + duplicate),
                    PeerTransport::Edge,
                    &terminal_row_hashes(&mut terminal),
                    false,
                );
                assert_eq!(
                    peer.display_cache.datagram_outcomes.edge.declared_lost,
                    u64::from(cohort + 1),
                    "three physically later same-path successes classify each original once"
                );
                assert_eq!(peer.display_cache.datagram_outcomes.edge.outcome_unknown, 0);
            }
        }
        assert_eq!(peer.display_cache.datagram_outcomes.edge.declared_lost, 12);
    }

    /// A gap that is only just behind the newest applied sequence is still in
    /// flight, not lost. Declaring it early would re-send rows that are about to
    /// be acknowledged, which is exactly the duplicate traffic this work removes.
    #[test]
    fn a_recent_gap_stays_outstanding_until_the_packet_threshold() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 1);
        peer.display_cache.record_sent_rows(
            5,
            &[SentRow {
                graphics: None,
                row: 0,
                hash: 33,
                cells: vec![CellRepr::BLANK].into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );

        // 6 applied, 5 did not — but only one sequence separates them.
        let mut received_mask = [0u32; DISPLAY_ACK_MASK_WORDS];
        received_mask[0] = 0b0001;
        let ack = DisplayAck::new(1, 6, received_mask);

        let current_row_hashes = vec![0u64; usize::from(peer.display_cache.rows)];
        let (_differs, declared_lost) =
            advance_acked_rows_from_ack(&mut peer, &ack, &current_row_hashes);

        assert_eq!(
            declared_lost, 0,
            "one sequence of separation is not evidence"
        );
        assert_eq!(
            peer.display_cache.sent_row_seq[0], 5,
            "an outstanding row keeps its send state; only the deadline may retire it"
        );
    }

    #[test]
    fn packet_threshold_counts_applied_datagrams_not_allocated_sequence_gaps() {
        for anchor in [1u32, 4, 128, u32::MAX - 1] {
            for applied in [
                &[0usize][..],
                &[0, 3],
                &[0, 33, 96],
                &[31, 64, 95],
                &[0, 126, 127],
            ] {
                let mut mask = [0u32; DISPLAY_ACK_MASK_WORDS];
                for &offset in applied {
                    mask[offset / 32] |= 1 << (offset % 32);
                }
                let ack = DisplayAck::new(1, anchor, mask);
                for offset in 0..DISPLAY_ACK_MASK_WINDOW {
                    let expected = if applied.contains(&(offset as usize)) {
                        DisplayAckResolution::Applied
                    } else if applied
                        .iter()
                        .filter(|&&newer| newer < offset as usize)
                        .count()
                        >= LOSS_PACKET_THRESHOLD as usize
                    {
                        DisplayAckResolution::Lost
                    } else {
                        DisplayAckResolution::Outstanding
                    };
                    assert_eq!(
                        ack.resolution(anchor.wrapping_sub(offset)),
                        expected,
                        "anchor={anchor} offset={offset} applied={applied:?}"
                    );
                }
                assert_eq!(
                    ack.resolution(anchor.wrapping_add(1)),
                    DisplayAckResolution::Ahead
                );
                assert_eq!(
                    ack.resolution(anchor.wrapping_sub(DISPLAY_ACK_MASK_WINDOW)),
                    DisplayAckResolution::Expired
                );
            }
        }
        let sparse = DisplayAck::new(1, 4, [1, 0, 0, 0]);
        assert_eq!(sparse.resolution(1), DisplayAckResolution::Outstanding);
        let evidenced = DisplayAck::new(1, 4, [0b111, 0, 0, 0]);
        assert_eq!(evidenced.resolution(1), DisplayAckResolution::Lost);
    }

    /// A sequence older than the window is unresolved forever. It is retried
    /// immediately, but is not counted as receiver-proven loss.
    #[test]
    fn a_sequence_below_the_window_is_retried_without_being_called_lost() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 1);
        peer.display_cache.record_sent_rows(
            1,
            &[SentRow {
                graphics: None,
                row: 0,
                hash: 44,
                cells: vec![CellRepr::BLANK].into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );

        let ack = DisplayAck::new(
            1,
            1 + DISPLAY_ACK_MASK_WINDOW,
            [u32::MAX; DISPLAY_ACK_MASK_WORDS],
        );

        let current_row_hashes = vec![0u64; usize::from(peer.display_cache.rows)];
        let (_differs, declared_lost) =
            advance_acked_rows_from_ack(&mut peer, &ack, &current_row_hashes);

        assert_eq!(declared_lost, 0);
        assert_eq!(
            peer.display_cache.acked_row_seq[0], 0,
            "a dense mask must not credit a sequence it does not describe"
        );
        assert_eq!(
            peer.display_cache.sent_row_latest_seq[0], 0,
            "an expired attempt can never be resolved by a later ACK and must be retried"
        );
        assert!(peer.display_cache.has_selectable_rows(&[44], 0.0));
    }

    #[test]
    fn display_ack_advances_from_sent_row_snapshot() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 1);
        let expected_cell = CellRepr {
            codepoint: 'x' as u32,
            ..CellRepr::BLANK
        };
        // Record the row as sent at seq=1 (populates sent_row_cells / sent_row_seq /
        // sent_row_hashes — the retained state the advance now reads from).
        peer.display_cache.record_sent_rows(
            1,
            &[SentRow {
                graphics: None,
                row: 0,
                hash: 7,
                cells: vec![expected_cell].into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        let sent_cells = Arc::clone(&peer.display_cache.sent_row_cells[0]);
        // Current terminal content (hash 8) still differs from the acked
        // snapshot (hash 7), so the row remains dirty.
        let (current_differs, _lost) =
            advance_acked_rows_from_ack(&mut peer, &DisplayAck::dense(1, 1), &[8]);

        assert_eq!(
            peer.display_cache.acked_row_cells[0].as_ref(),
            &[expected_cell]
        );
        assert!(Arc::ptr_eq(
            &peer.display_cache.acked_row_cells[0],
            &sent_cells
        ));
        assert_eq!(peer.display_cache.acked_row_hashes[0], 7);
        assert_eq!(peer.display_cache.acked_row_seq[0], 1);
        assert!(current_differs);
    }

    #[test]
    fn display_ack_exact_snapshots_remain_monotonic_across_seq_wrap() {
        // BTreeMap iterates numeric keys as 1, MAX even though wire order across
        // the nonzero u32 wrap is MAX, 1. The per-row stale guard must keep the
        // later MAX visit from rolling an ACKed seq=1 snapshot back.
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 1;
        peer.display_cache.resize(1, 1);
        let before_wrap = SentRow {
            graphics: None,
            row: 0,
            hash: 1,
            cells: vec![CellRepr {
                codepoint: 'x' as u32,
                ..CellRepr::BLANK
            }]
            .into(),
        };
        let after_wrap = SentRow {
            graphics: None,
            row: 0,
            hash: 2,
            cells: vec![CellRepr {
                codepoint: 'y' as u32,
                ..CellRepr::BLANK
            }]
            .into(),
        };
        let expected_after_wrap = Arc::clone(&after_wrap.cells);
        for (seq, row, sent_at_ms) in [(u32::MAX, before_wrap, 0.0), (1, after_wrap, 10.0)] {
            peer.display_cache.record_sent_rows(
                seq,
                std::slice::from_ref(&row),
                sent_at_ms,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
            peer.display_cache.sent_datagrams.insert(
                seq,
                SentDatagram {
                    sent_at_ms,
                    rows: SentRows::from_iter([row]),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: false,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }

        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 1),
            80.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(
            peer.display_cache.acked_row_cells[0][0].codepoint,
            'y' as u32
        );
        assert!(Arc::ptr_eq(
            &peer.display_cache.acked_row_cells[0],
            &expected_after_wrap
        ));
        assert_eq!(peer.display_cache.acked_row_hashes, vec![2]);
        assert_eq!(peer.display_cache.acked_row_seq, vec![1]);
        assert!(peer.display_cache.sent_datagrams.is_empty());
    }

    #[test]
    fn display_ack_ignores_stale_row_sequence() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(1, 1);
        // Row already acked at the newer seq=3.
        peer.display_cache.acked_row_seq[0] = 3;
        peer.display_cache.acked_row_cells[0] = vec![CellRepr {
            codepoint: 'n' as u32,
            ..CellRepr::BLANK
        }]
        .into();
        let old_cell = CellRepr {
            codepoint: 'o' as u32,
            ..CellRepr::BLANK
        };
        // A stale send at seq=2 arrives to be acked — must not overwrite the
        // newer acked baseline.
        peer.display_cache.record_sent_rows(
            2,
            &[SentRow {
                graphics: None,
                row: 0,
                hash: 5,
                cells: vec![old_cell].into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );

        let (current_differs, _lost) =
            advance_acked_rows_from_ack(&mut peer, &DisplayAck::dense(1, 2), &[5]);

        assert_eq!(
            peer.display_cache.acked_row_cells[0][0].codepoint,
            'n' as u32
        );
        assert_eq!(peer.display_cache.acked_row_seq[0], 3);
        assert!(!current_differs);
    }

    /// A row the hash baseline does not describe must not be reported as
    /// changed.
    ///
    /// The acknowledgement used to ask the terminal for each advanced row's
    /// current hash, so it always had an answer. It now reads the flush's
    /// maintained vector, which can be shorter than the peer's grid for one
    /// turn after a resize. "Absent" is not "changed": the flush owns damaged
    /// rows through the terminal's own dirty tracking, and inventing a
    /// difference here would arm a full diff on every acknowledgement that
    /// raced a resize.
    #[test]
    fn a_row_missing_from_the_hash_baseline_is_not_reported_as_changed() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 1;
        peer.display_cache.resize(1, 2);
        let cell = CellRepr {
            codepoint: 'z' as u32,
            ..CellRepr::BLANK
        };
        peer.display_cache.record_sent_rows(
            1,
            &[
                SentRow {
                    graphics: None,
                    row: 0,
                    hash: 41,
                    cells: vec![cell].into(),
                },
                SentRow {
                    graphics: None,
                    row: 1,
                    hash: 42,
                    cells: vec![cell].into(),
                },
            ],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );

        // A baseline covering only row 0, and agreeing with what was sent there.
        let (current_differs, declared_lost) =
            advance_acked_rows_from_ack(&mut peer, &DisplayAck::dense(1, 1), &[41]);

        assert_eq!(declared_lost, 0);
        assert!(
            !current_differs,
            "row 1 is outside the baseline, which is an absent answer rather \
             than a changed one"
        );
        assert_eq!(
            peer.display_cache.acked_row_seq,
            vec![1, 1],
            "both rows still advance; only the changed-since-send question is \
             unanswerable for row 1"
        );

        // The same acknowledgement against a baseline that does describe row 1,
        // and disagrees with it.
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 1;
        peer.display_cache.resize(1, 2);
        peer.display_cache.record_sent_rows(
            1,
            &[SentRow {
                graphics: None,
                row: 1,
                hash: 42,
                cells: vec![cell].into(),
            }],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        let (current_differs, _) =
            advance_acked_rows_from_ack(&mut peer, &DisplayAck::dense(1, 1), &[41, 43]);
        assert!(
            current_differs,
            "row 1 changed after it was sent and the baseline says so"
        );
    }

    fn ack_test_peer(sent_via: SentPaths) -> PeerDisplayState {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 1;
        peer.display_cache.resize(1, 1);
        peer.display_cache.sent_datagrams.insert(
            1,
            SentDatagram {
                sent_at_ms: 0.0,
                rows: SentRows::from_iter([SentRow {
                    graphics: None,
                    row: 0,
                    hash: 7,
                    cells: vec![CellRepr::BLANK].into(),
                }]),
                sent_via,
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );
        peer
    }

    #[test]
    fn cumulative_display_ack_reuses_drain_scratch_capacity() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.display_cache.resize(1, 1);

        for seq in 1..=4 {
            peer.display_cache.sent_datagrams.insert(
                seq,
                SentDatagram {
                    sent_at_ms: f64::from(seq),
                    rows: SentRows::default(),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: true,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }
        peer.last_display_seq_sent = 4;
        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 4),
            20.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        let warmed_capacity = peer.display_ack_drain_scratch.capacity();
        assert!(warmed_capacity >= 4);
        assert!(peer.display_ack_drain_scratch.is_empty());
        assert!(peer.display_cache.sent_datagrams.is_empty());

        for seq in 5..=8 {
            peer.display_cache.sent_datagrams.insert(
                seq,
                SentDatagram {
                    sent_at_ms: f64::from(seq),
                    rows: SentRows::default(),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: true,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }
        peer.last_display_seq_sent = 8;
        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 8),
            40.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(peer.display_ack_drain_scratch.capacity(), warmed_capacity);
        assert!(peer.display_ack_drain_scratch.is_empty());
        assert!(peer.display_cache.sent_datagrams.is_empty());
    }

    #[test]
    fn display_ack_rejects_future_sequence_before_mutating_delivery_or_liveness() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = ack_test_peer(SentPaths::single(PeerTransport::Edge));
        let sent_row = SentRow {
            graphics: None,
            row: 0,
            hash: 9,
            cells: vec![CellRepr {
                codepoint: u32::from('x'),
                ..CellRepr::BLANK
            }]
            .into(),
        };
        peer.display_cache.record_sent_rows(
            1,
            std::slice::from_ref(&sent_row),
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        let edge_activity_before = peer.paths.edge.last_ack_at_ms;

        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 2),
            80.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(peer.display_cache.last_applied_ack_seq, 0);
        assert_eq!(peer.display_cache.acked_row_seq, vec![0]);
        assert_eq!(
            peer.display_cache.acked_row_cells[0].as_ref(),
            &[CellRepr::BLANK]
        );
        assert!(peer.display_cache.sent_datagrams.contains_key(&1));
        assert!(!peer.has_receiver_ack);
        assert_eq!(peer.paths.edge.last_ack_at_ms, edge_activity_before);
    }

    #[test]
    fn generation_only_display_ack_preserves_liveness_semantics_without_sent_frames() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;

        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 0),
            80.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert!(peer.has_receiver_ack);
        assert_eq!(peer.paths.edge.last_ack_at_ms, 80.0);
        assert_eq!(peer.display_cache.last_applied_ack_seq, 0);
        assert_eq!(peer.last_display_seq_sent, 0);
    }

    #[test]
    fn display_ack_attributes_rtt_to_send_path_not_arrival_path() {
        // Datagram rode Edge; the client ACKed over direct WebTransport (its
        // fastest path). The round-trip sample must update Edge's EWMA —
        // charging it to the arrival path let a slow Edge primary inflate
        // WebTransport's EWMA while its own sat frozen at the baseline,
        // pinning itself as primary.
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = ack_test_peer(SentPaths::single(PeerTransport::Edge));
        let edge_rtt_before = peer.paths.edge.rtt_ewma_ms;
        let wt_rtt_before = peer.paths.webtransport.rtt_ewma_ms;

        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 1),
            80.0,
            PeerTransport::WebTransport,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert!(peer.paths.edge.rtt_ewma_ms > edge_rtt_before);
        assert_eq!(peer.paths.webtransport.rtt_ewma_ms, wt_rtt_before);
        // Arrival-path liveness is still credited to WebTransport.
        assert_eq!(peer.paths.webtransport.last_ack_at_ms, 80.0);
    }

    #[test]
    fn display_ack_skips_rtt_sample_for_dual_sent_datagram() {
        // A raced (dual-sent) datagram has no unambiguous carrier — the
        // first copy to arrive wins and we can't tell which. No RTT sample
        // on either path; per-path heartbeat PONGs keep the EWMAs fed.
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = ack_test_peer(SentPaths {
            webtransport: true,
            edge: true,
        });
        let edge_rtt_before = peer.paths.edge.rtt_ewma_ms;
        let wt_rtt_before = peer.paths.webtransport.rtt_ewma_ms;

        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 1),
            80.0,
            PeerTransport::WebTransport,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(peer.paths.edge.rtt_ewma_ms, edge_rtt_before);
        assert_eq!(peer.paths.webtransport.rtt_ewma_ms, wt_rtt_before);
        // The ACK still consumed the in-flight entry.
        assert!(peer.display_cache.sent_datagrams.is_empty());
    }

    #[test]
    fn display_confirmation_samples_every_newly_applied_unreliable_row_datagram_once() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 6;
        peer.display_cache.resize(1, 1);

        for seq in 1..=6 {
            peer.display_cache.sent_datagrams.insert(
                seq,
                SentDatagram {
                    sent_at_ms: f64::from(seq),
                    // An invalidated row-bearing record can have no rows left,
                    // but remains a valid confirmation-delay sample. Only the
                    // immutable header-only classification distinguishes it.
                    rows: SentRows::default(),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: seq == 5,
                    reliable: seq == 6,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }

        let edge_rtt_before = peer.paths.edge.rtt_ewma_ms;
        let ack = DisplayAck::dense(1, 6);
        handle_display_ack(
            &mut peer,
            ack,
            100.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(
            peer.display_confirm.sample_count(),
            4,
            "all four unreliable non-header datagrams must feed the estimator"
        );
        assert_eq!(
            peer.paths.edge.rtt_ewma_ms, edge_rtt_before,
            "path RTT remains newest-only, and the newest applied record was reliable"
        );

        handle_display_ack(
            &mut peer,
            ack,
            120.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );
        assert_eq!(
            peer.display_confirm.sample_count(),
            4,
            "draining the retained record makes each sample exactly once"
        );
    }

    #[test]
    fn recovered_count_requires_admitted_unreliable_sole_path_provenance() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 4;
        peer.display_cache.resize(1, 1);
        for (seq, reliable, sent_via) in [
            (1, false, SentPaths::single(PeerTransport::Edge)),
            (2, true, SentPaths::single(PeerTransport::Edge)),
            (
                3,
                false,
                SentPaths {
                    webtransport: true,
                    edge: true,
                },
            ),
            (4, false, SentPaths::single(PeerTransport::Edge)),
        ] {
            peer.display_cache.insert_sent_datagram(
                seq,
                SentDatagram {
                    sent_at_ms: 1.0,
                    rows: SentRows::default(),
                    sent_via,
                    header_only: false,
                    reliable,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }
        let received = [u32::MAX; DISPLAY_ACK_MASK_WORDS];
        let mut recovered = [0u32; DISPLAY_ACK_MASK_WORDS];
        // Seqs 1, 2 and 3 are reported recovered. Only seq 1 has eligible
        // admitted provenance; seq 2 was reliable and seq 3 was dual-sent.
        recovered[0] = 0b1110;
        handle_display_ack(
            &mut peer,
            DisplayAck::with_recovered(1, 4, received, recovered),
            50.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );
        assert_eq!(
            peer.display_cache.datagram_outcomes.edge.recovered_by_fec,
            1
        );
        assert_eq!(
            peer.display_cache.datagram_outcomes.edge.declared_lost, 0,
            "recovered-and-applied is not true wire loss"
        );
        assert_eq!(
            peer.display_cache.datagram_outcomes.edge.received, 1,
            "the other eligible applied datagram is the non-erasure denominator"
        );
        let outcomes = peer.display_cache.datagram_outcomes.edge;
        assert_eq!(
            outcomes.received + outcomes.recovered_by_fec + outcomes.declared_lost,
            2,
            "classified = received + recovered + residual lost; reliable and dual sends stay out"
        );
    }

    #[test]
    fn path_loss_requires_received_successors_on_the_original_carrier() {
        for original_path in [PeerTransport::Edge, PeerTransport::WebTransport] {
            let other_path = match original_path {
                PeerTransport::Edge => PeerTransport::WebTransport,
                PeerTransport::WebTransport => PeerTransport::Edge,
            };
            for successor_kind in 0..5 {
                for first in [1, u32::MAX - 1] {
                    for dual_original in [false, true] {
                        let mut peer = PeerDisplayState::new("path-evidence".into(), original_path);
                        peer.display_cache.resize(1, 1);
                        let original = SentRow {
                            graphics: None,
                            row: 0,
                            hash: 9,
                            cells: glyph_cells(b'x'),
                        };
                        let original_paths = if dual_original {
                            SentPaths {
                                webtransport: true,
                                edge: true,
                            }
                        } else {
                            SentPaths::single(original_path)
                        };
                        peer.display_cache.record_sent_rows_on_paths(
                            first,
                            std::slice::from_ref(&original),
                            1.0,
                            original_paths,
                            100.0,
                        );
                        peer.display_cache.insert_sent_datagram(
                            first,
                            SentDatagram {
                                sent_at_ms: 1.0,
                                rows: SentRows::from_iter([original]),
                                sent_via: original_paths,
                                header_only: false,
                                reliable: false,
                                protection: DisplayDatagramProtection::Unprotected,
                            },
                        );
                        let mut seq = first;
                        let mut applied = Vec::new();
                        for index in 0..3 {
                            seq = seq.wrapping_add(1).max(1);
                            applied.push(seq);
                            let sent_via = match successor_kind {
                                1 => SentPaths::single(other_path),
                                2 => SentPaths {
                                    webtransport: true,
                                    edge: true,
                                },
                                _ => SentPaths::single(original_path),
                            };
                            peer.last_display_seq_sent = seq;
                            peer.display_cache.insert_sent_datagram(
                                seq,
                                SentDatagram {
                                    sent_at_ms: 2.0 + index as f64,
                                    rows: SentRows::default(),
                                    sent_via,
                                    header_only: true,
                                    reliable: successor_kind == 3,
                                    protection: DisplayDatagramProtection::Unprotected,
                                },
                            );
                            let mut mask = [0; DISPLAY_ACK_MASK_WORDS];
                            for &applied_seq in &applied {
                                let offset = seq.wrapping_sub(applied_seq);
                                mask[(offset >> 5) as usize] |= 1 << (offset & 31);
                            }
                            let recovered = if successor_kind == 4 {
                                mask
                            } else {
                                [0; DISPLAY_ACK_MASK_WORDS]
                            };
                            let generation = peer.generation;
                            handle_display_ack(
                                &mut peer,
                                DisplayAck::with_recovered(generation, seq, mask, recovered),
                                10.0 + index as f64,
                                other_path,
                                &[9],
                                false,
                            );
                            assert!(!peer.display_cache.sent_datagrams.contains_key(&seq));
                            if index < 2 {
                                assert!(peer.display_cache.sent_datagrams.contains_key(&first));
                            }
                        }
                        assert_eq!(
                            peer.display_cache.sent_row_latest_seq[0], 0,
                            "global displacement still schedules the missing row"
                        );
                        assert!(peer.needs_full_diff);
                        let outcome = match original_path {
                            PeerTransport::Edge => peer.display_cache.datagram_outcomes.edge,
                            PeerTransport::WebTransport => {
                                peer.display_cache.datagram_outcomes.webtransport
                            }
                        };
                        let same_path_loss = successor_kind == 0 && !dual_original;
                        assert_eq!(
                            outcome.declared_lost,
                            u64::from(same_path_loss),
                            "path={original_path:?} kind={successor_kind} first={first} dual={dual_original}"
                        );
                        assert_eq!(
                            outcome.outcome_unknown,
                            u64::from(!same_path_loss && !dual_original)
                        );
                        if successor_kind == 1 {
                            assert!(
                                !peer
                                    .display_cache
                                    .fec_evidence
                                    .get(original_path)
                                    .replication_enabled()
                            );
                        }
                        peer.next_generation();
                        for path in [original_path, other_path] {
                            assert_eq!(
                                peer.display_cache.applied_carrier_evidence.window(path),
                                (0, [0; DISPLAY_ACK_MASK_WORDS])
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn expired_provenance_becomes_unknown_once_and_never_loss() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 1 + DISPLAY_ACK_MASK_WINDOW;
        peer.display_cache.resize(1, 1);
        for (seq, reliable, sent_via) in [
            (1, false, SentPaths::single(PeerTransport::Edge)),
            (2, true, SentPaths::single(PeerTransport::Edge)),
            (
                3,
                false,
                SentPaths {
                    webtransport: true,
                    edge: true,
                },
            ),
        ] {
            peer.display_cache.insert_sent_datagram(
                seq,
                SentDatagram {
                    sent_at_ms: 1.0,
                    rows: SentRows::default(),
                    sent_via,
                    header_only: true,
                    reliable,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }
        let ack = DisplayAck::dense(1, 1 + DISPLAY_ACK_MASK_WINDOW);

        for now_ms in [50.0, 60.0] {
            handle_display_ack(
                &mut peer,
                ack,
                now_ms,
                PeerTransport::Edge,
                &terminal_row_hashes(&mut terminal),
                false,
            );
        }

        let outcomes = peer.display_cache.datagram_outcomes.edge;
        assert_eq!(outcomes.outcome_unknown, 1);
        assert_eq!(outcomes.declared_lost, 0);
        assert_eq!(outcomes.received, 0);
        assert_eq!(outcomes.recovered_by_fec, 0);
        assert!(peer.display_cache.sent_datagrams.is_empty());
    }

    #[test]
    fn display_ack_uses_exact_older_snapshot_during_continuous_row_edits() {
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 1, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 2;
        peer.display_cache.resize(1, 1);
        let first = SentRow {
            graphics: None,
            row: 0,
            hash: 1,
            cells: vec![CellRepr {
                codepoint: 'a' as u32,
                ..CellRepr::BLANK
            }]
            .into(),
        };
        let latest = SentRow {
            graphics: None,
            row: 0,
            hash: 2,
            cells: vec![CellRepr {
                codepoint: 'b' as u32,
                ..CellRepr::BLANK
            }]
            .into(),
        };
        for (seq, row, sent_at_ms) in [(1, first, 0.0), (2, latest, 10.0)] {
            peer.display_cache.record_sent_rows(
                seq,
                std::slice::from_ref(&row),
                sent_at_ms,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
            peer.display_cache.sent_datagrams.insert(
                seq,
                SentDatagram {
                    sent_at_ms,
                    rows: SentRows::from_iter([row]),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: false,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }

        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 1),
            80.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        assert_eq!(
            peer.display_cache.acked_row_cells[0][0].codepoint,
            'a' as u32
        );
        assert_eq!(peer.display_cache.acked_row_seq, vec![1]);
        assert_eq!(
            peer.display_cache.sent_row_cells[0][0].codepoint,
            'b' as u32
        );
        assert_eq!(peer.display_cache.sent_row_seq, vec![2]);
        assert!(!peer.display_cache.sent_datagrams.contains_key(&1));
        assert!(peer.display_cache.sent_datagrams.contains_key(&2));
    }

    #[test]
    fn a_dense_window_advances_rows_whose_datagrams_were_pruned() {
        // The client ACKs ~once per render frame and both its ACK ring and the
        // datagram channel drop entries under load, so the matching
        // `sent_datagrams` are often gone by the time an acknowledgement
        // covering them lands. A window that reports those sequences applied
        // must STILL advance every row last sent at one of them — from the
        // retained per-row sent state — or the rows stay unacked and get
        // re-sent every flush (the "line-by-line" repaint). `sent_datagrams` is
        // left empty on purpose to model the drained map observed in the trace.
        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(1, 3, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.last_display_seq_sent = 3;
        peer.display_cache.resize(1, 3);
        for (seq, row) in [(1u32, 0u16), (2, 1), (3, 2)] {
            let cell = CellRepr {
                codepoint: ('a' as u32) + seq,
                ..CellRepr::BLANK
            };
            peer.display_cache.record_sent_rows(
                seq,
                &[SentRow {
                    graphics: None,
                    row,
                    hash: u64::from(seq),
                    cells: vec![cell].into(),
                }],
                0.0,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
        }

        // Client only ACKs seq=3 (it never acked 1 and 2, and their datagrams
        // were already pruned).
        handle_display_ack(
            &mut peer,
            DisplayAck::dense(1, 3),
            80.0,
            PeerTransport::Edge,
            &terminal_row_hashes(&mut terminal),
            false,
        );

        // Every row sent at seq <= 3 has its acked baseline advanced — not just
        // the row from seq=3.
        assert_eq!(peer.display_cache.acked_row_seq[0], 1);
        assert_eq!(peer.display_cache.acked_row_seq[1], 2);
        assert_eq!(peer.display_cache.acked_row_seq[2], 3);
        assert_eq!(peer.display_cache.acked_row_hashes[0], 1);
        assert_eq!(peer.display_cache.acked_row_hashes[2], 3);
    }

    /// Deterministic screen content for the acknowledgement benchmark.
    ///
    /// Local rather than shared with the send-path benchmarks: this module only
    /// needs a full grid of distinct rows, and importing across two `cfg(test)`
    /// modules would widen their visibility for one fixture.
    fn ack_benchmark_fixture(cols: u16, rows: u16, seed: u8) -> Vec<u8> {
        let mut fixture = Vec::with_capacity(usize::from(cols) * usize::from(rows));
        for row in 0..rows {
            fixture.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            for col in 0..cols {
                fixture.push(b' ' + ((seed.wrapping_add(row as u8).wrapping_add(col as u8)) % 95));
            }
        }
        fixture
    }

    /// Owner-loop cost of crediting one selective acknowledgement.
    ///
    /// The counterpart to
    /// `display::send::tests::production_display_pipeline_stage_decomposition`,
    /// which brackets the flush and stops there. Every acknowledgement resolves
    /// each row the peer still has outstanding, and for each row it advances it
    /// asks the terminal for that row's CURRENT hash — a full grid walk plus a
    /// full row hash, per row, per acknowledgement. Nothing measured that, so
    /// nothing could say whether that read belongs on this path at all.
    ///
    /// `sent_datagrams` is deliberately left empty. `record_sent_rows` populates
    /// the per-row provenance tier, and that is the tier performing the terminal
    /// reads; the datagram-snapshot tier above it copies from retained immutable
    /// snapshots and never touches the terminal.
    ///
    /// The workload alternates between two full screens, in lockstep on the
    /// terminal and in the recorded sends. That is not cosmetic:
    /// `record_sent_rows` pins `sent_row_seq` to the FIRST send of a given
    /// content so a loss-safety resend cannot outrun its own acknowledgement, so
    /// re-sending an identical screen leaves every row already acknowledged and
    /// the advance short-circuits to nothing. The `advanced_rows` assertion
    /// below fails the benchmark rather than reporting that empty measurement.
    #[test]
    #[ignore = "production performance workload"]
    fn production_display_ack_advance_benchmark() {
        const COLS: u16 = 120;
        const ROWS: u16 = 40;
        const ALLOCATION_SAMPLES: usize = 200;
        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(200);

        let (event_tx, _event_rx) = unbounded();
        let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
        let fixtures = [
            ack_benchmark_fixture(COLS, ROWS, b'a'),
            ack_benchmark_fixture(COLS, ROWS, b'b'),
        ];

        // One capture per row per screen, taken from the terminal exactly as a
        // flush takes them, so the rows this acknowledgement credits are the
        // rows a real flush would have put on the wire.
        let mut capture_scratch = RowCaptureScratch::default();
        let captures: Vec<Vec<SentRow>> = fixtures
            .iter()
            .map(|fixture| {
                terminal.apply_bytes(fixture);
                (0..ROWS)
                    .map(|row| {
                        let hash = terminal.read_row_cells(usize::from(row), &mut capture_scratch);
                        SentRow {
                            graphics: None,
                            row,
                            hash,
                            cells: capture_scratch.cells.as_slice().into(),
                        }
                    })
                    .collect()
            })
            .collect();

        let mut peer = PeerDisplayState::new("browser-bench".into(), PeerTransport::Edge);
        peer.display_cache.resize(COLS, ROWS);
        let generation = peer.generation;

        // The owner loop's live baseline, one per screen. Refreshing it is the
        // flush's work, not the acknowledgement's, so it is hoisted out of the
        // timed region exactly as it sits outside it in production.
        let row_hashes: Vec<Vec<u64>> = fixtures
            .iter()
            .map(|fixture| {
                terminal.apply_bytes(fixture);
                terminal_row_hashes(&mut terminal)
            })
            .collect();

        // Put the peer and the terminal on the same screen the first
        // acknowledgement will credit.
        let arm = |peer: &mut PeerDisplayState, terminal: &mut TerminalState, seq: u32| {
            let screen = (seq as usize) & 1;
            terminal.apply_bytes(&fixtures[screen]);
            peer.last_display_seq_sent = seq;
            peer.display_cache.record_sent_rows(
                seq,
                &captures[screen],
                0.0,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
        };

        // Untimed warm pass so first-touch growth is not attributed to a
        // steady-state acknowledgement.
        let warm = samples.min(4) as u32;
        for index in 0..warm {
            let seq = index + 1;
            arm(&mut peer, &mut terminal, seq);
            handle_display_ack(
                &mut peer,
                DisplayAck::dense(generation, seq),
                0.0,
                PeerTransport::Edge,
                &row_hashes[(seq as usize) & 1],
                false,
            );
        }

        let mut advance_samples = Vec::with_capacity(samples);
        let mut advanced_rows = 0usize;
        for sample in 0..samples {
            let seq = warm + sample as u32 + 1;
            arm(&mut peer, &mut terminal, seq);

            let started = Instant::now();
            handle_display_ack(
                &mut peer,
                DisplayAck::dense(generation, seq),
                0.0,
                PeerTransport::Edge,
                &row_hashes[(seq as usize) & 1],
                false,
            );
            advance_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            advanced_rows += peer
                .display_cache
                .acked_row_seq
                .iter()
                .filter(|acked| **acked == seq)
                .count();
        }
        assert_eq!(
            advanced_rows,
            samples * usize::from(ROWS),
            "every sample must advance every row; a sample that advances nothing \
             measures an empty acknowledgement and is not a benchmark"
        );

        // Exact shape of the acknowledgement the timings above describe.
        emit_ack_benchmark_exact_metric(
            "display-ack-advance-rows",
            usize::from(ROWS),
            1,
            "rows/ack",
        );
        emit_ack_benchmark_metric(
            "display-ack-advance",
            &mut advance_samples,
            samples,
            "ms/ack",
        );

        // Allocation tally, bracketed per acknowledgement so the re-arm that
        // sets each sample up is never counted against the acknowledgement.
        let allocation_start = warm + samples as u32 + 1;
        let mut allocations = 0usize;
        let mut allocated_bytes = 0usize;
        for sample in 0..ALLOCATION_SAMPLES {
            let seq = allocation_start + sample as u32;
            arm(&mut peer, &mut terminal, seq);

            crate::edge_tunnel::test_allocations::begin();
            handle_display_ack(
                &mut peer,
                DisplayAck::dense(generation, seq),
                0.0,
                PeerTransport::Edge,
                &row_hashes[(seq as usize) & 1],
                false,
            );
            let tally = crate::edge_tunnel::test_allocations::end();
            allocations += tally.allocations;
            allocated_bytes += tally.allocated_bytes;
        }
        emit_ack_benchmark_exact_metric(
            "display-ack-advance-allocations",
            allocations / ALLOCATION_SAMPLES,
            ALLOCATION_SAMPLES,
            "allocations/ack",
        );
        emit_ack_benchmark_exact_metric(
            "display-ack-advance-allocated-bytes",
            allocated_bytes / ALLOCATION_SAMPLES,
            ALLOCATION_SAMPLES,
            "bytes/ack",
        );
    }

    fn emit_ack_benchmark_metric(name: &str, samples: &mut [f64], sample_size: usize, unit: &str) {
        samples.sort_by(f64::total_cmp);
        let percentile = |ratio: f64| {
            let index = ((samples.len() as f64 * ratio).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len().saturating_sub(1));
            samples[index]
        };
        for ratio in [0.50, 0.95, 0.99] {
            let value = percentile(ratio);
            println!(
                "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value},\"unit\":\"{unit}\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{sample_size}}}"
            );
        }
    }

    fn emit_ack_benchmark_exact_metric(name: &str, value: usize, sample_size: usize, unit: &str) {
        println!(
            "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value},\"unit\":\"{unit}\",\"direction\":\"lower\",\"sampleSize\":{sample_size}}}"
        );
    }

    #[test]
    fn display_generation_reset_clears_applied_ack_high_water() {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.last_applied_ack_seq = 17;

        assert_eq!(peer.next_generation(), 2);
        assert_eq!(peer.display_cache.last_applied_ack_seq, 0);
    }
}
