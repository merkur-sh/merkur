/**
 * `bun run profile:<command>`: turn a `merkur profile record` directory into one Perfetto
 * trace and ask it the questions in `queries/`. Every answer comes from SQL over the
 * recorded events, so the same capture gives the same answer.
 *
 *   profile:setup                          install the pinned trace_processor and samply
 *   profile:sim [--rounds <n>] [--cpu] [--out <dir>]   capture the simulated display pipeline
 *   profile:perfetto <dir>                 write <dir>/trace.perfetto-trace
 *   profile:query <dir|trace> <query> [--span <name>] [--threshold-us <n>] [--limit <n>] [--json]
 *   profile:diff <dir|trace> <dir|trace> <query> [options]
 *
 * A Bazel command's own profile (`command.profile.gz`, Chrome's trace format) is a trace too:
 * `bazel` names this checkout's last one, and the `bazel-*` queries read it.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Predicate } from 'effect';
import { decodeNativeTrace } from './mtrace';
import { writePerfettoTrace } from './perfetto';
import { decodeSamplyProfile } from './samply';
import { parseSimOptions, runSim } from './sim';
import { setupTools, traceProcessorPath } from './tools';

const QUERIES = path.join(import.meta.dir, '..', 'queries');
const TRACE_FILE = 'trace.perfetto-trace';
/** Display bound: the widest cell a table prints. */
const TABLE_CELL_CHARS = 72;

interface QueryOptions {
  readonly span: string;
  readonly thresholdUs: number;
  readonly limit: number;
  readonly json: boolean;
}

type Row = readonly (string | number | null)[];

interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
}

/** `--span` names a site; numbers are numbers: nothing else reaches the SQL text. */
export function parseQueryOptions(args: readonly string[]): QueryOptions | null {
  let span = 'display.flush';
  let thresholdUs = 0;
  let limit = 20;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--json') json = true;
    else if (arg === '--span' && value !== undefined && /^[a-z0-9_.]+$/.test(value)) {
      span = value;
      index += 1;
    } else if ((arg === '--threshold-us' || arg === '--limit') && value !== undefined) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return null;
      if (arg === '--limit') limit = Math.trunc(number);
      else thresholdUs = number;
      index += 1;
    } else return null;
  }
  return { span, thresholdUs, limit, json };
}

export function fillQuery(sql: string, options: QueryOptions): string {
  return sql
    .replaceAll('{{span}}', options.span)
    .replaceAll('{{threshold_us}}', String(options.thresholdUs))
    .replaceAll('{{limit}}', String(options.limit));
}

/** trace_processor's `-q` output: a quoted-string CSV header and rows, `[NULL]` for null. */
export function parseQueryOutput(output: string): Table {
  const lines = output.split('\n').filter((line) => line.length > 0);
  const parse = (line: string): Row => {
    const cells: (string | number | null)[] = [];
    let index = 0;
    while (index <= line.length) {
      if (line[index] === '"') {
        let value = '';
        index += 1;
        while (index < line.length) {
          if (line[index] === '"' && line[index + 1] === '"') {
            value += '"';
            index += 2;
          } else if (line[index] === '"') {
            index += 1;
            break;
          } else {
            value += line[index];
            index += 1;
          }
        }
        cells.push(value);
      } else {
        const end = line.indexOf(',', index);
        const raw = line.slice(index, end < 0 ? line.length : end);
        index = end < 0 ? line.length : end;
        cells.push(raw === '[NULL]' ? null : Number(raw));
      }
      index += 1;
    }
    return cells;
  };
  const [header, ...rows] = lines;
  return {
    columns: header === undefined ? [] : parse(header).map(String),
    rows: rows.map(parse),
  };
}

/** The profile Bazel wrote for this checkout's last command, which `trace_processor` reads as is. */
async function bazelProfile(): Promise<string> {
  const child = Bun.spawn(['bazel', 'info', 'output_base'], { stdout: 'pipe', stderr: 'inherit' });
  const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exit !== 0) throw new Error(`bazel info output_base exited ${exit}`);
  return path.join(output.trim(), 'command.profile.gz');
}

async function tracePath(target: string): Promise<string> {
  if (target === 'bazel') return bazelProfile();
  if (!(await stat(target)).isDirectory()) return target;
  const traceFile = path.join(target, TRACE_FILE);
  const built = await stat(traceFile).then(
    (file) => file.mtimeMs,
    () => 0,
  );
  const spans = await stat(path.join(target, 'spans.mtrace'));
  if (built < spans.mtimeMs) await buildTrace(target);
  return traceFile;
}

