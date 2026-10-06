import '@merkur/shared/e2e-wasm-bun';
/**
 * Cost of building and compiling a Kysely query on every call.
 *
 * `bench-sqlite-statements.ts` measures the `sqlite3_prepare` each query pays.
 * This measures the step before it: every call to a service method rebuilds
 * the query-builder tree (immutable, frozen nodes) and runs Kysely's SQLite
 * compiler over it to produce the same SQL text as the call before, with only
 * the bound values differing.
 *
 * All arms run over one migrated in-memory database whose adapter memoizes
 * `prepare` by SQL text (the change `bench-sqlite-statements.ts` proposes), so
 * the difference between arms is query construction alone:
 *
 * - `builder`: the production query exactly as the service writes it.
 * - `template`: the same SQL as a `sql` tagged template; Kysely still builds
 *   and compiles a `RawNode` per call, but a small one.
 * - `compiled`: the builder compiled once; each call executes
 *   `CompiledQuery.raw(text, parameters)` with the call's values.
 *
 * Workloads: `findActiveDelegation` (inside `AuthService.verifyBearerToken`,
 * per authenticated browser request) and the one-id `touchDaemonsSeen` update
 * (per lease-renewal chunk). Every arm asserts rows and SQL text identical to
 * the builder's. Reported: JS cells per call (heapStats object counts after a
 * full collection, control subtracted), build+compile alone, and paired
 * ABBA wall time per executed query.
 */

import { fullGC, heapStats } from 'bun:jsc';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CompiledQuery, Kysely, sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { percentile, perfEnvInteger } from '../../../scripts/perf/harness';
import { createDatabaseClient } from '../src/db/client';
import { LibsqlDialect } from '../src/db/libsql-dialect';
import type { DatabaseSchema } from '../src/db/types';

const SAMPLES = perfEnvInteger('BENCH_SAMPLES', 40);
const OPS_PER_SAMPLE = perfEnvInteger('BENCH_OPS', 500);
const WARMUP_OPS = perfEnvInteger('BENCH_WARMUP_OPS', 5_000);
const ALLOCATION_OPS = perfEnvInteger('BENCH_ALLOCATION_OPS', 200);

const MIGRATIONS_DIRECTORY = path.join(import.meta.dir, '../migrations');
const USER_ID = 'user-1';
const DELEGATION_ID = 'delegation-1';
const DAEMON_ID = 'daemon-000';
const FAR_FUTURE_MS = Date.now() + 365 * 24 * 60 * 60 * 1_000;

type Arm = 'builder' | 'template' | 'compiled';
const ARMS: readonly Arm[] = ['builder', 'template', 'compiled'];

async function createDatabase(): Promise<Kysely<DatabaseSchema>> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect(createDatabaseClient(':memory:', undefined)),
  });
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIRECTORY }),
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw new Error(`bench: migration failed: ${String(result.error)}`);
  }
  await db
    .insertInto('users')
    .values({
      id: USER_ID,
      username: 'user-1@example.com',
      opaque_registration_record: 'A'.repeat(256),
      root_public_key: 'A'.repeat(3_456),
      root_key_commitment: 'A'.repeat(86),
      root_epoch: 1,
      root_envelope_nonce: 'A'.repeat(16),
      root_envelope_ciphertext: 'A'.repeat(64),
      created_at: 1,
    })
    .execute();
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
  await db
    .insertInto('daemons')
    .values({
      id: DAEMON_ID,
      user_id: USER_ID,
      name: 'Daemon',
      platform: 'test',
      daemon_identity_public_key: 'A'.repeat(64),
      daemon_identity_p256_public_key: 'A'.repeat(64),
      identity_seal_backend: 'software',
      daemon_identity_key_commitment: 'daemon-key-commitment',
      daemon_binding_json: '{"binding":true}',
      last_seen: null,
      version: null,
    })
    .execute();
  return db;
}

interface DelegationRow {
  readonly delegation_id: string | null;
  readonly expires_at: number;
  readonly delegation_root_epoch: number;
  readonly user_root_epoch: number;
}

interface Workload {
  readonly name: string;
  readonly frequency: string;
  /** Builds and compiles without executing; `null` for arms that build nothing. */
  readonly compile: Record<Arm, ((index: number) => CompiledQuery) | null>;
  readonly run: Record<Arm, (index: number) => Promise<unknown>>;
}

