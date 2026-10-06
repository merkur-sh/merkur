import type { EgressModelSample } from '@merkur/protocol';
import {
  RECOVERY_CANCEL_INITIATORS,
  RECOVERY_END_REASONS,
  RECOVERY_NATIVE_OUTCOMES,
  RECOVERY_PHASES,
  RECOVERY_TRIGGERS,
  type RecoveryOutcome,
} from '@merkur/shared/recovery-outcome';
import type { PerfRecordView, PerfRingWriter } from './perf-ring';
import type { PerfStringInterner, PerfStringResolver } from './perf-string-table';
import type {
  BrowserDisplayIngressRoute,
  BrowserDisplayIoStage,
  GraphicsAssetPhase,
  PredictionGateSuppressionReason,
  TerminalDisplayResyncReason,
  TerminalFrameCompletionDisposition,
  TerminalFrameCompletionModeLabel,
  TerminalPerfEvent,
  TerminalPresentationCommitReason,
  TerminalPresentationDiscardReason,
  TerminalPresentationMeasurementPhase,
  TerminalPresentationMeasurementPurpose,
  TerminalRenderGate,
  TerminalStartupMilestone,
} from './terminal-latency';
import {
  EDGE_FORWARD_RESIDENCE_BUCKET_COUNT,
  TERMINAL_EGRESS_HOPS,
  type TerminalEgressHop,
  type TerminalEgressRefusals,
} from './terminal-latency';

/**
 * Encodes `TerminalPerfEvent` into fixed ring slots and back.
 *
 * # Why every field fits in a number
 *
 * Each event kind gets a fixed slot assignment, so the encoder writes only the
 * slots it uses and the decoder reads only the slots it expects —
 * `PerfRingWriter.begin` has already zeroed the rest. Every enum in the event
 * model is a closed union, so each becomes a small integer here; the tables
 * below are the single definition of those mappings and are asserted exhaustive
 * by the codec tests.
 *
 * The only genuinely free-form values are `deviceId`, `merkurSessionId` and a
 * transport disconnect `reason`. Those are interned to integer ids: the writer
 * hands a novel string to its `publishString` callback exactly once, out of
 * band, and every record thereafter carries the id. In steady state no string
 * ever crosses a thread boundary, and the ring stays numbers-only.
 *
 * # Slot discipline
 *
 * Slot assignments are append-only in spirit but not in contract — there is one
 * version of Merkur, so a layout change is a hard cutover and both sides move
 * together. What must never happen is two event kinds disagreeing about a slot
 * they both use, which is why the shared render slots are named constants
 * rather than repeated literals.
 */

export const PERF_KIND_STARTUP_MILESTONE = 1;
export const PERF_KIND_SESSION_START = 2;
export const PERF_KIND_INPUT_QUEUED = 3;
export const PERF_KIND_KEYBOARD_COMMIT = 4;
export const PERF_KIND_INPUT_SENT = 5;
export const PERF_KIND_INPUT_ACK = 6;
export const PERF_KIND_PREDICTION_QUEUED = 7;
export const PERF_KIND_PREDICTION_APPLIED = 8;
export const PERF_KIND_PREDICTION_SUPPRESSED = 10;
export const PERF_KIND_TRANSPORT_STATE = 11;
export const PERF_KIND_PREDICTION_GATE = 12;
export const PERF_KIND_DISPLAY_RECEIVED = 13;
export const PERF_KIND_WORKER_DISPLAY_QUEUED = 14;
export const PERF_KIND_WORKER_DISPLAY_APPLIED = 15;
export const PERF_KIND_RENDER_START = 16;
export const PERF_KIND_RENDER_END = 17;
export const PERF_KIND_FRAME_COMPLETE = 18;
export const PERF_KIND_PREDICTION_REJECTED = 19;
export const PERF_KIND_DAEMON_TIMING = 20;
export const PERF_KIND_DISPLAY_RESYNC = 21;
export const PERF_KIND_SESSION_BOUND = 22;
export const PERF_KIND_CARRIER_RECOVERY = 23;
export const PERF_KIND_PRESENTATION_COMMIT = 24;
export const PERF_KIND_PRESENTATION_MEASUREMENT_BOUNDARY = 25;
export const PERF_KIND_DISPLAY_PUMP_COMPLETE = 26;
export const PERF_KIND_DAEMON_TIMING_STATUS = 27;
export const PERF_KIND_PRESENTATION_TRANSACTION_DISCARDED = 28;
export const PERF_KIND_PRESENTATION_EPOCH_BOUNDARY = 29;
export const PERF_KIND_MAIN_FRAME_CADENCE = 30;
export const PERF_KIND_MAIN_LONG_TASK = 31;
export const PERF_KIND_BROWSER_DISPLAY_IO = 32;
export const PERF_KIND_DISPLAY_RING_MEASUREMENT_BOUNDARY = 33;
export const PERF_KIND_CURSOR_STEP = 34;
export const PERF_KIND_CURSOR_SHAPE = 35;
export const PERF_KIND_GRAPHICS_ASSET = 36;
export const PERF_KIND_TRANSPORT_EGRESS = 37;
export const PERF_KIND_EDGE_FORWARD_RESIDENCE = 38;
export const PERF_KIND_EGRESS_MODEL = 39;
export const PERF_KIND_CARRIER_CLOSED = 40;
export const PERF_KIND_RECOVERY_OUTCOME = 41;
export const PERF_KIND_PRESENTATION_GATE = 42;
export const PERF_KIND_FIRST_DISPLAY_GATE = 43;

/** Slot 0 of the u32 block is the kind tag, written by `begin`. */
const U32_KIND = 0;
/** f64 slot 0 is `atMs` on every kind without exception. */
const F64_AT_MS = 0;

/** Shared by the three render kinds; they must not disagree. */
const U32_RENDER_SEQ = 1;
const U32_DISPLAY_INPUT_SEQ = 2;
const U32_PREDICTION_INPUT_SEQ = 3;
const U32_QUEUED_DISPLAY_FRAMES = 4;

/**
 * `visiblePredictionInputSeqs` is carried as a base sequence plus a bitmap over
 * the sequences that follow it, not as a list.
 *
 * A list costs one slot per sequence, which capped a frame at eight visible
 * predictions — reachable on any link where a keystroke's round trip outlasts
 * eight more keystrokes, so 25 ms of one-way delay truncated 69 of 275 frames
 * and cost the exact-prediction metric its whole run. Eight slots of bitmap
 * carry a 256-sequence window instead, which is the same bound the terminal
 * worker and the analyzer already impose on the set, so the record is no longer
 * the narrowest part of the path.
 *
 * Truncation now means one thing only: the visible sequences did not fit inside
 * one window. That is a real gap, and downstream still refuses to compute
 * coverage from a frame carrying it.
 */
export const PERF_VISIBLE_PREDICTION_MASK_WORDS = 8;
export const PERF_VISIBLE_PREDICTION_WINDOW = PERF_VISIBLE_PREDICTION_MASK_WORDS * 32;
const U32_VISIBLE_MASK_BASE = 8;
const U32_VISIBLE_BASE_SEQ = 7;
const U32_RENDER_FLAGS = 6;

/**
 * Scratch for the encoder's mask, allocated once.
 *
 * `writeVisiblePredictions` runs on the terminal worker's per-frame path, so it
 * builds the mask here and stores it into the ring rather than allocating a
 * typed array per frame.
 */
const visibleMaskScratch = new Uint32Array(PERF_VISIBLE_PREDICTION_MASK_WORDS);
// render_start has one free f64 slot but nine unused u32 slots. Preserve its
// 128-byte stride: the second exact duration occupies u32 words 8/9, not the
// overlapping f64 slot 8 (which would overwrite the kind and render id).
const renderWaitScratch = new Float64Array(1);
const renderWaitWords = new Uint32Array(renderWaitScratch.buffer);

const FLAG_ATLAS_UPLOADED = 1 << 0;
const FLAG_DRAINED_DISPLAY = 1 << 1;
const FLAG_VISIBLE_TRUNCATED = 1 << 2;
// Biased two-bit enum in the existing flags word: absent/invalid codes fail
// closed, with no ring-stride growth or per-completion allocation.
const COMPLETION_DISPOSITION_SHIFT = 3;
const COMPLETION_DISPOSITIONS: readonly TerminalFrameCompletionDisposition[] = [
  'latest-submitted',
  'superseded',
  'invalidated',
];

const DISPLAY_FLAG_PRESENTATION_COHERENT = 1 << 0;
const DISPLAY_FLAG_PRESENTATION_END = 1 << 1;
const DISPLAY_FLAG_FEC_RECOVERED = 1 << 2;
const DISPLAY_VISUAL_MUTATION_UNKNOWN = 0;
const DISPLAY_VISUAL_MUTATION_UNCHANGED = 1;
const DISPLAY_VISUAL_MUTATION_CHANGED = 2;
const U32_DISPLAY_PRESENTATION_MEMBER = 14;
const U32_DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID = 15;

const PRESENTATION_FLAG_COHERENT = 1 << 0;
const PRESENTATION_FLAG_END_SEEN = 1 << 1;
const PRESENTATION_FLAG_AUTHORITATIVE_VISUAL_CHANGE = 1 << 2;

const STARTUP_MILESTONES: readonly TerminalStartupMilestone[] = [
  'device_selected',
  'terminal_mount_requested',
  'worker_ready',
  'terminal_view_presented',
  'transport_start',
  'transport_connected',
  'first_display_applied',
  'first_display_visible',
];

const SUPPRESSION_REASONS: readonly PredictionGateSuppressionReason[] = [
  'mode_uninitialized',
  'no_prompt_grant',
  'unsafe_mode',
  'unknown_mode',
];

const RENDER_GATES: readonly TerminalRenderGate[] = [
  'immediate',
  'fence',
  'opportunity',
  'fence-and-opportunity',
];

const COMPLETION_MODES: readonly TerminalFrameCompletionModeLabel[] = ['gpu-queue', 'none'];

const PRESENTATION_COMMIT_REASONS: readonly TerminalPresentationCommitReason[] = [
  'urgent',
  'group-end-vsync',
  'deadline-vsync',
  'deadline-timer',
  'recovery-release',
  'repair-target-satisfied',
  'repair-deadline-expired',
  'safety-revocation',
  'membership-complete',
  'closure-complete',
  'paced-complete',
];

const PRESENTATION_MEASUREMENT_PHASES: readonly TerminalPresentationMeasurementPhase[] = [
  'start',
  'end',
];
const PRESENTATION_MEASUREMENT_PURPOSES: readonly TerminalPresentationMeasurementPurpose[] = [
  'coherent-redraw',
  'isolated-interactive',
  'streaming',
];

/** Indexed by the ClientViewer's discard reason word (`viewer::receive::Discard`). */
export const PRESENTATION_DISCARD_REASONS: readonly TerminalPresentationDiscardReason[] = [
  'resync',
  'epoch-reset',
  'teardown',
];

const DISPLAY_KINDS = ['display_snapshot', 'display_delta'] as const;
const BROWSER_DISPLAY_IO_STAGES: readonly BrowserDisplayIoStage[] = [
  'transport_ingress',
  'terminal_apply',
  'transport_fec_ingress',
  'terminal_fec',
];
const BROWSER_DISPLAY_INGRESS_ROUTES: readonly BrowserDisplayIngressRoute[] = [
  'direct-datagram',
  'direct-reliable',
  'relay-datagram',
  'relay-reliable',
];
const TRANSPORT_STATES = [
  'connected',
  'disconnected',
  'signaling_connected',
  'signaling_reconnecting',
] as const;
/**
 * Ordered to match `TerminalDisplayResyncReason`. A closed table rather than an
 * interned string on purpose: several of the worker's diag strings interpolate a
 * WASM error, and the ring must not become a route for one.
 */
/**
 * Phases of one carrier recovery, in the order they occur.
 *
 * `dial_started` and `promoted` are deliberately distinct. Opening a
 * replacement carrier is expensive and harmless; seating it evicts the
 * incumbent. The whole point of the recovery design is that the first happens
 * on evidence and the second waits for proof, so a trace that could not tell
 * them apart could not show whether that separation is working.
 *
 * `incumbent_failed` is the second unanswered round trip, one RTO after the
 * lapse that started the dial. It is the phase that separates the two strikes:
 * without it a trace shows only how many deadlines lapsed, which is the number
 * that was never evidence of anything, and cannot say how many of them were
 * followed by a carrier that had genuinely stopped answering.
 */
