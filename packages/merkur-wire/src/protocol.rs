/// Daemon -> client, typed title, bell, notification or clipboard write; reliable CTRL only.
pub const MSG_TYPE_TERMINAL_UI: u8 = 0x3f;
pub const CHANNEL_SIGNALING: u8 = 0x00;
pub const CHANNEL_PTY: u8 = 0x01;
pub const CHANNEL_CTRL: u8 = 0x02;
pub const CHANNEL_DISPLAY_DATAGRAM: u8 = 0x03;
pub const CHANNEL_DISPLAY_COMMIT: u8 = 0x04;
pub const CHANNEL_DISPLAY_ACK: u8 = 0x05;
/// Browser <-> daemon bulk-lane handshake. Every frame carries a generation
/// nonce so a replacement browser attachment cannot inherit confirmation from
/// the connection it displaced at the edge.
pub const CHANNEL_DATA_HELLO: u8 = 0x06;
/// Finite content streams only; keys belong to the independent content domain.
pub const CHANNEL_GRAPHICS_CONTENT: u8 = 0x07;
pub const MSG_TYPE_GEOMETRY_CLAIM: u8 = 0x3b;
pub const MSG_TYPE_GEOMETRY_STATE: u8 = 0x3c;
pub const MSG_TYPE_GRAPHICS_REQUEST: u8 = 0x38;
pub const MSG_TYPE_GRAPHICS_CANCEL: u8 = 0x39;
pub const MSG_TYPE_GRAPHICS_UNAVAILABLE: u8 = 0x3a;

/// Independently congested and independently owned edge connections.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeLane {
    Signaling,
    Interactive,
    Bulk,
}

impl EdgeLane {
    pub const ALL: [Self; 3] = [Self::Signaling, Self::Interactive, Self::Bulk];

    pub fn routing_id(self, session_id: &str) -> String {
        match self {
            Self::Signaling => format!("{session_id}#signaling"),
            Self::Interactive => session_id.to_string(),
            Self::Bulk => format!("{session_id}#bulk"),
        }
    }

    pub fn allows_reliable(self, channel: u8) -> bool {
        match self {
            Self::Signaling => channel == CHANNEL_SIGNALING,
            Self::Interactive => matches!(
                channel,
                CHANNEL_PTY | CHANNEL_CTRL | CHANNEL_DISPLAY_COMMIT | CHANNEL_DATA_HELLO
            ),
            Self::Bulk => matches!(
                channel,
                CHANNEL_CTRL | CHANNEL_DISPLAY_COMMIT | CHANNEL_DATA_HELLO
            ),
        }
    }
}

/// Reliable control streams take precedence over queued display content.
/// This orders unsent stream bytes only: every lane still shares the QUIC
/// congestion window, and priority cannot bypass loss recovery or bytes in flight.
pub const RELIABLE_PRIORITY_CONTROL: i32 = 0;
pub const RELIABLE_PRIORITY_BULK: i32 = -1;

/// The send priority for one reliable channel's persistent stream.
///
/// `CHANNEL_DISPLAY_COMMIT` is the one bulk lane: reliable snapshots, jumbo
/// frames and resume repair. Everything else carries control — signaling
/// (session establishment and rebind), CTRL (input ACKs, heartbeat pongs,
/// dictionary lifecycle), PTY (keystrokes and echo), and the bulk lane's own
/// handshake, which is a handshake rather than content.
pub fn reliable_stream_priority(channel_id: u8) -> i32 {
    match channel_id {
        CHANNEL_DISPLAY_COMMIT => RELIABLE_PRIORITY_BULK,
        _ => RELIABLE_PRIORITY_CONTROL,
    }
}
pub const DATA_HANDSHAKE_VERSION: u8 = 1;
pub const DATA_HANDSHAKE_NONCE_BYTES: usize = 16;
const DATA_HANDSHAKE_HEADER_BYTES: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataHandshakeKind {
    Hello = 1,
    Ack = 3,
}

impl DataHandshakeKind {
    fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Hello),
            3 => Some(Self::Ack),
            _ => None,
        }
    }
}

pub type DataHandshakeGeneration = [u8; DATA_HANDSHAKE_NONCE_BYTES];

/// Encode a versioned bulk handshake payload as
/// `[version:u8][kind:u8][nonce:16]`.
pub fn encode_data_handshake_frame(
    kind: DataHandshakeKind,
    nonce: &[u8; DATA_HANDSHAKE_NONCE_BYTES],
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(DATA_HANDSHAKE_HEADER_BYTES + DATA_HANDSHAKE_NONCE_BYTES);
    payload.push(DATA_HANDSHAKE_VERSION);
    payload.push(kind as u8);
    payload.extend_from_slice(nonce);
    payload
}

/// Decode a current bulk handshake payload.
pub fn decode_data_handshake_frame(
    payload: &[u8],
) -> Option<(DataHandshakeKind, [u8; DATA_HANDSHAKE_NONCE_BYTES])> {
    let (&[version, kind], nonce) = payload.split_first_chunk::<DATA_HANDSHAKE_HEADER_BYTES>()?;
    // An exact nonce: a payload of any other length is refused here.
    let nonce: [u8; DATA_HANDSHAKE_NONCE_BYTES] = nonce.try_into().ok()?;
    if version != DATA_HANDSHAKE_VERSION {
        return None;
    }
    let kind = DataHandshakeKind::from_byte(kind)?;
    Some((kind, nonce))
}

pub fn encode_data_generation_frame(
    kind: DataHandshakeKind,
    generation: DataHandshakeGeneration,
) -> Vec<u8> {
    encode_data_handshake_frame(kind, &generation)
}

