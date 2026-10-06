import { createECDH, timingSafeEqual } from 'node:crypto';
import {
  deriveSessionAuthorizationKeyPair,
  type MlDsa87SigningKey,
  SESSION_AUTHORIZATION_MAX_LIFETIME_MS,
  SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES,
  SESSION_AUTHORIZATION_SEED_BYTES,
  validateOpaqueServerSetup,
} from '@merkur/auth';
import { Context, Data, Effect, Layer, type LogLevel, Option, Redacted } from 'effect';

import { serverEnvironment } from './server-environment';

const TOKEN_HMAC_SECRET_BYTES = 64;
const TOKEN_HMAC_SECRET_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const EDGE_REGISTRATION_KEY_BYTES = 64;
const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SESSION_TOKEN_TTL_MS = SESSION_AUTHORIZATION_MAX_LIFETIME_MS;
export const MIN_SESSION_TOKEN_TTL_MS = 2_000;
const MAX_TRUSTED_PROXY_HOPS = 8;
const DEFAULT_RESEND_API_URL = 'https://api.resend.com';
const AUTH_IDENTITIES = ['username', 'email'] as const;

/**
 * Trace sampling threshold. Spans declared below this level are never sampled,
 * and an unsampled span forces its descendants unsampled too.
 *
 * `Info` is the default because the two highest-volume spans in the server —
 * `redis.operation`, which wraps every Redis command, and the health-route
 * spans, which fire on every platform poll — are declared at `Debug`. Raising
 * the threshold to `Debug` turns them on without a code change, which is what
 * makes them reachable during an incident rather than only after a deploy.
 */

/**
 * Tail sampling. A trace is kept when it contains a failure, when its root is at least this
 * slow, or when it reached a daemon; otherwise it is kept with probability
 * `TRACE_SAMPLE_RATIO`.
 *
 * The ratio defaults to 1 — keep everything — so enabling tail sampling is a deliberate act
 * rather than a silent reduction in what the backend receives. Turn it down when volume
 * warrants; the always-keep rules mean the interesting traces survive whatever it is set to.
 */
const TRACE_LEVELS: readonly LogLevel.LogLevel[] = [
  'All',
  'Fatal',
  'Error',
  'Warn',
  'Info',
  'Debug',
  'Trace',
  'None',
];

/**
 * OTLP export to Axiom. Present only when the whole group is configured; see
 * {@link ServerConfig.telemetry}.
 */
export interface TelemetryConfig {
  /** Axiom API token, sent as `Authorization: Bearer`. */
  readonly axiomToken: Redacted.Redacted<string>;
  /** Dataset receiving traces and logs (`X-Axiom-Dataset`). */
  readonly axiomDataset: string;
  /**
   * Dataset receiving metrics (`X-Axiom-Metrics-Dataset`). Separate from the
   * traces/logs dataset because Axiom's metrics intake uses a different header
   * and accepts only protobuf.
   */
  readonly axiomMetricsDataset: string;
  /**
   * Dataset receiving browser profiling rows (`/v1/ingest/{dataset}`).
   *
   * Deliberately not an OTLP signal. Profiling rows are wide, high-volume and
   * high-cardinality; wrapping each in a span envelope would multiply the bytes
   * and put per-render cardinality into a store that has no eviction path.
   * Axiom's native ingest takes them as plain NDJSON rows instead.
   *
   * Note the free tier allows exactly three datasets. With traces/logs and
   * metrics already taken, this is the third and last.
   */
  readonly axiomPerfDataset: string;
  /** OTLP base URL; `/v1/traces`, `/v1/logs` and `/v1/metrics` are appended. */
  readonly axiomEndpoint: string;
  /** Value of the `deployment.environment.name` resource attribute. */
  readonly environment: string;
}

/**
 * What an account is named by. `username` is any 3-254 character name and
 * sends no mail; `email` accepts only an address, and an account exists only
 * after a code mailed to it came back.
 */
export type AuthIdentity = (typeof AUTH_IDENTITIES)[number];

/** Resend delivery for sign-up codes. Present exactly when identity is `email`. */
export interface EmailDeliveryConfig {
  /** Resend API key, sent as `Authorization: Bearer`. */
  readonly resendApiKey: Redacted.Redacted<string>;
  /** The `from` header, e.g. `Merkur <signin@merkur.sh>`. */
  readonly from: string;
  /** Resend API base URL; `/emails` is appended. */
  readonly resendApiUrl: string;
}

/**
 * Rybbit, the website's analytics, for the one event only the server sees: a
 * new Boxes waitlist entry. The API key marks the request as ingestion from our
 * own backend, so it lives here and never reaches the website's pages.
 */
export interface RybbitConfig {
  /** Rybbit origin; `/api/track` is appended. */
  readonly host: string;
  readonly siteId: string;
  /** Rybbit API key, sent as `Authorization: Bearer`. */
  readonly apiKey: Redacted.Redacted<string>;
}

/** The public website this server takes Boxes waitlist addresses from. */
export interface WebsiteConfig {
  /** The one origin the waitlist route accepts a post from and names in its CORS answer. */
  readonly origin: string;
  /** Where a new address is counted, or `undefined` to count nothing. */
  readonly rybbit: RybbitConfig | undefined;
}

export interface BoxHostConfig {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
  readonly timeoutMs: number;
}

export interface WebPushConfig {
  readonly publicKey: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly contact: string;
}