const CARRIER_RECOVERY_PHASES = [
  'dial_started',
  'incumbent_failed',
  'promoted',
  'rebind_sent',
  'restored',
  // The incumbent was given up with nothing to seat: its replacement dial
  // failed too. Distinct from `promoted` because the trace has to say whether
  // recovery moved onto a proven path or fell back to the reconnect schedule.
  'evicted',
  // How each speculative dial ended. Without these a lapse's dial showed no
  // outcome, and "retired by incumbent progress", "failed" and "ready" read the
  // same: the next row was another dial, seconds later.
  'standby_ready',
  'dial_failed',
  'dial_retired',
  // The first input acknowledgement after a `dial_started`: the exact end of
  // the stall that started it, carrying that dial's reason.
  'first_ack',
] as const;

/**
 * Why a recovery phase happened. A closed table rather than an interned string,
 * for the same reason `DISPLAY_RESYNC_REASONS` is one: the ring must not become
 * a route for arbitrary text, and these are a fixed vocabulary the recovery
 * policy already speaks.
 */
const CARRIER_RECOVERY_REASONS = [
  'pong-deadline-lapsed',
  'connectivity-hint',
  'standby-proved-path',
  'edge-unreachable',
  'recovery-attempt',
] as const;

export type CarrierRecoveryPhase = (typeof CARRIER_RECOVERY_PHASES)[number];
export type CarrierRecoveryReason = (typeof CARRIER_RECOVERY_REASONS)[number];

/** Which of a session's three edge connections closed. */
const CARRIER_LANES = ['signaling', 'interactive', 'bulk'] as const;
/**
 * How it closed: `clean` is a close the protocol completed (a code, from
 * either side); `session` and `stream` are a `WebTransportError` by its
 * source; `other` is a rejection that is not one.
 */
const CARRIER_CLOSE_SOURCES = ['clean', 'session', 'stream', 'other'] as const;
export type CarrierLane = (typeof CARRIER_LANES)[number];
export type CarrierCloseSource = (typeof CARRIER_CLOSE_SOURCES)[number];

/**
 * `navigator.connection.type` and `.effectiveType`, where the browser exposes
 * them (`type` on Chromium for Android and ChromeOS, `effectiveType` on
 * Chromium everywhere), and `unavailable` where it does not.
 */
const BROWSER_NETWORK_TYPES = [
  'unavailable',
  'bluetooth',
  'cellular',
  'ethernet',
  'mixed',
  'none',
  'other',
  'unknown',
  'wifi',
  'wimax',
] as const;
const BROWSER_EFFECTIVE_TYPES = ['unavailable', 'slow-2g', '2g', '3g', '4g'] as const;
export type BrowserNetworkType = (typeof BROWSER_NETWORK_TYPES)[number];
export type BrowserEffectiveType = (typeof BROWSER_EFFECTIVE_TYPES)[number];

/** Narrow a browser-supplied string to the closed set, or `unavailable`. */
export function browserNetworkType(value: unknown): BrowserNetworkType {
  return BROWSER_NETWORK_TYPES.find((member) => member === value) ?? 'unavailable';
}

export function browserEffectiveType(value: unknown): BrowserEffectiveType {
  return BROWSER_EFFECTIVE_TYPES.find((member) => member === value) ?? 'unavailable';
}

/**
 * One graphics tile job's transitions, success path first. A job that retires
 * without its tile passes through at least one of the failure phases, and its
 * `retired` record carries the failed flag.
 */
const GRAPHICS_ASSET_PHASES: readonly GraphicsAssetPhase[] = [
  'demanded',
  'requested',
  'first_byte',
  'fin',
  'published',
  'consumed',
  'retired',
  'refused',
  'unavailable',
  'cancelled',
  'interrupted',
  'resumed',
];

const DISPLAY_RESYNC_REASONS: readonly TerminalDisplayResyncReason[] = [
  'queue_admission',
  'frame_parse_failed',
  'frame_stage_failed',
  'ahead_delta_buffer_overflow',
  'stale_generation_recovery',
  'pending_frame_metadata',
  'pending_frame_bytes',
  'pending_frame_rows',
  'pending_frame_mismatch',
  'pending_frame_evicted',
  'pending_assemblies_overflow',
  'frame_validation_rejected',
  'apply_rejected',
  'hash_digest_generation_ahead',
  'profiling_harness',
];

const GATE_STATES = ['learning', 'visible', 'suppressed'] as const;

/** Exported for the exhaustiveness assertions in the codec tests. */
export const PERF_ENUM_TABLES = {
  startupMilestones: STARTUP_MILESTONES,
  suppressionReasons: SUPPRESSION_REASONS,
  renderGates: RENDER_GATES,
  completionModes: COMPLETION_MODES,
  completionDispositions: COMPLETION_DISPOSITIONS,
  presentationCommitReasons: PRESENTATION_COMMIT_REASONS,
  presentationMeasurementPhases: PRESENTATION_MEASUREMENT_PHASES,
  presentationMeasurementPurposes: PRESENTATION_MEASUREMENT_PURPOSES,
  presentationDiscardReasons: PRESENTATION_DISCARD_REASONS,
  displayKinds: DISPLAY_KINDS,
  browserDisplayIoStages: BROWSER_DISPLAY_IO_STAGES,
  browserDisplayIngressRoutes: BROWSER_DISPLAY_INGRESS_ROUTES,
  displayResyncReasons: DISPLAY_RESYNC_REASONS,
  transportStates: TRANSPORT_STATES,
  carrierRecoveryPhases: CARRIER_RECOVERY_PHASES,
  carrierRecoveryReasons: CARRIER_RECOVERY_REASONS,
  graphicsAssetPhases: GRAPHICS_ASSET_PHASES,
  gateStates: GATE_STATES,
  egressHops: TERMINAL_EGRESS_HOPS,
} as const;

function indexOf<T extends string>(table: readonly T[], value: T): number {
  const index = table.indexOf(value);
  // A closed union that is not in its table means the union grew and this file
  // did not. Encoding it as 0 would silently relabel it as the first member.
  return index < 0 ? -1 : index;
}

function memberAt<T extends string>(table: readonly T[], index: number): T | null {
  return table[index] ?? null;
}

function observedU32(value: number): number | null {
  return value === U32_UNOBSERVED ? null : value;
}

/**
 * Allocation-free emitters — the real hot path.
 *
 * Positional arguments rather than an event object on purpose. An object
 * literal per event is ~1200 short-lived allocations/sec of young-gen churn,
 * which buys more frequent scavenges in a renderer where a minor GC pause is
 * exactly the thing being measured. These take primitives, write slots, and
 * allocate nothing.
 *
 * `encodePerfEvent` below is a thin dispatcher over these, so the codec
 * round-trip tests exercise the same slot writes the hot path uses rather than
 * a parallel implementation that could drift from it.
 */

/**
 * Trace and span id, packed as six unsigned 32-bit words rather than interned.
 *
 * A `traceparent` is fixed-width hex — 16 bytes of trace id and 8 of span id — so it is
 * *numbers*, and the ring's rule is that records carry numbers. Interning it would be
 * actively wrong: the string table is 64 slots with no eviction, sized for the handful of
 * genuinely free-form values (a session id, a device id, a disconnect reason), and a fresh
 * trace is minted for **every connect attempt**. Interning would therefore exhaust the table
 * after 64 reconnects and start dropping startup milestones for good.
 */
const U32_TRACE_ID_BASE = 4;
const U32_SPAN_ID_BASE = 8;
const TRACE_ID_WORDS = 4;
const SPAN_ID_WORDS = 2;
const HEX_PER_WORD = 8;

function writeHexWords(writer: PerfRingWriter, base: number, hex: string, words: number): void {
  for (let index = 0; index < words; index += 1) {
    const slice = hex.slice(index * HEX_PER_WORD, (index + 1) * HEX_PER_WORD);
    writer.u32(base + index, Number.parseInt(slice, 16) >>> 0);
  }
}

function readHexWords(record: PerfRecordView, base: number, words: number): string {
  let hex = '';
  for (let index = 0; index < words; index += 1) {
    hex += record
      .u32(base + index)
      .toString(16)
      .padStart(HEX_PER_WORD, '0');
  }
  return hex;
}

export function emitStartupMilestone(
  writer: PerfRingWriter,
  atMs: number,
  attemptId: number,
  deviceIdInternId: number,
  milestone: TerminalStartupMilestone,
  elapsedMs: number,
  traceId: string,
  spanId: string,
): boolean {
  const index = indexOf(STARTUP_MILESTONES, milestone);
  if (index < 0) return false;
  if (traceId.length !== TRACE_ID_WORDS * HEX_PER_WORD) return false;
  if (spanId.length !== SPAN_ID_WORDS * HEX_PER_WORD) return false;
  writer.begin(PERF_KIND_STARTUP_MILESTONE);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, elapsedMs);
  writer.u32(1, attemptId);
  writer.u32(2, index);
  writer.u32(3, deviceIdInternId);
  writeHexWords(writer, U32_TRACE_ID_BASE, traceId, TRACE_ID_WORDS);
  writeHexWords(writer, U32_SPAN_ID_BASE, spanId, SPAN_ID_WORDS);
  writer.commit();
  return true;
}

export function emitSessionStart(writer: PerfRingWriter, atMs: number): void {
  writer.begin(PERF_KIND_SESSION_START);
  writer.f64(F64_AT_MS, atMs);
  writer.commit();
}

export function emitSessionBound(
  writer: PerfRingWriter,
  atMs: number,
  merkurSessionIdInternId: number,
  networkType: BrowserNetworkType,
  effectiveType: BrowserEffectiveType,
): void {
  writer.begin(PERF_KIND_SESSION_BOUND);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, merkurSessionIdInternId);
  writer.u32(2, indexOf(BROWSER_NETWORK_TYPES, networkType));
  writer.u32(3, indexOf(BROWSER_EFFECTIVE_TYPES, effectiveType));
  writer.commit();
}

/**
 * One edge connection of this session closed: which, how, and after how long.
 * Written from the transport worker as the close settles, so the row survives a
 * carrier that is never coming back — telemetry ships over HTTPS.
 */
export function emitCarrierClosed(
  writer: PerfRingWriter,
  atMs: number,
  lane: CarrierLane,
  source: CarrierCloseSource,
  closeCode: number,
  lifetimeMs: number,
): void {
  writer.begin(PERF_KIND_CARRIER_CLOSED);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, lifetimeMs);
  writer.u32(1, indexOf(CARRIER_LANES, lane));
  writer.u32(2, indexOf(CARRIER_CLOSE_SOURCES, source));
  writer.u32(3, closeCode >>> 0);
  writer.commit();
}

export function emitInputQueued(
  writer: PerfRingWriter,
  atMs: number,
  admittedAtMs: number,
  inputSeq: number,
  byteLength: number,
): void {
  writer.begin(PERF_KIND_INPUT_QUEUED);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, admittedAtMs);
  writer.u32(1, inputSeq);
  writer.u32(2, byteLength);
  writer.commit();
}

export function emitKeyboardCommit(
  writer: PerfRingWriter,
  atMs: number,
  touchStartedAtMs: number,
  inputSeq: number,
  repeat: boolean,
): void {
  writer.begin(PERF_KIND_KEYBOARD_COMMIT);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, touchStartedAtMs);
  writer.u32(1, inputSeq);
  writer.u32(2, repeat ? 1 : 0);
  writer.commit();
}

/** The three kinds whose entire payload is one input sequence. */
export function emitInputSeqEvent(
  writer: PerfRingWriter,
  kind:
    | typeof PERF_KIND_INPUT_SENT
    | typeof PERF_KIND_PREDICTION_QUEUED
    | typeof PERF_KIND_PREDICTION_APPLIED,
  atMs: number,
  inputSeq: number,
): void {
  writer.begin(kind);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, inputSeq);
  writer.commit();
}

/**
 * The ack, plus the path RTT floor that splits its round trip into a network
 * and a non-network half. See the `input_ack` event for why the floor and not
 * the live sample.
 *
 * The extra terms are stores into slots the fixed-size record already reserves,
 * so this costs the same as the seq-only emitter it left: no allocation, no
 * change in record size, one more f64 and one more u32 per ack.
 */
