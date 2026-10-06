import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { type DaemonIdentitySealBackend, isDaemonIdentitySealBackend } from '@merkur/shared';
import {
  type DaemonBinding,
  type DelegationRevocationTarget,
  decodeUserAuthorizationBytes,
  parseDaemonBinding,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
} from '@merkur/shared/user-authorization';
import { Config, Context, Data, Effect, Layer } from 'effect';

const CONFIG_DIRECTORY_NAME = '.merkur';
const CONFIG_FILE_NAME = 'config.json';
const SHELL_TOKEN_FILE_NAME = 'shell-token';
/** 128 bits, hex-encoded. The dataplane buffers the whole OSC payload, so the
 *  length is bounded by `CONTROL_PAYLOAD_CAPACITY` there; move both together. */
const SHELL_TOKEN_BYTES = 16;
const SHELL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const SESSION_TOKEN_VERIFY_KEY_PATTERN = /^[A-Za-z0-9_-]{3456}$/;
const SESSION_TOKEN_VERIFY_KEY_BYTES = 2_592;
const DAEMON_CONFIG_FIELDS = new Set([
  'daemon_id',
  'server_origin',
  'daemon_identity_seal',
  'shell',
  'webtransport_port',
  'session_token_verify_key',
  'user_root_public_key',
  'root_epoch',
  'daemon_binding',
  'revoked_delegations',
]);

/**
 * The pinned UDP port for every daemon's direct WebTransport server.
 *
 * One constant rather than a per-daemon derivation, because its whole value is
 * that a human can write it into a router forward and a firewall rule. One
 * daemon per network namespace is the deployment model — a laptop runs one, and
 * each box container has its own namespace — so a fixed port does not collide.
 * A collision fails loudly at bind rather than silently searching for a free
 * port, which would defeat the forward it exists to enable.
 *
 * A box host's firewall and port mapping name this port; it is part of the box-host
 * contract in `docs/processes.md`.
 */
export const MERKUR_WEBTRANSPORT_PORT = 44_433;

export interface DaemonConfig {
  readonly daemon_id: string;
  readonly server_origin: string;
  readonly daemon_identity_seal: DaemonIdentitySeal;
  readonly shell: string;
  /**
   * UDP port for the direct WebTransport server.
   *
   * Pinned rather than ephemeral so a NAT mapping outlives a daemon restart, a
   * router forward can be written down at all, and a host firewall can name one
   * port instead of the whole ephemeral range. Persisted because all three of
   * those are operator contracts that must survive the process.
   */
  readonly webtransport_port: number;
  readonly session_token_verify_key: string;
  readonly user_root_public_key: string;
  readonly root_epoch: number;
  readonly daemon_binding: DaemonBinding;
  readonly revoked_delegations: readonly DelegationRevocationTarget[];
}

export interface DaemonEnvironment {
  readonly home: string;
  readonly configPath: string;
  readonly launchAgentPath: string;
  /**
   * `host:port` this daemon is reachable on from the public internet through a
   * port mapping somebody else installed, or `null` when nothing has told it.
   *
   * Environment rather than persisted config, deliberately. This describes the
   * *host* the daemon happens to be running on — a box host's `incus network
   * forward`, a router's port forward — not the daemon's own identity, so it
   * must not survive being moved to a machine where it is no longer true. A
   * stale value here is worse than none: it publishes a candidate that answers
   * nothing, and an unanswered candidate costs the browser its whole race
   * deadline.
   *
   * The dataplane publishes it as `CandidateFlavor::NatMap`, whose existing
   * definition already covers exactly this case — "the gateway has been told to
   * forward, so unsolicited inbound is admitted by configuration rather than by
   * a keepalive and a punch landing in time".
   */
  readonly publicWebtransportEndpoint: string | null;
}

export class DaemonConfigError extends Data.TaggedError('DaemonConfigError')<{
  readonly configPath: string;
  readonly message: string;
}> {}

export class DaemonEnvironmentService extends Context.Service<
  DaemonEnvironmentService,
  DaemonEnvironment
>()('DaemonEnvironment') {}

export class DaemonConfigService extends Context.Service<DaemonConfigService, DaemonConfig>()(
  'DaemonConfig',
) {}

export const DaemonEnvironmentLive = Layer.effect(
  DaemonEnvironmentService,
  Effect.gen(function* () {
    const home = yield* Config.nonEmptyString('MERKUR_DAEMON_HOME').pipe(
      Config.orElse(() => Config.nonEmptyString('HOME')),
    );
    const publicWebtransportEndpoint = yield* Config.nonEmptyString(
      'MERKUR_PUBLIC_WT_ENDPOINT',
    ).pipe(
      Config.map(validatePublicWebtransportEndpoint),
      // Unset is the ordinary case: only a host whose operator installed a port
      // mapping has one. A malformed value is dropped by the validator rather
      // than failing startup, because a daemon that refuses to boot over an
      // optional candidate is strictly worse than one that relays.
      Config.orElse(() => Config.succeed(null)),
    );
    return {
      home,
      configPath: daemonConfigPathForHome(home),
      launchAgentPath: launchAgentPathForHome(home),
      publicWebtransportEndpoint,
    } satisfies DaemonEnvironment;
  }),
);

