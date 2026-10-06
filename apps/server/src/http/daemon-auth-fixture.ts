import {
  deriveSessionAuthorizationKeyPair,
  deriveSoftwareDaemonP256PublicKey,
  verifyDaemonProof,
} from '@merkur/auth';
import { Effect, Layer, Redacted } from 'effect';

import { type ServerConfig, ServerConfigService } from '../config';
import { createLogger } from '../logger';
import type { runServerProgram } from '../runtime';
import {
  type DaemonControlService,
  DaemonControlServiceTag,
} from '../services/daemon-control-service';
import { type DeviceService, DeviceServiceTag } from '../services/device-service';
import { type RateLimitService, RateLimitServiceTag } from '../services/rate-limit-service';
import { RedisError, type RedisService, RedisServiceTag } from '../services/redis-service';

export const DAEMON_TEST_SEED = Buffer.alloc(32, 0x22).toString('base64url');
const pair = deriveSessionAuthorizationKeyPair(Buffer.from(DAEMON_TEST_SEED, 'base64url'));
const publicKey = Buffer.from(pair.verifyKey).toString('base64url');
const p256PublicKey = Buffer.from(
  deriveSoftwareDaemonP256PublicKey(Buffer.from(DAEMON_TEST_SEED, 'base64url')),
).toString('base64url');
const unused = () => Effect.die(new Error('Unexpected fixture service call'));

/** Shared HTTP/WS boundary fixture; real signatures, explicit unused services. */
export function daemonAuthFixture(
  options: {
    origin?: string;
    nonces?: Set<string>;
    redisFails?: boolean;
    redis?: RedisService;
    beforeVerify?: () => Promise<void>;
    control?: Partial<DaemonControlService>;
    rateLimit?: RateLimitService;
  } = {},
) {
  const origin = options.origin ?? 'http://127.0.0.1';
  const nonces = options.nonces ?? new Set<string>();
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    dbUrl: ':memory:',
    dbAuthToken: undefined,
    redisUrl: Redacted.make('redis://localhost:6379'),
    publicOrigin: origin,
    website: undefined,
    accessTokenHmacKey: new Uint8Array(64),
    jwtIssuer: 'merkur',
    jwtAudience: 'merkur-clients',
    tokenHmacSecret: Redacted.make('test'),
    authAllowRegistration: false,
    authIdentity: 'username',
    emailDelivery: undefined,
    opaqueServerSetup: Redacted.make(''),
    opaqueServerPublicKey: '',
    trustedProxyHops: 0,
    sessionTokenSigningKey: pair.signingKey,
    sessionTokenVerifyKeyB64: publicKey,
    sessionTokenTtlMs: 60_000,
    webPush: undefined,
    edgeRegistrationKeys: new Map(),
    telemetry: undefined,
    traceLevel: 'Info',
    traceSampleRatio: 1,
    traceSlowThresholdMs: 1000,
    boxHost: undefined,
    stunTicketKey: new Uint8Array(64),
    edgeAttachTicketKey: new Uint8Array(64).fill(11),
    stunServers: ['stun.test:3478', 'stun.test:3479'],
    boxHostStunObservers: [],
  };
  const devices: DeviceService = {
    listDevices: unused,
    getDevice: unused,
    createLinkToken: unused,
    resolveBox: unused,
    listAccountBoxes: unused,
    getDaemonSessionIdentity: unused,
    renameDevice: unused,
    deleteDevice: unused,
    touchDaemon: unused,
    touchDaemonsSeen: unused,
    authenticateDaemonProof: (id, transcript, signature, purpose, p256Signature) =>
      Effect.gen(function* () {
        if (options.beforeVerify !== undefined) yield* Effect.promise(options.beforeVerify);
        return id === 'daemon-1' &&
          verifyDaemonProof(publicKey, p256PublicKey, purpose, transcript, signature, p256Signature)
          ? { daemonId: id, userId: 'user-1', boxId: null }
          : null;
      }),
  };
  const redis: RedisService = {
    useCommands: (fn) =>
      Effect.tryPromise({
        try: async () =>
          fn({
            async sendCommand<T>(args: string[]): Promise<T> {
              if (options.redisFails) throw new Error('Replay store unavailable');
              const [command, key, value, nx, px, ttl] = args;
              if (
                command !== 'SET' ||
                key === undefined ||
                value !== '1' ||
                nx !== 'NX' ||
                px !== 'PX' ||
                Number(ttl) < 120_000
              )
                throw new Error('Unexpected replay command');
              const result = nonces.has(key) ? null : 'OK';
              nonces.add(key);
              return result as T;
            },
          }),
        catch: (cause) => new RedisError({ cause, message: 'Replay store unavailable' }),
      }),
    publish: unused,
    subscribe: unused,
    unsubscribe: unused,
    healthSnapshot: unused,
  };
  const control: DaemonControlService = {
    acceptConnection: unused,
    receive: unused,
    disconnect: unused,
    pushRevocationGeneration: unused,
    startSession: unused,
    cancelSession: unused,
    flushUserDelegationRevocations: unused,
    healthSnapshot: unused,
    awaitCriticalFailure: Effect.never,
    ...options.control,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ServerConfigService, config),
    Layer.succeed(DeviceServiceTag, devices),
    Layer.succeed(RedisServiceTag, options.redis ?? redis),
    Layer.succeed(DaemonControlServiceTag, control),
    Layer.succeed(
      RateLimitServiceTag,
      options.rateLimit ?? { consume: () => Effect.succeed({ allowed: true }) },
    ),
  );
  const runProgram = ((program, runOptions) =>
    Effect.runPromise(
      Effect.provide(program as Effect.Effect<unknown, unknown, never>, layer),
      runOptions,
    )) as typeof runServerProgram;
  return { runProgram, logger: createLogger('daemon-proof-test'), origin, nonces };
}
