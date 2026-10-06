import '@merkur/shared/e2e-wasm-bun';
import { randomUUID } from 'node:crypto';
import { cpus, release as osRelease } from 'node:os';

import { Effect, Layer, Result } from 'effect';

import { emitPerfMetric, perfEnvInteger, summarizeSamples } from '../../../scripts/perf/harness';
import { type ServerConfig, ServerConfigService } from '../src/config';
import {
  enforceRateLimit,
  type RateLimitCheck,
  RateLimitedError,
  type RateLimitService,
  RateLimitServiceLive,
  RateLimitServiceTag,
} from '../src/services/rate-limit-service';
import type { RedisScript } from '../src/services/redis-script';
import {
  type RedisCommandClient,
  type RedisError,
  type RedisService,
  RedisServiceLive,
  RedisServiceTag,
} from '../src/services/redis-service';
import { provideLayerAroundScopedProgram } from './benchmark-effect-scope';
import { parseCoordinationServerVersion } from './session-start-benchmark-artifact';

const WINDOW_MS = 60_000;
const IP_LIMIT = 30;
const USER_LIMIT = 5;
const REDIS_KEY_PREFIX = 'rl:';

type ExpectedOutcome = 'allowed' | 'first-denied' | 'second-denied';
type TraceImplementation = 'sequential-single-key-scripts' | 'ordered-batched-script';

interface ScriptOperation {
  readonly transport: 'evalScript' | 'raw-EVALSHA' | 'raw-EVAL';
  readonly scriptName: string;
  readonly scriptSha1: string | null;
  readonly keys: readonly string[];
  readonly succeeded: boolean;
}

interface CounterSnapshot {
  readonly exists: boolean;
  readonly totalCount: number;
  readonly ttlMs: number;
}

interface SemanticFixtureArtifact {
  readonly outcome: ExpectedOutcome;
  readonly deniedKey: string | null;
  readonly retryAfterMs: number | null;
  readonly implementation: TraceImplementation;
  readonly operations: readonly ScriptOperation[];
  readonly firstCounter: CounterSnapshot;
  readonly secondCounter: CounterSnapshot;
}

class RateLimitRedisRecorder {
  readonly observedKeys = new Set<string>();
  readonly latencySamplesMs: number[] = [];
  readonly scriptOperationSamples: number[] = [];
  private readonly scriptsBySha = new Map<string, RedisScript>();
  private readonly scriptsBySource = new Map<string, RedisScript>();
  private activeOperations: ScriptOperation[] | null = null;

  observeLoadedScripts(scripts: readonly RedisScript[]): void {
    for (const script of scripts) {
      this.scriptsBySha.set(script.sha1, script);
      this.scriptsBySource.set(script.source, script);
    }
  }

  loadedScripts(): readonly RedisScript[] {
    return [...this.scriptsBySha.values()];
  }

  beginTrace(): void {
    if (this.activeOperations !== null) throw new Error('A Redis script trace is already active');
    this.activeOperations = [];
  }

  finishTrace(): readonly ScriptOperation[] {
    const operations = this.activeOperations;
    if (operations === null) throw new Error('No Redis script trace is active');
    this.activeOperations = null;
    if (operations.some((operation) => !operation.succeeded)) {
      throw new Error('A measured Redis script operation failed and was handled fail-open');
    }
    return operations;
  }

  recordMeasuredSample(elapsedMs: number, operations: readonly ScriptOperation[]): void {
    this.latencySamplesMs.push(elapsedMs);
    this.scriptOperationSamples.push(operations.length);
  }