/** Immutable artifact pin, supplied only at the server composition boundary. */
export const OpaqueWebBuildPin = Context.Reference<string | undefined>('OpaqueWebBuildPin', {
  defaultValue: () => undefined,
});

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /**
   * Where the database is, and by scheme how it is reached: `http(s)://` or
   * `libsql://` for the libSQL server production shares between processes,
   * `file:` or `:memory:` for a local one in tests and development.
   */
  readonly dbUrl: string;
  /** Bearer credential for a remote database; unset for a local one. */
  readonly dbAuthToken: Redacted.Redacted<string> | undefined;
  readonly redisUrl: Redacted.Redacted<string>;
  readonly publicOrigin: string;
  /**
   * The public website, or `undefined` for a deployment without one: the Boxes
   * waitlist route then does not exist, rather than accepting posts from nowhere.
   */
  readonly website: WebsiteConfig | undefined;
  /** Fixed 64-byte HMAC-SHA-512 access-token authority. */
  readonly accessTokenHmacKey: Uint8Array;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly tokenHmacSecret: Redacted.Redacted<string>;
  readonly authAllowRegistration: boolean;
  readonly authIdentity: AuthIdentity;
  /**
   * Mail delivery, configured as a group. Required when `authIdentity` is
   * `email` and refused when it is `username`: a username server holding a
   * mail key it never uses is a half-configured deployment, not a spare.
   */
  readonly emailDelivery: EmailDeliveryConfig | undefined;
  /** Stable OPAQUE server setup; replacing it invalidates every password record. */
  readonly opaqueServerSetup: Redacted.Redacted<string>;
  /** Public half pinned into the web build; must match opaqueServerSetup. */
  readonly opaqueServerPublicKey: string;
  /**
   * Number of reverse proxies that append to `X-Forwarded-For` in front of this
   * server. `0` means the server is reached directly and the header is ignored
   * entirely. Every IP-keyed rate limit is only as trustworthy as this value, so
   * there is deliberately no default: an unset variable fails startup rather
   * than silently choosing between a spoofable limiter and a shared bucket.
   */
  readonly trustedProxyHops: number;
  /** Expanded ML-DSA-87 secret key, derived once at startup from the configured seed. */
  /** Expanded ML-DSA-87 key in WebAssembly memory, held for the process lifetime. */
  readonly sessionTokenSigningKey: MlDsa87SigningKey;
  /** Canonical base64url encoding of the exact 2,592-byte ML-DSA-87 public key. */
  readonly sessionTokenVerifyKeyB64: string;
  readonly sessionTokenTtlMs: number;
  readonly webPush: WebPushConfig | undefined;
  /** Distinct fixed HMAC-SHA-512 request-authentication key for every edge id. */
  readonly edgeRegistrationKeys: ReadonlyMap<string, Uint8Array>;
  /**
   * Shared secret the STUN responders verify tickets with. Sized and encoded
   * like an edge registration key so both are generated and rotated the same
   * way, and redacted for the same reason.
   */
  readonly stunTicketKey: Uint8Array;
  /**
   * Shared secret every edge verifies attach tickets with. Without a ticket the
   * edge closes a peer before it reaches the splice registry, so this key is
   * what keeps the relay from being open to anyone who knows its address.
   */
  readonly edgeAttachTicketKey: Uint8Array;
  /** `host:port` vantage points advertised to daemons. */
  readonly stunServers: readonly string[];
  /**
   * The subset of `stunServers` that runs on the box host itself. A box on that
   * host reaches them without crossing its NAT, so they are left out of a box
   * daemon's list: an observer inside the daemon's NAT realm sees its private
   * address and proves nothing about the mapping or the firewall.
   */
  readonly boxHostStunObservers: readonly string[];
  /**
   * Axiom OTLP export, or `undefined` to export nothing. Telemetry is all or
   * nothing: a partially configured group fails startup rather than silently
   * exporting a subset, matching how `TRUSTED_PROXY_HOPS` refuses to guess.
   */
  readonly telemetry: TelemetryConfig | undefined;
  /**
   * Minimum span level that is sampled. Applies whether spans are exported over
   * OTLP or printed to stdout, so the two surfaces never disagree about which
   * spans exist.
   */
  readonly traceLevel: LogLevel.LogLevel;
  /** Share of unremarkable traces kept by tail sampling, 0 to 1. */
  readonly traceSampleRatio: number;
  /** Root-span duration at or above which a trace is always kept. */
  readonly traceSlowThresholdMs: number;
  /**
   * The box host. Empty disables box creation entirely, so a
   * deployment without a box host simply has no `+` rather than a broken one.
   */
  readonly boxHost: BoxHostConfig | undefined;
}

export class ServerConfigError extends Data.TaggedError('ServerConfigError')<{
  readonly field: string;
  readonly message: string;
}> {}

export class ServerConfigService extends Context.Service<ServerConfigService, ServerConfig>()(
  'ServerConfig',
) {}

