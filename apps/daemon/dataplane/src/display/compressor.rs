use merkur_codec::{
    DISPLAY_COMPRESSED_PAYLOAD_OFFSET, DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
    DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD, DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
    DISPLAY_HEADER_FLAGS_OFFSET, FRAME_HEADER_BODY_BYTES, MSG_TYPE_DISPLAY_PATCH,
    STREAM_HEADER_BYTES,
};
use std::time::{Duration, Instant};

/// Compression level for display frames.
///
/// Measured on coloured full-screen repaints at the packed chunk size (~5 KB),
/// which is the unit the batcher produces: L1 costs the same as L3 and is 8%
/// bigger; L5 is *both* slower and bigger; L9 buys 5% for 13x the CPU and L12
/// buys 7% for 16x. L3 is the knee, not a compromise.
pub const DISPLAY_COMPRESSION_LEVEL: i32 = 3;

/// Maximum external-dictionary size, in bytes.
///
/// Measured on realistic coloured screens: a 110 KiB dictionary is no better
/// than a 16 KiB one and is sometimes worse. What a dictionary buys is the
/// pre-computed entropy tables and the most recent content, not raw window
/// size. 16 KiB also keeps the one-time install cheap on the reliable lane.
pub const DISPLAY_DICTIONARY_MAX_BYTES: usize = 16 * 1024;

/// Shorter trailing fragments skew the fitted entropy tables away from rows.
const DISPLAY_DICTIONARY_SAMPLE_MIN_BYTES: usize = 64;

/// Buffers the dictionary thread keeps across builds, so a steady session
/// finalizes without reallocating.
#[derive(Default)]
pub struct DictionaryScratch {
    samples: Vec<u8>,
    sizes: Vec<usize>,
    splitter: merkur_codec::RowSplitter,
}

/// Turn one screen's encoded rows into a finalized zstd dictionary for the
/// split payloads frames carry.
///
/// `rows` is the screen's row-layout body of `row_count` rows. A frame's
/// payload is the [split layout](merkur_codec::split_rows_into) of at most one
/// datagram's rows, so the samples are exactly that: consecutive rows grouped
/// to one datagram's worth of row bytes, each group split on its own. The
/// content is the newest groups that fit [`DISPLAY_DICTIONARY_MAX_BYTES`],
/// because the most recent screen content is the most predictive.
///
/// The content is only half a dictionary. A *finalized* dictionary carries
/// pre-computed entropy tables and a dictionary id, and both matter here:
///
/// - Measured on realistic coloured screens, finalizing the same 16 KiB of
///   content improves the ratio from 4.89x to 6.15x, for ~3 ms of work on the
///   `merkur-display-dict` thread, which nothing latency-sensitive shares.
///   Full `ZDICT_trainFromBuffer` reaches 6.25x for ~41 ms, which is not worth
///   12x the cost.
/// - Only a finalized dictionary stamps a dictionary id into every frame
///   header, so a diverged dictionary is rejected outright instead of decoding
///   to plausible garbage.
///
/// Returns an empty dictionary when the screen's split content is below
/// [`DISPLAY_DICTIONARY_MIN_BYTES`] or zstd declines to build one (too few
/// samples, or samples that are uncompressible or all identical). That is the
/// existing "this peer has no dictionary" state, not a fallback path.
pub fn finalize_display_dictionary(
    rows: &[u8],
    row_count: u16,
    scratch: &mut DictionaryScratch,
) -> Vec<u8> {
    let DictionaryScratch {
        samples,
        sizes,
        splitter,
    } = scratch;
    samples.clear();
    sizes.clear();
    let mut push_group = |group: &[u8], group_rows: u16| {
        if let Ok(split) = splitter.split(group, group_rows)
            && split.len() >= DISPLAY_DICTIONARY_SAMPLE_MIN_BYTES
        {
            samples.extend_from_slice(split);
            sizes.push(split.len());
        }
    };
    let (mut group_start, mut group_end, mut group_rows) = (0usize, 0usize, 0u16);
    for entry in merkur_codec::iter_rows_at(rows, 0, row_count) {
        let Ok(entry) = entry else {
            return Vec::new();
        };
        let entry_end = entry.offset + entry.len;
        if group_rows > 0
            && entry_end - group_start
                > crate::display::policy::DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES
        {
            push_group(&rows[group_start..group_end], group_rows);
            group_start = entry.offset;
            group_rows = 0;
        }
        group_rows += 1;
        group_end = entry_end;
    }
    if group_rows > 0 {
        push_group(&rows[group_start..group_end], group_rows);
    }
    let mut content_len = 0usize;
    for &size in sizes.iter().rev() {
        if content_len + size > DISPLAY_DICTIONARY_MAX_BYTES {
            break;
        }
        content_len += size;
    }
    if content_len == 0 {
        // One group larger than the cap: keep its newest bytes.
        content_len = samples.len().min(DISPLAY_DICTIONARY_MAX_BYTES);
    }
    if content_len < DISPLAY_DICTIONARY_MIN_BYTES {
        return Vec::new();
    }
    finalize_split_samples(&samples[samples.len() - content_len..], samples, sizes)
}

/// Finalize `content` with entropy tables fitted to `samples`, the
/// concatenation of payloads of the lengths in `sizes`.
fn finalize_split_samples(content: &[u8], samples: &[u8], sizes: &[usize]) -> Vec<u8> {
    if content.is_empty() || sizes.is_empty() {
        return Vec::new();
    }
    let mut out = vec![0u8; DISPLAY_DICTIONARY_MAX_BYTES];
    let params = zstd_sys::ZDICT_params_t {
        compressionLevel: DISPLAY_COMPRESSION_LEVEL,
        notificationLevel: 0,
        // Let zstd derive the id from the content it is given. The daemon's own
        // `(id, generation, hash)` triple remains the authority for which slot a
        // frame refers to; this id only has to distinguish two dictionaries from
        // each other inside the decoder.
        dictID: 0,
    };
    // SAFETY: all four buffers are live for the call, the sample count matches
    // `sizes.len()`, and the destination is `out.len()` bytes. The return value
    // is checked with `ZDICT_isError` before any of it is read.
    let written = unsafe {
        zstd_sys::ZDICT_finalizeDictionary(
            out.as_mut_ptr().cast(),
            out.len(),
            content.as_ptr().cast(),
            content.len(),
            samples.as_ptr().cast(),
            sizes.as_ptr(),
            u32::try_from(sizes.len()).unwrap_or(u32::MAX),
            params,
        )
    };
    // SAFETY: `ZDICT_isError` classifies the `size_t` it is handed by value; it
    // takes no pointer and reads no dictionary memory.
    if unsafe { zstd_sys::ZDICT_isError(written) } != 0 || written == 0 {
        return Vec::new();
    }
    out.truncate(written);
    out
}

