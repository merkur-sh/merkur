/** Real WASM Session driven against a signed native daemon fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ClientSession, initSync } from '../../packages/e2e-wasm/pkg/e2e_wasm.js';
import { clientSessionOracleExecutable } from './client-session-oracle';

const root =
  process.env.MERKUR_BENCH_REPO_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wasm = initSync({
  module: readFileSync(path.join(root, 'packages/e2e-wasm/pkg/e2e_wasm_bg.wasm')),
});

async function oracle() {
  const child = spawn(clientSessionOracleExecutable(root), [], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  assert(child.stdin !== null && child.stdout !== null);
  const input = child.stdin;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const completed = once(child, 'close');
  return {
    async request<T>(command: object): Promise<T> {
      if (!input.write(`${JSON.stringify(command)}\n`)) await once(input, 'drain');
      const reply = await lines.next();
      assert(!reply.done, 'native fixture exited before reply');
      return JSON.parse(reply.value) as T;
    },
    async close(): Promise<void> {
      input.end();
      while (!(await lines.next()).done) {
        /* exact EOF */
      }
      const [exitCode] = await completed;
      assert.equal(exitCode, 0, 'native authenticated fixture exit');
    },
  };
}
export interface ClientFecFixture {
  readonly frames: number;
  readonly recovered: number;
  readonly cols: number;
  readonly rows: number;
  readonly payload: string;
}

/** Generate opened viewer fixtures with the same native codec and parity encoder as the daemon. */
export async function generateClientFecFixture(frames: number): Promise<ClientFecFixture> {
  const peer = await oracle();
  try {
    return await peer.request<ClientFecFixture>({ op: 'fec-fixture', frames });
  } finally {
    await peer.close();
  }
}

interface Init {
  origin: string;
  browser: string;
  now: number;
  certificate: string;
  root: number[];
  issuance: { daemonId: string } & Record<string, unknown>;
}
export interface SessionFixtureAction {
  readonly kind: number;
  readonly conn: bigint;
  readonly channel: number;
  readonly topSequence: number;
  readonly payload: Uint8Array;
  readonly metadata: string;
}
export interface SessionFixtureReply {
  readonly responses: readonly (readonly [number, number[]])[];
  readonly applied: readonly { sequence: number; record: number[] }[];
}
export type SessionFixtureWire = (
  action: SessionFixtureAction,
  deliver: () => Promise<void>,
) => Promise<void>;

