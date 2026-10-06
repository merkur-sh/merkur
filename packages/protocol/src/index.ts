export * from './input-record';
export type { TerminalUiEffect } from './terminal-ui';

const HEADER_SIZE_BYTES = 4;
const LENGTH_HIGH_SHIFT = 16;
const LENGTH_MIDDLE_SHIFT = 8;
const LENGTH_MASK = 0xff;
const MAX_PAYLOAD_BYTES = 0x00ff_ffff;
const UINT32_BYTES = 4;
const UINT64_BYTES = 8;
const TRANSPORT_HINT_BYTES = 11;
const DISPLAY_RECEIVER_PROFILE_HEADER_BYTES = 13;
const DISPLAY_RECEIVER_PROFILE_BUCKET_BYTES = 20;
const DISPLAY_RECEIVER_PROFILE_MAX_BUCKETS = 48;
const INPUT_ACK_PAYLOAD_BYTES = UINT32_BYTES;
const PERF_GRID_CONVERGENCE_REQUEST_PAYLOAD_BYTES = 8;

export const MESSAGE_TYPE_HEARTBEAT_PING = 0x03;
export const MESSAGE_TYPE_HEARTBEAT_PONG = 0x04;
export const MESSAGE_TYPE_TRANSPORT_HINT = 0x09;
export const MESSAGE_TYPE_INPUT_ACK = 0x10;
/**
 * Daemon -> browser prompt anchor: the first editable column of the current
 * prompt, computed by the daemon's own emulator at the exact byte where the
 * shell's OSC 133;B terminated. Geometry only — never command text.
 */
export const MESSAGE_TYPE_EDITOR_ANCHOR = 0x2e;
/**
 * Daemon -> browser input-routing word, CTRL lane, reliable. Body
 * `generation:u32 | afterSeq:u32 | serial:u32 | word:u16`: the mode word's
 * pointer-routing and input-report bits, and only those, with the word's place
 * among the display frames.
 *
 * A synchronized update paused on a partial grid lets no display header leave,
 * yet the daemon already encodes input under the modes it applied. This is the
 * part of the word that decides where input goes. Nothing orders the control
 * lane against the display frames, so the word names its place: after every
 * frame of `generation` up to display sequence `afterSeq`, before every later
 * one. `serial` orders two words sent at one place.
 */
export const MESSAGE_TYPE_INPUT_ROUTING = 0x3d;
/**
 * Browser -> daemon: enable or disable daemon-interior latency attribution.
 *
 * Five bytes: one canonical enable byte plus a non-zero browser-owned u32
 * observation epoch. A recorder reset advances the epoch before clearing its
 * events, so reliable batches already in flight can never contaminate the new
 * measurement window.
 */
export const MESSAGE_TYPE_PERF_ENABLE = 0x2f;
export const MESSAGE_TYPE_DISPLAY_HASH_DIGEST = 0x25;
/**
 * End of an incremental resume repair.
 *
 * The browser holds its paint from the moment it asserts a resume claim until
 * each named row has reached its minimum admitted sequence, so a hole below a
 * newer unrelated datagram cannot expose a partial repair.
 */
export const MESSAGE_TYPE_DISPLAY_REPAIR_END = 0x31;
/** Browser -> daemon coalesced receiver-cost posterior, reliable CTRL lane. */
export const MESSAGE_TYPE_DISPLAY_RECEIVER_PROFILE = 0x32;
/** Browser -> daemon measurement-only authoritative-grid observation request. */
export const MESSAGE_TYPE_PERF_GRID_CONVERGENCE_REQUEST = 0x33;

export interface TransportHintMessage {
  readonly kind: 'transport_hint';
  readonly profile: number;
  readonly chunkBytes: number;
  readonly snapshotBytes: number;
  /**
   * Display datagrams this browser's WebTransport receive queue actually holds,
   * read back after configuring it rather than assumed.
   *
   * The daemon bounds one display flush by this, so a burst can never be larger
   * than the queue meant to receive it. Both ends previously agreed on
   * `DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH` by convention, which is not a
   * guarantee: the queue-limit setters are an optional browser capability, and
   * a browser that quietly kept a shallower queue would drop the tail of every
   * large redraw with nothing on either side able to tell. Zero means the
   * browser exposes no readable depth, and the daemon falls back to the shared
   * constant — the only honest reading when the receiver cannot say.
   */
  readonly receiveQueueDatagrams: number;
  /** Quantized browser presentation period in microseconds. */
  readonly presentationPeriodUs: number;
}

