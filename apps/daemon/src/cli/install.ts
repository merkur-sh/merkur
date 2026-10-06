import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { normalizeUnknownError } from '@merkur/shared';
import { Effect } from 'effect';

import { launchAgentPath, systemdUserUnitPath } from '../config';
import type { Logger } from '../logger';
import { resolveLaunchctlUserId, runLaunchctlEffect } from './launchctl';
import { DAEMON_LAUNCHD_LABEL, DAEMON_SYSTEMD_UNIT_NAME } from './service-identity';
import { runSystemctlEffect } from './systemctl';

const LABEL = DAEMON_LAUNCHD_LABEL;
const SYSTEMD_UNIT_NAME = DAEMON_SYSTEMD_UNIT_NAME;
const LAUNCHCTL_EVENTS = {
  ignored: 'daemon_install_launchctl_ignored',
  failed: 'daemon_install_failed',
};
const SYSTEMCTL_EVENTS = {
  ignored: 'daemon_install_systemctl_ignored',
  failed: 'daemon_install_failed',
};

export async function runInstallCommand(logger: Logger): Promise<number> {
  return Effect.runPromise(runInstallCommandEffect(logger));
}

function runInstallCommandEffect(logger: Logger): Effect.Effect<number, Error> {
  return installDaemonServiceEffect(logger, [...resolveProgramArguments(), 'daemon']);
}

export function installDaemonServiceForExecutableEffect(
  logger: Logger,
  executablePath: string,
): Effect.Effect<number, Error> {
  return installDaemonServiceEffect(logger, buildDaemonServiceProgramArguments(executablePath));
}

function installDaemonServiceEffect(
  logger: Logger,
  programArguments: readonly string[],
): Effect.Effect<number, Error> {
  if (process.platform === 'linux') {
    return runSystemdInstallEffect(logger, programArguments);
  }
  if (process.platform === 'darwin') {
    return runLaunchdInstallEffect(logger, programArguments);
  }
  return Effect.fail(new Error(`merkur install is not supported on ${process.platform}`));
}

function runLaunchdInstallEffect(
  logger: Logger,
  programArguments: readonly string[],
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const plistPath = launchAgentPath();
    const plistDirectory = path.dirname(plistPath);
    const uid = resolveLaunchctlUserId();
    const launchDomain = `gui/${uid}`;
    const serviceTarget = `${launchDomain}/${LABEL}`;

    yield* Effect.tryPromise({
      try: () => mkdir(plistDirectory, { recursive: true }),
      catch: normalizeUnknownError,
    });
    yield* Effect.tryPromise({
      try: () => writeFile(plistPath, buildLaunchdPlist(programArguments), 'utf8'),
      catch: normalizeUnknownError,
    });

    yield* runLaunchctlEffect(logger, ['bootout', launchDomain, plistPath], true, LAUNCHCTL_EVENTS);
    if (
      !(yield* runLaunchctlEffect(
        logger,
        ['bootstrap', launchDomain, plistPath],
        false,
        LAUNCHCTL_EVENTS,
      ))
    ) {
      return 1;
    }
    if (!(yield* runLaunchctlEffect(logger, ['enable', serviceTarget], false, LAUNCHCTL_EVENTS))) {
      return 1;
    }
    if (
      !(yield* runLaunchctlEffect(
        logger,
        ['kickstart', '-k', serviceTarget],
        false,
        LAUNCHCTL_EVENTS,
      ))
    ) {
      return 1;
    }

    logger.info('daemon_install_success', { plistPath, serviceTarget });

    return 0;
  });
}

