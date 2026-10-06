import '@merkur/shared/e2e-wasm-bun';
/**
 * Server-side steady-state cost of connected daemons.
 *
 * A registered daemon costs the server three recurring things: a WebSocket
 * ping every 2 s (`ControlConnectionHandle.observePing`), the liveness ticker
 * walk that follows the deadlines those pings move, and one lease renewal every
 * 20 s, which renews the Redis claim in 128-daemon chunks, mints a STUN ticket
 * and sends a `lease` frame. This drives the production
 * `createDaemonControlService` with N registered connections over an in-memory
 * coordination double (one Redis script call per renewal in production; the
 * double answers synchronously), a controlled monotonic clock and counting
 * sockets, and reports per daemon:
 *
 * - ns and JS cells per observed ping;
 * - ns and JS cells per renewed lease, with the production STUN issuer
 *   (two HMAC-SHA-256 and a 16-byte `randomBytes` per ticket) and with a
 *   constant issuer, which isolates the service's own work;
 * - bytes and `sendText` calls per renewal.
 *
 * It also measures, in a paired A/B, the byte-length check `sendFrame` runs on
 * every outbound frame: `TextEncoder.encode(frame).byteLength` copies the whole
 * frame into a fresh `Uint8Array` to read one number, where
 * `Buffer.byteLength(frame, 'utf8')` returns the same number without the copy
 * (asserted equal on every frame the run produces).
 *
 * Cells are `heapStats()` object type counts summed after a full collection;
 * a run that a collection interrupts is detected and retried smaller.
 */
import { fullGC, heapStats } from 'bun:jsc';

import {
  createDaemonControlCommandAckMessage,
  encodeDaemonControlMessage,
  parseDaemonControlDaemonMessage,
  parseDaemonControlServerMessage,
} from '@merkur/daemon-control-protocol';
import { Effect } from 'effect';

import { percentile, perfEnvInteger } from '../../../scripts/perf/harness';
import type { Logger } from '../src/logger';
import {
  type ControlConnectionHandle,
  createDaemonControlService,
  type DaemonControlSocket,
} from '../src/services/daemon-control-service';
import { createEdgeAttachTicketIssuer } from '../src/services/edge-attach-ticket';
import type {
  DaemonPresence,
  RealtimeCoordinationService,
} from '../src/services/realtime-coordination-service';
import type { RedisService } from '../src/services/redis-service';
import { createStunTicketIssuer, type StunTicketIssuer } from '../src/services/stun-ticket-service';

const DAEMONS = perfEnvInteger('BENCH_DAEMONS', 512);
const ROUNDS = perfEnvInteger('BENCH_ROUNDS', 20);
const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 40);
const LENGTH_OPS = perfEnvInteger('BENCH_LENGTH_OPS', 20_000);
const PING_INTERVAL_MS = 2_000;
const LEASE_RENEWAL_MS = 20_000;
const INSTANCE_ID = 'bench-instance';

const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

interface Clocks {
  mono: number;
  wall: number;
}

interface CountingSocket extends DaemonControlSocket {
  sent: number;
  bytes: number;
  frames: string[];
}

function countingSocket(keepFrames: boolean): CountingSocket {
  const socket: CountingSocket = {
    sent: 0,
    bytes: 0,
    frames: [],
    sendText(payload: string): number {
      socket.sent += 1;
      socket.bytes += Buffer.byteLength(payload, 'utf8');
      if (keepFrames) socket.frames.push(payload);
      return payload.length;
    },
    close() {},
  };
  return socket;
}

