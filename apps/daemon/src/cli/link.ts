import { randomBytes, randomUUID } from 'node:crypto';
import { deriveDaemonIdentityKeyCommitment, SESSION_AUTHORIZATION_SEED_BYTES } from '@merkur/auth';
import { canonicalizeDaemonServerOrigin } from '@merkur/config';
import {
  hasExactKeys,
  isMachineUsage,
  isRecord,
  type MachineUsage,
  normalizeUnknownError,
  readNonEmptyStringField,
} from '@merkur/shared';
import {
  type DaemonLinkApproval,
  type DaemonLinkPublicClaim,
  type DaemonLinkPublicClaimPayload,
  decodeUserAuthorizationBytes,
  deriveDaemonLinkClaimCommitment,
  deriveUserRootKeyCommitment,
  formatDaemonLinkCode,
  parseDaemonLinkApproval,
  parseDaemonLinkPublicClaim,
  USER_AUTHORIZATION_NONCE_BYTES,
  USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
  verifyDaemonBinding,
  verifyDaemonLinkApproval,
} from '@merkur/shared/user-authorization';
import { Clock, Effect } from 'effect';
import { renderUnicodeCompact } from 'uqr';
import {
  createLinkedConfig,
  currentMachineName,
  currentPlatformLabel,
  type DaemonConfig,
  daemonConfigPath,
  loadDaemonConfigEffect,
  readLoginShellEffect,
  removeDaemonConfigEffect,
  saveDaemonConfigEffect,
} from '../config';
import type { Logger } from '../logger';
import {
  createIdentitySealEffect,
  type IdentitySealError,
  inspectIdentitySealEffect,
  type SealedDaemonIdentity,
} from './identity-seal';
import {
  type LegacyDaemonLinkMigration,
  loadLegacyDaemonConfigForLinkMigration,
} from './legacy-daemon-config-migration';
import { repairTpmAccessEffect } from './linux-tpm-access';

const LINK_TOKEN_PATTERN = /^[0-9A-HJ-NP-Z]{52}$/u;
const LINK_CLAIMS_PATH = '/api/daemon-link/claims';
const LINK_POLL_INTERVAL = '1 second';

interface EdenErrorLike {
  readonly status: unknown;
  readonly value: unknown;
}

export interface DaemonLinkCreateRequest extends DaemonLinkPublicClaim {
  readonly linkToken: string;
}

export interface DaemonLinkPostResult {
  readonly data: unknown;
  readonly error: EdenErrorLike | null;
}

export interface DaemonLinkCommandDependencies {
  readonly generateDaemonId: () => string;
  readonly createIdentitySeal: typeof createIdentitySealEffect;
  readonly inspectIdentitySeal: typeof inspectIdentitySealEffect;
  readonly repairTpmAccess: (logger: Logger) => Effect.Effect<boolean>;
  readonly generateLinkClaimId: () => string;
  readonly generateLinkSecret: () => Uint8Array;
  readonly loadExistingConfig: () => Effect.Effect<DaemonConfig | null, Error>;
  readonly loadLegacyConfigForMigration: () => Effect.Effect<LegacyDaemonLinkMigration, Error>;
  readonly machineName: () => string;
  readonly platformLabel: () => string;
  readonly loginShell: () => Effect.Effect<string, Error>;
  readonly createClaim: (
    serverOrigin: string,
    request: DaemonLinkCreateRequest,
  ) => Promise<DaemonLinkPostResult>;
  readonly pollClaim: (
    serverOrigin: string,
    linkClaimId: string,
    pollToken: string,
  ) => Promise<DaemonLinkPostResult>;
  readonly completeClaim: (
    serverOrigin: string,
    linkClaimId: string,
    pollToken: string,
    approvalMac: string,
  ) => Promise<DaemonLinkPostResult>;
  readonly saveConfig: (config: DaemonConfig) => Effect.Effect<void, Error>;
  readonly restoreConfig: (config: DaemonConfig | null) => Effect.Effect<void, Error>;
  readonly readLinkToken: () => Effect.Effect<string, Error>;
  /** Draws the approval link as a QR code for a phone to scan. */
  readonly showApprovalQrCode: (approvalUrl: string) => void;
}

/** The environment variable the browser's link command sets. */
export const LINK_TOKEN_ENV = 'MERKUR_LINK_TOKEN';