export const ServerConfigLive = Layer.effect(
  ServerConfigService,
  Effect.gen(function* () {
    const host = yield* serverEnvironment.HOST.config;
    const configuredPort = yield* serverEnvironment.PORT.config;
    const port = yield* validatePort(configuredPort);
    const dbUrl = yield* validateDatabaseUrl(yield* serverEnvironment.DB_URL.config);
    const dbAuthToken = yield* revealOptionalSecret(
      yield* serverEnvironment.DB_AUTH_TOKEN.config,
      'DB_AUTH_TOKEN',
    );
    const redisUrl = yield* validateRedisUrl(
      yield* revealRequiredSecret(yield* serverEnvironment.REDIS_URL.config, 'REDIS_URL'),
    );
    const publicOriginRaw = yield* serverEnvironment.PUBLIC_ORIGIN.config;
    const publicOrigin = yield* parsePublicOrigin(publicOriginRaw);
    const website = yield* buildWebsiteConfig({
      siteOrigin: Option.getOrUndefined(yield* serverEnvironment.SITE_ORIGIN.config),
      rybbitHost: Option.getOrUndefined(yield* serverEnvironment.RYBBIT_HOST.config),
      rybbitSiteId: Option.getOrUndefined(yield* serverEnvironment.RYBBIT_SITE_ID.config),
      rybbitApiKey: yield* revealOptionalSecret(
        yield* serverEnvironment.RYBBIT_API_KEY.config,
        'RYBBIT_API_KEY',
      ),
    });
    const accessTokenHmacKeyRaw = yield* revealRequiredSecret(
      yield* serverEnvironment.ACCESS_TOKEN_HMAC_KEY.config,
      'ACCESS_TOKEN_HMAC_KEY',
    );
    const accessTokenHmacKey = yield* parseAccessTokenHmacKey(accessTokenHmacKeyRaw);
    const jwtIssuer = yield* serverEnvironment.JWT_ISSUER.config;
    const jwtAudience = yield* serverEnvironment.JWT_AUDIENCE.config;
    const tokenHmacSecretRaw = yield* revealRequiredSecret(
      yield* serverEnvironment.TOKEN_HMAC_SECRET.config,
      'TOKEN_HMAC_SECRET',
    );
    const tokenHmacSecret = yield* validateTokenHmacSecret(tokenHmacSecretRaw);
    const authAllowRegistration = yield* serverEnvironment.AUTH_ALLOW_REGISTRATION.config;
    const authIdentity = yield* parseAuthIdentity(yield* serverEnvironment.AUTH_IDENTITY.config);
    const emailDelivery = yield* buildEmailDeliveryConfig(authIdentity, {
      resendApiKey: yield* revealOptionalSecret(
        yield* serverEnvironment.RESEND_API_KEY.config,
        'RESEND_API_KEY',
      ),
      from: Option.getOrUndefined(yield* serverEnvironment.EMAIL_FROM.config),
      resendApiUrl: Option.getOrUndefined(yield* serverEnvironment.RESEND_API_URL.config),
    });
    const opaqueServerSetupRaw = yield* revealRequiredSecret(
      yield* serverEnvironment.OPAQUE_SERVER_SETUP.config,
      'OPAQUE_SERVER_SETUP',
    );
    const opaqueServerPublicKeyRaw = yield* revealRequiredSecret(
      yield* serverEnvironment.OPAQUE_SERVER_PUBLIC_KEY.config,
      'OPAQUE_SERVER_PUBLIC_KEY',
    );
    // The composition boundary provides Docker's immutable artifact pin.
    // Source and standalone builds read the VITE value through Effect Config.
    const opaqueWebPublicKeyRaw =
      (yield* OpaqueWebBuildPin) ??
      (yield* serverEnvironment.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY.config);
    const opaque = yield* parseOpaqueServerConfiguration(
      opaqueServerSetupRaw,
      opaqueServerPublicKeyRaw,
      opaqueWebPublicKeyRaw,
    );
    const trustedProxyHops = yield* validateTrustedProxyHops(
      yield* serverEnvironment.TRUSTED_PROXY_HOPS.config,
    );
    const sessionTokenSeed = yield* revealRequiredSecret(
      yield* serverEnvironment.SESSION_TOKEN_MLDSA87_SEED.config,
      'SESSION_TOKEN_MLDSA87_SEED',
    );
    const sessionTokenKeys = yield* parseSessionTokenSeed(sessionTokenSeed);
    // Validity window for the ML-DSA-87 session authorization a browser carries to a
    // daemon. Every reconnect requests a fresh token, so this stays short.
    const sessionTokenTtlMsRaw = yield* serverEnvironment.SESSION_TOKEN_TTL_MS.config;
    const sessionTokenTtlMs = yield* validateSessionTokenTtl(sessionTokenTtlMsRaw);
    const boxHostUrl = yield* serverEnvironment.BOX_HOST_URL.config;
    const boxHostToken =
      (yield* revealOptionalSecret(
        yield* serverEnvironment.BOX_HOST_TOKEN.config,
        'BOX_HOST_TOKEN',
      )) ?? '';
    // Creating a box clones an image, boots it, and waits for its daemon to
    // emit a link code, so the ceiling is much higher than a normal API call.
    const boxHostTimeoutMs = yield* serverEnvironment.BOX_HOST_TIMEOUT_MS.config;
    const boxHost = yield* validateBoxHost(boxHostUrl, boxHostToken, boxHostTimeoutMs);
    const webPushVapidPublicKey = Option.getOrUndefined(
      yield* serverEnvironment.WEB_PUSH_VAPID_PUBLIC_KEY.config,
    );
    const webPushVapidPrivateKey = yield* revealOptionalSecret(
      yield* serverEnvironment.WEB_PUSH_VAPID_PRIVATE_KEY.config,
      'WEB_PUSH_VAPID_PRIVATE_KEY',
    );
    const webPushContact = Option.getOrUndefined(yield* serverEnvironment.WEB_PUSH_CONTACT.config);

    const webPush = yield* validateWebPush(
      webPushVapidPublicKey,
      webPushVapidPrivateKey,
      webPushContact,
    );

    const edgeRegistrationKeysRaw = yield* revealRequiredSecret(
      yield* serverEnvironment.EDGE_REGISTRATION_KEYS_JSON.config,
      'EDGE_REGISTRATION_KEYS_JSON',
    );
    const edgeRegistrationKeys = yield* parseEdgeRegistrationKeys(edgeRegistrationKeysRaw);

    const stunTicketKeyRaw = yield* revealRequiredSecret(
      yield* serverEnvironment.STUN_TICKET_KEY.config,
      'STUN_TICKET_KEY',
    );
    const stunTicketKey = yield* parseDeploymentKey(stunTicketKeyRaw, 'STUN_TICKET_KEY');
    const edgeAttachTicketKeyRaw = yield* revealRequiredSecret(
      yield* serverEnvironment.EDGE_ATTACH_TICKET_KEY.config,
      'EDGE_ATTACH_TICKET_KEY',
    );
    const edgeAttachTicketKey = yield* parseDeploymentKey(
      edgeAttachTicketKeyRaw,
      'EDGE_ATTACH_TICKET_KEY',
    );
    const stunServers = yield* parseStunServers(yield* serverEnvironment.STUN_SERVERS.config);
    const boxHostStunObservers = yield* parseBoxHostStunObservers(
      yield* serverEnvironment.BOX_HOST_STUN_OBSERVERS.config,
      stunServers,
    );

    const axiomToken = yield* revealOptionalSecret(
      yield* serverEnvironment.AXIOM_TOKEN.config,
      'AXIOM_TOKEN',
    );
    const axiomDataset = Option.getOrUndefined(yield* serverEnvironment.AXIOM_DATASET.config);
    const axiomMetricsDataset = Option.getOrUndefined(
      yield* serverEnvironment.AXIOM_METRICS_DATASET.config,
    );
    const axiomPerfDataset = Option.getOrUndefined(
      yield* serverEnvironment.AXIOM_PERF_DATASET.config,
    );
    const axiomEndpoint = yield* serverEnvironment.AXIOM_ENDPOINT.config;
    const telemetryEnvironment = yield* serverEnvironment.TELEMETRY_ENVIRONMENT.config;
    const traceLevel = yield* parseTraceLevel(yield* serverEnvironment.TRACE_LEVEL.config);
    const traceSampleRatio = yield* parseTraceSampleRatio(
      yield* serverEnvironment.TRACE_SAMPLE_RATIO.config,
    );
    const traceSlowThresholdMs = yield* parseTraceSlowThreshold(
      yield* serverEnvironment.TRACE_SLOW_THRESHOLD_MS.config,
    );
    const telemetry = yield* buildTelemetryConfig({
      axiomToken,
      axiomDataset,
      axiomMetricsDataset,
      axiomPerfDataset,
      axiomEndpoint,
      environment: telemetryEnvironment,
    });

    return {
      host,
      port,
      dbUrl,
      dbAuthToken: dbAuthToken === undefined ? undefined : Redacted.make(dbAuthToken),
      redisUrl,
      publicOrigin,
      website,
      accessTokenHmacKey,
      jwtIssuer,
      jwtAudience,
      tokenHmacSecret: Redacted.make(tokenHmacSecret),
      authAllowRegistration,
      authIdentity,
      emailDelivery,
      opaqueServerSetup: Redacted.make(opaque.serverSetup),
      opaqueServerPublicKey: opaque.serverPublicKey,
      trustedProxyHops,
      stunTicketKey,
      edgeAttachTicketKey,
      stunServers,
      boxHostStunObservers,
      boxHost,
      sessionTokenSigningKey: sessionTokenKeys.signingKey,
      sessionTokenVerifyKeyB64: sessionTokenKeys.verifyKeyB64,
      sessionTokenTtlMs,
      webPush,
      edgeRegistrationKeys,
      telemetry,
      traceLevel,
      traceSampleRatio,
      traceSlowThresholdMs,
    } satisfies ServerConfig;
  }),
);

