import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');
const DIST_DIRECTORY = path.join(REPO_ROOT, 'apps/daemon/dist');
const RUST_TARGET_DIRECTORY = path.join(REPO_ROOT, 'target/rust');
const DATAPLANE_DIRECTORY = path.join(REPO_ROOT, 'apps/daemon/dataplane');
const USAGE = 'Usage: build-daemon-artifacts.ts [--tpm-sim] [--rust-target <triple>] [--pgo]';

/**
 * The profile-guided dataplane's training workloads, as test-harness arguments.
 *
 * The unit suite runs first for breadth: LLVM treats a function the training never
 * entered as cold, so code outside the benchmarks (QUIC, IPC, session, NAT) must still
 * run. The benchmarks then set the weights: the production display pipeline (PTY bytes
 * through VT parse, row capture, compression, FEC and Noise seal) and the scroll literal
 * replay, which is what the PGO measurement trained on; the display pipeline was held
 * out of that training and still improved 11%. Only this crate compiles differently
 * under `cfg(test)`; every dependency's profile matches the release build exactly.
 */
const PGO_TRAINING: readonly PgoWorkload[] = [
  // Breadth only: the suite's verdicts belong to CI's test job on a bare runner. Inside
  // the Linux release container, as root, one fd-passing socket test fails, and that
  // must not fail a release. The profile it writes is what training needs.
  { name: 'suite', args: [], mustPass: false },
  {
    name: 'display-pipeline',
    args: ['display::send::tests::production_display_pipeline_benchmark', '--exact', '--ignored'],
    mustPass: true,
  },
  {
    name: 'scroll',
    args: ['production_scroll_literal_benchmark', '--test-threads=1', '--ignored'],
    mustPass: true,
  },
];

interface PgoWorkload {
  readonly name: string;
  readonly args: readonly string[];
  /** A failing benchmark is a broken weight source; a failing suite test is CI's to report. */
  readonly mustPass: boolean;
}

const { tpmSim, rustTarget, pgo } = parseArguments(Bun.argv.slice(2));
const features = tpmSim ? ['--features', 'tpm-sim'] : [];

await fs.mkdir(DIST_DIRECTORY, { recursive: true });

if (pgo) {
  await buildNativeClients();
  await copyBinary('merkur-dataplane', await buildProfiledDataplane());
} else {
  await runOrThrow(
    [
      'cargo',
      'build',
      '--manifest-path',
      'Cargo.toml',
      '-p',
      'merkur-dataplane',
      '-p',
      'merkur-image-worker',
      '-p',
      'merkur-tui',
      '--release',
      '--locked',
      ...features,
      // Cross-building the other macOS architecture on one Mac: cargo then writes
      // under target/rust/<triple>/ instead of target/rust/.
      ...(rustTarget === null ? [] : ['--target', rustTarget]),
    ],
    REPO_ROOT,
  );
  await copyBinary('merkur-dataplane', releaseBinary(RUST_TARGET_DIRECTORY, 'merkur-dataplane'));
}
await copyBinary(
  'merkur-image-worker',
  releaseBinary(RUST_TARGET_DIRECTORY, 'merkur-image-worker'),
);

await copyBinary('merkur-tui', releaseBinary(RUST_TARGET_DIRECTORY, 'merkur-tui'));

async function buildNativeClients(): Promise<void> {
  await runOrThrow(
    [
      'cargo',
      'build',
      '--manifest-path',
      'Cargo.toml',
      '-p',
      'merkur-image-worker',
      '-p',
      'merkur-tui',
      '--release',
      '--locked',
      ...(rustTarget === null ? [] : ['--target', rustTarget]),
    ],
    REPO_ROOT,
  );
}

/**
 * Instrument, train, merge, rebuild. The instrumentation and the profile reach the
 * compiler through `CARGO_TARGET_<TRIPLE>_RUSTFLAGS`, not `RUSTFLAGS`: Cargo joins the
 * target table with `.cargo/config.toml`'s `cfg(target_arch)` flags (the x86-64 SSSE3
 * floor), which `RUSTFLAGS` would replace, and with an explicit `--target` build scripts
 * and proc macros stay uninstrumented. Each phase has its own target directory, so the
 * plain release cache is never rebuilt with other flags.
 */
