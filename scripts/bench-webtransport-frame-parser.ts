import { CarrierReader } from '../apps/web/src/transport/client-carrier';
import { emitPerfMetric, perfEnvInteger, summarizeSamples } from './perf/harness';

const DEFAULT_SAMPLES = 100;
const DEFAULT_WARMUPS = 10;
const DEFAULT_TARGET_FRAMED_BYTES_PER_SAMPLE = 2 * 1024 * 1024;
const MAX_FRAMES_PER_SAMPLE = 65_536;
const FRAGMENTED_PAYLOAD_BYTES = 64 * 1024;
const BODY_FRAGMENT_BYTES = 1024;
const LENGTH_PREFIX_BYTES = 4;
const FNV_OFFSET = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

const ONE_CHUNK_PAYLOAD_SIZES = [1, 64, 1024, 16 * 1024, 64 * 1024, 1024 * 1024] as const;

type CaseMode = 'one-chunk' | 'fragmented-header-and-body';

interface FrameParserCaseDefinition {
  readonly name: string;
  readonly mode: CaseMode;
  readonly payload: Uint8Array;
  readonly frame: Uint8Array;
  readonly chunks: readonly Uint8Array[];
}

interface BatchResult {
  readonly elapsedMs: number;
  readonly dispatchedFrames: number;
  readonly dispatchedBytes: number;
  readonly checksum: number;
}

export interface WebTransportFrameParserBenchmarkOptions {
  readonly samples: number;
  readonly warmups: number;
  readonly targetFramedBytesPerSample: number;
}

export interface WebTransportFrameParserCaseResult {
  readonly name: string;
  readonly payloadBytes: number;
  readonly pushesPerFrame: number;
  readonly framesPerSample: number;
  readonly ownershipVerified: boolean;
  readonly dispatchedFrames: number;
  readonly dispatchedBytes: number;
  readonly framedBytes: number;
  readonly checksum: number;
  readonly latencySamplesMsPerFrame: readonly number[];
  readonly latencyP50MsPerFrame: number;
  readonly latencyP95MsPerFrame: number;
  readonly latencyP99MsPerFrame: number;
  readonly framedBytesPerSecond: number;
}

export interface WebTransportFrameParserBenchmarkArtifact {
  readonly schemaVersion: 1;
  readonly benchmark: 'webtransport-frame-parser';
  readonly measurementBoundary: 'CarrierReader.record-through-native-stream-credit';
  readonly samples: number;
  readonly warmups: number;
  readonly targetFramedBytesPerSample: number;
  readonly cases: readonly WebTransportFrameParserCaseResult[];
}

export async function runWebTransportFrameParserBenchmark(
  options: WebTransportFrameParserBenchmarkOptions,
): Promise<WebTransportFrameParserBenchmarkArtifact> {
  validateOptions(options);
  const cases = await Promise.all(
    createCaseDefinitions().map((definition) => runCase(definition, options)),
  );
  return {
    schemaVersion: 1,
    benchmark: 'webtransport-frame-parser',
    measurementBoundary: 'CarrierReader.record-through-native-stream-credit',
    samples: options.samples,
    warmups: options.warmups,
    targetFramedBytesPerSample: options.targetFramedBytesPerSample,
    cases,
  };
}