function runSystemdInstallEffect(
  logger: Logger,
  programArguments: readonly string[],
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const unitPath = systemdUserUnitPath();
    const unitDirectory = path.dirname(unitPath);

    yield* Effect.tryPromise({
      try: () => mkdir(unitDirectory, { recursive: true }),
      catch: normalizeUnknownError,
    });
    yield* Effect.tryPromise({
      try: () => writeFile(unitPath, buildSystemdUnit(programArguments), 'utf8'),
      catch: normalizeUnknownError,
    });

    if (!(yield* runSystemctlEffect(logger, ['daemon-reload'], false, SYSTEMCTL_EVENTS))) {
      return 1;
    }
    if (
      !(yield* runSystemctlEffect(
        logger,
        ['enable', '--now', SYSTEMD_UNIT_NAME],
        false,
        SYSTEMCTL_EVENTS,
      ))
    ) {
      return 1;
    }
    // Idempotent re-install: pick up a rewritten ExecStart on a running unit.
    if (
      !(yield* runSystemctlEffect(logger, ['restart', SYSTEMD_UNIT_NAME], false, SYSTEMCTL_EVENTS))
    ) {
      return 1;
    }

    logger.info('daemon_install_success', { unitPath, serviceTarget: SYSTEMD_UNIT_NAME });
    yield* ensureLingerEffect(logger);

    return 0;
  });
}

/**
 * Keeps the user's systemd instance — and the daemon in it — running after the
 * last login session closes, which is the whole point of a remote terminal.
 *
 * `loginctl enable-linger` for one's own user is allowed without root by
 * logind's default polkit policy on the common distributions. Where a policy
 * refuses it, the daemon still runs while someone is logged in, so the install
 * succeeds and names the one command that finishes the job.
 */
function ensureLingerEffect(logger: Logger): Effect.Effect<void> {
  return Effect.promise(async () => {
    const user = userInfo().username;
    const lingering = await runLoginctl(['show-user', user, '--property=Linger', '--value']);
    if (lingering.exitCode === 0 && lingering.stdout.trim() === 'yes') return;
    const enabled = await runLoginctl(['enable-linger', user]);
    if (enabled.exitCode === 0) {
      logger.info('daemon_install_linger_enabled', { user });
      return;
    }
    logger.warn('daemon_install_linger_failed', {
      user,
      error: enabled.stderr.trim(),
      hint: `sudo loginctl enable-linger ${user}`,
    });
  });
}

async function runLoginctl(
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const proc = Bun.spawn(['loginctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    // No loginctl at all: a system without logind, where lingering does not exist.
    return { exitCode: 127, stdout: '', stderr: String(error) };
  }
}

/** The argv that runs this `merkur` CLI: the compiled binary, or bun on the source. */
export function resolveProgramArguments(): string[] {
  const daemonProjectDirectory = path.resolve(import.meta.dir, '../..');
  const daemonSourceEntry = path.join(daemonProjectDirectory, 'src/index.ts');
  if (existsSync(daemonSourceEntry)) {
    const bunPath = Bun.which('bun');
    if (!bunPath) {
      throw new Error('bun executable not found in PATH');
    }
    return [bunPath, 'run', '--cwd', daemonProjectDirectory, 'src/index.ts'];
  }

  // Compiled binary: when not running under `bun`, execPath is the real
  // on-disk merkur executable (import.meta paths point into the embedded
  // virtual filesystem and cannot be re-executed).
  if (path.basename(process.execPath) !== 'bun') {
    return [process.execPath];
  }

  const bunPath = Bun.which('bun');
  if (!bunPath) {
    throw new Error('bun executable not found in PATH');
  }

  return [bunPath, 'run', '--cwd', daemonProjectDirectory, 'src/index.ts'];
}

export function buildDaemonServiceProgramArguments(executablePath: string): readonly string[] {
  return [path.resolve(executablePath), 'daemon'];
}

function buildLaunchdPlist(programArguments: readonly string[]): string {
  const programArgumentsXml = programArguments
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/merkur-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/merkur-daemon.err.log</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit(programArguments: readonly string[]): string {
  const execStart = programArguments.map(quoteSystemdArgument).join(' ');

  return `[Unit]
Description=Merkur daemon
After=network-online.target

[Service]
ExecStart=${execStart}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function quoteSystemdArgument(argument: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(argument)) {
    return argument;
  }
  return `"${argument.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