/// A compression dictionary shared with exactly one peer.
///
/// Scoped to `(peer, generation)`: the id is only meaningful within the
/// generation it was installed in, and every generation change drops it. The
/// hash is what lets the receiver prove the two sides hold identical bytes
/// before decompressing anything against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayDictionary {
    pub id: u32,
    pub generation: u32,
    pub hash: u32,
    pub bytes: std::sync::Arc<[u8]>,
}

impl DisplayDictionary {
    #[cfg(test)]
    pub fn new(id: u32, generation: u32, bytes: Vec<u8>) -> Self {
        let hash = dictionary_hash(&bytes);
        Self::from_prepared(id, generation, bytes.into(), hash)
    }

    pub fn from_prepared(id: u32, generation: u32, bytes: std::sync::Arc<[u8]>, hash: u32) -> Self {
        Self {
            id,
            generation,
            hash,
            bytes,
        }
    }
}
/// Truncated content hash used to detect dictionary divergence on the wire.
///
/// Not a security boundary — the dictionary is derived from display content
/// both sides already hold, and the frames carrying it are already
/// authenticated. Its only job is turning a silent LZ4 mis-decode into a
/// detectable, recoverable resync.
pub fn dictionary_hash(bytes: &[u8]) -> u32 {
    (merkur_codec::hash_bytes(bytes) >> 32) as u32
}

/// A level-3 context writing the display payload's zstd frame: magicless and
/// without a frame content size, because the envelope already says the payload
/// is zstd and carries the row-body length. Five bytes saved on every frame.
fn display_context() -> zstd::bulk::Compressor<'static> {
    use zstd::zstd_safe::{CParameter, FrameFormat};
    let mut context =
        zstd::bulk::Compressor::new(DISPLAY_COMPRESSION_LEVEL).expect("zstd compression context");
    context
        .set_parameter(CParameter::Format(FrameFormat::Magicless))
        .expect("magicless display frames");
    context
        .set_parameter(CParameter::ContentSizeFlag(false))
        .expect("display frames without content size");
    context
}

pub struct Compressor {
    plain: zstd::bulk::Compressor<'static>,
    dictionary_context: zstd::bulk::Compressor<'static>,
    /// Splits the frame being compressed, its buffers reused across calls.
    splitter: merkur_codec::RowSplitter,
    /// Profiling-only accumulator around the complete compression stage,
    /// including validation and rejected outputs. Disabled in normal operation,
    /// so an unprofiled attempt pays one predictable false branch and no clock.
    timing_enabled: bool,
    timed_compression: Duration,
    #[cfg(test)]
    display_frame_compression_attempts: usize,
    /// The bytes currently digested into `dictionary_context`, by identity.
    ///
    /// zstd digests a dictionary into the context once and every frame after
    /// that reuses it. This is why zstd is *cheaper* here than the LZ4 path it
    /// replaced, which re-primed a 4096-slot hash table from the dictionary on
    /// every single compress call.
    ///
    /// One compressor serves every peer, and a dictionary's `id` is a per-peer
    /// counter: two peers hold `id` 1 at the same generation with different
    /// bytes whenever a page closes without its peer leaving and the next page
    /// connects. Keyed by `(id, generation)`, the context digested for the
    /// first peer was reused for the second, whose browser then decoded every
    /// dictionary frame against bytes the daemon had not compressed with. The
    /// `Arc` is what the digest actually depends on: it is shared by every
    /// peer installed from one prepared source, so a snapshot broadcast to
    /// eleven peers digests once, and holding it here keeps the address from
    /// being reused while it is the key.
    loaded_dictionary: Option<std::sync::Arc<[u8]>>,
}

impl Compressor {
    pub fn new() -> Self {
        Self {
            plain: display_context(),
            dictionary_context: display_context(),
            splitter: merkur_codec::RowSplitter::default(),
            timing_enabled: false,
            timed_compression: Duration::ZERO,
            loaded_dictionary: None,
            #[cfg(test)]
            display_frame_compression_attempts: 0,
        }
    }

    /// Start one display-preparation timing scope.
    pub(crate) fn begin_timing(&mut self, enabled: bool) {
        self.timing_enabled = enabled;
        self.timed_compression = Duration::ZERO;
    }

    /// End the current scope and return time spent inside zstd attempts.
    pub(crate) fn take_timed_compression(&mut self) -> Duration {
        self.timing_enabled = false;
        std::mem::take(&mut self.timed_compression)
    }

    /// Compress a display frame into `out`, the caller's buffer, returning the
    /// bytes saved when compression applies and `None` when it does not (the
    /// frame has no row payload, is already compressed, is not a display patch,
    /// or would not shrink). The payload is the zstd frame of the rows'
    /// [split layout](merkur_codec::split_rows_into), behind the envelope's
    /// row-body length. There is no material-savings threshold: after zstd
    /// runs, the planner decides from the complete actual packet cost. `out`
    /// holds the compressed frame on `Some` and is cleared otherwise; both
    /// display arms pass a pooled frame, so a successful compression allocates
    /// nothing.
    ///
    /// With `dictionary`, compresses against an external dictionary the peer
    /// has already installed and acknowledged. The resulting frame carries
    /// `dict_id` so the receiver can select the right dictionary, and
    /// `dict_hash` so it can prove agreement first: LZ4 had no integrity
    /// check, so decompressing against a diverged dictionary yielded plausible
    /// garbage rather than an error.
    pub fn compress_display_frame_into(
        &mut self,
        frame: &[u8],
        dictionary: Option<&DisplayDictionary>,
        out: &mut Vec<u8>,
    ) -> Option<usize> {
        let started_at = self.timing_enabled.then(Instant::now);
        let result = self.compress_display_frame_into_inner(frame, dictionary, out);
        if let Some(started_at) = started_at {
            self.timed_compression += started_at.elapsed();
        }
        result
    }

