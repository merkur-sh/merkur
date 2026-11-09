import { describe, expect, test } from 'bun:test';

import { createTerminalRingBundle } from './ring-bundle';

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