function buildWorkloads(db: Kysely<DatabaseSchema>): Workload[] {
  // Exactly `findActiveDelegation` in apps/server/src/services/auth-service.ts.
  const delegationQuery = (delegationId: string, userId: string, now: number) =>
    db
      .selectFrom('browser_delegations as delegation')
      .innerJoin('users as user', 'user.id', 'delegation.user_id')
      .select([
        'delegation.id as delegation_id',
        'delegation.expires_at as expires_at',
        'delegation.root_epoch as delegation_root_epoch',
        'user.root_epoch as user_root_epoch',
      ])
      .where('delegation.id', '=', delegationId)
      .where('delegation.user_id', '=', userId)
      .where('delegation.revoked_at', 'is', null)
      .where('delegation.expires_at', '>', now);
  const delegationTemplate = (delegationId: string, userId: string, now: number) =>
    sql<DelegationRow>`select "delegation"."id" as "delegation_id", "delegation"."expires_at" as "expires_at", "delegation"."root_epoch" as "delegation_root_epoch", "user"."root_epoch" as "user_root_epoch" from "browser_delegations" as "delegation" inner join "users" as "user" on "user"."id" = "delegation"."user_id" where "delegation"."id" = ${delegationId} and "delegation"."user_id" = ${userId} and "delegation"."revoked_at" is null and "delegation"."expires_at" > ${now}`;
  const delegationText = delegationQuery('', '', 0).compile().sql;

  // Exactly the one-id `touchDaemonsSeen` update in device-service.ts.
  const touchQuery = (now: number, ids: readonly string[]) =>
    db.updateTable('daemons').set({ last_seen: now }).where('id', 'in', ids);
  const touchTemplate = (now: number, id: string) =>
    sql`update "daemons" set "last_seen" = ${now} where "id" in (${id})`;
  const touchText = touchQuery(0, ['']).compile().sql;

  const now = (index: number) => 1_700_000_000_000 + index;
  const ids = [DAEMON_ID];
  return [
    {
      name: 'find-delegation',
      frequency: 'per authenticated browser request (verifyBearerToken)',
      compile: {
        builder: (index) => delegationQuery(DELEGATION_ID, USER_ID, now(index)).compile(),
        template: (index) => delegationTemplate(DELEGATION_ID, USER_ID, now(index)).compile(db),
        compiled: (index) =>
          CompiledQuery.raw(delegationText, [DELEGATION_ID, USER_ID, now(index)]),
      },
      run: {
        builder: (index) => delegationQuery(DELEGATION_ID, USER_ID, now(index)).executeTakeFirst(),
        template: (index) =>
          delegationTemplate(DELEGATION_ID, USER_ID, now(index))
            .execute(db)
            .then((result) => result.rows[0]),
        compiled: (index) =>
          db
            .executeQuery<DelegationRow>(
              CompiledQuery.raw(delegationText, [DELEGATION_ID, USER_ID, now(index)]),
            )
            .then((result) => result.rows[0]),
      },
    },
    {
      name: 'touch-seen-1',
      frequency: 'per lease-renewal chunk with one daemon (touchDaemonsSeen)',
      compile: {
        builder: (index) => touchQuery(now(index), ids).compile(),
        template: (index) => touchTemplate(now(index), DAEMON_ID).compile(db),
        compiled: (index) => CompiledQuery.raw(touchText, [now(index), DAEMON_ID]),
      },
      run: {
        builder: (index) =>
          touchQuery(now(index), ids)
            .execute()
            .then((rows) => rows.map((row) => Number(row.numUpdatedRows))),
        template: (index) =>
          touchTemplate(now(index), DAEMON_ID)
            .execute(db)
            .then((result) => [Number(result.numAffectedRows)]),
        compiled: (index) =>
          db
            .executeQuery(CompiledQuery.raw(touchText, [now(index), DAEMON_ID]))
            .then((result) => [Number(result.numAffectedRows)]),
      },
    },
  ];
}