    fn compress_display_frame_into_inner(
        &mut self,
        frame: &[u8],
        dictionary: Option<&DisplayDictionary>,
        out: &mut Vec<u8>,
    ) -> Option<usize> {
        out.clear();
        let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
        if frame.len() <= rows_offset || frame.len() > merkur_codec::MAX_DISPLAY_FRAME_BYTES {
            return None;
        }
        if frame[0] != MSG_TYPE_DISPLAY_PATCH {
            return None;
        }
        if (frame.get(DISPLAY_HEADER_FLAGS_OFFSET).copied().unwrap_or(0))
            & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD
            != 0
        {
            return None;
        }
        if dictionary.is_some_and(|dict| dict.bytes.is_empty()) {
            return None;
        }

        #[cfg(test)]
        {
            self.display_frame_compression_attempts += 1;
        }

        let rows = &frame[rows_offset..];
        let row_count = u16::from_be_bytes([
            frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET],
            frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET + 1],
        ]);
        let split = self.splitter.split(rows, row_count).ok()?;
        let context = match dictionary {
            None => &mut self.plain,
            Some(dict) => {
                let loaded = self
                    .loaded_dictionary
                    .as_ref()
                    .is_some_and(|loaded| std::sync::Arc::ptr_eq(loaded, &dict.bytes));
                if !loaded {
                    // Digested once per dictionary, not once per frame.
                    self.dictionary_context
                        .set_dictionary(DISPLAY_COMPRESSION_LEVEL, &dict.bytes)
                        .ok()?;
                    self.loaded_dictionary = Some(std::sync::Arc::clone(&dict.bytes));
                }
                &mut self.dictionary_context
            }
        };
        let payload_offset = match dictionary {
            None => DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
            Some(_) => DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
        };
        // Compress straight into the pooled frame's spare capacity, after its
        // header. Cursor's WriteBuf implementation extends the initialized
        // prefix without zeroing or copying the payload. A larger result could
        // not fit the frame resource bound anyway, so don't reserve an oversized
        // compress_bound in every retained output buffer.
        out.reserve(
            (payload_offset + zstd::zstd_safe::compress_bound(split.len()))
                .min(merkur_codec::MAX_DISPLAY_FRAME_BYTES),
        );
        out.extend_from_slice(&frame[..rows_offset]);
        out.extend_from_slice(&(rows.len() as u32).to_be_bytes());
        if let Some(dict) = dictionary {
            out.extend_from_slice(&dict.id.to_be_bytes());
            out.extend_from_slice(&dict.hash.to_be_bytes());
        }
        debug_assert_eq!(out.len(), payload_offset);
        let mut destination = std::io::Cursor::new(&mut *out);
        destination.set_position(payload_offset as u64);
        // Use the numeric zstd error directly: a too-large output is an
        // ordinary refused candidate, not an allocated io::Error.
        let compressed_len = match context.context_mut().compress2(&mut destination, split) {
            Ok(len) => len,
            Err(_) => {
                out.clear();
                return None;
            }
        };
        let compressed_body_bytes = payload_offset - STREAM_HEADER_BYTES + compressed_len;
        if STREAM_HEADER_BYTES + compressed_body_bytes > merkur_codec::MAX_DISPLAY_FRAME_BYTES {
            out.clear();
            return None;
        }
        let compressed_frame_bytes = STREAM_HEADER_BYTES + compressed_body_bytes;

        if compressed_frame_bytes >= frame.len() {
            out.clear();
            return None;
        }
        let saved_bytes = frame.len() - compressed_frame_bytes;

        let dict_flag = match dictionary {
            None => 0,
            Some(_) => DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
        };
        out[DISPLAY_HEADER_FLAGS_OFFSET] =
            frame[DISPLAY_HEADER_FLAGS_OFFSET] | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD | dict_flag;
        out[merkur_codec::DISPLAY_BODY_LENGTH_OFFSET
            ..merkur_codec::DISPLAY_BODY_LENGTH_OFFSET + 4]
            .copy_from_slice(&(compressed_body_bytes as u32).to_be_bytes());

        debug_assert_eq!(out.len(), compressed_frame_bytes);

        Some(saved_bytes)
    }

    #[cfg(test)]
    pub(crate) fn display_frame_compression_attempts(&self) -> usize {
        self.display_frame_compression_attempts
    }
}

/// Decode a compressed frame's payload as the browser does: the magicless zstd
/// frame, then the join back into the row layout. Production decodes in
/// term-wasm; this is the native harnesses' reading of the same bytes.
#[cfg(test)]
pub(crate) fn decode_display_payload(
    frame: &[u8],
    dictionary: Option<&[u8]>,
) -> std::io::Result<Vec<u8>> {
    use zstd::zstd_safe::{DCtx, DParameter, FrameFormat};
    let invalid = |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, what);
    let payload_offset = if dictionary.is_some() {
        DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET
    } else {
        DISPLAY_COMPRESSED_PAYLOAD_OFFSET
    };
    let length_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let declared = frame
        .get(length_offset..length_offset + 4)
        .map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
        .ok_or_else(|| invalid("compressed frame shorter than its envelope"))?;
    let row_count = u16::from_be_bytes([
        frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET],
        frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET + 1],
    ]);
    let mut context = DCtx::create();
    context
        .set_parameter(DParameter::Format(FrameFormat::Magicless))
        .map_err(|_| invalid("magicless decoder"))?;
    if let Some(dictionary) = dictionary {
        context
            .load_dictionary(dictionary)
            .map_err(|_| invalid("dictionary"))?;
    }
    let mut split = Vec::with_capacity(declared + merkur_codec::SPLIT_HEADER_MAX_BYTES);
    context
        .decompress(&mut split, &frame[payload_offset..])
        .map_err(|_| invalid("zstd payload"))?;
    let mut rows = Vec::new();
    merkur_codec::join_rows_into(&split, row_count, &mut rows)
        .map_err(|_| invalid("split payload"))?;
    if rows.len() != declared {
        return Err(invalid("joined rows disagree with the envelope length"));
    }
    Ok(rows)
}

/// Per-peer dictionary lifecycle.
///
/// Two states matter and must not be collapsed: `active` is what the peer has
/// acknowledged and is therefore safe to compress against, and `pending` has
/// been sent but not yet acknowledged. The daemon must never compress against
/// a dictionary the peer has not acknowledged — a successful persistent-lane
/// write is not evidence that the browser installed it, and LZ4 has no
/// integrity check.
///
/// The dictionary content is the current screen, encoded exactly as rows go on
/// the wire. That is the best available predictor of upcoming row deltas, and
/// unlike accumulating sent frames it needs no corpus bookkeeping and cannot
/// be biased by which of the two encode paths a flush happened to take.
#[derive(Default)]
pub struct PeerDictionaryState {
    active: Option<std::sync::Arc<DisplayDictionary>>,
    /// The browser retains exactly two acknowledged slots. Mirror that window
    /// so owner-loop work prepared against the former active dictionary can
    /// finish across one rotation, but never after a second rotation evicts it.
    previous: Option<std::sync::Arc<DisplayDictionary>>,
    pending: Option<std::sync::Arc<DisplayDictionary>>,
    /// Flushes since the last build *attempt*. Screen content drifts, so a
    /// dictionary pinned at session start goes stale exactly when
    /// self-similarity is recency-driven.
    flushes_since_build: u32,
    /// Flushes that must elapse before the next attempt. Zero only before the
    /// first one. Counting attempts rather than successes is what stops a
    /// terminal too small to justify a dictionary from re-encoding a snapshot
    /// on every single flush.
    next_build_after: u32,
    next_id: u32,
}

