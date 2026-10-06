import { describe, expect, test } from 'bun:test';
import {
  deriveDaemonIdentityKeyCommitment,
  deriveSessionAuthorizationKeyPair,
  deriveSoftwareDaemonP256PublicKey,
  SESSION_AUTHORIZATION_SEED_BYTES,
} from '@merkur/auth';
import {
  createDaemonBinding,
  createDaemonLinkApproval,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  parseDaemonLinkCode,
  USER_ROOT_INITIAL_EPOCH,
} from '@merkur/shared/user-authorization';
import { Effect } from 'effect';

import type { DaemonConfig } from '../config';
import type { Logger } from '../logger';
import { IdentitySealError } from './identity-seal';
import {
  type DaemonLinkCommandDependencies,
  type DaemonLinkCreateRequest,
  parseLinkArguments,
  runLinkCommandEffect,
} from './link';

const CLAIM_TOKEN = 'A'.repeat(52);
const SERVER_ORIGIN = 'https://merkur.example';
const IDENTITY_SEED = Buffer.alloc(SESSION_AUTHORIZATION_SEED_BYTES, 0x44);
const LINK_SECRET = Buffer.alloc(32, 0x55);
const SERVER_NONCE = Buffer.alloc(32, 0x66);
const POLL_TOKEN = Buffer.alloc(32, 0x77).toString('base64url');
const SESSION_TOKEN_VERIFY_KEY = Buffer.alloc(2_592, 0x33).toString('base64url');
const ROOT_KEYS = deriveUserAuthorizationSigningKey(Buffer.alloc(32, 0x11));
const ROOT_PUBLIC_KEY = encodeUserAuthorizationBytes(ROOT_KEYS.publicKey);
const ROOT_KEY_COMMITMENT = deriveUserRootKeyCommitment(ROOT_KEYS.publicKey);
const LOGIN_SHELL = '/opt/homebrew/bin/fish';

describe('daemon link arguments', () => {
  test('takes the origin alone; the token arrives in the environment, never as an argument', () => {
    expect(parseLinkArguments([SERVER_ORIGIN])).toEqual({
      requestedServerOrigin: SERVER_ORIGIN,
      forceSoftware: false,
      replaceIdentity: false,
    });
    for (const args of [
      [],
      [''],
      // An argument would be readable through `ps` by every user on the machine
      // for as long as linking waits for approval, so the flag is gone rather
      // than merely discouraged.
      [SERVER_ORIGIN, '--token', CLAIM_TOKEN],
      [SERVER_ORIGIN, '--pairing-code', 'secret'],
    ]) {
      expect(parseLinkArguments(args)).toBeNull();
    }
  });

  test('a token read from the environment is still validated before anything is claimed', async () => {
    for (const token of ['', 'not-a-token', `${CLAIM_TOKEN}extra`]) {
      const dependencies = createDependencies({
        readLinkToken: () => Effect.succeed(token),
        createClaim: () => {
          throw new Error('must not reach the server with an unusable token');
        },
      });
      expect(
        await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
      ).toBe(1);
    }
  });

  test('an account the password database names no shell for is refused before any claim', async () => {
    const dependencies = createDependencies({
      loginShell: () => Effect.fail(new Error('no login shell')),
      createClaim: () => {
        throw new Error('must not reach the server without a shell to record');
      },
    });

    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
    ).toBe(1);
  });

  test('a token read that fails is a refusal, not a link attempt', async () => {
    const dependencies = createDependencies({
      readLinkToken: () => Effect.fail(new Error('unreadable')),
      createClaim: () => {
        throw new Error('must not reach the server without a token');
      },
    });

    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
    ).toBe(1);
  });
});

