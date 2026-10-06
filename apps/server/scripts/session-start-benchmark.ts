import '@merkur/shared/e2e-wasm-bun';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, release as osRelease } from 'node:os';
import { deriveSessionAuthorizationKeyPair } from '@merkur/auth';
import {
  createDaemonControlCommandAckMessage,
  type DaemonControlRegisteredMessage,
  encodeDaemonControlMessage,
  MAX_DAEMON_CONTROL_FRAME_BYTES,
  parseDaemonControlServerMessage,
} from '@merkur/daemon-control-protocol';
import { RedisClient } from 'bun';
import { Effect, Logger as EffectLogger, Layer, Queue } from 'effect';

import { emitPerfMetric, perfEnvInteger, summarizeSamples } from '../../../scripts/perf/harness';
import { type ServerConfig, ServerConfigService } from '../src/config';
import type { Logger } from '../src/logger';
import {
  createDaemonControlService,
  DAEMON_CONTROL_MAX_PENDING_COMMANDS_PER_CONNECTION,
  DAEMON_CONTROL_PING_INTERVAL_MS,
  type DaemonControlService,
  type DaemonControlSessionStartInput,
  type DaemonControlSocket,
} from '../src/services/daemon-control-service';
import {
  type DaemonPresence,
  RealtimeCoordinationServiceLive,
  RealtimeCoordinationServiceTag,
} from '../src/services/realtime-coordination-service';
import { RedisServiceLive, RedisServiceTag } from '../src/services/redis-service';
import { provideLayerAroundScopedProgram } from './benchmark-effect-scope';
import {
  compareSessionStartBenchmarkArtifacts,
  parseCoordinationServerVersion,
  parseSessionStartBenchmarkArtifactOutput,
  SESSION_START_BENCHMARK_NAME,
  SESSION_START_BENCHMARK_SCHEMA_VERSION,
  SESSION_START_MEASUREMENT_BOUNDARY,
  type SessionStartBenchmarkArtifact,
  sessionStartRegressionPercentiles,
} from './session-start-benchmark-artifact';

const redisUrl = process.env.DRAGONFLY_BENCH_URL;
if (redisUrl === undefined || redisUrl.length === 0) {
  throw new Error('DRAGONFLY_BENCH_URL must point to a disposable Dragonfly instance');
}

const iterations = perfEnvInteger('BENCH_ITERATIONS', 1_000);
const warmupIterations = perfEnvInteger('BENCH_WARMUP_ITERATIONS', 100);
if (
  process.env.SESSION_START_REGRESSION_PERCENT !== undefined &&
  process.env.SESSION_START_BASELINE_ARTIFACT === undefined
) {
  throw new Error('SESSION_START_REGRESSION_PERCENT requires SESSION_START_BASELINE_ARTIFACT');
}
const allowedRegressionPercent = readNonNegativeFinite('SESSION_START_REGRESSION_PERCENT', 5);
const baselineArtifactPath = process.env.SESSION_START_BASELINE_ARTIFACT;
const baselineArtifact =
  baselineArtifactPath === undefined ? null : await readBaselineArtifact(baselineArtifactPath);
const suffix = randomUUID();
const daemonId = `bench-daemon-${suffix}`;
const userId = `bench-user-${suffix}`;
const connectionId = `bench-connection-${suffix}`;
const presenceId = `bench-presence-${suffix}`;
const browserNodeId = `bench-browser-${suffix}`;
const certificateHash = Buffer.alloc(32, 7).toString('base64');
let claimSeq = 0;
const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};
const benchmarkErrorLogs: string[] = [];
const benchmarkLoggerLayer = EffectLogger.layer([
  EffectLogger.make(({ logLevel, message }) => {
    if (logLevel === 'Error' || logLevel === 'Fatal') {
      benchmarkErrorLogs.push(typeof message === 'string' ? message : String(message));
    }
  }),
]);

