import type { TaskWake } from '../lib/task-wake';
import { createInputRingReader, type InputRingReader } from '../transport/input-ring';
import type { TerminalDisplayRingWakeMode } from './runtime-policy';
import {
  createFrameRingReader,
  createFrameRingWriter,
  type FrameRingReader,
  type FrameRingWriter,
} from './shared-ring';
import {
  createViewerOutputRingReader,
  createViewerOutputRingWriter,
  type ViewerOutputRingReader,
  type ViewerOutputRingWriter,
} from './viewer-output-ring';

/**
 * Ring readers and writers constructed by wake mode.
 *
 * The rings themselves are mode-blind: a reader parks natively on its ring's
 * wake word unless it is handed a task wait, and a writer publishes only the
 * native edge unless it is handed a task edge. This module is the one place
 * that decides which of those a worker gets, from the mode main resolved and
 * carried in `init`, so a task wait or a task edge exists only in `'task'`
 * mode (Apple mobile WebKit, where a suspended worker can lose a futex notify)
 * and the `'native'` arm pays nothing per event: no message, no port, no
 * timer, no promise beyond the futex's own.
 *
 * The task edge is `port.postMessage(0)` on the worker-to-worker wake port —
 * a number, not a message literal, so no object is minted per edge and no
 * validator walks it on arrival; the receiving worker's port handler wakes
 * the reader's task wait.
 */

function ringTaskWait(
  mode: TerminalDisplayRingWakeMode,
  taskWake: TaskWake,
): ((watchdogMs: number) => Promise<void>) | undefined {
  return mode === 'task' ? (watchdogMs) => taskWake.wait(watchdogMs) : undefined;
}

function ringTaskEdge(
  mode: TerminalDisplayRingWakeMode,
  wakePort: MessagePort,
): (() => void) | undefined {
  return mode === 'task' ? () => wakePort.postMessage(0) : undefined;
}

/** The terminal worker's frame-ring consumer. */
export function createFrameRingReaderForMode(
  mode: TerminalDisplayRingWakeMode,
  frameRing: SharedArrayBuffer,
  taskWake: TaskWake,
): FrameRingReader {
  return createFrameRingReader(frameRing, undefined, ringTaskWait(mode, taskWake));
}

/**
 * The transport worker's input-ring consumer. Its task edge is main's
 * `INPUT_AVAILABLE_EDGE` post rather than the wake port (main is the producer), and
 * main installs that edge only in `'task'` mode for the same reason this
 * reader receives a task wait only then.
 */
export function createInputRingReaderForMode(
  mode: TerminalDisplayRingWakeMode,
  inputRing: SharedArrayBuffer,
  predictionAdmission: SharedArrayBuffer,
  taskWake: TaskWake,
): InputRingReader {
  return createInputRingReader(
    inputRing,
    undefined,
    predictionAdmission,
    ringTaskWait(mode, taskWake),
  );
}

/** The transport worker's frame-ring producer; its task edge crosses the wake port. */
export function createFrameRingWriterForMode(
  mode: TerminalDisplayRingWakeMode,
  frameRing: SharedArrayBuffer,
  wakePort: MessagePort,
): FrameRingWriter {
  return createFrameRingWriter(frameRing, ringTaskEdge(mode, wakePort));
}

/** The terminal worker's viewer-output producer; its task edge crosses the wake port. */
export function createViewerOutputRingWriterForMode(
  mode: TerminalDisplayRingWakeMode,
  viewerOutputRing: SharedArrayBuffer,
  wakePort: MessagePort,
): ViewerOutputRingWriter {
  return createViewerOutputRingWriter(viewerOutputRing, ringTaskEdge(mode, wakePort));
}

/** The transport worker's viewer-output consumer. */
export function createViewerOutputRingReaderForMode(
  mode: TerminalDisplayRingWakeMode,
  viewerOutputRing: SharedArrayBuffer,
  taskWake: TaskWake,
): ViewerOutputRingReader {
  return createViewerOutputRingReader(viewerOutputRing, undefined, ringTaskWait(mode, taskWake));
}
