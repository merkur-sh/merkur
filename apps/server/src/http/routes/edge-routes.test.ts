import { describe, expect, test } from 'bun:test';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import { Effect, Layer, Redacted } from 'effect';
import { Elysia } from 'elysia';

import { type ServerConfig, ServerConfigService } from '../../config';
import { createLogger } from '../../logger';
import type { runServerProgram } from '../../runtime';
import {
  type EdgeRegistration,
  EdgeRegistrationConflictError,
  EdgeRegistrationReplayError,
  type EdgeRegistryService,
  EdgeRegistryServiceTag,
} from '../../services/edge-registry-service';
import { RateLimitServiceTag } from '../../services/rate-limit-service';
import { RedisError } from '../../services/redis-service';
import { apiErrorPlugin } from '../api-errors';
import {
  computeEdgeRegistrationAuthentication,
  EDGE_AUTH_HEADER,
  EDGE_ID_HEADER,
  EDGE_NONCE_HEADER,
  EDGE_REGISTRATION_METHOD,
  EDGE_REGISTRATION_PATH,
  EDGE_TIMESTAMP_HEADER,
  type EdgeRegistrationPayload,
} from '../edge-registration-auth';
import { edgeRoutesPlugin } from './edge-routes';

// A valid base64 SHA-256 digest (32 bytes).
const VALID_CERT_HASH = 'Qr4ZuCBq6NiQejuKBH9LF4gS6GICM00rGduNd31OVXw=';
// base64 of 31 bytes — not a 32-byte digest.
const SHORT_CERT_HASH = Buffer.alloc(31, 1).toString('base64');
const EDGE_ID = 'iad-1';
const EDGE_KEY = new Uint8Array(64).fill(0x41);
const SECOND_EDGE_KEY = new Uint8Array(64).fill(0x42);
const DEFAULT_NONCE = new Uint8Array(32).fill(0x23);

interface RegistryOverrides {
  readonly edgeRegistrations?: readonly EdgeRegistration[];
  readonly conflictingUrls?: readonly string[];
  readonly nonceClaimFailure?: boolean;
}

function createFakeRegistry(overrides: RegistryOverrides): {
  readonly service: EdgeRegistryService;
  readonly registrations: EdgeRegistration[];
} {
  const registrations: EdgeRegistration[] = [];
  const claimedNonces = new Set<string>();
  const service: EdgeRegistryService = {
    claimRegistrationNonce: (edgeId, nonce) => {
      if (overrides.nonceClaimFailure === true) {
        return Effect.fail(
          new RedisError({ cause: new Error('unavailable'), message: 'Redis unavailable' }),
        );
      }
      const claim = `${edgeId}:${nonce}`;
      if (claimedNonces.has(claim)) {
        return Effect.fail(new EdgeRegistrationReplayError({ edgeId }));
      }
      return Effect.sync(() => {
        claimedNonces.add(claim);
      });
    },
    registerEdge: (registration) =>
      overrides.conflictingUrls?.includes(registration.edgeWtUrl) === true
        ? Effect.fail(
            new EdgeRegistrationConflictError({
              edgeId: registration.edgeId,
              edgeWtUrl: registration.edgeWtUrl,
            }),
          )
        : Effect.sync(() => {
            registrations.push(registration);
          }),
    listHealthyEdges: () => Effect.succeed([...(overrides.edgeRegistrations ?? [])]),
  };
  return { service, registrations };
}

function createFakeConfig(): ServerConfig {
  return {
    host: '0.0.0.0',
    port: 3000,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: Redacted.make('redis://localhost:6379'),
    publicOrigin: 'https://localhost:3000',
    website: undefined,
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur',
    jwtAudience: 'merkur-clients',
    tokenHmacSecret: Redacted.make('secret'),
    authAllowRegistration: true,
    authIdentity: 'username',
    emailDelivery: undefined,
    opaqueServerSetup: Redacted.make(Buffer.alloc(128).toString('base64url')),
    opaqueServerPublicKey: Buffer.alloc(32).toString('base64url'),
    trustedProxyHops: 1,
    sessionTokenSigningKey: deriveSessionAuthorizationKeyPair(new Uint8Array(32)).signingKey,
    sessionTokenVerifyKeyB64: 'A'.repeat(3_456),
    sessionTokenTtlMs: 60_000,
    webPush: undefined,
    edgeRegistrationKeys: new Map([
      [EDGE_ID, EDGE_KEY],
      ['iad-2', SECOND_EDGE_KEY],
    ]),
    telemetry: undefined,
    traceLevel: 'Info',
    traceSampleRatio: 1,
    traceSlowThresholdMs: 1_000,
    boxHost: undefined,
    stunTicketKey: new Uint8Array(64),
    edgeAttachTicketKey: new Uint8Array(64).fill(11),
    stunServers: ['stun.test:3478', 'stun.test:3479'],
    boxHostStunObservers: [],
  };
}

