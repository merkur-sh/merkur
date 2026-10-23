import { expect, jest, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { killDaemon, observeDaemonClose } from './daemon-process';

class HeldDaemon extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

test('daemon teardown waits for actual close beyond the former force-kill deadline', async () => {
  jest.useFakeTimers();
  try {
    const child = new HeldDaemon();
    observeDaemonClose(child);
    let completed = false;
    const stop = killDaemon(child).then(() => {
      completed = true;
    });
    jest.advanceTimersByTime(6_000);
    await Promise.resolve();
    const signalsBeforeClose = [...child.signals];
    const completedBeforeClose = completed;
    child.exitCode = 0;
    child.emit('close');
    await stop;

    expect(signalsBeforeClose).toEqual(['SIGTERM']);
    expect(completedBeforeClose).toBe(false);
    expect(completed).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test('an exit status cannot substitute for daemon pipe close', async () => {
  const child = new HeldDaemon();
  observeDaemonClose(child);
  child.exitCode = 0;
  let completed = false;
  const stop = killDaemon(child).then(() => {
    completed = true;
  });
  await Promise.resolve();
  const completedBeforeClose = completed;
  child.emit('close');
  await stop;

  expect(completedBeforeClose).toBe(false);
  expect(child.signals).toEqual([]);
  expect(completed).toBe(true);
});

test('teardown observes an already-closed daemon without another signal', async () => {
  const child = new HeldDaemon();
  observeDaemonClose(child);
  child.exitCode = 0;
  child.emit('close');
  await killDaemon(child);
  expect(child.signals).toEqual([]);
});

test('overlapping teardown calls send SIGTERM once and join the same close fence', async () => {
  const child = new HeldDaemon();
  observeDaemonClose(child);
  const first = killDaemon(child);
  const second = killDaemon(child);
  child.exitCode = 0;
  child.emit('close');
  await Promise.all([first, second]);
  expect(child.signals).toEqual(['SIGTERM']);
});
