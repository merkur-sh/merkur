import type { Client, InValue, ResultSet, Transaction } from '@libsql/client';
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

import type { DatabaseSchema } from './types';

const ERROR_INVALID_BINDING = 'Unsupported SQLite binding value';
const ERROR_NO_STREAMING = 'Merkur does not stream query results';
const ERROR_NOT_A_LIBSQL_CONNECTION = 'Connection was not created by the libSQL driver';
const ERROR_FOREIGN_KEYS_OFF =
  'The database is not enforcing foreign keys, so an account erasure would silently orphan rows';
const ERROR_NESTED_TRANSACTION = 'A libSQL connection is already inside a transaction';
const ERROR_NO_TRANSACTION = 'A libSQL connection is not inside a transaction';

const SQL_ENABLE_FOREIGN_KEYS = 'PRAGMA foreign_keys = ON';
const SQL_READ_FOREIGN_KEYS = 'PRAGMA foreign_keys';
const FOREIGN_KEYS_ENFORCED = 1;

/**
 * Write transactions begin as `BEGIN IMMEDIATE`, never deferred.
 *
 * A deferred transaction takes a read snapshot first and asks for the write
 * lock only at its first write, so two transactions that read then write race
 * to upgrade and the loser gets `SQLITE_BUSY`. Measured against sqld: deferred
 * read-then-write fails under contention, while the same workload begun
 * immediately serialises cleanly with no errors. Taking the lock up front means
 * the conflict cannot occur, which is worth more than a retry policy that
 * papers over it after the fact. Kysely's own `startTransaction()` would issue
 * a plain deferred `BEGIN`, so the mode is forced here rather than left to it.
 */
const TRANSACTION_MODE = 'write';

/**
 * SQLite `CREATE`/`DROP`/`ALTER` participate in explicit transactions. Kysely
 * conservatively disables transactional DDL in its generic SQLite adapter,
 * which would leave a failed migration partially applied with its ledger row
 * absent. Merkur's migration uses only the transactional subset (no `VACUUM`,
 * no transaction-changing pragma), so opt into the atomic migrator path.
 */
class MerkurSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

/**
 * One Kysely connection over a libSQL client.
 *
 * These are deliberately cheap: a new one is handed out per acquisition and
 * holds nothing but the client and, while a transaction is open, its handle.
 * Pooling, reconnection and request concurrency belong to the libSQL client,
 * which owns the socket. Outside a transaction every statement goes straight
 * to the client and independent queries proceed concurrently; inside one they
 * are routed through the transaction's own stream, which is what keeps the
 * statements of a transaction on a single server-side connection.
 */
class LibsqlConnection implements DatabaseConnection {
  readonly #client: Client;
  #transaction: Transaction | undefined;

  constructor(client: Client) {
    this.#client = client;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const target = this.#transaction ?? this.#client;
    const result = await target.execute({
      sql: compiledQuery.sql,
      args: toLibsqlArguments(compiledQuery.parameters),
    });
    return toQueryResult<R>(result);
  }

  // Kysely's connection contract includes streaming; nothing in Merkur reads a
  // result set incrementally, and libSQL exposes no cursor to do it with, so
  // this refuses loudly rather than quietly buffering the whole result.
  // biome-ignore lint/correctness/useYield: an always-throwing generator has nothing to yield.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(ERROR_NO_STREAMING);
  }

  async begin(): Promise<void> {
    if (this.#transaction !== undefined) throw new Error(ERROR_NESTED_TRANSACTION);
    this.#transaction = await this.#client.transaction(TRANSACTION_MODE);
  }

  async commit(): Promise<void> {
    const transaction = this.#takeTransaction();
    await transaction.commit();
  }

  async rollback(): Promise<void> {
    const transaction = this.#takeTransaction();
    await transaction.rollback();
  }

  /**
   * Releasing a connection that still holds an open transaction would leak the
   * server-side stream and, with it, the write lock. Kysely only reaches here
   * after commit or rollback, so this is the backstop for a path that does not.
   */
  release(): void {
    const transaction = this.#transaction;
    this.#transaction = undefined;
    transaction?.close();
  }

  #takeTransaction(): Transaction {
    const transaction = this.#transaction;
    if (transaction === undefined) throw new Error(ERROR_NO_TRANSACTION);
    this.#transaction = undefined;
    return transaction;
  }
}

