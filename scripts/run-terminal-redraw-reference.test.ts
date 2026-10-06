import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  analyzeReferenceRedrawContent,
  summarizeReferenceRedrawContent,
} from '../tests/e2e/fixtures/reference-redraw-content';
import {
  analyzeReferenceRedrawTrace,
  type ReferenceTerminalEvent,
  summarizeReferenceRedrawSamples,
} from '../tests/e2e/fixtures/terminal-redraw-reference';
import { validateArtifact } from './run-terminal-redraw-reference';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function evidence() {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-reference-replay-'));
  directories.push(directory);
  const output = path.join(directory, 'reference.json');
  const rawPath = path.join(directory, 'events.json.gz');
  const windows = [
    {
      index: 0,
      readyMarker: 'ready',
      finalMarker: 'final',
      openedAtMs: 4,
      triggerDispatchCompletedAtMs: 6,
      closedAtMs: 40,
    },
  ];
  const events: ReferenceTerminalEvent[] = [
    { kind: 'input_queued', atMs: 5, inputSeq: 7, byteLength: 1 },
    ...(['display_received', 'worker_display_applied'] as const).map((kind, index) => ({
      kind,
      atMs: 9 + index,
      displaySeq: 1,
      generation: 1,
      inputSeq: 7,
      frameId: 1,
      byteLength: 64,
      rowCount: 36,
      displayKind: 'display_delta' as const,
    })),
    { kind: 'render_start', atMs: 11, renderSeq: 1, displayInputSeq: 7 },
    {
      kind: 'render_end',
      atMs: 11.5,
      renderSeq: 1,
      completionMode: 'gpu-queue',
      atlasUploaded: false,
    },
    {
      kind: 'frame_complete',
      atMs: 12,
      renderSeq: 1,
      displayInputSeq: 7,
      predictionInputSeq: 0,
      visiblePredictionInputSeqs: [],
      visiblePredictionInputSeqsTruncated: false,
      queuedDisplayFrames: 0,
      pollCount: 0,
      previousPollAtMs: 0,
    },
  ];
  const observations = [1, 11.2].map((atMs, index) => ({
    ordinal: index + 1,
    atMs,
    observedAtMs: atMs + 0.1,
    stateRevision: index + 1,
    changedRows: 36,
    cursorChanged: false,
    cols: 120,
    rows: 36,
    viewportWidth: 1200,
    viewportHeight: 720,
    atlasGeneration: 1,
    atlasWidth: 1024,
    atlasHeight: 1024,
  }));
  const samples = analyzeReferenceRedrawTrace(windows, events);
  const contentSamples = analyzeReferenceRedrawContent(samples, events, observations);
  const raw = {
    schemaVersion: 3,
    windows,
    events,
    contentObservations: observations,
    telemetryWorkerStats: { recordsLost: 0 },
  };
  const expanded = Buffer.from(JSON.stringify(raw));
  const compressed = gzipSync(expanded);
  writeFileSync(rawPath, compressed);
  const artifact = {
    schemaVersion: 4,
    metricContractVersion: 3,
    profile: 'fast',
    sampleCount: 1,
    targetRttMs: 50,
    impairment: {
      seed: 123,
      baseDelayUsPerLeg: 12500,
      jitterRadiusUsPerLeg: 1250,
      datagramLossPercent: 0,
      reorder: 'none',
      scenario: 'steady',
    },
    samples,
    contentSamples,
    summary: summarizeReferenceRedrawSamples(samples),
    contentSummary: summarizeReferenceRedrawContent(contentSamples),
    rawTrace: {
      path: rawPath,
      compression: 'gzip',
      uncompressedBytes: expanded.length,
      compressedBytes: compressed.length,
      sha256: createHash('sha256').update(compressed).digest('hex'),
      commonEventCount: events.length,
      telemetryRecordsLost: 0,
    },
  };
  const validate = () => {
    writeFileSync(output, JSON.stringify(artifact));
    validateArtifact(output, 'fast', 1, 123);
  };
  return { artifact, raw, validate };
}

test('reference acceptance replays every retained sample and headline distribution', () => {
  expect(() => evidence().validate()).not.toThrow();
  for (const group of ['summary', 'contentSummary'] as const) {
    const fixture = evidence();
    const first = Object.values(fixture.artifact[group])[0];
    if (first === undefined) throw new Error('missing fixture distribution');
    fixture.artifact[group].poison = { ...first, p99: 0 };
    expect(fixture.validate).toThrow('headline distributions');
  }
});

test('reference acceptance rejects stale contracts and fabricated raw counts or loss', () => {
  const metric = evidence();
  metric.artifact.metricContractVersion = 2;
  expect(metric.validate).toThrow('current redraw reference');
  for (const field of [
    'uncompressedBytes',
    'compressedBytes',
    'commonEventCount',
    'telemetryRecordsLost',
  ] as const) {
    const fixture = evidence();
    fixture.artifact.rawTrace[field] += 1;
    expect(fixture.validate).toThrow('accounting');
  }
  const network = evidence();
  network.artifact.impairment.datagramLossPercent = 1;
  expect(network.validate).toThrow('deterministic seed');
});
