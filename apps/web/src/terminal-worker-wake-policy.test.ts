import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source-level conformance for how `terminal-worker.ts` is woken.
 *
 * The worker is a bare worker entry point — no exports, and an init path that
 * needs OffscreenCanvas, WebGL2 and WASM — so it cannot be imported into a unit
 * test. What is pinned here is the shape of the contract the ring-wake readers
 * test in isolation: the worker takes its wake mode from `init`, never from a
 * user agent of its own (the realm-disagreement hazard: a worker with no
 * `navigator` picks one arm while its producer picks the other), and it relays
 * no per-ACK edge through main.
 */
const WORKER_SOURCE = readFileSync(
  fileURLToPath(new URL('./terminal-worker.ts', import.meta.url)),
  'utf8',
);

describe('terminal worker wake policy', () => {
  test('the wake mode arrives in init; the worker does not sniff a user agent', () => {
    expect(WORKER_SOURCE).not.toContain('terminalRuntimePolicyForUserAgent');
    expect(WORKER_SOURCE).toContain('cmd.displayRingWakeMode');
  });

  test('no per-ACK or per-frame notice is relayed through main', () => {
    expect(WORKER_SOURCE).not.toContain('display_ack_available');
    // Display output reaches main twice per burst through the settle, never
    // once per frame.
    expect(WORKER_SOURCE).not.toContain('display_frame_received');
    expect(WORKER_SOURCE).toContain('displayOutputSettle.noteFrame()');
    // Canonical Rust outputs cross on their own ring, never as a message: the
    // port carries only that ring's task and space edges.
    expect(WORKER_SOURCE).not.toContain('client_viewer_output');
    expect(WORKER_SOURCE).toContain('cmd.viewerOutputRing');
    expect(WORKER_SOURCE).toContain('cmd.ringWakePort');
  });

  test('the viewer-output writer takes the wake mode main resolved', () => {
    const start = WORKER_SOURCE.indexOf('createViewerOutputRingWriterForMode(');
    expect(start).toBeGreaterThan(-1);
    const call = WORKER_SOURCE.slice(start, WORKER_SOURCE.indexOf(')', start));
    expect(call).toContain('cmd.displayRingWakeMode');
    expect(call).toContain('cmd.viewerOutputRing');
    expect(call).toContain('cmd.ringWakePort');
  });

  test('the transport worker’s space edge resumes the held viewer output', () => {
    const start = WORKER_SOURCE.indexOf('function handleRingWakeEdge(');
    const edge = WORKER_SOURCE.indexOf('data === VIEWER_OUTPUT_SPACE_EDGE', start);
    const numeric = WORKER_SOURCE.indexOf("typeof data === 'number'", start);
    expect(edge).toBeGreaterThan(start);
    // Tested before the generic numeric wake, which would swallow it.
    expect(edge).toBeLessThan(numeric);
    expect(WORKER_SOURCE.slice(edge, numeric)).toContain('drainViewerOutputs()');
  });

  test('the wake port is installed before the first await of init', () => {
    const start = WORKER_SOURCE.indexOf('async function handleInit(');
    expect(start).toBeGreaterThan(-1);
    const install = WORKER_SOURCE.indexOf('installRingWakePort(cmd.ringWakePort);', start);
    const firstAwait = WORKER_SOURCE.indexOf('await ', start);
    expect(install).toBeGreaterThan(start);
    expect(firstAwait).toBeGreaterThan(install);
  });
});
