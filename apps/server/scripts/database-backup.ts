import '@merkur/shared/e2e-wasm-bun';
/**
 * Copies the whole database out to a file, and back into an empty one.
 *
 * A logical dump rather than a file copy, because the database is reached over
 * a connection: there is no file on this side to copy, and `VACUUM INTO` would
 * write on the server's disk where nothing can collect it. Reading the rows
 * works the same whether the database is a local file or a libSQL server, which
 * is what lets the same tool take a backup and move a database between the two.
 *
 * The dump is newline-delimited JSON: a header, one line per row, then a
 * trailer carrying the per-table counts. Restoring verifies those counts, so a
 * dump truncated by a dropped connection or a full disk is refused instead of
 * restored as a shorter database that still looks valid.
 *
 * Restore runs the migration itself and then loads the rows, rather than
 * copying the migration ledger, so a restored database is one this build
 * created. Tables load parents first, since foreign keys are enforced.
 *
 *   bun run apps/server/scripts/database-backup.ts dump    --url <url> --out <file>
 *   bun run apps/server/scripts/database-backup.ts restore --url <url> --in  <file>
 */

import type { InValue } from '@libsql/client';

import { createDatabaseClient } from '../src/db/client';
import { createMigratedKyselyDatabase } from '../src/db/migrate';
import type { DatabaseSchema } from '../src/db/types';

/**
 * Every table, ordered so a row's parents load before it does. Restoring walks
 * this list forwards; a table missing from it is not dumped, so it is also the
 * list a new table has to join.
 */
const TABLES = [
  'users',
  'browser_delegations',
  'daemons',
  'refresh_tokens',
  'daemon_link_claims',
  'delegation_revocations',
  'delegation_revocation_outbox',
  'link_tokens',
  'push_subscriptions',
  'keyboard_settings',
  'box_access',
  'box_waitlist',
] as const;

type TableName = (typeof TABLES)[number];

const FORMAT = 'merkur-database-dump-1';
const INSERT_CHUNK_ROWS = 200;

interface DumpHeader {
  readonly format: typeof FORMAT;
  readonly takenAt: string;
  readonly source: string;
}

interface DumpTrailer {
  readonly counts: Record<string, number>;
}

interface DumpRow {
  readonly table: TableName;
  readonly row: Record<string, InValue>;
}

const [command, ...rest] = process.argv.slice(2);
const options = parseOptions(rest);

if (command === 'dump') {
  await dump(required(options, 'url'), required(options, 'out'));
} else if (command === 'restore') {
  await restore(required(options, 'url'), required(options, 'in'));
} else {
  throw new Error('usage: database-backup.ts <dump|restore> --url <url> [--out|--in] <file>');
}

async function dump(url: string, outFile: string): Promise<void> {
  const client = createDatabaseClient(url, process.env.DB_AUTH_TOKEN);
  try {
    const header: DumpHeader = {
      format: FORMAT,
      takenAt: new Date().toISOString(),
      source: redactUrl(url),
    };
    const lines: string[] = [JSON.stringify(header)];
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      const result = await client.execute(`SELECT * FROM ${table}`);
      counts[table] = result.rows.length;
      for (const row of result.rows) {
        const record: Record<string, InValue> = {};
        for (let index = 0; index < result.columns.length; index += 1) {
          const column = result.columns[index];
          if (column === undefined) continue;
          record[column] = assertPortable(table, column, row[index]);
        }
        lines.push(JSON.stringify({ table, row: record } satisfies DumpRow));
      }
    }
    lines.push(JSON.stringify({ counts } satisfies DumpTrailer));
    await Bun.write(outFile, `${lines.join('\n')}\n`);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    process.stdout.write(`wrote ${outFile}: ${total} rows across ${TABLES.length} tables\n`);
    for (const table of TABLES) process.stdout.write(`  ${table.padEnd(30)} ${counts[table]}\n`);
  } finally {
    client.close();
  }
}

async function restore(url: string, inFile: string): Promise<void> {
  const text = await Bun.file(inFile).text();
  const lines = text.split('\n').filter((line) => line.length > 0);
  const headerLine = lines.shift();
  const trailerLine = lines.pop();
  if (headerLine === undefined || trailerLine === undefined) {
    throw new Error(`${inFile} is not a dump: it has no header and trailer`);
  }
  const header = JSON.parse(headerLine) as DumpHeader;
  if (header.format !== FORMAT) throw new Error(`${inFile} is not a ${FORMAT} dump`);
  const trailer = JSON.parse(trailerLine) as DumpTrailer;

  const rowsByTable = new Map<TableName, Record<string, InValue>[]>();
  for (const table of TABLES) rowsByTable.set(table, []);
  for (const line of lines) {
    const entry = JSON.parse(line) as DumpRow;
    const bucket = rowsByTable.get(entry.table);
    if (bucket === undefined) throw new Error(`dump names an unknown table: ${entry.table}`);
    bucket.push(entry.row);
  }
  // A dump cut short still parses; only the declared counts reveal it.
  for (const table of TABLES) {
    const loaded = rowsByTable.get(table)?.length ?? 0;
    const declared = trailer.counts[table] ?? 0;
    if (loaded !== declared) {
      throw new Error(
        `${inFile} is truncated: ${table} has ${loaded} rows, header says ${declared}`,
      );
    }
  }

  // Migrating first both creates the schema and proves the target is reachable.
  const db = await createMigratedKyselyDatabase<DatabaseSchema>(url, process.env.DB_AUTH_TOKEN);
  await db.destroy();

  const client = createDatabaseClient(url, process.env.DB_AUTH_TOKEN);
  try {
    const occupied = await client.execute('SELECT COUNT(*) AS count FROM users');
    if (Number(occupied.rows[0]?.count ?? 0) !== 0) {
      throw new Error('refusing to restore into a database that already holds accounts');
    }
    let written = 0;
    for (const table of TABLES) {
      const rows = rowsByTable.get(table) ?? [];
      for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
        const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS);
        await client.batch(
          chunk.map((row) => {
            const columns = Object.keys(row);
            const placeholders = columns.map(() => '?').join(', ');
            return {
              sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
              args: columns.map((column) => row[column] ?? null),
            };
          }),
          'write',
        );
        written += chunk.length;
      }
      process.stdout.write(`  ${table.padEnd(30)} ${rows.length}\n`);
    }
    process.stdout.write(`restored ${written} rows into ${redactUrl(url)}\n`);
  } finally {
    client.close();
  }
}

/**
 * JSON carries the column types this schema uses -- text, integer and null --
 * exactly. A binary column would not survive the round trip, so one stops the
 * dump rather than being written out as something that restores differently.
 */
function assertPortable(table: string, column: string, value: unknown): InValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  throw new Error(`${table}.${column} holds a value this dump format cannot carry`);
}

function parseOptions(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error(`malformed option near ${key ?? 'end of arguments'}`);
    }
    options.set(key.slice(2), value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

/** Keeps a credential embedded in a URL out of the log this prints. */
function redactUrl(url: string): string {
  const at = url.lastIndexOf('@');
  return at === -1 ? url : `${url.slice(0, url.indexOf('//') + 2)}***@${url.slice(at + 1)}`;
}