/**
 * Reads the link token from `MERKUR_LINK_TOKEN`.
 *
 * Never an argument: an argument is world-readable through `ps` for as long as
 * linking waits for approval. The environment of a process is readable only by
 * its own user. The browser's link command sets it on the installer it pipes
 * into; linking an already-installed machine by hand sets it the same way.
 */
function readLinkTokenFromEnvironment(): Effect.Effect<string, Error> {
  return Effect.sync(() => process.env[LINK_TOKEN_ENV]?.trim() ?? '');
}

/**
 * The QR code goes to a terminal only. Written into a log file or a pipe it is
 * three dozen lines of block characters nobody can scan.
 */
function writeApprovalQrCode(approvalUrl: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\n${renderUnicodeCompact(approvalUrl)}\n\n`);
}

/**
 * Where the browser approves this claim. The code rides in the fragment, which
 * a browser never sends to a server, so it cannot land in an access log.
 */
export function daemonLinkApprovalUrl(serverOrigin: string, code: string): string {
  return `${serverOrigin}/link#${code}`;
}

const LIVE_DAEMON_LINK_DEPENDENCIES: DaemonLinkCommandDependencies = {
  generateDaemonId: randomUUID,
  createIdentitySeal: createIdentitySealEffect,
  inspectIdentitySeal: inspectIdentitySealEffect,
  repairTpmAccess: repairTpmAccessEffect,
  generateLinkClaimId: randomUUID,
  generateLinkSecret: () => randomBytes(SESSION_AUTHORIZATION_SEED_BYTES),
  loadExistingConfig: loadDaemonConfigEffect,
  loadLegacyConfigForMigration: () => loadLegacyDaemonConfigForLinkMigration(daemonConfigPath()),
  machineName: currentMachineName,
  platformLabel: currentPlatformLabel,
  loginShell: readLoginShellEffect,
  createClaim: postDaemonLinkClaim,
  pollClaim: pollDaemonLinkClaim,
  completeClaim: completeDaemonLinkClaim,
  saveConfig: saveDaemonConfigEffect,
  restoreConfig: (config) =>
    config === null ? removeDaemonConfigEffect() : saveDaemonConfigEffect(config),
  readLinkToken: readLinkTokenFromEnvironment,
  showApprovalQrCode: writeApprovalQrCode,
};

export async function runLinkCommand(args: string[], logger: Logger): Promise<number> {
  return Effect.runPromise(runLinkCommandEffect(args, logger));
}

