import '@merkur/shared/e2e-wasm-bun';
/**
 * Round trips and allocations on the queries the server runs in steady state.
 *
 * The database is reached over a connection now, so the unit of cost is the
 * round trip: one `execute` is one request the server waits for, and a query
 * that needs two is twice as exposed to the network as one that needs one.
 * That is what this measures, alongside allocations and wall time, for the
 * queries that run continuously:
 *
 * - `verify-bearer`: `AuthService.verifyBearerToken`, run by every
 *   authenticated browser request (the link report streams one every 2 s per
 *   opted-in session).
 * - `touch-seen-1` / `touch-seen-128`: `DeviceService.touchDaemonsSeen`, run
 *   by every lease-renewal chunk (every 20 s per daemon; one daemon and a full
 *   128-daemon chunk).
 * - `list-devices`: `DeviceService.listDevices`, per device-list snapshot.
 * - `daemon-proof`: `DeviceService.authenticateDaemonProof`, per daemon HTTP
 *   request; its ML-DSA-87 and P-256 verification shows the query's share.
 * - `health-probe`: the `SELECT 1` the health monitor runs every 5 s.
 *
 * Round trips per operation is the regression gate. It is a property of the
 * code rather than of the host, so it is exact and does not move with load:
 * a query that grows a second round trip has had a real cost added to every
 * request that runs it, however fast the local database answers.
 *
 * Measured against a local in-memory libSQL database, which is the same engine
 * and the same SQL as the server it talks to in production, so the round trips
 * counted here are the round trips production makes. Wall time is not: it omits
 * the network entirely, and only says what the query costs before the wire.
 *
 * Reported per workload: round trips per operation (counted at the client), JS
 * cells allocated per operation (`heapStats().objectTypeCounts` summed after a
 * full collection, minus a control loop that awaits the same number of turns),
 * and wall time per operation from repeated batches.
 */

import { fullGC, heapStats } from 'bun:jsc';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Client } from '@libsql/client';
import {
  createAccessToken,
  deriveSessionAuthorizationKeyPair,
  deriveSoftwareDaemonP256PublicKey,
  signDaemonProof,
} from '@merkur/auth';
import { Clock, Effect } from 'effect';
import { Kysely, sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { percentile, perfEnvInteger } from '../../../scripts/perf/harness';
import { createDatabaseClient } from '../src/db/client';
import { LibsqlDialect } from '../src/db/libsql-dialect';
import type { DatabaseSchema } from '../src/db/types';
import { createAuthService } from '../src/services/auth-service';
import { createDeviceService } from '../src/services/device-service';
import type { DaemonPresenceState } from '../src/services/realtime-coordination-service';
import type { RedisService } from '../src/services/redis-service';

const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 40);
const OPS_PER_SAMPLE = perfEnvInteger('BENCH_OPS', 200);
const WARMUP_OPS = perfEnvInteger('BENCH_WARMUP_OPS', 2_000);
const ALLOCATION_OPS = perfEnvInteger('BENCH_ALLOCATION_OPS', 200);
const ONLY = process.env.BENCH_ONLY ?? '';

const MIGRATIONS_DIRECTORY = path.join(import.meta.dir, '../migrations');
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const DELEGATION_ID = 'delegation-1';
const DAEMON_COUNT = 128;
const LISTED_DAEMONS = 3;
const SEED = Buffer.alloc(32, 0x22);
const ACCESS_TOKEN_CONFIG = {
  hmacKey: new Uint8Array(64).fill(0x44),
  issuer: 'merkur-bench',
  audience: 'merkur-bench',
} as const;
const FAR_FUTURE_MS = Date.now() + 365 * 24 * 60 * 60 * 1_000;

interface Workload {
  readonly name: string;
  readonly frequency: string;
  run(): Promise<unknown>;
}

/** Counted at the client, because that is where a round trip actually leaves. */
let roundTrips = 0;

/**
 * Counts every statement handed to the database, including the ones a
 * transaction sends, so a query that opens one is charged for its `BEGIN` and
 * `COMMIT` as well as its statements.
 */
function countingClient(inner: Client): Client {
  const countedCall =
    (method: (...args: never[]) => unknown, self: object) =>
    (...args: never[]): unknown => {
      roundTrips += 1;
      return Reflect.apply(method, self, args);
    };
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver): unknown {
        const value = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'execute' || property === 'batch' || property === 'executeMultiple') {
          return countedCall(value as (...args: never[]) => unknown, object);
        }
        if (property === 'commit' || property === 'rollback') {
          return countedCall(value as (...args: never[]) => unknown, object);
        }
        if (property === 'transaction') {
          return async (...args: never[]): Promise<unknown> => {
            roundTrips += 1;
            const transaction = await Reflect.apply(value, object, args);
            return wrap(transaction as object);
          };
        }
        return (value as (...args: never[]) => unknown).bind(object);
      },
    });
  return wrap(inner);
}