export const loadServerConfig = Effect.gen(function* () {
  return yield* ServerConfigService;
}).pipe(Effect.provide(ServerConfigLive));

/**
 * Telemetry is configured as a group or not at all. Exporting traces while
 * silently dropping metrics — because only one dataset was supplied — is the
 * kind of half-configured state that is discovered weeks later, so a partial
 * group is a startup failure.
 */
function buildTelemetryConfig(fields: {
  readonly axiomToken: string | undefined;
  readonly axiomDataset: string | undefined;
  readonly axiomMetricsDataset: string | undefined;
  readonly axiomPerfDataset: string | undefined;
  readonly axiomEndpoint: string;
  readonly environment: string;
}): Effect.Effect<TelemetryConfig | undefined, ServerConfigError> {
  const group = [
    ['AXIOM_TOKEN', fields.axiomToken],
    ['AXIOM_DATASET', fields.axiomDataset],
    ['AXIOM_METRICS_DATASET', fields.axiomMetricsDataset],
    ['AXIOM_PERF_DATASET', fields.axiomPerfDataset],
  ] as const;

  const missing = group.filter(([, value]) => value === undefined);
  if (missing.length === group.length) {
    return Effect.succeed(undefined);
  }
  const firstMissing = missing[0];
  if (firstMissing !== undefined) {
    return Effect.fail(
      new ServerConfigError({
        field: firstMissing[0],
        message:
          'Axiom telemetry requires AXIOM_TOKEN, AXIOM_DATASET, AXIOM_METRICS_DATASET and AXIOM_PERF_DATASET together',
      }),
    );
  }

  const endpoint = normalizeHttpEndpoint(fields.axiomEndpoint);
  if (endpoint === null) {
    return Effect.fail(
      new ServerConfigError({
        field: 'AXIOM_ENDPOINT',
        message: 'AXIOM_ENDPOINT must be an absolute http(s) origin',
      }),
    );
  }

  const [, token] = group[0];
  const [, dataset] = group[1];
  const [, metricsDataset] = group[2];
  const [, perfDataset] = group[3];
  if (
    token === undefined ||
    dataset === undefined ||
    metricsDataset === undefined ||
    perfDataset === undefined
  ) {
    return Effect.fail(
      new ServerConfigError({
        field: 'AXIOM_TOKEN',
        message: 'Axiom telemetry configuration is incomplete',
      }),
    );
  }

  return Effect.succeed({
    axiomToken: Redacted.make(token),
    axiomDataset: dataset,
    axiomMetricsDataset: metricsDataset,
    axiomPerfDataset: perfDataset,
    axiomEndpoint: endpoint,
    environment: fields.environment,
  });
}

function parseAuthIdentity(value: string): Effect.Effect<AuthIdentity, ServerConfigError> {
  const identity = AUTH_IDENTITIES.find((candidate) => candidate === value);
  if (identity !== undefined) return Effect.succeed(identity);
  return Effect.fail(
    new ServerConfigError({
      field: 'AUTH_IDENTITY',
      message: `AUTH_IDENTITY must be one of ${AUTH_IDENTITIES.join(', ')}`,
    }),
  );
}