export function runLinkCommandEffect(
  args: string[],
  logger: Logger,
  dependencies: DaemonLinkCommandDependencies = LIVE_DAEMON_LINK_DEPENDENCIES,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const parsedArgs = parseLinkArguments(args);
    if (parsedArgs === null) {
      logger.error('daemon_link_usage', {
        usage: `${LINK_TOKEN_ENV}=<token> merkur link <url> [--identity-backend software] [--replace-identity]`,
      });
      return 1;
    }
    const { requestedServerOrigin } = parsedArgs;
    const serverOrigin = yield* Effect.try({
      try: () => canonicalizeDaemonServerOrigin(requestedServerOrigin),
      catch: normalizeUnknownError,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (serverOrigin === null) {
      logger.error('daemon_link_invalid_server_origin');
      return 1;
    }

    // Read only once the origin is known good, so a typo'd URL fails first.
    const token = yield* dependencies.readLinkToken().pipe(Effect.catch(() => Effect.succeed('')));
    if (!LINK_TOKEN_PATTERN.test(token)) {
      logger.error('daemon_link_invalid_token');
      return 1;
    }

    // The shell every terminal of this daemon opens. Read before anything is
    // claimed, so an account without one fails here rather than after approval.
    const shell = yield* dependencies.loginShell().pipe(
      Effect.catch((error) => {
        logger.error('daemon_link_login_shell_unavailable', { error: error.message });
        return Effect.succeed(null);
      }),
    );
    if (shell === null) return 1;

    const existingIdentity = yield* loadLinkIdentity(dependencies);
    if (existingIdentity._tag === 'failed') {
      logger.error('daemon_link_existing_config_unreadable', {
        error: 'existing_config_matches_neither_current_nor_supported_migration_schema',
      });
      return 1;
    }
    const existingConfig = existingIdentity._tag === 'current' ? existingIdentity.config : null;
    const daemonId = parsedArgs.replaceIdentity
      ? dependencies.generateDaemonId()
      : existingIdentity._tag === 'current'
        ? existingIdentity.config.daemon_id
        : existingIdentity._tag === 'legacy'
          ? existingIdentity.migration.daemonId
          : dependencies.generateDaemonId();

    if (
      parsedArgs.forceSoftware &&
      existingConfig !== null &&
      existingConfig.daemon_identity_seal.backend !== 'software' &&
      !parsedArgs.replaceIdentity
    ) {
      logger.error('daemon_link_identity_choice_conflict', {
        hint: 'Use --replace-identity to change this linked identity',
      });
      return 1;
    }
    const identity = yield* resolveLinkIdentitySeal(
      existingConfig,
      parsedArgs,
      logger,
      dependencies,
    ).pipe(
      Effect.catch((error) => {
        logger.error('daemon_link_identity_failed', {
          reason: error.code,
          hint:
            error.code === 'hardware_unavailable' || error.code === 'tpm_access_denied'
              ? 'Use --identity-backend software only if you choose to store the identity on disk'
              : error.code === 'binary_not_found'
                ? 'Build or install merkur-dataplane first'
                : 'Use --replace-identity to link a new identity on this machine',
        });
        return Effect.succeed(null);
      }),
    );
    if (identity === null) return 1;
    logger.info('daemon_link_identity_backend', { backend: identity.seal.backend });
    return yield* Effect.scoped(
      Effect.acquireRelease(
        Effect.try({ try: dependencies.generateLinkSecret, catch: normalizeUnknownError }),
        (linkSecret) => Effect.sync(() => linkSecret.fill(0)),
      ).pipe(
        Effect.flatMap((linkSecret) =>
          runLinkClaim({
            daemonId,
            existingConfig,
            identity,
            shell,
            linkSecret,
            serverOrigin,
            linkToken: token,
            logger,
            dependencies,
          }),
        ),
      ),
    );
  });
}

interface RunLinkClaimInput {
  readonly daemonId: string;
  readonly existingConfig: DaemonConfig | null;
  readonly identity: SealedDaemonIdentity;
  readonly shell: string;
  readonly linkSecret: Uint8Array;
  readonly serverOrigin: string;
  readonly linkToken: string;
  readonly logger: Logger;
  readonly dependencies: DaemonLinkCommandDependencies;
}