pub const MSG_TYPE_RESIZE: u8 = 0x01;
pub const MSG_TYPE_HEARTBEAT_PING: u8 = 0x03;
pub const MSG_TYPE_HEARTBEAT_PONG: u8 = 0x04;
pub const MSG_TYPE_DISCONNECT: u8 = 0x08;
pub const MSG_TYPE_TRANSPORT_HINT: u8 = 0x09;
pub const MSG_TYPE_SEQUENCED_KEYSTROKE: u8 = 0x0F;
pub const MSG_TYPE_INPUT_ACK: u8 = 0x10;
/// Input run carrying one authenticated shadow-model bit per entry. Opcode
/// `0x15` was the unflagged predecessor, which read every entry as unmodelled
/// for the whole run; it is retired, not accepted.
pub const MSG_TYPE_INPUT_RUN: u8 = 0x2A;
pub const MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST: u8 = 0x0c;
pub const MSG_TYPE_DISPLAY_RESUME: u8 = 0x13;
pub const MSG_TYPE_WEBTRANSPORT_UPGRADE_ACK: u8 = 0x14;
pub const MSG_TYPE_DISPLAY_HASH_DIGEST: u8 = 0x25;
pub const MSG_TYPE_DISPLAY_RESYNC_ROWS: u8 = 0x26;
/// Reliable selective display ACK (browser -> daemon, CTRL lane). Loss-proof
/// backstop to the datagram displayAck; body = generation:u32 | largest_seq:u32 |
/// received_mask:[u32;4] | recovered_mask:[u32;4] | grant:u32 (44 bytes exactly).
/// `merkur_codec::VERSION` is bumped whenever this control-message shape changes.
pub const MSG_TYPE_DISPLAY_ACK: u8 = 0x29;
/// Words in the display-ACK received bitmap.
///
/// Mirrored by `DISPLAY_ACK_MASK_WORDS` in `packages/protocol`; the pair is
/// pinned by the wire-conformance suite, because nothing at runtime detects a
/// width mismatch: a narrower mask simply reads as loss.
pub const DISPLAY_ACK_MASK_WORDS: usize = 4;
/// Sequences one acknowledgement can describe, `largest_seq` inclusive.
pub const DISPLAY_ACK_MASK_WINDOW: u32 = (DISPLAY_ACK_MASK_WORDS as u32) * 32;
/// generation | largest applied seq | received-bitmap words | FEC-recovered
/// bitmap words | cumulative display grant. The sealed display-ACK datagram
/// carries this body bare and the reliable CTRL backstop frames it, so one
/// parser serves both lanes. The daemon drops a body of any other length.
pub const DISPLAY_ACK_PAYLOAD_BYTES: usize = 4 * (3 + 2 * DISPLAY_ACK_MASK_WORDS);

/// The largest grant window a viewer may hold open, and the daemon's bound on
/// the grants it accepts: a window past it is refused as malformed, and
/// display would stall.
pub const DISPLAY_DEMAND_MAX_WINDOW: u32 = 255;

/// One selective display acknowledgement. Bit `n` of word `w` reports
/// `largest_seq - (w * 32 + n)`; the recovered bitmap marks the sequences FEC
/// reconstructed, with the same anchor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DisplayAckPayload {
    pub generation: u32,
    pub largest_seq: u32,
    pub received: [u32; DISPLAY_ACK_MASK_WORDS],
    pub recovered: [u32; DISPLAY_ACK_MASK_WORDS],
    pub grant: u32,
}

impl DisplayAckPayload {
    pub fn encode(&self) -> [u8; DISPLAY_ACK_PAYLOAD_BYTES] {
        let mut body = [0u8; DISPLAY_ACK_PAYLOAD_BYTES];
        let words = [self.generation, self.largest_seq]
            .into_iter()
            .chain(self.received)
            .chain(self.recovered)
            .chain([self.grant]);
        for (slot, word) in body.chunks_exact_mut(4).zip(words) {
            slot.copy_from_slice(&word.to_be_bytes());
        }
        body
    }

    pub fn parse(body: &[u8]) -> Option<Self> {
        const MASK_BYTES: usize = 4 * DISPLAY_ACK_MASK_WORDS;
        // The one length check: every split below is of a fixed-size array.
        let body: &[u8; DISPLAY_ACK_PAYLOAD_BYTES] = body.try_into().ok()?;
        let (generation, rest) = body.split_first_chunk::<4>()?;
        let (largest_seq, rest) = rest.split_first_chunk::<4>()?;
        let (received, rest) = rest.split_first_chunk::<MASK_BYTES>()?;
        let (recovered, rest) = rest.split_first_chunk::<MASK_BYTES>()?;
        let grant: &[u8; 4] = rest.try_into().ok()?;
        let words = |mask: &[u8; MASK_BYTES]| {
            let mut words = [0u32; DISPLAY_ACK_MASK_WORDS];
            for (word, bytes) in words.iter_mut().zip(mask.as_chunks::<4>().0) {
                *word = u32::from_be_bytes(*bytes);
            }
            words
        };
        Some(Self {
            generation: u32::from_be_bytes(*generation),
            largest_seq: u32::from_be_bytes(*largest_seq),
            received: words(received),
            recovered: words(recovered),
            grant: u32::from_be_bytes(*grant),
        })
    }
}

/// Browser -> daemon dictionary-readiness signal (CTRL lane), body =
/// `ready:u8` (0 or 1, one byte exactly).
///
/// This is terminal-worker lifecycle, not feature negotiation. The browser's
/// dictionary lives in a terminal worker that can be replaced while the
/// transport survives; a replacement worker has no memory of the dictionary
/// the daemon still owns. Clearing readiness makes the daemon fence its
/// dictionary state before the next frame, because compressing against a
/// dictionary the peer lacks is silent corruption rather than an error.
/// Readiness starts clear on every authentication and is set once the terminal
/// epoch is live.
pub const MSG_TYPE_DISPLAY_DICT_READY: u8 = 0x2B;
/// Browser -> daemon dictionary acknowledgement (CTRL lane), body =
/// `dict_id:u32`. The daemon must not compress against a dictionary until the
/// peer acknowledges it by id: reliable records share a persistent channel
/// stream, but successful transport admission is not evidence of browser
/// application, and decompressing against a missing dictionary is silent
/// corruption rather than an error.
pub const MSG_TYPE_DISPLAY_DICT_ACK: u8 = 0x2C;
/// Daemon -> browser dictionary install (CTRL lane, reliable), body =
/// `generation:u32 | dict_id:u32 | dict_hash:u32 | dict_len:u16 | bytes`.
pub const MSG_TYPE_DISPLAY_DICT_INSTALL: u8 = 0x2D;
/// Daemon -> browser prompt anchor (CTRL lane, reliable), body =
/// `generation:u32 | anchor_row:u16 | anchor_col:u16 | flags:u16`.
///
/// Geometry only: the first editable column of the current prompt, computed by
/// the daemon's own emulator. Never command text.
pub const MSG_TYPE_EDITOR_ANCHOR: u8 = 0x2E;
/// Daemon -> browser input-routing word (CTRL lane, reliable), body =
/// `generation:u32 | after_seq:u32 | serial:u32 | word:u16`: the display mode
/// word's pointer-routing and input-report bits, and only those
/// ([`INPUT_ROUTING_MASK`]), with the word's place among the display frames.
///
/// The mode word otherwise rides display headers, and none may leave while a
/// synchronized drain is paused on a partial grid, although the input encoder
/// already uses every mode the drain applied. This is the part of the word that
/// decides where browser input goes; the cursor, grid, alternate screen and
/// prediction grant of the uncommitted transaction stay behind.
///
/// Nothing orders the control stream against the display frames, so the word
/// names its place: it was read after every frame of `generation` up to display
/// sequence `after_seq`, and before every later one. The browser keeps its
/// routing bits across the headers of those earlier frames whenever they land,
/// and drops a word a later header has already applied past. `serial` (per
/// peer, skipping zero) orders two words sent at one place, which can cross on
/// different carriers. Mirrors `MESSAGE_TYPE_INPUT_ROUTING`.
pub const MSG_TYPE_INPUT_ROUTING: u8 = 0x3d;
/// The bits an input-routing word may carry: pointer clicks, drags, hover and
/// the wheel (`0x0f`), and the input reports (`0x1c0`). Mirrors
/// `INPUT_ROUTING_MASK`.
pub const INPUT_ROUTING_MASK: u16 = 0x01cf;
const INPUT_ROUTING_BODY_BYTES: usize = 4 + 4 + 4 + 2;
const INPUT_ROUTING_FRAME_BYTES: usize = PROTO_HEADER_BYTES + INPUT_ROUTING_BODY_BYTES;

