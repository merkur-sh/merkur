import { normalizeEdgeWebTransportUrl } from '@merkur/shared';
import { Clock, Context, Data, Effect, Layer } from 'effect';

import {
  parseRedisFlag,
  parseRedisNullableStringArray,
  parseRedisSetNxResult,
  parseRedisStringArray,
} from './redis-reply';
import { defineRedisScript } from './redis-script';
import {
  evalRedisScript,
  preloadRedisScripts,
  type RedisError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';

const EDGE_HEALTH_TTL_MS = 90_000;
const EDGE_REGISTRATION_INDEX_KEY = 'merkur:edge:registrations';
const EDGE_REGISTRATION_KEY_PREFIX = 'merkur:edge:registration:';
const EDGE_REGISTRATION_REPLAY_KEY_PREFIX = 'merkur:edge:registration-replay:';
const EDGE_URL_OWNER_KEY_PREFIX = 'merkur:edge:url-owner:';
const EDGE_ID_OWNER_KEY_PREFIX = 'merkur:edge:id-owner:';
// The request timestamp accepts at most 60 seconds of skew in either direction.
// Keep a successful nonce claim beyond that entire validity interval.
const EDGE_REGISTRATION_REPLAY_TTL_MS = 121_000;
const EDGE_CERT_HASH_BYTES = 32;
const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EDGE_REGISTRATION_FIELDS = new Set([
  'edgeId',
  'edgeRegion',
  'edgeWtUrl',
  'activeCertHash',
  'certHashes',
  'updatedAt',
]);

const CLAIM_EDGE_IDENTITY_SCRIPT = defineRedisScript(
  'claim-edge-identity',
  `
local url_owner = redis.call('GET', KEYS[1])
local id_url = redis.call('GET', KEYS[2])
if (not url_owner or url_owner == ARGV[1]) and (not id_url or id_url == ARGV[2]) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`,
);

const STORE_EDGE_REGISTRATION_SCRIPT = defineRedisScript(
  'store-edge-registration',
  `
local current_score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if current_score and tonumber(current_score) > tonumber(ARGV[3]) then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[4])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`,
);

const PRUNE_AND_LIST_HEALTHY_EDGE_IDS_SCRIPT = defineRedisScript(
  'prune-and-list-healthy-edge-ids',
  `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '0', ARGV[1])
return redis.call('ZREVRANGE', KEYS[1], '0', '-1')
`,
);
const EDGE_REGISTRY_SCRIPTS = [
  CLAIM_EDGE_IDENTITY_SCRIPT,
  STORE_EDGE_REGISTRATION_SCRIPT,
  PRUNE_AND_LIST_HEALTHY_EDGE_IDS_SCRIPT,
] as const;

export interface EdgeRegistration {
  readonly edgeId: string;
  readonly edgeRegion: string;
  readonly edgeWtUrl: string;
  readonly activeCertHash: string;
  /** What peers pin: the served certificate's hash, then the next one's. */
  readonly certHashes: readonly string[];
  readonly updatedAt: number;
}

export class EdgeRegistrationConflictError extends Data.TaggedError(
  'EdgeRegistrationConflictError',
)<{
  readonly edgeId: string;
  readonly edgeWtUrl: string;
}> {}

export class EdgeRegistrationValidationError extends Data.TaggedError(
  'EdgeRegistrationValidationError',
)<{
  readonly edgeId: string;
}> {}

export class EdgeRegistrationReplayError extends Data.TaggedError('EdgeRegistrationReplayError')<{
  readonly edgeId: string;
}> {}

export interface EdgeRegistryService {
  claimRegistrationNonce(
    edgeId: string,
    nonce: string,
  ): Effect.Effect<void, RedisError | EdgeRegistrationReplayError>;
  registerEdge(
    registration: EdgeRegistration,
  ): Effect.Effect<
    void,
    RedisError | EdgeRegistrationConflictError | EdgeRegistrationValidationError
  >;
  listHealthyEdges(): Effect.Effect<EdgeRegistration[], RedisError>;
}

export class EdgeRegistryServiceTag extends Context.Service<
  EdgeRegistryServiceTag,
  EdgeRegistryService
>()('EdgeRegistryService') {}

export const EdgeRegistryServiceLive = Layer.effect(
  EdgeRegistryServiceTag,
  Effect.gen(function* () {
    const redis = yield* RedisServiceTag;
    yield* preloadRedisScripts(redis, EDGE_REGISTRY_SCRIPTS);
    return createEdgeRegistryService(redis);
  }),
);

function createEdgeRegistryService(redis: RedisService): EdgeRegistryService {
  return {
    claimRegistrationNonce(
      edgeId,
      nonce,
    ): Effect.Effect<void, RedisError | EdgeRegistrationReplayError> {
      return Effect.gen(function* () {
        const claimed = yield* redis.useCommands(async (commands) =>
          parseRedisSetNxResult(
            await commands.sendCommand([
              'SET',
              edgeRegistrationReplayKey(edgeId, nonce),
              '1',
              'NX',
              'PX',
              String(EDGE_REGISTRATION_REPLAY_TTL_MS),
            ]),
            'edge registration replay claim result',
          ),
        );
        if (!claimed) {
          return yield* new EdgeRegistrationReplayError({ edgeId });
        }
      });
    },

    registerEdge(
      registration,
    ): Effect.Effect<
      void,
      RedisError | EdgeRegistrationConflictError | EdgeRegistrationValidationError
    > {
      return Effect.gen(function* () {
        const edgeId = registration.edgeId;
        if (!isCurrentEdgeRegistration(registration)) {
          return yield* new EdgeRegistrationValidationError({ edgeId });
        }
        const claimed = yield* redis.useCommands(async (commands) => {
          const claimed = await evalRedisScript(
            commands,
            CLAIM_EDGE_IDENTITY_SCRIPT,
            [edgeUrlOwnerKey(registration.edgeWtUrl), edgeIdOwnerKey(registration.edgeId)],
            [registration.edgeId, registration.edgeWtUrl, String(EDGE_HEALTH_TTL_MS)],
          );
          return parseRedisFlag(claimed, 'edge identity claim result');
        });
        if (!claimed) {
          return yield* new EdgeRegistrationConflictError({
            edgeId: registration.edgeId,
            edgeWtUrl: registration.edgeWtUrl,
          });
        }
        yield* storeEdgeRegistration(redis, registration);
      });
    },

    listHealthyEdges(): Effect.Effect<EdgeRegistration[], RedisError> {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* redis.useCommands(async (commands) => {
          const rawIds = await evalRedisScript(
            commands,
            PRUNE_AND_LIST_HEALTHY_EDGE_IDS_SCRIPT,
            [EDGE_REGISTRATION_INDEX_KEY],
            [String(now - EDGE_HEALTH_TTL_MS)],
          );
          const ids = parseRedisStringArray(rawIds, 'healthy edge identity list');
          if (ids.length === 0) return [];
          const values = parseRedisNullableStringArray(
            await commands.sendCommand([
              'MGET',
              ...ids.map((edgeId) => edgeRegistrationKey(edgeId)),
            ]),
            ids.length,
            'healthy edge registrations',
          );
          const registrations: EdgeRegistration[] = [];
          for (const [index, value] of values.entries()) {
            const registration = parseEdgeRegistration(value);
            if (registration !== null && registration.edgeId === ids[index]) {
              registrations.push(registration);
            }
          }
          return registrations;
        });
      });
    },
  };
}

