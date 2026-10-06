import '@merkur/shared/e2e-wasm-bun';
import { randomUUID } from 'node:crypto';
import { cpus, release as osRelease } from 'node:os';

import { Effect, Layer } from 'effect';

import { emitPerfMetric, perfEnvInteger, summarizeSamples } from '../../../scripts/perf/harness';
import { type ServerConfig, ServerConfigService } from '../src/config';
import type { RedisScript } from '../src/services/redis-script';
import {
  type RedisCommandClient,
  type RedisError,
  type RedisService,
  RedisServiceLive,
  RedisServiceTag,
} from '../src/services/redis-service';
import type {
  SessionIssuanceCallbacks,
  SessionIssuanceInput,
  SessionIssuanceResponse,
} from '../src/services/session-issuance-contract';
import {
  SessionIssuanceServiceLive,
  SessionIssuanceServiceTag,
} from '../src/services/session-issuance-service';
import { provideLayerAroundScopedProgram } from './benchmark-effect-scope';
import { parseCoordinationServerVersion } from './session-start-benchmark-artifact';

const RECORD_KEY_PREFIX = 'merkur:sessions:issuance:';
const LOCK_KEY_PREFIX = 'merkur:sessions:issuance-lock:';
const INITIALIZE_LEASE_AND_READ_SCRIPT_NAME = 'session-issuance-initialize-lease-and-read';
const COMMITTED_ISSUANCE_TTL_MS = 86_400_000;
const DAEMON_IDENTITY_KEY_COMMITMENT = Buffer.alloc(64, 11).toString('base64url');
const SESSION_REQUEST_COMMITMENT = Buffer.alloc(64, 12).toString('base64url');

class IssuanceRedisRecorder {
  readonly initializeLeaseReadSamplesMs: number[] = [];
  readonly totalSamplesMs: number[] = [];
  readonly commandSamples: number[] = [];
  readonly observedKeys = new Set<string>();
  private active = false;
  private measured = false;
  private commands = 0;
  private initializeElapsedMs: number | null = null;

  beginIssue(measured: boolean): void {
    if (this.active) throw new Error('Issuance recorder already has an active issue');
    this.active = true;
    this.measured = measured;
    this.commands = 0;
    this.initializeElapsedMs = null;
  }

  endIssue(totalElapsedMs: number): void {
    if (!this.active) throw new Error('Issuance recorder has no active issue');
    if (this.initializeElapsedMs === null) {
      throw new Error('Issuance did not execute exactly one initialize/lease/read phase');
    }
    if (this.measured) {
      this.initializeLeaseReadSamplesMs.push(this.initializeElapsedMs);
      this.totalSamplesMs.push(totalElapsedMs);
      this.commandSamples.push(this.commands);
    }
    this.active = false;
  }

  async sendCommand<T>(client: RedisCommandClient, args: string[]): Promise<T> {
    this.observeKeys(args.slice(1));
    if (this.active) this.commands += 1;
    return client.sendCommand<T>(args);
  }

