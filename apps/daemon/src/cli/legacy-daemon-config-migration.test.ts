import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';

import {
  loadLegacyDaemonConfigForLinkMigration,
  parseLegacyDaemonConfigForLinkMigration,
} from './legacy-daemon-config-migration';

const LEGACY_VALUE_A = Buffer.alloc(32, 0x11).toString('base64url');
const SESSION_TOKEN_VERIFY_KEY = Buffer.alloc(2_592, 0x33).toString('base64url');

describe('legacy daemon config link migration', () => {
  test('accepts only the exact deployed schema and exposes only a link-safe daemon id', () => {
    const legacyConfig = createLegacyConfig();

    const migration = parseLegacyDaemonConfigForLinkMigration(legacyConfig);

    expect(migration).toEqual({ daemonId: 'legacy-daemon_123' });
    expect(Object.keys(migration)).toEqual(['daemonId']);
    const serialized = JSON.stringify(migration);
    expect(serialized).not.toContain(legacyConfig.daemon_identity_signing_seed);
    expect(serialized).not.toContain(legacyConfig.session_token_verify_key);
  });

  test.each([
    {
      name: 'missing legacy field',
      mutate: (value: Record<string, unknown>) => {
        delete value.daemon_identity_signing_seed;
      },
    },
    {
      name: 'mixed current and legacy schema',
      mutate: (value: Record<string, unknown>) => {
        value.daemon_identity_seal = { backend: 'software', material: LEGACY_VALUE_A };
      },
    },
    {
      name: 'unknown field',
      mutate: (value: Record<string, unknown>) => {
        value.unexpected = true;
      },
    },
    {
      name: 'malformed legacy credential',
      mutate: (value: Record<string, unknown>) => {
        value.daemon_identity_signing_seed = 'not-canonical';
      },
    },
    {
      name: 'malformed verification key',
      mutate: (value: Record<string, unknown>) => {
        value.session_token_verify_key = 'not-canonical';
      },
    },
    {
      name: 'non-canonical server origin',
      mutate: (value: Record<string, unknown>) => {
        value.server_origin = 'https://example.test/path';
      },
    },
    {
      name: 'link-unsafe daemon id',
      mutate: (value: Record<string, unknown>) => {
        value.daemon_id = 'unsafe daemon id';
      },
    },
    {
      name: 'oversized daemon id',
      mutate: (value: Record<string, unknown>) => {
        value.daemon_id = 'A'.repeat(129);
      },
    },
  ])('rejects $name', ({ mutate }) => {
    const value: Record<string, unknown> = { ...createLegacyConfig() };
    mutate(value);

    expect(() => parseLegacyDaemonConfigForLinkMigration(value)).toThrow(
      'exact supported one-time link migration schema',
    );
  });

  test('loads the deployed file shape through the migration-only reader', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-legacy-config-'));
    const configPath = path.join(directory, 'config.json');
    try {
      await fs.writeFile(configPath, JSON.stringify(createLegacyConfig()));

      await expect(
        Effect.runPromise(loadLegacyDaemonConfigForLinkMigration(configPath)),
      ).resolves.toEqual({ daemonId: 'legacy-daemon_123' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('the migration-only reader rejects malformed current config files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-legacy-config-'));
    const configPath = path.join(directory, 'config.json');
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          daemon_id: 'current-but-malformed',
          daemon_identity_signing_seed: LEGACY_VALUE_A,
        }),
      );

      await expect(
        Effect.runPromise(loadLegacyDaemonConfigForLinkMigration(configPath)),
      ).rejects.toThrow('exact supported one-time link migration schema');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

function createLegacyConfig() {
  return {
    daemon_id: 'legacy-daemon_123',
    server_origin: 'https://merkur.example',
    daemon_identity_signing_seed: LEGACY_VALUE_A,
    webtransport_port: 44433,
    user_root_public_key: SESSION_TOKEN_VERIFY_KEY,
    root_epoch: 1,
    daemon_binding: {
      userId: 'user-1',
      rootKeyCommitment: Buffer.alloc(64, 1).toString('base64url'),
      daemonId: 'legacy-daemon_123',
      daemonIdentityKeyCommitment: Buffer.alloc(64, 2).toString('base64url'),
      serverOrigin: 'https://merkur.example',
      linkClaimId: 'claim-1',
      issuedAt: 1,
      signature: Buffer.alloc(4627, 3).toString('base64url'),
    },
    revoked_delegations: [],
    shell: '/legacy/shell/never-use',
    session_token_verify_key: SESSION_TOKEN_VERIFY_KEY,
  };
}
