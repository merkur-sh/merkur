// E2E Noise transport benchmark.
//
// Measures `packages/merkur-e2e` compiled to WebAssembly — the implementation
// the browser actually runs, driven through the same reused-buffer boundary the
// transport worker uses, so the numbers include the boundary cost rather than
// just the cipher.
//
// Workloads mirror the traffic the transport actually carries:
//   - small datagrams  (input runs, display ACKs) on the pty lane
//   - large stream frames (display commits) on the displayCommit lane
//   - reorder-heavy opens, which a frame fanned over several transports hits
//     routinely and which drive the replay window's expensive branch
//   - the full three-message handshake plus transport split
//
// Seal and open are timed separately: they have different costs and only the
// open path pays for the replay window.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as e2eWasm from '../packages/e2e-wasm/pkg/e2e_wasm.js';
import { LOGICAL_CHANNELS, type LogicalChannel } from '../packages/shared/src/transport';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const wasmMemory = e2eWasm.initSync({
  module: new Uint8Array(
    await readFile(path.join(REPO_ROOT, 'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm')),
  ),
}).memory;

const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 500);
const BATCH_SIZE = perfEnvInteger('BENCH_BATCH_SIZE', 256);
const WARMUPS = readNonNegativeInteger('BENCH_WARMUPS', 50);
const HANDSHAKE_SAMPLES = perfEnvInteger('BENCH_HANDSHAKE_SAMPLES', 200);
const FNV_OFFSET_BASIS = 0x811c_9dc5;

const SMALL_PAYLOAD_BYTES = 32;
const LARGE_PAYLOAD_BYTES = 8 * 1024;
// Wire counter + AEAD tag; mirrors `merkur_e2e::FRAME_OVERHEAD`.
const FRAME_OVERHEAD = 24;

interface BenchTransport {
  sealStream(channel: LogicalChannel, payload: Uint8Array): Uint8Array;
  openStream(channel: LogicalChannel, framed: Uint8Array): Uint8Array | null;
  sealDatagram(channel: LogicalChannel, payload: Uint8Array): Uint8Array;
  openDatagram(channel: LogicalChannel, framed: Uint8Array): Uint8Array | null;
}

interface TransportPair {
  readonly sender: BenchTransport;
  readonly receiver: BenchTransport;
}

const smallPayloads = createPayloads(BATCH_SIZE, SMALL_PAYLOAD_BYTES);
const largePayloads = createPayloads(BATCH_SIZE, LARGE_PAYLOAD_BYTES);
// A fixed shuffle keeps the reorder workload identical across runs.
const reorderOrder = deterministicShuffle(BATCH_SIZE);

const smallResult = measureSealOpen('pty', true, smallPayloads, false);
const largeResult = measureSealOpen('displayCommit', false, largePayloads, false);
const reorderResult = measureSealOpen('displayDatagram', true, smallPayloads, true);
const handshakeResult = measureHandshake();

process.stdout.write(
  `e2e crypto benchmark: samples=${SAMPLES}, warmups=${WARMUPS}, ` +
    `batchSize=${BATCH_SIZE}, handshakeSamples=${HANDSHAKE_SAMPLES}\n` +
    formatSealOpen('datagram-small', SMALL_PAYLOAD_BYTES, smallResult) +
    formatSealOpen('stream-large', LARGE_PAYLOAD_BYTES, largeResult) +
    formatSealOpen('datagram-reorder', SMALL_PAYLOAD_BYTES, reorderResult) +
    `handshake: p50=${nearestRank(handshakeResult, 0.5).toFixed(6)}ms, ` +
    `p99=${nearestRank(handshakeResult, 0.99).toFixed(6)}ms\n`,
);

emitSealOpenMetrics('datagram-small', SMALL_PAYLOAD_BYTES, smallResult);
emitSealOpenMetrics('stream-large', LARGE_PAYLOAD_BYTES, largeResult);
emitSealOpenMetrics('datagram-reorder', SMALL_PAYLOAD_BYTES, reorderResult);
for (const percentile of [0.5, 0.95, 0.99] as const) {
  emitPerfMetric({
    name: 'e2e-handshake-latency',
    value: nearestRank(handshakeResult, percentile),
    unit: 'ms/handshake',
    direction: 'lower',
    percentile,
    sampleSize: HANDSHAKE_SAMPLES,
  });
}

interface SealOpenResult {
  readonly sealMs: readonly number[];
  readonly openMs: readonly number[];
  readonly payloadBytes: number;
}