/**
 * Email identity cannot run without delivery, and username identity must not
 * carry it: either mismatch fails startup rather than surfacing when the first
 * sign-up waits for a code that never comes.
 */
function buildEmailDeliveryConfig(
  identity: AuthIdentity,
  fields: {
    readonly resendApiKey: string | undefined;
    readonly from: string | undefined;
    readonly resendApiUrl: string | undefined;
  },
): Effect.Effect<EmailDeliveryConfig | undefined, ServerConfigError> {
  if (identity === 'username') {
    const present = (
      [
        ['RESEND_API_KEY', fields.resendApiKey],
        ['EMAIL_FROM', fields.from],
        ['RESEND_API_URL', fields.resendApiUrl],
      ] as const
    ).find(([, value]) => value !== undefined);
    if (present === undefined) return Effect.succeed(undefined);
    return Effect.fail(
      new ServerConfigError({
        field: present[0],
        message: `${present[0]} is only valid with AUTH_IDENTITY=email`,
      }),
    );
  }
  const { resendApiKey, from } = fields;
  if (resendApiKey === undefined || from === undefined) {
    return Effect.fail(
      new ServerConfigError({
        field: resendApiKey === undefined ? 'RESEND_API_KEY' : 'EMAIL_FROM',
        message: 'AUTH_IDENTITY=email requires RESEND_API_KEY and EMAIL_FROM',
      }),
    );
  }
  const resendApiUrl = normalizeHttpEndpoint(fields.resendApiUrl ?? DEFAULT_RESEND_API_URL);
  if (resendApiUrl === null) {
    return Effect.fail(
      new ServerConfigError({
        field: 'RESEND_API_URL',
        message: 'RESEND_API_URL must be an absolute http(s) URL',
      }),
    );
  }
  return Effect.succeed({ resendApiKey: Redacted.make(resendApiKey), from, resendApiUrl });
}

/** Trailing slashes are stripped so request paths concatenate cleanly. */
function normalizeHttpEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
      return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function revealRequiredSecret(
  secret: Redacted.Redacted<string>,
  field: string,
): Effect.Effect<string, ServerConfigError> {
  const value = Redacted.value(secret);
  return value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new ServerConfigError({
          field,
          message: `${field} must not be empty`,
        }),
      );
}

function revealOptionalSecret(
  secret: Option.Option<Redacted.Redacted<string>>,
  field: string,
): Effect.Effect<string | undefined, ServerConfigError> {
  if (Option.isNone(secret)) {
    return Effect.succeed(undefined);
  }
  return revealRequiredSecret(secret.value, field).pipe(Effect.map((value) => value));
}

function parseSessionTokenSeed(
  encodedSeed: string,
): Effect.Effect<{ signingKey: MlDsa87SigningKey; verifyKeyB64: string }, ServerConfigError> {
  return Effect.try({
    try: () => {
      if (encodedSeed.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(encodedSeed)) {
        throw new ServerConfigError({
          field: 'SESSION_TOKEN_MLDSA87_SEED',
          message: 'SESSION_TOKEN_MLDSA87_SEED must be canonical base64url for 32 bytes',
        });
      }
      const seed = Buffer.from(encodedSeed, 'base64url');
      try {
        if (
          seed.byteLength !== SESSION_AUTHORIZATION_SEED_BYTES ||
          seed.toString('base64url') !== encodedSeed
        ) {
          throw new ServerConfigError({
            field: 'SESSION_TOKEN_MLDSA87_SEED',
            message: 'SESSION_TOKEN_MLDSA87_SEED must be canonical base64url for 32 bytes',
          });
        }
        const { signingKey, verifyKey } = deriveSessionAuthorizationKeyPair(seed);
        if (verifyKey.byteLength !== SESSION_AUTHORIZATION_PUBLIC_KEY_BYTES) {
          throw new Error('ML-DSA-87 returned an invalid public-key length');
        }
        return { signingKey, verifyKeyB64: Buffer.from(verifyKey).toString('base64url') };
      } finally {
        seed.fill(0);
      }
    },
    catch: (error) =>
      error instanceof ServerConfigError
        ? error
        : new ServerConfigError({
            field: 'SESSION_TOKEN_MLDSA87_SEED',
            message: 'Cannot derive SESSION_TOKEN_MLDSA87_SEED signing key',
          }),
  });
}

function validatePort(value: number): Effect.Effect<number, ServerConfigError> {
  if (Number.isSafeInteger(value) && value >= 1 && value <= 65_535) {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new ServerConfigError({
      field: 'PORT',
      message: 'PORT must be an integer from 1 to 65535',
    }),
  );
}

