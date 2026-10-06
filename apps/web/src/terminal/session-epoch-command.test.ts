import { describe, expect, test } from 'bun:test';

import type { WorkerCommand } from '../terminal-worker-protocol';
import { createSessionEpochCommandGate } from './session-epoch-command';

type SessionEpochCommand = Extract<WorkerCommand, { kind: 'session_epoch' }>;

describe('terminal session epoch command gate', () => {
  test('two auths before readiness publish one fence and keep the newest token', () => {
    const posted: SessionEpochCommand[] = [];
    const gate = createSessionEpochCommandGate((command) => posted.push(command));

    gate.notify(2);
    gate.notify(3);
    expect(posted).toEqual([]);
    gate.markReady();

    expect(posted).toEqual([{ kind: 'session_epoch' }]);
    expect(gate.currentFenceToken()).toBe(3);
  });

  test('two auths after readiness publish a fence each', () => {
    const posted: SessionEpochCommand[] = [];
    const gate = createSessionEpochCommandGate((command) => posted.push(command));
    gate.markReady();

    gate.notify(2);
    gate.notify(3);

    expect(posted).toEqual([{ kind: 'session_epoch' }, { kind: 'session_epoch' }]);
    expect(gate.currentFenceToken()).toBe(3);
  });

  test('a replayed owner names the same fence token', () => {
    const gate = createSessionEpochCommandGate(() => {});
    expect(gate.currentFenceToken()).toBeNull();
    // The epoch handoff notifies at transport connect and again when the worker
    // becomes ready: one transport lineage, whose token is what the worker
    // reports its first display under.
    gate.notify(3);
    gate.markReady();
    gate.notify(3);
    expect(gate.currentFenceToken()).toBe(3);
  });

  test('readiness with no epoch publishes nothing', () => {
    const posted: SessionEpochCommand[] = [];
    const gate = createSessionEpochCommandGate((command) => posted.push(command));
    gate.markReady();
    expect(posted).toEqual([]);
  });
});