export interface DisplayReceiverProfileBucket {
  /** 0 = plain zstd, 1 = finalized-dictionary zstd. */
  readonly dictionaryClass: number;
  /** Log2-like raw frame size bucket, 0..5. */
  readonly sizeClass: number;
  /** Compressed wire/raw ratio bucket: <=1/8, <=1/4, <=1/2, >1/2. */
  readonly ratioClass: number;
  readonly sampleCount: number;
  readonly wireRatioPpm: number;
  /** Incremental fused decode/validation cost above raw validation. */
  readonly meanUs: number;
  readonly varianceUs2: number;
  readonly upperUs: number;
}

export interface DisplayReceiverProfileMessage {
  readonly kind: 'display_receiver_profile';
  readonly sampleRevision: number;
  readonly ageMs: number;
  readonly serviceDebtUs: number;
  readonly buckets: readonly DisplayReceiverProfileBucket[];
}

export interface InputAckMessage {
  readonly kind: 'input_ack';
  readonly seq: number;
}

export interface DisplayLinkDefinition {
  readonly id: number;
  readonly uri: string;
}

/**
 * One keystroke's daemon-interior latency, split into ten contiguous terms.
 *
 * Durations in microseconds, never timestamps: the daemon and the browser have
 * unrelated clock origins, so an absolute daemon time could not be interpreted
 * here. `inputSeq` is the join key back to the browser's own events.
 *
 * The ten sum to the whole daemon segment, which is the identity that makes
 * this a partition rather than unrelated samples.
 */
export interface PerfTimingRecord {
  /** Zero identifies a unique display operation; positive values are input-causal. */
  readonly inputSeq: number;
  /** Datagram arrival to the bytes entering the PTY FIFO. Daemon ingress. */
  readonly recvToPtyUs: number;
  /** PTY write to the first PTY output after it. The shell, not Merkur. */
  readonly ptyToReadUs: number;
  readonly gridApplyUs: number;
  readonly displayCoalesceUs: number;
  readonly selectCaptureUs: number;
  readonly prepareQueueUs: number;
  /** Batch/encode/frame/FEC CPU excluding the compression stage. */
  readonly encodeUs: number;
  /** Complete compression stage, including rejected candidates. */
  readonly compressionUs: number;
  readonly completionQueueUs: number;
  readonly transportSubmitUs: number;
  /**
   * FIFO enqueue to the owner handling this input's PTY write completion,
   * which queues its cumulative ACK. Null when the daemon never observed it.
   * Parallel to the echo terms; not part of their partition.
   */
  readonly writeCompletionUs: number | null;
  /**
   * That handling to the QUIC packetization of the ACK datagram twin. With
   * `recvToPtyUs` and `writeCompletionUs`, the daemon's whole share of the
   * input-ACK time. Null when the daemon never observed the packetization.
   */
  readonly ackTransmitUs: number | null;
  /**
   * The daemon's owner thread over this record's span (PTY FIFO enqueue to
   * carrier submission; the flush alone for a display operation), beside the
   * partition: CPU time inside its busy periods.
   */
  readonly ownerCpuUs: number;
  /** Wall time inside those busy periods off the CPU: blocked or descheduled. */
  readonly ownerOffCpuUs: number;
  /** Contended QUIC connection-state lock waits (also inside `ownerOffCpuUs`). */
  readonly ownerQuinnWaitUs: number;
  /** WebTransport registry lock waits; async, so idle rather than busy. */
  readonly ownerRegistryWaitUs: number;
  /** Both lock waits inside the flush alone, flush start to carrier submission. */
  readonly flushLockWaitUs: number;
}

/** Daemon -> browser: a batch of daemon-interior latency attributions. */
export interface PerfTimingMessage {
  readonly kind: 'perf_timing';
  readonly batchSeq: number;
  readonly inputAttributedTotal: number;
  readonly inputDroppedTotal: number;
  readonly inputSkippedTotal: number;
  /** Inputs still awaiting an attributable authoritative display send. */
  readonly pendingInputs: number;
  readonly displayAttributedTotal: number;
  readonly displayDroppedTotal: number;
  readonly observationEpoch: number;
  readonly records: readonly PerfTimingRecord[];
}