export function emitInputAck(
  writer: PerfRingWriter,
  atMs: number,
  inputSeq: number,
  networkRttMs: number | null,
): void {
  writer.begin(PERF_KIND_INPUT_ACK);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, inputSeq);
  // A flag rather than a sentinel: 0 is a legitimate floor on a loopback path,
  // and a sentinel that can occur is how a null becomes a measurement of zero.
  writer.u32(2, networkRttMs === null ? 1 : 0);
  writer.f64(1, networkRttMs ?? 0);
  writer.commit();
}

/**
 * An acknowledgment term the daemon never observed. Unreachable as a duration
 * (71 minutes), so unlike zero it cannot turn a missing boundary into a value.
 */
const U32_UNOBSERVED = 0xffff_ffff;

export function emitDaemonTiming(
  writer: PerfRingWriter,
  atMs: number,
  inputSeq: number,
  recvToPtyUs: number,
  ptyToReadUs: number,
  gridApplyUs: number,
  displayCoalesceUs: number,
  selectCaptureUs: number,
  prepareQueueUs: number,
  encodeUs: number,
  compressionUs: number,
  completionQueueUs: number,
  transportSubmitUs: number,
  writeCompletionUs: number | null,
  ackTransmitUs: number | null,
  ownerCpuUs: number,
  ownerOffCpuUs: number,
  ownerQuinnWaitUs: number,
  ownerRegistryWaitUs: number,
  flushLockWaitUs: number,
  batchSeq: number,
  observationEpoch: number,
): void {
  writer.begin(PERF_KIND_DAEMON_TIMING);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, inputSeq);
  writer.u32(2, recvToPtyUs);
  writer.u32(3, ptyToReadUs);
  writer.u32(4, gridApplyUs);
  writer.u32(5, displayCoalesceUs);
  writer.u32(6, selectCaptureUs);
  writer.u32(7, prepareQueueUs);
  writer.u32(8, encodeUs);
  writer.u32(9, compressionUs);
  writer.u32(10, completionQueueUs);
  writer.u32(11, transportSubmitUs);
  writer.u32(12, batchSeq);
  writer.u32(13, observationEpoch);
  writer.u32(14, writeCompletionUs ?? U32_UNOBSERVED);
  writer.u32(15, ackTransmitUs ?? U32_UNOBSERVED);
  // Every u32 slot is taken; a u32 is exact in an f64 slot.
  writer.f64(1, ownerCpuUs);
  writer.f64(2, ownerOffCpuUs);
  writer.f64(3, ownerQuinnWaitUs);
  writer.f64(4, ownerRegistryWaitUs);
  writer.f64(5, flushLockWaitUs);
  writer.commit();
}

/** One egress hop's cumulative refusals, as the daemon last read them. */
export function emitTransportEgress(
  writer: PerfRingWriter,
  atMs: number,
  observationEpoch: number,
  hop: TerminalEgressHop,
  series: number,
  interactive: TerminalEgressRefusals,
  bulk: TerminalEgressRefusals,
): boolean {
  const index = indexOf(TERMINAL_EGRESS_HOPS, hop);
  if (index < 0) return false;
  writer.begin(PERF_KIND_TRANSPORT_EGRESS);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, index);
  writer.u32(2, interactive.blocked);
  writer.u32(3, interactive.paced);
  writer.u32(4, interactive.waitedUs);
  writer.u32(5, bulk.blocked);
  writer.u32(6, bulk.paced);
  writer.u32(7, bulk.waitedUs);
  writer.u32(8, observationEpoch);
  writer.u32(9, series);
  writer.commit();
  return true;
}

/** Fixed numeric slots; observing the model adds no work when profiling is disabled. */
export function emitEgressModel(
  writer: PerfRingWriter,
  atMs: number,
  observationEpoch: number,
  hop: TerminalEgressHop,
  model: EgressModelSample,
): boolean {
  const index = indexOf(TERMINAL_EGRESS_HOPS, hop);
  if (index < 0) return false;
  writer.begin(PERF_KIND_EGRESS_MODEL);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, index);
  writer.u32(2, observationEpoch);
  writer.u32(3, model.epoch);
  writer.u32(4, model.phase);
  writer.f64(1, model.bw);
  writer.f64(2, model.rtpropUs);
  writer.f64(3, model.pacingRate);
  writer.f64(4, model.bulkCap);
  writer.f64(5, model.quantum);
  writer.u32(5, model.probesGated);
  writer.u32(6, model.probesAborted);
  writer.u32(7, model.interactiveInProbe);
  writer.u32(8, model.queueGrowthCuts);
  writer.u32(9, model.lossRounds);
  writer.u32(10, model.ceRounds);
  writer.u32(11, model.probeRtts);
  writer.commit();
  return true;
}

/** The edge's cumulative residence buckets, one per u32 slot. */
export function emitEdgeForwardResidence(
  writer: PerfRingWriter,
  atMs: number,
  observationEpoch: number,
  series: number,
  buckets: readonly number[],
): boolean {
  if (buckets.length !== EDGE_FORWARD_RESIDENCE_BUCKET_COUNT) return false;
  writer.begin(PERF_KIND_EDGE_FORWARD_RESIDENCE);
  writer.f64(F64_AT_MS, atMs);
  for (let bucket = 0; bucket < EDGE_FORWARD_RESIDENCE_BUCKET_COUNT; bucket += 1) {
    writer.u32(1 + bucket, buckets[bucket] ?? 0);
  }
  writer.u32(1 + EDGE_FORWARD_RESIDENCE_BUCKET_COUNT, observationEpoch);
  writer.u32(2 + EDGE_FORWARD_RESIDENCE_BUCKET_COUNT, series);
  writer.commit();
  return true;
}

/**
 * One reliable daemon-timing batch's exact completeness envelope.
 *
 * This is separate from its records so a zero-record all-skipped/all-dropped
 * tail remains observable, and so cumulative metadata is written once per
 * batch instead of once per record.
 */
export function emitDaemonTimingStatus(
  writer: PerfRingWriter,
  atMs: number,
  batchSeq: number,
  inputAttributedTotal: number,
  inputDroppedTotal: number,
  inputSkippedTotal: number,
  pendingInputs: number,
  displayAttributedTotal: number,
  displayDroppedTotal: number,
  observationEpoch: number,
  recordCount: number,
): void {
  writer.begin(PERF_KIND_DAEMON_TIMING_STATUS);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, batchSeq);
  writer.u32(2, inputAttributedTotal);
  writer.u32(3, inputDroppedTotal);
  writer.u32(4, inputSkippedTotal);
  writer.u32(5, pendingInputs);
  writer.u32(6, displayAttributedTotal);
  writer.u32(7, displayDroppedTotal);
  writer.u32(8, observationEpoch);
  writer.u32(9, recordCount);
  writer.commit();
}

export function emitPredictionRejected(
  writer: PerfRingWriter,
  atMs: number,
  inputSeq: number,
  rejectKind: number,
  rejectCauseCode: number,
): void {
  writer.begin(PERF_KIND_PREDICTION_REJECTED);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, inputSeq);
  writer.u32(2, rejectKind);
  writer.u32(3, rejectCauseCode);
  writer.commit();
}

/**
 * One backwards step of the drawn cursor, from term-wasm's journal.
 *
 * The cause is the model's own code (`CursorCause` in `packages/term-wasm`),
 * resolved to its name only when the row is built, so the record stays
 * numbers-only and the name can never disagree with the code it came from.
 * The two input sequences say where the step sits against the keystrokes: the
 * newest one the model accepted and the newest one authority had covered.
 */
export function emitCursorStep(
  writer: PerfRingWriter,
  atMs: number,
  causeCode: number,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  flags: number,
  ops: number,
  journalSeq: number,
  predictionInputSeq: number,
  displayInputSeq: number,
): void {
  writer.begin(PERF_KIND_CURSOR_STEP);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, causeCode);
  writer.u32(2, ((fromRow & 0xffff) << 16) | (fromCol & 0xffff));
  writer.u32(3, ((toRow & 0xffff) << 16) | (toCol & 0xffff));
  writer.u32(4, flags);
  writer.u32(5, ops);
  writer.u32(6, journalSeq);
  writer.u32(7, predictionInputSeq);
  writer.u32(8, displayInputSeq);
  writer.commit();
}

/**
 * The authoritative cursor changed shape or visibility without moving — the
 * `AuthorityShape` journal record. A frame that hides the cursor mid-line is
 * what a torn repaint looks like from the browser.
 */
export function emitCursorShape(
  writer: PerfRingWriter,
  atMs: number,
  shapeFrom: number,
  visibleFrom: number,
  shapeTo: number,
  visibleTo: number,
  flags: number,
  displaySeq: number,
): void {
  writer.begin(PERF_KIND_CURSOR_SHAPE);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, ((shapeFrom & 0xff) << 8) | (visibleFrom & 0xff));
  writer.u32(2, ((shapeTo & 0xff) << 8) | (visibleTo & 0xff));
  writer.u32(3, flags);
  writer.u32(4, displaySeq);
  writer.commit();
}

export function emitPredictionSuppressed(
  writer: PerfRingWriter,
  atMs: number,
  queuedPredictions: number,
  failedPredictions: number,
  discardedPredictions: number,
): void {
  writer.begin(PERF_KIND_PREDICTION_SUPPRESSED);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, queuedPredictions);
  writer.u32(2, failedPredictions);
  writer.u32(3, discardedPredictions);
  writer.commit();
}

export function emitTransportState(
  writer: PerfRingWriter,
  atMs: number,
  state: (typeof TRANSPORT_STATES)[number],
  reasonInternId: number,
): boolean {
  const index = indexOf(TRANSPORT_STATES, state);
  if (index < 0) return false;
  writer.begin(PERF_KIND_TRANSPORT_STATE);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, index);
  writer.u32(2, reasonInternId);
  writer.commit();
  return true;
}

/**
 * One phase of a carrier recovery, with the evidence that produced it.
 *
 * Written from the transport worker, which owns the decision, so the trace
 * timestamps the decision rather than its downstream effects.
 */
export function emitRecoveryOutcome(
  writer: PerfRingWriter,
  atMs: number,
  outcome: RecoveryOutcome,
): void {
  writer.begin(PERF_KIND_RECOVERY_OUTCOME);
  writer.f64(0, atMs);
  writer.f64(1, outcome.durationMs);
  writer.f64(2, outcome.capabilityRemainingMs);
  writer.f64(3, outcome.backoffDelayMs);
  writer.f64(4, outcome.handshakeAdmissionMs);
  writer.f64(5, outcome.attemptId);
  writer.f64(6, outcome.carrierId);
  writer.f64(7, RECOVERY_TRIGGERS.indexOf(outcome.trigger));
  // UUIDs consume no intern slots, even during an arbitrarily long outage.
  for (const [base, value] of [
    [1, outcome.ownerId],
    [5, outcome.issuanceId],
    [9, outcome.sessionId],
  ] as const) {
    const hex = value.replaceAll('-', '');
    for (let word = 0; word < 4; word += 1)
      writer.u32(base + word, Number.parseInt(hex.slice(word * 8, word * 8 + 8), 16) || 0);
  }
  writer.u32(
    13,
    RECOVERY_PHASES.indexOf(outcome.phase) |
      (RECOVERY_END_REASONS.indexOf(outcome.endReason) << 8) |
      (RECOVERY_CANCEL_INITIATORS.indexOf(outcome.cancellationInitiator) << 16),
  );
  writer.u32(14, outcome.retryIndex);
  writer.u32(
    15,
    RECOVERY_NATIVE_OUTCOMES.indexOf(outcome.signalingOutcome) |
      (RECOVERY_NATIVE_OUTCOMES.indexOf(outcome.interactiveOutcome) << 8) |
      (RECOVERY_NATIVE_OUTCOMES.indexOf(outcome.bulkOutcome) << 16),
  );
  writer.commit();
}

export function emitCarrierRecovery(
  writer: PerfRingWriter,
  atMs: number,
  phase: CarrierRecoveryPhase,
  reason: CarrierRecoveryReason,
): boolean {
  const phaseIndex = indexOf(CARRIER_RECOVERY_PHASES, phase);
  const reasonIndex = indexOf(CARRIER_RECOVERY_REASONS, reason);
  if (phaseIndex < 0 || reasonIndex < 0) return false;
  writer.begin(PERF_KIND_CARRIER_RECOVERY);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, phaseIndex);
  writer.u32(2, reasonIndex);
  writer.commit();
  return true;
}

