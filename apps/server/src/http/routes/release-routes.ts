import path from 'node:path';
import {
  isReleaseStoreFile,
  isReleaseVersion,
  merkurRelease,
  RELEASE_ENDPOINT_PATH,
  RELEASE_FILES_PATH,
  RELEASE_MANIFEST_FILE,
} from '@merkur/shared';
import { Elysia, status } from 'elysia';

import type { runServerProgram } from '../../runtime';
import { withinRateLimitsEffect } from '../../services/rate-limit-service';
import { ApiModels } from '../api-models';
import { resolveRateLimitSource } from '../client-ip';

const STATUS_NOT_FOUND = 404;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_SERVICE_UNAVAILABLE = 503;
/**
 * A daemon converging to one release reads three files (manifest, signature, its archive),
 * and the installer reads the same three. Twenty convergences per address per ten minutes
 * covers every machine behind one NAT updating together, and caps what one address can make
 * this server send at twenty archives.
 */
const RELEASE_FILE_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RELEASE_FILE_IP_LIMIT = 60;

interface ReleaseRoutesOptions {
  readonly runServerProgram: typeof runServerProgram;
  /** `<store>/<version>/<file>`, written whole by the release workflow before it deploys. */
  readonly storeDirectory: string;
  readonly trustedProxyHops: number;
}

/**
 * The two frozen release endpoints (docs/releases.md, Convergence): which release this
 * server's daemons run, and the signed files of any release in its store. A daemon on the
 * previous release reads both from the server that replaced it, so neither ever changes shape.
 * Nothing here is trusted by the reader: the manifest signature is.
 */
export function releaseRoutesPlugin({
  runServerProgram,
  storeDirectory,
  trustedProxyHops,
}: ReleaseRoutesOptions) {
  return new Elysia({ name: 'release-routes' })
    .get(RELEASE_ENDPOINT_PATH, { response: { 200: ApiModels.ReleaseResponse } }, ({ set }) => {
      set.headers['cache-control'] = 'no-store';
      return { release: merkurRelease() };
    })
    .get(`${RELEASE_FILES_PATH}/:version/:file`, async ({ params, request, server, set }) => {
      const { version, file } = params;
      if (!isReleaseVersion(version) || !isReleaseStoreFile(file)) {
        return status(STATUS_NOT_FOUND, { error: 'not_found' as const });
      }
      const clientIp = resolveRateLimitSource(request, server, trustedProxyHops);
      try {
        const allowed = await runServerProgram(
          withinRateLimitsEffect([
            {
              key: `release-files:ip:${clientIp}`,
              limit: RELEASE_FILE_IP_LIMIT,
              windowMs: RELEASE_FILE_RATE_LIMIT_WINDOW_MS,
            },
          ]),
          { signal: request.signal },
        );
        if (!allowed) return status(STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' as const });
      } catch {
        return status(STATUS_SERVICE_UNAVAILABLE, { error: 'unavailable' as const });
      }
      const source = Bun.file(path.join(storeDirectory, version, file));
      if (!(await source.exists())) {
        return status(STATUS_NOT_FOUND, { error: 'not_found' as const });
      }
      // A version's files are signed once and never rewritten.
      set.headers['cache-control'] = 'public, max-age=31536000, immutable';
      set.headers['content-type'] =
        file === RELEASE_MANIFEST_FILE ? 'application/json' : 'application/octet-stream';
      return source;
    });
}
