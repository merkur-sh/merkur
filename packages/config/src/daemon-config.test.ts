import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigProvider, Effect } from 'effect';

import {
  canonicalizeDaemonServerOrigin,
  DaemonEnvironmentLive,
  DaemonEnvironmentService,
  loadDaemonConfigFromPath,
  removeDaemonConfigFromPath,
  requireDaemonConfigFromPath,
  saveDaemonConfigToPath,
  validateDaemonConfig,
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
      saveDaemonConfigToPath(configPath, {
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
      }),
    );

    expect((await stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  test('saveDaemonConfigToPath atomically replaces the config without temp artifacts', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, '.merkur', 'config.json');
    const initial = createDaemonConfigFile();
    const replacement = { ...initial, shell: '/bin/bash' };

    await Effect.runPromise(saveDaemonConfigToPath(configPath, initial));
    await Effect.runPromise(saveDaemonConfigToPath(configPath, replacement));

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(replacement);
    expect(await readdir(path.dirname(configPath))).toEqual(['config.json']);
  });

  test('removeDaemonConfigFromPath restores the pre-link absence', async () => {
    const directory = await createTempDirectory();
    const configPath = path.join(directory, '.merkur', 'config.json');
    await Effect.runPromise(saveDaemonConfigToPath(configPath, createDaemonConfigFile()));

    await Effect.runPromise(removeDaemonConfigFromPath(configPath));

    expect(await Effect.runPromise(loadDaemonConfigFromPath(configPath))).toBeNull();
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