/// One input-routing frame, on the stack: it is sent from the owner loop.
pub fn encode_input_routing_frame(
    generation: u32,
    after_seq: u32,
    serial: u32,
    word: u16,
) -> [u8; INPUT_ROUTING_FRAME_BYTES] {
    debug_assert_eq!(word & !INPUT_ROUTING_MASK, 0, "routing bits only");
    debug_assert!(
        generation != 0 && serial != 0,
        "generations and serials skip zero"
    );
    let mut frame = [0; INPUT_ROUTING_FRAME_BYTES];
    frame[0] = MSG_TYPE_INPUT_ROUTING;
    frame[3] = INPUT_ROUTING_BODY_BYTES as u8;
    frame[4..8].copy_from_slice(&generation.to_be_bytes());
    frame[8..12].copy_from_slice(&after_seq.to_be_bytes());
    frame[12..16].copy_from_slice(&serial.to_be_bytes());
    frame[16..].copy_from_slice(&word.to_be_bytes());
    frame
}

/// End of an incremental resume repair:
/// `generation:u32 | repair_id:u32 | member_count:u16 |
/// member_count * (row:u16 | minimum_admitted_seq:u32)`.
///
/// The browser holds its paint from the moment it asserts a resume claim until
/// each named row reaches its minimum. A newer retry of that row satisfies the
/// target; an unrelated newer sequence cannot. Reliable CTRL, one frame per
/// reconnect, and never load-bearing for terminal state: the presentation hold
/// has its own deadline.
pub const MSG_TYPE_DISPLAY_REPAIR_END: u8 = 0x31;
/// Browser -> daemon coalesced fused receiver-cost posterior (reliable CTRL).
pub const MSG_TYPE_DISPLAY_RECEIVER_PROFILE: u8 = 0x32;
/// Browser -> daemon measurement-only convergence probe (reliable CTRL).
/// Body = `observation_epoch:u32 | probe_id:u32`.
pub const MSG_TYPE_PERF_GRID_CONVERGENCE_REQUEST: u8 = 0x33;
/// Daemon -> browser measurement-only convergence observation (reliable CTRL).
/// Body = `observation_epoch:u32 | probe_id:u32 | generation:u32 |
/// last_admitted_seq:u32 | cols:u16 | rows:u16 | row_hashes:[u64; rows]`.
///
/// This is evidence, never a display correctness or presentation barrier. A
/// mismatch asks the existing selective-resync path to do the repair.
pub const MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE: u8 = 0x34;
/// Daemon -> browser OSC 8 link definitions (CTRL lane, reliable), body =
/// `flags:u8 | (link_id:u32 | uri_len:u32 | uri)*` to the end of the body.
///
/// Display cells name links by id; this message is how the browser learns the
/// URI an id names. With [`DISPLAY_LINK_TABLE_FLAG_RESET`] the records replace
/// every definition the browser holds; without it they extend them. A
/// definition set larger than one frame body continues in unflagged frames.
pub const MSG_TYPE_DISPLAY_LINK_TABLE: u8 = 0x35;
pub const DISPLAY_LINK_TABLE_FLAG_RESET: u8 = 1 << 0;
/// Daemon -> browser `merkur open` request (CTRL lane, reliable), body =
/// `epoch:u32 | seq:u32 | url`. The browser opens it when the user has just
/// interacted with the page and offers it behind a click otherwise, then
/// acknowledges it.
pub const MSG_TYPE_OPEN_URL: u8 = 0x36;
/// Browser -> daemon (CTRL lane), body = the `epoch:u32 | seq:u32` of an open
/// request it handled; the daemon stops offering it.
pub const MSG_TYPE_OPEN_URL_ACK: u8 = 0x37;
/// Bytes of the `epoch | seq` id that opens both open-url bodies. A wire fact.
pub const OPEN_URL_ID_BYTES: usize = 8;
/// One authenticated program request, stable across carrier reauthentication.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenUrlId {
    pub epoch: u32,
    pub seq: u32,
}
impl OpenUrlId {
    pub fn encode(self) -> [u8; OPEN_URL_ID_BYTES] {
        let mut body = [0; OPEN_URL_ID_BYTES];
        body[..4].copy_from_slice(&self.epoch.to_be_bytes());
        body[4..].copy_from_slice(&self.seq.to_be_bytes());
        body
    }
}
/// Largest web target accepted for either OSC 8 or a program open request.
/// This also bounds one URL retained by a client or daemon (2 MiB).
pub const OPEN_URL_MAX_BYTES: usize = 2 * 1024 * 1024;

/// A bounded prefix test for link-table cache admission. Full acceptance still
/// requires `openable_url`; an existing vetted URI need not be scanned again.
pub fn has_web_scheme(url: &[u8]) -> bool {
    let prefixed = |prefix: &[u8]| {
        url.split_at_checked(prefix.len())
            .is_some_and(|(scheme, rest)| !rest.is_empty() && scheme.eq_ignore_ascii_case(prefix))
    };
    prefixed(b"http://") || prefixed(b"https://")
}

/// Printable ASCII HTTP(S), safe to carry in a control frame or a host OSC 8.
/// Hosts parse the target again before invoking their browser or system opener.
pub fn openable_url(url: &[u8]) -> Option<&str> {
    if !has_web_scheme(url)
        || url.len() > OPEN_URL_MAX_BYTES
        || !url.iter().all(|byte| (0x21..=0x7e).contains(byte))
    {
        return None;
    }
    std::str::from_utf8(url).ok()
}

/// Parse the daemon's printable-ASCII HTTP(S) request without allocating.
/// A host also parses the URL before offering it to its system opener.
pub fn parse_open_url(body: &[u8]) -> Option<(OpenUrlId, &str)> {
    let (&[e0, e1, e2, e3, s0, s1, s2, s3], bytes) =
        body.split_first_chunk::<OPEN_URL_ID_BYTES>()?;
    let url = openable_url(bytes)?;
    let seq = u32::from_be_bytes([s0, s1, s2, s3]);
    if seq == 0 {
        return None;
    }
    Some((
        OpenUrlId {
            epoch: u32::from_be_bytes([e0, e1, e2, e3]),
            seq,
        },
        url,
    ))
}