// One long-lived pair per workload: lane counters advance monotonically across
// every batch, so no frame is ever presented to the replay window twice.
function measureSealOpen(
  channel: LogicalChannel,
  datagram: boolean,
  payloads: readonly Uint8Array[],
  reorder: boolean,
): SealOpenResult {
  const { sender, receiver } = establishWasmPair();
  const seal = datagram
    ? (payload: Uint8Array): Uint8Array => sender.sealDatagram(channel, payload)
    : (payload: Uint8Array): Uint8Array => sender.sealStream(channel, payload);
  const open = datagram
    ? (framed: Uint8Array): Uint8Array | null => receiver.openDatagram(channel, framed)
    : (framed: Uint8Array): Uint8Array | null => receiver.openStream(channel, framed);

  for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
    runBatch(seal, open, payloads, reorder, false);
  }

  const sealMs: number[] = [];
  const openMs: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    // Verify the first recorded batch only: the checksum walks every payload
    // byte and would otherwise dominate what the timers are measuring.
    const batch = runBatch(seal, open, payloads, reorder, sample === 0);
    sealMs.push(batch.sealMs);
    openMs.push(batch.openMs);
  }

  const payloadBytes = payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  return { sealMs, openMs, payloadBytes };
}

function runBatch(
  seal: (payload: Uint8Array) => Uint8Array,
  open: (framed: Uint8Array) => Uint8Array | null,
  payloads: readonly Uint8Array[],
  reorder: boolean,
  verify: boolean,
): { readonly sealMs: number; readonly openMs: number } {
  const framed: Uint8Array[] = new Array(payloads.length);

  const sealStartedAt = performance.now();
  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    if (payload === undefined) throw new Error(`missing bench payload at ${index}`);
    framed[index] = seal(payload);
  }
  const sealMs = performance.now() - sealStartedAt;

  const order = reorder ? reorderOrder : null;
  const opened: (Uint8Array | null)[] = new Array(payloads.length);
  const openStartedAt = performance.now();
  for (let step = 0; step < framed.length; step += 1) {
    const index = order === null ? step : (order[step] ?? step);
    const frame = framed[index];
    if (frame === undefined) throw new Error(`missing sealed frame at ${index}`);
    opened[index] = open(frame);
  }
  const openMs = performance.now() - openStartedAt;

  if (verify) {
    for (let index = 0; index < payloads.length; index += 1) {
      const expected = payloads[index];
      const actual = opened[index];
      if (expected === undefined || actual === null || actual === undefined) {
        throw new Error(`e2e transport dropped frame ${index}`);
      }
      if (checksum(expected) !== checksum(actual)) {
        throw new Error(`e2e transport corrupted frame ${index}`);
      }
    }
  }

  return { sealMs, openMs };
}

function measureHandshake(): readonly number[] {
  for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
    establishWasmPair();
  }
  const samples: number[] = [];
  for (let sample = 0; sample < HANDSHAKE_SAMPLES; sample += 1) {
    const startedAt = performance.now();
    const pair = establishWasmPair();
    samples.push(performance.now() - startedAt);
    // Touch the result so the handshake cannot be optimized away.
    if (pair.sender === pair.receiver) throw new Error('handshake returned one transport');
  }
  return samples;
}

// Adapts the WebAssembly session to the same interface the TypeScript arm
// implements, so both are driven by identical benchmark code.
//
// Views over linear memory are cached and refreshed only when the payload
// outgrows the reserved capacity or when memory growth detaches the backing
// ArrayBuffer. Comparing `memory.buffer` is a plain property read, so the steady
// state costs no extra call across the boundary.
class WasmTransportAdapter implements BenchTransport {
  private buffer: ArrayBufferLike;
  private input: Uint8Array;
  private output: Uint8Array;

  constructor(private readonly session: e2eWasm.E2eTransport) {
    this.buffer = wasmMemory.buffer;
    this.input = new Uint8Array(this.buffer, session.input_ptr, session.capacity + FRAME_OVERHEAD);
    this.output = new Uint8Array(
      this.buffer,
      session.output_ptr,
      session.capacity + FRAME_OVERHEAD,
    );
  }

  private ready(bytes: number): void {
    if (bytes <= this.session.capacity && this.buffer === wasmMemory.buffer) return;
    this.session.reserve(bytes);
    this.buffer = wasmMemory.buffer;
    const size = this.session.capacity + FRAME_OVERHEAD;
    this.input = new Uint8Array(this.buffer, this.session.input_ptr, size);
    this.output = new Uint8Array(this.buffer, this.session.output_ptr, size);
  }

  private seal(channel: LogicalChannel, datagram: boolean, plaintext: Uint8Array): Uint8Array {
    this.ready(plaintext.byteLength);
    this.input.set(plaintext);
    const framed = this.session.seal(laneOf(channel), datagram, plaintext.byteLength);
    // `slice` copies out of linear memory. The next call reuses the same
    // buffer, so a view would alias whatever is sealed after it.
    return this.output.slice(0, framed);
  }

  private open(channel: LogicalChannel, datagram: boolean, framed: Uint8Array): Uint8Array | null {
    this.ready(framed.byteLength);
    this.input.set(framed);
    const plaintext = this.session.open(laneOf(channel), datagram, framed.byteLength);
    return plaintext < 0 ? null : this.output.slice(0, plaintext);
  }

  sealStream(channel: LogicalChannel, plaintext: Uint8Array): Uint8Array {
    return this.seal(channel, false, plaintext);
  }