function validateDatabaseUrl(value: string): Effect.Effect<string, ServerConfigError> {
  return Effect.try({
    try: () => {
      if (value === ':memory:' || (value.startsWith('file:') && value.length > 5)) return value;
      const url = new URL(value);
      if (
        !['http:', 'https:', 'libsql:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('invalid database URL');
      return value;
    },
    catch: () =>
      new ServerConfigError({
        field: 'DB_URL',
        message:
          'DB_URL must be a local file: URL, :memory:, or an HTTP(S)/libsql URL without credentials or fragments',
      }),
  });
}

function validateRedisUrl(
  value: string,
): Effect.Effect<Redacted.Redacted<string>, ServerConfigError> {
  return Effect.try({
    try: () => {
      const url = new URL(value);
      if (
        !['redis:', 'rediss:'].includes(url.protocol) ||
        !url.hostname ||
        url.search ||
        url.hash ||
        (url.port !== '' &&
          (!Number.isInteger(Number(url.port)) ||
            Number(url.port) < 1 ||
            Number(url.port) > 65_535)) ||
        (url.pathname !== '' && url.pathname !== '/' && !/^\/[0-9]+$/.test(url.pathname))
      )
        throw new Error('invalid Redis URL');
      return Redacted.make(value);
    },
    catch: () =>
      new ServerConfigError({
        field: 'REDIS_URL',
        message:
          'REDIS_URL must be a redis:// or rediss:// URL with a valid port and optional database number',
      }),
  });
}

function validateBoxHost(
  url: string,
  token: string,
  timeoutMs: number,
): Effect.Effect<BoxHostConfig | undefined, ServerConfigError> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    return new ServerConfigError({
      field: 'BOX_HOST_TIMEOUT_MS',
      message: 'BOX_HOST_TIMEOUT_MS must be a positive integer no greater than 2147483647',
    });
  }
  if (url === '' && token === '') return Effect.succeed(undefined);
  if (url === '' || token === '') {
    return new ServerConfigError({
      field: url === '' ? 'BOX_HOST_URL' : 'BOX_HOST_TOKEN',
      message: 'BOX_HOST_URL and BOX_HOST_TOKEN must be configured together',
    });
  }
  return parsePublicOrigin(url).pipe(
    Effect.mapError(
      () =>
        new ServerConfigError({
          field: 'BOX_HOST_URL',
          message:
            'BOX_HOST_URL must be a canonical HTTP(S) origin without credentials, path, query, or fragment',
        }),
    ),
    Effect.map((origin) => ({ url: origin, token: Redacted.make(token), timeoutMs })),
  );
}

/**
 * The website is configured or it is not, and so is its analytics: Rybbit's
 * three variables come together, and only for a website to count joins of.
 */
function buildWebsiteConfig(fields: {
  readonly siteOrigin: string | undefined;
  readonly rybbitHost: string | undefined;
  readonly rybbitSiteId: string | undefined;
  readonly rybbitApiKey: string | undefined;
}): Effect.Effect<WebsiteConfig | undefined, ServerConfigError> {
  const origin = (value: string, field: 'SITE_ORIGIN' | 'RYBBIT_HOST') =>
    parsePublicOrigin(value).pipe(
      Effect.mapError(
        () =>
          new ServerConfigError({
            field,
            message: `${field} must be a canonical HTTP(S) origin without credentials, path, query, fragment, or trailing slash`,
          }),
      ),
    );
  const rybbit = [
    ['RYBBIT_HOST', fields.rybbitHost],
    ['RYBBIT_SITE_ID', fields.rybbitSiteId],
    ['RYBBIT_API_KEY', fields.rybbitApiKey],
  ] as const;
  const set = rybbit.filter(([, value]) => value !== undefined);
  const missing = rybbit.find(([, value]) => value === undefined);
  if (set.length > 0 && missing !== undefined) {
    return new ServerConfigError({
      field: missing[0],
      message: 'RYBBIT_HOST, RYBBIT_SITE_ID and RYBBIT_API_KEY must be configured together',
    });
  }
  if (fields.siteOrigin === undefined) {
    return set.length === 0
      ? Effect.succeed(undefined)
      : new ServerConfigError({
          field: 'SITE_ORIGIN',
          message: 'Rybbit counts joins of the website; SITE_ORIGIN must be configured with it',
        });
  }
  const { rybbitHost, rybbitSiteId, rybbitApiKey } = fields;
  return Effect.gen(function* () {
    const site = yield* origin(fields.siteOrigin ?? '', 'SITE_ORIGIN');
    if (rybbitHost === undefined || rybbitSiteId === undefined || rybbitApiKey === undefined) {
      return { origin: site, rybbit: undefined };
    }
    return {
      origin: site,
      rybbit: {
        host: yield* origin(rybbitHost, 'RYBBIT_HOST'),
        siteId: rybbitSiteId,
        apiKey: Redacted.make(rybbitApiKey),
      },
    };
  });
}

function validateWebPush(
  publicKey: string | undefined,
  privateKey: string | undefined,
  contact: string | undefined,
): Effect.Effect<WebPushConfig | undefined, ServerConfigError> {
  if (publicKey === undefined && privateKey === undefined && contact === undefined)
    return Effect.succeed(undefined);
  return Effect.try({
    try: () => {
      if (publicKey === undefined || privateKey === undefined || contact === undefined)
        throw new Error('incomplete');
      const publicBytes = Buffer.from(publicKey, 'base64url');
      const privateBytes = Buffer.from(privateKey, 'base64url');
      try {
        if (
          publicBytes.length !== 65 ||
          publicBytes[0] !== 4 ||
          publicBytes.toString('base64url') !== publicKey ||
          privateBytes.length !== 32 ||
          privateBytes.toString('base64url') !== privateKey
        )
          throw new Error('invalid key');
        const ecdh = createECDH('prime256v1');
        ecdh.setPrivateKey(privateBytes);
        if (!timingSafeEqual(ecdh.getPublicKey(), publicBytes)) throw new Error('mismatched key');
        const url = new URL(contact);
        if (url.protocol === 'mailto:') {
          if (!url.pathname.includes('@') || url.search || url.hash)
            throw new Error('invalid contact');
        } else if (
          url.protocol !== 'https:' ||
          !url.hostname ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error('invalid contact');
        return { publicKey, privateKey: Redacted.make(privateKey), contact };
      } finally {
        privateBytes.fill(0);
      }
    },
    catch: () =>
      new ServerConfigError({
        field: 'WEB_PUSH_VAPID_PUBLIC_KEY',
        message:
          'Web push requires a matching canonical P-256 VAPID keypair and a mailto: or HTTPS contact together',
      }),
  });
}

function validStunEndpoint(value: string): boolean {
  try {
    const url = new URL(`http://${value}`);
    return (
      url.hostname !== '' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      `${url.hostname}:${url.port || 80}` === value &&
      Number(url.port || 80) >= 1 &&
      Number(url.port || 80) <= 65_535
    );
  } catch {
    return false;
  }
}

function validateTrustedProxyHops(value: number): Effect.Effect<number, ServerConfigError> {
  if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_TRUSTED_PROXY_HOPS) {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new ServerConfigError({
      field: 'TRUSTED_PROXY_HOPS',
      message: `TRUSTED_PROXY_HOPS must be an integer from 0 to ${MAX_TRUSTED_PROXY_HOPS}`,
    }),
  );
}