/** Cumulative refusals of one traffic class at one egress hop, modular u32. */
export interface EgressRefusals {
  /** Refused for aggregate credit, or bulk yielding to queued interactive work. */
  readonly blocked: number;
  /** Refused by the shared pacer. */
  readonly paced: number;
  /** Closed waits: first refusal decision to the next admitted packet. */
  readonly waitedUs: number;
}

/** Profiling-only model gauges and modular counters within one path epoch. */
export interface EgressModelSample {
  readonly epoch: number;
  readonly bw: number;
  readonly rtpropUs: number;
  readonly pacingRate: number;
  readonly bulkCap: number;
  readonly quantum: number;
  readonly phase: number;
  readonly probesGated: number;
  readonly probesAborted: number;
  readonly interactiveInProbe: number;
  readonly queueGrowthCuts: number;
  readonly lossRounds: number;
  readonly ceRounds: number;
  readonly probeRtts: number;
}

/**
 * Daemon -> browser: where packets waited at the two egress hops Merkur owns.
 * The daemon's aggregate group on its primary carrier, and (on the relay path)
 * the edge's browser-facing group and daemon-to-browser datagram residence
 * from its latest quote. Counters are cumulative and modular u32 within one
 * identity per hop, so consumers difference consecutive snapshots of the same
 * identity; a changed identity is a new counter series.
 */
export interface PerfEgressMessage {
  readonly kind: 'perf_egress';
  readonly observationEpoch: number;
  /** The daemon group counted below; zero before one exists. */
  readonly daemonGroup: number;
  /** The browser attachment whose edge quote carried the edge counters; zero before any. */
  readonly edgeAttachment: number;
  readonly daemonInteractive: EgressRefusals;
  readonly daemonBulk: EgressRefusals;
  readonly edgeInteractive: EgressRefusals;
  readonly edgeBulk: EgressRefusals;
  /** Bucket 0 is below 16 us, bucket i covers [2^(i+3), 2^(i+4)) us, the last is open. */
  readonly edgeForwardResidence: readonly number[];
  readonly daemonModel: EgressModelSample;
  readonly edgeModel: EgressModelSample;
}

/** Browser -> daemon: toggle daemon-interior attribution. */
export interface PerfEnableMessage {
  readonly kind: 'perf_enable';
  readonly enabled: boolean;
  readonly observationEpoch: number;
}

/** Browser -> daemon: request a measurement-only authoritative-grid observation. */
export interface PerfGridConvergenceRequestMessage {
  readonly kind: 'perf_grid_convergence_request';
  readonly observationEpoch: number;
  readonly probeId: number;
}

/**
 * Daemon -> browser: one bounded observation of the authoritative grid.
 *
 * `rowHashes` is a dense `(lo, hi)` u32 pair per row, matching term-wasm's
 * allocation-free row-hash vector. This message is evidence only: it never
 * gates display application, ACKs, repair, or browser presentation.
 */
export interface PerfGridConvergenceResponseMessage {
  readonly kind: 'perf_grid_convergence_response';
  readonly observationEpoch: number;
  readonly probeId: number;
  readonly generation: number;
  readonly lastAdmittedDisplaySeq: number;
  readonly cols: number;
  readonly rows: number;
  readonly rowHashes: Uint32Array;
}

/** Every frame this package encodes. */
export type Message =
  | TransportHintMessage
  | DisplayReceiverProfileMessage
  | InputAckMessage
  | PerfEnableMessage
  | PerfGridConvergenceRequestMessage;

export function encode(message: Message): ArrayBuffer {
  switch (message.kind) {
    case 'transport_hint':
      return encodeTransportHint(message);
    case 'display_receiver_profile':
      return encodeDisplayReceiverProfile(message);
    case 'input_ack':
      return encodeInputAck(message.seq);
    case 'perf_enable':
      return encodePerfEnable(message);
    case 'perf_grid_convergence_request':
      return encodePerfGridConvergenceRequest(message);
  }
}

export function encodeHeartbeatPingFrame(timestamp: bigint): ArrayBuffer {
  validateUint64(timestamp, 'timestamp');
  const frame = createKnownFrame(MESSAGE_TYPE_HEARTBEAT_PING, UINT64_BYTES);
  writeU64BE(frame, HEADER_SIZE_BYTES, timestamp);
  return frame.buffer;
}

