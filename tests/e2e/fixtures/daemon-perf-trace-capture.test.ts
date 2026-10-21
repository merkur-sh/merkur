import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectDaemonPerfTraceCapture } from './daemon-perf-trace-capture';

/** The capture `merkur-trace`'s file test writes byte for byte. */
const FIXTURE = readFileSync(
  path.join(import.meta.dir, '../../../packages/merkur-trace/testdata/capture.mtrace'),
);

function files(entries: Record<string, Uint8Array>) {
  return (file: string): Uint8Array => {
    const bytes = entries[file];
    if (bytes === undefined) throw new Error(`ENOENT: ${file}`);
    return bytes;
  };
}

function log(message: string, context: object): string {
  return `${JSON.stringify({ message, context: { daemonId: 'daemon-1', captureRequestedAtMs: 100, ...context } })}\n`;
}

function completion(overrides: object = {}): string {
  return log('daemon_perf_trace_capture_complete', {
    commandId: 'capture-1',
    captureCompletedAtMs: 101,
    path: '/profiles/capture-1.mtrace',
    ...overrides,
  });
}

const read = files({ '/profiles/capture-1.mtrace': FIXTURE });

test('native capture requires its exact fresh daemon and command identity', () => {
  const raw = completion();
  const capture = collectDaemonPerfTraceCapture(raw, 'daemon-1', 100, read);
  expect(capture.status).toBe('complete');
  expect(capture.terminalMarkerSeen).toBe(true);
  expect(capture.commandId).toBe('capture-1');
  expect(capture.path).toBe('/profiles/capture-1.mtrace');
  expect(capture.trace?.sessionId).toBe('session-12345678');
  expect(capture.trace?.records.map((record) => record.ordinal)).toEqual([11, 12]);
  expect(capture.rawLog).toBe(raw);
  expect(collectDaemonPerfTraceCapture(raw, 'daemon-2', 100, read).status).toBe('pending');
  expect(collectDaemonPerfTraceCapture(raw, 'daemon-1', 101, read).status).toBe('pending');
});

test('native capture never certifies a missing, malformed or doubled capture', () => {
  const missingPath = completion({ path: undefined });
  expect(collectDaemonPerfTraceCapture(missingPath, 'daemon-1', 100, read).status).toBe('invalid');
  const absent = completion({ path: '/profiles/absent.mtrace' });
  expect(collectDaemonPerfTraceCapture(absent, 'daemon-1', 100, read).status).toBe('invalid');
  const truncated = files({ '/profiles/capture-1.mtrace': FIXTURE.subarray(0, 64) });
  const malformed = collectDaemonPerfTraceCapture(completion(), 'daemon-1', 100, truncated);
  expect(malformed.status).toBe('invalid');
  expect(malformed.trace).toBeNull();
  expect(malformed.errors[0]).toStartWith('malformed native capture');
  const doubled = completion() + completion({ commandId: 'capture-2' });
  expect(collectDaemonPerfTraceCapture(doubled, 'daemon-1', 100, read).status).toBe('invalid');
});

test('failed native export retains its raw failure', () => {
  const raw = log('daemon_perf_trace_capture_failed', {
    commandId: 'capture-1',
    reason: 'write_failed',
  });
  const capture = collectDaemonPerfTraceCapture(raw, 'daemon-1', 100, read);
  expect(capture.status).toBe('failed');
  expect(capture.terminalMarkerSeen).toBe(true);
  expect(capture.trace).toBeNull();
  expect(capture.errors).toContain('native capture failed: write_failed');
  expect(capture.rawLog).toBe(raw);
});

test('native export completeness does not erase collection losses or stale ownership', () => {
  const capture = collectDaemonPerfTraceCapture(completion(), 'daemon-1', 100, read);
  expect(capture.status).toBe('complete');
  expect(capture.trace?.dropped).toBe(1);
  expect(capture.trace?.stale).toBe(2);
});

test('a capture stays pending until its final marker', () => {
  const capture = collectDaemonPerfTraceCapture('', 'daemon-1', 100, read);
  expect(capture.status).toBe('pending');
  expect(capture.terminalMarkerSeen).toBe(false);
});