/// Largest body a length-prefixed protocol frame can carry (24-bit length).
pub const PROTO_MAX_BODY_BYTES: usize = 0x00ff_ffff;
/// Browser -> daemon, CTRL lane: `enabled:u8 | observation_epoch:u32`.
///
/// The non-zero browser-owned epoch changes on every profiling-recorder reset.
/// It fences daemon batches that were already admitted to the persistent
/// reliable lane before that reset, so display-only operation samples cannot
/// leak into the next measurement window. This message is authenticated and
/// ordered with the timing batches on CTRL.
pub const MSG_TYPE_PERF_ENABLE: u8 = 0x2F;
pub const PERF_ENABLE_PAYLOAD_BYTES: usize = 5;
pub const PERF_GRID_CONVERGENCE_REQUEST_PAYLOAD_BYTES: usize = 8;
pub const PERF_GRID_CONVERGENCE_RESPONSE_FIXED_BYTES: usize = 20;
pub const PERF_GRID_CONVERGENCE_RESPONSE_MAX_BYTES: usize =
    PERF_GRID_CONVERGENCE_RESPONSE_FIXED_BYTES + merkur_codec::MAX_TERMINAL_ROWS * size_of::<u64>();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerfTimingConfig {
    pub enabled: bool,
    pub observation_epoch: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerfGridConvergenceRequest {
    pub observation_epoch: u32,
    pub probe_id: u32,
}

/// Decode the fixed-size, authenticated profiling probe. Both identifiers are
/// non-zero so a stale/default buffer can never address the current capture.
pub fn parse_perf_grid_convergence_request(body: &[u8]) -> Option<PerfGridConvergenceRequest> {
    let bytes: &[u8; PERF_GRID_CONVERGENCE_REQUEST_PAYLOAD_BYTES] = body.try_into().ok()?;
    let observation_epoch = u32::from_be_bytes(bytes[..4].try_into().ok()?);
    let probe_id = u32::from_be_bytes(bytes[4..].try_into().ok()?);
    (observation_epoch != 0 && probe_id != 0).then_some(PerfGridConvergenceRequest {
        observation_epoch,
        probe_id,
    })
}

/// Encode one exact authoritative-grid observation directly into its protocol
/// frame. The single allocation is bounded to 2,072 bytes including the
/// protocol header at Merkur's maximum 256-row viewport.
pub fn encode_perf_grid_convergence_response(
    observation_epoch: u32,
    probe_id: u32,
    generation: u32,
    last_admitted_seq: u32,
    cols: u16,
    rows: u16,
    row_hashes: &[u64],
) -> Option<Vec<u8>> {
    let dimensions_valid = cols != 0
        && rows != 0
        && usize::from(cols) <= merkur_codec::MAX_TERMINAL_COLUMNS
        && usize::from(rows) <= merkur_codec::MAX_TERMINAL_ROWS
        && usize::from(cols).checked_mul(usize::from(rows))? <= merkur_codec::MAX_TERMINAL_CELLS;
    if observation_epoch == 0
        || probe_id == 0
        || generation == 0
        || !dimensions_valid
        || row_hashes.len() != usize::from(rows)
    {
        return None;
    }
    let body_len = PERF_GRID_CONVERGENCE_RESPONSE_FIXED_BYTES
        .checked_add(row_hashes.len().checked_mul(size_of::<u64>())?)?;
    if body_len > PERF_GRID_CONVERGENCE_RESPONSE_MAX_BYTES {
        return None;
    }
    let mut frame = Vec::with_capacity(PROTO_HEADER_BYTES + body_len);
    frame.push(MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE);
    frame.push(((body_len >> 16) & 0xff) as u8);
    frame.push(((body_len >> 8) & 0xff) as u8);
    frame.push((body_len & 0xff) as u8);
    frame.extend_from_slice(&observation_epoch.to_be_bytes());
    frame.extend_from_slice(&probe_id.to_be_bytes());
    frame.extend_from_slice(&generation.to_be_bytes());
    frame.extend_from_slice(&last_admitted_seq.to_be_bytes());
    frame.extend_from_slice(&cols.to_be_bytes());
    frame.extend_from_slice(&rows.to_be_bytes());
    for hash in row_hashes {
        frame.extend_from_slice(&hash.to_be_bytes());
    }
    debug_assert_eq!(frame.len(), PROTO_HEADER_BYTES + body_len);
    Some(frame)
}

/// Decode the canonical profiling observation boundary. Unknown enable bytes,
/// a zero epoch, truncation, and trailing bytes are all rejected atomically.
pub fn parse_perf_timing_config(body: &[u8]) -> Option<PerfTimingConfig> {
    let bytes: &[u8; PERF_ENABLE_PAYLOAD_BYTES] = body.try_into().ok()?;
    let enabled = match bytes[0] {
        0 => false,
        1 => true,
        _ => return None,
    };
    let observation_epoch = u32::from_be_bytes(bytes[1..].try_into().ok()?);
    (observation_epoch != 0).then_some(PerfTimingConfig {
        enabled,
        observation_epoch,
    })
}

/// Daemon -> browser, CTRL lane. Cumulative completeness counters plus up to
/// five 44-byte, ten-stage `PerfTimingRecord`s (bounded by the u8 body length),
/// fenced by the exact observation epoch that enabled them. Input sequence zero
/// identifies the unique display-operation stream; non-zero records retain
/// input-causal weighting.
///
/// Durations, never timestamps: the daemon and the browser have unrelated clock
/// origins, so an absolute daemon time would be uninterpretable on arrival.
pub const MSG_TYPE_PERF_TIMING: u8 = 0x30;
/// Daemon -> browser, CTRL lane, beside the timing batches while profiling:
/// cumulative packet-admission refusals at both Merkur-owned egress hops (the
/// daemon's aggregate group and the edge's browser-facing one) and the edge's
/// daemon-to-browser datagram residence. Fenced by the observation epoch and
/// offered only when it differs from the last one a carrier admitted.
pub const MSG_TYPE_PERF_EGRESS: u8 = 0x3e;
/// `flags` bit 0: an editor boundary is open. Clear means the anchor is void.
pub const EDITOR_ANCHOR_FLAG_OPEN: u16 = 1 << 0;
pub const PROTO_HEADER_BYTES: usize = 4;
const MAX_PROTO_PAYLOAD_BYTES: usize = 0x00ff_ffff;

pub fn encode_proto_frame(msg_type: u8, payload: &[u8]) -> Vec<u8> {
    let len = payload.len();
    assert!(
        len <= MAX_PROTO_PAYLOAD_BYTES,
        "protocol payload exceeds the 24-bit wire length"
    );
    let mut frame = Vec::with_capacity(PROTO_HEADER_BYTES + len);
    frame.push(msg_type);
    frame.push(((len >> 16) & 0xFF) as u8);
    frame.push(((len >> 8) & 0xFF) as u8);
    frame.push((len & 0xFF) as u8);
    frame.extend_from_slice(payload);
    frame
}

/// Decode one complete current protocol frame.
///
/// Terminal transports preserve message boundaries, so a frame must contain
/// exactly the body declared by its 24-bit header. Accepting a prefix or
/// dispatching an undeclared suffix would create a second, implicit framing
/// protocol and make the Rust receiver disagree with `@merkur/protocol`.
pub fn decode_proto_frame(frame: &[u8]) -> Option<(u8, &[u8])> {
    let (header, payload) = frame.split_first_chunk::<PROTO_HEADER_BYTES>()?;
    let payload_len =
        (usize::from(header[1]) << 16) | (usize::from(header[2]) << 8) | usize::from(header[3]);
    if payload.len() != payload_len {
        return None;
    }
    Some((header[0], payload))
}

/// `[type][len:u24][seq:u32]`: the whole input-ack frame, which is why it is
/// encoded on the stack rather than through [`encode_proto_frame`].
pub const INPUT_ACK_FRAME_BYTES: usize = PROTO_HEADER_BYTES + 4;

pub fn encode_input_ack(seq: u32) -> [u8; INPUT_ACK_FRAME_BYTES] {
    let seq = seq.to_be_bytes();
    [MSG_TYPE_INPUT_ACK, 0, 0, 4, seq[0], seq[1], seq[2], seq[3]]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputRunEntry<'a> {
    pub payload: &'a [u8],
    pub shadow_modelled: bool,
}

/// Borrowing iterator over a fully validated input_run body.
pub struct InputRunIter<'a> {
    shadow_bits: &'a [u8],
    rest: &'a [u8],
    index: u8,
    remaining: u8,
}

