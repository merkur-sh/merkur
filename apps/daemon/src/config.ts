import os from 'node:os';
import path from 'node:path';

import {
  canonicalizeDaemonServerOrigin,
  type DaemonConfig,
  type DaemonEnvironment,
  DaemonEnvironmentLive,
  DaemonEnvironmentService,
  daemonConfigPathForHome,
  ensureShellTokenAtPath,
  launchAgentPathForHome,
  loadDaemonConfigFromPath,
  MERKUR_WEBTRANSPORT_PORT,
  removeDaemonConfigFromPath,
  requireDaemonConfigFromPath,
  saveDaemonConfigToPath,
  shellTokenPathForHome,
  systemdUserUnitPathForHome,
  validateDaemonConfig,
} from '@merkur/config';
import { normalizeUnknownError } from '@merkur/shared';
import type { DaemonBinding } from '@merkur/shared/user-authorization';
import { Effect } from 'effect';

const daemonEnvironment: DaemonEnvironment = Effect.runSync(
  Effect.gen(function* () {
    return yield* DaemonEnvironmentService;
  }).pipe(Effect.provide(DaemonEnvironmentLive)),
);

export interface DaemonEnv {
  readonly HOME: string;
}

export type { DaemonConfig };

const daemonEnv: DaemonEnv = {
  HOME: daemonEnvironment.home,
};

export interface LinkConfigInput {
  readonly daemonId: string;
  readonly serverOrigin: string;
  readonly daemonIdentitySeal: DaemonConfig['daemon_identity_seal'];
  /** The account's login shell, from `readLoginShellEffect`. */
  readonly shell: string;
  readonly sessionTokenVerifyKey: string;
  readonly userRootPublicKey: string;
  readonly rootEpoch: number;
  readonly daemonBinding: DaemonBinding;
  readonly revokedDelegations: DaemonConfig['revoked_delegations'];
}

export function loadDaemonConfigEffect(): Effect.Effect<DaemonConfig | null, Error> {
  return loadDaemonConfigFromPath(daemonConfigPath());
}

export function requireDaemonConfigEffect(): Effect.Effect<DaemonConfig, Error> {
  return requireDaemonConfigFromPath(daemonConfigPath());
}

export function createLinkedConfig(input: LinkConfigInput): DaemonConfig {
  return validateDaemonConfig({
    daemon_id: input.daemonId,
    server_origin: canonicalizeDaemonServerOrigin(input.serverOrigin),
    daemon_identity_seal: input.daemonIdentitySeal,
    shell: input.shell,
    webtransport_port: MERKUR_WEBTRANSPORT_PORT,
    session_token_verify_key: input.sessionTokenVerifyKey,
    user_root_public_key: input.userRootPublicKey,
    root_epoch: input.rootEpoch,
    daemon_binding: input.daemonBinding,
    revoked_delegations: input.revokedDelegations,
  });
}

export function saveDaemonConfigEffect(config: DaemonConfig): Effect.Effect<void, Error> {
  return saveDaemonConfigToPath(daemonConfigPath(), config);
}

export function removeDaemonConfigEffect(): Effect.Effect<void, Error> {
  return removeDaemonConfigFromPath(daemonConfigPath());
}

export function daemonConfigPath(): string {
  return daemonConfigPathForHome(daemonEnv.HOME);
}

export function launchAgentPath(): string {
  return launchAgentPathForHome(daemonEnv.HOME);
}

export function systemdUserUnitPath(): string {
  return systemdUserUnitPathForHome(daemonEnv.HOME);
}

/**
 * `host:port` an operator-installed port mapping publishes this daemon on, or
 * `null`.
 *
 * Read from the environment at startup like `HOME` above, because it describes
 * the host rather than the daemon. A box host sets it from the port it
 * allocated and the public address it publishes; elsewhere it is unset and the
 * daemon offers only the candidates it can discover for itself.
 */
export function publicWebtransportEndpoint(): string | null {
  return daemonEnvironment.publicWebtransportEndpoint;
}

export function shellTokenPath(): string {
  return shellTokenPathForHome(daemonEnv.HOME);
}

export function ensureShellTokenEffect(): Effect.Effect<string, Error> {
  return ensureShellTokenAtPath(shellTokenPath());
}

export function daemonInstanceLockPath(daemonId: string): string {
  return path.join(path.dirname(daemonConfigPath()), `daemon-${daemonId}.lock`);
}

/** ~/.merkur — also the root of the versioned binary install layout. */
export function merkurInstallRootPath(): string {
  return path.dirname(daemonConfigPath());
}

export function currentMachineName(): string {
  return os.hostname();
}

/**
 * The account's login shell, from the password database: the shell login(1),
 * sshd and tmux start for this user, and so the one every Merkur terminal opens.
 *
 * Neither `$SHELL` nor `os.userInfo().shell` is that value. Bun answers the
 * latter from `$SHELL`, and with "unknown" when it is unset, so both name
 * whichever shell launched this command: a coding agent's tool shell, or the
 * one `runuser -s` forced. `id -P` and `getent passwd` ask the resolver
 * `getpwuid` asks, Directory Services and NSS included.
 */
export function readLoginShellEffect(): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error('this platform has no numeric user id');
      const query = passwordEntryQuery(process.platform, uid);
      const child = Bun.spawn([...query], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
      const [output, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`${query.join(' ')} exited ${exitCode}`);
      return loginShellFromPasswordEntry(process.platform, output);
    },
    catch: normalizeUnknownError,
  });
}

function passwordEntryQuery(platform: NodeJS.Platform, uid: number): readonly string[] {
  if (platform === 'darwin') return ['/usr/bin/id', '-P', String(uid)];
  if (platform === 'linux') return ['getent', 'passwd', String(uid)];
  throw new Error(`no password database query for ${platform}`);
}

/** macOS `id -P` prints master.passwd's ten fields; `getent passwd` the classic seven. */
const PASSWORD_ENTRY_FIELDS: Partial<Record<NodeJS.Platform, number>> = { darwin: 10, linux: 7 };

/** The shell field of the one password entry `output` holds. */
export function loginShellFromPasswordEntry(platform: NodeJS.Platform, output: string): string {
  const lines = output.split('\n').filter((line) => line.length > 0);
  const fields = lines.length === 1 ? (lines[0]?.split(':') ?? []) : [];
  const shell = fields.length === PASSWORD_ENTRY_FIELDS[platform] ? fields.at(-1) : undefined;
  if (shell === undefined || !path.isAbsolute(shell)) {
    throw new Error('the password database names no login shell for this account');
  }
  return shell;
}

export function currentPlatformLabel(): string {
  return `${process.platform}-${process.arch}`;
}