  openStream(channel: LogicalChannel, framed: Uint8Array): Uint8Array | null {
    return this.open(channel, false, framed);
  }

  sealDatagram(channel: LogicalChannel, plaintext: Uint8Array): Uint8Array {
    return this.seal(channel, true, plaintext);
  }

  openDatagram(channel: LogicalChannel, framed: Uint8Array): Uint8Array | null {
    return this.open(channel, true, framed);
  }
}

function establishWasmPair(): TransportPair {
  const psk = benchPsk();
  const prologue = benchPrologue();
  const initiatorStatic = e2eWasm.generate_static_keypair().subarray(0, 32);
  const responderStatic = e2eWasm.generate_static_keypair().subarray(0, 32);
  const initiator = new e2eWasm.E2eHandshake(initiatorStatic, psk, prologue);
  const responder = e2eWasm.E2eHandshake.newResponder(responderStatic, psk, prologue);
  responder.read_message(initiator.write_message());
  initiator.read_message(responder.write_message());
  responder.read_message(initiator.write_message());
  if (!initiator.is_complete() || !responder.is_complete()) {
    throw new Error('wasm bench handshake did not complete');
  }
  return {
    sender: new WasmTransportAdapter(initiator.into_transport(LARGE_PAYLOAD_BYTES)),
    receiver: new WasmTransportAdapter(responder.into_transport(LARGE_PAYLOAD_BYTES)),
  };
}

function laneOf(channel: LogicalChannel): number {
  const lane = LOGICAL_CHANNELS.indexOf(channel);
  if (lane < 0) throw new Error(`unknown bench channel ${channel}`);
  return lane;
}

function benchPsk(): Uint8Array {
  const psk = new Uint8Array(32);
  for (let index = 0; index < psk.length; index += 1) psk[index] = (index * 7 + 13) & 0xff;
  return psk;
}

function benchPrologue(): Uint8Array {
  return new TextEncoder().encode('merkur-bench-prologue');
}

function emitSealOpenMetrics(workload: string, payloadBytes: number, result: SealOpenResult): void {
  for (const [operation, samples] of [
    ['seal', result.sealMs],
    ['open', result.openMs],
  ] as const) {
    for (const percentile of [0.5, 0.95, 0.99] as const) {
      emitPerfMetric({
        name: `e2e-${workload}-${operation}-latency`,
        value: nearestRank(samples, percentile),
        unit: 'ms/batch',
        direction: 'lower',
        percentile,
        sampleSize: SAMPLES,
      });
    }
    const totalMs = samples.reduce((sum, value) => sum + value, 0);
    if (!(totalMs > 0)) throw new Error(`e2e ${workload} ${operation} timer did not advance`);
    emitPerfMetric({
      name: `e2e-${workload}-${operation}-throughput`,
      value: Math.round(((SAMPLES * result.payloadBytes) / totalMs) * 1_000),
      unit: 'bytes/s',
      direction: 'higher',
      sampleSize: SAMPLES * BATCH_SIZE,
    });
  }
  emitPerfMetric({
    name: `e2e-${workload}-frame-size`,
    value: payloadBytes,
    unit: 'bytes',
    direction: 'lower',
    sampleSize: BATCH_SIZE,
  });
}

function formatSealOpen(workload: string, payloadBytes: number, result: SealOpenResult): string {
  const perFrame = (samples: readonly number[], percentile: number): string =>
    ((nearestRank(samples, percentile) * 1_000_000) / BATCH_SIZE).toFixed(1);
  return (
    `${workload} (${payloadBytes}B x ${BATCH_SIZE}): ` +
    `seal p50=${perFrame(result.sealMs, 0.5)}ns/frame p99=${perFrame(result.sealMs, 0.99)}ns/frame, ` +
    `open p50=${perFrame(result.openMs, 0.5)}ns/frame p99=${perFrame(result.openMs, 0.99)}ns/frame\n`
  );
}

function createPayloads(count: number, byteLength: number): Uint8Array[] {
  return Array.from({ length: count }, (_, index) => {
    const payload = new Uint8Array(byteLength);
    for (let offset = 0; offset < byteLength; offset += 1) {
      payload[offset] = (index * 31 + offset * 17 + byteLength) & 0xff;
    }
    return payload;
  });
}

// Deterministic Fisher-Yates over a fixed LCG so every arm and every run sees
// the same arrival order, and the replay window sees the same branch mix.
function deterministicShuffle(count: number): readonly number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  let state = 0x2545_f491;
  for (let index = count - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    const swap = order[index];
    const other = order[target];
    if (swap === undefined || other === undefined) throw new Error('shuffle index out of range');
    order[index] = other;
    order[target] = swap;
  }
  return order;
}

function checksum(payload: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of payload) {
    hash = Math.imul(hash ^ byte, 0x0100_0193) >>> 0;
  }
  return hash;
}

function nearestRank(samples: readonly number[], percentile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}
