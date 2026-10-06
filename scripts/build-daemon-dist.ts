import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIRECTORY, '..');
const DIST_DIRECTORY = path.join(REPO_ROOT, 'apps/daemon/dist');
const DAEMON_ENTRY = path.join(REPO_ROOT, 'apps/daemon/src/index.ts');
const DAEMON_OUTFILE = path.join(DIST_DIRECTORY, 'merkur');

/**
 * The macOS release platforms this script can build from one Apple Silicon
 * machine; Linux releases come from `Dockerfile.daemon-release`. Without
 * `--platform` it builds for the host, which is what development wants.
 */
const MACOS_PLATFORM_TARGETS = {
  'darwin-arm64': { bun: 'bun-darwin-arm64', rust: 'aarch64-apple-darwin' },
  'darwin-x64': { bun: 'bun-darwin-x64', rust: 'x86_64-apple-darwin' },
} as const;

const version = await resolveVersion();
const releaseTrust = resolveReleaseTrust(version);
const platformTarget = resolvePlatformTarget();
const clientBuildEnvironment: Record<string, string> = { MERKUR_VERSION: version };
if (releaseTrust.sequence > 0) {
  const origin = process.env.MERKUR_PUBLIC_ORIGIN;
  const pin = process.env.MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
  if (origin === undefined || pin === undefined) {
    throw new Error(
      'release builds require MERKUR_PUBLIC_ORIGIN and MERKUR_OPAQUE_SERVER_PUBLIC_KEY',
    );
  }
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) {
    throw new Error('release account origin must be a canonical HTTPS origin');
  }
  const key = Buffer.from(pin, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== pin) {
    throw new Error('release OPAQUE pin must encode exactly 32 bytes as canonical base64url');
  }
  clientBuildEnvironment.MERKUR_PUBLIC_ORIGIN = origin;
  clientBuildEnvironment.MERKUR_OPAQUE_SERVER_PUBLIC_KEY = pin;
}

await fs.mkdir(DIST_DIRECTORY, { recursive: true });

// Rust dataplane → apps/daemon/dist/merkur-dataplane. A release (a `vX.Y.Z`
// version, which is what requires the trust inputs above) ships the
// profile-guided dataplane; a development build skips the minutes of training.
await runOrThrow(
  [
    'bun',
    'run',
    path.join(CURRENT_DIRECTORY, 'build-daemon-artifacts.ts'),
    ...(platformTarget === null ? [] : ['--rust-target', platformTarget.rust]),
    ...(releaseTrust.sequence > 0 ? ['--pgo'] : []),
  ],
  clientBuildEnvironment,
);

// The notices the CLI embeds, regenerated from the resolved dependency graph
// before it is compiled in, so a dependency change can never ship unattributed.
await runOrThrow(['bun', 'run', path.join(CURRENT_DIRECTORY, 'generate-third-party-notices.ts')]);

// The CLI signs and verifies ML-DSA-87 through the e2e WebAssembly module,
// which `bun build --compile` embeds; build it from this checkout's source.
await runOrThrow(['bun', 'run', path.join(CURRENT_DIRECTORY, 'build-e2e-wasm.ts')]);

// Daemon CLI → single compiled executable with the version stamped in.
await runOrThrow([
  'bun',
  'build',
  DAEMON_ENTRY,
  '--compile',
  '--target',
  platformTarget === null ? 'bun' : platformTarget.bun,
  '--outfile',
  DAEMON_OUTFILE,
  '--define',
  `process.env.MERKUR_VERSION=${JSON.stringify(version)}`,
  '--define',
  `process.env.MERKUR_RELEASE_SEQUENCE=${JSON.stringify(String(releaseTrust.sequence))}`,
  '--define',
  `process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=${JSON.stringify(releaseTrust.publicKey)}`,
]);

process.stdout.write(`built ${DAEMON_OUTFILE} (${version})\n`);

async function resolveVersion(): Promise<string> {
  const argIndex = process.argv.indexOf('--version');
  const explicit = argIndex === -1 ? undefined : process.argv[argIndex + 1];
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const proc = Bun.spawn(['git', 'describe', '--tags', '--always', '--dirty'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return 'dev';
  }
  const described = (await new Response(proc.stdout).text()).trim();
  return described.length > 0 ? described : 'dev';
}

function resolvePlatformTarget(): { readonly bun: string; readonly rust: string } | null {
  const argIndex = process.argv.indexOf('--platform');
  if (argIndex === -1) return null;
  const platform = process.argv[argIndex + 1];
  if (platform !== 'darwin-arm64' && platform !== 'darwin-x64') {
    throw new Error('--platform must be darwin-arm64 or darwin-x64');
  }
  return MACOS_PLATFORM_TARGETS[platform];
}

function resolveReleaseTrust(version: string): {
  readonly publicKey: string;
  readonly sequence: number;
} {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    return { publicKey: '', sequence: 0 };
  }

  const sequenceIndex = process.argv.indexOf('--sequence');
  const rawSequence = sequenceIndex === -1 ? undefined : process.argv[sequenceIndex + 1];
  if (rawSequence === undefined || !/^[1-9]\d*$/.test(rawSequence)) {
    throw new Error('release builds require --sequence with a positive integer');
  }
  const sequence = Number(rawSequence);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error('release sequence exceeds the safe-integer range');
  }

  const publicKey = process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY;
  if (publicKey === undefined || !/^[A-Za-z0-9_-]{3456}$/.test(publicKey)) {
    throw new Error(
      'release builds require MERKUR_RELEASE_MLDSA87_PUBLIC_KEY as canonical base64url',
    );
  }
  const decoded = Buffer.from(publicKey, 'base64url');
  if (decoded.byteLength !== 2_592 || decoded.toString('base64url') !== publicKey) {
    throw new Error('release public-key pin must encode exactly 2592 bytes');
  }
  return { publicKey, sequence };
}

async function runOrThrow(cmd: string[], env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
