import { describe, expect, test } from 'bun:test';

import type { WorkerCommand } from '../terminal-worker-protocol';
import { DEFAULT_TERMINAL_FONT } from './fonts';
import {
  createWorkerControlQueue,
  workerControlCommandBlocksDataPlane,
} from './worker-control-queue';

const health: WorkerCommand = { kind: 'worker_health_check' };

describe('worker control queue', () => {
  test('an adversarial superseding flood has fixed depth and retains the latest state', () => {
    const queue = createWorkerControlQueue(16);
    for (let index = 1; index <= 10_000; index += 1) {
      expect(queue.push({ kind: 'resize', cols: index, rows: 24 })).toBe(true);
      expect(queue.push({ kind: 'font_update', fontSize: index, lineHeight: 1.2 })).toBe(true);
      expect(queue.push({ kind: 'set_preedit', text: `${index}`, caret: 0 })).toBe(true);
      expect(queue.push(health)).toBe(true);
      expect(queue.push({ kind: 'display_available' })).toBe(true);
    }

    expect(queue.size()).toBe(5);
    expect(queue.highWater()).toBe(5);
    const drained: WorkerCommand[] = [];
    for (let command = queue.shift(); command !== undefined; command = queue.shift()) {
      drained.push(command);
    }
    expect(drained.map((command) => command.kind)).toEqual([
      'resize',
      'font_update',
      'set_preedit',
      'worker_health_check',
      'display_available',
    ]);
    expect(drained[0]).toEqual({ kind: 'resize', cols: 10_000, rows: 24 });
  });

  test('superseding never crosses an exact observation or ownership boundary', () => {
    const queue = createWorkerControlQueue(8);
    expect(queue.push({ kind: 'resize', cols: 80, rows: 24 })).toBe(true);
    expect(queue.push({ kind: 'get_viewport_rows', watch: false })).toBe(true);
    expect(queue.push({ kind: 'resize', cols: 120, rows: 40 })).toBe(true);

    expect(queue.size()).toBe(3);
    expect(queue.shift()).toEqual({ kind: 'resize', cols: 80, rows: 24 });
    expect(queue.shift()).toEqual({ kind: 'get_viewport_rows', watch: false });
    expect(queue.shift()).toEqual({ kind: 'resize', cols: 120, rows: 40 });
  });

  test('a display-ring counter read keeps its exact position between setters', () => {
    const queue = createWorkerControlQueue(8);
    const boundary: WorkerCommand = {
      kind: 'profiling_read_display_ring_boundary',
      observationEpoch: 4,
      requestId: 9,
    };
    expect(queue.push({ kind: 'resize', cols: 80, rows: 24 })).toBe(true);
    expect(queue.push(boundary)).toBe(true);
    expect(queue.push({ kind: 'resize', cols: 120, rows: 40 })).toBe(true);

    expect(queue.size()).toBe(3);
    expect(queue.shift()).toEqual({ kind: 'resize', cols: 80, rows: 24 });
    expect(queue.shift()).toEqual(boundary);
    expect(queue.shift()).toEqual({ kind: 'resize', cols: 120, rows: 40 });
  });

  test('the strict bound fails closed for exact commands without growing storage', () => {
    const queue = createWorkerControlQueue(3);
    expect(queue.push({ kind: 'get_viewport_rows', watch: false })).toBe(true);
    expect(queue.push({ kind: 'worker_health_check' })).toBe(true);
    expect(queue.push({ kind: 'profiling_force_display_resync' })).toBe(true);
    expect(queue.push({ kind: 'get_viewport_rows', watch: false })).toBe(false);
    expect(queue.size()).toBe(3);
    expect(queue.highWater()).toBe(3);
  });

  test('shutdown always supersedes bounded queued work', () => {
    const queue = createWorkerControlQueue(2);
    expect(queue.push({ kind: 'get_viewport_rows', watch: false })).toBe(true);
    expect(queue.push({ kind: 'worker_health_check' })).toBe(true);
    expect(queue.push({ kind: 'shutdown' })).toBe(true);
    expect(queue.size()).toBe(1);
    expect(queue.shift()).toEqual({ kind: 'shutdown' });
  });

  test('authenticated ownership blocks data-plane fairness until handled', () => {
    const queue = createWorkerControlQueue(8);
    expect(queue.push({ kind: 'resize', cols: 80, rows: 24 })).toBe(true);
    expect(queue.hasDataPlaneBarrier()).toBe(false);

    expect(queue.push({ kind: 'session_epoch' })).toBe(true);
    expect(queue.hasDataPlaneBarrier()).toBe(true);
    queue.shift();
    expect(queue.hasDataPlaneBarrier()).toBe(true);
    queue.shift();
    expect(queue.hasDataPlaneBarrier()).toBe(false);
  });

  test('only active ownership transitions block data-plane progress across an await', () => {
    expect(workerControlCommandBlocksDataPlane({ kind: 'worker_health_check' })).toBe(false);
    expect(
      workerControlCommandBlocksDataPlane({
        kind: 'profiling_read_display_ring_boundary',
        observationEpoch: 1,
        requestId: 1,
      }),
    ).toBe(false);
    expect(
      workerControlCommandBlocksDataPlane({
        kind: 'font_family_update',
        fontFamily: DEFAULT_TERMINAL_FONT,
      }),
    ).toBe(false);
    expect(workerControlCommandBlocksDataPlane({ kind: 'session_epoch' })).toBe(true);
    expect(workerControlCommandBlocksDataPlane({ kind: 'shutdown' })).toBe(true);
  });

  test('consumed prefixes are compacted under sustained enqueue/drain traffic', () => {
    const queue = createWorkerControlQueue(4);
    for (let index = 0; index < 1_000; index += 1) {
      expect(queue.push({ kind: 'get_viewport_rows', watch: false })).toBe(true);
      expect(queue.shift()).toEqual({ kind: 'get_viewport_rows', watch: false });
    }
    expect(queue.size()).toBe(0);
    expect(queue.highWater()).toBe(1);
  });
});
