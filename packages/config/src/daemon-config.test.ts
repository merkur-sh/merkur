import { dlopen, FFIType } from 'bun:ffi';
import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigProvider, Deferred, Effect, Fiber } from 'effect';

import {
  canonicalizeDaemonServerOrigin,
  DaemonEnvironmentLive,
  DaemonEnvironmentService,
  loadDaemonConfigFromPath,
  persistDaemonRevocationsToPath,
  removeDaemonConfigFromPath,
  requireDaemonConfigFromPath,
  restoreDaemonConfigAtPath,
  saveDaemonConfigToPath,
  transactDaemonConfigAtPath,
  validateDaemonConfig,
  withDaemonEnrollmentLockAtPath,
} from './daemon-config';

const tempDirectories: string[] = [];
const DAEMON_IDENTITY_SIGNING_SEED = Buffer.alloc(32, 0x22).toString('base64url');
const SESSION_TOKEN_VERIFY_KEY = Buffer.alloc(2_592, 0x33).toString('base64url');
const USER_ROOT_PUBLIC_KEY = Buffer.alloc(2_592, 0x44).toString('base64url');

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0, tempDirectories.length)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('daemon config', () => {
  test('rejects the removed bearer credential', () => {
    expect(() =>
      validateDaemonConfig({ ...createDaemonConfigFile(), api_key: 'copied-key' }),
    ).toThrow('Invalid daemon config field: api_key');
  });

  test('daemon server origins require HTTPS before connection except on loopback', () => {
    expect(canonicalizeDaemonServerOrigin('https://merkur.example/')).toBe(
      'https://merkur.example',
    );
    expect(canonicalizeDaemonServerOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(canonicalizeDaemonServerOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(() => canonicalizeDaemonServerOrigin('http://merkur.example')).toThrow(
      'Invalid daemon config field: server_origin',
    );
  });

  test('the pinned WebTransport port must be one the daemon can actually bind', () => {
    // A persisted 0 would mean "ephemeral", which silently invalidates the
    // router forward and firewall rule the pinned port exists to make possible.
    // Below 1024 needs privileges the daemon does not have.
    for (const invalid of [0, 80, 1023, 65_536, 1.5, '44433']) {
      expect(() =>
        validateDaemonConfig({ ...createDaemonConfigFile(), webtransport_port: invalid }),
      ).toThrow('Invalid daemon config field: webtransport_port');
    }

    expect(
      validateDaemonConfig({ ...createDaemonConfigFile(), webtransport_port: 1024 })
        .webtransport_port,
    ).toBe(1024);
    expect(
      validateDaemonConfig({ ...createDaemonConfigFile(), webtransport_port: 65_535 })
        .webtransport_port,
    ).toBe(65_535);
  });

  test('loadDaemonConfigFromPath returns null for a missing file', async () => {
    const directory = await createTempDirectory();
    const config = await Effect.runPromise(
      loadDaemonConfigFromPath(path.join(directory, 'missing.json')),
    );

    expect(config).toBeNull();
  });

  test('loadDaemonConfigFromPath reads the exact current schema', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(createDaemonConfigFile()), 'utf8');

    const config = await Effect.runPromise(loadDaemonConfigFromPath(configPath));

    expect(config).toEqual({
      daemon_id: 'daemon-1',
      server_origin: 'https://example.com',
      daemon_identity_seal: {
        backend: 'software' as const,
        material: DAEMON_IDENTITY_SIGNING_SEED,
      },
      shell: '/bin/zsh',
      webtransport_port: 44_433,
      session_token_verify_key: SESSION_TOKEN_VERIFY_KEY,
      ...authorizationConfigFields(),
    });
  });

  test('saveDaemonConfigToPath writes private directory and file modes', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, '.merkur', 'config.json');

    await Effect.runPromise(
      saveDaemonConfigToPath(
        configPath,
        {
          daemon_id: 'daemon-1',
          server_origin: 'https://example.com',
          daemon_identity_seal: {
            backend: 'software' as const,
            material: DAEMON_IDENTITY_SIGNING_SEED,
          },
          shell: '/bin/zsh',
          webtransport_port: 44_433,
          session_token_verify_key: SESSION_TOKEN_VERIFY_KEY,
          ...authorizationConfigFields(),
        },
        null,
      ),
    );

    expect((await stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  test('saveDaemonConfigToPath atomically replaces the config without temp artifacts', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, '.merkur', 'config.json');
    const initial = createDaemonConfigFile();
    const replacement = { ...initial, shell: '/bin/bash' };

    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    await Effect.runPromise(saveDaemonConfigToPath(configPath, replacement, initial));

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(replacement);
    expect((await readdir(path.dirname(configPath))).sort()).toEqual([
      'config.json',
      'config.json.lock',
    ]);
  });

  test('removeDaemonConfigFromPath restores the pre-link absence', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, '.merkur', 'config.json');
    const initial = createDaemonConfigFile();
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));

    await Effect.runPromise(removeDaemonConfigFromPath(configPath, initial));

    expect(await Effect.runPromise(loadDaemonConfigFromPath(configPath))).toBeNull();
  });

  test('concurrent_revocation survives a stale same-lineage enrollment save', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const initial = createDaemonConfigFile();
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    const revoked = {
      ...initial,
      revoked_delegations: [{ delegationId: 'revoked-a', expiresAt: 100 }],
    };
    await Effect.runPromise(saveDaemonConfigToPath(configPath, revoked, initial));
    const approved = {
      ...initial,
      daemon_binding: { ...initial.daemon_binding, linkClaimId: 'claim-2' },
    };
    await Effect.runPromise(saveDaemonConfigToPath(configPath, approved, initial));
    expect(
      (await Effect.runPromise(requireDaemonConfigFromPath(configPath))).revoked_delegations,
    ).toEqual(revoked.revoked_delegations);
  });

  test('concurrent_revocation cannot restore an identity replaced by another writer', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const initial = createDaemonConfigFile();
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    const replacement = { ...initial, root_epoch: 2 };
    await Effect.runPromise(saveDaemonConfigToPath(configPath, replacement, initial));
    const stale = {
      ...initial,
      revoked_delegations: [{ delegationId: 'revoked-a', expiresAt: 100 }],
    };
    await expect(
      Effect.runPromise(saveDaemonConfigToPath(configPath, stale, initial)),
    ).rejects.toThrow();
    expect(await Effect.runPromise(requireDaemonConfigFromPath(configPath))).toEqual(replacement);
    await expect(
      Effect.runPromise(removeDaemonConfigFromPath(configPath, initial)),
    ).rejects.toThrow();
    expect(await Effect.runPromise(requireDaemonConfigFromPath(configPath))).toEqual(replacement);
  });

  test('concurrent_revocation merges maximum expiry after enrollment changes within its lineage', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const initial = createDaemonConfigFile();
    const installed = {
      ...initial,
      daemon_binding: { ...initial.daemon_binding, linkClaimId: 'claim-2' },
    };
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    await Effect.runPromise(saveDaemonConfigToPath(configPath, installed, initial));
    for (const expiresAt of [100, 50, 200]) {
      await Effect.runPromise(
        persistDaemonRevocationsToPath(configPath, initial, [
          { delegationId: 'revoked-a', expiresAt },
        ]),
      );
    }
    const final = await Effect.runPromise(requireDaemonConfigFromPath(configPath));
    expect(final.daemon_binding.linkClaimId).toBe('claim-2');
    expect(final.revoked_delegations).toEqual([{ delegationId: 'revoked-a', expiresAt: 200 }]);
    await Effect.runPromise(restoreDaemonConfigAtPath(configPath, initial, installed));
    const restored = await Effect.runPromise(requireDaemonConfigFromPath(configPath));
    expect(restored.daemon_binding).toEqual(initial.daemon_binding);
    expect(restored.revoked_delegations).toEqual(final.revoked_delegations);
  });

  test('rollback cannot overwrite or remove a newer enrollment', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const initial = createDaemonConfigFile();
    const installed = {
      ...initial,
      daemon_binding: { ...initial.daemon_binding, linkClaimId: 'claim-2' },
    };
    const successor = { ...installed, root_epoch: 2 };
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    await Effect.runPromise(saveDaemonConfigToPath(configPath, installed, initial));
    await Effect.runPromise(saveDaemonConfigToPath(configPath, successor, installed));
    const bytes = await readFile(configPath, 'utf8');
    await Effect.runPromise(restoreDaemonConfigAtPath(configPath, initial, installed));
    await Effect.runPromise(restoreDaemonConfigAtPath(configPath, null, installed));
    expect(await readFile(configPath, 'utf8')).toBe(bytes);
    await expect(
      Effect.runPromise(
        persistDaemonRevocationsToPath(configPath, initial, [
          { delegationId: 'revoked-a', expiresAt: 100 },
        ]),
      ),
    ).rejects.toThrow('lineage');
    expect(await readFile(configPath, 'utf8')).toBe(bytes);
  });

  test('a failed mutation releases the kernel lock without changing config bytes', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const initial = createDaemonConfigFile();
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    const bytes = await readFile(configPath, 'utf8');
    await expect(
      Effect.runPromise(
        transactDaemonConfigAtPath(configPath, () => {
          throw new Error('rejected');
        }),
      ),
    ).rejects.toThrow('rejected');
    expect(await readFile(configPath, 'utf8')).toBe(bytes);
    await Effect.runPromise(
      persistDaemonRevocationsToPath(configPath, initial, [
        { delegationId: 'revoked-a', expiresAt: 100 },
      ]),
    );
    expect(
      (await Effect.runPromise(requireDaemonConfigFromPath(configPath))).revoked_delegations,
    ).toHaveLength(1);
  });

  test('the parent retains the kernel lock after its acquisition worker exits', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const initial = createDaemonConfigFile();
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    const libc = dlopen(
      process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
      {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      },
    );
    try {
      await Effect.runPromise(
        transactDaemonConfigAtPath(configPath, (current) => {
          const descriptor = openSync(`${configPath}.lock`, 'r+');
          try {
            expect(libc.symbols.flock(descriptor, 2 | 4)).toBe(-1);
          } finally {
            closeSync(descriptor);
          }
          return current;
        }),
      );
    } finally {
      libc.close();
    }
    expect((await stat(`${configPath}.lock`)).mode & 0o777).toBe(0o600);
  });

  test.each(['release', 'death', 'enrollment-death'] as const)(
    'cross-process config transaction resumes after owner %s',
    async (outcome) => {
      const directory = await createTempDirectory();
      const configPath = path.join(directory, 'config.json');
      await Effect.runPromise(saveDaemonConfigToPath(configPath, createDaemonConfigFile(), null));
      const owner = spawnConfigTransaction(
        configPath,
        'revoked-a',
        outcome === 'enrollment-death' ? 'enrollment-hold' : 'hold',
      );
      const ownerOutput = owner.stdout.getReader();
      let successor: ReturnType<typeof spawnConfigTransaction> | undefined;
      try {
        await readTransactionMarker(ownerOutput, 'locked');
        if (outcome === 'enrollment-death') {
          owner.kill('SIGKILL');
          await owner.exited;
        }
        successor = spawnConfigTransaction(
          configPath,
          'revoked-b',
          outcome === 'enrollment-death' ? 'enrollment-write' : 'write',
        );
        const successorOutput = successor.stdout.getReader();
        await readTransactionMarker(successorOutput, 'starting');
        if (outcome !== 'release') owner.kill('SIGKILL');
        else {
          owner.stdin.write('r');
          owner.stdin.end();
        }
        await owner.exited;
        await readTransactionMarker(successorOutput, 'committed');
        expect(await successor.exited).toBe(0);
        const final = await Effect.runPromise(requireDaemonConfigFromPath(configPath));
        expect(final.revoked_delegations).toEqual(
          outcome !== 'release'
            ? [{ delegationId: 'revoked-b', expiresAt: 100 }]
            : [
                { delegationId: 'revoked-a', expiresAt: 100 },
                { delegationId: 'revoked-b', expiresAt: 100 },
              ],
        );
      } finally {
        owner.kill('SIGKILL');
        successor?.kill('SIGKILL');
        await owner.exited;
        if (successor !== undefined) await successor.exited;
      }
    },
  );

  test('interrupting enrollment releases its lock while tombstone persistence remains independent', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const initial = createDaemonConfigFile();
    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial, null));
    const entered = Deferred.makeUnsafe<void>();
    const owner = Effect.runFork(
      withDaemonEnrollmentLockAtPath(
        configPath,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Effect.never;
        }),
      ),
    );
    try {
      await Effect.runPromise(Deferred.await(entered));
      await expect(
        Effect.runPromise(withDaemonEnrollmentLockAtPath(configPath, Effect.void)),
      ).rejects.toThrow('already in progress');
      await Effect.runPromise(
        persistDaemonRevocationsToPath(configPath, initial, [
          { delegationId: 'revoked-a', expiresAt: 100 },
        ]),
      );
      expect(
        (await Effect.runPromise(requireDaemonConfigFromPath(configPath))).revoked_delegations,
      ).toHaveLength(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(owner));
    }
    expect(
      await Effect.runPromise(
        withDaemonEnrollmentLockAtPath(configPath, Effect.succeed('successor')),
      ),
    ).toBe('successor');
  });

  test('a compiled executable embeds the config lock worker and completes a transaction', async () => {
    const directory = await createTempDirectory();
    const executable = path.join(directory, 'config-transaction');
    const configPath = path.join(directory, 'config.json');
    const build = Bun.spawn(
      [
        process.execPath,
        'build',
        new URL('../../../apps/daemon/src/cli/config-transaction-fixture.ts', import.meta.url)
          .pathname,
        new URL('./daemon-config-lock-worker.ts', import.meta.url).pathname,
        '--compile',
        '--entry-naming',
        '[name].[ext]',
        '--outfile',
        executable,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [status, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect({ status, stderr: status === 0 ? '' : stderr }).toEqual({ status: 0, stderr: '' });
    await Effect.runPromise(saveDaemonConfigToPath(configPath, createDaemonConfigFile(), null));
    const child = Bun.spawn([executable, configPath, 'compiled-revocation', 'write'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, error }).toEqual({ exitCode: 0, error: '' });
    expect(
      (await Effect.runPromise(requireDaemonConfigFromPath(configPath))).revoked_delegations,
    ).toEqual([{ delegationId: 'compiled-revocation', expiresAt: 100 }]);
  });

  test('requireDaemonConfigFromPath fails when the config is missing', async () => {
    const directory = await createTempDirectory();

    await expect(
      Effect.runPromise(requireDaemonConfigFromPath(path.join(directory, 'missing.json'))),
    ).rejects.toThrow(`Missing daemon config at ${path.join(directory, 'missing.json')}`);
  });

  test('loadDaemonConfigFromPath rejects the removed local daemon auth salt', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ ...createDaemonConfigFile(), daemon_auth_salt: 'b'.repeat(64) }),
      'utf8',
    );

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: daemon_auth_salt',
    );
  });

  test('loadDaemonConfigFromPath rejects invalid JSON', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, '{not-json', 'utf8');

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow();
  });

  test('loadDaemonConfigFromPath rejects a BOM instead of normalizing persisted JSON', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, `\uFEFF${JSON.stringify(createDaemonConfigFile())}`, 'utf8');

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow();
  });

  test('loadDaemonConfigFromPath rejects an array root', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, '[]', 'utf8');

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: root must be an object',
    );
  });

  test('loadDaemonConfigFromPath rejects version fields instead of gating schemas', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ ...createDaemonConfigFile(), version: 4 }),
      'utf8',
    );

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: version',
    );
  });

  test('loadDaemonConfigFromPath rejects the removed signaling URL schema', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const { server_origin: _serverOrigin, ...config } = createDaemonConfigFile();
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        server_url: 'wss://example.com/signal',
      }),
      'utf8',
    );

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: server_url',
    );
  });

  test('loadDaemonConfigFromPath requires a canonical HTTP server origin', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');

    for (const serverOrigin of [
      'wss://example.com/signal',
      'https://example.com/signal',
      'https://example.com?edge=1',
      'http://example.com',
    ]) {
      await writeFile(
        configPath,
        JSON.stringify({ ...createDaemonConfigFile(), server_origin: serverOrigin }),
        'utf8',
      );
      await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
        'Invalid daemon config field: server_origin',
      );
    }

    for (const serverOrigin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      await writeFile(
        configPath,
        JSON.stringify({ ...createDaemonConfigFile(), server_origin: serverOrigin }),
        'utf8',
      );
      expect((await Effect.runPromise(loadDaemonConfigFromPath(configPath)))?.server_origin).toBe(
        serverOrigin,
      );
    }
  });

  test('loadDaemonConfigFromPath rejects malformed daemon identity signing seeds', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDaemonConfigFile(),
        daemon_identity_seal: { backend: 'software', material: `${DAEMON_IDENTITY_SIGNING_SEED}=` },
      }),
      'utf8',
    );

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: daemon_identity_seal',
    );
  });

  test('loadDaemonConfigFromPath rejects invalid session_token_verify_key length', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ ...createDaemonConfigFile(), session_token_verify_key: 'too-short' }),
      'utf8',
    );

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: session_token_verify_key',
    );
  });

  test('loadDaemonConfigFromPath rejects a non-base64url session token verification key', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ ...createDaemonConfigFile(), session_token_verify_key: '~'.repeat(3_456) }),
      'utf8',
    );

    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: session_token_verify_key',
    );
  });

  test('loadDaemonConfigFromPath rejects empty identity and authority strings', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');

    for (const field of ['daemon_id', 'api_key', 'shell'] as const) {
      await writeFile(
        configPath,
        JSON.stringify({ ...createDaemonConfigFile(), [field]: '   ' }),
        'utf8',
      );
      await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
        `Invalid daemon config field: ${field}`,
      );
    }
  });

  test('loadDaemonConfigFromPath rejects unknown legacy transport fields', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');

    await writeFile(
      configPath,
      JSON.stringify({ ...createDaemonConfigFile(), legacy_transport_id: 'removed' }),
      'utf8',
    );
    await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
      'Invalid daemon config field: legacy_transport_id',
    );
  });

  test('loadDaemonConfigFromPath rejects missing authority fields', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');

    for (const field of ['daemon_identity_seal', 'session_token_verify_key'] as const) {
      const config: Record<string, unknown> = createDaemonConfigFile();
      delete config[field];
      await writeFile(configPath, JSON.stringify(config), 'utf8');
      await expect(Effect.runPromise(loadDaemonConfigFromPath(configPath))).rejects.toThrow(
        `Invalid daemon config field: ${field}`,
      );
    }
  });

  test('loadDaemonConfigFromPath round-trips required authority fields', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, 'config.json');
    const sessionKey = Buffer.alloc(2_592, 0x44).toString('base64url');
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDaemonConfigFile(),
        session_token_verify_key: sessionKey,
      }),
      'utf8',
    );

    const config = await Effect.runPromise(loadDaemonConfigFromPath(configPath));

    expect(config?.session_token_verify_key).toBe(sessionKey);
    expect(config?.daemon_identity_seal.material).toBe(DAEMON_IDENTITY_SIGNING_SEED);
  });
});

