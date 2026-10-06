import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Effect, Layer } from 'effect';

import {
  type EdgeRegistration,
  EdgeRegistrationConflictError,
  EdgeRegistrationReplayError,
  EdgeRegistrationValidationError,
  type EdgeRegistryService,
  EdgeRegistryServiceLive,
  EdgeRegistryServiceTag,
} from './edge-registry-service';
import {
  type RedisCommandClient,
  RedisError,
  type RedisService,
  RedisServiceTag,
} from './redis-service';

describe('EdgeRegistryService', () => {
  test('claims each authenticated nonce once with a bounded SET NX PX fence', async () => {
    const redis = createFakeRedisService();
    const nonce = Buffer.alloc(32, 0x33).toString('base64url');
    const replay = await Effect.runPromise(
      Effect.flip(
        runWithRegistryEffect(redis.service, (registry) =>
          Effect.gen(function* () {
            yield* registry.claimRegistrationNonce('iad-1', nonce);
            yield* registry.claimRegistrationNonce('iad-1', nonce);
          }),
        ),
      ),
    );

    expect(replay).toBeInstanceOf(EdgeRegistrationReplayError);
    expect(redis.commandCalls[0]).toEqual([
      'SET',
      `merkur:edge:registration-replay:iad-1:${nonce}`,
      '1',
      'NX',
      'PX',
      '121000',
    ]);
  });

  test('registers multiple instance-specific URLs and lists both replicas', async () => {
    const redis = createFakeRedisService();
    await runWithRegistry(redis.service, (registry) =>
      Effect.gen(function* () {
        yield* registry.registerEdge(registration('iad-1', 'iad', 'https://iad-1.example:4433/'));
        yield* registry.registerEdge(registration('iad-2', 'iad', 'https://iad-2.example:4433/'));

        const commandsBeforeList = redis.commandNames.length;
        const callsBeforeList = redis.commandCalls.length;
        const edges = yield* registry.listHealthyEdges();
        expect(edges.map((edge) => edge.edgeId).sort()).toEqual(['iad-1', 'iad-2']);
        expect(redis.commandNames.slice(commandsBeforeList)).toEqual(['EVAL', 'MGET']);
        const [listCommand, valuesCommand] = redis.commandCalls.slice(callsBeforeList);
        expect(listCommand?.slice(2, 4)).toEqual(['1', 'merkur:edge:registrations']);
        expect(listCommand?.[1]).not.toContain("redis.call('GET'");
        expect(valuesCommand).toEqual([
          'MGET',
          'merkur:edge:registration:iad-2',
          'merkur:edge:registration:iad-1',
        ]);
      }),
    );
  });

  test('rejects two replica ids that advertise the same public URL', async () => {
    const redis = createFakeRedisService();
    const error = await Effect.runPromise(
      Effect.flip(
        runWithRegistryEffect(redis.service, (registry) =>
          Effect.gen(function* () {
            yield* registry.registerEdge(registration('iad-1', 'iad', 'https://iad.example:4433/'));
            yield* registry.registerEdge(registration('iad-2', 'iad', 'https://iad.example:4433/'));
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(EdgeRegistrationConflictError);
  });

  test('rejects two public URLs that reuse one live replica id', async () => {
    const redis = createFakeRedisService();
    const error = await Effect.runPromise(
      Effect.flip(
        runWithRegistryEffect(redis.service, (registry) =>
          Effect.gen(function* () {
            yield* registry.registerEdge(
              registration('iad-1', 'iad', 'https://iad-1.example:4433/'),
            );
            yield* registry.registerEdge(
              registration('iad-1', 'iad', 'https://iad-2.example:4433/'),
            );
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(EdgeRegistrationConflictError);
  });

  test('allows one replica id to renew ownership of its URL', async () => {
    const redis = createFakeRedisService();
    await runWithRegistry(redis.service, (registry) =>
      Effect.gen(function* () {
        const edge = registration('iad-1', 'iad', 'https://iad.example:4433/');
        yield* registry.registerEdge(edge);
        yield* registry.registerEdge({ ...edge, updatedAt: edge.updatedAt + 1 });
        expect(yield* registry.listHealthyEdges()).toHaveLength(1);
      }),
    );
  });

  test('does not let an older registration overwrite newer edge state', async () => {
    const redis = createFakeRedisService();
    await runWithRegistry(redis.service, (registry) =>
      Effect.gen(function* () {
        const now = Date.now();
        const base = registration('iad-1', 'iad', 'https://iad.example:4433/');
        yield* registry.registerEdge({
          ...base,
          activeCertHash: certHash('new'),
          certHashes: [certHash('new')],
          updatedAt: now,
        });
        yield* registry.registerEdge({
          ...base,
          activeCertHash: certHash('old'),
          certHashes: [certHash('old')],
          updatedAt: now - 1,
        });

        const [edge] = yield* registry.listHealthyEdges();
        expect(edge?.activeCertHash).toBe(certHash('new'));
        expect(edge?.updatedAt).toBe(now);
      }),
    );
  });

  test('atomically prunes stale registrations while returning live replicas', async () => {
    const redis = createFakeRedisService();
    await runWithRegistry(redis.service, (registry) =>
      Effect.gen(function* () {
        const now = Date.now();
        yield* registry.registerEdge({
          ...registration('stale-1', 'iad', 'https://stale.example:4433/'),
          updatedAt: now - 90_001,
        });
        yield* registry.registerEdge({
          ...registration('live-1', 'iad', 'https://live.example:4433/'),
          updatedAt: now,
        });

        const commandsBeforeList = redis.commandNames.length;
        const edges = yield* registry.listHealthyEdges();
        expect(edges.map((edge) => edge.edgeId)).toEqual(['live-1']);
        expect(redis.commandNames.slice(commandsBeforeList)).toEqual(['EVAL', 'MGET']);
      }),
    );
  });

  test('ignores a missing registration value without racing a concurrent refresh', async () => {
    const redis = createFakeRedisService();
    await runWithRegistry(redis.service, (registry) =>
      Effect.gen(function* () {
        yield* registry.registerEdge(
          registration('expired-key', 'iad', 'https://expired.example:4433/'),
        );
        yield* registry.registerEdge(registration('live-1', 'iad', 'https://live.example:4433/'));
        redis.expireRegistration('expired-key');

        const edges = yield* registry.listHealthyEdges();

        expect(edges.map((edge) => edge.edgeId)).toEqual(['live-1']);
        expect(redis.indexedEdgeIds()).toEqual(['expired-key', 'live-1']);
      }),
    );
  });

  test('rejects malformed registrations at the service boundary', async () => {
    const redis = createFakeRedisService();
    const error = await Effect.runPromise(
      Effect.flip(
        runWithRegistryEffect(redis.service, (registry) =>
          registry.registerEdge({
            ...registration('iad-1', 'iad', 'https://iad.example:4433/'),
            activeCertHash: 'not-a-hash',
            certHashes: ['not-a-hash'],
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(EdgeRegistrationValidationError);
    expect(redis.commandNames).toEqual([]);
  });

  test('rejects coercible but malformed Redis identity-claim replies', async () => {
    for (const reply of [true, [1], ' 1', '01', null]) {
      const redis = createFakeRedisService(reply);
      const error = await Effect.runPromise(
        Effect.flip(
          runWithRegistryEffect(redis.service, (registry) =>
            registry.registerEdge(registration('iad-1', 'iad', 'https://iad.example:4433/')),
          ),
        ),
      );

      expect(error).toBeInstanceOf(RedisError);
      expect(redis.commandNames).toEqual(['EVAL']);
    }
  });
});

function registration(edgeId: string, edgeRegion: string, edgeWtUrl: string): EdgeRegistration {
  return {
    edgeId,
    edgeRegion,
    edgeWtUrl,
    activeCertHash: certHash(edgeId),
    certHashes: [certHash(edgeId)],
    updatedAt: Date.now(),
  };
}

function certHash(seed: string): string {
  return createHash('sha256').update(seed).digest('base64');
}

function runWithRegistry<A>(
  redis: RedisService,
  use: (
    registry: EdgeRegistryService,
  ) => Effect.Effect<
    A,
    | RedisError
    | EdgeRegistrationConflictError
    | EdgeRegistrationReplayError
    | EdgeRegistrationValidationError
  >,
): Promise<A> {
  return Effect.runPromise(runWithRegistryEffect(redis, use));
}

function runWithRegistryEffect<A, E>(
  redis: RedisService,
  use: (registry: EdgeRegistryService) => Effect.Effect<A, E>,
): Effect.Effect<A, E | RedisError> {
  const redisLayer = Layer.succeed(RedisServiceTag, redis);
  const registryLayer = EdgeRegistryServiceLive.pipe(Layer.provide(redisLayer));
  return Effect.gen(function* () {
    const registry = yield* EdgeRegistryServiceTag;
    return yield* use(registry);
  }).pipe(Effect.provide(registryLayer));
}

function createFakeRedisService(identityClaimReply?: unknown): {
  readonly service: RedisService;
  readonly commandNames: string[];
  readonly commandCalls: readonly string[][];
  expireRegistration(edgeId: string): void;
  indexedEdgeIds(): string[];
} {
  const commandNames: string[] = [];
  const commandCalls: string[][] = [];
  const commands = new FakeRedisCommandClient(commandNames, commandCalls, identityClaimReply);
  return {
    commandNames,
    commandCalls,
    expireRegistration: (edgeId) => commands.expireRegistration(edgeId),
    indexedEdgeIds: () => commands.indexedEdgeIds(),
    service: {
      useCommands<T>(use: (client: RedisCommandClient) => T | PromiseLike<T>) {
        return Effect.tryPromise({
          try: async () => await use(commands),
          catch: (cause) => new RedisError({ cause, message: 'fake redis command failed' }),
        });
      },
      publish: () => Effect.void,
      subscribe: () => Effect.void,
      unsubscribe: () => Effect.void,
      healthSnapshot: () =>
        Effect.succeed({
          commandsReady: true,
          publisherReady: true,
          subscriberReady: true,
        }),
    },
  };
}

class FakeRedisCommandClient implements RedisCommandClient {
  private readonly strings = new Map<string, string>();
  private readonly zsets = new Map<string, Map<string, number>>();

  constructor(
    private readonly commandNames: string[],
    private readonly commandCalls: string[][],
    private readonly identityClaimReply?: unknown,
  ) {}

  expireRegistration(edgeId: string): void {
    this.strings.delete(`merkur:edge:registration:${edgeId}`);
  }

  indexedEdgeIds(): string[] {
    return [...(this.zsets.get('merkur:edge:registrations')?.keys() ?? [])].sort();
  }

  async sendCommand<T = unknown>(args: string[]): Promise<T> {
    return this.execute(args) as T;
  }

  private execute(args: string[]): unknown {
    const command = requiredArg(args, 0).toUpperCase();
    this.commandNames.push(command);
    this.commandCalls.push([...args]);
    switch (command) {
      case 'EVAL': {
        const script = requiredArg(args, 1);
        const keyCount = Number(requiredArg(args, 2));
        if (script.includes("redis.call('ZSCORE', KEYS[1]")) {
          if (keyCount !== 2) throw new Error('edge store must declare both Redis keys');
          const indexKey = requiredArg(args, 3);
          const registrationKey = requiredArg(args, 4);
          const edgeId = requiredArg(args, 5);
          const registration = requiredArg(args, 6);
          const updatedAt = Number(requiredArg(args, 7));
          const zset = this.zsets.get(indexKey) ?? new Map<string, number>();
          const currentScore = zset.get(edgeId);
          if (currentScore !== undefined && currentScore > updatedAt) return 0;
          this.strings.set(registrationKey, registration);
          zset.set(edgeId, updatedAt);
          this.zsets.set(indexKey, zset);
          return 1;
        }
        if (script.includes("redis.call('ZREMRANGEBYSCORE', KEYS[1]")) {
          if (keyCount !== 1) throw new Error('edge list must declare its Redis key');
          const indexKey = requiredArg(args, 3);
          const cutoff = Number(requiredArg(args, 4));
          const zset = this.zsets.get(indexKey);
          if (zset === undefined) return [];
          for (const [member, score] of zset) {
            if (score <= cutoff) {
              zset.delete(member);
            }
          }
          return [...zset]
            .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
            .map(([edgeId]) => edgeId);
        }
        if (this.identityClaimReply !== undefined) {
          return this.identityClaimReply;
        }
        const key = requiredArg(args, 3);
        const idKey = requiredArg(args, 4);
        const edgeId = requiredArg(args, 5);
        const edgeWtUrl = requiredArg(args, 6);
        const owner = this.strings.get(key);
        const ownedUrl = this.strings.get(idKey);
        if (
          (owner !== undefined && owner !== edgeId) ||
          (ownedUrl !== undefined && ownedUrl !== edgeWtUrl)
        ) {
          return 0;
        }
        this.strings.set(key, edgeId);
        this.strings.set(idKey, edgeWtUrl);
        return 1;
      }
      case 'SET':
        if (args[3] === 'NX') {
          const key = requiredArg(args, 1);
          if (this.strings.has(key)) return null;
          this.strings.set(key, requiredArg(args, 2));
          return 'OK';
        }
        this.strings.set(requiredArg(args, 1), requiredArg(args, 2));
        return 'OK';
      case 'GET':
        return this.strings.get(requiredArg(args, 1)) ?? null;
      case 'MGET':
        return args.slice(1).map((key) => this.strings.get(key) ?? null);
      case 'ZADD': {
        const key = requiredArg(args, 1);
        const score = Number(requiredArg(args, 2));
        const member = requiredArg(args, 3);
        const zset = this.zsets.get(key) ?? new Map<string, number>();
        zset.set(member, score);
        this.zsets.set(key, zset);
        return 1;
      }
      case 'ZREVRANGE': {
        const zset = this.zsets.get(requiredArg(args, 1));
        if (zset === undefined) return [];
        return [...zset]
          .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
          .map(([member]) => member);
      }
      case 'ZREMRANGEBYSCORE': {
        const zset = this.zsets.get(requiredArg(args, 1));
        if (zset === undefined) return 0;
        const max = Number(requiredArg(args, 3));
        let removed = 0;
        for (const [member, score] of zset) {
          if (score <= max) {
            zset.delete(member);
            removed += 1;
          }
        }
        return removed;
      }
      case 'PEXPIRE':
        return 1;
      default:
        throw new Error(`unsupported fake Redis command: ${command}`);
    }
  }
}

function requiredArg(args: string[], index: number): string {
  const value = args[index];
  if (value === undefined) throw new Error(`missing argument ${index}`);
  return value;
}
