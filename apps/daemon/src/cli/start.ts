import { existsSync } from 'node:fs';
import { Effect } from 'effect';

import { launchAgentPath, systemdUserUnitPath } from '../config';
import type { Logger } from '../logger';
import { resolveLaunchctlUserId, runLaunchctlEffect } from './launchctl';
import { DAEMON_LAUNCHD_LABEL, DAEMON_SYSTEMD_UNIT_NAME } from './service-identity';
import { runSystemctlEffect } from './systemctl';

const LABEL = DAEMON_LAUNCHD_LABEL;
const SYSTEMD_UNIT_NAME = DAEMON_SYSTEMD_UNIT_NAME;
const LAUNCHCTL_EVENTS = {
  ignored: 'daemon_start_launchctl_ignored',
  failed: 'daemon_start_failed',
};
const SYSTEMCTL_EVENTS = {
  ignored: 'daemon_start_systemctl_ignored',
  failed: 'daemon_start_failed',
};

export async function runStartCommand(logger: Logger): Promise<number> {
  return Effect.runPromise(runStartCommandEffect(logger));
}

function runStartCommandEffect(logger: Logger): Effect.Effect<number, Error> {
  if (process.platform === 'linux') {
    return runSystemdStartEffect(logger);
  }
  if (process.platform === 'darwin') {
    return runLaunchdStartEffect(logger);
  }
  return Effect.fail(new Error(`merkur start is not supported on ${process.platform}`));
}

function runLaunchdStartEffect(logger: Logger): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const plistPath = launchAgentPath();
    if (!existsSync(plistPath)) {
      return yield* Effect.fail(
        new Error(`No LaunchAgent at ${plistPath}. Run \`merkur install\` first.`),
      );
    }

    const uid = resolveLaunchctlUserId();
    const launchDomain = `gui/${uid}`;
    const serviceTarget = `${launchDomain}/${LABEL}`;

    // `merkur stop` boots the job out of the domain, which is what makes the
    // daemon stay down for the rest of the boot session. Bootstrapping it back
    // in is the step that restores KeepAlive supervision. Already-bootstrapped
    // is the ordinary case after a login reloaded the agent, so it is not fatal.
    yield* runLaunchctlEffect(
      logger,
      ['bootstrap', launchDomain, plistPath],
      true,
      LAUNCHCTL_EVENTS,
    );
    if (!(yield* runLaunchctlEffect(logger, ['enable', serviceTarget], false, LAUNCHCTL_EVENTS))) {
      return 1;
    }
    // Deliberately no `-k`: an already-running daemon keeps its live terminal
    // sessions instead of being killed and respawned.
    if (
      !(yield* runLaunchctlEffect(logger, ['kickstart', serviceTarget], false, LAUNCHCTL_EVENTS))
    ) {
      return 1;
    }

    logger.info('daemon_start_success', { plistPath, serviceTarget });

    return 0;
  });
}

function runSystemdStartEffect(logger: Logger): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const unitPath = systemdUserUnitPath();
    if (!existsSync(unitPath)) {
      return yield* Effect.fail(
        new Error(`No systemd user unit at ${unitPath}. Run \`merkur install\` first.`),
      );
    }

    // Mirrors `merkur stop`'s `disable --now`, so the daemon comes back both
    // now and at the next login.
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

    logger.info('daemon_start_success', { unitPath, serviceTarget: SYSTEMD_UNIT_NAME });

    return 0;
  });
}