describe('two-phase daemon link claim', () => {
  test('reports capacity and exits without displaying an approval link when full', async () => {
    const logs: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
    const logger: Logger = {
      info: (message, context) => {
        logs.push({ message, context });
      },
      warn() {},
      error: (message, context) => {
        logs.push({ message, context });
      },
    };
    const dependencies = createDependencies({
      createClaim: async () => ({
        ...createdClaim(),
        data: { ...createdClaim().data, machineUsage: { used: 3, limit: 3 }, canLink: false },
      }),
      showApprovalQrCode: () => {
        throw new Error('must not display QR code at capacity');
      },
      pollClaim: async () => {
        throw new Error('must not poll at capacity');
      },
    });
    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], logger, dependencies)),
    ).toBe(1);
    expect(logs.some((entry) => entry.message === 'daemon_link_code')).toBe(false);
    expect(
      logs.find((entry) => entry.message === 'daemon_link_machine_limit_reached')?.context?.message,
    ).toContain('Unlink a machine');
    expect(
      logs.find((entry) => entry.message === 'daemon_link_machine_usage')?.context,
    ).toMatchObject({ used: 3, limit: 3 });
  });
  test('binds the complete public claim, verifies root approval, saves, then completes', async () => {
    const generatedSecret = Buffer.from(LINK_SECRET);
    const saved: DaemonConfig[] = [];
    const events: string[] = [];
    const codes: string[] = [];
    const requests: DaemonLinkCreateRequest[] = [];
    const dependencies = createDependencies({
      generateLinkSecret: () => generatedSecret,
      createClaim: (_origin, request) => {
        requests.push(request);
        return Promise.resolve(createdClaim());
      },
      pollClaim: (_origin, _claimId, _pollToken) => {
        events.push('poll');
        return Promise.resolve(approvedClaim(required(requests[0]), LINK_SECRET));
      },
      saveConfig: (config) =>
        Effect.sync(() => {
          events.push('save');
          saved.push(config);
        }),
      completeClaim: () => {
        events.push('complete');
        return Promise.resolve({ data: null, error: null });
      },
    });
    const logger: Logger = {
      info(message, context): void {
        if (message === 'daemon_link_code' && typeof context?.code === 'string') {
          codes.push(context.code);
          expect(context.url).toBe(`${SERVER_ORIGIN}/link#${context.code}`);
        }
      },
      warn(): void {},
      error(): void {},
    };

    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], logger, dependencies)),
    ).toBe(0);

    const request = required(requests[0]);
    expect(Object.keys(request)).toEqual([
      'linkToken',
      'linkClaimId',
      'daemonId',
      'daemonIdentityPublicKey',
      'daemonIdentityP256PublicKey',
      'daemonIdentityKeyCommitment',
      'name',
      'platform',
      'identitySealBackend',
      'claimCommitment',
    ]);
    expect(request.linkToken).toBe(CLAIM_TOKEN);
    expect(request.claimCommitment).toHaveLength(86);
    expect(JSON.stringify(request)).not.toContain(IDENTITY_SEED.toString('base64url'));
    expect(parseDaemonLinkCode(required(codes[0])).linkClaimId).toBe('claim-1');
    expect(events).toEqual(['poll', 'save', 'complete']);
    const config = required(saved[0]);
    expect(config.daemon_identity_seal.material).toBe(IDENTITY_SEED.toString('base64url'));
    expect(config.shell).toBe(LOGIN_SHELL);
    expect(config.user_root_public_key).toBe(ROOT_PUBLIC_KEY);
    expect(config.root_epoch).toBe(USER_ROOT_INITIAL_EPOCH);
    expect(config.daemon_binding.daemonIdentityKeyCommitment).toBe(
      request.daemonIdentityKeyCommitment,
    );
    expect(config.revoked_delegations).toEqual([]);
    expect([...generatedSecret]).toEqual(new Array(32).fill(0));
  });

  test('relink preserves the permanent daemon identity and same-lineage tombstones', async () => {
    const existing = existingConfig();
    const requests: DaemonLinkCreateRequest[] = [];
    const saved: DaemonConfig[] = [];
    const dependencies = createDependencies({
      generateDaemonId: () => {
        throw new Error('must preserve daemon id');
      },
      createIdentitySeal: () => {
        throw new Error('must preserve daemon identity');
      },
      loadExistingConfig: () => Effect.succeed(existing),
      createClaim: (_origin, value) => {
        requests.push(value);
        return Promise.resolve(createdClaim());
      },
      pollClaim: () =>
        Promise.resolve(approvedClaim(required(requests[0]), Buffer.from(LINK_SECRET))),
      saveConfig: (config) =>
        Effect.sync(() => {
          saved.push(config);
        }),
    });
    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
    ).toBe(0);
    expect(required(requests[0]).daemonId).toBe(existing.daemon_id);
    expect(required(saved[0]).daemon_identity_seal).toEqual(existing.daemon_identity_seal);
    expect(required(saved[0]).revoked_delegations).toEqual(existing.revoked_delegations);
  });

  test('restores the prior config after a definitive completion conflict', async () => {
    const existing = existingConfig();
    const requests: DaemonLinkCreateRequest[] = [];
    const saved: DaemonConfig[] = [];
    const restored: Array<DaemonConfig | null> = [];
    const dependencies = createDependencies({
      loadExistingConfig: () => Effect.succeed(existing),
      createClaim: (_origin, value) => {
        requests.push(value);
        return Promise.resolve(createdClaim());
      },
      pollClaim: () =>
        Promise.resolve(approvedClaim(required(requests[0]), Buffer.from(LINK_SECRET))),
      saveConfig: (config) =>
        Effect.sync(() => {
          saved.push(config);
        }),
      completeClaim: () =>
        Promise.resolve({ data: null, error: { status: 409, value: { error: 'claim_conflict' } } }),
      restoreConfig: (config) =>
        Effect.sync(() => {
          restored.push(config);
        }),
    });

    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
    ).toBe(1);
    expect(saved).toHaveLength(1);
    expect(restored).toEqual([existing]);
  });

  test('retains the newly saved config when completion transport is ambiguous', async () => {
    const saved: DaemonConfig[] = [];
    let restored = false;
    const dependencies = createDependencies({
      saveConfig: (config) =>
        Effect.sync(() => {
          saved.push(config);
        }),
      completeClaim: () => Promise.reject(new Error('connection reset after request write')),
      restoreConfig: () => {
        restored = true;
        return Effect.void;
      },
    });

    await expect(
      Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
    ).rejects.toThrow('connection reset after request write');
    expect(saved).toHaveLength(1);
    expect(restored).toBe(false);
  });

  test('rejects a coordinator-substituted or invalid approval before persistence', async () => {
    let request: DaemonLinkCreateRequest | null = null;
    let saved = false;
    const dependencies = createDependencies({
      createClaim: (_origin, value) => {
        request = value;
        return Promise.resolve(createdClaim());
      },
      pollClaim: () => {
        const result = approvedClaim(required(request), Buffer.from(LINK_SECRET));
        if (!isApprovedResult(result.data)) throw new Error('approved fixture');
        const mac = result.data.approval.approvalMac;
        return Promise.resolve({
          ...result,
          data: {
            ...result.data,
            approval: {
              ...result.data.approval,
              approvalMac: `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`,
            },
          },
        });
      },
      saveConfig: () => {
        saved = true;
        return Effect.void;
      },
    });
    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
    ).toBe(1);
    expect(saved).toBe(false);
  });
});