/** Many daemons, one presence each, every renewal answered `refreshed`. */
function coordinationFor(): RealtimeCoordinationService {
  const presences = new Map<string, DaemonPresence>();
  let nextClaimSeq = 1;
  return {
    instanceId: INSTANCE_ID,
    healthSnapshot: () => Effect.succeed({ presenceExpirySchedulerHealthy: true }),
    awaitCriticalFailure: Effect.never,
    claimDaemonOnline: (input) =>
      Effect.sync(() => {
        const claimSeq = nextClaimSeq++;
        presences.set(input.daemonId, {
          ...input,
          ownerInstanceId: INSTANCE_ID,
          claimSeq,
          state: 'online',
          updatedAt: 0,
        });
        return { _tag: 'Claimed' as const, claimSeq };
      }),
    renewDaemonLeases: (inputs) =>
      Effect.sync(() =>
        inputs.map((input) => {
          const presence = presences.get(input.daemonId);
          return {
            presence:
              presence !== undefined &&
              presence.presenceId === input.presenceId &&
              presence.claimSeq === input.claimSeq
                ? ('refreshed' as const)
                : ('not-owner' as const),
            revocationGeneration: 7,
          };
        }),
      ),
    markDaemonSilent: () => Effect.succeed('changed' as const),
    clearDaemonSilent: () => Effect.succeed('changed' as const),
    resumeDaemonPresence: () => Effect.succeed(null),
    suspendDaemonPresence: () => Effect.succeed(true),
    unmarkDaemonOnline: () => Effect.succeed(true),
    getDaemonPresence: (daemonId) => Effect.succeed(presences.get(daemonId) ?? null),
    getUserDaemonPresence: () => Effect.succeed([]),
    publishDeviceDelta: () => Effect.void,
    readDeviceEventsCursor: () => Effect.succeed({ epoch: 'feedfacefeedface', seq: 0 }),
    subscribeDeviceEvents: () => Effect.succeed(Effect.void),
    incrementRevocationGeneration: () => Effect.succeed(1),
    createSessionForDaemonPresence: () => Effect.succeed(null),
    removeSessionForUser: () => Effect.void,
    removeDaemonSessions: () => Effect.void,
  };
}

interface Fleet {
  readonly service: ReturnType<typeof createDaemonControlService>;
  readonly clocks: Clocks;
  readonly handles: ControlConnectionHandle[];
  readonly sockets: CountingSocket[];
}

async function createFleet(stun: StunTicketIssuer, keepFrames: boolean): Promise<Fleet> {
  const clocks: Clocks = { mono: 1_000, wall: 1_700_000_000_000 };
  const service = createDaemonControlService({
    coordination: coordinationFor(),
    redis: {} as RedisService,
    touchDaemon: () => Effect.void,
    touchDaemonsSeen: () => Effect.void,
    logger: NOOP_LOGGER,
    stun,
    edgeAttach: createEdgeAttachTicketIssuer(new Uint8Array(64).fill(10)),
    edges: Effect.succeed([
      {
        edgeWtUrl: 'https://edge.example:4433/',
        certHashes: [
          Buffer.alloc(32, 1).toString('base64'),
          Buffer.alloc(32, 2).toString('base64'),
        ],
      },
    ]),
    now: () => clocks.wall,
    monotonicNow: () => clocks.mono,
  });
  const handles: ControlConnectionHandle[] = [];
  const sockets: CountingSocket[] = [];
  for (let index = 0; index < DAEMONS; index += 1) {
    const socket = countingSocket(keepFrames);
    sockets.push(socket);
    handles.push(
      await Effect.runPromise(
        service.acceptConnection({
          daemonId: `daemon-${index}`,
          userId: `user-${index % 64}`,
          boxId: null,
          daemonVersion: '0.57.1',
          connectionId: crypto.randomUUID(),
          presenceId: crypto.randomUUID(),
          socket,
          zone: null,
        }),
      ),
    );
  }
  return { service, clocks, handles, sockets };
}

function advance(fleet: Fleet, ms: number): void {
  fleet.clocks.mono += ms;
  fleet.clocks.wall += ms;
}

function pingAll(fleet: Fleet): void {
  for (const handle of fleet.handles) handle.observePing();
}

/** One 20 s lease period of pings, ending on a walk that renews every lease. */
function leasePeriod(fleet: Fleet): Promise<number | null> {
  for (let elapsed = 0; elapsed < LEASE_RENEWAL_MS; elapsed += PING_INTERVAL_MS) {
    advance(fleet, PING_INTERVAL_MS);
    pingAll(fleet);
  }
  return Effect.runPromise(fleet.service.livenessTick);
}

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

