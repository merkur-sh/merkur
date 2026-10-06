import { expect, test } from 'bun:test';
import type { NativePerfTraceChunk } from '../../../packages/shared/src/native-perf-trace';
import { collectDaemonPerfTraceCapture } from './daemon-perf-trace-capture';

function chunk(overrides: Partial<NativePerfTraceChunk> = {}): NativePerfTraceChunk {
  return {
    command_id: 'capture-1',
    owner: 1,
    peer_id: 'peer-1',
    session_id: 'session-1',
    observation_epoch: 1,
    attempted: 1,
    dropped: 0,
    stale: 0,
    record_count: 1,
    first_ordinal: 1,
    last_ordinal: 1,
    chunk_index: 0,
    chunk_count: 1,
    records: [{ ordinal: 1, owner: 1, at_us: 42, kind: 'pty_write', fields: Array(16).fill(0) }],
    ...overrides,
  };
}

function log(message: string, context: object): string {
  return `${JSON.stringify({ message, context: { daemonId: 'daemon-1', captureRequestedAtMs: 100, ...context } })}\n`;
}

function completion(overrides: object = {}): string {
  return log('daemon_perf_trace_capture_complete', {
    commandId: 'capture-1',
    captureCompletedAtMs: 101,
    chunkCount: 1,
    recordCount: 1,
    ...overrides,
  });
}

test('native capture requires its exact fresh daemon and command identity', () => {
  const raw = log('daemon_perf_trace_chunk', { chunk: chunk() }) + completion();
  const capture = collectDaemonPerfTraceCapture(raw, 'daemon-1', 100);
  expect(capture.status).toBe('complete');
  expect(capture.terminalMarkerSeen).toBe(true);
  expect(capture.chunks).toEqual([chunk()]);
  expect(capture.rawLog).toBe(raw);
  expect(collectDaemonPerfTraceCapture(raw, 'daemon-2', 100).status).toBe('pending');
  expect(collectDaemonPerfTraceCapture(raw, 'daemon-1', 101).status).toBe('pending');
});

test('native capture never certifies missing, duplicate or miscounted chunks', () => {
  expect(collectDaemonPerfTraceCapture(completion(), 'daemon-1', 100).status).toBe('invalid');
  const entry = log('daemon_perf_trace_chunk', { chunk: chunk() });
  expect(collectDaemonPerfTraceCapture(entry + entry + completion(), 'daemon-1', 100).status).toBe(
    'invalid',
  );
  expect(
    collectDaemonPerfTraceCapture(entry + completion({ recordCount: 2 }), 'daemon-1', 100).status,
  ).toBe('invalid');
  expect(
    collectDaemonPerfTraceCapture(entry + completion({ commandId: 'capture-2' }), 'daemon-1', 100)
      .status,
  ).toBe('invalid');
  expect(collectDaemonPerfTraceCapture(entry + completion() + entry, 'daemon-1', 100).status).toBe(
    'invalid',
  );
});

test('failed native export retains partial chunks and its raw failure', () => {
  const raw =
    log('daemon_perf_trace_chunk', { chunk: chunk() }) +
    log('daemon_perf_trace_capture_failed', { commandId: 'capture-1', reason: 'timeout' });
  const capture = collectDaemonPerfTraceCapture(raw, 'daemon-1', 100);
  expect(capture.status).toBe('failed');
  expect(capture.terminalMarkerSeen).toBe(true);
  expect(capture.chunks).toHaveLength(1);
  expect(capture.errors).toContain('native capture failed: timeout');
  expect(capture.rawLog).toBe(raw);
});

test('native export completeness does not erase collection losses or stale ownership', () => {
  const entry = chunk({ attempted: 4, dropped: 3, stale: 2 });
  const capture = collectDaemonPerfTraceCapture(
    log('daemon_perf_trace_chunk', { chunk: entry }) + completion(),
    'daemon-1',
    100,
  );
  expect(capture.status).toBe('complete');
  expect(capture.chunks[0]?.dropped).toBe(3);
  expect(capture.chunks[0]?.stale).toBe(2);
});

test('malformed native records remain invalid while awaiting the final marker', () => {
  const capture = collectDaemonPerfTraceCapture(
    log('daemon_perf_trace_chunk', { chunk: chunk({ records: [] }) }),
    'daemon-1',
    100,
  );
  expect(capture.status).toBe('invalid');
  expect(capture.terminalMarkerSeen).toBe(false);
});