impl<'a> Iterator for InputRunIter<'a> {
    type Item = InputRunEntry<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }
        let index = usize::from(self.index);
        self.index = self.index.wrapping_add(1);
        self.remaining -= 1;
        // `parse_input_run` walked every entry and sized the bitset before it
        // built this iterator, so none of these three reads comes up short.
        let (len, rest) = self.rest.split_first_chunk::<2>()?;
        let (payload, tail) = rest.split_at_checked(usize::from(u16::from_be_bytes(*len)))?;
        self.rest = tail;
        let shadow_bits = *self.shadow_bits.get(index >> 3)?;
        Some(InputRunEntry {
            payload,
            shadow_modelled: shadow_bits & (1 << (index & 7)) != 0,
        })
    }
}

/// The only defined `flags` bit of an input run. Set by the browser's idle
/// retransmit timer and by nothing else: a run that advanced nothing is owed
/// an ack only when it carries this mark, because the dual-send twin of every
/// keystroke, a reorder-gap insert and a backpressured rejection all arrive
/// without it and none of them needs an answer of its own. Mirrored by
/// `INPUT_RUN_FLAG_RETRANSMIT` in `packages/protocol`.
pub const INPUT_RUN_FLAG_RETRANSMIT: u8 = 0x01;
/// `flags` bit 1: a u64 liveness probe token follows the flags byte. The emit
/// that armed the browser's pong deadline carries it in place of a CTRL ping;
/// see `session::liveness::answer_input_probe`. Mirrored by
/// `INPUT_RUN_FLAG_PROBE` in `packages/protocol`.
pub const INPUT_RUN_FLAG_PROBE: u8 = 0x02;
const INPUT_RUN_HEADER_BYTES: usize = 4 + 1 + 1;
const INPUT_RUN_PROBE_BYTES: usize = 8;

/// The fixed prefix of a validated input run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputRunHeader {
    pub base_seq: u32,
    pub count: u8,
    pub retransmit: bool,
    /// The liveness probe token, when the run carries one.
    pub probe: Option<u64>,
    /// Where the shadow bitset starts in the body: past the token when present.
    pub shadow_offset: usize,
}

impl InputRunHeader {
    /// The wire seq of the run's last entry; `base_seq - 1` for an empty run.
    pub fn top_seq(&self) -> u32 {
        self.base_seq
            .wrapping_add(u32::from(self.count))
            .wrapping_sub(1)
    }
}

/// Parses the input run layout:
/// `base_seq:u32 | count:u8 | flags:u8 | [probe:u64 iff flags & 0x02] |
/// shadow_bits:ceil(count/8) | repeated(len:u16 | payload)`.
///
/// The complete body, canonical unused shadow bits, canonical flag bits and
/// every entry's input record (`input_record::validate`) are validated before
/// an iterator is returned, so malformed input cannot
/// partially mutate PTY state. A reserved flag bit is rejected before a single
/// entry is read.
pub fn parse_input_run(body: &[u8]) -> Option<(InputRunHeader, InputRunIter<'_>)> {
    let &[b0, b1, b2, b3, count, flags] = body.first_chunk::<INPUT_RUN_HEADER_BYTES>()?;
    let base_seq = u32::from_be_bytes([b0, b1, b2, b3]);
    if flags & !(INPUT_RUN_FLAG_RETRANSMIT | INPUT_RUN_FLAG_PROBE) != 0 {
        return None;
    }
    let (probe, shadow_offset) = if flags & INPUT_RUN_FLAG_PROBE != 0 {
        let end = INPUT_RUN_HEADER_BYTES + INPUT_RUN_PROBE_BYTES;
        let token: [u8; INPUT_RUN_PROBE_BYTES] =
            body.get(INPUT_RUN_HEADER_BYTES..end)?.try_into().ok()?;
        (Some(u64::from_be_bytes(token)), end)
    } else {
        (None, INPUT_RUN_HEADER_BYTES)
    };
    let bitset_len = usize::from(count).div_ceil(8);
    let bitset_end = shadow_offset.checked_add(bitset_len)?;
    let shadow_bits = body.get(shadow_offset..bitset_end)?;
    if !count.is_multiple_of(8) {
        let used_mask = (1u8 << (count % 8)) - 1;
        if shadow_bits.last().copied()? & !used_mask != 0 {
            return None;
        }
    }
    let entries = body.get(bitset_end..)?;
    let mut remaining = entries;
    for _ in 0..count {
        let (len, rest) = remaining.split_first_chunk::<2>()?;
        let (record, rest) = rest.split_at_checked(usize::from(u16::from_be_bytes(*len)))?;
        if !super::input_record::validate(record) {
            return None;
        }
        remaining = rest;
    }
    if !remaining.is_empty() {
        return None;
    }
    Some((
        InputRunHeader {
            base_seq,
            count,
            retransmit: flags & INPUT_RUN_FLAG_RETRANSMIT != 0,
            probe,
            shadow_offset,
        },
        InputRunIter {
            shadow_bits,
            rest: entries,
            index: 0,
            remaining: count,
        },
    ))
}

/// Encodes one input run frame: what a client sends and [`parse_input_run`]
/// reads back.
pub fn encode_input_run(base_seq: u32, retransmit: bool, entries: &[(&[u8], bool)]) -> Vec<u8> {
    encode_probed_input_run(base_seq, retransmit, None, entries)
}