/** Cells for `run`, retried with fewer repetitions if a collection interrupts it. */
async function cellsFor(run: (repetitions: number) => Promise<void>, repetitions: number) {
  for (let attempt = repetitions; attempt >= 1; attempt = Math.floor(attempt / 2)) {
    fullGC();
    const survivors = heapStats().objectCount;
    const before = liveCells();
    await run(attempt);
    const after = liveCells();
    if (heapStats().objectCount === survivors)
      return { cells: after - before, repetitions: attempt };
  }
  throw new Error('bench: a collection ran during every allocation measurement');
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function measurePings(fleet: Fleet): Promise<void> {
  // Warm the path, then count cells for whole ping rounds of every daemon.
  for (let round = 0; round < ROUNDS; round += 1) {
    advance(fleet, PING_INTERVAL_MS);
    pingAll(fleet);
  }
  const { cells, repetitions } = await cellsFor(async (rounds) => {
    for (let round = 0; round < rounds; round += 1) {
      advance(fleet, PING_INTERVAL_MS);
      pingAll(fleet);
    }
  }, ROUNDS);
  const times: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    advance(fleet, PING_INTERVAL_MS);
    const startedAt = Bun.nanoseconds();
    pingAll(fleet);
    times.push((Bun.nanoseconds() - startedAt) / DAEMONS);
  }
  write(
    `   observePing           cells/ping=${(cells / (repetitions * DAEMONS)).toFixed(3)}  ` +
      `ns/ping p50=${percentile(times, 0.5).toFixed(1)} p95=${percentile(times, 0.95).toFixed(1)} ` +
      `(n=${SAMPLES} rounds of ${DAEMONS})`,
  );
}

async function measureRenewals(label: string, fleet: Fleet): Promise<void> {
  for (let round = 0; round < 3; round += 1) await leasePeriod(fleet);
  const sentBefore = fleet.sockets.reduce((sum, socket) => sum + socket.sent, 0);
  const bytesBefore = fleet.sockets.reduce((sum, socket) => sum + socket.bytes, 0);
  await leasePeriod(fleet);
  const sent = fleet.sockets.reduce((sum, socket) => sum + socket.sent, 0) - sentBefore;
  const bytes = fleet.sockets.reduce((sum, socket) => sum + socket.bytes, 0) - bytesBefore;
  if (sent !== DAEMONS) throw new Error(`bench: expected ${DAEMONS} lease frames, sent ${sent}`);

  // Cells for the renewing walk only: the pings that precede it run outside
  // the counted window.
  const { cells, repetitions } = await cellsFor(async (periods) => {
    for (let period = 0; period < periods; period += 1) await leasePeriod(fleet);
  }, 1);
  // leasePeriod includes 10 ping rounds; subtract their (measured ~zero) cost
  // by construction: pings allocate nothing (see observePing above).
  const times: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    for (let elapsed = 0; elapsed < LEASE_RENEWAL_MS; elapsed += PING_INTERVAL_MS) {
      advance(fleet, PING_INTERVAL_MS);
      pingAll(fleet);
    }
    const startedAt = Bun.nanoseconds();
    await Effect.runPromise(fleet.service.livenessTick);
    times.push((Bun.nanoseconds() - startedAt) / DAEMONS);
  }
  write(
    `   renewal ${label.padEnd(13)} cells/lease=${(cells / (repetitions * DAEMONS)).toFixed(1)}  ` +
      `ns/lease p50=${percentile(times, 0.5).toFixed(0)} p95=${percentile(times, 0.95).toFixed(0)}  ` +
      `frame=${(bytes / sent).toFixed(0)} B, sendText/lease=${(sent / DAEMONS).toFixed(2)} ` +
      `(n=${SAMPLES} walks of ${DAEMONS})`,
  );
}