function runLinkClaim(input: RunLinkClaimInput): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const keyMaterial = {
      publicKey: input.identity.publicKey,
      commitment: deriveDaemonIdentityKeyCommitment(
        Buffer.from(input.identity.publicKey, 'base64url'),
        Buffer.from(input.identity.p256PublicKey, 'base64url'),
      ),
    };
    const linkClaimId = input.dependencies.generateLinkClaimId();
    const publicClaim: DaemonLinkPublicClaimPayload = {
      linkClaimId,
      daemonId: input.daemonId,
      daemonIdentityPublicKey: keyMaterial.publicKey,
      daemonIdentityP256PublicKey: input.identity.p256PublicKey,
      daemonIdentityKeyCommitment: keyMaterial.commitment,
      name: input.dependencies.machineName(),
      platform: input.dependencies.platformLabel(),
      identitySealBackend: input.identity.seal.backend,
    };
    const claimCommitment = deriveDaemonLinkClaimCommitment(publicClaim, input.linkSecret);
    const claim = parseDaemonLinkPublicClaim({ ...publicClaim, claimCommitment });
    const request: DaemonLinkCreateRequest = { linkToken: input.linkToken, ...claim };
    const createResult = yield* Effect.tryPromise({
      try: () => input.dependencies.createClaim(input.serverOrigin, request),
      catch: normalizeUnknownError,
    });
    if (createResult.error !== null) {
      logLinkError(input.logger, createResult.error);
      return 1;
    }
    const created = parseCreatedClaim(createResult.data);
    if (created === null) {
      input.logger.error('daemon_link_failed', { error: 'invalid_claim_response' });
      return 1;
    }
    const { used, limit } = created.machineUsage;
    input.logger.info('daemon_link_machine_usage', {
      message:
        limit === null
          ? `${used} machines linked; no machine limit.`
          : `${used} / ${limit} machine slots used. Hosted boxes do not count.`,
      used,
      limit,
    });
    if (!created.canLink) {
      input.logger.error('daemon_link_machine_limit_reached', {
        message: `Machine limit reached (${used} / ${limit}). Unlink a machine at ${input.serverOrigin}, then copy and run a new link command.`,
      });
      return 1;
    }
    const serverNonce = decodeUserAuthorizationBytes(
      created.serverNonce,
      USER_AUTHORIZATION_NONCE_BYTES,
      'daemon link server nonce',
    );
    try {
      const code = formatDaemonLinkCode(linkClaimId, input.linkSecret);
      const approvalUrl = daemonLinkApprovalUrl(input.serverOrigin, code);
      input.logger.info('daemon_link_code', {
        code,
        url: approvalUrl,
        expiresAt: created.expiresAt,
      });
      input.dependencies.showApprovalQrCode(approvalUrl);
      const approved = yield* pollUntilApproved(
        input,
        linkClaimId,
        created.pollToken,
        created.expiresAt,
      );
      if (approved === null) return 1;
      const approval = verifyDaemonLinkApproval(approved.approval, serverNonce, input.linkSecret);
      if (
        approval === null ||
        approval.linkClaimId !== linkClaimId ||
        approval.claimCommitment !== claimCommitment
      ) {
        input.logger.error('daemon_link_failed', { error: 'invalid_link_approval_mac' });
        return 1;
      }
      if (!verifyRootBinding(approval, input, keyMaterial.commitment)) {
        input.logger.error('daemon_link_failed', { error: 'invalid_root_daemon_binding' });
        return 1;
      }

      const config = createLinkedConfig({
        daemonId: input.daemonId,
        serverOrigin: input.serverOrigin,
        daemonIdentitySeal: input.identity.seal,
        shell: input.shell,
        sessionTokenVerifyKey: approved.sessionTokenVerifyKey,
        userRootPublicKey: approval.userRootPublicKey,
        rootEpoch: approval.rootEpoch,
        daemonBinding: approval.daemonBinding,
        revokedDelegations: revocationsForRelink(
          input.existingConfig,
          approval,
          input.serverOrigin,
          input.daemonId,
          keyMaterial.commitment,
        ),
      });
      yield* input.dependencies.saveConfig(config);
      const completeResult = yield* Effect.tryPromise({
        try: () =>
          input.dependencies.completeClaim(
            input.serverOrigin,
            linkClaimId,
            created.pollToken,
            approval.approvalMac,
          ),
        catch: normalizeUnknownError,
      });
      if (completeResult.error !== null) {
        logLinkError(input.logger, completeResult.error);
        if (isDefinitiveCompletionRejection(completeResult.error)) {
          yield* input.dependencies.restoreConfig(input.existingConfig);
        }
        return 1;
      }
      input.logger.info('daemon_link_success', {
        serverOrigin: input.serverOrigin,
        daemonId: input.daemonId,
      });
      return 0;
    } finally {
      serverNonce.fill(0);
    }
  });
}

function revocationsForRelink(
  existing: DaemonConfig | null,
  approval: DaemonLinkApproval,
  serverOrigin: string,
  daemonId: string,
  daemonIdentityKeyCommitment: string,
): DaemonConfig['revoked_delegations'] {
  if (existing === null) return [];
  const prior = existing.daemon_binding;
  const next = approval.daemonBinding;
  const sameLineage =
    existing.daemon_id === daemonId &&
    existing.server_origin === serverOrigin &&
    existing.user_root_public_key === approval.userRootPublicKey &&
    existing.root_epoch === approval.rootEpoch &&
    prior.userId === next.userId &&
    prior.rootKeyCommitment === next.rootKeyCommitment &&
    prior.daemonId === next.daemonId &&
    prior.daemonIdentityKeyCommitment === daemonIdentityKeyCommitment &&
    next.daemonIdentityKeyCommitment === daemonIdentityKeyCommitment &&
    prior.serverOrigin === next.serverOrigin;
  return sameLineage ? existing.revoked_delegations : [];
}