  async evalScript<T>(
    evaluate: NonNullable<RedisCommandClient['evalScript']>,
    script: RedisScript,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<T> {
    this.observeKeys(keys);
    try {
      const result = await evaluate<T>(script, keys, args);
      this.recordOperation({
        transport: 'evalScript',
        scriptName: script.name,
        scriptSha1: script.sha1,
        keys: [...keys],
        succeeded: true,
      });
      return result;
    } catch (error) {
      this.recordOperation({
        transport: 'evalScript',
        scriptName: script.name,
        scriptSha1: script.sha1,
        keys: [...keys],
        succeeded: false,
      });
      throw error;
    }
  }

  async sendCommand<T>(delegate: RedisCommandClient, args: string[]): Promise<T> {
    const command = args[0]?.toUpperCase();
    if (command !== 'EVALSHA' && command !== 'EVAL') {
      return delegate.sendCommand<T>(args);
    }
    const keyCount = parseCommandKeyCount(args[2]);
    const keys = args.slice(3, 3 + keyCount);
    this.observeKeys(keys);
    const script =
      command === 'EVALSHA'
        ? this.scriptsBySha.get(args[1] ?? '')
        : this.scriptsBySource.get(args[1] ?? '');
    try {
      const result = await delegate.sendCommand<T>(args);
      this.recordOperation({
        transport: command === 'EVALSHA' ? 'raw-EVALSHA' : 'raw-EVAL',
        scriptName: script?.name ?? 'unknown',
        scriptSha1: script?.sha1 ?? (command === 'EVALSHA' ? (args[1] ?? null) : null),
        keys,
        succeeded: true,
      });
      return result;
    } catch (error) {
      this.recordOperation({
        transport: command === 'EVALSHA' ? 'raw-EVALSHA' : 'raw-EVAL',
        scriptName: script?.name ?? 'unknown',
        scriptSha1: script?.sha1 ?? (command === 'EVALSHA' ? (args[1] ?? null) : null),
        keys,
        succeeded: false,
      });
      throw error;
    }
  }

  private recordOperation(operation: ScriptOperation): void {
    this.activeOperations?.push(operation);
  }

  private observeKeys(keys: readonly string[]): void {
    for (const key of keys) {
      if (key.startsWith(REDIS_KEY_PREFIX)) this.observedKeys.add(key);
    }
  }
}

const redisUrl = process.env.DRAGONFLY_BENCH_URL;
if (redisUrl === undefined || redisUrl.length === 0) {
  throw new Error('DRAGONFLY_BENCH_URL must point to a disposable Dragonfly instance');
}

const iterations = perfEnvInteger('BENCH_ITERATIONS', 5_000);
const warmupIterations = perfEnvInteger('BENCH_WARMUP_ITERATIONS', 500);
const runSuffix = randomUUID();
const recorder = new RateLimitRedisRecorder();
const configLayer = Layer.succeed(ServerConfigService, benchmarkConfig(redisUrl));
const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
const countingRedisLayer = Layer.effect(
  RedisServiceTag,
  Effect.gen(function* () {
    return createCountingRedisService(yield* RedisServiceTag, recorder);
  }),
).pipe(Layer.provide(redisLayer));
const infrastructureLayer = RateLimitServiceLive.pipe(Layer.provideMerge(countingRedisLayer));

const program = Effect.gen(function* () {
  const rateLimit = yield* RateLimitServiceTag;
  const redis = yield* RedisServiceTag;

  return yield* Effect.gen(function* () {
    const coordinationServerVersion = yield* redis.useCommands(async (commands) =>
      parseCoordinationServerVersion(await commands.sendCommand<unknown>(['INFO'])),
    );
    yield* verifyScriptCache(redis, recorder.loadedScripts());

    const semanticFixtures = [
      yield* runSemanticFixture(rateLimit, redis, recorder, 'allowed', runSuffix),
      yield* runSemanticFixture(rateLimit, redis, recorder, 'first-denied', runSuffix),
      yield* runSemanticFixture(rateLimit, redis, recorder, 'second-denied', runSuffix),
    ];

    for (let index = 0; index < warmupIterations; index += 1) {
      const checks = productionChecks('warmup', index, runSuffix);
      const result = yield* Effect.result(enforceRateLimit(rateLimit, checks));
      if (Result.isFailure(result)) {
        return yield* Effect.die(
          new Error('Warmup production-shaped checks were unexpectedly denied'),
        );
      }
    }

    let measuredImplementation: TraceImplementation | null = null;
    let measuredTraceShape: readonly ScriptOperation[] | null = null;
    for (let index = 0; index < iterations; index += 1) {
      const checks = productionChecks('measure', index, runSuffix);
      recorder.beginTrace();
      const startedAt = performance.now();
      const result = yield* Effect.result(enforceRateLimit(rateLimit, checks));
      const elapsedMs = performance.now() - startedAt;
      const operations = recorder.finishTrace();
      if (Result.isFailure(result)) {
        return yield* Effect.die(
          new Error('Measured production-shaped checks were unexpectedly denied'),
        );
      }
      const implementation = validateTrace(operations, checks, 'allowed');
      if (measuredImplementation !== null && implementation !== measuredImplementation) {
        return yield* Effect.die(new Error('Measured Redis script shape changed during the run'));
      }
      measuredImplementation = implementation;
      measuredTraceShape ??= operations;
      recorder.recordMeasuredSample(elapsedMs, operations);
    }

    if (measuredImplementation === null || measuredTraceShape === null) {
      return yield* Effect.die(new Error('Benchmark did not produce a measured script trace'));
    }
    return {
      coordinationServerVersion,
      measuredImplementation,
      measuredTraceShape,
      semanticFixtures,
    };
  }).pipe(Effect.ensuring(cleanupObservedKeys(redis, recorder.observedKeys)));
});

const result = await Effect.runPromise(
  provideLayerAroundScopedProgram(program, infrastructureLayer),
);
const latencySummary = summarizeSamples(recorder.latencySamplesMs);
const operationSummary = summarizeSamples(recorder.scriptOperationSamples);

for (const [suffix, value, percentile] of [
  ['p50', latencySummary.median, 0.5],
  ['p95', latencySummary.p95, 0.95],
  ['p99', latencySummary.p99, 0.99],
] as const) {
  emitPerfMetric({
    name: `server-auth-continue-rate-limit-allowed-${suffix}`,
    value,
    unit: 'ms/allowed-check-pair',
    direction: 'lower',
    percentile,
    sampleSize: iterations,
  });
}
emitPerfMetric({
  name: 'server-auth-continue-rate-limit-script-operations',
  value: operationSummary.median,
  unit: 'script-operations/allowed-check-pair',
  direction: 'lower',
  sampleSize: iterations,
});

const systemCpus = cpus();
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    benchmark: 'server-auth-continue-rate-limit',
    measurementBoundary: 'ordered-rate-limit-enforcement-call-to-return',
    implementation: result.measuredImplementation,
    revision: gitOutput(['rev-parse', 'HEAD']),
    dirty: gitOutput(['status', '--porcelain']) !== '',
    environment: {
      platform: process.platform,
      osRelease: osRelease(),
      architecture: process.arch,
      cpuModel: systemCpus[0]?.model ?? 'unknown',
      logicalCpuCount: Math.max(1, systemCpus.length),
      bunVersion: Bun.version,
      coordinationServerVersion: result.coordinationServerVersion,
      dragonflyImageId: process.env.DRAGONFLY_BENCH_IMAGE_ID ?? 'unavailable',
    },
    iterations,
    warmupIterations,
    preloadedScripts: recorder.loadedScripts().map(({ name, sha1 }) => ({ name, sha1 })),
    scriptCacheVerifiedBeforeTiming: true,
    latencySamplesMs: recorder.latencySamplesMs,
    scriptOperationSamples: recorder.scriptOperationSamples,
    measuredTraceShape: result.measuredTraceShape,
    semanticFixtures: result.semanticFixtures,
  })}\n`,
);
process.stdout.write(
  `auth continue rate limits: iterations=${iterations} ` +
    `p50=${latencySummary.median.toFixed(3)}ms ` +
    `p95=${latencySummary.p95.toFixed(3)}ms ` +
    `script operations=${operationSummary.median.toFixed(0)} ` +
    `implementation=${result.measuredImplementation}\n`,
);

function createCountingRedisService(
  delegate: RedisService,
  redisRecorder: RateLimitRedisRecorder,
): RedisService {
  return {
    useCommands: <T>(
      use: (client: RedisCommandClient) => T | PromiseLike<T>,
    ): Effect.Effect<T, RedisError> =>
      delegate.useCommands((client) => use(createCountingRedisClient(client, redisRecorder))),
    publish: (channel, message) => delegate.publish(channel, message),
    subscribe: (channel, handler) => delegate.subscribe(channel, handler),
    unsubscribe: (channel, handler) => delegate.unsubscribe(channel, handler),
    loadScripts: (scripts) => {
      redisRecorder.observeLoadedScripts(scripts);
      return delegate.loadScripts?.(scripts) ?? Effect.void;
    },
    healthSnapshot: () => delegate.healthSnapshot(),
  };
}

function createCountingRedisClient(
  delegate: RedisCommandClient,
  redisRecorder: RateLimitRedisRecorder,
): RedisCommandClient {
  const sendCommand = <T = unknown>(args: string[]): Promise<T> =>
    redisRecorder.sendCommand<T>(delegate, args);
  if (delegate.evalScript === undefined) return { sendCommand };
  const evaluate = delegate.evalScript.bind(delegate);
  return {
    sendCommand,
    evalScript: <T = unknown>(
      script: RedisScript,
      keys: readonly string[],
      args: readonly string[],
    ): Promise<T> => redisRecorder.evalScript<T>(evaluate, script, keys, args),
  };
}

function productionChecks(
  phase: 'warmup' | 'measure',
  index: number,
  suffix: string,
): readonly [RateLimitCheck, RateLimitCheck] {
  const identity = `${phase}-${index.toString(16)}-${suffix}`;
  const addressPhase = phase === 'warmup' ? 'a' : 'b';
  const addressHigh = Math.floor(index / 0x1_0000).toString(16);
  const addressLow = (index % 0x1_0000).toString(16);
  return [
    {
      key: `auth-continue:ip:2001:db8:${addressPhase}:${addressHigh}:${addressLow}::1`,
      limit: IP_LIMIT,
      windowMs: WINDOW_MS,
    },
    {
      key: `auth-continue:user:bench-${identity}@example.test`,
      limit: USER_LIMIT,
      windowMs: WINDOW_MS,
    },
  ];
}

function fixtureChecks(
  outcome: ExpectedOutcome,
  suffix: string,
): readonly [RateLimitCheck, RateLimitCheck] {
  return [
    {
      key: `auth-continue:ip:fixture-${outcome}-${suffix}`,
      limit: outcome === 'first-denied' ? 0 : IP_LIMIT,
      windowMs: WINDOW_MS,
    },
    {
      key: `auth-continue:user:fixture-${outcome}-${suffix}@example.test`,
      limit: outcome === 'second-denied' ? 0 : USER_LIMIT,
      windowMs: WINDOW_MS,
    },
  ];
}

function runSemanticFixture(
  rateLimit: RateLimitService,
  redis: RedisService,
  redisRecorder: RateLimitRedisRecorder,
  expectedOutcome: ExpectedOutcome,
  suffix: string,
): Effect.Effect<SemanticFixtureArtifact, never, never> {
  const checks = fixtureChecks(expectedOutcome, suffix);
  return Effect.gen(function* () {
    redisRecorder.beginTrace();
    const enforcement = yield* Effect.result(enforceRateLimit(rateLimit, checks));
    const operations = redisRecorder.finishTrace();
    const implementation = validateTrace(operations, checks, expectedOutcome);
    const [firstCounter, secondCounter] = yield* Effect.all([
      readCounter(redis, redisKey(checks[0])),
      readCounter(redis, redisKey(checks[1])),
    ]);

    let deniedKey: string | null = null;
    let retryAfterMs: number | null = null;
    if (expectedOutcome === 'allowed') {
      if (Result.isFailure(enforcement)) throw new Error('Allowed fixture was denied');
    } else {
      if (Result.isSuccess(enforcement) || !(enforcement.failure instanceof RateLimitedError)) {
        throw new Error(`${expectedOutcome} fixture was not denied with RateLimitedError`);
      }
      const expectedKey = expectedOutcome === 'first-denied' ? checks[0].key : checks[1].key;
      if (
        enforcement.failure.key !== expectedKey ||
        enforcement.failure.retryAfterMs <= 0 ||
        enforcement.failure.retryAfterMs > WINDOW_MS
      ) {
        throw new Error(`${expectedOutcome} fixture returned incorrect denial metadata`);
      }
      deniedKey = enforcement.failure.key;
      retryAfterMs = enforcement.failure.retryAfterMs;
    }

    if (firstCounter.totalCount !== 1 || firstCounter.ttlMs <= 0) {
      throw new Error(`${expectedOutcome} fixture did not increment the first counter once`);
    }
    if (expectedOutcome === 'first-denied') {
      if (secondCounter.exists || secondCounter.totalCount !== 0 || secondCounter.ttlMs !== -2) {
        throw new Error('First-denied fixture mutated the second counter');
      }
    } else if (secondCounter.totalCount !== 1 || secondCounter.ttlMs <= 0) {
      throw new Error(`${expectedOutcome} fixture did not increment the second counter once`);
    }

    return {
      outcome: expectedOutcome,
      deniedKey,
      retryAfterMs,
      implementation,
      operations,
      firstCounter,
      secondCounter,
    };
  });
}

function validateTrace(
  operations: readonly ScriptOperation[],
  checks: readonly [RateLimitCheck, RateLimitCheck],
  expectedOutcome: ExpectedOutcome,
): TraceImplementation {
  if (operations.some((operation) => operation.transport !== 'evalScript')) {
    throw new Error('Rate limiting bypassed the production preloaded-script transport');
  }
  const firstKey = redisKey(checks[0]);
  const secondKey = redisKey(checks[1]);
  if (
    operations.length === 2 &&
    expectedOutcome !== 'first-denied' &&
    sameKeys(operations[0]?.keys, [firstKey]) &&
    sameKeys(operations[1]?.keys, [secondKey])
  ) {
    return 'sequential-single-key-scripts';
  }
  if (
    operations.length === 1 &&
    expectedOutcome === 'first-denied' &&
    sameKeys(operations[0]?.keys, [firstKey])
  ) {
    return 'sequential-single-key-scripts';
  }
  if (operations.length === 1 && sameKeys(operations[0]?.keys, [firstKey, secondKey])) {
    return 'ordered-batched-script';
  }
  throw new Error(`Unexpected ${expectedOutcome} script trace: ${JSON.stringify(operations)}`);
}

function readCounter(redis: RedisService, key: string): Effect.Effect<CounterSnapshot, unknown> {
  return redis.useCommands(async (commands) => {
    const [existsReply, valuesReply, ttlReply] = await Promise.all([
      commands.sendCommand<unknown>(['EXISTS', key]),
      commands.sendCommand<unknown>(['HVALS', key]),
      commands.sendCommand<unknown>(['PTTL', key]),
    ]);
    const exists = parseIntegerReply(existsReply, `EXISTS ${key}`);
    const ttlMs = parseIntegerReply(ttlReply, `PTTL ${key}`);
    if (exists !== 0 && exists !== 1) throw new Error(`EXISTS ${key} must return zero or one`);
    if (!Array.isArray(valuesReply)) throw new Error(`HVALS ${key} must return an array`);
    return {
      exists: exists === 1,
      totalCount: valuesReply.reduce(
        (sum, value) => sum + parseIntegerReply(value, `HVALS ${key}`),
        0,
      ),
      ttlMs,
    };
  });
}

function verifyScriptCache(
  redis: RedisService,
  scripts: readonly RedisScript[],
): Effect.Effect<void, unknown> {
  if (scripts.length === 0) return Effect.die(new Error('Rate limit layer preloaded no scripts'));
  return redis.useCommands(async (commands) => {
    const reply = await commands.sendCommand<unknown>([
      'SCRIPT',
      'EXISTS',
      ...scripts.map((script) => script.sha1),
    ]);
    if (
      !Array.isArray(reply) ||
      reply.length !== scripts.length ||
      reply.some((value) => parseIntegerReply(value, 'SCRIPT EXISTS') !== 1)
    ) {
      throw new Error('Not all rate limit scripts were present before timing');
    }
  });
}

function cleanupObservedKeys(
  redis: RedisService,
  observedKeys: ReadonlySet<string>,
): Effect.Effect<void, unknown> {
  const keys = [...observedKeys];
  return Effect.forEach(
    chunk(keys, 500),
    (batch) => redis.useCommands((commands) => commands.sendCommand(['DEL', ...batch])),
    { discard: true },
  );
}

function sameKeys(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return (
    actual?.length === expected.length && actual.every((key, index) => key === expected[index])
  );
}

function redisKey(check: RateLimitCheck): string {
  return `${REDIS_KEY_PREFIX}${check.key}`;
}

function parseCommandKeyCount(raw: string | undefined): number {
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid Redis script key count: ${raw ?? 'missing'}`);
  }
  return count;
}

function parseIntegerReply(value: unknown, label: string): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} returned a non-integer reply`);
  return parsed;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function benchmarkConfig(configuredRedisUrl: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: configuredRedisUrl,
    publicOrigin: 'https://localhost:3000',
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur',
    jwtAudience: 'merkur-clients',
    tokenHmacSecret: 'bench',
    authAllowRegistration: false,
    githubReleasesToken: undefined,
    sessionTokenSigningKey: new Uint8Array(4_896),
    sessionTokenVerifyKeyB64: 'A'.repeat(3_456),
    sessionTokenTtlMs: 60_000,
    webPushVapidPublicKey: undefined,
    webPushVapidPrivateKey: undefined,
    webPushContact: undefined,
    edgeRegistrationKeys: new Map(),
  };
}

function gitOutput(args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : 'unavailable';
}