export async function createClientSessionFixture() {
  const peer = await oracle();
  const init = await peer.request<Init>({ op: 'init' });
  const seed = new Uint8Array(32).fill(0x22);
  const session = new ClientSession(
    init.certificate,
    new Uint8Array(init.root),
    init.origin,
    init.browser,
    true,
    seed,
  );
  seed.fill(0);
  const memory = wasm.memory;
  let now = init.now;
  let signaling = 0n;
  let interactive = 0n;
  const carriers = new Set<bigint>();
  const applied: { sequence: number; record: number[] }[] = [];
  let lineage = 0;
  let incomingWire:
    | ((channel: number, payload: Uint8Array, deliver: () => void) => void)
    | undefined;
  let datagrams = 0;
  let reliableInputs = 0;
  function ingress(bytes: Uint8Array): number {
    const pointer = session.reserve_ingress(bytes.length);
    assert(pointer !== 0);
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    return bytes.length;
  }
  function receive(conn: bigint, channel: number, bytes: Uint8Array, proof = false): void {
    session.receive(now, proof ? 2 : 0, conn, 42n, channel, ingress(bytes));
  }
  function action(kind: number): SessionFixtureAction {
    const words = new Uint32Array(memory.buffer, session.action_words_ptr(), 12);
    return {
      kind,
      conn: BigInt(words[0] ?? 0) | (BigInt(words[1] ?? 0) << 32n),
      channel: words[2] ?? 0,
      topSequence: kind === 7 ? (words[2] ?? 0) : 0,
      payload: new Uint8Array(
        memory.buffer,
        session.action_bytes_ptr(),
        session.action_bytes_len(),
      ).slice(),
      metadata: session.action_metadata(),
    };
  }
  async function transmit(value: SessionFixtureAction): Promise<void> {
    if ((value.kind === 5 && value.channel === 0) || value.kind === 6) {
      const reply = await peer.request<{ signal: string | null }>({
        op: 'signal',
        bytes: Array.from(value.payload),
      });
      if (reply.signal !== null)
        receive(value.conn, 0, new TextEncoder().encode(reply.signal), value.kind === 6);
    } else if (value.kind === 5 && value.channel === 6) {
      const reply = await peer.request<{ ack: number[] }>({
        op: 'hello',
        bytes: Array.from(value.payload),
      });
      receive(value.conn, 6, Uint8Array.from(reply.ack));
    } else if (value.kind === 5 || value.kind === 7) {
      const datagram = value.kind === 7;
      const channel = datagram ? (value.payload[0] ?? 0) : value.channel;
      if (channel === 1) {
        if (datagram) datagrams += 1;
        else reliableInputs += 1;
      }
      const reply = await peer.request<SessionFixtureReply>({
        op: 'receive',
        channel,
        datagram,
        bytes: Array.from(datagram ? value.payload.subarray(1) : value.payload),
      });
      applied.push(...reply.applied);
      for (const [responseChannel, bytes] of reply.responses) {
        const payload = Uint8Array.from(bytes);
        const conn = interactive;
        const deliver = (): void => receive(conn, responseChannel, payload);
        if (incomingWire === undefined) deliver();
        else incomingWire(responseChannel, payload, deliver);
      }
    }
  }
  const fixture = {
    session,
    memory,
    lineage: (): number => lineage,
    incomingWire(value: typeof incomingWire): void {
      incomingWire = value;
    },
    async daemonSeal(channel: number, datagram: boolean, bytes: Uint8Array): Promise<Uint8Array> {
      const value = await peer.request<{ bytes: number[] }>({
        op: 'seal',
        channel,
        datagram,
        bytes: Array.from(bytes),
      });
      return Uint8Array.from(value.bytes);
    },
    incoming(channel: number, payload: Uint8Array, datagram: boolean): void {
      if (datagram) {
        const packet = new Uint8Array(payload.length + 1);
        packet[0] = channel;
        packet.set(payload, 1);
        session.receive(now, 1, interactive, 0n, 0, ingress(packet));
      } else receive(interactive, channel, payload);
    },
    drainHost(
      consume: (kind: number, words: Uint32Array, payload: Uint8Array, metadata: string) => void,
    ): void {
      for (;;) {
        const kind = session.poll_action(false);
        if (kind === 0) return;
        if (kind === 10)
          lineage = new Uint32Array(memory.buffer, session.action_words_ptr(), 12)[0] ?? 0;
        consume(
          kind,
          new Uint32Array(memory.buffer, session.action_words_ptr(), 12),
          new Uint8Array(memory.buffer, session.action_bytes_ptr(), session.action_bytes_len()),
          session.action_metadata(),
        );
      }
    },
    now: (): number => now,
    advanceToNext(eventAt: number, origin: number): number {
      const deadline = session.next_deadline();
      const at = Math.min(eventAt, deadline === undefined ? Infinity : deadline - origin);
      assert(Number.isFinite(at) && at <= 60_000, 'authenticated schedule must converge');
      now = Math.max(now, origin + at);
      return at;
    },
    async step(
      event: { at: number; run: () => void | Promise<void> } | undefined,
      origin: number,
    ): Promise<boolean> {
      const at = fixture.advanceToNext(event?.at ?? Infinity, origin);
      if (event !== undefined && event.at <= at) {
        await event.run();
        return true;
      }
      session.timeout(now);
      return false;
    },
    setNow(value: number): void {
      assert(value >= now);
      now = value;
    },
    applied,
    counts: (): { datagrams: number; reliableInputs: number } => ({ datagrams, reliableInputs }),
    input(sequence: number, bytes: Uint8Array, modelled = false): boolean {
      return session.input(now, sequence, ingress(bytes), modelled);
    },
    pollIo(): SessionFixtureAction | null {
      const kind = session.poll_action(true);
      return kind === 0 ? null : action(kind);
    },
    async transmit(value: SessionFixtureAction): Promise<void> {
      await transmit(value);
    },
    async settle(
      wire?: SessionFixtureWire,
      observe?: (action: SessionFixtureAction) => void,
    ): Promise<void> {
      for (;;) {
        const kind = session.poll_action(true);
        if (kind === 0) break;
        const value = action(kind);
        observe?.(value);
        if (kind === 1) session.issued(now, JSON.stringify(init.issuance));
        else if (kind === 3) {
          carriers.add(value.conn);
          const words = new Uint32Array(memory.buffer, session.action_words_ptr(), 12);
          const candidate = words[3] === 1;
          if (words[2] === 0 && !candidate) signaling = value.conn;
          if (words[2] === 1) interactive = value.conn;
          session.connected(now, value.conn);
          session.splice(
            now,
            value.conn,
            JSON.stringify({
              type: 'counterpart_present',
              present: true,
              counterpart_attachment_id: 42,
            }),
          );
        } else if (kind === 8) carriers.delete(value.conn);
        else if (kind === 5 || kind === 6 || kind === 7) {
          if (kind === 7 && value.topSequence !== 0)
            session.input_datagram_sent(now, value.conn, value.topSequence);
          if (wire !== undefined) await wire(value, () => transmit(value));
          else await transmit(value);
        }
      }
      fixture.drainHost(() => {
        /* projections do not alter the protocol */
      });
    },
    recover(allCarriers = false): void {
      const ended = allCarriers ? Array.from(carriers) : [];
      session.closed(now, signaling, false);
      for (const conn of ended) {
        if (conn !== signaling) session.closed(now, conn, false);
      }
    },
    async close(): Promise<void> {
      session.free();
      await peer.close();
    },
  };
  session.connect(init.issuance.daemonId);
  await fixture.settle();
  assert(session.is_ready(), 'the real hybrid/Noise/data attachment reached Ready');
  return fixture;
}
export type ClientSessionFixture = Awaited<ReturnType<typeof createClientSessionFixture>>;