async function measureLengthCheck(frames: readonly string[]): Promise<void> {
  const encoder = new TextEncoder();
  for (const frame of frames) {
    if (encoder.encode(frame).byteLength !== Buffer.byteLength(frame, 'utf8')) {
      throw new Error('bench: byte lengths disagree');
    }
  }
  const arms = {
    encode: () => {
      let total = 0;
      for (let index = 0; index < LENGTH_OPS; index += 1) {
        total += encoder.encode(frames[index % frames.length] ?? '').byteLength;
      }
      return total;
    },
    byteLength: () => {
      let total = 0;
      for (let index = 0; index < LENGTH_OPS; index += 1) {
        total += Buffer.byteLength(frames[index % frames.length] ?? '', 'utf8');
      }
      return total;
    },
  };
  const expected = arms.encode();
  if (arms.byteLength() !== expected) throw new Error('bench: totals disagree');
  const cells = {
    encode: (await cellsFor(async () => void arms.encode(), 1)).cells / LENGTH_OPS,
    byteLength: (await cellsFor(async () => void arms.byteLength(), 1)).cells / LENGTH_OPS,
  };
  const times = { encode: [] as number[], byteLength: [] as number[] };
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const order: ReadonlyArray<keyof typeof arms> =
      sample % 2 === 0
        ? ['encode', 'byteLength', 'byteLength', 'encode']
        : ['byteLength', 'encode', 'encode', 'byteLength'];
    for (const arm of order) {
      const startedAt = Bun.nanoseconds();
      arms[arm]();
      times[arm].push((Bun.nanoseconds() - startedAt) / LENGTH_OPS);
    }
  }
  const averageBytes = expected / LENGTH_OPS;
  for (const arm of ['encode', 'byteLength'] as const) {
    write(
      `   ${arm.padEnd(11)} cells/frame=${cells[arm].toFixed(2)}  ns/frame p50=${percentile(times[arm], 0.5).toFixed(1)} ` +
        `p95=${percentile(times[arm], 0.95).toFixed(1)} (lease+registered frames, avg ${averageBytes.toFixed(0)} B, n=${times[arm].length})`,
    );
  }
}

/**
 * Inbound frame validation with the production parsers: the daemon parses a
 * `lease` every 20 s, the server a `command_ack` per command. Their byte-length
 * guards (`decodeFrame`, `readIdentifier`, `readRejectionReason`) encode the
 * value only to read its length, so cells here include those copies.
 */
async function measureParse(label: string, frame: string, parse: (raw: string) => unknown) {
  if (parse(frame) === null) throw new Error(`bench: ${label} did not parse`);
  for (let index = 0; index < LENGTH_OPS; index += 1) parse(frame);
  const { cells } = await cellsFor(async () => {
    for (let index = 0; index < LENGTH_OPS; index += 1) parse(frame);
  }, 1);
  const times: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const startedAt = Bun.nanoseconds();
    for (let index = 0; index < LENGTH_OPS; index += 1) parse(frame);
    times.push((Bun.nanoseconds() - startedAt) / LENGTH_OPS);
  }
  write(
    `   ${label.padEnd(26)} frame=${Buffer.byteLength(frame)} B  cells/parse=${(cells / LENGTH_OPS).toFixed(2)}  ` +
      `ns/parse p50=${percentile(times, 0.5).toFixed(0)} p95=${percentile(times, 0.95).toFixed(0)} (n=${SAMPLES}x${LENGTH_OPS})`,
  );
}

write(`daemon control benchmark: daemons=${DAEMONS}, samples=${SAMPLES}`);
write('1. per-daemon steady state (production service, in-memory coordination)');
const production = await createFleet(
  createStunTicketIssuer(new Uint8Array(64).fill(9), ['stun.test:3478', 'stun.test:3479'], []),
  true,
);
await measurePings(production);
await measureRenewals('real stun', production);
const constantStun = await createFleet(
  {
    serversFor: () => ['stun.test:3478', 'stun.test:3479'],
    issue: () => ({ ticket: 'A'.repeat(55), secret: 'B'.repeat(43), lifetimeMs: 90_000 }),
  },
  false,
);
await measureRenewals('const stun', constantStun);
write('2. sendFrame byte-length check, paired A/B');
await measureLengthCheck(
  production.sockets.flatMap((socket) => socket.frames.slice(0, 2)).slice(0, 256),
);
write('3. inbound frame validation (production parsers)');
const leaseFrame = production.sockets[0]?.frames.at(-1) ?? '';
await measureParse('daemon parses lease', leaseFrame, parseDaemonControlServerMessage);
await measureParse(
  'server parses command_ack',
  encodeDaemonControlMessage(
    createDaemonControlCommandAckMessage(crypto.randomUUID(), { status: 'accepted' }),
  ),
  parseDaemonControlDaemonMessage,
);
await measureParse(
  'server parses rejected ack',
  encodeDaemonControlMessage(
    createDaemonControlCommandAckMessage(crypto.randomUUID(), {
      status: 'rejected',
      reason: 'dataplane_backpressure',
    }),
  ),
  parseDaemonControlDaemonMessage,
);
await Effect.runPromise(production.service.shutdown);
await Effect.runPromise(constantStun.service.shutdown);