export function encodeHeartbeatPongFrame(timestamp: bigint, monotonicUs: bigint): ArrayBuffer {
  validateUint64(timestamp, 'heartbeat timestamp');
  validateUint64(monotonicUs, 'monotonic clock');
  const frame = createKnownFrame(MESSAGE_TYPE_HEARTBEAT_PONG, 2 * UINT64_BYTES);
  writeU64BE(frame, HEADER_SIZE_BYTES, timestamp);
  writeU64BE(frame, HEADER_SIZE_BYTES + UINT64_BYTES, monotonicUs);
  return frame.buffer;
}

/** Words in the display-ACK received bitmap. */
const DISPLAY_ACK_MASK_WORDS = 4;
/**
 * Display-ACK payload: generation, largest applied seq, received bitmap words,
 * FEC-recovered bitmap words using the same anchor, then the cumulative
 * per-generation display grant.
 *
 * The same layout is used by the sealed `displayAck` datagram (which carries the
 * bare payload with no message header) and by the reliable ctrl-lane backstop
 * frame, so the daemon has one parser for both.
 */
export const DISPLAY_ACK_PAYLOAD_BYTES = UINT32_BYTES * (3 + DISPLAY_ACK_MASK_WORDS * 2);

function encodeInputAck(seq: number): ArrayBuffer {
  validateUint32(seq, 'input ack seq');
  const frame = createKnownFrame(MESSAGE_TYPE_INPUT_ACK, INPUT_ACK_PAYLOAD_BYTES);
  writeU32BE(frame, HEADER_SIZE_BYTES, seq);
  return frame.buffer;
}

function encodePerfEnable(message: PerfEnableMessage): ArrayBuffer {
  validateUint32(message.observationEpoch, 'perf observation epoch');
  if (message.observationEpoch === 0) {
    throw new RangeError('perf observation epoch must be non-zero');
  }
  const frame = createKnownFrame(MESSAGE_TYPE_PERF_ENABLE, 5);
  frame[HEADER_SIZE_BYTES] = message.enabled ? 1 : 0;
  writeU32BE(frame, HEADER_SIZE_BYTES + 1, message.observationEpoch);
  return frame.buffer;
}

function encodePerfGridConvergenceRequest(message: PerfGridConvergenceRequestMessage): ArrayBuffer {
  validateUint32(message.observationEpoch, 'perf grid convergence observation epoch');
  validateUint32(message.probeId, 'perf grid convergence probe id');
  if (message.observationEpoch === 0 || message.probeId === 0) {
    throw new RangeError('perf grid convergence identifiers must be non-zero');
  }
  const frame = createKnownFrame(
    MESSAGE_TYPE_PERF_GRID_CONVERGENCE_REQUEST,
    PERF_GRID_CONVERGENCE_REQUEST_PAYLOAD_BYTES,
  );
  writeU32BE(frame, HEADER_SIZE_BYTES, message.observationEpoch);
  writeU32BE(frame, HEADER_SIZE_BYTES + UINT32_BYTES, message.probeId);
  return frame.buffer;
}

function encodeTransportHint(message: TransportHintMessage): ArrayBuffer {
  validateUint8(message.profile, 'profile');
  validateUint16(message.chunkBytes, 'chunkBytes');
  validateUint32(message.snapshotBytes, 'snapshotBytes');
  validateUint16(message.receiveQueueDatagrams, 'receiveQueueDatagrams');
  validateUint16(message.presentationPeriodUs, 'presentationPeriodUs');
  const frame = createKnownFrame(MESSAGE_TYPE_TRANSPORT_HINT, TRANSPORT_HINT_BYTES);
  const offset = HEADER_SIZE_BYTES;
  frame[offset] = message.profile;
  writeU16BE(frame, offset + 1, message.chunkBytes);
  writeU32BE(frame, offset + 3, message.snapshotBytes);
  writeU16BE(frame, offset + 7, message.receiveQueueDatagrams);
  writeU16BE(frame, offset + 9, message.presentationPeriodUs);
  return frame.buffer;
}