function isDefinitiveCompletionRejection(error: EdenErrorLike): boolean {
  return (
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function verifyRootBinding(
  approval: DaemonLinkApproval,
  input: RunLinkClaimInput,
  daemonIdentityKeyCommitment: string,
): boolean {
  const rootPublicKey = decodeUserAuthorizationBytes(
    approval.userRootPublicKey,
    USER_AUTHORIZATION_PUBLIC_KEY_BYTES,
    'user root public key',
  );
  try {
    const rootKeyCommitment = deriveUserRootKeyCommitment(rootPublicKey);
    if (approval.daemonBinding.rootKeyCommitment !== rootKeyCommitment) return false;
    return (
      verifyDaemonBinding(approval.daemonBinding, rootPublicKey, {
        userId: approval.daemonBinding.userId,
        rootKeyCommitment,
        daemonId: input.daemonId,
        daemonIdentityKeyCommitment,
        serverOrigin: input.serverOrigin,
        linkClaimId: approval.linkClaimId,
        issuedAt: approval.daemonBinding.issuedAt,
      }) !== null
    );
  } finally {
    rootPublicKey.fill(0);
  }
}

interface ApprovedClaim {
  readonly sessionTokenVerifyKey: string;
  readonly approval: DaemonLinkApproval;
}

function pollUntilApproved(
  input: RunLinkClaimInput,
  linkClaimId: string,
  pollToken: string,
  expiresAt: number,
): Effect.Effect<ApprovedClaim | null, Error> {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* Effect.tryPromise({
        try: () => input.dependencies.pollClaim(input.serverOrigin, linkClaimId, pollToken),
        catch: normalizeUnknownError,
      });
      if (result.error !== null) {
        logLinkError(input.logger, result.error);
        return null;
      }
      const parsed = parseClaimStatus(result.data);
      if (parsed === null) {
        input.logger.error('daemon_link_failed', { error: 'invalid_claim_status' });
        return null;
      }
      if (parsed.status === 'approved') return parsed;
      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs >= expiresAt) {
        input.logger.error('daemon_link_failed', { error: 'link_claim_expired' });
        return null;
      }
      yield* Effect.sleep(LINK_POLL_INTERVAL);
    }
  });
}

function loadLinkIdentity(dependencies: DaemonLinkCommandDependencies) {
  return dependencies.loadExistingConfig().pipe(
    Effect.map((config) =>
      config === null ? { _tag: 'missing' as const } : { _tag: 'current' as const, config },
    ),
    Effect.catch(() =>
      dependencies.loadLegacyConfigForMigration().pipe(
        Effect.map((migration) => ({ _tag: 'legacy' as const, migration })),
        Effect.catch(() => Effect.succeed({ _tag: 'failed' as const })),
      ),
    ),
  );
}

function parseCreatedClaim(value: unknown): {
  readonly pollToken: string;
  readonly serverNonce: string;
  readonly expiresAt: number;
  readonly machineUsage: MachineUsage;
  readonly canLink: boolean;
} | null {
  if (!hasExactKeys(value, ['pollToken', 'serverNonce', 'expiresAt', 'machineUsage', 'canLink']))
    return null;
  const pollToken = canonicalBytes(value.pollToken, 32);
  const serverNonce = canonicalBytes(value.serverNonce, USER_AUTHORIZATION_NONCE_BYTES);
  return pollToken === null ||
    serverNonce === null ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 0 ||
    !isMachineUsage(value.machineUsage) ||
    typeof value.canLink !== 'boolean'
    ? null
    : {
        pollToken,
        serverNonce,
        expiresAt: value.expiresAt,
        machineUsage: value.machineUsage,
        canLink: value.canLink,
      };
}

function parseClaimStatus(
  value: unknown,
): ({ readonly status: 'pending' } | ({ readonly status: 'approved' } & ApprovedClaim)) | null {
  if (!isRecord(value)) return null;
  if (value.status === 'pending' && Object.keys(value).length === 1) return { status: 'pending' };
  if (
    value.status !== 'approved' ||
    !hasExactKeys(value, ['status', 'sessionTokenVerifyKey', 'approval'])
  ) {
    return null;
  }
  const sessionTokenVerifyKey = readNonEmptyStringField(value, 'sessionTokenVerifyKey');
  if (sessionTokenVerifyKey === null) return null;
  let approval: DaemonLinkApproval;
  try {
    approval = parseDaemonLinkApproval(value.approval);
  } catch {
    return null;
  }
  return {
    status: 'approved',
    sessionTokenVerifyKey,
    approval,
  };
}

