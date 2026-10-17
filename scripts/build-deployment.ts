/**
 * Builds the unsigned deployment the release signs and the server image runs: the compiled
 * server, its bundled migrations and the web app, precompressed. `//tools/bazel/release:deployment`
 * runs it inside a checkout of the repository, on Linux x64, the server's platform.
 *
 *   bun run scripts/build-deployment.ts <absolute output directory>
 *
 * It reads `MERKUR_BUILD_COMMIT`, which is the deployment's version, the release public key
 * (`MERKUR_RELEASE_MLDSA87_PUBLIC_KEY`) and the OPAQUE server key the web build pins
 * (`VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY`).
 */

import '../packages/shared/src/e2e-wasm-bun';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { Schema } from 'effect';
import { decodeReleasePublicKey } from '../packages/shared/src/release-signature';
import { outputArgument } from './output-argument';

const ROOT = path.resolve(import.meta.dir, '..');

interface DeploymentInputs {
  readonly commit: string;
  readonly releasePublicKey: string;
  readonly opaquePin: string;
}

export function deploymentInputs(
  env: Readonly<Record<string, string | undefined>>,
): DeploymentInputs {
  const commit = env.MERKUR_BUILD_COMMIT ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('MERKUR_BUILD_COMMIT is required');
  const releasePublicKey = env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '';
  decodeReleasePublicKey(releasePublicKey);
  const opaquePin = env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY ?? '';
  const decoded = Buffer.from(opaquePin, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== opaquePin)
    throw new Error(
      'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY must be canonical base64url for 32 bytes',
    );
  return { commit, releasePublicKey, opaquePin };
}

async function run(command: readonly string[], env: Record<string, string>): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}`);
}

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** `brotli --quality=11` beside every file: the server serves the `.br` twin. */
function precompress(directory: string): void {
  for (const file of files(directory)) {
    if (file.endsWith('.br')) continue;
    writeFileSync(
      `${file}.br`,
      brotliCompressSync(readFileSync(file), {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_LGWIN]: 24,
        },
      }),
    );
  }
}

const BuildManifest = Schema.Struct({ buildId: Schema.String });

async function build(output: string, inputs: DeploymentInputs): Promise<void> {
  const web = path.join(output, 'web');
  await run(
    [
      process.execPath,
      '--no-env-file',
      'run',
      '--cwd',
      'apps/web',
      'vite',
      'build',
      '--outDir',
      web,
    ],
    {
      MERKUR_VERSION: inputs.commit,
      VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY: inputs.opaquePin,
    },
  );
  const { buildId } = Schema.decodeUnknownSync(BuildManifest)(
    JSON.parse(readFileSync(path.join(web, 'merkur-build.json'), 'utf8')),
  );
  precompress(web);
  // `bun build` inlines `process.env.NODE_ENV` while bundling, as "development" unless the
  // build says otherwise, so the executable never reads the deployment's runtime variable:
  // production HSTS, `upgrade-insecure-requests` and the loopback-origin cookie relaxation
  // key on it. `--conditions=workerd` resolves `@libsql/client` to its pure-JavaScript
  // build, which a standalone executable can embed; the Node build reaches for a native addon.
  const defines = {
    NODE_ENV: 'production',
    MERKUR_BUILD_ID: buildId,
    MERKUR_RELEASE_MLDSA87_PUBLIC_KEY: inputs.releasePublicKey,
    MERKUR_VERSION: inputs.commit,
    MERKUR_OPAQUE_WEB_BUILD_PUBLIC_KEY: inputs.opaquePin,
  };
  await run(
    [
      process.execPath,
      'build',
      'apps/server/src/index.ts',
      '--compile',
      '--conditions=workerd',
      '--outfile',
      path.join(output, 'server/server'),
      ...Object.entries(defines).flatMap(([name, value]) => [
        '--define',
        `process.env.${name}=${JSON.stringify(value)}`,
      ]),
    ],
    {},
  );
  // Migrations load after the compiled server starts; the runtime has no node_modules, so
  // their imports are bundled too.
  const migrations = readdirSync(path.join(ROOT, 'apps/server/migrations'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `apps/server/migrations/${name}`);
  await run(
    [
      process.execPath,
      'build',
      ...migrations,
      '--target',
      'bun',
      '--root',
      'apps/server/migrations',
      '--outdir',
      path.join(output, 'migrations'),
    ],
    {},
  );
}

if (import.meta.main) {
  const output = outputArgument('bun run scripts/build-deployment.ts <absolute output directory>');
  await build(output, deploymentInputs(process.env));
}
