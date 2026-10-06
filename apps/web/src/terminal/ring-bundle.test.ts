import { describe, expect, test } from 'bun:test';

import { INPUT_RING_SIZE } from '../transport/input-ring';
import {
  createTerminalRingBundle,
  PREDICTION_ADMISSION_SIZE,
  PREDICTION_FAST_PATH_SIZE,
} from './ring-bundle';
import { FRAME_RING_SIZE } from './shared-ring';
import { VIEWER_OUTPUT_RING_SIZE } from './viewer-output-ring';

describe('terminal ring bundle', () => {
  test('allocates distinct SABs for every worker generation', () => {
    const first = createTerminalRingBundle('native');
    const second = createTerminalRingBundle('native');

    expect(second.frameRing).not.toBe(first.frameRing);
    expect(second.viewerOutputRing).not.toBe(first.viewerOutputRing);
    expect(second.inputRing).not.toBe(first.inputRing);
    expect(second.predictionAdmission).not.toBe(first.predictionAdmission);
    expect(second.predictionFastPath).not.toBe(first.predictionFastPath);
    expect(second.terminalRingWakePort).not.toBe(first.terminalRingWakePort);
    expect(second.transportRingWakePort).not.toBe(first.transportRingWakePort);
    for (const bundle of [first, second]) {
      bundle.terminalRingWakePort.close();
      bundle.transportRingWakePort.close();
    }
  });

  test('provides one coherent bundle to the terminal, transport, and input consumers', () => {
    const rings = createTerminalRingBundle('native');
    const terminalWorkerRings = {
      frameRing: rings.frameRing,
      predictionAdmission: rings.predictionAdmission,
      predictionFastPath: rings.predictionFastPath,
    };
    const transportWorkerRings = rings;
    const inputWriterRing = rings.inputRing;

    expect(terminalWorkerRings.frameRing).toBe(transportWorkerRings.frameRing);
    expect(inputWriterRing).toBe(transportWorkerRings.inputRing);
    expect(terminalWorkerRings.predictionAdmission).toBe(transportWorkerRings.predictionAdmission);
    expect(terminalWorkerRings.predictionFastPath).toBe(transportWorkerRings.predictionFastPath);
    expect(rings.frameRing.byteLength).toBe(FRAME_RING_SIZE);
    expect(rings.viewerOutputRing.byteLength).toBe(VIEWER_OUTPUT_RING_SIZE);
    expect(rings.viewerOutputRing).not.toBe(rings.frameRing);
    expect(rings.inputRing.byteLength).toBe(INPUT_RING_SIZE);
    expect(rings.predictionAdmission.byteLength).toBe(PREDICTION_ADMISSION_SIZE);
    expect(rings.predictionFastPath.byteLength).toBe(PREDICTION_FAST_PATH_SIZE);
    rings.terminalRingWakePort.close();
    rings.transportRingWakePort.close();
  });

  test('the two wake ports are the ends of one channel, in both directions', async () => {
    const rings = createTerminalRingBundle('task');
    const toTerminal = new Promise<unknown>((resolve) => {
      rings.terminalRingWakePort.onmessage = (event) => resolve(event.data);
    });
    const toTransport = new Promise<unknown>((resolve) => {
      rings.transportRingWakePort.onmessage = (event) => resolve(event.data);
    });

    // The edge is a bare number on the wire: no literal is minted per edge.
    rings.transportRingWakePort.postMessage(0);
    rings.terminalRingWakePort.postMessage(0);
    await expect(toTerminal).resolves.toBe(0);
    await expect(toTransport).resolves.toBe(0);
    rings.terminalRingWakePort.close();
    rings.transportRingWakePort.close();
  });

  test('carries the wake mode main resolved, whichever arm it is', () => {
    const native = createTerminalRingBundle('native');
    const task = createTerminalRingBundle('task');
    expect(native.displayRingWakeMode).toBe('native');
    expect(task.displayRingWakeMode).toBe('task');
    for (const bundle of [native, task]) {
      bundle.terminalRingWakePort.close();
      bundle.transportRingWakePort.close();
    }
  });
});