const noopLogger: Logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

function createDependencies(
  overrides: Partial<DaemonLinkCommandDependencies> = {},
): DaemonLinkCommandDependencies {
  let request: DaemonLinkCreateRequest | null = null;
  return {
    generateDaemonId: () => 'daemon-1',
    createIdentitySeal: () => Effect.succeed(identityFixture()),
    inspectIdentitySeal: (seal) => Effect.succeed({ ...identityFixture(), seal }),
    repairTpmAccess: () => Effect.succeed(false),
    generateLinkClaimId: () => 'claim-1',
    generateLinkSecret: () => Buffer.from(LINK_SECRET),
    readLinkToken: () => Effect.succeed(CLAIM_TOKEN),
    showApprovalQrCode: () => {},
    loadExistingConfig: () => Effect.succeed(null),
    loadLegacyConfigForMigration: () => Effect.fail(new Error('no legacy config')),
    machineName: () => 'test-machine',
    platformLabel: () => 'test-platform',
    loginShell: () => Effect.succeed(LOGIN_SHELL),
    createClaim: (_origin, value) => {
      request = value;
      return Promise.resolve(createdClaim());
    },
    pollClaim: () => Promise.resolve(approvedClaim(required(request), Buffer.from(LINK_SECRET))),
    completeClaim: () => Promise.resolve({ data: null, error: null }),
    saveConfig: () => Effect.void,
    restoreConfig: () => Effect.void,
    ...overrides,
  };
}

function createdClaim() {
  return {
    data: {
      pollToken: POLL_TOKEN,
      serverNonce: SERVER_NONCE.toString('base64url'),
      expiresAt: Date.now() + 60_000,
      machineUsage: { used: 1, limit: 3 },
      canLink: true,
    },
    error: null,
  } as const;
}

function approvedClaim(request: DaemonLinkCreateRequest, linkSecret: Uint8Array) {
  const binding = createDaemonBinding(
    {
      userId: 'user-1',
      rootKeyCommitment: ROOT_KEY_COMMITMENT,
      daemonId: request.daemonId,
      daemonIdentityKeyCommitment: request.daemonIdentityKeyCommitment,
      serverOrigin: SERVER_ORIGIN,
      linkClaimId: request.linkClaimId,
      issuedAt: 1_800_000_000_000,
    },
    ROOT_KEYS,
    Buffer.alloc(32, 0x22),
  );
  const approval = createDaemonLinkApproval(
    {
      linkClaimId: request.linkClaimId,
      claimCommitment: request.claimCommitment,
      userRootPublicKey: ROOT_PUBLIC_KEY,
      rootEpoch: USER_ROOT_INITIAL_EPOCH,
      daemonBinding: binding,
    },
    SERVER_NONCE,
    linkSecret,
  );
  return {
    data: {
      status: 'approved',
      sessionTokenVerifyKey: SESSION_TOKEN_VERIFY_KEY,
      approval,
    },
    error: null,
  };
}

