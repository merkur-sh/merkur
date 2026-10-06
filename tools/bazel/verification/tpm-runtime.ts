import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { probeTpm, waitForTpm } from '../../../scripts/test-tpm-sim';
import {
  invokeFixtureCommand,
  nativeGraphicsInventory,
  runAndRetireFixture,
  verifyNativeGraphicsRun,
} from './real-helper';

export const tpmSimulatorCases = Object.freeze([
  'tpm::tests::tpm_sim_round_trip_sign_tamper_binding_and_context_cleanup',
]);

export interface TpmFixtureInputs {
  readonly image: string;
  readonly identity: string;
  readonly harness: string;
  readonly docker_host: string;
  readonly target: string;
}

function portable(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every((part) => !['', '.', '..'].includes(part))
  );
}

export function tpmFixtureInputs(value: unknown): TpmFixtureInputs {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TPM inputs require the declared fixture object');
  const row = value as Record<string, unknown>;
  const platforms: Record<string, string> = {
    'aarch64-apple-darwin': 'darwin/arm64',
    'x86_64-apple-darwin': 'darwin/x64',
    'aarch64-unknown-linux-gnu': 'linux/arm64',
    'x86_64-unknown-linux-gnu': 'linux/x64',
  };
  if (
    Object.keys(row).sort().join(',') !== 'docker_host,harness,identity,image,target' ||
    !portable(row.image) ||
    !portable(row.identity) ||
    !portable(row.harness) ||
    typeof row.docker_host !== 'string' ||
    !row.docker_host.startsWith('unix:///') ||
    typeof row.target !== 'string' ||
    platforms[row.target] !== `${process.platform}/${process.arch}`
  )
    throw new Error('TPM inputs require exact Files, local Docker and matching native target');
  return row as unknown as TpmFixtureInputs;
}

/** One action-owned ephemeral simulator; cleanup remains outside cancellation. */
export async function runTpmFixture(
  input: TpmFixtureInputs,
  runfiles: string,
  docker: string,
  temporary: string,
  signal: AbortSignal,
  command: typeof invokeFixtureCommand = invokeFixtureCommand,
  readiness: (port: number) => Promise<void> = probeTpm,
) {
  if (![runfiles, docker, temporary].every(path.isAbsolute))
    throw new Error('TPM fixture requires original absolute tool and engine paths');
  accessSync(docker, constants.X_OK);
  const harness = path.join(runfiles, input.harness);
  const environment = { PATH: '', HOME: temporary, TMPDIR: temporary, RUNFILES_DIR: runfiles };
  const listing = await command([harness, 'tpm_sim', '--list'], { env: environment, signal });
  if (listing.exitCode !== 0) throw new Error('Original TPM inventory query failed');
  nativeGraphicsInventory(listing.stdout, tpmSimulatorCases);
  const image = readFileSync(path.join(runfiles, input.identity), 'utf8').trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Original TPM image identity missing');
  const name = `merkur-tpm-test-${randomUUID()}`;
  const dockerCommand = async (args: string[], cleaningUp = false) => {
    const result = await command([docker, ...args], {
      env: { ...environment, DOCKER_HOST: input.docker_host },
      signal: cleaningUp ? undefined : signal,
    });
    if (result.exitCode !== 0)
      throw new Error(`Declared Docker ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  await runAndRetireFixture(
    async () => {
      await dockerCommand(['load', '--input', path.join(runfiles, input.image)]);
      if ((await dockerCommand(['image', 'inspect', '--format={{.Id}}', image])) !== image)
        throw new Error('Loaded TPM image differs from its declared identity');
      await dockerCommand([
        'run',
        '--rm',
        '-d',
        '--name',
        name,
        '-p',
        '127.0.0.1::2321',
        '--tmpfs',
        '/tmp/tpm',
        '--entrypoint',
        '/usr/bin/swtpm',
        image,
        'socket',
        '--tpm2',
        '--tpmstate',
        'dir=/tmp/tpm',
        '--server',
        'type=tcp,bindaddr=0.0.0.0,port=2321',
        '--flags',
        'not-need-init,startup-clear',
      ]);
      const address = await dockerCommand(['port', name, '2321/tcp']);
      await waitForTpm(address, signal, readiness);
      const test = await command([harness, 'tpm_sim'], {
        env: { ...environment, MERKUR_TPM_SIM_ADDR: address },
        signal,
      });
      verifyNativeGraphicsRun(test.stdout, test.exitCode, tpmSimulatorCases);
      signal.throwIfAborted();
    },
    () => dockerCommand(['rm', '-f', name], true).then(() => {}),
    'Original TPM fixture refused',
  );
}

if (import.meta.main) {
  const request = process.env.MERKUR_TPM_INPUTS;
  const runfiles = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  const docker = process.env.MERKUR_TPM_DOCKER;
  const temporary = process.env.TEST_TMPDIR;
  if (
    request === undefined ||
    runfiles === undefined ||
    docker === undefined ||
    temporary === undefined ||
    process.argv.length !== 2
  )
    throw new Error('Declared TPM inputs, Docker and private runtime paths required');
  const lifetime = new AbortController();
  const interrupt = () => lifetime.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await runTpmFixture(
      tpmFixtureInputs(JSON.parse(readFileSync(request, 'utf8'))),
      realpathSync(runfiles),
      realpathSync(docker),
      temporary,
      lifetime.signal,
    );
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