export const DaemonConfigLive = Layer.effect(
  DaemonConfigService,
  Effect.gen(function* () {
    const env = yield* DaemonEnvironmentService;
    return yield* requireDaemonConfigFromPath(env.configPath);
  }),
);

/**
 * Accept `host:port` / `[v6]:port` only, and only with a port in range.
 *
 * Rejecting beats correcting: every value here comes from an operator or from
 * a box host, and a typo that silently became a different port would publish a
 * candidate that cannot answer while looking exactly like one that can.
 */
export function validatePublicWebtransportEndpoint(raw: string): string | null {
  const trimmed = raw.trim();
  const separator = trimmed.lastIndexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const host = trimmed.slice(0, separator);
  const port = Number(trimmed.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  // A bare IPv6 literal has colons of its own, so it must arrive bracketed or
  // the split above would have cut it in the middle.
  if (host.includes(':') && !(host.startsWith('[') && host.endsWith(']'))) return null;
  if (host.length === 0 || host === '[]') return null;
  return `${host}:${port}`;
}

export function daemonConfigPathForHome(home: string): string {
  return path.join(home, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

export function launchAgentPathForHome(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', 'dev.merkur.daemon.plist');
}

export function systemdUserUnitPathForHome(home: string): string {
  return path.join(home, '.config', 'systemd', 'user', 'merkur-daemon.service');
}

export function shellTokenPathForHome(home: string): string {
  return path.join(home, CONFIG_DIRECTORY_NAME, SHELL_TOKEN_FILE_NAME);
}

/**
 * Read the shell-integration token, creating it on first use.
 *
 * The token proves an `OSC 133;B` came from a shell Merkur started rather than
 * from arbitrary program output. It lives in a file, not only in the
 * environment, for one specific reason: a tmux server started before the daemon
 * — or one that outlives a daemon restart — hands its panes an environment
 * snapshot the daemon never touched, and those panes need a way to find the
 * token anyway.
 *
 * That also fixes the lifetime. The value must be STABLE, because a rotated
 * token would silently stop matching in every already-running multiplexer pane
 * and prediction would decay with no error anywhere. It is regenerated only
 * when the file is absent or unusable.
 *
 * It is not a secret against other local processes of this user. One of those
 * can already write to the PTY, read the environment, and attach a debugger.
 * The file mode is 0600 because that is the correct default for anything in
 * this directory, not because a stronger claim is being made.
 */
export function ensureShellTokenAtPath(tokenPath: string): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const existing = await readShellToken(tokenPath);
      if (existing !== null) return existing;

      const token = randomBytes(SHELL_TOKEN_BYTES).toString('hex');
      const tokenDirectory = path.dirname(tokenPath);
      await mkdir(tokenDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
      await chmod(tokenDirectory, CONFIG_DIRECTORY_MODE);
      const tempPath = path.join(
        tokenDirectory,
        `.${path.basename(tokenPath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
      );
      let tempExists = false;
      let tempFile: Awaited<ReturnType<typeof open>> | null = null;
      try {
        tempFile = await open(tempPath, 'wx', CONFIG_FILE_MODE);
        tempExists = true;
        await tempFile.writeFile(`${token}\n`, 'utf8');
        await tempFile.sync();
        await tempFile.close();
        tempFile = null;
        await chmod(tempPath, CONFIG_FILE_MODE);
        await rename(tempPath, tokenPath);
        tempExists = false;
        await syncDirectory(tokenDirectory);
      } finally {
        await tempFile?.close().catch(() => undefined);
        if (tempExists) {
          await rm(tempPath, { force: true }).catch(() => undefined);
        }
      }
      // Re-read rather than returning the value just written. Two daemons
      // racing on first start both create a temp file and both rename; the
      // loser's token is the one on disk, and that is the one the dataplane
      // will read.
      return (await readShellToken(tokenPath)) ?? token;
    },
    catch: (error) => normalizeConfigError(error, tokenPath),
  });
}

/**
 * Read an existing token, or `null` when there is nothing usable to read.
 *
 * The charset check has to agree with the dataplane's, which refuses anything
 * outside `[A-Za-z0-9_-]` because the value is compared against bytes lifted
 * out of an OSC payload — a token containing `;` or a terminator could never
 * match and would fail looking like a bug. Rejecting it here means a corrupt
 * file is replaced rather than producing a shell that can never authenticate.
 */
async function readShellToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, 'utf8')).trim();
    return token.length > 0 && SHELL_TOKEN_PATTERN.test(token) ? token : null;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export function loadDaemonConfigFromPath(
  configPath: string,
): Effect.Effect<DaemonConfig | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      try {
        const raw = await readFile(configPath, 'utf8');
        return validateDaemonConfig(JSON.parse(raw));
      } catch (error) {
        if (isMissingFileError(error)) {
          return null;
        }
        throw error;
      }
    },
    catch: (error) => normalizeConfigError(error, configPath),
  });
}

export function requireDaemonConfigFromPath(
  configPath: string,
): Effect.Effect<DaemonConfig, Error> {
  return Effect.flatMap(loadDaemonConfigFromPath(configPath), (config) =>
    config === null
      ? Effect.fail(
          new DaemonConfigError({
            configPath,
            message: `Missing daemon config at ${configPath}`,
          }),
        )
      : Effect.succeed(config),
  );
}

export function saveDaemonConfigToPath(
  configPath: string,
  config: DaemonConfig,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const validatedConfig = validateDaemonConfig(config);
      const configDirectory = path.dirname(configPath);
      await mkdir(configDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
      await chmod(configDirectory, CONFIG_DIRECTORY_MODE);
      const tempPath = path.join(
        configDirectory,
        `.${path.basename(configPath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
      );
      let tempExists = false;
      let tempFile: Awaited<ReturnType<typeof open>> | null = null;
      try {
        tempFile = await open(tempPath, 'wx', CONFIG_FILE_MODE);
        tempExists = true;
        await tempFile.writeFile(`${JSON.stringify(validatedConfig, null, 2)}\n`, 'utf8');
        await tempFile.sync();
        await tempFile.close();
        tempFile = null;
        await chmod(tempPath, CONFIG_FILE_MODE);
        await rename(tempPath, configPath);
        tempExists = false;
        await chmod(configPath, CONFIG_FILE_MODE);
        await syncDirectory(configDirectory);
      } finally {
        await tempFile?.close().catch(() => undefined);
        if (tempExists) {
          await rm(tempPath, { force: true }).catch(() => undefined);
        }
      }
    },
    catch: (error) => normalizeConfigError(error, configPath),
  });
}

export function removeDaemonConfigFromPath(configPath: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await rm(configPath, { force: true });
      await syncDirectory(path.dirname(configPath));
    },
    catch: (error) => normalizeConfigError(error, configPath),
  });
}

