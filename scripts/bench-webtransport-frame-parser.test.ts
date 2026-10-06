import { describe, expect, test } from 'bun:test';

import { parsePerfMetrics } from './perf/harness';
import { runTestProcess } from './test-process';

const ROOT = new URL('..', import.meta.url).pathname;
const EXPECTED_CASES = [
  'one-chunk-1b',
  'one-chunk-64b',
  'one-chunk-1kib',
  'one-chunk-16kib',
  'one-chunk-64kib',
  'one-chunk-1mib',
  'fragmented-header-1b-body-1kib-64kib',
] as const;

describe('WebTransport frame parser benchmark', () => {
  test('reports production parser metrics and exact dispatch ownership invariants', async () => {
    const { exitCode, stdout, stderr } = await runTestProcess(
      ['bun', 'run', 'scripts/bench-webtransport-frame-parser.ts'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          BENCH_SAMPLES: '2',
          BENCH_WARMUPS: '0',
          BENCH_TARGET_FRAMED_BYTES_PER_SAMPLE: '4096',
        },
      },
    );

    expect(exitCode, stderr).toBe(0);
    const metrics = parsePerfMetrics(stdout);
    expect(metrics).toHaveLength(EXPECTED_CASES.length * 4);
    expect(metrics.every((metric) => metric.value > 0)).toBe(true);
    expect(metrics.filter((metric) => metric.unit === 'ms/frame')).toHaveLength(
      EXPECTED_CASES.length * 3,
    );
    expect(metrics.filter((metric) => metric.unit === 'framed-bytes/s')).toHaveLength(
      EXPECTED_CASES.length,
    );

    const artifactLine = stdout
      .split(/\r?\n/)
      .find((line) =>
        line.startsWith('{"schemaVersion":1,"benchmark":"webtransport-frame-parser"'),
      );
    if (artifactLine === undefined) throw new Error('benchmark artifact line is missing');
    const artifact: unknown = JSON.parse(artifactLine);
    if (!isBenchmarkArtifact(artifact)) throw new Error('benchmark artifact shape is invalid');

    expect(artifact.samples).toBe(2);
    expect(artifact.warmups).toBe(0);
    expect(artifact.cases.map((item) => item.name)).toEqual([...EXPECTED_CASES]);
    for (const item of artifact.cases) {
      expect(item.ownershipVerified).toBe(true);
      expect(item.dispatchedFrames).toBe(item.framesPerSample * artifact.samples);
      expect(item.dispatchedBytes).toBe(item.dispatchedFrames * item.payloadBytes);
      expect(item.framedBytes).toBe(item.dispatchedFrames * (item.payloadBytes + 4));
      expect(item.latencySamplesMsPerFrame).toHaveLength(artifact.samples);
    }
    expect(artifact.cases.at(-1)?.pushesPerFrame).toBe(68);
  }, 10_000);
});

interface ArtifactCase {
  readonly name: string;
  readonly payloadBytes: number;
  readonly pushesPerFrame: number;
  readonly framesPerSample: number;
  readonly ownershipVerified: boolean;
  readonly dispatchedFrames: number;
  readonly dispatchedBytes: number;
  readonly framedBytes: number;
  readonly latencySamplesMsPerFrame: readonly number[];
}

interface BenchmarkArtifact {
  readonly samples: number;
  readonly warmups: number;
  readonly cases: readonly ArtifactCase[];
}

function isBenchmarkArtifact(value: unknown): value is BenchmarkArtifact {
  if (!isRecord(value) || !Array.isArray(value.cases)) return false;
  if (!Number.isSafeInteger(value.samples) || !Number.isSafeInteger(value.warmups)) return false;
  return value.cases.every(
    (item) =>
      isRecord(item) &&
      typeof item.name === 'string' &&
      typeof item.payloadBytes === 'number' &&
      typeof item.pushesPerFrame === 'number' &&
      typeof item.framesPerSample === 'number' &&
      item.ownershipVerified === true &&
      typeof item.dispatchedFrames === 'number' &&
      typeof item.dispatchedBytes === 'number' &&
      typeof item.framedBytes === 'number' &&
      Array.isArray(item.latencySamplesMsPerFrame) &&
      item.latencySamplesMsPerFrame.every((sample) => typeof sample === 'number'),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