function makeRunServerProgram(
  config: ServerConfig,
  registry: EdgeRegistryService,
): typeof runServerProgram {
  const layer = Layer.mergeAll(
    Layer.succeed(ServerConfigService, config),
    Layer.succeed(EdgeRegistryServiceTag, registry),
    Layer.succeed(RateLimitServiceTag, {
      consume: () => Effect.succeed({ allowed: true as const }),
    }),
  );
  return ((program) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
    )) as typeof runServerProgram;
}

function buildApp(input: { readonly registry: EdgeRegistryService }) {
  // `apiErrorPlugin` is mounted here for the same reason the real server mounts
  // it first: schema violations are production-shaped 400 responses.
  return new Elysia().use(apiErrorPlugin).use(
    edgeRoutesPlugin({
      runServerProgram: makeRunServerProgram(createFakeConfig(), input.registry),
      logger: createLogger('test'),
      trustedProxyHops: 1,
    }),
  );
}

function defaultBody(): EdgeRegistrationPayload {
  return {
    edgeId: EDGE_ID,
    edgeRegion: 'iad',
    edgeWtUrl: 'https://iad-1.edge.example:4433/',
    certHash: VALID_CERT_HASH,
    certHashes: [VALID_CERT_HASH],
  };
}

function postRegister(
  app: ReturnType<typeof buildApp>,
  options: {
    readonly body?: Record<string, unknown>;
    readonly key?: Uint8Array;
    readonly edgeId?: string;
    readonly timestamp?: string;
    readonly nonce?: Uint8Array;
    readonly omitAuthentication?: boolean;
    readonly path?: string;
  } = {},
): Promise<Response> {
  const body = options.body ?? defaultBody();
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? DEFAULT_NONCE;
  const edgeId = options.edgeId ?? EDGE_ID;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!options.omitAuthentication && isEdgeRegistrationPayload(body)) {
    headers[EDGE_ID_HEADER] = edgeId;
    headers[EDGE_TIMESTAMP_HEADER] = timestamp;
    headers[EDGE_NONCE_HEADER] = Buffer.from(nonce).toString('base64url');
    headers[EDGE_AUTH_HEADER] = computeEdgeRegistrationAuthentication({
      key: options.key ?? EDGE_KEY,
      edgeId,
      method: EDGE_REGISTRATION_METHOD,
      path: EDGE_REGISTRATION_PATH,
      timestamp,
      nonce,
      payload: body,
    }).toString('base64url');
  }
  return app.handle(
    new Request(`https://merkur.example${options.path ?? EDGE_REGISTRATION_PATH}`, {
      method: EDGE_REGISTRATION_METHOD,
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe('edge-routes POST /api/edge/register auth + store', () => {
  test('registers complete edge coordinates with per-edge request authentication', async () => {
    const registry = createFakeRegistry({});
    const response = await postRegister(buildApp({ registry: registry.service }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(registry.registrations).toHaveLength(1);
  });

  test('stores a canonical region registration with the served and the next hash', async () => {
    const nextHash = Buffer.alloc(32, 2).toString('base64');
    const registry = createFakeRegistry({});
    const response = await postRegister(buildApp({ registry: registry.service }), {
      nonce: new Uint8Array(32).fill(0x24),
      body: {
        ...defaultBody(),
        certHashes: [VALID_CERT_HASH, nextHash],
      },
    });

    expect(response.status).toBe(200);
    expect(registry.registrations[0]).toMatchObject({
      edgeId: EDGE_ID,
      edgeRegion: 'iad',
      edgeWtUrl: 'https://iad-1.edge.example:4433/',
      activeCertHash: VALID_CERT_HASH,
      certHashes: [VALID_CERT_HASH, nextHash],
    });
  });

  test('rejects a partial edge registration before invoking the route', async () => {
    const registry = createFakeRegistry({});
    const response = await postRegister(buildApp({ registry: registry.service }), {
      body: { edgeId: EDGE_ID, edgeRegion: 'iad', certHash: VALID_CERT_HASH },
    });

    expect(response.status).toBe(400);
    expect(registry.registrations).toEqual([]);
  });

  test('rejects a public URL already owned by another replica', async () => {
    const edgeWtUrl = 'https://iad-2.edge.example:4433/';
    const registry = createFakeRegistry({ conflictingUrls: [edgeWtUrl] });
    const response = await postRegister(buildApp({ registry: registry.service }), {
      edgeId: 'iad-2',
      key: SECOND_EDGE_KEY,
      nonce: new Uint8Array(32).fill(0x25),
      body: { ...defaultBody(), edgeId: 'iad-2', edgeWtUrl },
    });

    expect(response.status).toBe(409);
    expect(registry.registrations).toEqual([]);
  });

  test('rejects an authentication tag made with another edge key', async () => {
    const registry = createFakeRegistry({});
    const response = await postRegister(buildApp({ registry: registry.service }), {
      key: SECOND_EDGE_KEY,
    });

    expect(response.status).toBe(401);
    expect(registry.registrations).toEqual([]);
  });

  test('rejects missing authentication headers', async () => {
    const registry = createFakeRegistry({});
    const response = await postRegister(buildApp({ registry: registry.service }), {
      omitAuthentication: true,
    });

    expect(response.status).toBe(401);
    expect(registry.registrations).toEqual([]);
  });

  test('rejects a stale timestamp and a query outside the authenticated path', async () => {
    const staleRegistry = createFakeRegistry({});
    const stale = await postRegister(buildApp({ registry: staleRegistry.service }), {
      timestamp: String(Date.now() - 60_001),
    });
    expect(stale.status).toBe(401);

    const queryRegistry = createFakeRegistry({});
    const query = await postRegister(buildApp({ registry: queryRegistry.service }), {
      path: `${EDGE_REGISTRATION_PATH}?ignored=1`,
    });
    expect(query.status).toBe(401);
  });

  test('rejects replay of an authenticated nonce', async () => {
    const registry = createFakeRegistry({});
    const app = buildApp({ registry: registry.service });
    expect((await postRegister(app)).status).toBe(200);
    expect((await postRegister(app)).status).toBe(401);
    expect(registry.registrations).toHaveLength(1);
  });

  test('fails closed when the durable replay fence is unavailable', async () => {
    const registry = createFakeRegistry({ nonceClaimFailure: true });
    const response = await postRegister(buildApp({ registry: registry.service }));

    expect(response.status).toBe(500);
    expect(registry.registrations).toEqual([]);
  });

  test('prevents an edge-A key from substituting edge B in the body', async () => {
    const registry = createFakeRegistry({});
    const edgeMismatch = await postRegister(buildApp({ registry: registry.service }), {
      body: {
        ...defaultBody(),
        edgeId: 'iad-2',
        edgeWtUrl: 'https://iad-2.edge.example:4433/',
      },
    });
    expect(edgeMismatch.status).toBe(401);

    const signed = defaultBody();
    const timestamp = String(Date.now());
    const nonce = new Uint8Array(32).fill(0x26);
    const tag = computeEdgeRegistrationAuthentication({
      key: EDGE_KEY,
      edgeId: EDGE_ID,
      method: EDGE_REGISTRATION_METHOD,
      path: EDGE_REGISTRATION_PATH,
      timestamp,
      nonce,
      payload: signed,
    }).toString('base64url');
    const tampered = { ...signed, edgeRegion: 'fra' };
    const response = await buildApp({ registry: registry.service }).handle(
      new Request(`https://merkur.example${EDGE_REGISTRATION_PATH}`, {
        method: EDGE_REGISTRATION_METHOD,
        headers: {
          'content-type': 'application/json',
          [EDGE_ID_HEADER]: EDGE_ID,
          [EDGE_TIMESTAMP_HEADER]: timestamp,
          [EDGE_NONCE_HEADER]: Buffer.from(nonce).toString('base64url'),
          [EDGE_AUTH_HEADER]: tag,
        },
        body: JSON.stringify(tampered),
      }),
    );
    expect(response.status).toBe(401);
    expect(registry.registrations).toEqual([]);
  });

  test('rejects authenticated but noncanonical registration data with 400', async () => {
    const registry = createFakeRegistry({});
    const shortHash = await postRegister(buildApp({ registry: registry.service }), {
      nonce: new Uint8Array(32).fill(0x27),
      body: {
        ...defaultBody(),
        certHash: SHORT_CERT_HASH,
        certHashes: [SHORT_CERT_HASH],
      },
    });
    expect(shortHash.status).toBe(400);

    const noncanonicalUrl = await postRegister(buildApp({ registry: registry.service }), {
      nonce: new Uint8Array(32).fill(0x28),
      body: { ...defaultBody(), edgeWtUrl: 'https://iad-1.edge.example:4433' },
    });
    expect(noncanonicalUrl.status).toBe(400);
    expect(registry.registrations).toEqual([]);
  });
});

function isEdgeRegistrationPayload(value: unknown): value is EdgeRegistrationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.edgeId === 'string' &&
    typeof record.edgeRegion === 'string' &&
    typeof record.edgeWtUrl === 'string' &&
    typeof record.certHash === 'string' &&
    Array.isArray(record.certHashes) &&
    record.certHashes.every((hash) => typeof hash === 'string')
  );
}
