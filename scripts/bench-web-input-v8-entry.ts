import v8 from 'node:v8';
import {
  createInputRingReader,
  createInputRingWriter,
  INPUT_RING_SIZE,
} from '../apps/web/src/transport/input-ring';
import {
  createClientSessionFixture,
  type SessionFixtureAction,
} from './perf/client-session-fixture';
import { emitPerfMetric } from './perf/harness';

/** Node/V8 allocation capture for authenticated Rust input/sealing and actual host callbacks.
 * Native peer delivery/ACK verifies custody outside the input allocation capture.
 */

const TIER = process.env.BENCH_V8_TIER ?? 'default';
const SAMPLES = 9;

function allocatedBytes(): number {
  return v8.getHeapStatistics().total_allocated_bytes;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function bytesPerOp(
  op: () => void | Promise<void>,
  ops: number,
  settled: boolean,
): Promise<number> {
  const probeStart = allocatedBytes();
  const probe = allocatedBytes() - probeStart;
  const start = allocatedBytes();
  for (let index = 0; index < ops; index += 1) {
    const done = op();
    if (done !== undefined) await done;
    if (settled) await settle();
  }
  return (allocatedBytes() - start - probe) / ops;
}

async function measure(
  name: string,
  op: () => void | Promise<void>,
  ops: number,
  settled: boolean,
): Promise<void> {
  for (let warmup = 0; warmup < 5; warmup += 1) await bytesPerOp(op, ops, settled);
  const control: number[] = [];
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    control.push(await bytesPerOp(() => {}, ops, settled));
    samples.push(await bytesPerOp(op, ops, settled));
  }
  control.sort((left, right) => left - right);
  samples.sort((left, right) => left - right);
  const value = (samples[SAMPLES >> 1] ?? 0) - (control[SAMPLES >> 1] ?? 0);
  process.stdout.write(
    `${name} [v8 ${TIER}]: bytes/op median=${value.toFixed(1)} ` +
      `(n=${SAMPLES}x${ops}, minus the same loop doing nothing)\n`,
  );
  emitPerfMetric({
    name: `web-input-v8-${TIER}-${name}-bytes`,
    value,
    unit: 'bytes/op',
    direction: 'lower',
    sampleSize: SAMPLES,
  });
}

async function measureSessionInput() {
  const peer = await createClientSessionFixture();
  const key = Uint8Array.of(0, 97);
  let sequence = 0;
  const samples: number[] = [];
  try {
    for (let sample = 0; sample < SAMPLES + 5; sample++) {
      const actions: SessionFixtureAction[] = [];
      const start = allocatedBytes();
      for (let index = 0; index < 256; index++) {
        if (!peer.input(++sequence, key)) throw new Error('Rust input refused');
        for (;;) {
          const value = peer.pollIo();
          if (value === null) break;
          actions.push(value);
        }
      }
      const bytes = (allocatedBytes() - start) / 256;
      // Authentication, peer application and ACK are verified outside allocation capture.
      for (const action of actions) {
        if (action.kind === 7 && action.topSequence !== 0)
          peer.session.input_datagram_sent(peer.now(), action.conn, action.topSequence);
        await peer.transmit(action);
      }
      await peer.settle();
      if (peer.applied.length !== sequence || peer.session.input_ack_local() !== sequence)
        throw new Error('authenticated peer did not apply exactly once');
      if (sample >= 5) samples.push(bytes);
    }
    samples.sort((a, b) => a - b);
    const value = samples[SAMPLES >> 1] ?? 0;
    process.stdout.write(
      `session-input [v8 ${TIER}]: bytes/key=${value}; WASM ingress and sealed-output transfer copies, oracle outside capture\n`,
    );
    emitPerfMetric({
      name: `web-input-v8-${TIER}-session-input-bytes`,
      value,
      unit: 'bytes/op',
      direction: 'lower',
      sampleSize: SAMPLES,
    });
  } finally {
    await peer.close();
  }
}

function readerPark(): () => Promise<void> {
  const sab = new SharedArrayBuffer(INPUT_RING_SIZE);
  const writer = createInputRingWriter(sab);
  const reader = createInputRingReader(sab);
  const payload = Uint8Array.of(0x01, 0x61);
  let seq = 1;
  return async () => {
    const wait = reader.waitAsync();
    if (wait === 'not-equal') throw new Error('bench: an empty ring did not park');
    if (!writer.write(seq, payload)) throw new Error('bench: ring refused an entry');
    seq += 1;
    await wait;
    const ordinal = reader.tryReadNext();
    if (ordinal < 0) throw new Error('bench: woken reader found nothing');
    reader.release(ordinal + 1);
  };
}

interface KeybindScopeShape {
  readonly title: string;
  active(): boolean;
  readonly bindings: readonly { readonly keys: string; readonly label: string; run(): void }[];
}

async function appKeybindsKeystroke(): Promise<() => void> {
  // Bundled through bench-web-input-v8.ts's virtual module rather than imported
  // here, so the scripts type-check project, which has no Solid types, never
  // loads the web app's Solid modules.
  // @ts-expect-error resolved only by the bench-web-input-v8.ts bundler plugin
  const solidModules = (await import('bench-web-input-v8:keybinds')) as {
    createRoot(fn: () => void): void;
    createKeybinds(scope: KeybindScopeShape): void;
  };
  const { createRoot, createKeybinds } = solidModules;
  const listeners: Array<(event: unknown) => void> = [];
  const globals = globalThis as Record<string, unknown>;
  globals.document = {
    addEventListener: (_type: string, handler: (event: unknown) => void) => listeners.push(handler),
    removeEventListener: () => {},
  };
  globals.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globals.HTMLElement ??= class {};
  const run = (): void => {};
  const bindings = (keys: readonly string[]) => keys.map((keys) => ({ keys, label: keys, run }));
  // The shell's scopes with their terminal-route activity, as bench-web-input-keybinds.ts.
  createRoot(() => {
    createKeybinds({ title: 'Anywhere', active: () => true, bindings: bindings(['rcmd+k']) });
    createKeybinds({
      title: 'Go to',
      active: () => false,
      bindings: bindings(['g d', 'g s', '?']),
    });
    createKeybinds({
      title: 'Machines',
      active: () => false,
      bindings: bindings(['j', 'k', 'g g', 'G', 'o', 's', 'r', 'x', 'n', 'a', 'y', 'R']),
    });
    createKeybinds({ title: 'Sessions', active: () => false, bindings: bindings(['x', 'X']) });
    createKeybinds({
      title: 'Settings',
      active: () => false,
      bindings: bindings(['j', 'k', 'l', 'h', '1', '2', '3', '4', 'q', 'Escape']),
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const handler = listeners[0];
  if (listeners.length !== 1 || handler === undefined) {
    throw new Error(`bench: createKeybinds attached ${listeners.length} listeners, expected 1`);
  }
  const events = [...'etaoinshrdlucmfwypvbgkqjxz'].map((key) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: null,
    preventDefault: () => {
      throw new Error('bench: the app layer swallowed a terminal key');
    },
  }));
  let index = 0;
  return () => {
    handler(events[index % events.length]);
    index += 1;
  };
}

await measureSessionInput();
await measure('reader-park', readerPark(), 1_024, false);
await measure('app-keybinds', await appKeybindsKeystroke(), 4_096, false);