function normalizeConfigError(error: unknown, configPath: string): DaemonConfigError {
  if (error instanceof DaemonConfigError) {
    return error;
  }

  return new DaemonConfigError({
    configPath,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function validateDaemonConfig(value: unknown): DaemonConfig {
  if (!isRecord(value)) {
    throw new Error('Invalid daemon config field: root must be an object');
  }
  for (const field of Object.keys(value)) {
    if (!DAEMON_CONFIG_FIELDS.has(field)) {
      throw new Error(`Invalid daemon config field: ${field}`);
    }
  }

  const sessionTokenVerifyKey = requireNonEmptyStringField(value, 'session_token_verify_key');
  if (
    !SESSION_TOKEN_VERIFY_KEY_PATTERN.test(sessionTokenVerifyKey) ||
    Buffer.from(sessionTokenVerifyKey, 'base64url').byteLength !== SESSION_TOKEN_VERIFY_KEY_BYTES ||
    Buffer.from(sessionTokenVerifyKey, 'base64url').toString('base64url') !== sessionTokenVerifyKey
  ) {
    throw new Error('Invalid daemon config field: session_token_verify_key');
  }

  const daemonIdentitySeal = requireDaemonIdentitySeal(value.daemon_identity_seal);
  const userRootPublicKey = requireNonEmptyStringField(value, 'user_root_public_key');
  decodeUserAuthorizationBytes(
    userRootPublicKey,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'user root public key',
  );
  const rootEpoch = requirePositiveSafeIntegerField(value, 'root_epoch');
  const daemonBinding = parseDaemonBinding(value.daemon_binding);
  const revokedDelegations = requireRevokedDelegations(value.revoked_delegations);

  return {
    daemon_id: requireNonEmptyStringField(value, 'daemon_id'),
    server_origin: requireDaemonServerOriginField(value),
    daemon_identity_seal: daemonIdentitySeal,
    shell: requireNonEmptyStringField(value, 'shell'),
    webtransport_port: requireWebTransportPortField(value),
    session_token_verify_key: sessionTokenVerifyKey,
    user_root_public_key: userRootPublicKey,
    root_epoch: rootEpoch,
    daemon_binding: daemonBinding,
    revoked_delegations: revokedDelegations,
  };
}

/**
 * The pinned WebTransport port.
 *
 * Below 1024 needs privileges the daemon does not have, and 0 is not accepted
 * here: a persisted config that means "ephemeral" would silently invalidate the
 * router forward and firewall rule that the pinned port exists to make possible.
 * The CLI still accepts 0 for local runs that never persist a config.
 */
function requireWebTransportPortField(value: Record<string, unknown>): number {
  const field = value.webtransport_port;
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 1024 || field > 65_535) {
    throw new Error('Invalid daemon config field: webtransport_port');
  }
  return field;
}

function requirePositiveSafeIntegerField(
  value: Record<string, unknown>,
  fieldName: string,
): number {
  const field = value[fieldName];
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 1) {
    throw new Error(`Invalid daemon config field: ${fieldName}`);
  }
  return field;
}

function requireRevokedDelegations(value: unknown): readonly DelegationRevocationTarget[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid daemon config field: revoked_delegations');
  }
  const targets = value.map((item): DelegationRevocationTarget => {
    if (!isRecord(item) || Object.keys(item).join(',') !== 'delegationId,expiresAt') {
      throw new Error('Invalid daemon config field: revoked_delegations');
    }
    const delegationId = item.delegationId;
    const expiresAt = item.expiresAt;
    if (
      typeof delegationId !== 'string' ||
      !/^[A-Za-z0-9_-]+$/u.test(delegationId) ||
      Buffer.byteLength(delegationId, 'utf8') > 128 ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < 0
    ) {
      throw new Error('Invalid daemon config field: revoked_delegations');
    }
    return { delegationId, expiresAt };
  });
  if (
    new Set(targets.map((target) => target.delegationId)).size !== targets.length ||
    targets.some(
      (target, index) =>
        index > 0 && (targets[index - 1]?.delegationId ?? '') >= target.delegationId,
    )
  ) {
    throw new Error('Invalid daemon config field: revoked_delegations');
  }
  return targets;
}

