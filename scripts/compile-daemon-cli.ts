/**
 * Compiles the daemon CLI into one executable for this machine, with its release identity
 * stamped in: `//tools/bazel/release:merkur` runs it inside a checkout of the repository.
 *
 *   bun run scripts/compile-daemon-cli.ts <outfile>
 *
 * It reads `MERKUR_VERSION` and `MERKUR_RELEASE_SEQUENCE`. A release (a `vX.Y.Z` version, with a
 * positive sequence) also requires `MERKUR_RELEASE_MLDSA87_PUBLIC_KEY`, `MERKUR_PUBLIC_ORIGIN`
 * and `MERKUR_OPAQUE_SERVER_PUBLIC_KEY`; any other version is a development build, with none.
 * The CLI embeds the e2e WebAssembly module and `apps/daemon/NOTICES.txt`, which the release
 * job regenerates first (`scripts/generate-third-party-notices.ts`).
 */

import path from 'node:path';
import { outputArgument } from './output-argument';

const ROOT = path.resolve(import.meta.dir, '..');
const ENTRY = path.join(ROOT, 'apps/daemon/src/index.ts');
const LOCK_WORKER = path.join(ROOT, 'packages/config/src/daemon-config-lock-worker.ts');

interface ReleaseIdentity {
  readonly version: string;
  readonly sequence: number;
  readonly publicKey: string;
  readonly origin: string;
  readonly opaquePin: string;
}

export function releaseIdentity(
  env: Readonly<Record<string, string | undefined>>,
): ReleaseIdentity {
  const version = env.MERKUR_VERSION ?? '';
  if (version === '') throw new Error('MERKUR_VERSION is required');
  const sequenceText = env.MERKUR_RELEASE_SEQUENCE ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(sequenceText))
    throw new Error('MERKUR_RELEASE_SEQUENCE must be a non-negative integer');
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence))
    throw new Error('release sequence exceeds the safe-integer range');
  const release = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
  if (release !== sequence > 0)
    throw new Error('a vX.Y.Z version takes a positive sequence, and only it does');
  if (!release) return { version, sequence, publicKey: '', origin: '', opaquePin: '' };

  const publicKey = env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '';
  const decodedKey = Buffer.from(publicKey, 'base64url');
  if (
    !/^[A-Za-z0-9_-]{3456}$/.test(publicKey) ||
    decodedKey.byteLength !== 2_592 ||
    decodedKey.toString('base64url') !== publicKey
  )
    throw new Error('MERKUR_RELEASE_MLDSA87_PUBLIC_KEY must encode exactly 2592 bytes');
  const origin = env.MERKUR_PUBLIC_ORIGIN ?? '';
  const url = URL.parse(origin);
  if (url === null || url.protocol !== 'https:' || url.origin !== origin)
    throw new Error('MERKUR_PUBLIC_ORIGIN must be a canonical HTTPS origin');
  const opaquePin = env.MERKUR_OPAQUE_SERVER_PUBLIC_KEY ?? '';
  const decodedPin = Buffer.from(opaquePin, 'base64url');
  if (decodedPin.byteLength !== 32 || decodedPin.toString('base64url') !== opaquePin)
    throw new Error('MERKUR_OPAQUE_SERVER_PUBLIC_KEY must encode exactly 32 bytes');
  return { version, sequence, publicKey, origin, opaquePin };
}

/** The `bun build` arguments that compile the CLI with `identity` stamped in. */
export function compileArguments(identity: ReleaseIdentity, outfile: string): string[] {
  // The OPAQUE pin is the terminal client's (`apps/tui`), which Bazel compiles with it. The CLI
  // embeds the origin too: `merkur update` on a machine with no daemon config asks it which
  // release to run.
  const defines = {
    MERKUR_VERSION: identity.version,
    MERKUR_RELEASE: identity.version,
    MERKUR_RELEASE_SEQUENCE: String(identity.sequence),
    MERKUR_RELEASE_MLDSA87_PUBLIC_KEY: identity.publicKey,
    MERKUR_PUBLIC_ORIGIN: identity.origin,
  };
  return [
    'build',
    ENTRY,
    LOCK_WORKER,
    '--compile',
    '--outfile',
    outfile,
    '--entry-naming',
    '[name].[ext]',
    ...Object.entries(defines).flatMap(([name, value]) => [
      '--define',
      `process.env.${name}=${JSON.stringify(value)}`,
    ]),
  ];
}

if (import.meta.main) {
  const outfile = outputArgument('bun run scripts/compile-daemon-cli.ts <absolute outfile>');
  const compile = Bun.spawn(
    [process.execPath, ...compileArguments(releaseIdentity(process.env), outfile)],
    {
      cwd: ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  process.exitCode = await compile.exited;
}
