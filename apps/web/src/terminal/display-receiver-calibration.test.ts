import { describe, expect, test } from 'bun:test';
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_MESSAGE_TYPE_OFFSET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MESSAGE_TYPE_DISPLAY_PATCH,
} from '@merkur/shared';
import {
  createDisplayReceiverCalibrationRun,
  createDisplayReceiverCalibrationScheduler,
  DISPLAY_RECEIVER_CALIBRATION_COLS,
  DISPLAY_RECEIVER_CALIBRATION_ROWS,
  type DisplayReceiverCalibrationRun,
  type DisplayReceiverCalibrationTerminal,
} from './display-receiver-calibration';
import type { DisplayReceiverProfileWriter } from './display-receiver-profile';

class FakeCalibrationTerminal implements DisplayReceiverCalibrationTerminal {
  readonly rawFrames: Uint8Array[] = [];
  readonly stagedFrames: Uint8Array[] = [];
  dictionaryInstalls = 0;
  dictionaryClears = 0;
  orderingResets = 0;
  releases = 0;
  destroys = 0;
  rejectRaw = false;
  rejectValidation = false;
  rejectFused = false;

  destroy(): void {
    this.destroys += 1;
  }

  applyDelta(data: Uint8Array, _seq: number): boolean {
    this.rawFrames.push(data);
    return !this.rejectRaw;
  }

  installDisplayDictionary(
    _generation: number,
    _id: number,
    _hash: number,
    _bytes: Uint8Array,
  ): boolean {
    this.dictionaryInstalls += 1;
    return true;
  }

  clearDisplayDictionaries(): void {
    this.dictionaryClears += 1;
  }

  stageDisplayFrame(data: Uint8Array): number {
    this.stagedFrames.push(data);
    return this.stagedFrames.length;
  }

  validateStagedFrame(_handle: number): boolean {
    return !this.rejectValidation;
  }

  applyStagedDelta(_handle: number, _seq: number): boolean {
    return !this.rejectFused;
  }

  releaseStagedFrame(_handle: number): void {
    this.releases += 1;
  }

  resetDisplayOrdering(): void {
    this.orderingResets += 1;
  }

  takeLastError(): string | null {
    return 'synthetic_rejection';
  }
}

interface WriterProbe {
  readonly writer: DisplayReceiverProfileWriter;
  readonly raw: Array<readonly [number, number]>;
  readonly compressed: Array<readonly [number, number, boolean, number]>;
  publishes: number;
}

function createWriterProbe(): WriterProbe {
  const probe: WriterProbe = {
    raw: [],
    compressed: [],
    publishes: 0,
    writer: {
      recordRaw(rawBytes, validationApplyUs): void {
        probe.raw.push([rawBytes, validationApplyUs]);
      },
      recordCompressed(rawBytes, wireBytes, dictionary, fusedValidationApplyUs): void {
        probe.compressed.push([rawBytes, wireBytes, dictionary, fusedValidationApplyUs]);
      },
      publish(): void {
        probe.publishes += 1;
      },
    },
  };
  return probe;
}

function drive(run: DisplayReceiverCalibrationRun, maximumSteps = 1_000): string {
  for (let step = 0; step < maximumSteps; step += 1) {
    const result = run.step();
    if (result.status === 'complete') return 'complete';
    if (result.status === 'failed') return result.error;
  }
  throw new Error('calibration did not finish within its fixed work bound');
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

class ManualTasks {
  private nextId = 1;
  private readonly tasks = new Map<number, () => void>();

  schedule = (callback: () => void, _delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, callback);
    return id;
  };

  cancel = (id: number): void => {
    this.tasks.delete(id);
  };

  runNext(): boolean {
    const entry = this.tasks.entries().next().value as [number, () => void] | undefined;
    if (entry === undefined) return false;
    this.tasks.delete(entry[0]);
    entry[1]();
    return true;
  }

  size(): number {
    return this.tasks.size;
  }
}