if (import.meta.main) {
  const artifact = await runWebTransportFrameParserBenchmark({
    samples: perfEnvInteger('BENCH_SAMPLES', DEFAULT_SAMPLES),
    warmups: readNonNegativeInteger('BENCH_WARMUPS', DEFAULT_WARMUPS),
    targetFramedBytesPerSample: perfEnvInteger(
      'BENCH_TARGET_FRAMED_BYTES_PER_SAMPLE',
      DEFAULT_TARGET_FRAMED_BYTES_PER_SAMPLE,
    ),
  });

  for (const result of artifact.cases) {
    for (const [value, percentile] of [
      [result.latencyP50MsPerFrame, 0.5],
      [result.latencyP95MsPerFrame, 0.95],
      [result.latencyP99MsPerFrame, 0.99],
    ] as const) {
      emitPerfMetric({
        name: `webtransport-frame-parser-${result.name}-latency`,
        value,
        unit: 'ms/frame',
        direction: 'lower',
        percentile,
        sampleSize: artifact.samples,
      });
    }
    emitPerfMetric({
      name: `webtransport-frame-parser-${result.name}-framed-throughput`,
      value: result.framedBytesPerSecond,
      unit: 'framed-bytes/s',
      direction: 'higher',
      sampleSize: result.dispatchedFrames,
    });
  }

  process.stdout.write(`${JSON.stringify(artifact)}\n`);
  process.stdout.write(
    `WebTransport frame parser: samples=${artifact.samples}, warmups=${artifact.warmups}, ` +
      `target=${artifact.targetFramedBytesPerSample} framed bytes/sample\n`,
  );
  for (const result of artifact.cases) {
    process.stdout.write(
      `${result.name}: payload=${result.payloadBytes} pushes/frame=${result.pushesPerFrame} ` +
        `p50=${result.latencyP50MsPerFrame.toFixed(6)}ms/frame ` +
        `p95=${result.latencyP95MsPerFrame.toFixed(6)}ms/frame ` +
        `throughput=${(result.framedBytesPerSecond / (1024 * 1024)).toFixed(2)}MiB/s ` +
        `dispatched=${result.dispatchedFrames} frames/${result.dispatchedBytes} bytes ` +
        `framed=${result.framedBytes} bytes checksum=${result.checksum.toString(16)} ` +
        `ownership=${result.ownershipVerified ? 'verified' : 'FAILED'}\n`,
    );
  }
}

async function runCase(
  definition: FrameParserCaseDefinition,
  options: WebTransportFrameParserBenchmarkOptions,
): Promise<WebTransportFrameParserCaseResult> {
  const ownershipVerified = await verifyRetainedPayloadOwnership(definition);
  const framedBytesPerFrame = definition.frame.byteLength;
  const framesPerSample = Math.min(
    MAX_FRAMES_PER_SAMPLE,
    Math.max(1, Math.ceil(options.targetFramedBytesPerSample / framedBytesPerFrame)),
  );
  const runBatch = createBatchRunner(definition, framesPerSample);
  for (let index = 0; index < options.warmups; index += 1) await runBatch();

  const latencySamplesMsPerFrame: number[] = [];
  let dispatchedFrames = 0;
  let dispatchedBytes = 0;
  let totalElapsedMs = 0;
  let checksum = FNV_OFFSET;
  for (let index = 0; index < options.samples; index += 1) {
    const batch = await runBatch();
    latencySamplesMsPerFrame.push(batch.elapsedMs / framesPerSample);
    dispatchedFrames += batch.dispatchedFrames;
    dispatchedBytes += batch.dispatchedBytes;
    totalElapsedMs += batch.elapsedMs;
    checksum = Math.imul(checksum ^ batch.checksum, FNV_PRIME) >>> 0;
  }

  const expectedFrames = options.samples * framesPerSample;
  const expectedDispatchedBytes = expectedFrames * definition.payload.byteLength;
  const framedBytes = expectedFrames * framedBytesPerFrame;
  if (
    !Number.isSafeInteger(expectedFrames) ||
    !Number.isSafeInteger(expectedDispatchedBytes) ||
    !Number.isSafeInteger(framedBytes)
  ) {
    throw new Error(`${definition.name} totals exceed safe integer precision`);
  }
  if (dispatchedFrames !== expectedFrames || dispatchedBytes !== expectedDispatchedBytes) {
    throw new Error(
      `${definition.name} dispatch invariant failed: ` +
        `${dispatchedFrames}/${dispatchedBytes}, expected ${expectedFrames}/${expectedDispatchedBytes}`,
    );
  }
  if (!(totalElapsedMs > 0)) throw new Error(`${definition.name} benchmark timer did not advance`);

  const summary = summarizeSamples(latencySamplesMsPerFrame);
  return {
    name: definition.name,
    payloadBytes: definition.payload.byteLength,
    pushesPerFrame: definition.chunks.length,
    framesPerSample,
    ownershipVerified,
    dispatchedFrames,
    dispatchedBytes,
    framedBytes,
    checksum,
    latencySamplesMsPerFrame,
    latencyP50MsPerFrame: summary.median,
    latencyP95MsPerFrame: summary.p95,
    latencyP99MsPerFrame: summary.p99,
    framedBytesPerSecond: Math.round((framedBytes / totalElapsedMs) * 1000),
  };
}