async function syncDirectory(directory: string): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    directoryHandle = await open(directory, 'r');
    await directoryHandle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return (
    error.code === 'EINVAL' ||
    error.code === 'ENOTSUP' ||
    error.code === 'EISDIR' ||
    error.code === 'EBADF'
  );
}

export function canonicalizeServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid daemon config field: server_origin');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Invalid daemon config field: server_origin');
  }
  return url.origin;
}

export function canonicalizeDaemonServerOrigin(value: string): string {
  const origin = canonicalizeServerOrigin(value);
  const url = new URL(origin);
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('Invalid daemon config field: server_origin');
  }
  return origin;
}

function requireDaemonServerOriginField(value: Record<string, unknown>): string {
  return canonicalizeDaemonServerOrigin(requireStringField(value, 'server_origin'));
}

export interface DaemonIdentitySeal {
  readonly backend: DaemonIdentitySealBackend;
  readonly material: string;
}

export function requireDaemonIdentitySeal(value: unknown): DaemonIdentitySeal {
  const invalid = () => new Error('Invalid daemon config field: daemon_identity_seal');
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'backend') ||
    !Object.hasOwn(value, 'material') ||
    !isDaemonIdentitySealBackend(value.backend) ||
    typeof value.material !== 'string' ||
    value.material.length === 0 ||
    value.material.length > 10923 ||
    !/^[A-Za-z0-9_-]+$/.test(value.material)
  )
    throw invalid();
  const bytes = Buffer.from(value.material, 'base64url');
  try {
    if (
      bytes.toString('base64url') !== value.material ||
      bytes.length > 8192 ||
      (value.backend === 'software' && bytes.length !== 32)
    )
      throw invalid();
    return { backend: value.backend, material: value.material };
  } finally {
    bytes.fill(0);
  }
}

function requireStringField(
  value: Record<string, unknown>,
  fieldName: string,
  prefix?: string,
): string {
  const raw = value[fieldName];
  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid daemon config field: ${prefix === undefined ? fieldName : `${prefix}.${fieldName}`}`,
    );
  }
  return raw;
}

function requireNonEmptyStringField(value: Record<string, unknown>, fieldName: string): string {
  const raw = requireStringField(value, fieldName);
  if (raw.trim().length === 0) {
    throw new Error(`Invalid daemon config field: ${fieldName}`);
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') {
    return true;
  }
  const octets = normalized.split('.');
  if (octets.length !== 4 || octets[0] !== '127') {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    const numeric = Number(octet);
    return numeric >= 0 && numeric <= 255 && String(numeric) === octet;
  });
}

function isMissingFileError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return 'code' in error && error.code === 'ENOENT';
}
