import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MAX_DISPLAY_FRAME_BYTES } from '@merkur/shared';
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_CLIENT_INGRESS_BASE,
  FRAME_KIND_DISPLAY,
  FRAME_KIND_LINEAGE_FENCE,
  FRAME_RING_SIZE,
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
    extract('async function deliverFrame('),
    extract('function deliverDatagram('),
    extract('function signalSpace('),
    extract('function waitSpace('),
    extract('async function deliverFrame('),
  ].join('\n'),
);

function host(ringBytes: number) {
  const ring = new SharedArrayBuffer(ringBytes);
  const posted: TransportToTerminalPeer[] = [];
  const received: number[] = [];
  let currentFrame: Uint8Array = new Uint8Array(0);
  const context = {
    FRAME_KIND_CLIENT_INGRESS_BASE,
    frameMapping: { epoch: 0, localMinusWire: 0, wireMin: 0, wireMax: 0 },
    actionBytes: () => Uint8Array.of(42),
    active: true,
    generation: 1,
    lineage: 0,
    frameToken: 0,
    newViewerSession: true,
    resumeSpace: null,
    spacePromise: null,
    rxBytes: 0,
    frameMapping: { epoch: 0, localMinusWire: 0, wireMin: 0, wireMax: 0 },
    actionBytes: () => currentFrame,
    FRAME_KIND_CLIENT_INGRESS_BASE,
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
  return {
    ring,
    posted,
    received,
    context,
    run,
    setFrame: (frame: Uint8Array) => {
      currentFrame = frame;
    },
  };
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

function linkFrame(first: number, count: number): Uint8Array {
  const urlBytes = 8192;
  const frame = new Uint8Array(5 + count * (8 + urlBytes));
  const view = new DataView(frame.buffer);
  view.setUint32(0, frame.byteLength - 4);
  frame[0] = 0x35; // MSG_TYPE_DISPLAY_LINK_TABLE
  frame[4] = first === 1 ? 1 : 0;
  for (let index = 0, offset = 5; index < count; index += 1, offset += 8 + urlBytes) {
    const id = first + index;
    const prefix = `https://example.com/${id}/`;
    const url = new TextEncoder().encode(prefix + 'x'.repeat(urlBytes - prefix.length));
    view.setUint32(offset, id);
    view.setUint32(offset + 4, urlBytes);
    frame.set(url, offset + 8);
  }
  return frame;
}

test('an unfittable link table rejects instead of parking terminal delivery', async () => {
  for (const count of [640, 384]) {
    const session = host(FRAME_RING_SIZE);
    const meta = new Int32Array(session.ring, 0, 6);
    const offset = (session.ring.byteLength - meta.byteLength) / 2;
    Atomics.store(meta, 0, offset);
    Atomics.store(meta, 1, offset);
    session.setFrame(linkFrame(1, count));
    let outcome = 'pending';
    void session.run<Promise<void>>('deliverFrame(1, new Uint32Array([2, 0]))').then(
      () => {
        outcome = 'delivered';
      },
      () => {
        outcome = 'rejected';
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(outcome).toBe('rejected');
    expect(session.context.spacePromise).toBeNull();
  }
});

test('a split 640-link reset and subsequent display reach the terminal consumer', async () => {
  const session = host(FRAME_RING_SIZE);
  const reader = createFrameRingReader(session.ring);
  const perFrame = Math.floor((MAX_DISPLAY_FRAME_BYTES - 5) / (8 + 8192));
  let definitions = 0;
  for (let first = 1; first <= 640; first += perFrame) {
    const count = Math.min(perFrame, 641 - first);
    const frame = linkFrame(first, count);
    session.setFrame(frame);
    await session.run<Promise<void>>('deliverFrame(1, new Uint32Array([2, 0]))');
    const entry = reader.tryRead();
    expect(entry?.kind).toBe(FRAME_KIND_CLIENT_INGRESS_BASE + 2);
    expect(entry?.payload).toEqual(frame);
    definitions += count;
  }
  expect(definitions).toBe(640);
  const display = Uint8Array.of(0x20, 0, 0, 0);
  session.setFrame(display);
  await session.run<Promise<void>>('deliverFrame(1, new Uint32Array([4, 0]))');
  expect(reader.tryRead()?.payload).toEqual(display);
  expect(reader.hasPending()).toBe(false);
});
for (const operation of ['frame', 'fence'] as const) {
  test(`${operation} retries admission when the reader drains before refusal registration`, async () => {
    const session = host(4 * 1024);
    const writer = createFrameRingWriter(session.ring);
    while (writer.write(new Uint8Array(256), FRAME_KIND_DISPLAY, false)) {}
    while (writer.write(Uint8Array.of(0), FRAME_KIND_DISPLAY, false)) {}
    const reader = createFrameRingReader(session.ring);
    reader.takeRefusal();
    const add = Atomics.add;
    let drained = false;
    const refusal = spyOn(Atomics, 'add').mockImplementation((meta, index, value) => {
      if (meta.buffer === session.ring && index === 2 && !drained) {
        drained = true;
        while (reader.tryRead() !== null) {}
        expect(reader.takeRefusal()).toBe(false);
      }
      return add(meta, index, value);
    });
    try {
      let delivered = false;
      const pending = session.run<Promise<void>>(
        operation === 'frame' ? 'deliverFrame(1, new Uint32Array(6))' : 'fenceLineage(1, 3)',
      );
      void pending.then(() => {
        delivered = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(drained).toBe(true);
      expect(delivered).toBe(true);
      expect(reader.tryRead()?.kind).toBe(
        operation === 'frame' ? FRAME_KIND_CLIENT_INGRESS_BASE : FRAME_KIND_LINEAGE_FENCE,
      );
    } finally {
      refusal.mockRestore();
      session.context.active = false;
      session.run<void>('signalSpace()');
    }
  });
}