/// `encode_input_run` with the liveness probe token the browser's emit carries.
pub fn encode_probed_input_run(
    base_seq: u32,
    retransmit: bool,
    probe: Option<u64>,
    entries: &[(&[u8], bool)],
) -> Vec<u8> {
    let mut frame = Vec::new();
    encode_probed_input_run_into(
        &mut frame,
        base_seq,
        retransmit,
        probe,
        entries.iter().copied(),
    );
    frame
}

/// [`encode_probed_input_run`] into `frame`, replacing what it held: the
/// protocol header and the body are written in one pass with no intermediate
/// buffer, so a sender that keeps `frame` encodes each run without allocating.
pub fn encode_probed_input_run_into<'a>(
    frame: &mut Vec<u8>,
    base_seq: u32,
    retransmit: bool,
    probe: Option<u64>,
    entries: impl ExactSizeIterator<Item = (&'a [u8], bool)> + Clone,
) {
    let count = entries.len();
    debug_assert!(count <= u8::MAX as usize);
    let bitset_len = count.div_ceil(8);
    let body_len = INPUT_RUN_HEADER_BYTES
        + probe.map_or(0, |_| INPUT_RUN_PROBE_BYTES)
        + bitset_len
        + entries
            .clone()
            .map(|(entry, _)| 2 + entry.len())
            .sum::<usize>();
    assert!(
        body_len <= MAX_PROTO_PAYLOAD_BYTES,
        "protocol payload exceeds the 24-bit wire length"
    );
    frame.clear();
    frame.reserve(PROTO_HEADER_BYTES + body_len);
    frame.push(MSG_TYPE_INPUT_RUN);
    frame.extend_from_slice(&(body_len as u32).to_be_bytes()[1..]);
    frame.extend_from_slice(&base_seq.to_be_bytes());
    frame.push(count as u8);
    let retransmit_flag = if retransmit {
        INPUT_RUN_FLAG_RETRANSMIT
    } else {
        0
    };
    frame.push(retransmit_flag | probe.map_or(0, |_| INPUT_RUN_FLAG_PROBE));
    if let Some(token) = probe {
        frame.extend_from_slice(&token.to_be_bytes());
    }
    let bitset_start = frame.len();
    frame.resize(bitset_start + bitset_len, 0);
    for (index, (_, shadow_modelled)) in entries.clone().enumerate() {
        // The resize above made room for `count.div_ceil(8)` bytes, one bit per
        // entry, so the byte is always there.
        if shadow_modelled && let Some(bits) = frame.get_mut(bitset_start + (index >> 3)) {
            *bits |= 1 << (index & 7);
        }
    }
    for (entry, _) in entries {
        frame.extend_from_slice(&(entry.len() as u16).to_be_bytes());
        frame.extend_from_slice(entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_display_ack_is_eleven_big_endian_words_and_nothing_else() {
        let ack = DisplayAckPayload {
            generation: 7,
            largest_seq: 99,
            received: [1, 2, 3, 0x8000_0000],
            recovered: [4, 0, 0, 5],
            grant: 0x0102_0304,
        };
        let body = ack.encode();
        assert_eq!(body.len(), 44);
        assert_eq!(&body[..8], &[0, 0, 0, 7, 0, 0, 0, 99]);
        assert_eq!(&body[20..24], &[0x80, 0, 0, 0], "received word 3");
        assert_eq!(&body[24..28], &[0, 0, 0, 4], "recovered word 0");
        assert_eq!(&body[40..], &[1, 2, 3, 4], "the grant follows both masks");
        assert_eq!(DisplayAckPayload::parse(&body), Some(ack));
        assert_eq!(DisplayAckPayload::parse(&body[..43]), None);
        let mut long = body.to_vec();
        long.push(0);
        assert_eq!(DisplayAckPayload::parse(&long), None);
    }
    use crate::input_record::build;

    #[test]
    fn only_the_reliable_display_lane_yields_the_connection() {
        // Named one by one rather than looped, so adding a reliable channel is
        // a decision taken here rather than a default inherited silently.
        assert_eq!(
            reliable_stream_priority(CHANNEL_SIGNALING),
            RELIABLE_PRIORITY_CONTROL
        );
        assert_eq!(
            reliable_stream_priority(CHANNEL_PTY),
            RELIABLE_PRIORITY_CONTROL
        );
        assert_eq!(
            reliable_stream_priority(CHANNEL_CTRL),
            RELIABLE_PRIORITY_CONTROL
        );
        assert_eq!(
            reliable_stream_priority(CHANNEL_DATA_HELLO),
            RELIABLE_PRIORITY_CONTROL
        );
        assert_eq!(
            reliable_stream_priority(CHANNEL_DISPLAY_COMMIT),
            RELIABLE_PRIORITY_BULK
        );
        const { assert!(RELIABLE_PRIORITY_BULK < RELIABLE_PRIORITY_CONTROL) };
    }

    #[test]
    fn proto_frame_requires_exact_declared_length() {
        let frame = encode_proto_frame(MSG_TYPE_HEARTBEAT_PING, &[1, 2, 3]);
        assert_eq!(
            decode_proto_frame(&frame),
            Some((MSG_TYPE_HEARTBEAT_PING, &[1, 2, 3][..]))
        );
        assert!(decode_proto_frame(&frame[..frame.len() - 1]).is_none());

        let mut trailing = frame;
        trailing.push(4);
        assert!(decode_proto_frame(&trailing).is_none());
        assert!(decode_proto_frame(&[MSG_TYPE_HEARTBEAT_PING, 0, 0]).is_none());
    }

    /// The bytes `wire-conformance.test.ts` decodes: the word's display
    /// position, its serial, and the word.
    #[test]
    fn input_routing_frame_names_its_display_position() {
        let frame = encode_input_routing_frame(7, 0x0102_0304, 9, 0x01c1);
        let (header, body) = frame.split_at(PROTO_HEADER_BYTES);
        assert_eq!(header, [MSG_TYPE_INPUT_ROUTING, 0, 0, 14]);
        assert_eq!(body, [0, 0, 0, 7, 1, 2, 3, 4, 0, 0, 0, 9, 0x01, 0xc1]);
        assert_eq!(
            decode_proto_frame(&frame),
            Some((MSG_TYPE_INPUT_ROUTING, body))
        );
    }

    #[test]
    fn input_run_truncated_header_returns_none() {
        assert!(parse_input_run(&[0x00, 0x00, 0x00, 0x09]).is_none());
        // base + count without the flags byte is a truncated header, not an
        // empty run.
        assert!(parse_input_run(&[0x00, 0x00, 0x00, 0x09, 0x00]).is_none());
    }

    #[test]
    fn input_run_rejects_truncated_entry_atomically() {
        // base=9, count=2, flags 0x00, shadow bitset 0x00, first entry the
        // two-byte record for 'a', second entry len=2 but only one byte present.
        let body = [
            0x00, 0x00, 0x00, 0x09, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x61, 0x00, 0x02, 0x00,
        ];
        assert!(parse_input_run(&body).is_none());
    }

    #[test]
    fn input_run_rejects_a_malformed_record_in_a_well_formed_frame() {
        // Framing is complete and canonical; the second entry is not a record
        // (kind 7 is reserved). Nothing of the run may reach the PTY.
        let good = build::press('a');
        let frame = encode_input_run(1, false, &[(&good[..], false), (&[0xe0][..], false)]);
        assert!(parse_input_run(&frame[PROTO_HEADER_BYTES..]).is_none());
    }

    #[test]
    fn input_run_rejects_trailing_bytes_past_count() {
        let mut body = vec![
            0x00, 0x00, 0x00, 0x09, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x61,
        ];
        body.extend_from_slice(&[0xde, 0xad]); // garbage tail
        assert!(parse_input_run(&body).is_none());
    }

    #[test]
    fn input_run_roundtrips_bitset_and_payloads() {
        let a = build::press('a');
        let bc = build::text("bc");
        let d = build::press('d');
        let frame = encode_input_run(
            9,
            false,
            &[(&a[..], true), (&bc[..], false), (&d[..], true)],
        );
        assert_eq!(frame[0], MSG_TYPE_INPUT_RUN);
        // [base=9][count=3][flags=0][bits=0b101]
        assert_eq!(
            &frame[PROTO_HEADER_BYTES..PROTO_HEADER_BYTES + 7],
            &[0x00, 0x00, 0x00, 0x09, 0x03, 0x00, 0x05]
        );
        let (header, entries) = parse_input_run(&frame[PROTO_HEADER_BYTES..]).expect("run parses");
        assert_eq!(
            header,
            InputRunHeader {
                base_seq: 9,
                count: 3,
                retransmit: false,
                probe: None,
                shadow_offset: 6,
            }
        );
        assert_eq!(
            entries.collect::<Vec<_>>(),
            vec![
                InputRunEntry {
                    payload: &a,
                    shadow_modelled: true,
                },
                InputRunEntry {
                    payload: &bc,
                    shadow_modelled: false,
                },
                InputRunEntry {
                    payload: &d,
                    shadow_modelled: true,
                },
            ]
        );
    }

    #[test]
    fn input_run_rejects_noncanonical_bits_and_truncation_atomically() {
        // count=1 permits only bit 0; bit 7 must be rejected.
        let noncanonical = [0, 0, 0, 1, 1, 0, 0x80, 0, 2, 0x00, b'a'];
        assert!(parse_input_run(&noncanonical).is_none());

        // count=2, complete bitset, second payload declares two bytes but has one.
        let truncated = [0, 0, 0, 1, 2, 0, 0x01, 0, 2, 0x00, b'a', 0, 2, 0x00];
        assert!(parse_input_run(&truncated).is_none());
    }

    #[test]
    fn input_run_roundtrips_the_retransmit_mark() {
        let frame = encode_input_run(7, true, &[(&build::press('a')[..], false)]);
        assert_eq!(
            &frame[PROTO_HEADER_BYTES..PROTO_HEADER_BYTES + 6],
            &[0x00, 0x00, 0x00, 0x07, 0x01, INPUT_RUN_FLAG_RETRANSMIT]
        );
        let (header, entries) = parse_input_run(&frame[PROTO_HEADER_BYTES..]).expect("run parses");
        assert_eq!(
            header,
            InputRunHeader {
                base_seq: 7,
                count: 1,
                retransmit: true,
                probe: None,
                shadow_offset: 6,
            }
        );
        assert_eq!(entries.count(), 1);
    }

    #[test]
    fn input_run_carries_a_probe_token_between_the_flags_and_the_bitset() {
        let a = build::press('a');
        let d = build::press('d');
        let token = 0x0102_0304_0506_0708;
        let frame =
            encode_probed_input_run(9, false, Some(token), &[(&a[..], true), (&d[..], false)]);
        // [base=9][count=2][flags=0x02][token][bits=0b01]
        assert_eq!(
            &frame[PROTO_HEADER_BYTES..PROTO_HEADER_BYTES + 15],
            &[
                0,
                0,
                0,
                9,
                2,
                INPUT_RUN_FLAG_PROBE,
                1,
                2,
                3,
                4,
                5,
                6,
                7,
                8,
                0b01
            ]
        );
        let (header, entries) = parse_input_run(&frame[PROTO_HEADER_BYTES..]).expect("run parses");
        assert_eq!(
            header,
            InputRunHeader {
                base_seq: 9,
                count: 2,
                retransmit: false,
                probe: Some(token),
                shadow_offset: 14,
            }
        );
        assert_eq!(header.top_seq(), 10);
        assert_eq!(
            entries
                .map(|entry| (entry.payload.to_vec(), entry.shadow_modelled))
                .collect::<Vec<_>>(),
            vec![(a.to_vec(), true), (d.to_vec(), false)]
        );
        let marked = encode_probed_input_run(9, true, Some(token), &[(&a[..], true)]);
        let (header, _) = parse_input_run(&marked[PROTO_HEADER_BYTES..]).expect("run parses");
        assert!(header.retransmit);
        assert_eq!(header.probe, Some(token));
    }

    #[test]
    fn input_run_rejects_a_probe_flag_with_a_truncated_token() {
        // flags=0x02 with seven of the token's eight bytes and no entries.
        let truncated = [0, 0, 0, 1, 0, INPUT_RUN_FLAG_PROBE, 1, 2, 3, 4, 5, 6, 7];
        assert!(parse_input_run(&truncated).is_none());
        let mut whole = truncated.to_vec();
        whole.push(8);
        let (header, entries) = parse_input_run(&whole).expect("an empty probed run parses");
        assert_eq!(header.probe, Some(0x0102_0304_0506_0708));
        assert_eq!(entries.count(), 0);
    }

    #[test]
    fn input_run_rejects_unknown_flag_bits_before_reading_entries() {
        // A well-formed one-entry run whose flags byte carries a reserved bit
        // beside the retransmit mark. Nothing after the header is consulted.
        let reserved = [0, 0, 0, 1, 1, 0x05, 0x00, 0, 2, 0x00, b'a'];
        assert!(parse_input_run(&reserved).is_none());
        // The same run with a reserved bit and an entry that would ALSO fail
        // is rejected by the flags check first — the body is never walked.
        let reserved_and_truncated = [0, 0, 0, 1, 1, 0x80, 0x00, 0, 3, 0x00, b'a'];
        assert!(parse_input_run(&reserved_and_truncated).is_none());
        let mut well_formed = reserved;
        well_formed[5] = INPUT_RUN_FLAG_RETRANSMIT;
        assert!(parse_input_run(&well_formed).is_some());
    }

    #[test]
    fn data_handshake_frames_roundtrip_and_reject_nonce_less_or_malformed_payloads() {
        let nonce = [0x5a; DATA_HANDSHAKE_NONCE_BYTES];
        for kind in [DataHandshakeKind::Hello, DataHandshakeKind::Ack] {
            let encoded = encode_data_handshake_frame(kind, &nonce);
            assert_eq!(decode_data_handshake_frame(&encoded), Some((kind, nonce)));
        }

        assert_eq!(decode_data_handshake_frame(&[]), None);
        assert_eq!(
            decode_data_handshake_frame(&[DATA_HANDSHAKE_VERSION, DataHandshakeKind::Hello as u8]),
            None
        );
        let mut future = encode_data_handshake_frame(DataHandshakeKind::Hello, &nonce);
        future[0] = DATA_HANDSHAKE_VERSION + 1;
        assert_eq!(decode_data_handshake_frame(&future), None);
    }

    #[test]
    fn perf_timing_config_requires_a_canonical_toggle_and_nonzero_observation_epoch() {
        assert_eq!(
            parse_perf_timing_config(&[1, 0x01, 0x02, 0x03, 0x04]),
            Some(PerfTimingConfig {
                enabled: true,
                observation_epoch: 0x0102_0304,
            })
        );
        assert_eq!(
            parse_perf_timing_config(&[0, 0x05, 0x06, 0x07, 0x08]),
            Some(PerfTimingConfig {
                enabled: false,
                observation_epoch: 0x0506_0708,
            })
        );

        assert!(parse_perf_timing_config(&[1, 0, 0, 0, 0]).is_none());
        assert!(parse_perf_timing_config(&[2, 0, 0, 0, 1]).is_none());
        assert!(parse_perf_timing_config(&[1, 0, 0, 1]).is_none());
        assert!(parse_perf_timing_config(&[1, 0, 0, 0, 1, 0]).is_none());
    }

    #[test]
    fn convergence_request_is_fixed_size_and_rejects_default_identifiers() {
        assert_eq!(
            parse_perf_grid_convergence_request(&[0, 0, 0, 7, 0, 0, 0, 9]),
            Some(PerfGridConvergenceRequest {
                observation_epoch: 7,
                probe_id: 9,
            })
        );
        assert!(parse_perf_grid_convergence_request(&[0, 0, 0, 0, 0, 0, 0, 9]).is_none());
        assert!(parse_perf_grid_convergence_request(&[0, 0, 0, 7, 0, 0, 0, 0]).is_none());
        assert!(parse_perf_grid_convergence_request(&[0, 0, 0, 7, 0, 0, 0]).is_none());
        assert!(parse_perf_grid_convergence_request(&[0, 0, 0, 7, 0, 0, 0, 9, 0]).is_none());
    }

    #[test]
    fn convergence_response_has_one_bounded_canonical_row_hash_vector() {
        let hashes = [0x0102_0304_0506_0708, 0x1112_1314_1516_1718];
        let frame = encode_perf_grid_convergence_response(7, 9, 11, 13, 120, 2, &hashes)
            .expect("valid convergence response");
        let (msg_type, body) = decode_proto_frame(&frame).expect("complete frame");
        assert_eq!(msg_type, MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE);
        assert_eq!(body.len(), PERF_GRID_CONVERGENCE_RESPONSE_FIXED_BYTES + 16);
        assert_eq!(&body[0..4], &7u32.to_be_bytes());
        assert_eq!(&body[4..8], &9u32.to_be_bytes());
        assert_eq!(&body[8..12], &11u32.to_be_bytes());
        assert_eq!(&body[12..16], &13u32.to_be_bytes());
        assert_eq!(&body[16..18], &120u16.to_be_bytes());
        assert_eq!(&body[18..20], &2u16.to_be_bytes());
        assert_eq!(&body[20..28], &hashes[0].to_be_bytes());
        assert_eq!(&body[28..36], &hashes[1].to_be_bytes());

        assert!(encode_perf_grid_convergence_response(0, 9, 11, 13, 120, 2, &hashes).is_none());
        assert!(encode_perf_grid_convergence_response(7, 0, 11, 13, 120, 2, &hashes).is_none());
        assert!(encode_perf_grid_convergence_response(7, 9, 0, 13, 120, 2, &hashes).is_none());
        assert!(encode_perf_grid_convergence_response(7, 9, 11, 13, 0, 2, &hashes).is_none());
        assert!(
            encode_perf_grid_convergence_response(
                7,
                9,
                11,
                13,
                u16::try_from(merkur_codec::MAX_TERMINAL_COLUMNS).unwrap(),
                u16::try_from(merkur_codec::MAX_TERMINAL_ROWS).unwrap(),
                &vec![0; merkur_codec::MAX_TERMINAL_ROWS],
            )
            .is_none(),
            "the shared total-cell bound remains authoritative",
        );
        assert!(
            encode_perf_grid_convergence_response(7, 9, 11, 13, 120, 2, &hashes[..1]).is_none()
        );
    }

    #[test]
    fn maximum_legal_convergence_response_stays_strictly_bounded() {
        let cols = (merkur_codec::MAX_TERMINAL_CELLS / merkur_codec::MAX_TERMINAL_ROWS) as u16;
        let hashes = vec![0x55aa; merkur_codec::MAX_TERMINAL_ROWS];
        let frame = encode_perf_grid_convergence_response(
            u32::MAX,
            u32::MAX,
            u32::MAX,
            0,
            cols,
            u16::try_from(merkur_codec::MAX_TERMINAL_ROWS).unwrap(),
            &hashes,
        )
        .expect("maximum legal response");
        assert_eq!(
            frame.len(),
            PROTO_HEADER_BYTES + PERF_GRID_CONVERGENCE_RESPONSE_MAX_BYTES
        );
        assert_eq!(frame.len(), 2_072);
    }
}

#[cfg(test)]
mod open_url_tests {
    use super::*;
    #[test]
    fn program_url_body_is_bounded_and_keeps_the_exact_stable_identity() {
        let id = OpenUrlId {
            epoch: 0,
            seq: u32::MAX,
        };
        let mut body = id.encode().to_vec();
        body.extend_from_slice(b"HTTPS://example.com/a;b?q=1");
        assert_eq!(
            parse_open_url(&body),
            Some((id, "HTTPS://example.com/a;b?q=1"))
        );
        assert!(parse_open_url(&body[..8]).is_none());
        body[4..8].fill(0);
        assert!(parse_open_url(&body).is_none());
        for url in [
            "https://",
            "file:///etc/passwd",
            "https://a/\x1b]52;c;x",
            "https://a/ x",
            "https://a/é",
        ] {
            let mut body = id.encode().to_vec();
            body.extend_from_slice(url.as_bytes());
            assert!(parse_open_url(&body).is_none(), "{url:?}");
        }
        let mut body = id.encode().to_vec();
        body.extend_from_slice(b"https://a/");
        body.resize(8 + 2 * 1024 * 1024, b'x');
        assert!(parse_open_url(&body).is_some());
        body.push(b'x');
        assert!(parse_open_url(&body).is_none());
    }
}