export class LibsqlDriver implements Driver {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  /**
   * Foreign-key enforcement is asserted, not assumed.
   *
   * Account erasure is a single `DELETE FROM users` that relies entirely on
   * `ON DELETE CASCADE`. SQLite defaults enforcement off per connection; a
   * libSQL server defaults it on. Either way the failure is silent -- the
   * delete reports success and leaves the personal data behind -- so the
   * setting is written and then read back, and a server that disagrees stops
   * the process here instead of at the first erasure.
   */
  async init(): Promise<void> {
    await this.#client.execute(SQL_ENABLE_FOREIGN_KEYS);
    const result = await this.#client.execute(SQL_READ_FOREIGN_KEYS);
    const reported = result.rows[0]?.foreign_keys;
    const enforced = typeof reported === 'bigint' ? Number(reported) : reported;
    if (enforced !== FOREIGN_KEYS_ENFORCED) throw new Error(ERROR_FOREIGN_KEYS_OFF);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new LibsqlConnection(this.#client);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await libsqlConnection(connection).begin();
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await libsqlConnection(connection).commit();
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await libsqlConnection(connection).rollback();
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    libsqlConnection(connection).release();
  }

  async destroy(): Promise<void> {
    this.#client.close();
  }
}

export class LibsqlDialect implements Dialect {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  createAdapter(): DialectAdapter {
    return new MerkurSqliteAdapter();
  }

  createDriver(): Driver {
    return new LibsqlDriver(this.#client);
  }

  createQueryCompiler(): QueryCompiler {
    return createSqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<DatabaseSchema>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/**
 * The compiler this dialect uses, exposed so anything that compiles SQL text
 * ahead of time produces exactly the text this dialect would have produced.
 */
export function createSqliteQueryCompiler(): QueryCompiler {
  return new SqliteQueryCompiler();
}

function libsqlConnection(connection: DatabaseConnection): LibsqlConnection {
  if (!(connection instanceof LibsqlConnection)) {
    throw new Error(ERROR_NOT_A_LIBSQL_CONNECTION);
  }
  return connection;
}

function toQueryResult<R>(result: ResultSet): QueryResult<R> {
  const { columns, rows: resultRows } = result;
  const rows: R[] = new Array<R>(resultRows.length);
  for (let index = 0; index < resultRows.length; index += 1) {
    const source = resultRows[index];
    const row: Record<string, unknown> = {};
    // Read positionally against the declared columns rather than copying the
    // driver's row object, whose own shape (array-like as well as keyed) is
    // not something the rest of the codebase should ever observe.
    for (let column = 0; column < columns.length; column += 1) {
      const name = columns[column];
      if (name === undefined) continue;
      row[name] = source?.[column];
    }
    rows[index] = row as R;
  }
  return {
    rows,
    numAffectedRows: BigInt(result.rowsAffected),
    insertId: result.lastInsertRowid,
  };
}

function toLibsqlArguments(parameters: ReadonlyArray<unknown>): InValue[] {
  const values: InValue[] = new Array<InValue>(parameters.length);
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    const parameterType = typeof parameter;
    const isBindable =
      parameter === null ||
      parameter === undefined ||
      parameterType === 'string' ||
      parameterType === 'bigint' ||
      parameterType === 'number' ||
      parameterType === 'boolean' ||
      (ArrayBuffer.isView(parameter) && !(parameter instanceof DataView));
    if (!isBindable) throw new Error(ERROR_INVALID_BINDING);
    // libSQL binds `undefined` as NULL only if it is given null explicitly.
    values[index] = (parameter ?? null) as InValue;
  }
  return values;
}
