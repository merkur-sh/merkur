/**
 * The instructions each dataplane benchmark executes, counted by Cachegrind: a count the load of a
 * shared runner does not move, which `.github/workflows/instructions.yml` reports for every push
 * to `main` beside the previous push's. The benchmarks are the `bench:*` scripts that run
 * `//apps/daemon/dataplane:unit_release`, each run once with its own arguments and environment
 * but `BENCH_SAMPLES` fixed, so a count measures the code and not the sample count.
 *
 *   bun run scripts/bench-instructions.ts [--baseline <counts.json>] [--out <counts.json>]
 *
 * Linux only: Valgrind does not run on current macOS. Prints a Markdown table.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';

const ROOT = path.resolve(import.meta.dir, '..');
const TARGET = '//apps/daemon/dataplane:unit_release';
/** Samples each benchmark runs under Cachegrind, which runs a program tens of times slower. */
const SAMPLES = '5';

const Manifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
const Counts = Schema.Record(Schema.String, Schema.Number);
type Counts = typeof Counts.Type;

interface Benchmark {
  readonly name: string;
  readonly environment: Record<string, string>;
  readonly args: readonly string[];
}

/** The `bench:*` scripts that run the dataplane's release benchmarks, with their arguments. */
export function dataplaneBenchmarks(scripts: Record<string, string>): Benchmark[] {
  const releaseRun = new RegExp(
    `^((?:[A-Z_]+=\\S+ )*)bazel run ${TARGET.replaceAll('/', '\\/')} -- (.+)$`,
  );
  return Object.entries(scripts).flatMap(([name, command]) => {
    const match = releaseRun.exec(command);
    if (!name.startsWith('bench:') || match === null) return [];
    const [, assignments = '', args = ''] = match;
    const environment = Object.fromEntries(
      assignments
        .trim()
        .split(' ')
        .flatMap((assignment) => {
          const [key, value] = assignment.split('=');
          return key === undefined || key === '' || value === undefined ? [] : [[key, value]];
        }),
    );
    return [{ name, environment, args: args.split(' ') }];
  });
}

/** The total instructions Cachegrind reports for one run, from its `I refs:` line. */
export function instructionCount(stderr: string): number {
  const refs = /^==\d+== I\s+refs:\s+([\d,]+)$/m.exec(stderr)?.[1];
  if (refs === undefined)
    throw new Error(`no instruction count in Cachegrind's report:\n${stderr}`);
  return Number(refs.replaceAll(',', ''));
}

/** The Markdown table of `counts` against `baseline`, with each change in percent. */
export function countsTable(counts: Counts, baseline: Counts | null): string {
  const rows = Object.entries(counts).map(([name, count]) => {
    const before = baseline?.[name];
    const change = before === undefined ? '' : `${(((count - before) / before) * 100).toFixed(2)}%`;
    return `| \`${name}\` | ${count.toLocaleString('en')} | ${before?.toLocaleString('en') ?? ''} | ${change} |`;
  });
  return [
    '| Benchmark | Instructions | Previous push | Change |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
  ].join('\n');
}

function bazel(args: readonly string[]): string {
  const run = Bun.spawnSync(['bazel', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'inherit' });
  if (run.exitCode !== 0) throw new Error(`bazel ${args.join(' ')} exited ${run.exitCode}`);
  return run.stdout.toString().trim();
}

async function count(binary: string, benchmark: Benchmark): Promise<number> {
  const child = Bun.spawn(
    [
      'valgrind',
      '--tool=cachegrind',
      '--cache-sim=no',
      `--cachegrind-out-file=${path.join(mkdtempSync(path.join(tmpdir(), 'cachegrind-')), 'out')}`,
      binary,
      ...benchmark.args,
    ],
    {
      // As `bazel run` runs it: the release suite's helpers sit at their paths in its runfiles.
      cwd: `${binary}.runfiles/_main`,
      env: { ...process.env, ...benchmark.environment, BENCH_SAMPLES: SAMPLES },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`${benchmark.name} exited ${exit} under Cachegrind:\n${stderr}`);
  return instructionCount(stderr);
}

async function main(args: readonly string[]): Promise<void> {
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const baselineFile = option('--baseline');
  const out = option('--out');
  const { scripts } = Schema.decodeUnknownSync(Manifest)(
    JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')),
    { onExcessProperty: 'ignore' },
  );
  bazel(['build', TARGET]);
  const file = bazel(['cquery', '--output=files', TARGET]);
  const binary = path.join(bazel(['info', 'execution_root']), file);
  const counts: Record<string, number> = {};
  for (const benchmark of dataplaneBenchmarks(scripts))
    counts[benchmark.name] = await count(binary, benchmark);
  const baseline =
    baselineFile === undefined
      ? null
      : Schema.decodeUnknownSync(Counts)(JSON.parse(readFileSync(baselineFile, 'utf8')));
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(counts, null, 2)}\n`);
  process.stdout.write(`${countsTable(counts, baseline)}\n`);
}

if (import.meta.main) await main(process.argv.slice(2));