async function seed(db: Kysely<DatabaseSchema>): Promise<void> {
  const p256 = Buffer.from(deriveSoftwareDaemonP256PublicKey(SEED)).toString('base64url');
  const identity = Buffer.from(deriveSessionAuthorizationKeyPair(SEED).verifyKey).toString(
    'base64url',
  );
  for (const userId of [USER_ID, OTHER_USER_ID]) {
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: `${userId}@example.com`,
        opaque_registration_record: 'A'.repeat(256),
        root_public_key: 'A'.repeat(3_456),
        root_key_commitment: 'A'.repeat(86),
        root_epoch: 1,
        root_envelope_nonce: 'A'.repeat(16),
        root_envelope_ciphertext: 'A'.repeat(64),
        created_at: 1,
      })
      .execute();
  }
  await db
    .insertInto('browser_delegations')
    .values({
      id: DELEGATION_ID,
      user_id: USER_ID,
      certificate_json: '{}',
      delegate_public_key: 'A'.repeat(64),
      issued_at: 1,
      expires_at: FAR_FUTURE_MS,
      revoked_at: null,
      root_epoch: 1,
      client_browser: 'Chrome',
      client_platform: 'macOS',
      client_installed: 0,
    })
    .execute();
  for (let index = 0; index < DAEMON_COUNT; index += 1) {
    await db
      .insertInto('daemons')
      .values({
        id: daemonId(index),
        // listDevices reads every daemon of the user; the listed user owns three.
        user_id: index < LISTED_DAEMONS ? USER_ID : OTHER_USER_ID,
        name: `Daemon ${index}`,
        platform: 'test',
        daemon_identity_public_key: identity,
        daemon_identity_p256_public_key: p256,
        identity_seal_backend: 'software',
        daemon_identity_key_commitment: 'daemon-key-commitment',
        daemon_binding_json: '{"binding":true}',
        last_seen: null,
        version: null,
      })
      .execute();
  }
}

function daemonId(index: number): string {
  return `daemon-${String(index).padStart(3, '0')}`;
}

/**
 * `touchDaemonsSeen` throttles each daemon for 15 s. The bench advances this
 * clock 20 s per call (the lease-renewal period) so every call writes, exactly
 * as a renewal does in production.
 */
function steppingClock(): { readonly clock: Clock.Clock; step(): void } {
  const base = Effect.runSync(Effect.clockWith(Effect.succeed));
  let nowMs = 1_700_000_000_000;
  return {
    clock: {
      ...base,
      currentTimeMillisUnsafe: () => nowMs,
      currentTimeMillis: Effect.sync(() => nowMs),
    },
    step() {
      nowMs += 20_000;
    },
  };
}

const fakeRedis = {} as RedisService;

async function createBenchDatabase(): Promise<Kysely<DatabaseSchema>> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect(countingClient(createDatabaseClient(':memory:', undefined))),
  });
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIRECTORY }),
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw new Error(`bench: migration failed: ${String(result.error)}`);
  }
  return db;
}

