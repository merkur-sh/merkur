import { describe, expect, test } from 'bun:test';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { Kysely, sql } from 'kysely';

import { createDatabaseClient } from './client';
import { LibsqlDialect } from './libsql-dialect';
import {
  DatabaseTransactionBeginError,
  DatabaseTransactionCommitError,
  DatabaseTransactionRollbackError,
  tryDatabaseTransactionPromise,
  withDatabaseTransaction,
  withTransactionResource,
} from './transaction';
import type { DatabaseSchema } from './types';

describe('withDatabaseTransaction', () => {
  test.each(['use', 'commit'] as const)(
    'rolls back a synchronous %s callback defect',
    async (phase) => {
      const defect = new Error(`${phase} callback threw`);
      let rollbackCalls = 0;
      const result = await Effect.runPromise(
        Effect.exit(
          withTransactionResource(
            Effect.succeed({ id: 'transaction-1' }),
            () => {
              if (phase === 'use') throw defect;
              return Effect.void;
            },
            () => {
              throw defect;
            },
            () =>
              Effect.sync(() => {
                rollbackCalls += 1;
              }),
          ),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isSuccess(result)) throw new Error('transaction unexpectedly succeeded');
      expect(Cause.squash(result.cause)).toBe(defect);
      expect(rollbackCalls).toBe(1);
    },
  );

  test('retains a synchronous rollback defect alongside the use failure', async () => {
    const useError = new Error('use failed');
    const rollbackDefect = new Error('rollback callback threw');
    const result = await Effect.runPromise(
      Effect.exit(
        withTransactionResource(
          Effect.succeed({ id: 'transaction-1' }),
          () => Effect.fail(useError),
          () => Effect.void,
          () => {
            throw rollbackDefect;
          },
        ),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isSuccess(result)) throw new Error('transaction unexpectedly succeeded');
    expect(result.cause.reasons).toHaveLength(2);
    expect(
      result.cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && reason.error === useError,
      ),
    ).toBe(true);
    expect(
      result.cause.reasons.some(
        (reason) => Cause.isDieReason(reason) && reason.defect === rollbackDefect,
      ),
    ).toBe(true);
  });

  test('interruption settles a native transaction coroutine before rollback', async () => {
    const db = await createTestDatabase();
    const release = Promise.withResolvers<void>();
    let completed = false;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const fiber = yield* withDatabaseTransaction(db, (trx) =>
            tryDatabaseTransactionPromise({
              try: async () => {
                Deferred.doneUnsafe(started, Effect.void);
                await release.promise;
                await sql`insert into transaction_test (value) values ('late-write')`.execute(trx);
                completed = true;
              },
              catch: (cause) => cause,
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(completed).toBe(false);
          release.resolve();
          yield* Fiber.join(interrupted);
          expect(completed).toBe(true);
        }),
      );
      expect(await readValues(db)).toEqual([]);
    } finally {
      release.resolve();
      await db.destroy();
    }
  });

  test('commits a successful transaction', async () => {
    const db = await createTestDatabase();
    try {
      await Effect.runPromise(
        withDatabaseTransaction(db, (trx) =>
          Effect.promise(() =>
            sql`insert into transaction_test (value) values ('committed')`.execute(trx),
          ),
        ),
      );

      expect(await readValues(db)).toEqual(['committed']);
    } finally {
      await db.destroy();
    }
  });

  test('rolls back a failed transaction without replacing the use error', async () => {
    const db = await createTestDatabase();
    const useError = new Error('use failed');
    try {
      const observed = await Effect.runPromise(
        withDatabaseTransaction(db, (trx) =>
          Effect.promise(() =>
            sql`insert into transaction_test (value) values ('rolled-back')`.execute(trx),
          ).pipe(Effect.andThen(Effect.fail(useError))),
        ).pipe(Effect.flip),
      );

      expect(observed).toBe(useError);
      expect(await readValues(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test('rolls back when the use effect is interrupted', async () => {
    const db = await createTestDatabase();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const inserted = yield* Deferred.make<void>();
          const fiber = yield* withDatabaseTransaction(db, (trx) =>
            Effect.promise(() =>
              sql`insert into transaction_test (value) values ('interrupted')`.execute(trx),
            ).pipe(
              Effect.tap(() => Deferred.succeed(inserted, undefined)),
              Effect.andThen(Effect.never),
            ),
          ).pipe(Effect.forkChild);

          yield* Deferred.await(inserted);
          yield* Fiber.interrupt(fiber);
        }),
      );

      expect(await readValues(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test('reports typed begin and commit failures', async () => {
    const destroyed = await createTestDatabase();
    await destroyed.destroy();

    const beginError = await Effect.runPromise(
      withDatabaseTransaction(destroyed, () => Effect.void).pipe(Effect.flip),
    );
    expect(beginError).toBeInstanceOf(DatabaseTransactionBeginError);
    expect(beginError.transactionPhase).toBe('begin');

    const expectedCommitError = new DatabaseTransactionCommitError(new Error('commit failed'));
    let rollbackCalls = 0;
    const commitError = await Effect.runPromise(
      withTransactionResource(
        Effect.succeed({ id: 'transaction-1' }),
        () => Effect.succeed('done'),
        () => Effect.fail(expectedCommitError),
        () =>
          Effect.sync(() => {
            rollbackCalls += 1;
          }),
      ).pipe(Effect.flip),
    );
    expect(commitError).toBe(expectedCommitError);
    expect(commitError.transactionPhase).toBe('commit');
    expect(rollbackCalls).toBe(1);
  });

  test('retains both the use failure and a typed rollback failure', async () => {
    const db = await createTestDatabase();
    const useError = new Error('use failed after transaction was closed');
    try {
      const result = await Effect.runPromise(
        Effect.exit(
          withDatabaseTransaction(db, (trx) =>
            Effect.promise(() => trx.commit().execute()).pipe(
              Effect.andThen(Effect.fail(useError)),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isSuccess(result)) throw new Error('transaction unexpectedly succeeded');

      const failures = result.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) ? [reason.error] : [],
      );
      expect(failures).toContain(useError);
      expect(failures.some((error) => error instanceof DatabaseTransactionRollbackError)).toBe(
        true,
      );
    } finally {
      await db.destroy();
    }
  });

  test('pairs a delayed successful BEGIN with rollback when interrupted during acquisition', async () => {
    const cleanup = await Effect.runPromise(
      Effect.gen(function* () {
        const acquisitionStarted = yield* Deferred.make<void>();
        const transactionReady = yield* Deferred.make<{ readonly id: string }>();
        let rollbackCalls = 0;

        const transaction = withTransactionResource(
          Deferred.succeed(acquisitionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(transactionReady)),
          ),
          () => Effect.never,
          () => Effect.void,
          () =>
            Effect.sync(() => {
              rollbackCalls += 1;
            }),
        );

        const transactionFiber = yield* transaction.pipe(Effect.forkChild);
        yield* Deferred.await(acquisitionStarted);
        const interruptFiber = yield* Fiber.interrupt(transactionFiber).pipe(Effect.forkChild);
        yield* Deferred.succeed(transactionReady, { id: 'transaction-1' });
        yield* Fiber.join(interruptFiber);
        return rollbackCalls;
      }),
    );

    expect(cleanup).toBe(1);
  });
});

async function createTestDatabase(): Promise<Kysely<DatabaseSchema>> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new LibsqlDialect(createDatabaseClient(':memory:', undefined)),
  });
  await sql`create table transaction_test (value text not null)`.execute(db);
  return db;
}

async function readValues(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const result = await sql<{ readonly value: string }>`
    select value from transaction_test order by rowid
  `.execute(db);
  return result.rows.map((row) => row.value);
}
