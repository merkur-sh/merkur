import { merkurRelease, merkurVersion } from '@merkur/shared';
import { Effect } from 'effect';

import { loadDaemonConfigEffect, merkurInstallRootPath } from '../config';
import type { Logger } from '../logger';
import {
  activateReleaseEffect,
  fetchServerReleaseEffect,
  stageReleaseEffect,
} from '../services/daemon-release';

export async function runUpdateCommand(logger: Logger): Promise<number> {
  return Effect.runPromise(runUpdateCommandEffect(logger));
}

/**
 * `merkur update`: installs the release this machine's server runs, now. A linked daemon
 * does the same on its own before every connection and takes its terminal over with it;
 * this is for an install the daemon is not running from, such as one that only signs in,
 * and for doing it before the daemon next connects.
 */
function runUpdateCommandEffect(logger: Logger): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    if (merkurVersion() === 'dev') {
      logger.error('daemon_update_unsupported', {
        reason: 'running from source; update with git instead',
      });
      return 1;
    }
    const origin = (yield* loadDaemonConfigEffect())?.server_origin ?? publicOrigin();
    if (origin === null) {
      logger.error('daemon_update_unsupported', {
        reason: 'this build names no server; link this machine first',
      });
      return 1;
    }
    const release = yield* fetchServerReleaseEffect(origin);
    if (release === merkurRelease()) {
      logger.info('daemon_update_up_to_date', { release });
      return 0;
    }
    const installRoot = merkurInstallRootPath();
    const versionDirectory = yield* stageReleaseEffect({ logger, installRoot, origin, release });
    yield* activateReleaseEffect({
      logger,
      installRoot,
      versionDirectory,
      running: merkurRelease(),
    });
    logger.info('daemon_update_success', { from: merkurRelease(), to: release });
    return 0;
  });
}

function publicOrigin(): string | null {
  const origin = process.env.MERKUR_PUBLIC_ORIGIN ?? '';
  return origin === '' ? null : origin;
}
