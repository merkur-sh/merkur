import { type DaemonIdentitySeal, requireDaemonIdentitySeal } from '@merkur/config';
import { isRecord } from '@merkur/shared';
import { Data, Effect } from 'effect';
import { resolveDataplaneBinaryPath } from '../services/dataplane-binary';

export class IdentitySealError extends Data.TaggedError('IdentitySealError')<{
  readonly code:
    | 'binary_not_found'
    | 'invalid_output'
    | 'backend_failure'
    | 'tpm_access_denied'
    | 'hardware_unavailable';
}> {}

export interface SealedDaemonIdentity {
  readonly seal: DaemonIdentitySeal;
  readonly publicKey: string;
  readonly p256PublicKey: string;
}

function runIdentitySeal(
  args: string[],
  seal?: DaemonIdentitySeal,
): Effect.Effect<unknown, IdentitySealError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const binary = resolveDataplaneBinaryPath();
      if (binary === null) throw new IdentitySealError({ code: 'binary_not_found' });
      const input =
        seal === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(seal));
      let child: ReturnType<typeof Bun.spawn> | null = null;
      const output = new Uint8Array(16384);
      let size = 0;
      try {
        const process = Bun.spawn([binary, 'identity-seal', ...args], {
          stdin: input,
          stdout: 'pipe',
          stderr: 'ignore',
          signal,
          timeout: 30000,
          killSignal: 'SIGKILL',
        });
        child = process;
        for await (const chunk of process.stdout) {
          if (size + chunk.byteLength > output.byteLength)
            throw new IdentitySealError({ code: 'invalid_output' });
          output.set(chunk, size);
          size += chunk.byteLength;
          chunk.fill(0);
        }
        const exitCode = await process.exited;
        if (exitCode === 4) throw new IdentitySealError({ code: 'tpm_access_denied' });
        if (exitCode === 5) throw new IdentitySealError({ code: 'hardware_unavailable' });
        if (exitCode !== 0) throw new IdentitySealError({ code: 'backend_failure' });
        return JSON.parse(new TextDecoder().decode(output.subarray(0, size))) as unknown;
      } finally {
        if (child !== null && child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
        input.fill(0);
        output.fill(0);
      }
    },
    catch: (error) =>
      error instanceof IdentitySealError
        ? error
        : new IdentitySealError({ code: 'backend_failure' }),
  });
}

function publicKeys(
  value: Record<string, unknown>,
): Pick<SealedDaemonIdentity, 'publicKey' | 'p256PublicKey'> {
  for (const [field, bytes] of [
    ['public_key', 2592],
    ['p256_public_key', 65],
  ] as const) {
    const encoded = value[field];
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(encoded))
      throw new IdentitySealError({ code: 'invalid_output' });
    const decoded = Buffer.from(encoded, 'base64url');
    if (
      decoded.length !== bytes ||
      decoded.toString('base64url') !== encoded ||
      (bytes === 65 && decoded[0] !== 4)
    )
      throw new IdentitySealError({ code: 'invalid_output' });
  }
  if (typeof value.public_key !== 'string' || typeof value.p256_public_key !== 'string')
    throw new IdentitySealError({ code: 'invalid_output' });
  return { publicKey: value.public_key, p256PublicKey: value.p256_public_key };
}

export const createIdentitySealEffect = Effect.fnUntraced(function* (options: {
  readonly forceSoftware: boolean;
}) {
  const value = yield* runIdentitySeal(
    options.forceSoftware ? ['create', '--backend', 'software'] : ['create'],
  );
  return yield* Effect.try({
    try: (): SealedDaemonIdentity => {
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 4 ||
        !Object.hasOwn(value, 'backend') ||
        !Object.hasOwn(value, 'material')
      )
        throw new IdentitySealError({ code: 'invalid_output' });
      const seal = requireDaemonIdentitySeal({ backend: value.backend, material: value.material });
      if (!options.forceSoftware && seal.backend === 'software')
        throw new IdentitySealError({ code: 'hardware_unavailable' });
      if (options.forceSoftware && seal.backend !== 'software')
        throw new IdentitySealError({ code: 'invalid_output' });
      return { seal, ...publicKeys(value) };
    },
    catch: (error) =>
      error instanceof IdentitySealError
        ? error
        : new IdentitySealError({ code: 'invalid_output' }),
  });
});

export const inspectIdentitySealEffect = Effect.fnUntraced(function* (seal: DaemonIdentitySeal) {
  const value = yield* runIdentitySeal(['inspect'], seal);
  return yield* Effect.try({
    try: (): SealedDaemonIdentity => {
      if (!isRecord(value) || Object.keys(value).length !== 2)
        throw new IdentitySealError({ code: 'invalid_output' });
      return { seal, ...publicKeys(value) };
    },
    catch: () => new IdentitySealError({ code: 'invalid_output' }),
  });
});