/**
 * One graphics tile job transition, from the transport worker's asset client:
 * once per transition, never per chunk. `bytes` is the object size at `fin` and
 * zero otherwise; `failed` is set only on a `retired` that ended without a tile.
 */
export function emitGraphicsAsset(
  writer: PerfRingWriter,
  atMs: number,
  phase: GraphicsAssetPhase,
  jobId: number,
  bytes: number,
  failed: boolean,
): boolean {
  const index = indexOf(GRAPHICS_ASSET_PHASES, phase);
  if (index < 0) return false;
  writer.begin(PERF_KIND_GRAPHICS_ASSET);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, index);
  writer.u32(2, jobId);
  writer.u32(3, bytes);
  writer.u32(4, failed ? 1 : 0);
  writer.commit();
  return true;
}

export function emitDisplayResync(
  writer: PerfRingWriter,
  atMs: number,
  reason: TerminalDisplayResyncReason,
  generation: number,
  alreadyPending: boolean,
): boolean {
  const index = indexOf(DISPLAY_RESYNC_REASONS, reason);
  if (index < 0) return false;
  writer.begin(PERF_KIND_DISPLAY_RESYNC);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, index);
  writer.u32(2, generation);
  writer.u32(3, alreadyPending ? 1 : 0);
  writer.commit();
  return true;
}

/**
 * The prediction visibility gate's state, with the trust evidence it was
 * decided on: the consecutive confirmations and the confirmed ratio over the
 * bounded outcome window. Emitted on a state change or a 1 Hz heartbeat.
 */
export function emitPredictionGate(
  writer: PerfRingWriter,
  atMs: number,
  state: (typeof GATE_STATES)[number],
  mode: number,
  suppressionReason: PredictionGateSuppressionReason | null,
  trustConsecutive: number,
  trustRatio: number,
  trustWindow: number,
): boolean {
  const stateIndex = indexOf(GATE_STATES, state);
  if (stateIndex < 0) return false;
  const suppression =
    suppressionReason === null ? -1 : indexOf(SUPPRESSION_REASONS, suppressionReason);
  if (suppression < 0 && suppressionReason !== null) return false;
  writer.begin(PERF_KIND_PREDICTION_GATE);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, trustRatio);
  writer.u32(1, stateIndex);
  // Biased by one so 0 encodes null; the raw index would collide with
  // `mode_uninitialized`.
  writer.u32(2, suppression + 1);
  writer.u32(3, trustConsecutive);
  writer.u32(4, trustWindow);
  // `mode` is -1 before any rendered header, so it needs the signed view.
  writer.i32(5, mode);
  writer.commit();
  return true;
}

export function emitDisplayEvent(
  writer: PerfRingWriter,
  kind:
    | typeof PERF_KIND_DISPLAY_RECEIVED
    | typeof PERF_KIND_WORKER_DISPLAY_QUEUED
    | typeof PERF_KIND_WORKER_DISPLAY_APPLIED,
  atMs: number,
  displaySeq: number,
  generation: number,
  inputSeq: number,
  frameId: number,
  chunkIndex: number,
  chunkCount: number,
  presentationId: number,
  presentationMemberIndex: number,
  presentationMemberCount: number,
  rowPredecessorPresentationId: number,
  presentationTransactionSeq: number,
  presentationCoherent: boolean,
  presentationEnd: boolean,
  fecRecovered: boolean,
  authoritativeVisualMutation: boolean | null,
  workerReceiptToDecodeMs: number | null,
  decodeToApplyMs: number | null,
  byteLength: number,
  rowCount: number,
  displayKind: (typeof DISPLAY_KINDS)[number],
): boolean {
  const index = indexOf(DISPLAY_KINDS, displayKind);
  if (index < 0) return false;
  const isApplied = kind === PERF_KIND_WORKER_DISPLAY_APPLIED;
  if (
    !Number.isInteger(presentationMemberIndex) ||
    presentationMemberIndex < 0 ||
    presentationMemberIndex > 0xffff ||
    !Number.isInteger(presentationMemberCount) ||
    presentationMemberCount < 0 ||
    presentationMemberCount > 0xffff ||
    !Number.isInteger(rowPredecessorPresentationId) ||
    rowPredecessorPresentationId < 0 ||
    rowPredecessorPresentationId > 0xffff_ffff ||
    (isApplied && authoritativeVisualMutation === null) ||
    (!isApplied && authoritativeVisualMutation !== null) ||
    (kind === PERF_KIND_DISPLAY_RECEIVED
      ? workerReceiptToDecodeMs === null || decodeToApplyMs !== null
      : kind === PERF_KIND_WORKER_DISPLAY_QUEUED
        ? workerReceiptToDecodeMs !== null || decodeToApplyMs !== null
        : workerReceiptToDecodeMs !== null || decodeToApplyMs === null)
  ) {
    return false;
  }
  writer.begin(kind);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, displaySeq);
  writer.u32(2, generation);
  writer.u32(3, inputSeq);
  writer.u32(4, frameId);
  writer.u32(5, byteLength);
  writer.u32(6, rowCount);
  writer.u32(7, index);
  writer.u32(8, presentationId);
  writer.u32(10, presentationTransactionSeq);
  writer.u32(12, chunkIndex);
  writer.u32(13, chunkCount);
  writer.u32(
    U32_DISPLAY_PRESENTATION_MEMBER,
    ((presentationMemberCount & 0xffff) << 16) | (presentationMemberIndex & 0xffff),
  );
  writer.u32(U32_DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID, rowPredecessorPresentationId);
  writer.u32(
    11,
    authoritativeVisualMutation === null
      ? DISPLAY_VISUAL_MUTATION_UNKNOWN
      : authoritativeVisualMutation
        ? DISPLAY_VISUAL_MUTATION_CHANGED
        : DISPLAY_VISUAL_MUTATION_UNCHANGED,
  );
  writer.f64(1, workerReceiptToDecodeMs ?? 0);
  writer.f64(2, decodeToApplyMs ?? 0);
  writer.u32(
    9,
    (presentationCoherent ? DISPLAY_FLAG_PRESENTATION_COHERENT : 0) |
      (presentationEnd ? DISPLAY_FLAG_PRESENTATION_END : 0) |
      (fecRecovered ? DISPLAY_FLAG_FEC_RECOVERED : 0),
  );
  writer.commit();
  return true;
}

export function emitDisplayPumpComplete(
  writer: PerfRingWriter,
  atMs: number,
  durationMs: number,
  budgetMs: number,
  processedDatagramCount: number,
  processedRowCount: number,
  queueHighWater: number,
  queueRemaining: number,
  ringBytesAtStart: number,
  ringBytesAtEnd: number,
  ringDroppedTotal: number,
): void {
  writer.begin(PERF_KIND_DISPLAY_PUMP_COMPLETE);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, durationMs);
  writer.f64(2, budgetMs);
  writer.u32(1, processedDatagramCount);
  writer.u32(2, processedRowCount);
  writer.u32(3, queueHighWater);
  writer.u32(4, queueRemaining);
  writer.u32(5, ringBytesAtStart);
  writer.u32(6, ringBytesAtEnd);
  writer.u32(7, ringDroppedTotal);
  writer.commit();
}

export function emitPresentationCommit(
  writer: PerfRingWriter,
  atMs: number,
  transactionSeq: number,
  renderSeq: number,
  generation: number,
  firstDisplaySeq: number,
  lastDisplaySeq: number,
  displayInputSeq: number,
  firstPresentationId: number,
  lastPresentationId: number,
  firstApplyToCommitMs: number,
  lastApplyToCommitMs: number,
  deadlineOverrunMs: number,
  refreshPeriodMs: number,
  datagramCount: number,
  rowCount: number,
  byteLength: number,
  queueHighWater: number,
  coherent: boolean,
  endSeen: boolean,
  authoritativeVisualChange: boolean,
  reason: TerminalPresentationCommitReason,
  releaseFrameTimeMs: number,
  releaseFrameCount: number,
  membershipReleaseDisableBits: number,
  displayEchoHorizonSeq: number,
): boolean {
  const reasonIndex = indexOf(PRESENTATION_COMMIT_REASONS, reason);
  if (
    reasonIndex < 0 ||
    !Number.isInteger(membershipReleaseDisableBits) ||
    membershipReleaseDisableBits < 0 ||
    membershipReleaseDisableBits > 0xff
  )
    return false;
  writer.begin(PERF_KIND_PRESENTATION_COMMIT);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, firstApplyToCommitMs);
  writer.f64(2, lastApplyToCommitMs);
  writer.f64(3, deadlineOverrunMs);
  writer.f64(4, refreshPeriodMs);
  writer.f64(5, releaseFrameTimeMs);
  // Every u32 slot is taken; a sequence is exact in a float slot.
  writer.f64(6, displayEchoHorizonSeq);
  writer.u32(1, transactionSeq);
  writer.u32(2, renderSeq);
  writer.u32(3, generation);
  writer.u32(4, firstDisplaySeq);
  writer.u32(5, lastDisplaySeq);
  writer.u32(6, firstPresentationId);
  writer.u32(7, lastPresentationId);
  writer.u32(8, datagramCount);
  writer.u32(9, rowCount);
  writer.u32(10, byteLength);
  writer.u32(11, queueHighWater);
  writer.u32(
    12,
    (coherent ? PRESENTATION_FLAG_COHERENT : 0) |
      (endSeen ? PRESENTATION_FLAG_END_SEEN : 0) |
      (authoritativeVisualChange ? PRESENTATION_FLAG_AUTHORITATIVE_VISUAL_CHANGE : 0) |
      (membershipReleaseDisableBits << 8),
  );
  writer.u32(13, reasonIndex);
  writer.u32(14, displayInputSeq);
  writer.u32(15, releaseFrameCount);
  writer.commit();
  return true;
}

export function emitPresentationMeasurementBoundary(
  writer: PerfRingWriter,
  atMs: number,
  measurementId: number,
  phase: TerminalPresentationMeasurementPhase,
  purpose: TerminalPresentationMeasurementPurpose,
): boolean {
  const phaseIndex = indexOf(PRESENTATION_MEASUREMENT_PHASES, phase);
  const purposeIndex = indexOf(PRESENTATION_MEASUREMENT_PURPOSES, purpose);
  if (phaseIndex < 0 || purposeIndex < 0) return false;
  writer.begin(PERF_KIND_PRESENTATION_MEASUREMENT_BOUNDARY);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, measurementId);
  writer.u32(2, phaseIndex);
  writer.u32(3, purposeIndex);
  writer.commit();
  return true;
}

export function emitDisplayRingMeasurementBoundary(
  writer: PerfRingWriter,
  atMs: number,
  measurementId: number,
  phase: TerminalPresentationMeasurementPhase,
  observationEpoch: number,
  sessionEpoch: number,
  ringDroppedTotal: number,
): boolean {
  const phaseIndex = indexOf(PRESENTATION_MEASUREMENT_PHASES, phase);
  if (phaseIndex < 0) return false;
  writer.begin(PERF_KIND_DISPLAY_RING_MEASUREMENT_BOUNDARY);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, measurementId);
  writer.u32(2, phaseIndex);
  writer.u32(3, observationEpoch);
  writer.u32(4, sessionEpoch);
  writer.u32(5, ringDroppedTotal);
  writer.commit();
  return true;
}

export function emitPresentationTransactionDiscarded(
  writer: PerfRingWriter,
  atMs: number,
  transactionSeq: number,
  generation: number,
  firstDisplaySeq: number,
  lastDisplaySeq: number,
  appliedDatagramCount: number,
  rowCount: number,
  byteLength: number,
  reason: TerminalPresentationDiscardReason,
): boolean {
  const reasonIndex = indexOf(PRESENTATION_DISCARD_REASONS, reason);
  if (reasonIndex < 0) return false;
  writer.begin(PERF_KIND_PRESENTATION_TRANSACTION_DISCARDED);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, transactionSeq);
  writer.u32(2, generation);
  writer.u32(3, firstDisplaySeq);
  writer.u32(4, lastDisplaySeq);
  writer.u32(5, appliedDatagramCount);
  writer.u32(6, rowCount);
  writer.u32(7, byteLength);
  writer.u32(8, reasonIndex);
  writer.commit();
  return true;
}

/**
 * `preserved` is whether the epoch kept the grid it inherited. The analyzer
 * treats a preserved boundary as lineage continuity -- a carrier swap that was
 * answered with repairs -- and only a discarding one as the cut before which
 * nothing belongs to the current presentation lineage.
 */
