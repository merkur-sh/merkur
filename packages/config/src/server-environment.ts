import { Config } from 'effect';

const DEFAULT_DB_URL = 'file:./data/merkur.db';

const DEFAULT_HOST = '0.0.0.0';

const DEFAULT_PORT = 3000;

const DEFAULT_PUBLIC_ORIGIN = 'https://localhost:3000';

const DEFAULT_JWT_ISSUER = 'merkur';

const DEFAULT_JWT_AUDIENCE = 'merkur-clients';

const DEFAULT_AXIOM_ENDPOINT = 'https://api.axiom.co';

const DEFAULT_TELEMETRY_ENVIRONMENT = 'development';

const DEFAULT_TRACE_LEVEL = 'Info';

const DEFAULT_TRACE_SAMPLE_RATIO = 1;

const DEFAULT_TRACE_SLOW_THRESHOLD_MS = 1_000;

/** Server settings, parsing, ownership, and operator documentation. */
export const serverEnvironment = {
  HOST: {
    config: Config.nonEmptyString('HOST').pipe(Config.withDefault(DEFAULT_HOST)),
    required: false,
    secret: false,
    requirement: 'No',
    notes: 'HTTP server bind address.',
    example: '0.0.0.0',
  },
  PORT: {
    config: Config.int('PORT').pipe(Config.withDefault(DEFAULT_PORT)),
    required: false,
    secret: false,
    requirement: 'No',
    notes: 'HTTP server listen port.',
    example: '3000',
  },
  PUBLIC_ORIGIN: {
    config: Config.nonEmptyString('PUBLIC_ORIGIN').pipe(Config.withDefault(DEFAULT_PUBLIC_ORIGIN)),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Canonical origin browsers reach Merkur at. Set explicitly for deployments. Local setup uses http://127.0.0.1:3000. It is checked against signed browser delegations and used as the daemon linking target.',
    example: 'https://example.com',
  },
  DB_URL: {
    config: Config.nonEmptyString('DB_URL').pipe(Config.withDefault(DEFAULT_DB_URL)),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Defaults to `file:./data/merkur.db`. `file:` opens a local database in-process; `http(s)://` or `libsql://` reach a libSQL server, which is what production runs so more than one process can share one database. The compiled server carries only the network client, so a `file:` URL is refused there.',
    example: 'file:./data/merkur.db',
  },
  DB_AUTH_TOKEN: {
    config: Config.option(Config.redacted('DB_AUTH_TOKEN')),
    required: false,
    secret: true,
    requirement: 'No',
    notes: 'Bearer credential for a remote database; unset for a local one.',
    example: '',
  },
  REDIS_URL: {
    config: Config.redacted('REDIS_URL'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes: 'Redis or Dragonfly URL. Railway Dragonfly can be mapped from `DRAGONFLY_PRIVATE_URL`.',
    example: 'redis://127.0.0.1:6379',
  },
  ACCESS_TOKEN_HMAC_KEY: {
    config: Config.redacted('ACCESS_TOKEN_HMAC_KEY'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes:
      'Canonical unpadded base64url for exactly 64 random bytes. It authenticates the single fixed access-token format; there is no key id or algorithm negotiation.',
    example: '',
  },
  JWT_ISSUER: {
    config: Config.nonEmptyString('JWT_ISSUER').pipe(Config.withDefault(DEFAULT_JWT_ISSUER)),
    required: false,
    secret: false,
    requirement: 'No',
    notes: 'Access-token issuer.',
    example: '',
  },
  JWT_AUDIENCE: {
    config: Config.nonEmptyString('JWT_AUDIENCE').pipe(Config.withDefault(DEFAULT_JWT_AUDIENCE)),
    required: false,
    secret: false,
    requirement: 'No',
    notes: 'Access-token audience.',
    example: '',
  },
  TOKEN_HMAC_SECRET: {
    config: Config.redacted('TOKEN_HMAC_SECRET'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes:
      'Canonical unpadded base64url for exactly 64 random bytes; domain-separated HMAC-SHA-512 hashes refresh and link tokens, and derives deterministic synthetic absent-account auth-start material. Rotation changes future provisional values; already-created Redis auth flows retain their recorded material until consumed or expired.',
    example: '',
  },
  AUTH_ALLOW_REGISTRATION: {
    config: Config.boolean('AUTH_ALLOW_REGISTRATION'),
    required: true,
    secret: false,
    requirement: 'Yes',
    notes:
      'Explicit account-creation policy. The combined OPAQUE start remains available in either state. When `false`, every registration finish answers `403 registration_closed`, whether the username is new or belongs to an account whose password was mistyped, so the refusal does not enumerate usernames; existing-account login is unchanged. When `true`, account creation is limited to five per source address per hour.',
    example: 'false',
  },
  AUTH_IDENTITY: {
    config: Config.string('AUTH_IDENTITY'),
    required: true,
    secret: false,
    requirement: 'Yes',
    notes:
      'What accounts are named by: `username` or `email`. Username mode accepts any 3-254 character name and sends no mail; use it for self-hosting. Email mode accepts only an address and creates an account only after a six-digit code mailed to it is entered; an address that already has an account is mailed a notice instead of a code, so sign-up still does not enumerate accounts.',
    example: 'username',
  },
  RESEND_API_KEY: {
    config: Config.option(Config.redacted('RESEND_API_KEY')),
    required: false,
    secret: true,
    requirement: 'With `AUTH_IDENTITY=email`',
    notes: 'Resend API key that sends sign-up and password-reset codes. Refused in username mode.',
    example: '',
  },
  EMAIL_FROM: {
    config: Config.option(Config.nonEmptyString('EMAIL_FROM')),
    required: false,
    secret: false,
    requirement: 'With `AUTH_IDENTITY=email`',
    notes:
      'Sender header, e.g. `Merkur <signin@merkur.sh>`; its domain must be verified in Resend. Refused in username mode.',
    example: '',
  },
  RESEND_API_URL: {
    config: Config.option(Config.nonEmptyString('RESEND_API_URL')),
    required: false,
    secret: false,
    requirement: 'No',
    notes: 'Resend API base URL; defaults to `https://api.resend.com`. Only valid in email mode.',
    example: '',
  },
  SITE_ORIGIN: {
    config: Config.option(Config.nonEmptyString('SITE_ORIGIN')),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Origin of the public website. Set it to take Boxes waitlist addresses from that site: the waitlist route exists only when it is set, accepts a post from this origin alone, and names only it in `Access-Control-Allow-Origin`.',
    example: '',
  },
  RYBBIT_HOST: {
    config: Config.option(Config.nonEmptyString('RYBBIT_HOST')),
    required: false,
    secret: false,
    requirement: 'With `RYBBIT_SITE_ID` and `RYBBIT_API_KEY`',
    notes:
      'Rybbit origin the server reports a new waitlist address to; `/api/track` is appended. The three Rybbit variables are set together or not at all, and need `SITE_ORIGIN`.',
    example: '',
  },
  RYBBIT_SITE_ID: {
    config: Config.option(Config.nonEmptyString('RYBBIT_SITE_ID')),
    required: false,
    secret: false,
    requirement: 'With `RYBBIT_HOST` and `RYBBIT_API_KEY`',
    notes: 'Rybbit site the website reports to, so both kinds of event land on one site.',
    example: '',
  },
  RYBBIT_API_KEY: {
    config: Config.option(Config.redacted('RYBBIT_API_KEY')),
    required: false,
    secret: true,
    requirement: 'With `RYBBIT_HOST` and `RYBBIT_SITE_ID`',
    notes:
      'Rybbit API key, sent as `Authorization: Bearer`. It marks the event as ingestion from this server and never reaches the website.',
    example: '',
  },
  OPAQUE_SERVER_SETUP: {
    config: Config.redacted('OPAQUE_SERVER_SETUP'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes:
      'Stable canonical OPAQUE server setup. Replacing it invalidates every OPAQUE registration record. Keep it secret and durable.',
    example: '',
  },
  OPAQUE_SERVER_PUBLIC_KEY: {
    config: Config.redacted('OPAQUE_SERVER_PUBLIC_KEY'),
    required: true,
    secret: false,
    requirement: 'Yes',
    notes:
      'Canonical public key derived from `OPAQUE_SERVER_SETUP`; startup fails if they do not match.',
    example: '',
  },
  VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY: {
    config: Config.nonEmptyString('VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY'),
    required: true,
    secret: false,
    requirement: 'Build + standalone startup',
    notes:
      'Must equal `OPAQUE_SERVER_PUBLIC_KEY`. The browser pins this value; Docker validates it as a build argument and compiles it into the server for a pre-migration startup comparison.',
    example: '',
  },
  TRUSTED_PROXY_HOPS: {
    config: Config.int('TRUSTED_PROXY_HOPS'),
    required: true,
    secret: false,
    requirement: 'Yes',
    notes:
      'Number of reverse proxies in front of the server that append to `X-Forwarded-For`. `0` ignores the header and keys rate limits on the socket address; use `1` behind a single proxy such as Railway or Fly. Wrong values either let a client forge its own rate-limit key or collapse every client into one bucket, so there is no default.',
    example: '0',
  },
  SESSION_TOKEN_MLDSA87_SEED: {
    config: Config.redacted('SESSION_TOKEN_MLDSA87_SEED'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes:
      'Canonical unpadded base64url for exactly 32 random bytes used to derive the fixed ML-DSA-87 session-authorization keypair. Existing daemons must relink after an intentional hard-cut key replacement.',
    example: '',
  },
  SESSION_TOKEN_TTL_MS: {
    config: Config.int('SESSION_TOKEN_TTL_MS').pipe(Config.withDefault(60_000)),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Session-capability lifetime from 2000 through 300000 milliseconds. Reconnects request fresh capabilities. Server and daemon clocks must be synchronized.',
    example: '',
  },
  BOX_HOST_URL: {
    config: Config.string('BOX_HOST_URL').pipe(Config.withDefault('')),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Canonical HTTP(S) origin of the box host. Configure together with `BOX_HOST_TOKEN`; both absent disables hosted-box provisioning. Credentials, paths, queries, fragments, and trailing slashes are refused.',
    example: '',
  },
  BOX_HOST_TOKEN: {
    config: Config.option(Config.redacted('BOX_HOST_TOKEN')),
    required: false,
    secret: true,
    requirement: 'With `BOX_HOST_URL`',
    notes: 'Bearer token the box host authorizes with.',
    example: '',
  },
  BOX_HOST_TIMEOUT_MS: {
    config: Config.int('BOX_HOST_TIMEOUT_MS').pipe(Config.withDefault(120_000)),
    required: false,
    secret: false,
    requirement: 'No',
    notes: 'Positive integer request timeout in milliseconds, no greater than 2147483647.',
    example: '',
  },
  EDGE_REGISTRATION_KEYS_JSON: {
    config: Config.redacted('EDGE_REGISTRATION_KEYS_JSON'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes:
      'Canonical minified JSON mapping each edge id to its distinct canonical base64url 64-byte HMAC-SHA-512 key. The server refuses to boot on an empty, reused, malformed, or noncanonical map.',
    example: '',
  },
  EDGE_ATTACH_TICKET_KEY: {
    config: Config.redacted('EDGE_ATTACH_TICKET_KEY'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes:
      'Canonical unpadded base64url for exactly 64 random bytes. The deployment secret every edge verifies attach tickets with: the server mints one per daemon on each control lease and one per browser session, and an edge closes any peer without a valid ticket. Set the same value as `MERKUR_EDGE_ATTACH_TICKET_KEY` on every edge.',
    example: '',
  },
  STUN_TICKET_KEY: {
    config: Config.redacted('STUN_TICKET_KEY'),
    required: true,
    secret: true,
    requirement: 'Yes',
    notes:
      'Canonical unpadded base64url for exactly 64 random bytes. The deployment secret every `merkur-stun` responder derives per-ticket MESSAGE-INTEGRITY-SHA256 keys from; the server mints short-lived tickets over the daemon control connection and the daemon never sees this value. Set the same value as `MERKUR_STUN_TICKET_KEY` on the responder.',
    example: '',
  },
  STUN_SERVERS: {
    config: Config.string('STUN_SERVERS'),
    required: true,
    secret: false,
    requirement: 'Yes',
    notes:
      'At least two distinct comma-separated `host:port` vantage points, with ports from 1 through 65535. Use independent addresses in production; two ports of one address establish only port dependence. Local development uses blackholed TEST-NET-1 addresses.',
    example: '192.0.2.1:3478,192.0.2.1:3479',
  },
  BOX_HOST_STUN_OBSERVERS: {
    config: Config.string('BOX_HOST_STUN_OBSERVERS').pipe(Config.withDefault('')),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      "The `STUN_SERVERS` entries that run on the box host, spelled exactly as there. Left out of a box daemon's list, because a box reaches its own host without crossing its NAT and would classify it from a private address. Empty by default.",
    example: '',
  },
  WEB_PUSH_VAPID_PUBLIC_KEY: {
    config: Config.option(Config.nonEmptyString('WEB_PUSH_VAPID_PUBLIC_KEY')),
    required: false,
    secret: false,
    requirement: 'Optional group',
    notes:
      'Canonical unpadded base64url P-256 public key. Configure together with `WEB_PUSH_VAPID_PRIVATE_KEY` and `WEB_PUSH_CONTACT`; partial or mismatched groups fail startup.',
    example: '',
  },
  WEB_PUSH_VAPID_PRIVATE_KEY: {
    config: Config.option(Config.redacted('WEB_PUSH_VAPID_PRIVATE_KEY')),
    required: false,
    secret: true,
    requirement: 'Optional group',
    notes:
      'Canonical unpadded base64url P-256 private key matching the public key. Configure the complete web-push group.',
    example: '',
  },
  WEB_PUSH_CONTACT: {
    config: Config.option(Config.nonEmptyString('WEB_PUSH_CONTACT')),
    required: false,
    secret: false,
    requirement: 'Optional group',
    notes:
      'Web-push contact: a `mailto:` address or an HTTPS URL. Required with the VAPID keypair.',
    example: '',
  },
  AXIOM_TOKEN: {
    config: Config.option(Config.redacted('AXIOM_TOKEN')),
    required: false,
    secret: true,
    requirement: 'Optional group',
    notes:
      'Axiom API token. Supplying it enables OTLP export of traces, Effect-native logs, and metrics; supply all four Axiom variables or none. Unset, spans are printed to stdout as a tree instead of exported.',
    example: '',
  },
  AXIOM_DATASET: {
    config: Config.option(Config.nonEmptyString('AXIOM_DATASET')),
    required: false,
    secret: false,
    requirement: 'Optional group',
    notes: 'Dataset receiving traces and logs (`x-axiom-dataset`).',
    example: '',
  },
  AXIOM_METRICS_DATASET: {
    config: Config.option(Config.nonEmptyString('AXIOM_METRICS_DATASET')),
    required: false,
    secret: false,
    requirement: 'Optional group',
    notes:
      "Dataset receiving metrics (`x-axiom-metrics-dataset`). Separate from traces and logs because Axiom's metrics intake uses a different header and accepts only protobuf.",
    example: '',
  },
  AXIOM_PERF_DATASET: {
    config: Config.option(Config.nonEmptyString('AXIOM_PERF_DATASET')),
    required: false,
    secret: false,
    requirement: 'Optional group',
    notes:
      "Dataset receiving browser profiling rows, written through Axiom's native `/v1/ingest/{dataset}` API rather than OTLP. Without it, profiling batches are accepted and discarded as unconfigured. On the free tier this is the third and last dataset allowed.",
    example: '',
  },
  AXIOM_ENDPOINT: {
    config: Config.nonEmptyString('AXIOM_ENDPOINT').pipe(
      Config.withDefault(DEFAULT_AXIOM_ENDPOINT),
    ),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Axiom intake base URL without credentials, query, or fragment. Datasets outside the default region require their own edge deployment URL, which is not api.<region>.axiom.co; read edgeDeploymentUrl from the dataset API.',
    example: '',
  },
  TELEMETRY_ENVIRONMENT: {
    config: Config.nonEmptyString('TELEMETRY_ENVIRONMENT').pipe(
      Config.withDefault(DEFAULT_TELEMETRY_ENVIRONMENT),
    ),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Value of the deployment.environment.name resource attribute. Set to production on the deployed server.',
    example: '',
  },
  TRACE_LEVEL: {
    config: Config.nonEmptyString('TRACE_LEVEL').pipe(Config.withDefault(DEFAULT_TRACE_LEVEL)),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Minimum sampled span level: All, Fatal, Error, Warn, Info, Debug, Trace, or None. Applies equally to stdout and OTLP export; Debug enables Redis operation and health-poll spans.',
    example: '',
  },
  TRACE_SAMPLE_RATIO: {
    config: Config.number('TRACE_SAMPLE_RATIO').pipe(
      Config.withDefault(DEFAULT_TRACE_SAMPLE_RATIO),
    ),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Share of unremarkable traces retained, from 0 to 1. Failures, slow traces, and traces reaching a daemon are always retained.',
    example: '',
  },
  TRACE_SLOW_THRESHOLD_MS: {
    config: Config.number('TRACE_SLOW_THRESHOLD_MS').pipe(
      Config.withDefault(DEFAULT_TRACE_SLOW_THRESHOLD_MS),
    ),
    required: false,
    secret: false,
    requirement: 'No',
    notes: 'Root-span duration in milliseconds at or above which a trace is always retained.',
    example: '',
  },
  LOG_LEVEL: {
    config: Config.option(Config.nonEmptyString('LOG_LEVEL')),
    required: false,
    secret: false,
    requirement: 'No',
    notes:
      'Shared JSON-log threshold: info, warn, error, or silent. Unset or unrecognized values emit all supported levels.',
    example: 'info',
  },
} as const;

export type ServerEnvironmentKey = keyof typeof serverEnvironment;
