import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_DISPLAY,
  FRAME_KIND_LINEAGE_FENCE,
  readFrameRingFence,
} from '../terminal/shared-ring';
import type { TransportToTerminalPeer } from '../terminal/worker-peer-control';

// A terminal worker that stops reading its rings (an iPhone PWA back from the
// background) must cost the session its display and nothing else: no
// authenticated lineage may wait on it, and the carrier reader that brings
// pongs and input ACKs may not wait behind display it cannot hand over.

const source = readFileSync(new URL('./browser-client-session.ts', import.meta.url), 'utf8');

function extract(signature: string): string {
  const start = source.indexOf(`  ${signature}`);
  const end = source.indexOf('\n  }\n', start);
  if (start < 0 || end < start) throw new Error(`missing ${signature}`);
  return source.slice(start, end + 4);
}

const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  [
    extract('async function fenceLineage('),
    extract('function deliverDatagram('),
    extract('function signalSpace('),
    extract('function waitSpace('),
  ].join('\n'),
);

function host(ringBytes: number) {
  const ring = new SharedArrayBuffer(ringBytes);
  const posted: TransportToTerminalPeer[] = [];
  const received: number[] = [];
  const context = {
    active: true,
    generation: 1,
    lineage: 0,
    frameToken: 0,
    newViewerSession: true,
    resumeSpace: null,
    spacePromise: null,
    rxBytes: 0,
    carriers: new Map([[7n, {}]]),
    host: {
      frames: createFrameRingWriter(ring),
      input: { revokeShadowProvenance() {} },
      peer: { postMessage: (message: TransportToTerminalPeer) => posted.push(message) },
    },
    session: {
      is_ready: () => true,
      receive(_at: number, kind: number) {
        received.push(kind);
      },
    },
    activity: { record() {} },
    isTerminalTrafficChannel: () => true,
    ingress: (bytes: Uint8Array) => bytes.byteLength,
    releaseInput() {},
    drive: () => new Promise<void>(() => {}),
    failed(error: Error) {
      throw error;
    },
    performance,
  };
  runInNewContext(program, context);
  const run = <T>(code: string) =>
    // SAFETY: each caller names the type of the one extracted function call it
    // evaluates, whose source is the production code this file read above.
    runInNewContext(code, context) as T;
  return { ring, posted, received, context, run };
}

test('a new lineage is fenced in the frame ring without waiting for the terminal', async () => {
  const session = host(64 * 1024);
  // Nothing on the terminal side reads or answers: the fence still completes.
  await session.run<Promise<void>>('fenceLineage(1, 2)');
  expect(session.context.lineage).toBe(2);
  expect(session.context.frameToken).not.toBe(0);
  expect(session.context.newViewerSession).toBe(false);
  expect(session.posted).toEqual([]);

  const entry = createFrameRingReader(session.ring).tryRead();
  expect(entry?.kind).toBe(FRAME_KIND_LINEAGE_FENCE);
  expect(readFrameRingFence(entry?.payload ?? new Uint8Array(0))).toEqual({
    token: session.context.frameToken,
    lineage: 2,
    newSession: true,
  });
});

test('a full ring parks the display lane, never the carrier reader', async () => {
  const session = host(4 * 1024);
  const writer = createFrameRingWriter(session.ring);
  while (writer.write(new Uint8Array(256), FRAME_KIND_DISPLAY, false)) {}
  while (writer.write(Uint8Array.of(0), FRAME_KIND_DISPLAY, false)) {}

  let fenced = false;
  void session.run<Promise<void>>('fenceLineage(1, 3)').then(() => {
    fenced = true;
  });
  await Promise.resolve();
  expect(fenced).toBe(false);

  // The lane is parked and its drain never settles (`drive` here never
  // resolves), yet every datagram, display, pong and ACK alike, reaches the
  // session in the turn it arrives: nothing is awaited and nothing is lost.
  for (const channel of [3, 2, 1, 3]) {
    session.run<void>(`deliverDatagram(1, 7n, Uint8Array.of(${channel}, 0, 0))`);
  }
  expect(session.received).toEqual([1, 1, 1, 1]);

  // The reader discards the ended lineage the announcement fenced off; its
  // space edge lets the fence in.
  expect(createFrameRingReader(session.ring).tryRead()).toBeNull();
  session.run<void>('signalSpace()');
  await Promise.resolve();
  await Promise.resolve();
  expect(fenced).toBe(true);
});