function createBatchRunner(
  definition: FrameParserCaseDefinition,
  framesPerSample: number,
): () => Promise<BatchResult> {
  let chunkIndex = 0;
  const parser = new CarrierReader(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = definition.chunks[chunkIndex++ % definition.chunks.length];
        if (chunk === undefined) throw new Error('missing stream chunk');
        controller.enqueue(chunk);
      },
    }).getReader(),
  );
  return async () => {
    let dispatchedFrames = 0,
      dispatchedBytes = 0,
      checksum = FNV_OFFSET;
    const startedAt = performance.now();
    for (let frameIndex = 0; frameIndex < framesPerSample; frameIndex++) {
      const dispatched = await parser.record();
      if (dispatched === null || !bytesEqual(dispatched, definition.payload))
        throw new Error('carrier framing content mismatch');
      dispatchedFrames++;
      dispatchedBytes += dispatched.length;
      checksum = Math.imul(checksum ^ dispatched.length ^ (dispatched[0] ?? 0), FNV_PRIME) >>> 0;
    }
    return {
      elapsedMs: performance.now() - startedAt,
      dispatchedFrames,
      dispatchedBytes,
      checksum,
    };
  };
}

function createCaseDefinitions(): FrameParserCaseDefinition[] {
  const definitions = ONE_CHUNK_PAYLOAD_SIZES.map((payloadBytes) =>
    createCaseDefinition(`one-chunk-${formatSizeName(payloadBytes)}`, payloadBytes, 'one-chunk'),
  );
  definitions.push(
    createCaseDefinition(
      'fragmented-header-1b-body-1kib-64kib',
      FRAGMENTED_PAYLOAD_BYTES,
      'fragmented-header-and-body',
    ),
  );
  return definitions;
}

function createCaseDefinition(
  name: string,
  payloadBytes: number,
  mode: CaseMode,
): FrameParserCaseDefinition {
  const payload = createPayload(payloadBytes, payloadBytes ^ 0x5a);
  const frame = framePayload(payload);
  return {
    name,
    mode,
    payload,
    frame,
    chunks: chunksFor(frame, mode),
  };
}

async function verifyRetainedPayloadOwnership(
  definition: FrameParserCaseDefinition,
): Promise<true> {
  const sourceFrame = framePayload(definition.payload.slice());
  const chunks = chunksFor(sourceFrame, definition.mode);
  let index = 0;
  const parser = new CarrierReader(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++ % chunks.length];
        if (chunk === undefined) throw new Error('missing ownership chunk');
        controller.enqueue(chunk);
      },
    }).getReader(),
  );
  const retained = await parser.record();
  if (retained === null || retained.buffer === sourceFrame.buffer)
    throw new Error('record ownership aliases source');
  sourceFrame.fill(0xa5);
  if (!bytesEqual(retained, definition.payload)) throw new Error('record changed with source');
  parser.dispose();
  return true;
}

function chunksFor(frame: Uint8Array, mode: CaseMode): Uint8Array[] {
  if (mode === 'one-chunk') return [frame];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < LENGTH_PREFIX_BYTES; offset += 1) {
    chunks.push(frame.subarray(offset, offset + 1));
  }
  for (let offset = LENGTH_PREFIX_BYTES; offset < frame.byteLength; offset += BODY_FRAGMENT_BYTES) {
    chunks.push(frame.subarray(offset, Math.min(frame.byteLength, offset + BODY_FRAGMENT_BYTES)));
  }
  return chunks;
}

function framePayload(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(LENGTH_PREFIX_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, LENGTH_PREFIX_BYTES);
  return frame;
}

function createPayload(byteLength: number, seed: number): Uint8Array {
  const payload = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < payload.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    payload[index] = state >>> 24;
  }
  return payload;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function formatSizeName(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / 1024 / 1024}mib`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}kib`;
  return `${bytes}b`;
}

function validateOptions(options: WebTransportFrameParserBenchmarkOptions): void {
  for (const [name, value, allowZero] of [
    ['samples', options.samples, false],
    ['warmups', options.warmups, true],
    ['targetFramedBytesPerSample', options.targetFramedBytesPerSample, false],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
    }
  }
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}