async function buildProfiledDataplane(): Promise<string> {
  const host = await rustcHost();
  const triple = rustTarget ?? host;
  const flagsVariable = `CARGO_TARGET_${triple.toUpperCase().replaceAll('-', '_')}_RUSTFLAGS`;
  const pgoDirectory = path.join(RUST_TARGET_DIRECTORY, 'pgo');
  const rawProfiles = path.join(pgoDirectory, 'profiles');
  const mergedProfile = path.join(pgoDirectory, 'dataplane.profdata');
  await fs.rm(rawProfiles, { recursive: true, force: true });
  await fs.mkdir(rawProfiles, { recursive: true });

  const instrumented = await instrumentedTestBinary(
    flagsVariable,
    `-Cprofile-generate=${rawProfiles}`,
    triple,
    path.join(pgoDirectory, 'generate'),
  );
  const profiles: string[] = [];
  for (const workload of PGO_TRAINING) {
    // The harness exits 0 when its filter selects nothing, having trained nothing.
    const selected = await capture([instrumented, ...workload.args, '--list'], {
      LLVM_PROFILE_FILE: '/dev/null',
    });
    if (!/: test$/m.test(selected)) {
      throw new Error(`PGO workload ${workload.name} selects no test`);
    }
    const proc = Bun.spawn([instrumented, ...workload.args], {
      cwd: DATAPLANE_DIRECTORY,
      env: {
        ...process.env,
        LLVM_PROFILE_FILE: path.join(rawProfiles, `${workload.name}-%p-%m.profraw`),
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    if (workload.mustPass && exitCode !== 0) process.exit(exitCode);
    const written = (await fs.readdir(rawProfiles))
      .filter((name) => name.startsWith(`${workload.name}-`) && name.endsWith('.profraw'))
      .map((name) => path.join(rawProfiles, name));
    if (written.length === 0) throw new Error(`PGO workload ${workload.name} wrote no profile`);
    profiles.push(...written);
  }

  const profdata = path.join(await rustcSysroot(), 'lib/rustlib', host, 'bin/llvm-profdata');
  if (!(await fs.stat(profdata).catch(() => null))?.isFile()) {
    throw new Error(`${profdata} is missing; rust-toolchain.toml lists llvm-tools for it`);
  }
  await runOrThrow([profdata, 'merge', '-o', mergedProfile, ...profiles], REPO_ROOT);

  const useDirectory = path.join(pgoDirectory, 'use');
  await runOrThrow(
    [
      'cargo',
      'build',
      '--manifest-path',
      'Cargo.toml',
      '-p',
      'merkur-dataplane',
      '--release',
      '--locked',
      ...features,
      '--target',
      triple,
      '--target-dir',
      useDirectory,
    ],
    REPO_ROOT,
    { [flagsVariable]: `-Cprofile-use=${mergedProfile}` },
  );
  return path.join(useDirectory, triple, 'release', executableName('merkur-dataplane'));
}

/**
 * Builds the instrumented dataplane test binary and returns its path from Cargo's JSON.
 *
 * The tests live in the library; the binary target builds a test executable too, and it
 * holds none of them.
 */
async function instrumentedTestBinary(
  flagsVariable: string,
  flags: string,
  triple: string,
  targetDirectory: string,
): Promise<string> {
  const proc = Bun.spawn(
    [
      'cargo',
      'test',
      '--manifest-path',
      'Cargo.toml',
      '-p',
      'merkur-dataplane',
      '--release',
      '--locked',
      '--no-run',
      ...features,
      '--target',
      triple,
      '--target-dir',
      targetDirectory,
      '--message-format=json-render-diagnostics',
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, [flagsVariable]: flags },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) process.exit(1);
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message: unknown = JSON.parse(line);
    if (
      typeof message === 'object' &&
      message !== null &&
      'reason' in message &&
      message.reason === 'compiler-artifact' &&
      'profile' in message &&
      typeof message.profile === 'object' &&
      message.profile !== null &&
      'test' in message.profile &&
      message.profile.test === true &&
      'package_id' in message &&
      typeof message.package_id === 'string' &&
      message.package_id.includes('merkur-dataplane') &&
      'target' in message &&
      typeof message.target === 'object' &&
      message.target !== null &&
      'kind' in message.target &&
      Array.isArray(message.target.kind) &&
      message.target.kind.includes('lib') &&
      'executable' in message &&
      typeof message.executable === 'string'
    ) {
      return message.executable;
    }
  }
  throw new Error('cargo reported no instrumented merkur-dataplane library test binary');
}

function releaseBinary(targetDirectory: string, name: string): string {
  return rustTarget === null
    ? path.join(targetDirectory, 'release', executableName(name))
    : path.join(targetDirectory, rustTarget, 'release', executableName(name));
}

function executableName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function copyBinary(name: string, source: string): Promise<void> {
  await fs.copyFile(source, path.join(DIST_DIRECTORY, executableName(name)));
}

async function rustcHost(): Promise<string> {
  const host = (await capture(['rustc', '-vV'])).match(/^host: (\S+)$/m)?.[1];
  if (host === undefined) throw new Error('rustc -vV reported no host triple');
  return host;
}

async function rustcSysroot(): Promise<string> {
  return (await capture(['rustc', '--print', 'sysroot'])).trim();
}

async function capture(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
  return output;
}

function parseArguments(args: readonly string[]): {
  readonly tpmSim: boolean;
  readonly rustTarget: string | null;
  readonly pgo: boolean;
} {
  let tpmSim = false;
  let rustTarget: string | null = null;
  let pgo = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--tpm-sim' && !tpmSim) {
      tpmSim = true;
    } else if (argument === '--pgo' && !pgo) {
      pgo = true;
    } else if (argument === '--rust-target' && rustTarget === null) {
      const value = args[index + 1];
      if (value === undefined || !/^[a-z0-9_]+-[a-z0-9_-]+$/.test(value)) throw new Error(USAGE);
      rustTarget = value;
      index++;
    } else {
      throw new Error(USAGE);
    }
  }
  return { tpmSim, rustTarget, pgo };
}

async function runOrThrow(
  cmd: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
