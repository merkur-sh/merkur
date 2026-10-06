import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./browser-client-session.ts', import.meta.url), 'utf8');
const start = source.indexOf('  function runLane(');
const end = source.indexOf('\n  }', start);
if (start < 0 || end < start) throw new Error('missing session lane owner');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 4));

test.each([false, true])('work queued during retirement drains on lane io=%s', async (io) => {
  let drains = 0;
  let queued = false;
  const delivered: number[] = [];
  const context = {
    active: true,
    generation: 1,
    requested: [false, false],
    draining: [null, null],
    failed(error: unknown) {
      throw error;
    },
    onDrain(_owner: number, selectedIo: boolean) {
      expect(selectedIo).toBe(io);
      drains++;
      if (queued) {
        delivered.push(1);
        queued = false;
      }
    },
  };
  const runLane = runInNewContext(
    `${program}\nasync function drain(owner, io) { onDrain(owner, io); }\nrunLane;`,
    context,
  ) as (io: boolean) => Promise<void>;
  const idle = runLane(io);
  // The first drain's continuation finishes its loop before this microtask.
  // Its promise finalizer is still queued when the display receipt arrives.
  let receipt: Promise<void> | null = null;
  queueMicrotask(() => {
    queued = true;
    receipt = runLane(io);
  });
  await idle;
  await receipt;
  // Allow the successor owner to retire; no third receipt may be needed.
  await Promise.resolve();
  expect(delivered).toEqual([1]);
  expect(drains).toBe(2);
  expect(context.requested).toEqual([false, false]);
  expect(context.draining).toEqual([null, null]);
});

test('retiring a stopped session does not restart its queued display work', async () => {
  let drains = 0;
  const context = {
    active: true,
    generation: 1,
    requested: [false, false],
    draining: [null, null],
    failed(error: unknown) {
      throw error;
    },
    onDrain() {
      drains++;
    },
  };
  const runLane = runInNewContext(
    `${program}\nasync function drain() { onDrain(); }\nrunLane;`,
    context,
  ) as (io: boolean) => Promise<void>;
  const idle = runLane(false);
  queueMicrotask(() => {
    void runLane(false);
    context.active = false;
    context.generation++;
  });
  await idle;
  await Promise.resolve();
  expect(drains).toBe(1);
  expect(context.draining).toEqual([null, null]);
});