impl PeerDictionaryState {
    /// The dictionary frames may be compressed against, if any.
    pub fn active(&self) -> Option<&std::sync::Arc<DisplayDictionary>> {
        self.active.as_ref()
    }

    /// Whether the browser's current/previous slots can still decode a frame
    /// prepared with `dictionary`. Pointer identity also fences a wrapped id.
    pub fn retains(&self, dictionary: &std::sync::Arc<DisplayDictionary>) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| std::sync::Arc::ptr_eq(active, dictionary))
            || self
                .previous
                .as_ref()
                .is_some_and(|previous| std::sync::Arc::ptr_eq(previous, dictionary))
    }

    /// Whether any browser-visible install is owned by this connection.
    pub fn has_wire_state(&self) -> bool {
        self.active.is_some() || self.previous.is_some() || self.pending.is_some()
    }

    /// Advance the rebuild clock. Called once per flush for this peer.
    pub fn observe_flush(&mut self) {
        self.flushes_since_build = self.flushes_since_build.saturating_add(1);
    }

    pub fn build_due(&self) -> bool {
        self.pending.is_none() && self.flushes_since_build >= self.next_build_after
    }

    /// Take ownership of `source` as the next dictionary, returning it for
    /// transmission. `source` is truncated to the calibrated cap, keeping its
    /// tail: the most recent screen content is the most predictive.
    #[cfg(test)]
    pub fn build_next(
        &mut self,
        generation: u32,
        mut source: Vec<u8>,
    ) -> Option<std::sync::Arc<DisplayDictionary>> {
        if !self.build_due() {
            return None;
        }
        // Every attempt costs a snapshot encode, so back off whether or not it
        // produced a dictionary.
        self.flushes_since_build = 0;
        self.next_build_after = DISPLAY_DICTIONARY_REBUILD_FLUSHES;
        if source.len() < DISPLAY_DICTIONARY_MIN_BYTES {
            return None;
        }
        if source.len() > DISPLAY_DICTIONARY_MAX_BYTES {
            let excess = source.len() - DISPLAY_DICTIONARY_MAX_BYTES;
            source.drain(..excess);
        }
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let dictionary =
            std::sync::Arc::new(DisplayDictionary::new(self.next_id, generation, source));
        self.pending = Some(std::sync::Arc::clone(&dictionary));
        Some(dictionary)
    }

    /// Install an off-loop prepared source. The source bytes and their hash are
    /// shared by every due peer; only the per-peer id/generation wrapper differs.
    pub fn build_next_prepared(
        &mut self,
        generation: u32,
        source: std::sync::Arc<[u8]>,
        hash: u32,
    ) -> Option<std::sync::Arc<DisplayDictionary>> {
        if !self.build_due() {
            return None;
        }
        self.flushes_since_build = 0;
        self.next_build_after = DISPLAY_DICTIONARY_REBUILD_FLUSHES;
        if source.len() < DISPLAY_DICTIONARY_MIN_BYTES
            || source.len() > DISPLAY_DICTIONARY_MAX_BYTES
        {
            return None;
        }
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let dictionary = std::sync::Arc::new(DisplayDictionary::from_prepared(
            self.next_id,
            generation,
            source,
            hash,
        ));
        self.pending = Some(std::sync::Arc::clone(&dictionary));
        Some(dictionary)
    }

    pub fn acknowledge(&mut self, dict_id: u32) -> bool {
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.id != dict_id)
        {
            return false;
        }
        self.previous = self.active.take();
        self.active = self.pending.take();
        true
    }

    /// Abandon an install that failed to reach the peer, so a later flush can
    /// retry. Without this the peer would hold a pending slot forever and
    /// never be offered another dictionary.
    pub fn abandon_pending(&mut self) {
        self.pending = None;
        // A failed send should be retried promptly, not after a full interval.
        self.flushes_since_build = self.next_build_after;
    }

    /// Drop everything. Called on generation change, resize, and resume: the
    /// dictionary is scoped to a `(peer, generation)` pair and to one browser
    /// connection, so carrying it across any of those is unsound.
    pub fn reset(&mut self) {
        self.active = None;
        self.previous = None;
        self.pending = None;
        self.flushes_since_build = 0;
        self.next_build_after = 0;
    }
}