export function emitPresentationEpochBoundary(
  writer: PerfRingWriter,
  atMs: number,
  epoch: number,
  preserved: boolean,
): void {
  writer.begin(PERF_KIND_PRESENTATION_EPOCH_BOUNDARY);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, epoch);
  writer.u32(2, preserved ? 1 : 0);
  writer.commit();
}

export function emitMainFrameCadence(
  writer: PerfRingWriter,
  atMs: number,
  gapMs: number,
  longTaskObserverSupported: boolean,
): void {
  writer.begin(PERF_KIND_MAIN_FRAME_CADENCE);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, gapMs);
  writer.u32(1, longTaskObserverSupported ? 1 : 0);
  writer.commit();
}

export function emitMainLongTask(writer: PerfRingWriter, atMs: number, durationMs: number): void {
  writer.begin(PERF_KIND_MAIN_LONG_TASK);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, durationMs);
  writer.commit();
}

export function emitPresentationGate(
  writer: PerfRingWriter,
  atMs: number,
  gates: number,
  viewerFrameAgeMs: number,
  frameFenceToken: number,
  gridCols: number,
  gridRows: number,
  presentationCols: number,
  presentationRows: number,
): void {
  writer.begin(PERF_KIND_PRESENTATION_GATE);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, viewerFrameAgeMs);
  writer.u32(1, gates);
  writer.u32(2, frameFenceToken);
  writer.u32(3, gridCols);
  writer.u32(4, gridRows);
  writer.u32(5, presentationCols);
  writer.u32(6, presentationRows);
  writer.commit();
}

export function emitFirstDisplayGate(
  writer: PerfRingWriter,
  atMs: number,
  accepted: boolean,
  frameFenceToken: number,
  currentFenceToken: number,
): void {
  writer.begin(PERF_KIND_FIRST_DISPLAY_GATE);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, accepted ? 1 : 0);
  writer.u32(2, frameFenceToken);
  writer.u32(3, currentFenceToken);
  writer.commit();
}

export function emitBrowserDisplayIo(
  writer: PerfRingWriter,
  atMs: number,
  stage: BrowserDisplayIoStage,
  ingressRoute: BrowserDisplayIngressRoute | null,
  displaySeq: number,
  generation: number,
  frameId: number,
  chunkIndex: number,
  chunkCount: number,
  payloadByteLength: number,
  admitted: boolean,
  explicitCopyCount: number,
  explicitCopiedBytes: number,
  explicitAllocationRequestCount: number,
  explicitAllocationRequestedBytes: number,
  explicitObjectAllocationRequestCount: number,
  fecRecovered: boolean,
): boolean {
  const stageIndex = indexOf(BROWSER_DISPLAY_IO_STAGES, stage);
  const transportStage = stage === 'transport_ingress' || stage === 'transport_fec_ingress';
  const ingressRouteIndex =
    ingressRoute === null ? -1 : indexOf(BROWSER_DISPLAY_INGRESS_ROUTES, ingressRoute);
  if (
    stageIndex < 0 ||
    (transportStage && ingressRouteIndex < 0) ||
    (!transportStage && ingressRoute !== null)
  ) {
    return false;
  }
  writer.begin(PERF_KIND_BROWSER_DISPLAY_IO);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(1, stageIndex);
  writer.u32(2, displaySeq);
  writer.u32(3, generation);
  writer.u32(4, frameId);
  writer.u32(5, chunkIndex);
  writer.u32(6, chunkCount);
  writer.u32(7, payloadByteLength);
  writer.u32(8, admitted ? 1 : 0);
  writer.u32(9, explicitCopyCount);
  writer.u32(10, explicitCopiedBytes);
  writer.u32(11, explicitAllocationRequestCount);
  writer.u32(12, explicitAllocationRequestedBytes);
  writer.u32(13, explicitObjectAllocationRequestCount);
  writer.u32(14, fecRecovered ? 1 : 0);
  // Zero is the mandatory null value on terminal-owned stages; routes are 1..4.
  writer.u32(15, ingressRouteIndex + 1);
  writer.commit();
  return true;
}

export function emitRenderStart(
  writer: PerfRingWriter,
  atMs: number,
  renderSeq: number,
  displayInputSeq: number,
  predictionInputSeq: number,
  queuedDisplayFrames: number,
  wantedAtMs: number,
  gate: TerminalRenderGate,
  fenceReleasedAtMs: number,
  fenceReleasedRenderSeq: number,
  opportunityEnteredAtMs: number,
  opportunityDelayMs: number,
  refreshPeriodMs: number,
  refreshConfidence01: number,
  fenceWaitMs: number,
  opportunityWaitMs: number,
): boolean {
  const index = indexOf(RENDER_GATES, gate);
  if (index < 0) return false;
  if (
    !Number.isFinite(fenceWaitMs) ||
    fenceWaitMs < 0 ||
    !Number.isFinite(opportunityWaitMs) ||
    opportunityWaitMs < 0
  )
    return false;
  if (gate === 'fence' || gate === 'fence-and-opportunity') {
    if (
      !Number.isInteger(fenceReleasedRenderSeq) ||
      fenceReleasedRenderSeq <= 0 ||
      fenceReleasedRenderSeq > 0xffff_ffff ||
      fenceReleasedRenderSeq === renderSeq
    )
      return false;
  } else if (fenceReleasedRenderSeq !== 0) return false;
  writer.begin(PERF_KIND_RENDER_START);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, wantedAtMs);
  writer.f64(2, fenceReleasedAtMs);
  writer.f64(3, opportunityEnteredAtMs);
  writer.f64(4, opportunityDelayMs);
  writer.f64(5, refreshPeriodMs);
  writer.f64(6, refreshConfidence01);
  writer.f64(7, fenceWaitMs);
  renderWaitScratch[0] = opportunityWaitMs;
  writer.u32(8, renderWaitWords[0] ?? 0);
  writer.u32(9, renderWaitWords[1] ?? 0);
  writer.u32(U32_RENDER_SEQ, renderSeq);
  writer.u32(U32_DISPLAY_INPUT_SEQ, displayInputSeq);
  writer.u32(U32_PREDICTION_INPUT_SEQ, predictionInputSeq);
  writer.u32(U32_QUEUED_DISPLAY_FRAMES, queuedDisplayFrames);
  writer.u32(5, index);
  writer.u32(6, fenceReleasedRenderSeq);
  writer.commit();
  return true;
}

export function emitRenderEnd(
  writer: PerfRingWriter,
  atMs: number,
  renderSeq: number,
  displayInputSeq: number,
  predictionInputSeq: number,
  queuedDisplayFrames: number,
  visiblePredictionInputSeqs: readonly number[],
  visibleTruncated: boolean,
  completionMode: TerminalFrameCompletionModeLabel,
  atlasUploaded: boolean,
  drainedDisplay: boolean,
): boolean {
  const index = indexOf(COMPLETION_MODES, completionMode);
  if (index < 0) return false;
  writer.begin(PERF_KIND_RENDER_END);
  writer.f64(F64_AT_MS, atMs);
  writer.u32(U32_RENDER_SEQ, renderSeq);
  writer.u32(U32_DISPLAY_INPUT_SEQ, displayInputSeq);
  writer.u32(U32_PREDICTION_INPUT_SEQ, predictionInputSeq);
  writer.u32(U32_QUEUED_DISPLAY_FRAMES, queuedDisplayFrames);
  writer.u32(5, index);
  writeVisiblePredictions(
    writer,
    visiblePredictionInputSeqs,
    visibleTruncated,
    atlasUploaded,
    drainedDisplay,
    0,
  );
  writer.commit();
  return true;
}

export function emitFrameComplete(
  writer: PerfRingWriter,
  atMs: number,
  renderSeq: number,
  displayInputSeq: number,
  predictionInputSeq: number,
  queuedDisplayFrames: number,
  visiblePredictionInputSeqs: readonly number[],
  visibleTruncated: boolean,
  pollCount: number,
  previousPollAtMs: number,
  completionDisposition: TerminalFrameCompletionDisposition,
): boolean {
  const index = indexOf(COMPLETION_DISPOSITIONS, completionDisposition);
  if (index < 0) return false;
  writer.begin(PERF_KIND_FRAME_COMPLETE);
  writer.f64(F64_AT_MS, atMs);
  writer.f64(1, previousPollAtMs);
  writer.u32(U32_RENDER_SEQ, renderSeq);
  writer.u32(U32_DISPLAY_INPUT_SEQ, displayInputSeq);
  writer.u32(U32_PREDICTION_INPUT_SEQ, predictionInputSeq);
  writer.u32(U32_QUEUED_DISPLAY_FRAMES, queuedDisplayFrames);
  writer.u32(5, pollCount);
  writeVisiblePredictions(
    writer,
    visiblePredictionInputSeqs,
    visibleTruncated,
    false,
    false,
    (index + 1) << COMPLETION_DISPOSITION_SHIFT,
  );
  writer.commit();
  return true;
}

/**
 * Object-shaped dispatcher over the emitters above.
 *
 * For the handful of sites that naturally hold a whole event, and for the codec
 * tests. Returns false when an enum member is missing from its table — the
 * caller drops the event rather than writing a record that would decode to a
 * different, plausible one.
 */
