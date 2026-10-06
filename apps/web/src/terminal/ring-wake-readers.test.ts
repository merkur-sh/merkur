import { describe, expect, test } from 'bun:test';
import { createTaskWake, type TaskWake } from '../lib/task-wake';
import {
  createInputRingWriter,
  INPUT_RING_SIZE,
  wakeInputRingReader,
} from '../transport/input-ring';
import { createPredictionAdmissionBuffer } from '../transport/prediction-admission';
import {
  createFrameRingReaderForMode,
  createFrameRingWriterForMode,
  createInputRingReaderForMode,
} from './ring-wake-readers';
import { FRAME_KIND_DISPLAY, FRAME_RING_SIZE, wakeFrameRingReader } from './shared-ring';

/** A task wake that reports whether anything ever asked it to wait. */
function countingTaskWake(): TaskWake & { readonly waits: () => number } {
  const inner = createTaskWake();
  let waits = 0;
  return {
    wait(watchdogMs) {
      waits += 1;
      return inner.wait(watchdogMs);
    },
    wake: () => inner.wake(),
    dispose: () => inner.dispose(),
    waits: () => waits,
  };
}

describe('ring wake readers by mode', () => {
  test("'native': the frame writer posts nothing on the port and the frame reader parks natively", async () => {
    const channel = new MessageChannel();
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const taskWake = countingTaskWake();
    let portMessages = 0;
    channel.port2.onmessage = () => {
      portMessages += 1;
    };
    const writer = createFrameRingWriterForMode('native', sab, channel.port1);
    const reader = createFrameRingReaderForMode('native', sab, taskWake);

    const parked = reader.waitAsync();
    if (parked === 'not-equal') throw new Error('empty frame reader did not park');
    expect(writer.write(Uint8Array.of(1), FRAME_KIND_DISPLAY, false)).toBe(true);
    await parked;
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(1));
    // Let any port delivery that might have been queued run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(portMessages).toBe(0);
    expect(taskWake.waits()).toBe(0);

    const again = reader.waitAsync();
    if (again === 'not-equal') throw new Error('drained frame reader did not park');
    expect(wakeFrameRingReader(sab)).toBe(1);
    await again;
    channel.port1.close();
    channel.port2.close();
  });

  test("'task': the frame writer's edge crosses the port the same way", async () => {
    const channel = new MessageChannel();
    const sab = new SharedArrayBuffer(FRAME_RING_SIZE);
    const taskWake = countingTaskWake();
    const portData: unknown[] = [];
    channel.port2.onmessage = (event) => {
      portData.push(event.data);
      taskWake.wake();
    };
    const writer = createFrameRingWriterForMode('task', sab, channel.port1);
    const reader = createFrameRingReaderForMode('task', sab, taskWake);

    const parked = reader.waitAsync();
    if (parked === 'not-equal') throw new Error('empty frame reader did not park');
    expect(writer.write(Uint8Array.of(7), FRAME_KIND_DISPLAY, false)).toBe(true);
    await parked;
    expect(portData).toEqual([0]);
    expect(reader.tryRead()?.payload).toEqual(Uint8Array.of(7));
    channel.port1.close();
    channel.port2.close();
  });

  test('the input reader follows the same mode: native park, task identity', async () => {
    const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
    const admission = createPredictionAdmissionBuffer();
    const nativeWake = countingTaskWake();
    const native = createInputRingReaderForMode('native', sab, admission, nativeWake);
    const parked = native.waitAsync();
    if (parked === 'not-equal') throw new Error('empty input reader did not park');
    expect(nativeWake.waits()).toBe(0);
    expect(wakeInputRingReader(sab)).toBe(1);
    await parked;

    const taskWake = countingTaskWake();
    const task = createInputRingReaderForMode('task', sab, admission, taskWake);
    const taskParked = task.waitAsync();
    if (taskParked === 'not-equal') throw new Error('empty task input reader did not park');
    expect(taskWake.waits()).toBe(1);
    const writer = createInputRingWriter(sab, admission);
    expect(writer.write(1, Uint8Array.of(0x61))).toBe(true);
    taskWake.wake();
    await taskParked;
    const ordinal = task.tryReadNext();
    expect(ordinal).toBe(0);
    expect(task.localSeq(ordinal)).toBe(1);
  });
});
