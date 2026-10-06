import { describe, expect, test } from 'bun:test';

import { createPerfSessionStamper } from './perf-session-stamp';
import type { TerminalPerfEvent } from './terminal-latency';

function inputAck(atMs: number, inputSeq: number): TerminalPerfEvent {
  return { kind: 'input_ack', atMs, inputSeq, networkRttMs: null };
}

describe('createPerfSessionStamper', () => {
  test('stamps the build on every row, including ones with no session id yet', () => {
    // Unconditional, unlike the session id: the build is a constant folded in
    // at bundle time, so it is known before the first event. A row that ships
    // without it could not be attributed to a release, which is the whole
    // reason the field exists — and the startup window, the part that is
    // unattributed longest, is exactly the part worth comparing across builds.
    const rows = createPerfSessionStamper().stamp([
      { kind: 'session_start', atMs: 1 },
      inputAck(2, 1),
      {
        kind: 'session_bound',
        atMs: 3,
        merkurSessionId: 'sess-a',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
      inputAck(4, 2),
    ]);

    // 'dev' under test: `process.env.MERKUR_VERSION` is defined only by the
    // Docker/Vite build, and `merkurVersion()` falls back for a source run.
    expect(rows.map((row) => row.merkur_version)).toEqual(['dev', 'dev', 'dev', 'dev']);
  });

  test('stamps every row after the session id is announced', () => {
    const rows = createPerfSessionStamper().stamp([
      { kind: 'session_start', atMs: 1 },
      {
        kind: 'session_bound',
        atMs: 2,
        merkurSessionId: 'sess-a',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
      inputAck(3, 1),
      inputAck(4, 2),
    ]);

    expect(rows.map((row) => row.merkur_session_id)).toEqual([
      'sess-a',
      'sess-a',
      'sess-a',
      'sess-a',
    ]);
  });

  test('back-fills the startup window that precedes the announcement', () => {
    // The ~600ms between session_start and connect is exactly the span worth
    // attributing: it is where the startup funnel lives.
    const rows = createPerfSessionStamper().stamp([
      { kind: 'session_start', atMs: 1 },
      {
        kind: 'startup_milestone',
        atMs: 2,
        attemptId: 1,
        deviceId: 'd',
        milestone: 'worker_ready',
        elapsedMs: 58,
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
      },
      {
        kind: 'session_bound',
        atMs: 3,
        merkurSessionId: 'sess-a',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
    ]);

    expect(rows[1]?.merkur_session_id).toBe('sess-a');
  });

  test('carries the id across batches', () => {
    const stamper = createPerfSessionStamper();
    stamper.stamp([
      { kind: 'session_start', atMs: 1 },
      {
        kind: 'session_bound',
        atMs: 2,
        merkurSessionId: 'sess-a',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
    ]);

    const later = stamper.stamp([inputAck(50, 9)]);
    expect(later[0]?.merkur_session_id).toBe('sess-a');
  });

  test('never inherits the previous session id across a new session_start', () => {
    // Attributing a new session's rows to the previous trace is worse than
    // leaving them unattributed, so the id clears at the boundary.
    const stamper = createPerfSessionStamper();
    stamper.stamp([
      { kind: 'session_start', atMs: 1 },
      {
        kind: 'session_bound',
        atMs: 2,
        merkurSessionId: 'sess-a',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
    ]);

    const rows = stamper.stamp([{ kind: 'session_start', atMs: 10 }, inputAck(11, 1)]);
    expect(rows[0]?.merkur_session_id).toBeUndefined();
    expect(rows[1]?.merkur_session_id).toBeUndefined();
  });

  test('re-stamps correctly when a second session is bound in the same batch', () => {
    const rows = createPerfSessionStamper().stamp([
      { kind: 'session_start', atMs: 1 },
      {
        kind: 'session_bound',
        atMs: 2,
        merkurSessionId: 'sess-a',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
      inputAck(3, 1),
      { kind: 'session_start', atMs: 10 },
      inputAck(11, 1),
      {
        kind: 'session_bound',
        atMs: 12,
        merkurSessionId: 'sess-b',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
      inputAck(13, 2),
    ]);

    expect(rows.map((row) => row.merkur_session_id)).toEqual([
      'sess-a',
      'sess-a',
      'sess-a',
      'sess-b',
      'sess-b',
      'sess-b',
      'sess-b',
    ]);
  });

  test('leaves a startup tail unstamped when its announcement lands in a later batch', () => {
    // Back-fill cannot cross a batch boundary. Delaying the batch to wait for
    // the id would trade a visible gap for a hidden one.
    const stamper = createPerfSessionStamper();
    const first = stamper.stamp([{ kind: 'session_start', atMs: 1 }, inputAck(2, 1)]);
    expect(first.every((row) => row.merkur_session_id === undefined)).toBe(true);

    const second = stamper.stamp([
      {
        kind: 'session_bound',
        atMs: 3,
        merkurSessionId: 'sess-a',
        networkType: 'unavailable',
        effectiveType: 'unavailable',
      },
      inputAck(4, 2),
    ]);
    expect(second.map((row) => row.merkur_session_id)).toEqual(['sess-a', 'sess-a']);
  });
});

test('failed startup outcomes ship without inheriting a later session binding', () => {
  const event: TerminalPerfEvent = {
    kind: 'recovery_outcome',
    atMs: 1,
    ownerId: 'owner',
    attemptId: 1,
    carrierId: 0,
    issuanceId: 'issuance',
    sessionId: '',
    trigger: 'initial',
    phase: 'issuance_requested',
    endReason: 'issuance_failed',
    cancellationInitiator: 'attempt',
    durationMs: 100,
    capabilityRemainingMs: 0,
    retryIndex: 0,
    backoffDelayMs: 0,
    handshakeAdmissionMs: 0,
    signalingOutcome: 'not_started',
    interactiveOutcome: 'not_started',
    bulkOutcome: 'not_started',
  };
  const rows = createPerfSessionStamper().stamp([
    event,
    {
      kind: 'session_bound',
      atMs: 2,
      merkurSessionId: 'later',
      networkType: 'unavailable',
      effectiveType: 'unavailable',
    },
  ]);
  expect(rows[0]?.merkur_session_id).toBe('');
  expect(rows[0]?.owner_id).toBe('owner');
});