export function encodePerfEvent(
  writer: PerfRingWriter,
  interner: PerfStringInterner,
  event: TerminalPerfEvent,
): boolean {
  switch (event.kind) {
    case 'startup_milestone':
      return emitStartupMilestone(
        writer,
        event.atMs,
        event.attemptId,
        interner.intern(event.deviceId),
        event.milestone,
        event.elapsedMs,
        event.traceId,
        event.spanId,
      );
    case 'session_start':
      emitSessionStart(writer, event.atMs);
      return true;
    case 'session_bound':
      emitSessionBound(
        writer,
        event.atMs,
        interner.intern(event.merkurSessionId),
        event.networkType,
        event.effectiveType,
      );
      return true;
    case 'recovery_outcome':
      emitRecoveryOutcome(writer, event.atMs, event);
      return true;
    case 'carrier_closed':
      emitCarrierClosed(
        writer,
        event.atMs,
        event.lane,
        event.source,
        event.closeCode,
        event.lifetimeMs,
      );
      return true;
    case 'input_queued':
      emitInputQueued(writer, event.atMs, event.admittedAtMs, event.inputSeq, event.byteLength);
      return true;
    case 'keyboard_commit':
      emitKeyboardCommit(writer, event.atMs, event.touchStartedAtMs, event.inputSeq, event.repeat);
      return true;
    case 'input_ack':
      emitInputAck(writer, event.atMs, event.inputSeq, event.networkRttMs);
      return true;
    case 'prediction_rejected':
      emitPredictionRejected(
        writer,
        event.atMs,
        event.inputSeq,
        event.rejectKind,
        event.rejectCauseCode,
      );
      return true;
    case 'cursor_step':
      emitCursorStep(
        writer,
        event.atMs,
        event.causeCode,
        event.fromRow,
        event.fromCol,
        event.toRow,
        event.toCol,
        event.flags,
        event.ops,
        event.journalSeq,
        event.predictionInputSeq,
        event.displayInputSeq,
      );
      return true;
    case 'cursor_shape':
      emitCursorShape(
        writer,
        event.atMs,
        event.shapeFrom,
        event.visibleFrom,
        event.shapeTo,
        event.visibleTo,
        event.flags,
        event.displaySeq,
      );
      return true;
    case 'daemon_timing':
      emitDaemonTiming(
        writer,
        event.atMs,
        event.inputSeq,
        event.recvToPtyUs,
        event.ptyToReadUs,
        event.gridApplyUs,
        event.displayCoalesceUs,
        event.selectCaptureUs,
        event.prepareQueueUs,
        event.encodeUs,
        event.compressionUs,
        event.completionQueueUs,
        event.transportSubmitUs,
        event.writeCompletionUs,
        event.ackTransmitUs,
        event.ownerCpuUs,
        event.ownerOffCpuUs,
        event.ownerQuinnWaitUs,
        event.ownerRegistryWaitUs,
        event.flushLockWaitUs,
        event.batchSeq,
        event.observationEpoch,
      );
      return true;
    case 'egress_model':
      return emitEgressModel(writer, event.atMs, event.observationEpoch, event.hop, event.model);
    case 'transport_egress':
      return emitTransportEgress(
        writer,
        event.atMs,
        event.observationEpoch,
        event.hop,
        event.series,
        event.interactive,
        event.bulk,
      );
    case 'edge_forward_residence':
      return emitEdgeForwardResidence(
        writer,
        event.atMs,
        event.observationEpoch,
        event.series,
        event.buckets,
      );
    case 'daemon_timing_status':
      emitDaemonTimingStatus(
        writer,
        event.atMs,
        event.batchSeq,
        event.inputAttributedTotal,
        event.inputDroppedTotal,
        event.inputSkippedTotal,
        event.pendingInputs,
        event.displayAttributedTotal,
        event.displayDroppedTotal,
        event.observationEpoch,
        event.recordCount,
      );
      return true;
    case 'prediction_suppressed':
      emitPredictionSuppressed(
        writer,
        event.atMs,
        event.queuedPredictions,
        event.failedPredictions,
        event.discardedPredictions,
      );
      return true;
    case 'carrier_recovery':
      return emitCarrierRecovery(writer, event.atMs, event.phase, event.reason);
    case 'graphics_asset':
      return emitGraphicsAsset(
        writer,
        event.atMs,
        event.phase,
        event.jobId,
        event.bytes,
        event.failed,
      );
    case 'transport_state':
      return emitTransportState(writer, event.atMs, event.state, interner.intern(event.reason));
    case 'prediction_gate':
      return emitPredictionGate(
        writer,
        event.atMs,
        event.state,
        event.mode,
        event.suppressionReason,
        event.trustConsecutive,
        event.trustRatio,
        event.trustWindow,
      );
    case 'display_received':
    case 'worker_display_queued':
    case 'worker_display_applied':
      return emitDisplayEvent(
        writer,
        DISPLAY_KIND_BY_EVENT[event.kind],
        event.atMs,
        event.displaySeq,
        event.generation,
        event.inputSeq,
        event.frameId,
        event.chunkIndex,
        event.chunkCount,
        event.presentationId,
        event.presentationMemberIndex,
        event.presentationMemberCount,
        event.rowPredecessorPresentationId,
        event.presentationTransactionSeq,
        event.presentationCoherent,
        event.presentationEnd,
        event.fecRecovered,
        event.authoritativeVisualMutation,
        event.workerReceiptToDecodeMs,
        event.decodeToApplyMs,
        event.byteLength,
        event.rowCount,
        event.displayKind,
      );
    case 'display_pump_complete':
      emitDisplayPumpComplete(
        writer,
        event.atMs,
        event.durationMs,
        event.budgetMs,
        event.processedDatagramCount,
        event.processedRowCount,
        event.queueHighWater,
        event.queueRemaining,
        event.ringBytesAtStart,
        event.ringBytesAtEnd,
        event.ringDroppedTotal,
      );
      return true;
    case 'presentation_commit':
      return emitPresentationCommit(
        writer,
        event.atMs,
        event.transactionSeq,
        event.renderSeq,
        event.generation,
        event.firstDisplaySeq,
        event.lastDisplaySeq,
        event.displayInputSeq,
        event.firstPresentationId,
        event.lastPresentationId,
        event.firstApplyToCommitMs,
        event.lastApplyToCommitMs,
        event.deadlineOverrunMs,
        event.refreshPeriodMs,
        event.datagramCount,
        event.rowCount,
        event.byteLength,
        event.queueHighWater,
        event.coherent,
        event.endSeen,
        event.authoritativeVisualChange,
        event.reason,
        event.releaseFrameTimeMs,
        event.releaseFrameCount,
        event.membershipReleaseDisableBits,
        event.displayEchoHorizonSeq,
      );
    case 'presentation_transaction_discarded':
      return emitPresentationTransactionDiscarded(
        writer,
        event.atMs,
        event.transactionSeq,
        event.generation,
        event.firstDisplaySeq,
        event.lastDisplaySeq,
        event.appliedDatagramCount,
        event.rowCount,
        event.byteLength,
        event.reason,
      );
    case 'presentation_epoch_boundary':
      emitPresentationEpochBoundary(writer, event.atMs, event.epoch, event.preserved);
      return true;
    case 'main_frame_cadence':
      emitMainFrameCadence(writer, event.atMs, event.gapMs, event.longTaskObserverSupported);
      return true;
    case 'main_long_task':
      emitMainLongTask(writer, event.atMs, event.durationMs);
      return true;
    case 'presentation_gate':
      emitPresentationGate(
        writer,
        event.atMs,
        event.gates,
        event.viewerFrameAgeMs,
        event.frameFenceToken,
        event.gridCols,
        event.gridRows,
        event.presentationCols,
        event.presentationRows,
      );
      return true;
    case 'first_display_gate':
      emitFirstDisplayGate(
        writer,
        event.atMs,
        event.accepted,
        event.frameFenceToken,
        event.currentFenceToken,
      );
      return true;
    case 'browser_display_io':
      return emitBrowserDisplayIo(
        writer,
        event.atMs,
        event.stage,
        event.ingressRoute,
        event.displaySeq,
        event.generation,
        event.frameId,
        event.chunkIndex,
        event.chunkCount,
        event.payloadByteLength,
        event.admitted,
        event.explicitCopyCount,
        event.explicitCopiedBytes,
        event.explicitAllocationRequestCount,
        event.explicitAllocationRequestedBytes,
        event.explicitObjectAllocationRequestCount,
        event.fecRecovered,
      );
    case 'presentation_measurement_boundary':
      return emitPresentationMeasurementBoundary(
        writer,
        event.atMs,
        event.measurementId,
        event.phase,
        event.purpose,
      );
    case 'display_ring_measurement_boundary':
      return emitDisplayRingMeasurementBoundary(
        writer,
        event.atMs,
        event.measurementId,
        event.phase,
        event.observationEpoch,
        event.sessionEpoch,
        event.ringDroppedTotal,
      );
    case 'display_resync':
      return emitDisplayResync(
        writer,
        event.atMs,
        event.reason,
        event.generation,
        event.alreadyPending,
      );
    case 'render_start':
      return emitRenderStart(
        writer,
        event.atMs,
        event.renderSeq,
        event.displayInputSeq,
        event.predictionInputSeq,
        event.queuedDisplayFrames,
        event.wantedAtMs,
        event.gate,
        event.fenceReleasedAtMs,
        event.fenceReleasedRenderSeq,
        event.opportunityEnteredAtMs,
        event.opportunityDelayMs,
        event.refreshPeriodMs,
        event.refreshConfidence01,
        event.fenceWaitMs,
        event.opportunityWaitMs,
      );
    case 'render_end':
      return emitRenderEnd(
        writer,
        event.atMs,
        event.renderSeq,
        event.displayInputSeq,
        event.predictionInputSeq,
        event.queuedDisplayFrames,
        event.visiblePredictionInputSeqs,
        event.visiblePredictionInputSeqsTruncated,
        event.completionMode,
        event.atlasUploaded,
        event.drainedDisplay,
      );
    case 'frame_complete':
      return emitFrameComplete(
        writer,
        event.atMs,
        event.renderSeq,
        event.displayInputSeq,
        event.predictionInputSeq,
        event.queuedDisplayFrames,
        event.visiblePredictionInputSeqs,
        event.visiblePredictionInputSeqsTruncated,
        event.pollCount,
        event.previousPollAtMs,
        event.completionDisposition,
      );
    default:
      // What is left is the kinds whose entire payload is one input sequence; a
      // new kind without a case fails to type-check here.
      emitInputSeqEvent(writer, SEQ_ONLY_KIND_BY_EVENT[event.kind], event.atMs, event.inputSeq);
      return true;
  }
}

const SEQ_ONLY_KIND_BY_EVENT = {
  input_sent: PERF_KIND_INPUT_SENT,
  prediction_queued: PERF_KIND_PREDICTION_QUEUED,
  prediction_applied: PERF_KIND_PREDICTION_APPLIED,
} as const;

const SEQ_ONLY_EVENT_BY_KIND: ReadonlyMap<number, keyof typeof SEQ_ONLY_KIND_BY_EVENT> = new Map<
  number,
  keyof typeof SEQ_ONLY_KIND_BY_EVENT
>([
  [PERF_KIND_INPUT_SENT, 'input_sent'],
  [PERF_KIND_PREDICTION_QUEUED, 'prediction_queued'],
  [PERF_KIND_PREDICTION_APPLIED, 'prediction_applied'],
]);

/** The kinds whose entire payload is one input sequence; null for any other kind. */
function decodeInputSeqEvent(record: PerfRecordView, atMs: number): TerminalPerfEvent | null {
  const kind = SEQ_ONLY_EVENT_BY_KIND.get(record.u32(U32_KIND));
  return kind === undefined ? null : { kind, atMs, inputSeq: record.u32(1) };
}

const DISPLAY_KIND_BY_EVENT = {
  display_received: PERF_KIND_DISPLAY_RECEIVED,
  worker_display_queued: PERF_KIND_WORKER_DISPLAY_QUEUED,
  worker_display_applied: PERF_KIND_WORKER_DISPLAY_APPLIED,
} as const;

/** Positional, not an options object: this runs on the two most frequent event
 * kinds, and an options literal here is an allocation per render. */
function writeVisiblePredictions(
  writer: PerfRingWriter,
  seqs: readonly number[],
  truncatedFlag: boolean,
  atlasUploaded: boolean,
  drainedDisplay: boolean,
  completionDispositionFlags: number,
): void {
  visibleMaskScratch.fill(0);
  let baseSeq = 0;
  let truncated = truncatedFlag;

  if (!truncated && seqs.length > 0) {
    let lowest = 0;
    for (let index = 0; index < seqs.length; index += 1) {
      const seq = seqs[index] ?? 0;
      // A sequence at or below zero is not a sequence. Anchoring the base on one
      // would shift every offset in the mask with it.
      if (!Number.isInteger(seq) || seq <= 0) {
        truncated = true;
        break;
      }
      if (lowest === 0 || seq < lowest) lowest = seq;
    }
    if (!truncated) {
      for (let index = 0; index < seqs.length; index += 1) {
        const offset = (seqs[index] ?? 0) - lowest;
        if (offset >= PERF_VISIBLE_PREDICTION_WINDOW) {
          // Wider than one window. Half a set is not a set, so the record
          // carries nothing and the flag says why.
          truncated = true;
          visibleMaskScratch.fill(0);
          break;
        }
        const word = offset >>> 5;
        visibleMaskScratch[word] = ((visibleMaskScratch[word] ?? 0) | (1 << (offset & 31))) >>> 0;
      }
      if (!truncated) baseSeq = lowest;
    }
  }

  writer.u32(U32_VISIBLE_BASE_SEQ, baseSeq);
  for (let word = 0; word < PERF_VISIBLE_PREDICTION_MASK_WORDS; word += 1) {
    writer.u32(U32_VISIBLE_MASK_BASE + word, visibleMaskScratch[word] ?? 0);
  }
  writer.u32(
    U32_RENDER_FLAGS,
    (truncated ? FLAG_VISIBLE_TRUNCATED : 0) |
      (atlasUploaded ? FLAG_ATLAS_UPLOADED : 0) |
      (drainedDisplay ? FLAG_DRAINED_DISPLAY : 0) |
      completionDispositionFlags,
  );
}

/**
 * Expand the bitmap, ascending.
 *
 * A base of zero is the empty set: the encoder only writes a base once it has a
 * sequence to anchor, so a zero base with a set bit is a record that cannot be
 * trusted and decodes to nothing.
 */
function readVisiblePredictions(record: PerfRecordView): number[] {
  const baseSeq = record.u32(U32_VISIBLE_BASE_SEQ);
  const seqs: number[] = [];
  if (baseSeq === 0) return seqs;
  for (let word = 0; word < PERF_VISIBLE_PREDICTION_MASK_WORDS; word += 1) {
    let bits = record.u32(U32_VISIBLE_MASK_BASE + word) >>> 0;
    while (bits !== 0) {
      const lowest = bits & -bits;
      seqs.push(baseSeq + (word << 5) + (31 - Math.clz32(lowest)));
      bits = (bits ^ lowest) >>> 0;
    }
  }
  return seqs;
}

/**
 * Decode one record.
 *
 * Returns null for an unknown kind or an out-of-range enum index. A record that
 * cannot be decoded faithfully is dropped: the analyzer's partition identities
 * are only meaningful over events it can trust.
 */