async function buildTrace(directory: string): Promise<string> {
  const capture = decodeNativeTrace(await readFile(path.join(directory, 'spans.mtrace')));
  const entries = await readdir(directory);
  const cpu = entries.includes('cpu.json.gz')
    ? decodeSamplyProfile(await readFile(path.join(directory, 'cpu.json.gz')))
    : null;
  const output = path.join(directory, TRACE_FILE);
  await Bun.write(output, writePerfettoTrace(capture, cpu));
  const problems = [
    capture.dropped > 0 ? `${capture.dropped} records dropped` : null,
    capture.discontinuous ? 'the machine slept: span times are discontinuous' : null,
  ].filter((problem) => problem !== null);
  for (const problem of problems) process.stderr.write(`profile: ${problem}\n`);
  return output;
}

async function runQuery(target: string, name: string, options: QueryOptions): Promise<Table> {
  const sql = fillQuery(await readFile(path.join(QUERIES, `${name}.sql`), 'utf8'), options);
  const queryFile = path.join(process.env.TMPDIR ?? '/tmp', `merkur-profile-${process.pid}.sql`);
  await Bun.write(queryFile, sql);
  const child = Bun.spawn([traceProcessorPath(), '-q', queryFile, await tracePath(target)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`trace_processor exited ${exit}:\n${stderr}`);
  return parseQueryOutput(stdout);
}

export function renderTable(table: Table): string {
  // A table is read in a terminal: a cell past this many characters keeps its end, where a
  // Rust symbol names its function. `--json` keeps every cell whole.
  const text = (cell: string | number | null) => {
    const value = cell === null ? '-' : String(cell);
    return value.length > TABLE_CELL_CHARS ? `…${value.slice(-(TABLE_CELL_CHARS - 1))}` : value;
  };
  const widths = table.columns.map((column, index) =>
    Math.max(column.length, ...table.rows.map((row) => text(row[index] ?? null).length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(table.columns), ...table.rows.map((row) => line(row.map(text)))].join('\n');
}

function asJson(table: Table): string {
  return JSON.stringify(
    table.rows.map((row) =>
      Object.fromEntries(table.columns.map((column, index) => [column, row[index] ?? null])),
    ),
    null,
    2,
  );
}

/** Two tables side by side, joined on their first column, with each numeric delta. */
export function diffTables(before: Table, after: Table): Table {
  const keyed = new Map(after.rows.map((row) => [String(row[0]), row]));
  const columns = [before.columns[0] ?? 'key'];
  for (const column of before.columns.slice(1))
    columns.push(`${column} a`, `${column} b`, `${column} Δ`);
  const rows = before.rows.map((row): Row => {
    const other = keyed.get(String(row[0]));
    const cells: (string | number | null)[] = [row[0] ?? null];
    for (let index = 1; index < before.columns.length; index += 1) {
      const a = row[index] ?? null;
      const b = other?.[index] ?? null;
      cells.push(
        a,
        b,
        Predicate.isNumber(a) && Predicate.isNumber(b) ? Math.round((b - a) * 10) / 10 : null,
      );
    }
    return cells;
  });
  return { columns, rows };
}

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'setup') {
    await setupTools();
    return 0;
  }
  if (command === 'sim') {
    const options = parseSimOptions(rest);
    if (options === null) return usage();
    process.stdout.write(`${await runSim(options)}\n`);
    return 0;
  }
  if (command === 'perfetto' && rest.length === 1 && rest[0] !== undefined) {
    process.stdout.write(`${await buildTrace(rest[0])}\n`);
    return 0;
  }
  if (command === 'query') {
    const [target, name, ...flags] = rest;
    const options = parseQueryOptions(flags);
    if (target === undefined || name === undefined || options === null) return usage();
    const table = await runQuery(target, name, options);
    process.stdout.write(`${options.json ? asJson(table) : renderTable(table)}\n`);
    return 0;
  }
  if (command === 'diff') {
    const [a, b, name, ...flags] = rest;
    const options = parseQueryOptions(flags);
    if (a === undefined || b === undefined || name === undefined || options === null)
      return usage();
    const table = diffTables(await runQuery(a, name, options), await runQuery(b, name, options));
    process.stdout.write(`${options.json ? asJson(table) : renderTable(table)}\n`);
    return 0;
  }
  return usage();
}

function usage(): number {
  process.stderr.write(
    'usage: profile:setup | profile:sim [--rounds <n>] [--cpu] [--out <dir>] | profile:perfetto <dir> | profile:query <dir|trace> <query> [options] | profile:diff <a> <b> <query> [options]\n',
  );
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