async function postDaemonLinkClaim(
  serverOrigin: string,
  request: DaemonLinkCreateRequest,
): Promise<DaemonLinkPostResult> {
  return requestJson(new URL(LINK_CLAIMS_PATH, serverOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

async function pollDaemonLinkClaim(
  serverOrigin: string,
  linkClaimId: string,
  pollToken: string,
): Promise<DaemonLinkPostResult> {
  return requestJson(linkClaimUrl(serverOrigin, linkClaimId), {
    headers: { authorization: `Bearer ${pollToken}` },
  });
}

async function completeDaemonLinkClaim(
  serverOrigin: string,
  linkClaimId: string,
  pollToken: string,
  approvalMac: string,
): Promise<DaemonLinkPostResult> {
  const claimUrl = linkClaimUrl(serverOrigin, linkClaimId);
  return requestJson(new URL(`${claimUrl.pathname}/complete`, serverOrigin), {
    method: 'POST',
    headers: { authorization: `Bearer ${pollToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ approvalMac }),
  });
}

async function requestJson(url: URL, init: RequestInit): Promise<DaemonLinkPostResult> {
  const response = await fetch(url, init);
  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  return response.ok
    ? { data, error: null }
    : { data: null, error: { status: response.status, value: data } };
}

function linkClaimUrl(serverOrigin: string, linkClaimId: string): URL {
  return new URL(`${LINK_CLAIMS_PATH}/${encodeURIComponent(linkClaimId)}`, serverOrigin);
}

function logLinkError(logger: Logger, error: EdenErrorLike): void {
  const errorBody = readErrorBody(error.value);
  logger.error('daemon_link_failed', {
    status: readErrorStatus(error),
    error: errorBody.error,
    details:
      errorBody.error === 'machine_limit_reached'
        ? 'Machine limit reached. Unlink a machine in Merkur, then copy and run a new link command.'
        : errorBody.details,
  });
}

function readErrorBody(value: unknown): {
  readonly error: string;
  readonly details: string | null;
} {
  if (!isRecord(value)) return { error: '', details: null };
  return {
    error: readNonEmptyStringField(value, 'error') ?? '',
    details: readNonEmptyStringField(value, 'details'),
  };
}

export function parseLinkArguments(args: string[]): {
  readonly requestedServerOrigin: string;
  readonly forceSoftware: boolean;
  readonly replaceIdentity: boolean;
} | null {
  const requestedServerOrigin = args[0];
  if (typeof requestedServerOrigin !== 'string' || requestedServerOrigin.length === 0) return null;
  let forceSoftware = false;
  let replaceIdentity = false;
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--replace-identity' && !replaceIdentity) replaceIdentity = true;
    else if (
      args[index] === '--identity-backend' &&
      args[index + 1] === 'software' &&
      !forceSoftware
    ) {
      forceSoftware = true;
      index++;
    } else return null;
  }
  return { requestedServerOrigin, forceSoftware, replaceIdentity };
}

const resolveLinkIdentitySeal = Effect.fnUntraced(function* (
  existing: DaemonConfig | null,
  choice: { readonly forceSoftware: boolean; readonly replaceIdentity: boolean },
  logger: Logger,
  dependencies: DaemonLinkCommandDependencies,
): Effect.fn.Return<SealedDaemonIdentity, IdentitySealError> {
  if (existing !== null && !choice.replaceIdentity)
    return yield* dependencies.inspectIdentitySeal(existing.daemon_identity_seal);
  return yield* dependencies.createIdentitySeal({ forceSoftware: choice.forceSoftware }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (error.code !== 'tpm_access_denied' || choice.forceSoftware) return yield* error;
        const repaired = yield* dependencies.repairTpmAccess(logger);
        if (!repaired) return yield* error;
        return yield* dependencies.createIdentitySeal({ forceSoftware: false });
      }),
    ),
  );
});

function readErrorStatus(error: EdenErrorLike): number | string {
  return typeof error.status === 'number' || typeof error.status === 'string'
    ? error.status
    : 'unknown';
}

function canonicalBytes(value: unknown, expectedBytes: number): string | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = decodeUserAuthorizationBytes(value, expectedBytes);
    bytes.fill(0);
    return value;
  } catch {
    return null;
  }
}