function parsePublicOrigin(value: string): Effect.Effect<string, ServerConfigError> {
  return Effect.try({
    try: () => {
      const url = new URL(value);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.pathname !== '/' ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        url.origin !== value
      ) {
        throw new Error('not a canonical HTTP(S) origin');
      }
      return url.origin;
    },
    catch: () =>
      new ServerConfigError({
        field: 'PUBLIC_ORIGIN',
        message:
          'PUBLIC_ORIGIN must be a canonical HTTP(S) origin without credentials, path, query, fragment, or trailing slash',
      }),
  });
}

function validateTokenHmacSecret(value: string): Effect.Effect<string, ServerConfigError> {
  const decoded = Buffer.from(value, 'base64url');
  try {
    if (
      TOKEN_HMAC_SECRET_PATTERN.test(value) &&
      decoded.byteLength === TOKEN_HMAC_SECRET_BYTES &&
      decoded.toString('base64url') === value
    ) {
      return Effect.succeed(value);
    }
    return Effect.fail(
      new ServerConfigError({
        field: 'TOKEN_HMAC_SECRET',
        message: 'TOKEN_HMAC_SECRET must be canonical base64url for exactly 64 random bytes',
      }),
    );
  } finally {
    decoded.fill(0);
  }
}

function parseOpaqueServerConfiguration(
  serverSetup: string,
  serverPublicKey: string,
  webPublicKey: string,
): Effect.Effect<
  { readonly serverSetup: string; readonly serverPublicKey: string },
  ServerConfigError
> {
  return Effect.tryPromise({
    try: async () => {
      const derived = await validateOpaqueServerSetup(serverSetup);
      const derivedBytes = Buffer.from(derived, 'base64url');
      const configuredBytes = Buffer.from(serverPublicKey, 'base64url');
      const webBytes = Buffer.from(webPublicKey, 'base64url');
      try {
        if (
          configuredBytes.byteLength !== 32 ||
          configuredBytes.toString('base64url') !== serverPublicKey ||
          !timingSafeEqual(derivedBytes, configuredBytes)
        ) {
          throw new ServerConfigError({
            field: 'OPAQUE_SERVER_PUBLIC_KEY',
            message: 'OPAQUE_SERVER_PUBLIC_KEY must be canonical and match OPAQUE_SERVER_SETUP',
          });
        }
        if (
          webBytes.byteLength !== 32 ||
          webBytes.toString('base64url') !== webPublicKey ||
          !timingSafeEqual(derivedBytes, webBytes)
        ) {
          throw new ServerConfigError({
            field: 'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY',
            message:
              'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY must be canonical and match OPAQUE_SERVER_SETUP',
          });
        }
      } finally {
        derivedBytes.fill(0);
        configuredBytes.fill(0);
        webBytes.fill(0);
      }
      return { serverSetup, serverPublicKey };
    },
    catch: (error) =>
      error instanceof ServerConfigError
        ? error
        : new ServerConfigError({
            field: 'OPAQUE_SERVER_SETUP',
            message: 'OPAQUE_SERVER_SETUP must be a canonical OPAQUE server setup',
          }),
  });
}

function parseAccessTokenHmacKey(value: string): Effect.Effect<Uint8Array, ServerConfigError> {
  const decoded = Buffer.from(value, 'base64url');
  try {
    if (
      TOKEN_HMAC_SECRET_PATTERN.test(value) &&
      decoded.byteLength === TOKEN_HMAC_SECRET_BYTES &&
      decoded.toString('base64url') === value
    ) {
      return Effect.succeed(new Uint8Array(decoded));
    }
    return Effect.fail(
      new ServerConfigError({
        field: 'ACCESS_TOKEN_HMAC_KEY',
        message: 'ACCESS_TOKEN_HMAC_KEY must be canonical base64url for exactly 64 random bytes',
      }),
    );
  } finally {
    decoded.fill(0);
  }
}

/**
 * A deployment secret shared with a stateless verifier (the STUN responders,
 * the edges): exactly 64 random bytes, canonical base64url.
 *
 * Same shape as an edge registration key. Refusing anything shorter matters
 * because each key is the only thing standing between its verifier and being
 * open to anyone: an open reflector, an open relay.
 */
function parseDeploymentKey(
  value: string,
  field: 'STUN_TICKET_KEY' | 'EDGE_ATTACH_TICKET_KEY',
): Effect.Effect<Uint8Array, ServerConfigError> {
  return Effect.try({
    try: () => {
      const encoded = value.trim();
      const decoded = Buffer.from(encoded, 'base64url');
      // Canonical, not merely decodable: `Buffer` accepts several encodings of
      // the same bytes, and accepting them would mean the same secret has more
      // than one spelling across the deployments that must agree on it.
      if (
        !TOKEN_HMAC_SECRET_PATTERN.test(encoded) ||
        decoded.byteLength !== EDGE_REGISTRATION_KEY_BYTES ||
        decoded.toString('base64url') !== encoded
      ) {
        decoded.fill(0);
        throw new Error('length');
      }
      return new Uint8Array(decoded);
    },
    catch: () =>
      new ServerConfigError({
        field,
        message: `${field} must be a canonical base64url encoding of exactly ${EDGE_REGISTRATION_KEY_BYTES} random bytes`,
      }),
  });
}