/// Smallest source worth installing. Below this the dictionary cannot cover
/// enough recurring structure to pay for its transmission.
pub const DISPLAY_DICTIONARY_MIN_BYTES: usize = 2 * 1024;
/// Flushes before an installed dictionary is rebuilt from current content.
/// At the 10ms normal flush cadence this is roughly ten seconds of activity.
pub const DISPLAY_DICTIONARY_REBUILD_FLUSHES: u32 = 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_codec::{
        CellRepr, DISPLAY_HEADER_BODY_LENGTH_OFFSET, FrameHeader, FrameKind, RowRef,
        encode_frame_into,
    };

    const COLS: usize = 120;

    /// One screen of `rows` log lines from `offset`, as the dictionary thread
    /// encodes it: the row-layout body and its row count.
    fn screen(offset: usize, rows: usize) -> (Vec<u8>, u16) {
        let frame = delta_frame(
            &(0..rows)
                .map(|row| (row as u16, log_line(offset + row)))
                .collect::<Vec<_>>(),
        );
        (
            frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..].to_vec(),
            rows as u16,
        )
    }

    fn screen_dictionary(offset: usize, rows: usize) -> Vec<u8> {
        let (body, row_count) = screen(offset, rows);
        finalize_display_dictionary(&body, row_count, &mut DictionaryScratch::default())
    }

    fn decode(frame: &[u8], dictionary: Option<&[u8]>) -> Vec<u8> {
        decode_display_payload(frame, dictionary).expect("browser-equivalent decode")
    }

    #[test]
    fn the_dictionary_is_fitted_to_split_datagram_groups_and_keeps_its_buffers() {
        let (body, row_count) = screen(0, 960);
        let mut scratch = DictionaryScratch::default();
        let first = finalize_display_dictionary(&body, row_count, &mut scratch);
        assert!(!first.is_empty());
        assert_eq!(scratch.sizes.iter().sum::<usize>(), scratch.samples.len());
        // A group is at most one datagram's worth of row bytes, and the split
        // layout of a group is never longer than its rows.
        assert!(scratch.sizes.iter().all(|&size| {
            (DISPLAY_DICTIONARY_SAMPLE_MIN_BYTES
                ..=crate::display::policy::DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES)
                .contains(&size)
        }));
        // The splitter's own buffers are merkur-codec's to keep.
        let capacities = (scratch.samples.capacity(), scratch.sizes.capacity());
        assert_eq!(
            finalize_display_dictionary(&body, row_count, &mut scratch),
            first
        );
        assert_eq!(
            (scratch.samples.capacity(), scratch.sizes.capacity()),
            capacities
        );
        let (small, small_rows) = screen(0, 2);
        assert!(finalize_display_dictionary(&small, small_rows, &mut scratch).is_empty());
    }

    fn cell(c: char) -> CellRepr {
        CellRepr {
            codepoint: c as u32,
            ..CellRepr::BLANK
        }
    }

    fn row_cells(text: &str) -> Vec<CellRepr> {
        let mut cells: Vec<CellRepr> = text.chars().take(COLS).map(cell).collect();
        cells.resize(COLS, cell(' '));
        cells
    }

    /// A line from a realistic terminal workload: repetitive in structure but
    /// varying in detail, which is exactly the shape a cross-frame dictionary
    /// is supposed to exploit.
    fn log_line(index: usize) -> String {
        const LEVELS: [&str; 3] = ["INFO", "WARN", "DEBUG"];
        const SCOPES: [&str; 4] = ["display", "transport", "session", "pty"];
        format!(
            "2026-08-05T08:{:02}:{:02}.{:03}Z {} scope={} peer=browser-{:02} seq={} bytes={}",
            index % 60,
            (index * 7) % 60,
            (index * 131) % 1000,
            LEVELS[index % LEVELS.len()],
            SCOPES[(index / 3) % SCOPES.len()],
            index % 8,
            1000 + index,
            256 + (index * 37) % 4096,
        )
    }

    /// Encode a display delta the way the daemon does: only the rows that
    /// changed, each trimmed to its changed span.
    fn delta_frame(rows: &[(u16, String)]) -> Vec<u8> {
        let header = FrameHeader {
            memory_only: false,
            kind: FrameKind::Delta,
            cols: COLS as u16,
            rows: 40,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 1,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: rows.len() as u16,
            frame_id: 1,
            presentation_id: 0,
            presentation_member_index: 0,
            presentation_member_count: 0,
            row_predecessor_presentation_id: 0,
            presentation_coherent: false,
            presentation_end: false,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            scroll_serial: 0,
            echo_horizon: 0,
        };
        let cells: Vec<Vec<CellRepr>> = rows.iter().map(|(_, text)| row_cells(text)).collect();
        let mut frame = Vec::new();
        encode_frame_into(
            &mut frame,
            &header,
            rows.iter().enumerate().map(|(index, (row, _))| RowRef {
                graphics: &[],
                row_index: *row,
                left: 0,
                cells: &cells[index],
            }),
        );
        frame[0] = MSG_TYPE_DISPLAY_PATCH;
        let body_len = frame.len() - STREAM_HEADER_BYTES;
        frame[DISPLAY_HEADER_BODY_LENGTH_OFFSET..DISPLAY_HEADER_BODY_LENGTH_OFFSET + 2]
            .copy_from_slice(&(body_len as u16).to_be_bytes());
        frame
    }

    /// What one compression attempt produced, for tests that read the frame.
    struct Attempt {
        frame: Vec<u8>,
        saved_bytes: usize,
    }

    /// Compress into a fresh buffer, the way the production arms compress into
    /// a pooled one.
    fn compress(
        compressor: &mut Compressor,
        frame: &[u8],
        dictionary: Option<&DisplayDictionary>,
    ) -> Option<Attempt> {
        let mut out = Vec::new();
        let saved_bytes = compressor.compress_display_frame_into(frame, dictionary, &mut out)?;
        Some(Attempt {
            frame: out,
            saved_bytes,
        })
    }

    #[test]
    fn compress_display_frame_round_trips_and_reports_real_savings() {
        let frame = delta_frame(
            &(0..20)
                .map(|index| (index as u16, log_line(index)))
                .collect::<Vec<_>>(),
        );
        let attempt = compress(&mut Compressor::new(), &frame, None)
            .expect("a 20-row log delta must compress");

        assert_eq!(attempt.frame.len() + attempt.saved_bytes, frame.len());
        assert_ne!(
            attempt.frame[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
            0
        );
        assert_eq!(
            decode(&attempt.frame, None),
            frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..]
        );
        // The payload is magicless: the envelope already names it zstd.
        assert_ne!(
            attempt.frame[DISPLAY_COMPRESSED_PAYLOAD_OFFSET..DISPLAY_COMPRESSED_PAYLOAD_OFFSET + 4],
            [0x28, 0xb5, 0x2f, 0xfd]
        );
    }

    #[test]
    fn an_already_compressed_frame_is_not_recompressed() {
        let frame = delta_frame(&[(0, log_line(1))]);
        let mut compressor = Compressor::new();
        let once = compress(&mut compressor, &frame, None).expect("first pass compresses");
        assert!(compress(&mut compressor, &once.frame, None).is_none());
    }

    #[test]
    fn a_non_display_frame_or_header_only_frame_is_refused() {
        let mut compressor = Compressor::new();
        assert!(compress(&mut compressor, &[], None).is_none());
        assert!(compress(&mut compressor, &[0u8; STREAM_HEADER_BYTES], None).is_none());
        let mut wrong_type = delta_frame(&[(0, log_line(2))]);
        wrong_type[0] = 0x21;
        assert!(compress(&mut compressor, &wrong_type, None).is_none());
    }

    #[test]
    fn compression_writes_byte_exact_frames_into_reused_storage() {
        use crate::edge_tunnel::test_allocations;

        let dictionary = benchmark_dictionary();
        let mut compressor = Compressor::new();
        let mut out = Vec::new();
        for target in [65_536, 300, 4_096, 512, 16_384, 1_100] {
            let frame = benchmark_frame_of_at_least(target);
            let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
            let rows = &frame[rows_offset..];
            let row_count = u16::from_be_bytes([
                frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET],
                frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET + 1],
            ]);
            let split = merkur_codec::RowSplitter::default()
                .split(rows, row_count)
                .unwrap()
                .to_vec();
            for dictionary in [None, Some(&dictionary), None] {
                let mut reference = display_context();
                if let Some(dict) = dictionary {
                    reference
                        .set_dictionary(DISPLAY_COMPRESSION_LEVEL, &dict.bytes)
                        .unwrap();
                }
                let payload = reference.compress(&split).unwrap();
                let mut expected = frame[..rows_offset].to_vec();
                expected.extend_from_slice(&(rows.len() as u32).to_be_bytes());
                if let Some(dict) = dictionary {
                    expected.extend_from_slice(&dict.id.to_be_bytes());
                    expected.extend_from_slice(&dict.hash.to_be_bytes());
                }
                expected.extend_from_slice(&payload);
                expected[DISPLAY_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD
                    | if dictionary.is_some() {
                        DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT
                    } else {
                        0
                    };
                let body_len = (expected.len() - STREAM_HEADER_BYTES) as u32;
                expected[2..6].copy_from_slice(&body_len.to_be_bytes());
                let saved = compressor.compress_display_frame_into(&frame, dictionary, &mut out);
                assert_eq!(saved, Some(frame.len() - expected.len()));
                assert_eq!(out, expected);
                let pointer = out.as_ptr();
                let capacity = out.capacity();

                test_allocations::begin_thread();
                for _ in 0..128 {
                    std::hint::black_box(
                        compressor.compress_display_frame_into(&frame, dictionary, &mut out),
                    );
                }
                let tally = test_allocations::end_thread();
                assert_eq!(tally.allocations, 0, "target={target}");
                assert_eq!(tally.allocated_bytes, 0, "target={target}");
                assert_eq!(out.as_ptr(), pointer);
                assert_eq!(out.capacity(), capacity);
                assert_eq!(out, expected);
            }
        }
    }

    #[test]
    fn refused_compression_clears_output_and_preserves_reuse() {
        use crate::edge_tunnel::test_allocations;

        let frame = delta_frame(&[(0, log_line(1))]);
        let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
        let mut tiny = frame[..rows_offset].to_vec();
        tiny.push(0);
        // The compressor validates the envelope, not the cell codec. Random
        // body bytes exercise the exact same oversize rejection as a jumbo
        // incompressible snapshot without constructing a terminal fixture.
        let mut oversized = frame[..rows_offset].to_vec();
        let mut random = 0x4d45_5243_u32;
        for _ in 0..131_072 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            oversized.push(random as u8);
        }
        let empty_dictionary = dict(1, 1, &[]);
        let mut compressor = Compressor::new();
        let mut out = Vec::new();
        for rejected in [&tiny, &oversized] {
            assert!(
                compressor
                    .compress_display_frame_into(&frame, None, &mut out)
                    .is_some()
            );
            assert!(
                compressor
                    .compress_display_frame_into(rejected, None, &mut out)
                    .is_none()
            );
            assert!(out.is_empty());
            test_allocations::begin_thread();
            let result = compressor.compress_display_frame_into(rejected, None, &mut out);
            let tally = test_allocations::end_thread();
            assert!(result.is_none());
            assert!(out.is_empty());
            assert_eq!(tally.allocations, 0);
            assert!(
                compressor
                    .compress_display_frame_into(&frame, None, &mut out)
                    .is_some()
            );
        }
        assert!(
            compressor
                .compress_display_frame_into(&frame, Some(&empty_dictionary), &mut out)
                .is_none()
        );
        assert!(out.is_empty());
    }

    /// Measure the sender-service and achieved-ratio surfaces consumed by the
    /// display planner, for plain and finalized-dictionary contexts.
    #[test]
    #[ignore = "benchmark"]
    fn production_compression_planner_surface_benchmark() {
        const TARGET_BYTES: [usize; 9] =
            [300, 512, 1_024, 1_100, 2_048, 4_096, 8_192, 16_384, 65_536];
        const ITERATIONS: usize = 400;
        const WARMUPS: usize = 100;

        let dictionary = benchmark_dictionary();
        println!(
            "\n{:>8}  {:>7}  {:>6}  {:>5}  {:>10}",
            "raw", "saved", "ratio", "dict", "us/call"
        );

        for target in TARGET_BYTES {
            let frame = benchmark_frame_of_at_least(target);
            for use_dictionary in [false, true] {
                let mut compressor = Compressor::new();
                let mut samples = Vec::with_capacity(ITERATIONS);
                let mut saved_bytes = 0usize;
                for index in 0..(WARMUPS + ITERATIONS) {
                    let started = std::time::Instant::now();
                    let attempt = compress(
                        &mut compressor,
                        &frame,
                        use_dictionary.then_some(&dictionary),
                    );
                    let elapsed = started.elapsed();
                    let attempt = attempt.expect("production frame must compress");
                    std::hint::black_box(&attempt.frame);
                    if index >= WARMUPS {
                        samples.push(elapsed.as_secs_f64() * 1_000.0);
                        saved_bytes = attempt.saved_bytes;
                    }
                }
                samples.sort_by(f64::total_cmp);
                let measured_ms = samples[samples.len() / 2];
                println!(
                    "{:>8}  {:>7}  {:>6.2}  {:>5}  {:>10.3}",
                    frame.len(),
                    saved_bytes,
                    frame.len() as f64 / (frame.len() - saved_bytes) as f64,
                    if use_dictionary { "yes" } else { "no" },
                    measured_ms * 1_000.0,
                );
                let label = if use_dictionary { "dict" } else { "plain" };
                println!(
                    "@@merkur-perf {{\"name\":\"compression-planner-sender-{label}-{}\",\"value\":{},\"unit\":\"ms/op\",\"direction\":\"lower\",\"percentile\":0.5,\"sampleSize\":{ITERATIONS}}}",
                    frame.len(),
                    measured_ms,
                );
            }
        }
    }

    /// A dictionary built the way `prepare_dictionary_off_loop` builds one: a
    /// screen's rows grouped per datagram, split, and finalized.
    fn benchmark_dictionary() -> DisplayDictionary {
        let bytes = screen_dictionary(0, 960);
        assert!(
            !bytes.is_empty(),
            "benchmark dictionary failed to build; every dictionary row below \
             would silently measure the plain path"
        );
        dict(1, 1, &bytes)
    }

    /// Grow a realistic delta until its encoded frame reaches `target`, so
    /// every measurement is on bytes the production encoder actually emits.
    fn benchmark_frame_of_at_least(target: usize) -> Vec<u8> {
        let mut rows = 1usize;
        loop {
            let frame = delta_frame(
                &(0..rows)
                    .map(|index| (index as u16, log_line(index)))
                    .collect::<Vec<_>>(),
            );
            if frame.len() >= target || rows > 4_096 {
                return frame;
            }
            rows += 1;
        }
    }

    fn dict(id: u32, generation: u32, bytes: &[u8]) -> DisplayDictionary {
        DisplayDictionary::new(id, generation, bytes.to_vec())
    }

    #[test]
    fn a_dictionary_frame_carries_its_id_and_hash_and_beats_plain_zstd() {
        let frame = delta_frame(
            &(0..20)
                .map(|index| (index as u16, log_line(index)))
                .collect::<Vec<_>>(),
        );
        // The dictionary holds split payloads of encoded rows, exactly what
        // production builds from a screen. Raw text would share no byte
        // sequences with the cell streams and buy nothing.
        let dictionary = dict(3, 7, &screen_dictionary(0, 80));

        let mut compressor = Compressor::new();
        let plain = compress(&mut compressor, &frame, None).expect("plain");
        let with_dict = compress(&mut compressor, &frame, Some(&dictionary)).expect("dictionary");

        assert!(
            with_dict.frame.len() < plain.frame.len(),
            "dictionary must beat plain: dict={} plain={}",
            with_dict.frame.len(),
            plain.frame.len()
        );

        let flags = with_dict.frame[DISPLAY_HEADER_FLAGS_OFFSET];
        assert_ne!(flags & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD, 0);
        assert_ne!(flags & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT, 0);
        let id_offset = DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET - 8;
        assert_eq!(
            u32::from_be_bytes(
                with_dict.frame[id_offset..id_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            3
        );
        assert_eq!(
            u32::from_be_bytes(
                with_dict.frame[id_offset + 4..id_offset + 8]
                    .try_into()
                    .unwrap()
            ),
            dictionary.hash
        );

        // Round trip exactly as the browser does.
        assert_eq!(
            decode(&with_dict.frame, Some(&dictionary.bytes)),
            frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..]
        );
    }

    #[test]
    fn the_digested_dictionary_follows_the_bytes_not_the_per_peer_id() {
        // Two peers hand the one shared compressor dictionaries with the same
        // per-peer id and generation but different bytes — the normal state
        // once a page closed without its peer leaving and the next page
        // connected. The second peer's frame must decode against the second
        // peer's bytes, not against the tables digested for the first.
        let frame = delta_frame(
            &(0..20)
                .map(|index| (index as u16, log_line(index)))
                .collect::<Vec<_>>(),
        );
        let first_peer = dict(1, 4, &screen_dictionary(0, 80));
        let second_peer = dict(1, 4, &screen_dictionary(1_000, 80));
        assert_ne!(first_peer.hash, second_peer.hash);

        let mut compressor = Compressor::new();
        compress(&mut compressor, &frame, Some(&first_peer)).expect("first peer");
        let with_second =
            compress(&mut compressor, &frame, Some(&second_peer)).expect("second peer");

        assert_eq!(
            decode(&with_second.frame, Some(&second_peer.bytes)),
            frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..],
            "the second peer's frame decodes against the second peer's bytes"
        );

        // Peers installed from one prepared source share the bytes `Arc`, so
        // switching between them digests nothing: the context stays loaded.
        let shared = DisplayDictionary::from_prepared(
            2,
            4,
            std::sync::Arc::clone(&second_peer.bytes),
            second_peer.hash,
        );
        compress(&mut compressor, &frame, Some(&shared)).expect("shared source");
        assert!(
            compressor
                .loaded_dictionary
                .as_ref()
                .is_some_and(|loaded| std::sync::Arc::ptr_eq(loaded, &second_peer.bytes))
        );
    }

    #[test]
    fn an_empty_dictionary_is_refused_rather_than_producing_a_dictionary_frame() {
        let frame = delta_frame(&[(0, log_line(1))]);
        let empty = DisplayDictionary::new(1, 1, Vec::new());
        assert!(compress(&mut Compressor::new(), &frame, Some(&empty)).is_none());
    }

    #[test]
    fn the_dictionary_hash_detects_divergence() {
        let a = dict(1, 1, b"the quick brown fox");
        let b = dict(1, 1, b"the quick brown fux");
        assert_ne!(a.hash, b.hash);
        assert_eq!(a.hash, dict(9, 9, b"the quick brown fox").hash);
    }

    #[test]
    fn a_dictionary_is_only_usable_after_the_peer_acknowledges_its_id() {
        let mut state = PeerDictionaryState::default();
        let source = vec![7u8; DISPLAY_DICTIONARY_MIN_BYTES];
        assert!(state.build_due());

        let built = state.build_next(4, source).expect("build");
        // Sent but unacknowledged: compressing now would be silent corruption
        // if the install never arrived.
        assert!(state.active().is_none());
        // No second install while one is outstanding.
        assert!(
            state
                .build_next(4, vec![7u8; DISPLAY_DICTIONARY_MIN_BYTES])
                .is_none()
        );

        // A stale id must not promote anything.
        assert!(!state.acknowledge(built.id.wrapping_add(1)));
        assert!(state.active().is_none());

        assert!(state.acknowledge(built.id));
        assert_eq!(state.active().map(|dict| dict.id), Some(built.id));
    }

    #[test]
    fn an_abandoned_install_can_be_retried_and_a_reset_clears_everything() {
        let mut state = PeerDictionaryState::default();
        let built = state
            .build_next(1, vec![1u8; DISPLAY_DICTIONARY_MIN_BYTES])
            .expect("build");
        state.abandon_pending();
        // Without this the peer would hold a pending slot forever.
        assert!(state.build_due());
        let retried = state
            .build_next(1, vec![1u8; DISPLAY_DICTIONARY_MIN_BYTES])
            .expect("retry");
        assert_ne!(retried.id, built.id);

        state.acknowledge(retried.id);
        assert!(state.active().is_some());
        state.reset();
        assert!(state.active().is_none());
        assert!(!state.retains(&retried));
        assert!(state.build_due());
    }

    #[test]
    fn acknowledged_slots_retain_exactly_one_rotation() {
        let mut state = PeerDictionaryState::default();
        let first = state
            .build_next(1, vec![1u8; DISPLAY_DICTIONARY_MIN_BYTES])
            .expect("first dictionary");
        assert!(state.acknowledge(first.id));

        for fill in [2u8, 3u8] {
            for _ in 0..DISPLAY_DICTIONARY_REBUILD_FLUSHES {
                state.observe_flush();
            }
            let next = state
                .build_next(1, vec![fill; DISPLAY_DICTIONARY_MIN_BYTES])
                .expect("rotated dictionary");
            assert!(state.acknowledge(next.id));
            if fill == 2 {
                assert!(state.retains(&first));
            }
        }

        assert!(!state.retains(&first));
    }

    #[test]
    fn a_declined_build_backs_off_instead_of_retrying_every_flush() {
        // Each attempt costs a full snapshot encode. A terminal too small to
        // justify a dictionary must not pay that on every flush forever.
        let mut state = PeerDictionaryState::default();
        let tiny = || vec![0u8; DISPLAY_DICTIONARY_MIN_BYTES - 1];

        assert!(state.build_due());
        assert!(state.build_next(1, tiny()).is_none());
        assert!(!state.build_due(), "a declined build must back off");

        for _ in 0..DISPLAY_DICTIONARY_REBUILD_FLUSHES - 1 {
            state.observe_flush();
        }
        assert!(!state.build_due());
        state.observe_flush();
        assert!(
            state.build_due(),
            "the attempt should be retried eventually"
        );
    }

    #[test]
    fn a_source_below_the_minimum_is_not_worth_installing() {
        let mut state = PeerDictionaryState::default();
        assert!(
            state
                .build_next(1, vec![0u8; DISPLAY_DICTIONARY_MIN_BYTES - 1])
                .is_none()
        );
    }

    #[test]
    fn an_oversized_source_keeps_its_most_recent_tail() {
        let mut state = PeerDictionaryState::default();
        let mut source = vec![0u8; DISPLAY_DICTIONARY_MAX_BYTES];
        source.extend_from_slice(&[9u8; 64]);
        let built = state.build_next(1, source).expect("build");
        assert_eq!(built.bytes.len(), DISPLAY_DICTIONARY_MAX_BYTES);
        // Recent content is the predictive part, so the tail is what survives.
        assert_eq!(&built.bytes[built.bytes.len() - 64..], &[9u8; 64]);
    }

    #[test]
    fn an_installed_dictionary_is_not_rebuilt_until_content_has_had_time_to_drift() {
        let mut state = PeerDictionaryState::default();
        let built = state
            .build_next(1, vec![3u8; DISPLAY_DICTIONARY_MIN_BYTES])
            .expect("build");
        state.acknowledge(built.id);
        assert!(!state.build_due());

        for _ in 0..DISPLAY_DICTIONARY_REBUILD_FLUSHES {
            state.observe_flush();
        }
        assert!(state.build_due());
    }

    /// Calibration for the cross-frame dictionary (plan item 2b, P0-B).
    ///
    /// Reports the byte ratio and datagram-fit rate for per-frame LZ4 versus
    /// an external dictionary drawn from recent traffic, across dictionary
    /// sizes. Frames are *post*-row-diffing, which is the honest comparison:
    /// measuring against pre-diff full screens would overstate the win, since
    /// `classify_flush_rows` already skips rows the browser has confirmed.
    ///
    /// The dictionary is finalized exactly as production finalizes it, because
    /// the entropy tables a finalized dictionary carries are most of what it
    /// buys — raw content alone measures a materially different thing.
    ///
    /// Measured on the scrolling-log corpus below (16,562 bytes of frame body,
    /// compressed as the split payloads of their rows):
    ///
    /// | dict   | compressed bytes | vs dictionary-free zstd |
    /// |--------|------------------|-------------------------|
    /// | none   | 5789             | baseline                |
    /// | 4 KiB  | 2755             | -52%                    |
    /// | 8 KiB  | 2608             | -55%                    |
    /// | 16 KiB | 3137             | -46%                    |
    ///
    /// The corpus's whole history is under 16 KiB, so every row from 16 KiB
    /// on finalizes the same content; they are kept so a future raise of
    /// [`DISPLAY_DICTIONARY_MAX_BYTES`] shows its effect here rather than
    /// silently.
    ///
    /// What a dictionary buys at this size is the fitted entropy tables, not
    /// window length.
    ///
    /// Run with `--nocapture` to see the full curve.
    #[test]
    fn dictionary_calibration_reports_ratio_and_datagram_fit() {
        const DATAGRAM_LIMIT: usize = 1100;
        // A scrolling log: each flush sends the few rows that changed.
        let frames: Vec<Vec<u8>> = (0..60)
            .map(|flush| {
                let rows: Vec<(u16, String)> = (0..3)
                    .map(|offset| {
                        let index = flush * 3 + offset;
                        ((index % 40) as u16, log_line(index))
                    })
                    .collect();
                delta_frame(&rows)
            })
            .collect();

        // Each frame's payload is the split layout of its rows.
        let payloads: Vec<Vec<u8>> = frames
            .iter()
            .map(|frame| {
                merkur_codec::RowSplitter::default()
                    .split(&frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..], 3)
                    .expect("split")
                    .to_vec()
            })
            .collect();
        // The dictionary is what the peer has already received: the tail of
        // prior payloads, newest last, with each payload one sample.
        let history: Vec<u8> = payloads.iter().take(30).flatten().copied().collect();
        let sample_sizes: Vec<usize> = payloads.iter().take(30).map(Vec::len).collect();

        println!("dict_bytes  total_raw  total_plain  total_dict  fit_plain  fit_dict");
        for dict_bytes in [0usize, 4096, 8192, 16_384, 32_768, 65_536] {
            let content = &history[history.len().saturating_sub(dict_bytes)..];
            let dict = if dict_bytes == 0 {
                Vec::new()
            } else {
                finalize_split_samples(content, &history, &sample_sizes)
            };
            let mut plain_context = display_context();
            let mut dict_context = if dict.is_empty() {
                None
            } else {
                let mut context = display_context();
                context
                    .set_dictionary(DISPLAY_COMPRESSION_LEVEL, &dict)
                    .expect("dictionary context");
                Some(context)
            };
            let mut raw_total = 0usize;
            let mut plain_total = 0usize;
            let mut dict_total = 0usize;
            let mut fit_plain = 0usize;
            let mut fit_dict = 0usize;
            for (frame, payload) in frames.iter().zip(&payloads).skip(30) {
                let envelope = DISPLAY_COMPRESSED_PAYLOAD_OFFSET;
                raw_total += frame.len() - STREAM_HEADER_BYTES;
                let plain = plain_context.compress(payload).expect("compress");
                plain_total += plain.len();
                fit_plain += usize::from(plain.len() + envelope <= DATAGRAM_LIMIT);
                let with_dict = match dict_context.as_mut() {
                    Some(context) => context.compress(payload).expect("compress"),
                    None => plain.clone(),
                };
                dict_total += with_dict.len();
                fit_dict += usize::from(with_dict.len() + envelope <= DATAGRAM_LIMIT);
            }
            println!(
                "{dict_bytes:>10}  {raw_total:>9}  {plain_total:>11}  {dict_total:>10}  {fit_plain:>9}  {fit_dict:>8}"
            );
            if dict_bytes == DISPLAY_DICTIONARY_MAX_BYTES {
                // The constant the implementation is built on. If a codec or
                // corpus change erodes this, the dictionary path stops paying
                // for its complexity and that must fail loudly.
                assert!(
                    dict_total * 4 < plain_total * 3,
                    "a {dict_bytes}-byte dictionary must beat dictionary-free zstd by >25%: \
                     dict={dict_total} plain={plain_total}"
                );
            }
        }
    }
}