async function assertArmsAgree(workload: Workload): Promise<void> {
  const reference = workload.compile.builder?.(7);
  if (reference === undefined) throw new Error('bench: builder must compile');
  for (const arm of ARMS) {
    const compiled = workload.compile[arm]?.(7);
    if (compiled === undefined) continue;
    if (compiled.sql !== reference.sql) {
      throw new Error(
        `bench: ${workload.name} ${arm} SQL differs:\n${compiled.sql}\n${reference.sql}`,
      );
    }
    if (JSON.stringify(compiled.parameters) !== JSON.stringify(reference.parameters)) {
      throw new Error(`bench: ${workload.name} ${arm} parameters differ`);
    }
  }
  const expected = JSON.stringify(await workload.run.builder(7));
  for (const arm of ARMS) {
    const actual = JSON.stringify(await workload.run[arm](7));
    if (actual !== expected) {
      throw new Error(`bench: ${workload.name} ${arm} rows differ: ${actual} vs ${expected}`);
    }
  }
}

function liveCells(): number {
  const counts = heapStats().objectTypeCounts;
  let total = 0;
  for (const key in counts) total += counts[key] ?? 0;
  return total;
}

/** Cells per call, retried at half size whenever a collection ran mid-loop. */
async function cellsPerOp(run: (index: number) => unknown, ops: number): Promise<number> {
  for (let attempt = ops; attempt >= 1; attempt = Math.floor(attempt / 2)) {
    fullGC();
    const controlBefore = liveCells();
    for (let index = 0; index < attempt; index += 1) await null;
    const control = liveCells() - controlBefore;
    fullGC();
    const survivors = heapStats().objectCount;
    const before = liveCells();
    for (let index = 0; index < attempt; index += 1) await run(index);
    const after = liveCells();
    if (heapStats().objectCount === survivors) return (after - before - control) / attempt;
  }
  throw new Error('bench: a collection ran during every allocation measurement');
}

async function timeBatch(run: (index: number) => unknown): Promise<number> {
  const startedAt = Bun.nanoseconds();
  for (let index = 0; index < OPS_PER_SAMPLE; index += 1) await run(index);
  return (Bun.nanoseconds() - startedAt) / OPS_PER_SAMPLE;
}

const db = await createDatabase();
process.stdout.write(
  `sqlite query compile benchmark (prepare memoized in every arm): samples=${SAMPLES} ` +
    `(x2 per arm, ABBA), ops/sample=${OPS_PER_SAMPLE}, warmup=${WARMUP_OPS}\n` +
    'workload         arm        compile cells  compile ns p50  query cells  query ns p50  query ns p95\n',
);
for (const workload of buildWorkloads(db)) {
  await assertArmsAgree(workload);
  for (let index = 0; index < WARMUP_OPS; index += 1) {
    for (const arm of ARMS) {
      workload.compile[arm]?.(index);
      await workload.run[arm](index);
    }
  }
  const compileCells: Record<Arm, number> = { builder: 0, template: 0, compiled: 0 };
  const queryCells: Record<Arm, number> = { builder: 0, template: 0, compiled: 0 };
  const compileTimes: Record<Arm, number[]> = { builder: [], template: [], compiled: [] };
  const queryTimes: Record<Arm, number[]> = { builder: [], template: [], compiled: [] };
  for (const arm of ARMS) {
    const compile = workload.compile[arm];
    if (compile !== null) compileCells[arm] = await cellsPerOp(compile, ALLOCATION_OPS);
    queryCells[arm] = await cellsPerOp(workload.run[arm], ALLOCATION_OPS);
  }
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const forward = sample % 2 === 0 ? ARMS : [...ARMS].reverse();
    for (const arm of [...forward, ...[...forward].reverse()]) {
      const compile = workload.compile[arm];
      if (compile !== null) compileTimes[arm].push(await timeBatch(compile));
      queryTimes[arm].push(await timeBatch(workload.run[arm]));
    }
  }
  for (const arm of ARMS) {
    process.stdout.write(
      `${workload.name.padEnd(16)} ${arm.padEnd(10)} ${compileCells[arm].toFixed(1).padStart(13)} ` +
        `${percentile(compileTimes[arm], 0.5).toFixed(0).padStart(15)} ` +
        `${queryCells[arm].toFixed(1).padStart(12)} ${percentile(queryTimes[arm], 0.5).toFixed(0).padStart(13)} ` +
        `${percentile(queryTimes[arm], 0.95).toFixed(0).padStart(13)}\n`,
    );
  }
  process.stdout.write(
    `${''.padEnd(16)} (${workload.frequency}; n=${queryTimes.builder.length} batches/arm)\n`,
  );
}
await db.destroy();