function encodeDisplayReceiverProfile(message: DisplayReceiverProfileMessage): ArrayBuffer {
  validateUint32(message.sampleRevision, 'sampleRevision');
  validateUint32(message.ageMs, 'ageMs');
  validateUint32(message.serviceDebtUs, 'serviceDebtUs');
  if (message.buckets.length > DISPLAY_RECEIVER_PROFILE_MAX_BUCKETS) {
    throw new Error('display receiver profile has too many buckets');
  }
  const payloadBytes =
    DISPLAY_RECEIVER_PROFILE_HEADER_BYTES +
    message.buckets.length * DISPLAY_RECEIVER_PROFILE_BUCKET_BYTES;
  const frame = createKnownFrame(MESSAGE_TYPE_DISPLAY_RECEIVER_PROFILE, payloadBytes);
  let offset = HEADER_SIZE_BYTES;
  writeU32BE(frame, offset, message.sampleRevision);
  writeU32BE(frame, offset + 4, message.ageMs);
  writeU32BE(frame, offset + 8, message.serviceDebtUs);
  frame[offset + 12] = message.buckets.length;
  offset += DISPLAY_RECEIVER_PROFILE_HEADER_BYTES;
  for (const bucket of message.buckets) {
    validateUint8(bucket.dictionaryClass, 'dictionaryClass');
    validateUint8(bucket.sizeClass, 'sizeClass');
    validateUint8(bucket.ratioClass, 'ratioClass');
    validateUint8(bucket.sampleCount, 'sampleCount');
    validateUint32(bucket.wireRatioPpm, 'wireRatioPpm');
    validateUint32(bucket.meanUs, 'meanUs');
    validateUint32(bucket.varianceUs2, 'varianceUs2');
    validateUint32(bucket.upperUs, 'upperUs');
    frame[offset] = bucket.dictionaryClass;
    frame[offset + 1] = bucket.sizeClass;
    frame[offset + 2] = bucket.ratioClass;
    frame[offset + 3] = bucket.sampleCount;
    writeU32BE(frame, offset + 4, bucket.wireRatioPpm);
    writeU32BE(frame, offset + 8, bucket.meanUs);
    writeU32BE(frame, offset + 12, bucket.varianceUs2);
    writeU32BE(frame, offset + 16, bucket.upperUs);
    offset += DISPLAY_RECEIVER_PROFILE_BUCKET_BYTES;
  }
  return frame.buffer;
}

/** A frame with its 4-byte proto header (type, 24-bit payload length) written. */
function createKnownFrame(frameType: number, payloadLength: number): Uint8Array<ArrayBuffer> {
  if (payloadLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Payload too large: ${payloadLength} bytes exceeds ${MAX_PAYLOAD_BYTES}`);
  }
  const frame = new Uint8Array(new ArrayBuffer(HEADER_SIZE_BYTES + payloadLength));
  frame[0] = frameType;
  frame[1] = (payloadLength >> LENGTH_HIGH_SHIFT) & LENGTH_MASK;
  frame[2] = (payloadLength >> LENGTH_MIDDLE_SHIFT) & LENGTH_MASK;
  frame[3] = payloadLength & LENGTH_MASK;
  return frame;
}

function writeU16BE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 8) & LENGTH_MASK;
  buffer[offset + 1] = value & LENGTH_MASK;
}

function writeU32BE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 24) & LENGTH_MASK;
  buffer[offset + 1] = (value >>> 16) & LENGTH_MASK;
  buffer[offset + 2] = (value >>> 8) & LENGTH_MASK;
  buffer[offset + 3] = value & LENGTH_MASK;
}

function writeU64BE(buffer: Uint8Array, offset: number, value: bigint): void {
  buffer[offset] = Number((value >> 56n) & 0xffn);
  buffer[offset + 1] = Number((value >> 48n) & 0xffn);
  buffer[offset + 2] = Number((value >> 40n) & 0xffn);
  buffer[offset + 3] = Number((value >> 32n) & 0xffn);
  buffer[offset + 4] = Number((value >> 24n) & 0xffn);
  buffer[offset + 5] = Number((value >> 16n) & 0xffn);
  buffer[offset + 6] = Number((value >> 8n) & 0xffn);
  buffer[offset + 7] = Number(value & 0xffn);
}

function validateUint8(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${fieldName} must be a uint8`);
  }
}

function validateUint16(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${fieldName} must be a uint16`);
  }
}

function validateUint32(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
    throw new Error(`${fieldName} must be a uint32`);
  }
}

function validateUint64(value: bigint, fieldName: string): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${fieldName} must be a uint64`);
  }
}