async function buildWorkloads(): Promise<Workload[]> {
  const db = await createBenchDatabase();
  await seed(db);

  const authConfig = {
    accessToken: ACCESS_TOKEN_CONFIG,
    tokenHmacSecret: 'bench-token-hmac-secret',
    allowRegistration: false,
    identity: { kind: 'username' as const },
    opaqueServerSetup: '',
    publicOrigin: 'https://merkur.test',
  };
  const auth = createAuthService(db, fakeRedis, authConfig, Effect.void);
  const deviceConfig = { tokenHmacSecret: 'bench-hmac', publicOrigin: 'https://merkur.test' };
  const devices = createDeviceService(db, deviceConfig, Effect.void);
  const clock = steppingClock();
  const token = await createAccessToken(USER_ID, DELEGATION_ID, FAR_FUTURE_MS, ACCESS_TOKEN_CONFIG);
  const presence = new Map<string, DaemonPresenceState>();
  const allIds = Array.from({ length: DAEMON_COUNT }, (_, index) => daemonId(index));
  const transcript = new TextEncoder().encode('bound request');
  const signature = signDaemonProof(SEED.toString('base64url'), 'http', transcript);

  const touch = (ids: readonly string[]) => {
    clock.step();
    return Effect.runPromise(
      devices.touchDaemonsSeen(ids).pipe(Effect.provideService(Clock.Clock, clock.clock)),
    );
  };

  const workloads: Workload[] = [
    {
      name: 'verify-bearer',
      frequency: 'per authenticated browser request',
      run: () => Effect.runPromise(auth.verifyBearerToken(token)),
    },
    {
      name: 'touch-seen-1',
      frequency: 'per lease-renewal chunk (20 s per daemon), one daemon',
      run: () => touch(allIds.slice(0, 1)),
    },
    {
      name: 'touch-seen-128',
      frequency: 'per lease-renewal chunk, full 128-daemon chunk',
      run: () => touch(allIds),
    },
    {
      name: 'list-devices',
      frequency: 'per device-list snapshot',
      run: () => Effect.runPromise(devices.listDevices(USER_ID, presence)),
    },
    {
      name: 'daemon-proof',
      frequency: 'per daemon HTTP request (includes ML-DSA-87 + P-256 verify)',
      run: () =>
        Effect.runPromise(
          devices.authenticateDaemonProof(
            daemonId(0),
            transcript,
            signature.mldsa,
            'http',
            signature.p256,
          ),
        ),
    },
    {
      name: 'health-probe',
      frequency: 'every 5 s (server health monitor)',
      run: () =>
        sql<{ readonly healthy: number }>`SELECT 1 AS healthy`
          .execute(db)
          .then((result) => result.rows),
    },
  ];
  return workloads.filter((workload) => ONLY === '' || workload.name === ONLY);
}

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

/**
 * Cells per operation, minus a control loop. A collection inside the measured
 * loop frees cells and undercounts, so one is detected through `objectCount`
 * (survivors of the last collection) and the measurement retried at half size.
 */
async function cellsPerOp(run: () => Promise<unknown>, ops: number): Promise<number> {
  for (let attempt = ops; attempt >= 1; attempt = Math.floor(attempt / 2)) {
    fullGC();
    const controlBefore = liveCells();
    for (let index = 0; index < attempt; index += 1) await null;
    const control = liveCells() - controlBefore;
    fullGC();
    const survivors = heapStats().objectCount;
    const before = liveCells();
    for (let index = 0; index < attempt; index += 1) await run();
    const after = liveCells();
    if (heapStats().objectCount === survivors) return (after - before - control) / attempt;
  }
  throw new Error('bench: a collection ran during every allocation measurement');
}

async function roundTripsPerOp(run: () => Promise<unknown>, ops: number): Promise<number> {
  const before = roundTrips;
  for (let index = 0; index < ops; index += 1) await run();
  return (roundTrips - before) / ops;
}

async function timeBatch(run: () => Promise<unknown>): Promise<number> {
  const startedAt = Bun.nanoseconds();
  for (let index = 0; index < OPS_PER_SAMPLE; index += 1) await run();
  return (Bun.nanoseconds() - startedAt) / OPS_PER_SAMPLE;
}

interface WorkloadResult {
  readonly nsPerOp: number[];
  roundTripsPerOp: number;
  cellsPerOp: number;
}

async function measure(workload: Workload): Promise<WorkloadResult> {
  for (let index = 0; index < WARMUP_OPS; index += 1) await workload.run();
  const result: WorkloadResult = { nsPerOp: [], roundTripsPerOp: 0, cellsPerOp: 0 };
  result.roundTripsPerOp = await roundTripsPerOp(() => workload.run(), ALLOCATION_OPS);
  result.cellsPerOp = await cellsPerOp(() => workload.run(), ALLOCATION_OPS);
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    result.nsPerOp.push(await timeBatch(() => workload.run()));
  }
  return result;
}

const workloads = await buildWorkloads();
process.stdout.write(
  `database round-trip benchmark: samples=${SAMPLES}, ops/sample=${OPS_PER_SAMPLE}, ` +
    `warmup=${WARMUP_OPS}, allocation ops=${ALLOCATION_OPS}\n` +
    'workload         round-trips/op  cells/op   ns/op p50   ns/op p95\n',
);
for (const workload of workloads) {
  const result = await measure(workload);
  process.stdout.write(
    `${workload.name.padEnd(16)} ${result.roundTripsPerOp.toFixed(2).padStart(14)} ` +
      `${result.cellsPerOp.toFixed(1).padStart(9)} ${percentile(result.nsPerOp, 0.5).toFixed(0).padStart(11)} ` +
      `${percentile(result.nsPerOp, 0.95).toFixed(0).padStart(11)}\n`,
  );
  process.stdout.write(
    `${''.padEnd(16)} (${workload.frequency}; n=${result.nsPerOp.length} batches)\n`,
  );
}