  async evalScript<T>(
    evaluate: NonNullable<RedisCommandClient['evalScript']>,
    script: RedisScript,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<T> {
    this.observeKeys(keys);
    if (!this.active) return evaluate<T>(script, keys, args);
    this.commands += 1;
    const startedAt = performance.now();
    const result = await evaluate<T>(script, keys, args);
    if (script.name === INITIALIZE_LEASE_AND_READ_SCRIPT_NAME) {
      if (this.initializeElapsedMs !== null) {
        throw new Error('Issuance executed duplicate initialize/lease/read phases');
      }
      this.initializeElapsedMs = performance.now() - startedAt;
    }
    return result;
  }

  lastObservedKey(prefix: string): string | null {
    for (const key of this.observedKeys) {
      if (key.startsWith(prefix)) return key;
    }
    return null;
  }

  private observeKeys(values: readonly string[]): void {
    for (const value of values) {
      if (value.startsWith(RECORD_KEY_PREFIX) || value.startsWith(LOCK_KEY_PREFIX)) {
        this.observedKeys.add(value);
      }
    }
  }
}

const redisUrl = process.env.DRAGONFLY_BENCH_URL;
if (redisUrl === undefined || redisUrl.length === 0) {
  throw new Error('DRAGONFLY_BENCH_URL must point to a disposable Dragonfly instance');
}

const iterations = perfEnvInteger('BENCH_ITERATIONS', 5_000);
const warmupIterations = perfEnvInteger('BENCH_WARMUP_ITERATIONS', 500);
const recorder = new IssuanceRedisRecorder();
const configLayer = Layer.succeed(ServerConfigService, benchmarkConfig(redisUrl));
const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
const countingRedisLayer = Layer.effect(
  RedisServiceTag,
  Effect.gen(function* () {
    return createCountingRedisService(yield* RedisServiceTag, recorder);
  }),
).pipe(Layer.provide(redisLayer));
const infrastructureLayer = SessionIssuanceServiceLive.pipe(Layer.provideMerge(countingRedisLayer));
const suffix = randomUUID();

const program = Effect.gen(function* () {
  const issuance = yield* SessionIssuanceServiceTag;
  const redis = yield* RedisServiceTag;
  const coordinationServerVersion = yield* redis.useCommands(async (commands) =>
    parseCoordinationServerVersion(await commands.sendCommand<unknown>(['INFO'])),
  );
  let prepares = 0;
  let deliveries = 0;
  let compensations = 0;
  const callbacks: SessionIssuanceCallbacks = {
    prepare: (sessionId) =>
      Effect.sync(() => {
        prepares += 1;
        const expiresAtMs = Date.now() + 3_600_000;
        return {
          response: response(sessionId, expiresAtMs),
          expiresAtMs,
        };
      }),
    deliver: () =>
      Effect.sync(() => {
        deliveries += 1;
      }),
    compensate: () =>
      Effect.sync(() => {
        compensations += 1;
      }),
  };

  const issue = (index: number, phase: 'warmup' | 'measure') =>
    Effect.gen(function* () {
      const input: SessionIssuanceInput = {
        issuanceId: `bench-issuance-${phase}-${index}-${suffix}`,
        userId: `bench-user-${suffix}`,
        delegationId: `bench-delegation-${suffix}`,
        daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
        sessionRequestCommitment: SESSION_REQUEST_COMMITMENT,
        daemonId: `bench-daemon-${suffix}`,
        browserNodeId: `bench-browser-${suffix}`,
      };
      recorder.beginIssue(phase === 'measure');
      const startedAt = performance.now();
      const result = yield* issuance.issue(input, callbacks);
      const elapsedMs = performance.now() - startedAt;
      recorder.endIssue(elapsedMs);
      if (
        result.daemonId !== input.daemonId ||
        result.controlPresence.userId !== input.userId ||
        result.sessionId.length === 0
      ) {
        return yield* Effect.die(
          new Error('Session issuance benchmark returned a mismatched result'),
        );
      }
    });

  for (let index = 0; index < warmupIterations; index += 1) {
    yield* issue(index, 'warmup');
  }
  for (let index = 0; index < iterations; index += 1) {
    yield* issue(index, 'measure');
  }

  const expectedCallbacks = warmupIterations + iterations;
  if (prepares !== expectedCallbacks || deliveries !== expectedCallbacks || compensations !== 0) {
    return yield* Effect.die(
      new Error(
        `Expected ${expectedCallbacks} prepare/deliver callbacks and no compensation; ` +
          `observed ${prepares}/${deliveries}/${compensations}`,
      ),
    );
  }
  yield* verifyCommittedRecord(redis, recorder);
  yield* cleanupObservedKeys(redis, recorder.observedKeys);
  return { coordinationServerVersion };
});

const result = await Effect.runPromise(
  provideLayerAroundScopedProgram(program, infrastructureLayer),
);
const initializeSummary = summarizeSamples(recorder.initializeLeaseReadSamplesMs);
const totalSummary = summarizeSamples(recorder.totalSamplesMs);
const commandSummary = summarizeSamples(recorder.commandSamples);

for (const [name, summary, unit] of [
  ['server-session-issuance-initialize-lease-read', initializeSummary, 'ms/issuance-transition'],
  ['server-session-issuance-total', totalSummary, 'ms/committed-issuance'],
] as const) {
  for (const [suffix, value, percentile] of [
    ['p50', summary.median, 0.5],
    ['p95', summary.p95, 0.95],
    ['p99', summary.p99, 0.99],
  ] as const) {
    emitPerfMetric({
      name: `${name}-${suffix}`,
      value,
      unit,
      direction: 'lower',
      percentile,
      sampleSize: iterations,
    });
  }
}
emitPerfMetric({
  name: 'server-session-issuance-redis-commands',
  value: commandSummary.median,
  unit: 'commands/committed-issuance',
  direction: 'lower',
  sampleSize: iterations,
});

const systemCpus = cpus();
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    benchmark: 'server-session-issuance-redis-transitions',
    measurementBoundary: 'redis-transition-invocation-to-return-and-full-issuance-commit',
    implementation: 'session-issuance-live-dragonfly-v1',
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
    initializeLeaseReadSamplesMs: recorder.initializeLeaseReadSamplesMs,
    totalSamplesMs: recorder.totalSamplesMs,
    commandSamples: recorder.commandSamples,
  })}\n`,
);
process.stdout.write(
  `server session issuance: iterations=${iterations} ` +
    `initialize/lease/read p50=${initializeSummary.median.toFixed(3)}ms ` +
    `total p50=${totalSummary.median.toFixed(3)}ms ` +
    `commands=${commandSummary.median.toFixed(0)}\n`,
);

function createCountingRedisService(
  delegate: RedisService,
  issueRecorder: IssuanceRedisRecorder,
): RedisService {
  return {
    useCommands: <T>(
      use: (client: RedisCommandClient) => T | PromiseLike<T>,
    ): Effect.Effect<T, RedisError> =>
      delegate.useCommands((client) => use(createCountingRedisClient(client, issueRecorder))),
    publish: (channel, message) => delegate.publish(channel, message),
    subscribe: (channel, handler) => delegate.subscribe(channel, handler),
    unsubscribe: (channel, handler) => delegate.unsubscribe(channel, handler),
    loadScripts: (scripts) => delegate.loadScripts?.(scripts) ?? Effect.void,
    healthSnapshot: () => delegate.healthSnapshot(),
  };
}

function createCountingRedisClient(
  delegate: RedisCommandClient,
  issueRecorder: IssuanceRedisRecorder,
): RedisCommandClient {
  const sendCommand = <T = unknown>(args: string[]): Promise<T> =>
    issueRecorder.sendCommand<T>(delegate, args);
  if (delegate.evalScript === undefined) return { sendCommand };
  const evaluate = delegate.evalScript.bind(delegate);
  return {
    sendCommand,
    evalScript: <T = unknown>(
      script: RedisScript,
      keys: readonly string[],
      args: readonly string[],
    ): Promise<T> => issueRecorder.evalScript<T>(evaluate, script, keys, args),
  };
}

function response(sessionId: string, expiresAtMs: number): SessionIssuanceResponse {
  const daemonId = `bench-daemon-${suffix}`;
  return {
    daemonId,
    daemonIdentityPublicKey: Buffer.alloc(2_592, 8).toString('base64url'),
    daemonIdentityP256PublicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString(
      'base64url',
    ),
    daemonBinding: {
      userId: `bench-user-${suffix}`,
      rootKeyCommitment: Buffer.alloc(64, 14).toString('base64url'),
      daemonId,
      daemonIdentityKeyCommitment: DAEMON_IDENTITY_KEY_COMMITMENT,
      serverOrigin: 'https://merkur.example',
      linkClaimId: 'benchmark-link-claim',
      issuedAt: 1,
      signature: Buffer.alloc(4_627, 15).toString('base64url'),
    },
    controlPresence: {
      daemonId,
      userId: `bench-user-${suffix}`,
      ownerInstanceId: 'benchmark-instance',
      connectionId: 'benchmark-connection',
      presenceId: 'benchmark-presence',
      claimSeq: 1,
      state: 'online',
      zone: null,
      updatedAt: Date.now(),
    },
    sessionToken: `benchmark-token-${sessionId}`,
    sessionTokenExpiresAtMs: expiresAtMs,
    sessionId,
    edgeWtUrl: 'https://edge.example/',
    edgeCertHashes: [Buffer.alloc(32, 7).toString('base64')],
    edgeAttachTicket: Buffer.alloc(26, 1).toString('base64url'),
    clientNonce: Buffer.alloc(32, 9).toString('base64url'),
    encapsulationKey: Buffer.alloc(1_568, 10).toString('base64url'),
  };
}

function verifyCommittedRecord(
  redis: RedisService,
  issueRecorder: IssuanceRedisRecorder,
): Effect.Effect<void, unknown> {
  const recordKey = issueRecorder.lastObservedKey(RECORD_KEY_PREFIX);
  const lockKey = issueRecorder.lastObservedKey(LOCK_KEY_PREFIX);
  if (recordKey === null || lockKey === null) {
    return Effect.die(new Error('Benchmark did not observe issuance record and lock keys'));
  }
  return redis.useCommands(async (commands) => {
    const [raw, ttl, lockExists] = await Promise.all([
      commands.sendCommand<unknown>(['GET', recordKey]),
      commands.sendCommand<unknown>(['PTTL', recordKey]),
      commands.sendCommand<unknown>(['EXISTS', lockKey]),
    ]);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { state?: unknown }).state !== 'committed' ||
      typeof ttl !== 'number' ||
      ttl <= 0 ||
      ttl > COMMITTED_ISSUANCE_TTL_MS ||
      lockExists !== 0
    ) {
      throw new Error('Benchmark issuance did not finish as a fenced committed record');
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