describe('display receiver calibration', () => {
  test('every fixture carries the exported V19 display layout and positive identities', () => {
    const terminal = new FakeCalibrationTerminal();
    const writer = createWriterProbe();
    let clock = 0;
    expect(drive(createDisplayReceiverCalibrationRun(terminal, writer.writer, () => ++clock))).toBe(
      'complete',
    );

    expect(terminal.rawFrames.length).toBeGreaterThan(0);
    const seenRows = new Set<number>();
    for (const frame of terminal.rawFrames) {
      expect(frame[DISPLAY_MESSAGE_TYPE_OFFSET]).toBe(MESSAGE_TYPE_DISPLAY_PATCH);
      expect(frame[DISPLAY_VERSION_OFFSET]).toBe(DISPLAY_PROTOCOL_VERSION);
      expect(frame[DISPLAY_PATCH_FLAGS_OFFSET]).toBe(0);
      expect(readU16(frame, DISPLAY_COLUMNS_OFFSET)).toBe(DISPLAY_RECEIVER_CALIBRATION_COLS);
      expect(readU16(frame, DISPLAY_GRID_ROWS_OFFSET)).toBe(DISPLAY_RECEIVER_CALIBRATION_ROWS);
      expect(readU32(frame, DISPLAY_SEQUENCE_OFFSET)).toBeGreaterThan(0);
      expect(readU32(frame, DISPLAY_GENERATION_OFFSET)).toBeGreaterThan(0);
      expect(readU32(frame, DISPLAY_FRAME_ID_OFFSET)).toBeGreaterThan(0);
      expect(readU32(frame, DISPLAY_PRESENTATION_ID_OFFSET)).toBeGreaterThan(0);
      expect(readU16(frame, DISPLAY_CHUNK_INDEX_OFFSET)).toBe(0);
      expect(readU16(frame, DISPLAY_CHUNK_COUNT_OFFSET)).toBe(1);
      const rowCount = readU16(frame, DISPLAY_ROW_COUNT_OFFSET);
      expect(rowCount).toBeGreaterThan(0);
      expect(frame.byteLength).toBeGreaterThan(DISPLAY_ROWS_OFFSET);
      expect(readU32(frame, DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET)).toBe(
        frame.byteLength - DISPLAY_STREAM_HEADER_BYTES,
      );
      seenRows.add(rowCount);
    }
    expect([...seenRows].sort((left, right) => left - right)).toEqual([1, 2, 4, 8, 16, 29]);
    expect(terminal.dictionaryClears).toBe(1);
    expect(terminal.orderingResets).toBe(1);
    expect(terminal.destroys).toBe(1);
  });

  test('publishes exactly once only after every fixture and measurement succeeds', () => {
    const terminal = new FakeCalibrationTerminal();
    const writer = createWriterProbe();
    const run = createDisplayReceiverCalibrationRun(terminal, writer.writer, () => 1);
    for (;;) {
      const result = run.step();
      if (result.status === 'pending') {
        expect(writer.raw).toHaveLength(0);
        expect(writer.compressed).toHaveLength(0);
        expect(writer.publishes).toBe(0);
        continue;
      }
      expect(result.status).toBe('complete');
      break;
    }
    expect(writer.raw).toHaveLength(96);
    expect(writer.compressed).toHaveLength(96);
    expect(writer.publishes).toBe(1);
  });

  test('failure and cancellation erase and free scratch state without publishing', () => {
    const rejected = new FakeCalibrationTerminal();
    rejected.rejectValidation = true;
    const rejectedWriter = createWriterProbe();
    expect(drive(createDisplayReceiverCalibrationRun(rejected, rejectedWriter.writer))).toBe(
      'rows=1 plain: synthetic_rejection',
    );
    expect(rejectedWriter.publishes).toBe(0);
    expect(rejected.dictionaryClears).toBe(1);
    expect(rejected.orderingResets).toBe(1);
    expect(rejected.destroys).toBe(1);

    const cancelled = new FakeCalibrationTerminal();
    const cancelledWriter = createWriterProbe();
    const run = createDisplayReceiverCalibrationRun(cancelled, cancelledWriter.writer);
    expect(run.step().status).toBe('pending');
    run.cancel();
    run.cancel();
    expect(cancelledWriter.publishes).toBe(0);
    expect(cancelled.dictionaryClears).toBe(1);
    expect(cancelled.orderingResets).toBe(1);
    expect(cancelled.destroys).toBe(1);
  });

  test('an unresolved cold factory cannot delay readiness and is epoch-cancellable', async () => {
    const tasks = new ManualTasks();
    let epoch = 7;
    const generation = 9;
    let ready = false;
    let complete = 0;
    let failed = 0;
    const scheduler = createDisplayReceiverCalibrationScheduler({
      createTerminal: () => new Promise<DisplayReceiverCalibrationTerminal>(() => {}),
      createRun: () => {
        throw new Error('unreachable');
      },
      currentEpoch: () => epoch,
      currentGeneration: () => generation,
      hasLiveWork: () => false,
      onComplete: () => {
        complete += 1;
      },
      onFailure: () => {
        failed += 1;
      },
      schedule: tasks.schedule,
      cancelScheduled: tasks.cancel,
    });

    scheduler.start(epoch, generation);
    ready = true;
    expect(ready).toBe(true);
    expect(tasks.runNext()).toBe(true);
    await Promise.resolve();
    epoch = 8;
    scheduler.cancel();
    expect(scheduler.isActive()).toBe(false);
    expect(complete).toBe(0);
    expect(failed).toBe(0);
    expect(tasks.size()).toBe(0);
  });

  test('a scratch terminal that resolves after cancellation is freed without running', async () => {
    const tasks = new ManualTasks();
    const scratch = new FakeCalibrationTerminal();
    const deferred: {
      resolve: ((terminal: DisplayReceiverCalibrationTerminal) => void) | null;
    } = { resolve: null };
    let creates = 0;
    const scheduler = createDisplayReceiverCalibrationScheduler({
      createTerminal: () =>
        new Promise<DisplayReceiverCalibrationTerminal>((resolve) => {
          deferred.resolve = resolve;
        }),
      createRun: () => {
        creates += 1;
        return {
          step: () => ({ status: 'complete' }),
          cancel: () => {},
        };
      },
      currentEpoch: () => 5,
      currentGeneration: () => 6,
      hasLiveWork: () => false,
      onComplete: () => {},
      onFailure: () => {},
      schedule: tasks.schedule,
      cancelScheduled: tasks.cancel,
    });
    scheduler.start(5, 6);
    expect(tasks.runNext()).toBe(true);
    scheduler.cancel();
    deferred.resolve?.(scratch);
    await Promise.resolve();
    expect(creates).toBe(0);
    expect(scratch.destroys).toBe(1);
    expect(tasks.size()).toBe(0);
  });

  test('runs one bounded step per task and yields whenever live work is pending', async () => {
    const tasks = new ManualTasks();
    const terminal = new FakeCalibrationTerminal();
    const epoch = 3;
    const generation = 4;
    let busy = true;
    let steps = 0;
    let completion = 0;
    const run: DisplayReceiverCalibrationRun = {
      step: () => {
        steps += 1;
        return steps === 3 ? { status: 'complete' } : { status: 'pending' };
      },
      cancel: () => {},
    };
    const scheduler = createDisplayReceiverCalibrationScheduler({
      createTerminal: async () => terminal,
      createRun: () => run,
      currentEpoch: () => epoch,
      currentGeneration: () => generation,
      hasLiveWork: () => busy,
      onComplete: () => {
        completion += 1;
      },
      onFailure: () => {
        throw new Error('unexpected calibration failure');
      },
      schedule: tasks.schedule,
      cancelScheduled: tasks.cancel,
    });

    scheduler.start(epoch, generation);
    expect(tasks.runNext()).toBe(true);
    await Promise.resolve();
    expect(tasks.size()).toBe(1);
    expect(tasks.runNext()).toBe(true);
    expect(steps).toBe(0);
    expect(tasks.runNext()).toBe(true);
    expect(steps).toBe(0);

    busy = false;
    expect(tasks.runNext()).toBe(true);
    expect(steps).toBe(1);
    expect(tasks.runNext()).toBe(true);
    expect(steps).toBe(2);
    expect(tasks.runNext()).toBe(true);
    expect(steps).toBe(3);
    expect(completion).toBe(1);
    expect(scheduler.isActive()).toBe(false);
  });

  test('epoch cancellation destroys only scratch state and cannot contaminate live state', async () => {
    const tasks = new ManualTasks();
    const scratch = new FakeCalibrationTerminal();
    const live = {
      grid: 'authoritative',
      predictions: 4,
      dictionaries: 2,
      coordinatorDatagrams: 3,
    };
    const epoch = 11;
    let generation = 13;
    let runCancelled = 0;
    const scheduler = createDisplayReceiverCalibrationScheduler({
      createTerminal: async () => scratch,
      createRun: () => ({
        step: () => ({ status: 'pending' }),
        cancel: () => {
          runCancelled += 1;
          scratch.destroy();
        },
      }),
      currentEpoch: () => epoch,
      currentGeneration: () => generation,
      hasLiveWork: () => false,
      onComplete: () => {},
      onFailure: () => {},
      schedule: tasks.schedule,
      cancelScheduled: tasks.cancel,
    });
    scheduler.start(epoch, generation);
    expect(tasks.runNext()).toBe(true);
    await Promise.resolve();
    expect(tasks.size()).toBe(1);
    generation = 14;
    expect(tasks.runNext()).toBe(true);
    expect(runCancelled).toBe(1);
    expect(scratch.destroys).toBe(1);
    expect(live).toEqual({
      grid: 'authoritative',
      predictions: 4,
      dictionaries: 2,
      coordinatorDatagrams: 3,
    });
  });
});