describe('DaemonEnvironmentLive', () => {
  test('prefers MERKUR_DAEMON_HOME when set', async () => {
    const env = await Effect.runPromise(
      provideEnv({
        MERKUR_DAEMON_HOME: '/tmp/scoped-home',
        HOME: '/var/empty',
      }),
    );

    expect(env.home).toBe('/tmp/scoped-home');
    expect(env.configPath).toBe('/tmp/scoped-home/.merkur/config.json');
  });

  test('falls back to HOME when MERKUR_DAEMON_HOME is absent', async () => {
    const env = await Effect.runPromise(
      provideEnv({
        HOME: '/home/user',
      }),
    );

    expect(env.home).toBe('/home/user');
    expect(env.configPath).toBe('/home/user/.merkur/config.json');
  });
});

function provideEnv(entries: Record<string, string>) {
  const provider = ConfigProvider.fromUnknown(entries);
  return Effect.provide(
    Effect.gen(function* () {
      return yield* DaemonEnvironmentService;
    }),
    DaemonEnvironmentLive,
  ).pipe(Effect.provide(ConfigProvider.layer(provider)));
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'merkur-daemon-config-'));
  tempDirectories.push(directory);
  return directory;
}

function createDaemonConfigFile() {
  return {
    daemon_id: 'daemon-1',
    server_origin: 'https://example.com',
    daemon_identity_seal: { backend: 'software' as const, material: DAEMON_IDENTITY_SIGNING_SEED },
    shell: '/bin/zsh',
    webtransport_port: 44_433,
    session_token_verify_key: SESSION_TOKEN_VERIFY_KEY,
    ...authorizationConfigFields(),
  };
}

function authorizationConfigFields() {
  return {
    user_root_public_key: USER_ROOT_PUBLIC_KEY,
    root_epoch: 1,
    daemon_binding: {
      userId: 'user-1',
      rootKeyCommitment: Buffer.alloc(64, 0x55).toString('base64url'),
      daemonId: 'daemon-1',
      daemonIdentityKeyCommitment: Buffer.alloc(64, 0x66).toString('base64url'),
      serverOrigin: 'https://example.com',
      linkClaimId: 'claim-1',
      issuedAt: 1,
      signature: Buffer.alloc(4_627, 0x77).toString('base64url'),
    },
    revoked_delegations: [],
  } as const;
}

function spawnConfigTransaction(configPath: string, delegationId: string, mode: string) {
  return Bun.spawn(
    [
      process.execPath,
      new URL('../../../apps/daemon/src/cli/config-transaction-fixture.ts', import.meta.url)
        .pathname,
      configPath,
      delegationId,
      mode,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
}

async function readTransactionMarker(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<void> {
  let output = '';
  while (!output.split('\n').includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Transaction ended before ${marker}: ${output}`);
    output += new TextDecoder().decode(chunk.value);
  }
}
