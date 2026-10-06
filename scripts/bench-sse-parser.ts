import { createSseEventParser } from '../apps/web/src/lib/authenticated-transport';
import { emitPerfMetric, perfEnvInteger } from './perf/harness';

const DEFAULT_SAMPLES = 500;
const DEFAULT_EVENTS_PER_SAMPLE = 16;
const DEFAULT_PAYLOAD_CHARS = 16 * 1024;
const DEFAULT_CHUNK_CHARS = 64;
const DEFAULT_WARMUPS = 50;

export interface SseParserBatchResult {
  readonly elapsedMs: number;
  readonly parsedEvents: number;
  readonly parsedChars: number;
  readonly checksum: number;
}

export function createSseParserBenchmarkDriver(
  eventsPerSample: number,
  payloadChars: number,
  chunkChars: number,
): () => SseParserBatchResult {
  for (const [name, value] of [
    ['eventsPerSample', eventsPerSample],
    ['payloadChars', payloadChars],
    ['chunkChars', chunkChars],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }

  const payload = 'x'.repeat(payloadChars);
  const source = `event: devices\ndata: ${payload}\n\n`;
  const chunks: string[] = [];
  for (let offset = 0; offset < source.length; offset += chunkChars) {
    chunks.push(source.slice(offset, offset + chunkChars));
  }

  return () => {
    let parsedEvents = 0;
    let parsedChars = 0;
    let checksum = 0x811c_9dc5;
    const startedAt = performance.now();
    for (let eventIndex = 0; eventIndex < eventsPerSample; eventIndex += 1) {
      const parser = createSseEventParser((event) => {
        parsedEvents += 1;
        parsedChars += event.data.length;
        checksum =
          Math.imul(checksum ^ event.data.charCodeAt(event.data.length - 1), 0x0100_0193) >>> 0;
      });
      for (const chunk of chunks) parser.push(chunk);
    }
    const elapsedMs = performance.now() - startedAt;
    if (parsedEvents !== eventsPerSample || parsedChars !== eventsPerSample * payloadChars) {
      throw new Error(
        `SSE parser invariant failed: ${JSON.stringify({
          parsedEvents,
          parsedChars,
          eventsPerSample,
          payloadChars,
        })}`,
      );
    }
    return { elapsedMs, parsedEvents, parsedChars, checksum };
  };
}

if (import.meta.main) {
  const samples = perfEnvInteger('BENCH_SAMPLES', DEFAULT_SAMPLES);
  const eventsPerSample = perfEnvInteger('BENCH_EVENTS_PER_SAMPLE', DEFAULT_EVENTS_PER_SAMPLE);
  const payloadChars = perfEnvInteger('BENCH_PAYLOAD_CHARS', DEFAULT_PAYLOAD_CHARS);
  const chunkChars = perfEnvInteger('BENCH_CHUNK_CHARS', DEFAULT_CHUNK_CHARS);
  const warmups = readNonNegativeInteger('BENCH_WARMUPS', DEFAULT_WARMUPS);
  const runBatch = createSseParserBenchmarkDriver(eventsPerSample, payloadChars, chunkChars);
  for (let index = 0; index < warmups; index += 1) runBatch();

  const elapsedSamples: number[] = [];
  let totalChars = 0;
  let checksum = 0;
  for (let index = 0; index < samples; index += 1) {
    const result = runBatch();
    elapsedSamples.push(result.elapsedMs);
    totalChars += result.parsedChars;
    checksum = Math.imul(checksum ^ result.checksum, 0x0100_0193) >>> 0;
  }
  elapsedSamples.sort((left, right) => left - right);
  const totalElapsedMs = elapsedSamples.reduce((sum, value) => sum + value, 0);
  if (!(totalElapsedMs > 0)) throw new Error('SSE parser benchmark timer did not advance');
  const charsPerSecond = Math.round((totalChars / totalElapsedMs) * 1_000);

  process.stdout.write(
    `SSE parser benchmark: samples=${samples}, events=${eventsPerSample}, ` +
      `payload=${payloadChars}, chunk=${chunkChars}\n` +
      `batch p50=${nearestRank(elapsedSamples, 0.5).toFixed(4)}ms, ` +
      `p95=${nearestRank(elapsedSamples, 0.95).toFixed(4)}ms, ` +
      `p99=${nearestRank(elapsedSamples, 0.99).toFixed(4)}ms, ` +
      `${charsPerSecond.toLocaleString('en-US')} chars/s, checksum=${checksum.toString(16)}\n`,
  );
  for (const [value, percentile] of [
    [nearestRank(elapsedSamples, 0.5), 0.5],
    [nearestRank(elapsedSamples, 0.95), 0.95],
    [nearestRank(elapsedSamples, 0.99), 0.99],
  ] as const) {
    emitPerfMetric({
      name: 'sse-incremental-parse-batch-latency',
      value,
      unit: 'ms/batch',
      direction: 'lower',
      percentile,
      sampleSize: samples,
    });
  }
  emitPerfMetric({
    name: 'sse-incremental-parse-throughput',
    value: charsPerSecond,
    unit: 'chars/s',
    direction: 'higher',
    sampleSize: totalChars,
  });
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}