const configLayer = Layer.succeed(ServerConfigService, testConfig(redisUrl));
const redisLayer = RedisServiceLive.pipe(Layer.provide(configLayer));
const infrastructureLayer = RealtimeCoordinationServiceLive.pipe(Layer.provideMerge(redisLayer));
const program = Effect.gen(function* () {
  const coordination = yield* RealtimeCoordinationServiceTag;
  const redis = yield* RedisServiceTag;
  const acknowledgementQueue = yield* Queue.bounded<string>(
    DAEMON_CONTROL_MAX_PENDING_COMMANDS_PER_CONNECTION,
  );
  const socket = new BenchmarkControlSocket(acknowledgementQueue);
  const coordinationServerVersion = yield* redis.useCommands(async (commands) =>
    parseCoordinationServerVersion(await commands.sendCommand<unknown>(['INFO'])),
  );
  const control = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createDaemonControlService({
        coordination,
        redis,
        touchDaemon: () => Effect.void,
        logger: NOOP_LOGGER,
      }),
    ),
    (service) => service.shutdown,
  );
  const handle = yield* control.acceptConnection({
    daemonId,
    userId,
    daemonVersion: 'benchmark',
    connectionId,
    presenceId,
    socket,
  });

  const registered = socket.requireRegistration();
  claimSeq = registered.claimSeq;
  const presence = yield* coordination.getDaemonPresence(daemonId);
  if (presence === null || !matchesRegistration(presence, registered)) {
    return yield* Effect.die(
      new Error('Registered control socket did not produce the current fenced presence'),
    );
  }

  const startSession = (index: number, phase: 'warmup' | 'measure') =>
    runAcknowledgedSessionStart(control, acknowledgementQueue, socket, {
      presence,
      sessionId: `bench-session-${phase}-${index}-${suffix}`,
      browserNodeId,
      offer: {
        userId,
        clientNonce: Buffer.alloc(32, 8).toString('base64url'),
        encapsulationKey: Buffer.alloc(1_568, 9).toString('base64url'),
        edgeWtUrl: 'https://edge.example/benchmark',
        edgeCertHashes: [certificateHash],
      },
    });
  // Liveness is a ping frame the socket layer observes; the benchmark stands
  // in for it at the daemon's cadence so the connection is never marked silent.
  let lastPingAt = performance.now();
  const pingIfDue = Effect.sync(() => {
    if (performance.now() - lastPingAt < DAEMON_CONTROL_PING_INTERVAL_MS / 2) return;
    handle.observePing();
    lastPingAt = performance.now();
  });

  for (let index = 0; index < warmupIterations; index += 1) {
    yield* pingIfDue;
    yield* startSession(index, 'warmup');
  }

  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    yield* pingIfDue;
    const startedAt = performance.now();
    yield* startSession(index, 'measure');
    samples.push(performance.now() - startedAt);
  }

  const expectedAcknowledgements = warmupIterations + iterations;
  if (
    socket.sessionStartCount !== expectedAcknowledgements ||
    socket.acknowledgedCommandCount !== expectedAcknowledgements
  ) {
    return yield* Effect.die(
      new Error(
        `Benchmark expected ${expectedAcknowledgements} exact session_start/command_ack pairs, ` +
          `observed ${socket.sessionStartCount}/${socket.acknowledgedCommandCount}`,
      ),
    );
  }
  return { coordinationServerVersion, samples };
});

try {
  const result = await Effect.runPromise(
    provideLayerAroundScopedProgram(program, infrastructureLayer).pipe(
      Effect.provide(benchmarkLoggerLayer),
    ),
  );
  if (benchmarkErrorLogs.length > 0) {
    throw new Error(
      `session-start benchmark emitted ${benchmarkErrorLogs.length} Error/Fatal log(s): ` +
        benchmarkErrorLogs.join(' | '),
    );
  }
  const summary = summarizeSamples(result.samples);
  const systemCpus = cpus();
  const artifact: SessionStartBenchmarkArtifact = {
    schemaVersion: SESSION_START_BENCHMARK_SCHEMA_VERSION,
    benchmark: SESSION_START_BENCHMARK_NAME,
    measurementBoundary: SESSION_START_MEASUREMENT_BOUNDARY,
    implementation: 'daemon-control-local-owner-synthetic-command-ack-v1',
    confirmationSemantics: 'daemon-command-ack',
    harnessTopology: 'bounded-in-process-control-socket',
    environment: {
      platform: process.platform,
      osRelease: osRelease(),
      architecture: process.arch,
      cpuModel: systemCpus[0]?.model ?? 'unknown',
      logicalCpuCount: Math.max(1, systemCpus.length),
      bunVersion: Bun.version,
      coordinationServerVersion: result.coordinationServerVersion,
    },
    iterations,
    warmupIterations,
    meanMs: summary.mean,
    p50Ms: summary.median,
    p95Ms: summary.p95,
    p99Ms: summary.p99,
  };
  for (const [name, value, percentile] of [
    ['server-session-start-ack-p50', summary.median, 0.5],
    ['server-session-start-ack-p95', summary.p95, 0.95],
    ['server-session-start-ack-p99', summary.p99, 0.99],
  ] as const) {
    emitPerfMetric({
      name,
      value,
      unit: 'ms/acknowledged-session',
      direction: 'lower',
      percentile,
      sampleSize: result.samples.length,
    });
  }
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
  process.stdout.write(
    `server session start -> accepted command_ack: iterations=${iterations} ` +
      `p50=${summary.median.toFixed(3)}ms p95=${summary.p95.toFixed(3)}ms ` +
      `p99=${summary.p99.toFixed(3)}ms\n`,
  );
  if (baselineArtifact !== null) {
    const comparison = compareSessionStartBenchmarkArtifacts(baselineArtifact, artifact);
    const regressionPercentiles = sessionStartRegressionPercentiles(
      comparison,
      allowedRegressionPercent,
    );
    process.stdout.write(
      `${JSON.stringify({
        benchmarkComparison: SESSION_START_BENCHMARK_NAME,
        baselineArtifactPath,
        allowedRegressionPercent,
        regressionPercentiles,
        ...comparison,
      })}\n`,
    );
    process.stdout.write(
      `pre-cut baseline change: p50=${formatPercent(comparison.p50ChangePercent)} ` +
        `p95=${formatPercent(comparison.p95ChangePercent)} ` +
        `p99=${formatPercent(comparison.p99ChangePercent)}\n`,
    );
    if (regressionPercentiles.length > 0) {
      throw new Error(
        `session-start acknowledgement regression exceeded ${allowedRegressionPercent}% at ` +
          regressionPercentiles.join(', '),
      );
    }
  }
} finally {
  await cleanupBenchmarkKeys();
}