function existingConfig(): DaemonConfig {
  const keyPair = deriveSessionAuthorizationKeyPair(Buffer.from(IDENTITY_SEED));
  try {
    const commitment = deriveDaemonIdentityKeyCommitment(
      keyPair.verifyKey,
      deriveSoftwareDaemonP256PublicKey(IDENTITY_SEED),
    );
    const binding = createDaemonBinding(
      {
        userId: 'user-1',
        rootKeyCommitment: ROOT_KEY_COMMITMENT,
        daemonId: 'existing-daemon',
        daemonIdentityKeyCommitment: commitment,
        serverOrigin: SERVER_ORIGIN,
        linkClaimId: 'old-claim',
        issuedAt: 1,
      },
      ROOT_KEYS,
      Buffer.alloc(32, 0x33),
    );
    return {
      daemon_id: 'existing-daemon',
      server_origin: SERVER_ORIGIN,
      daemon_identity_seal: identityFixture().seal,
      shell: '/bin/zsh',
      webtransport_port: 44_433,
      session_token_verify_key: SESSION_TOKEN_VERIFY_KEY,
      user_root_public_key: ROOT_PUBLIC_KEY,
      root_epoch: USER_ROOT_INITIAL_EPOCH,
      daemon_binding: binding,
      revoked_delegations: [{ delegationId: 'revoked-delegation', expiresAt: 1_900_000_000_000 }],
    };
  } finally {
    keyPair.signingKey.free();
  }
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('expected value');
  return value;
}

function isApprovedResult(value: unknown): value is { approval: { approvalMac: string } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'approval' in value &&
    typeof value.approval === 'object' &&
    value.approval !== null &&
    'approvalMac' in value.approval &&
    typeof value.approval.approvalMac === 'string'
  );
}

function identityFixture() {
  const keys = deriveSessionAuthorizationKeyPair(IDENTITY_SEED);
  try {
    return {
      seal: { backend: 'software' as const, material: IDENTITY_SEED.toString('base64url') },
      publicKey: Buffer.from(keys.verifyKey).toString('base64url'),
      p256PublicKey: Buffer.from(deriveSoftwareDaemonP256PublicKey(IDENTITY_SEED)).toString(
        'base64url',
      ),
    };
  } finally {
    keys.signingKey.free();
  }
}

describe('identity custody selection', () => {
  test('an unavailable chip and a declined access repair never select software implicitly', async () => {
    for (const code of ['hardware_unavailable', 'tpm_access_denied'] as const) {
      const attempts: boolean[] = [];
      let repairs = 0;
      const dependencies = createDependencies({
        createIdentitySeal: ({ forceSoftware }) => {
          attempts.push(forceSoftware);
          return Effect.fail(new IdentitySealError({ code }));
        },
        repairTpmAccess: () => {
          repairs += 1;
          return Effect.succeed(false);
        },
        createClaim: () => {
          throw new Error('must refuse before enrollment');
        },
      });
      expect(
        await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
      ).toBe(1);
      expect(attempts).toEqual([false]);
      expect(repairs).toBe(code === 'tpm_access_denied' ? 1 : 0);
    }
  });

  test('successful access repair retries hardware once', async () => {
    let attempts = 0;
    const dependencies = createDependencies({
      createIdentitySeal: ({ forceSoftware }) => {
        expect(forceSoftware).toBe(false);
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new IdentitySealError({ code: 'tpm_access_denied' }))
          : Effect.succeed(identityFixture());
      },
      repairTpmAccess: () => Effect.succeed(true),
    });
    expect(
      await Effect.runPromise(runLinkCommandEffect([SERVER_ORIGIN], noopLogger, dependencies)),
    ).toBe(0);
    expect(attempts).toBe(2);
  });

  test('explicit software choice is forwarded and identity replacement does not inspect lost material', async () => {
    let created = false;
    const dependencies = createDependencies({
      loadExistingConfig: () => Effect.succeed(existingConfig()),
      inspectIdentitySeal: () => {
        throw new Error('lost identity must not be opened');
      },
      createIdentitySeal: ({ forceSoftware }) => {
        expect(forceSoftware).toBe(true);
        created = true;
        return Effect.succeed(identityFixture());
      },
    });
    expect(
      await Effect.runPromise(
        runLinkCommandEffect(
          [SERVER_ORIGIN, '--replace-identity', '--identity-backend', 'software'],
          noopLogger,
          dependencies,
        ),
      ),
    ).toBe(0);
    expect(created).toBe(true);
  });
});
