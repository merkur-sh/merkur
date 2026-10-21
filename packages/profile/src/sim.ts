/**
 * `bun run profile:sim`: the edit loop for one component. Builds the dataplane's tests with
 * Cargo's incremental `profiling` profile, runs the simulator capture test
 * (`display::sim::trace_fixture::write_native_trace_capture`), and writes a directory the
 * queries read. With `--cpu` the run is sampled by samply; without it, macOS reports the
 * run's instructions retired, which a layout change cannot move the way it moves time.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Option, Schema } from 'effect';
import { samplyPath } from './tools';

const ROOT = path.join(import.meta.dir, '..', '..', '..');
const TARGET = path.join(ROOT, 'target', 'rust', 'profiling');
const TEST = 'display::sim::trace_fixture::write_native_trace_capture';

export interface SimOptions {
  readonly rounds: number;
  readonly cpu: boolean;
  readonly out: string | null;
}

export function parseSimOptions(args: readonly string[]): SimOptions | null {
  let rounds = 2_000;
  let cpu = false;
  let out: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--cpu') cpu = true;
    else if (arg === '--rounds' && value !== undefined && /^[1-9][0-9]*$/.test(value)) {
      rounds = Number(value);
      index += 1;
    } else if (arg === '--out' && value !== undefined) {
      out = path.resolve(value);
      index += 1;
    } else return null;
  }
  return { rounds, cpu, out };
}

/** The rustup toolchain file decides the compiler; an ambient override would not. */
function cargoEnvironment(extra: Record<string, string>) {
  const { RUSTUP_TOOLCHAIN: _ignored, ...environment } = process.env;
  return { ...environment, ...extra };
}

const CompilerArtifact = Schema.Struct({
  reason: Schema.Literal('compiler-artifact'),
  target: Schema.Struct({ name: Schema.String, kind: Schema.Array(Schema.String) }),
  profile: Schema.Struct({ test: Schema.Boolean }),
  executable: Schema.NullOr(Schema.String),
});
const decodeArtifact = Schema.decodeUnknownOption(Schema.fromJsonString(CompilerArtifact));

/** The dataplane library's test binary, as Cargo's JSON messages name it. */
export function testExecutable(messages: string): string | null {
  for (const line of messages.split('\n')) {
    const artifact = Option.getOrNull(decodeArtifact(line));
    if (
      artifact !== null &&
      artifact.target.name === 'merkur_dataplane' &&
      artifact.target.kind.includes('lib') &&
      artifact.profile.test &&
      artifact.executable !== null
    ) {
      return artifact.executable;
    }
  }
  return null;
}

async function cargo(args: readonly string[], extra: Record<string, string>): Promise<string> {
  const child = Bun.spawn(['cargo', ...args], {
    cwd: ROOT,
    env: cargoEnvironment(extra),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exit !== 0) throw new Error(`cargo ${args.join(' ')} exited ${exit}`);
  return stdout;
}

/** Builds, runs, and returns the directory written. */
export async function runSim(options: SimOptions): Promise<string> {
  await cargo(['build', '--locked', '--profile', 'profiling', '-p', 'merkur-image-worker'], {});
  const messages = await cargo(
    [
      'test',
      '--locked',
      '--profile',
      'profiling',
      '-p',
      'merkur-dataplane',
      '--lib',
      '--no-run',
      '--message-format=json',
    ],
    { MERKUR_IMAGE_WORKER: path.join(TARGET, 'merkur-image-worker') },
  );
  const executable = testExecutable(messages);
  if (executable === null) throw new Error('cargo named no dataplane test binary');
  const out =
    options.out ??
    path.join(ROOT, 'target', 'profiles', `sim-${new Date().toISOString().replaceAll(':', '-')}`);
  await mkdir(out, { recursive: true });
  const test = [executable, '--ignored', '--exact', TEST];
  const command = options.cpu
    ? [
        samplyPath(),
        'record',
        '--save-only',
        '--presymbolicate',
        '-o',
        path.join(out, 'cpu.json.gz'),
        '--',
        ...test,
      ]
    : process.platform === 'darwin'
      ? ['/usr/bin/time', '-l', ...test]
      : test;
  const child = Bun.spawn(command, {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      MERKUR_TRACE_OUT: path.join(out, 'spans.mtrace'),
      MERKUR_TRACE_ROUNDS: String(options.rounds),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`the capture run exited ${exit}:\n${stderr}`);
  const instructions = /(\d+)\s+instructions retired/.exec(stderr)?.[1];
  if (instructions !== undefined) {
    await Bun.write(
      path.join(out, 'run.json'),
      `${JSON.stringify({ instructionsRetired: Number(instructions), rounds: options.rounds })}\n`,
    );
  }
  return out;
}