/**
 * Comma-separated `host:port` vantage points.
 *
 * At least two, because the daemon's NAT inference produces `Unknown` from a
 * single observation and `Unknown` is what makes the reprobe drop its
 * reflexive candidate. Configuring one would look like it worked and quietly
 * disable direct-path discovery, so it is refused outright.
 */
function parseStunServers(value: string): Effect.Effect<readonly string[], ServerConfigError> {
  return Effect.try({
    try: () => {
      const servers = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (servers.length < 2) {
        throw new Error('too few');
      }
      if (new Set(servers).size !== servers.length) {
        throw new Error('duplicate');
      }
      for (const server of servers) {
        // `host:port`, where host may be a bracketed IPv6 literal.
        if (!validStunEndpoint(server)) {
          throw new Error('shape');
        }
      }
      return servers;
    },
    catch: () =>
      new ServerConfigError({
        field: 'STUN_SERVERS',
        message:
          'STUN_SERVERS must be at least two distinct comma-separated host:port vantage points; a single one leaves NAT behaviour unknowable',
      }),
  });
}

/**
 * Comma-separated entries of `STUN_SERVERS` that run on the box host, or empty.
 *
 * Each must be spelled exactly as in `STUN_SERVERS`, because the exclusion is a
 * set difference on those strings. An entry that is not there would exclude
 * nothing and leave a box classifying its NAT against its own host.
 */
function parseBoxHostStunObservers(
  value: string,
  stunServers: readonly string[],
): Effect.Effect<readonly string[], ServerConfigError> {
  const observers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const known = new Set(stunServers);
  if (
    new Set(observers).size !== observers.length ||
    observers.some((entry) => !known.has(entry))
  ) {
    return Effect.fail(
      new ServerConfigError({
        field: 'BOX_HOST_STUN_OBSERVERS',
        message:
          'BOX_HOST_STUN_OBSERVERS must list distinct entries of STUN_SERVERS, spelled exactly as there',
      }),
    );
  }
  return Effect.succeed(observers);
}

function parseEdgeRegistrationKeys(
  value: string,
): Effect.Effect<ReadonlyMap<string, Uint8Array>, ServerConfigError> {
  return Effect.try({
    try: () => {
      const decodedKeys: Uint8Array[] = [];
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('must be a JSON object');
        }
        const entries = Object.entries(parsed as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        if (entries.length === 0) throw new Error('must contain at least one edge id');

        const canonicalEntries: Array<readonly [string, string]> = [];
        const uniqueKeys = new Set<string>();
        const result = new Map<string, Uint8Array>();
        for (const [edgeId, encodedKey] of entries) {
          if (!EDGE_ID_PATTERN.test(edgeId) || typeof encodedKey !== 'string') {
            throw new Error('edge ids or key values are malformed');
          }
          const decoded = Buffer.from(encodedKey, 'base64url');
          if (
            !TOKEN_HMAC_SECRET_PATTERN.test(encodedKey) ||
            decoded.byteLength !== EDGE_REGISTRATION_KEY_BYTES ||
            decoded.toString('base64url') !== encodedKey ||
            uniqueKeys.has(encodedKey)
          ) {
            decoded.fill(0);
            throw new Error('every edge id must have a distinct canonical 64-byte key');
          }
          const key = new Uint8Array(decoded);
          decoded.fill(0);
          decodedKeys.push(key);
          uniqueKeys.add(encodedKey);
          canonicalEntries.push([edgeId, encodedKey]);
          result.set(edgeId, key);
        }
        if (JSON.stringify(Object.fromEntries(canonicalEntries)) !== value) {
          throw new Error('JSON must be minified with edge ids in lexical order');
        }
        return result;
      } catch (error) {
        for (const key of decodedKeys) key.fill(0);
        throw error;
      }
    },
    catch: () =>
      new ServerConfigError({
        field: 'EDGE_REGISTRATION_KEYS_JSON',
        message:
          'EDGE_REGISTRATION_KEYS_JSON must be a canonical JSON object mapping each edge id to a distinct canonical base64url encoding of exactly 64 random bytes',
      }),
  });
}

function parseTraceLevel(value: string): Effect.Effect<LogLevel.LogLevel, ServerConfigError> {
  const level = TRACE_LEVELS.find((candidate) => candidate === value);
  if (level !== undefined) {
    return Effect.succeed(level);
  }
  return Effect.fail(
    new ServerConfigError({
      field: 'TRACE_LEVEL',
      message: `TRACE_LEVEL must be one of ${TRACE_LEVELS.join(', ')}`,
    }),
  );
}

function parseTraceSampleRatio(value: number): Effect.Effect<number, ServerConfigError> {
  if (Number.isFinite(value) && value >= 0 && value <= 1) {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new ServerConfigError({
      field: 'TRACE_SAMPLE_RATIO',
      message: 'TRACE_SAMPLE_RATIO must be a number from 0 to 1',
    }),
  );
}

function parseTraceSlowThreshold(value: number): Effect.Effect<number, ServerConfigError> {
  if (Number.isSafeInteger(value) && value > 0) {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new ServerConfigError({
      field: 'TRACE_SLOW_THRESHOLD_MS',
      message: 'TRACE_SLOW_THRESHOLD_MS must be a positive integer number of milliseconds',
    }),
  );
}

function validateSessionTokenTtl(value: number): Effect.Effect<number, ServerConfigError> {
  if (
    Number.isSafeInteger(value) &&
    value >= MIN_SESSION_TOKEN_TTL_MS &&
    value <= MAX_SESSION_TOKEN_TTL_MS
  ) {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new ServerConfigError({
      field: 'SESSION_TOKEN_TTL_MS',
      message: `SESSION_TOKEN_TTL_MS must be an integer from ${MIN_SESSION_TOKEN_TTL_MS} to ${MAX_SESSION_TOKEN_TTL_MS}`,
    }),
  );
}