function storeEdgeRegistration(
  redis: RedisService,
  registration: EdgeRegistration,
): Effect.Effect<void, RedisError> {
  return redis.useCommands(async (commands) => {
    parseRedisFlag(
      await evalRedisScript(
        commands,
        STORE_EDGE_REGISTRATION_SCRIPT,
        [EDGE_REGISTRATION_INDEX_KEY, edgeRegistrationKey(registration.edgeId)],
        [
          registration.edgeId,
          JSON.stringify(registration),
          String(registration.updatedAt),
          String(EDGE_HEALTH_TTL_MS),
        ],
      ),
      'edge registration store result',
    );
  });
}

function parseEdgeRegistration(value: unknown): EdgeRegistration | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!isCurrentEdgeRegistration(record)) return null;
  return {
    edgeId: record.edgeId,
    edgeRegion: record.edgeRegion,
    edgeWtUrl: record.edgeWtUrl,
    activeCertHash: record.activeCertHash,
    certHashes: record.certHashes,
    updatedAt: record.updatedAt,
  };
}

export function isCurrentEdgeRegistration(value: unknown): value is EdgeRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const canonicalUrl =
    typeof record.edgeWtUrl === 'string' ? normalizeEdgeWebTransportUrl(record.edgeWtUrl) : null;
  return (
    Object.keys(record).length === EDGE_REGISTRATION_FIELDS.size &&
    Object.keys(record).every((field) => EDGE_REGISTRATION_FIELDS.has(field)) &&
    typeof record.edgeId === 'string' &&
    EDGE_ID_PATTERN.test(record.edgeId) &&
    typeof record.edgeRegion === 'string' &&
    EDGE_ID_PATTERN.test(record.edgeRegion) &&
    canonicalUrl !== null &&
    canonicalUrl === record.edgeWtUrl &&
    typeof record.activeCertHash === 'string' &&
    isCanonicalEdgeCertificateHash(record.activeCertHash) &&
    Array.isArray(record.certHashes) &&
    record.certHashes.length >= 1 &&
    record.certHashes.length <= 2 &&
    record.certHashes.every(isCanonicalEdgeCertificateHash) &&
    record.certHashes.includes(record.activeCertHash) &&
    new Set(record.certHashes).size === record.certHashes.length &&
    typeof record.updatedAt === 'number' &&
    Number.isSafeInteger(record.updatedAt) &&
    record.updatedAt > 0
  );
}

export function isCanonicalEdgeCertificateHash(value: string): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return false;
  }
  return decoded.byteLength === EDGE_CERT_HASH_BYTES && decoded.toString('base64') === value;
}

function edgeRegistrationKey(edgeId: string): string {
  return `${EDGE_REGISTRATION_KEY_PREFIX}${edgeId}`;
}

function edgeRegistrationReplayKey(edgeId: string, nonce: string): string {
  return `${EDGE_REGISTRATION_REPLAY_KEY_PREFIX}${edgeId}:${nonce}`;
}

function edgeUrlOwnerKey(edgeWtUrl: string): string {
  const digest = Bun.CryptoHasher.hash('sha256', edgeWtUrl, 'hex');
  return `${EDGE_URL_OWNER_KEY_PREFIX}${digest}`;
}

function edgeIdOwnerKey(edgeId: string): string {
  return `${EDGE_ID_OWNER_KEY_PREFIX}${edgeId}`;
}