class BenchmarkControlSocket implements DaemonControlSocket {
  private registration: DaemonControlRegisteredMessage | null = null;
  sessionStartCount = 0;
  acknowledgedCommandCount = 0;

  constructor(private readonly acknowledgementQueue: Queue.Queue<string>) {}

  sendText(payload: string): number {
    const byteLength = new TextEncoder().encode(payload).byteLength;
    if (byteLength > MAX_DAEMON_CONTROL_FRAME_BYTES) {
      throw new Error(`Control service emitted an oversized ${byteLength}-byte frame`);
    }
    const message = parseDaemonControlServerMessage(payload);
    if (message === null) {
      throw new Error('Control service emitted a non-canonical daemon-control frame');
    }
    if (message.type === 'registered') {
      if (this.registration !== null) {
        throw new Error('Control service emitted duplicate registered frames');
      }
      this.registration = message;
      return byteLength;
    }
    if (message.type === 'lease' || message.type === 'revocation') {
      return byteLength;
    }
    if (message.type !== 'session_start') {
      throw new Error(`Control benchmark received unexpected server frame: ${message.type}`);
    }
    if (!Queue.offerUnsafe(this.acknowledgementQueue, message.commandId)) {
      return -1;
    }
    this.sessionStartCount += 1;
    return byteLength;
  }

  close(): void {
    // DaemonControlService.shutdown owns the synthetic socket's lifecycle.
  }

  requireRegistration(): DaemonControlRegisteredMessage {
    if (this.registration === null) {
      throw new Error('Control service did not register the benchmark socket');
    }
    return this.registration;
  }

  recordAcknowledgedCommand(): void {
    this.acknowledgedCommandCount += 1;
  }
}

function runAcknowledgedSessionStart(
  control: DaemonControlService,
  queue: Queue.Queue<string>,
  socket: BenchmarkControlSocket,
  input: DaemonControlSessionStartInput,
): Effect.Effect<void, unknown> {
  const acknowledge = Effect.gen(function* () {
    const commandId = yield* Queue.take(queue);
    yield* control.receive(
      connectionId,
      encodeDaemonControlMessage(
        createDaemonControlCommandAckMessage(commandId, { status: 'accepted' }),
      ),
    );
    socket.recordAcknowledgedCommand();
  });
  return Effect.all([control.startSession(input), acknowledge], {
    concurrency: 'unbounded',
    discard: true,
  });
}

function matchesRegistration(
  presence: DaemonPresence,
  registered: DaemonControlRegisteredMessage,
): boolean {
  return (
    presence.daemonId === daemonId &&
    presence.userId === userId &&
    presence.connectionId === registered.connectionId &&
    presence.presenceId === registered.presenceId &&
    presence.claimSeq === registered.claimSeq
  );
}

async function readBaselineArtifact(path: string): Promise<SessionStartBenchmarkArtifact> {
  if (path.length === 0) {
    throw new Error('SESSION_START_BASELINE_ARTIFACT must not be empty');
  }
  const artifact = parseSessionStartBenchmarkArtifactOutput(await readFile(path, 'utf8'));
  if (artifact === null) {
    throw new Error(
      `${path} does not contain an exact ${SESSION_START_BENCHMARK_NAME} artifact ` +
        `with boundary ${SESSION_START_MEASUREMENT_BOUNDARY}`,
    );
  }
  return artifact;
}

function readNonNegativeFinite(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

async function cleanupBenchmarkKeys(): Promise<void> {
  const client = new RedisClient(redisUrl);
  await client.connect();
  try {
    const keys = [
      `merkur:control:daemon-claim:${daemonId}:${presenceId}`,
      `merkur:control:daemon-claims:${daemonId}`,
      `merkur:control:user-online-daemons:${userId}`,
      `merkur:sessions:claim:${daemonId}:${claimSeq}:${presenceId}`,
    ];
    await client.del(...keys);
    if (claimSeq > 0) {
      await client.zrem(
        'merkur:control:daemon-presence-deadlines',
        JSON.stringify({
          daemonId,
          userId,
          presenceId,
          claimSeq,
        }),
      );
    }
  } finally {
    client.close();
  }
}

function testConfig(configuredRedisUrl: string): ServerConfig {
  const { signingKey, verifyKey } = deriveSessionAuthorizationKeyPair(new Uint8Array(32));
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
    sessionTokenSigningKey: signingKey,
    sessionTokenVerifyKeyB64: Buffer.from(verifyKey).toString('base64url'),
    sessionTokenTtlMs: 60_000,
    webPushVapidPublicKey: undefined,
    webPushVapidPrivateKey: undefined,
    webPushContact: undefined,
    edgeRegistrationKeys: new Map(),
  };
}