export function decodePerfEvent(
  record: PerfRecordView,
  strings: PerfStringResolver,
): TerminalPerfEvent | null {
  const atMs = record.f64(F64_AT_MS);

  switch (record.u32(U32_KIND)) {
    case PERF_KIND_STARTUP_MILESTONE: {
      const milestone = memberAt(STARTUP_MILESTONES, record.u32(2));
      const deviceId = strings.resolve(record.u32(3));
      if (milestone === null || deviceId === null) return null;
      return {
        kind: 'startup_milestone',
        atMs,
        attemptId: record.u32(1),
        deviceId,
        milestone,
        elapsedMs: record.f64(1),
        traceId: readHexWords(record, U32_TRACE_ID_BASE, TRACE_ID_WORDS),
        spanId: readHexWords(record, U32_SPAN_ID_BASE, SPAN_ID_WORDS),
      };
    }
    case PERF_KIND_SESSION_START:
      return { kind: 'session_start', atMs };
    case PERF_KIND_SESSION_BOUND: {
      const merkurSessionId = strings.resolve(record.u32(1));
      const networkType = memberAt(BROWSER_NETWORK_TYPES, record.u32(2));
      const effectiveType = memberAt(BROWSER_EFFECTIVE_TYPES, record.u32(3));
      if (merkurSessionId === null || networkType === null || effectiveType === null) return null;
      return { kind: 'session_bound', atMs, merkurSessionId, networkType, effectiveType };
    }
    case PERF_KIND_RECOVERY_OUTCOME: {
      const trigger = memberAt(RECOVERY_TRIGGERS, record.f64(7));
      const packed = record.u32(13);
      const native = record.u32(15);
      const phase = memberAt(RECOVERY_PHASES, packed & 255);
      const endReason = memberAt(RECOVERY_END_REASONS, (packed >>> 8) & 255);
      const cancellationInitiator = memberAt(RECOVERY_CANCEL_INITIATORS, packed >>> 16);
      const signalingOutcome = memberAt(RECOVERY_NATIVE_OUTCOMES, native & 255);
      const interactiveOutcome = memberAt(RECOVERY_NATIVE_OUTCOMES, (native >>> 8) & 255);
      const bulkOutcome = memberAt(RECOVERY_NATIVE_OUTCOMES, native >>> 16);
      if (
        trigger === null ||
        phase === null ||
        endReason === null ||
        cancellationInitiator === null ||
        signalingOutcome === null ||
        interactiveOutcome === null ||
        bulkOutcome === null
      )
        return null;
      const uuid = (base: number): string => {
        const hex = Array.from({ length: 4 }, (_, word) =>
          record
            .u32(base + word)
            .toString(16)
            .padStart(8, '0'),
        ).join('');
        return hex === '0'.repeat(32)
          ? ''
          : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
      return {
        kind: 'recovery_outcome',
        atMs,
        ownerId: uuid(1),
        attemptId: record.f64(5),
        carrierId: record.f64(6),
        trigger,
        issuanceId: uuid(5),
        sessionId: uuid(9),
        phase,
        endReason,
        cancellationInitiator,
        durationMs: record.f64(1),
        capabilityRemainingMs: record.f64(2),
        backoffDelayMs: record.f64(3),
        handshakeAdmissionMs: record.f64(4),
        retryIndex: record.u32(14),
        signalingOutcome,
        interactiveOutcome,
        bulkOutcome,
      };
    }
    case PERF_KIND_CARRIER_CLOSED: {
      const lane = memberAt(CARRIER_LANES, record.u32(1));
      const source = memberAt(CARRIER_CLOSE_SOURCES, record.u32(2));
      if (lane === null || source === null) return null;
      return {
        kind: 'carrier_closed',
        atMs,
        lane,
        source,
        closeCode: record.u32(3),
        lifetimeMs: record.f64(1),
      };
    }
    case PERF_KIND_INPUT_QUEUED:
      return {
        kind: 'input_queued',
        atMs,
        admittedAtMs: record.f64(1),
        inputSeq: record.u32(1),
        byteLength: record.u32(2),
      };
    case PERF_KIND_KEYBOARD_COMMIT:
      return {
        kind: 'keyboard_commit',
        atMs,
        touchStartedAtMs: record.f64(1),
        inputSeq: record.u32(1),
        repeat: record.u32(2) === 1,
      };
    case PERF_KIND_INPUT_ACK:
      return {
        kind: 'input_ack',
        atMs,
        inputSeq: record.u32(1),
        networkRttMs: record.u32(2) === 1 ? null : record.f64(1),
      };
    case PERF_KIND_DAEMON_TIMING:
      return {
        kind: 'daemon_timing',
        atMs,
        inputSeq: record.u32(1),
        recvToPtyUs: record.u32(2),
        ptyToReadUs: record.u32(3),
        gridApplyUs: record.u32(4),
        displayCoalesceUs: record.u32(5),
        selectCaptureUs: record.u32(6),
        prepareQueueUs: record.u32(7),
        encodeUs: record.u32(8),
        compressionUs: record.u32(9),
        completionQueueUs: record.u32(10),
        transportSubmitUs: record.u32(11),
        writeCompletionUs: observedU32(record.u32(14)),
        ackTransmitUs: observedU32(record.u32(15)),
        ownerCpuUs: record.f64(1),
        ownerOffCpuUs: record.f64(2),
        ownerQuinnWaitUs: record.f64(3),
        ownerRegistryWaitUs: record.f64(4),
        flushLockWaitUs: record.f64(5),
        batchSeq: record.u32(12),
        observationEpoch: record.u32(13),
      };
    case PERF_KIND_EGRESS_MODEL: {
      const hop = memberAt(TERMINAL_EGRESS_HOPS, record.u32(1));
      if (hop === null || record.u32(4) > 6) return null;
      return {
        kind: 'egress_model',
        atMs,
        observationEpoch: record.u32(2),
        hop,
        model: {
          epoch: record.u32(3),
          phase: record.u32(4),
          bw: record.f64(1),
          rtpropUs: record.f64(2),
          pacingRate: record.f64(3),
          bulkCap: record.f64(4),
          quantum: record.f64(5),
          probesGated: record.u32(5),
          probesAborted: record.u32(6),
          interactiveInProbe: record.u32(7),
          queueGrowthCuts: record.u32(8),
          lossRounds: record.u32(9),
          ceRounds: record.u32(10),
          probeRtts: record.u32(11),
        },
      };
    }
    case PERF_KIND_TRANSPORT_EGRESS: {
      const hop = memberAt(TERMINAL_EGRESS_HOPS, record.u32(1));
      if (hop === null) return null;
      return {
        kind: 'transport_egress',
        atMs,
        observationEpoch: record.u32(8),
        hop,
        series: record.u32(9),
        interactive: { blocked: record.u32(2), paced: record.u32(3), waitedUs: record.u32(4) },
        bulk: { blocked: record.u32(5), paced: record.u32(6), waitedUs: record.u32(7) },
      };
    }
    case PERF_KIND_EDGE_FORWARD_RESIDENCE: {
      const buckets: number[] = [];
      for (let bucket = 0; bucket < EDGE_FORWARD_RESIDENCE_BUCKET_COUNT; bucket += 1) {
        buckets.push(record.u32(1 + bucket));
      }
      return {
        kind: 'edge_forward_residence',
        atMs,
        observationEpoch: record.u32(1 + EDGE_FORWARD_RESIDENCE_BUCKET_COUNT),
        series: record.u32(2 + EDGE_FORWARD_RESIDENCE_BUCKET_COUNT),
        buckets,
      };
    }
    case PERF_KIND_DAEMON_TIMING_STATUS:
      return {
        kind: 'daemon_timing_status',
        atMs,
        batchSeq: record.u32(1),
        inputAttributedTotal: record.u32(2),
        inputDroppedTotal: record.u32(3),
        inputSkippedTotal: record.u32(4),
        pendingInputs: record.u32(5),
        displayAttributedTotal: record.u32(6),
        displayDroppedTotal: record.u32(7),
        observationEpoch: record.u32(8),
        recordCount: record.u32(9),
      };
    case PERF_KIND_PREDICTION_REJECTED:
      return {
        kind: 'prediction_rejected',
        atMs,
        inputSeq: record.u32(1),
        rejectKind: record.u32(2),
        rejectCauseCode: record.u32(3),
      };
    case PERF_KIND_CURSOR_STEP: {
      const from = record.u32(2);
      const to = record.u32(3);
      return {
        kind: 'cursor_step',
        atMs,
        causeCode: record.u32(1),
        fromRow: from >>> 16,
        fromCol: from & 0xffff,
        toRow: to >>> 16,
        toCol: to & 0xffff,
        flags: record.u32(4),
        ops: record.u32(5),
        journalSeq: record.u32(6),
        predictionInputSeq: record.u32(7),
        displayInputSeq: record.u32(8),
      };
    }
    case PERF_KIND_CURSOR_SHAPE: {
      const from = record.u32(1);
      const to = record.u32(2);
      return {
        kind: 'cursor_shape',
        atMs,
        shapeFrom: from >>> 8,
        visibleFrom: from & 0xff,
        shapeTo: to >>> 8,
        visibleTo: to & 0xff,
        flags: record.u32(3),
        displaySeq: record.u32(4),
      };
    }
    case PERF_KIND_PREDICTION_SUPPRESSED:
      return {
        kind: 'prediction_suppressed',
        atMs,
        queuedPredictions: record.u32(1),
        failedPredictions: record.u32(2),
        discardedPredictions: record.u32(3),
      };
    case PERF_KIND_CARRIER_RECOVERY: {
      const phase = memberAt(CARRIER_RECOVERY_PHASES, record.u32(1));
      const reason = memberAt(CARRIER_RECOVERY_REASONS, record.u32(2));
      if (phase === null || reason === null) return null;
      return { kind: 'carrier_recovery', atMs, phase, reason };
    }
    case PERF_KIND_GRAPHICS_ASSET: {
      const phase = memberAt(GRAPHICS_ASSET_PHASES, record.u32(1));
      const bytes = record.u32(3);
      const failed = record.u32(4);
      if (
        phase === null ||
        failed > 1 ||
        (failed === 1 && phase !== 'retired') ||
        (bytes !== 0 && phase !== 'fin')
      ) {
        return null;
      }
      return {
        kind: 'graphics_asset',
        atMs,
        phase,
        jobId: record.u32(2),
        bytes,
        failed: failed === 1,
      };
    }
    case PERF_KIND_TRANSPORT_STATE: {
      const state = memberAt(TRANSPORT_STATES, record.u32(1));
      if (state === null) return null;
      const reason = strings.resolve(record.u32(2));
      return reason === null
        ? { kind: 'transport_state', atMs, state }
        : { kind: 'transport_state', atMs, state, reason };
    }
    case PERF_KIND_PREDICTION_GATE: {
      const state = memberAt(GATE_STATES, record.u32(1));
      if (state === null) return null;
      const suppressionIndex = record.u32(2);
      const suppressionReason =
        suppressionIndex === 0 ? null : memberAt(SUPPRESSION_REASONS, suppressionIndex - 1);
      if (suppressionIndex !== 0 && suppressionReason === null) return null;
      return {
        kind: 'prediction_gate',
        atMs,
        state,
        mode: record.i32(5),
        suppressionReason,
        trustConsecutive: record.u32(3),
        trustRatio: record.f64(1),
        trustWindow: record.u32(4),
      };
    }
    case PERF_KIND_DISPLAY_RECEIVED:
    case PERF_KIND_WORKER_DISPLAY_QUEUED:
    case PERF_KIND_WORKER_DISPLAY_APPLIED: {
      const displayKind = memberAt(DISPLAY_KINDS, record.u32(7));
      if (displayKind === null) return null;
      const presentationFlags = record.u32(9);
      const visualMutationCode = record.u32(11);
      if (visualMutationCode > DISPLAY_VISUAL_MUTATION_CHANGED) return null;
      const authoritativeVisualMutation =
        visualMutationCode === DISPLAY_VISUAL_MUTATION_UNKNOWN
          ? null
          : visualMutationCode === DISPLAY_VISUAL_MUTATION_CHANGED;
      const presentationMember = record.u32(U32_DISPLAY_PRESENTATION_MEMBER);
      const shared = {
        atMs,
        displaySeq: record.u32(1),
        generation: record.u32(2),
        inputSeq: record.u32(3),
        frameId: record.u32(4),
        chunkIndex: record.u32(12),
        chunkCount: record.u32(13),
        presentationId: record.u32(8),
        presentationMemberIndex: presentationMember & 0xffff,
        presentationMemberCount: presentationMember >>> 16,
        rowPredecessorPresentationId: record.u32(U32_DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID),
        presentationTransactionSeq: record.u32(10),
        presentationCoherent: (presentationFlags & DISPLAY_FLAG_PRESENTATION_COHERENT) !== 0,
        presentationEnd: (presentationFlags & DISPLAY_FLAG_PRESENTATION_END) !== 0,
        fecRecovered: (presentationFlags & DISPLAY_FLAG_FEC_RECOVERED) !== 0,
        authoritativeVisualMutation,
        workerReceiptToDecodeMs:
          record.u32(U32_KIND) === PERF_KIND_DISPLAY_RECEIVED ? record.f64(1) : null,
        decodeToApplyMs:
          record.u32(U32_KIND) === PERF_KIND_WORKER_DISPLAY_APPLIED ? record.f64(2) : null,
        byteLength: record.u32(5),
        rowCount: record.u32(6),
        displayKind,
      };
      if (record.u32(U32_KIND) === PERF_KIND_DISPLAY_RECEIVED) {
        if (authoritativeVisualMutation !== null) return null;
        return { kind: 'display_received', ...shared };
      }
      if (record.u32(U32_KIND) === PERF_KIND_WORKER_DISPLAY_QUEUED) {
        if (authoritativeVisualMutation !== null) return null;
        return { kind: 'worker_display_queued', ...shared };
      }
      if (authoritativeVisualMutation === null) return null;
      return { kind: 'worker_display_applied', ...shared };
    }
    case PERF_KIND_DISPLAY_PUMP_COMPLETE:
      return {
        kind: 'display_pump_complete',
        atMs,
        durationMs: record.f64(1),
        budgetMs: record.f64(2),
        processedDatagramCount: record.u32(1),
        processedRowCount: record.u32(2),
        queueHighWater: record.u32(3),
        queueRemaining: record.u32(4),
        ringBytesAtStart: record.u32(5),
        ringBytesAtEnd: record.u32(6),
        ringDroppedTotal: record.u32(7),
      };
    case PERF_KIND_PRESENTATION_COMMIT: {
      const reason = memberAt(PRESENTATION_COMMIT_REASONS, record.u32(13));
      if (reason === null) return null;
      const flags = record.u32(12);
      if ((flags & ~0xff07) !== 0) return null;
      return {
        kind: 'presentation_commit',
        atMs,
        releaseFrameTimeMs: record.f64(5),
        releaseFrameCount: record.u32(15),
        membershipReleaseDisableBits: flags >>> 8,
        transactionSeq: record.u32(1),
        renderSeq: record.u32(2),
        generation: record.u32(3),
        firstDisplaySeq: record.u32(4),
        lastDisplaySeq: record.u32(5),
        displayInputSeq: record.u32(14),
        displayEchoHorizonSeq: record.f64(6),
        firstPresentationId: record.u32(6),
        lastPresentationId: record.u32(7),
        firstApplyToCommitMs: record.f64(1),
        lastApplyToCommitMs: record.f64(2),
        deadlineOverrunMs: record.f64(3),
        refreshPeriodMs: record.f64(4),
        datagramCount: record.u32(8),
        rowCount: record.u32(9),
        byteLength: record.u32(10),
        queueHighWater: record.u32(11),
        coherent: (flags & PRESENTATION_FLAG_COHERENT) !== 0,
        endSeen: (flags & PRESENTATION_FLAG_END_SEEN) !== 0,
        authoritativeVisualChange: (flags & PRESENTATION_FLAG_AUTHORITATIVE_VISUAL_CHANGE) !== 0,
        reason,
      };
    }
    case PERF_KIND_PRESENTATION_MEASUREMENT_BOUNDARY: {
      const phase = memberAt(PRESENTATION_MEASUREMENT_PHASES, record.u32(2));
      const purpose = memberAt(PRESENTATION_MEASUREMENT_PURPOSES, record.u32(3));
      if (phase === null || purpose === null) return null;
      return {
        kind: 'presentation_measurement_boundary',
        atMs,
        measurementId: record.u32(1),
        phase,
        purpose,
      };
    }
    case PERF_KIND_DISPLAY_RING_MEASUREMENT_BOUNDARY: {
      const phase = memberAt(PRESENTATION_MEASUREMENT_PHASES, record.u32(2));
      if (phase === null) return null;
      return {
        kind: 'display_ring_measurement_boundary',
        atMs,
        measurementId: record.u32(1),
        phase,
        observationEpoch: record.u32(3),
        sessionEpoch: record.u32(4),
        ringDroppedTotal: record.u32(5),
      };
    }
    case PERF_KIND_PRESENTATION_TRANSACTION_DISCARDED: {
      const reason = memberAt(PRESENTATION_DISCARD_REASONS, record.u32(8));
      if (reason === null) return null;
      return {
        kind: 'presentation_transaction_discarded',
        atMs,
        transactionSeq: record.u32(1),
        generation: record.u32(2),
        firstDisplaySeq: record.u32(3),
        lastDisplaySeq: record.u32(4),
        appliedDatagramCount: record.u32(5),
        rowCount: record.u32(6),
        byteLength: record.u32(7),
        reason,
      };
    }
    case PERF_KIND_PRESENTATION_EPOCH_BOUNDARY:
      if (record.u32(2) > 1) return null;
      return {
        kind: 'presentation_epoch_boundary',
        atMs,
        epoch: record.u32(1),
        preserved: record.u32(2) === 1,
      };
    case PERF_KIND_MAIN_FRAME_CADENCE:
      if (record.u32(1) > 1) return null;
      return {
        kind: 'main_frame_cadence',
        atMs,
        gapMs: record.f64(1),
        longTaskObserverSupported: record.u32(1) === 1,
      };
    case PERF_KIND_MAIN_LONG_TASK:
      return {
        kind: 'main_long_task',
        atMs,
        durationMs: record.f64(1),
      };
    case PERF_KIND_PRESENTATION_GATE:
      return {
        kind: 'presentation_gate',
        atMs,
        gates: record.u32(1),
        viewerFrameAgeMs: record.f64(1),
        frameFenceToken: record.u32(2),
        gridCols: record.u32(3),
        gridRows: record.u32(4),
        presentationCols: record.u32(5),
        presentationRows: record.u32(6),
      };
    case PERF_KIND_FIRST_DISPLAY_GATE:
      return {
        kind: 'first_display_gate',
        atMs,
        accepted: record.u32(1) === 1,
        frameFenceToken: record.u32(2),
        currentFenceToken: record.u32(3),
      };
    case PERF_KIND_BROWSER_DISPLAY_IO: {
      const stage = memberAt(BROWSER_DISPLAY_IO_STAGES, record.u32(1));
      const ingressRouteCode = record.u32(15);
      const ingressRoute =
        ingressRouteCode === 0
          ? null
          : memberAt(BROWSER_DISPLAY_INGRESS_ROUTES, ingressRouteCode - 1);
      const transportStage = stage === 'transport_ingress' || stage === 'transport_fec_ingress';
      if (
        stage === null ||
        record.u32(8) > 1 ||
        record.u32(14) > 1 ||
        (transportStage ? ingressRoute === null : ingressRouteCode !== 0)
      ) {
        return null;
      }
      return {
        kind: 'browser_display_io',
        atMs,
        stage,
        ingressRoute,
        displaySeq: record.u32(2),
        generation: record.u32(3),
        frameId: record.u32(4),
        chunkIndex: record.u32(5),
        chunkCount: record.u32(6),
        payloadByteLength: record.u32(7),
        admitted: record.u32(8) === 1,
        explicitCopyCount: record.u32(9),
        explicitCopiedBytes: record.u32(10),
        explicitAllocationRequestCount: record.u32(11),
        explicitAllocationRequestedBytes: record.u32(12),
        explicitObjectAllocationRequestCount: record.u32(13),
        fecRecovered: record.u32(14) === 1,
      };
    }
    case PERF_KIND_DISPLAY_RESYNC: {
      const reason = memberAt(DISPLAY_RESYNC_REASONS, record.u32(1));
      if (reason === null) return null;
      return {
        kind: 'display_resync',
        atMs,
        reason,
        generation: record.u32(2),
        alreadyPending: record.u32(3) === 1,
      };
    }
    case PERF_KIND_RENDER_START: {
      const gate = memberAt(RENDER_GATES, record.u32(5));
      if (gate === null) return null;
      const fenceWaitMs = record.f64(7);
      renderWaitWords[0] = record.u32(8);
      renderWaitWords[1] = record.u32(9);
      const opportunityWaitMs = renderWaitScratch[0] ?? 0;
      if (
        !Number.isFinite(fenceWaitMs) ||
        fenceWaitMs < 0 ||
        !Number.isFinite(opportunityWaitMs) ||
        opportunityWaitMs < 0
      )
        return null;
      const fenceReleasedRenderSeq = record.u32(6);
      if (gate === 'fence' || gate === 'fence-and-opportunity') {
        if (fenceReleasedRenderSeq === 0 || fenceReleasedRenderSeq === record.u32(U32_RENDER_SEQ))
          return null;
      } else if (fenceReleasedRenderSeq !== 0) return null;
      return {
        kind: 'render_start',
        atMs,
        renderSeq: record.u32(U32_RENDER_SEQ),
        displayInputSeq: record.u32(U32_DISPLAY_INPUT_SEQ),
        predictionInputSeq: record.u32(U32_PREDICTION_INPUT_SEQ),
        queuedDisplayFrames: record.u32(U32_QUEUED_DISPLAY_FRAMES),
        wantedAtMs: record.f64(1),
        gate,
        fenceReleasedAtMs: record.f64(2),
        fenceReleasedRenderSeq,
        opportunityEnteredAtMs: record.f64(3),
        opportunityDelayMs: record.f64(4),
        fenceWaitMs,
        opportunityWaitMs,
        refreshPeriodMs: record.f64(5),
        refreshConfidence01: record.f64(6),
      };
    }
    case PERF_KIND_RENDER_END: {
      const completionMode = memberAt(COMPLETION_MODES, record.u32(5));
      if (completionMode === null) return null;
      const flags = record.u32(U32_RENDER_FLAGS);
      if ((flags & ~(FLAG_VISIBLE_TRUNCATED | FLAG_ATLAS_UPLOADED | FLAG_DRAINED_DISPLAY)) !== 0)
        return null;
      return {
        kind: 'render_end',
        atMs,
        renderSeq: record.u32(U32_RENDER_SEQ),
        displayInputSeq: record.u32(U32_DISPLAY_INPUT_SEQ),
        predictionInputSeq: record.u32(U32_PREDICTION_INPUT_SEQ),
        queuedDisplayFrames: record.u32(U32_QUEUED_DISPLAY_FRAMES),
        visiblePredictionInputSeqs: readVisiblePredictions(record),
        visiblePredictionInputSeqsTruncated: (flags & FLAG_VISIBLE_TRUNCATED) !== 0,
        completionMode,
        atlasUploaded: (flags & FLAG_ATLAS_UPLOADED) !== 0,
        drainedDisplay: (flags & FLAG_DRAINED_DISPLAY) !== 0,
      };
    }
    case PERF_KIND_FRAME_COMPLETE: {
      const flags = record.u32(U32_RENDER_FLAGS);
      if ((flags & ~(FLAG_VISIBLE_TRUNCATED | (3 << COMPLETION_DISPOSITION_SHIFT))) !== 0)
        return null;
      const completionDisposition = memberAt(
        COMPLETION_DISPOSITIONS,
        ((flags >>> COMPLETION_DISPOSITION_SHIFT) & 3) - 1,
      );
      if (completionDisposition === null) return null;
      return {
        kind: 'frame_complete',
        completionDisposition,
        atMs,
        renderSeq: record.u32(U32_RENDER_SEQ),
        displayInputSeq: record.u32(U32_DISPLAY_INPUT_SEQ),
        predictionInputSeq: record.u32(U32_PREDICTION_INPUT_SEQ),
        queuedDisplayFrames: record.u32(U32_QUEUED_DISPLAY_FRAMES),
        visiblePredictionInputSeqs: readVisiblePredictions(record),
        visiblePredictionInputSeqsTruncated: (flags & FLAG_VISIBLE_TRUNCATED) !== 0,
        pollCount: record.u32(5),
        previousPollAtMs: record.f64(1),
      };
    }
    default:
      return decodeInputSeqEvent(record, atMs);
  }
}
