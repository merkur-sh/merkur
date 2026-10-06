import { merkurVersion } from '@merkur/shared';
import { Elysia } from 'elysia';

import type { ServerConfig } from '../config';
import type { Logger } from '../logger';
import { readInlineStyleHashes, securityHeadersPlugin } from '../middleware/security-headers';
import type { runServerProgram } from '../runtime';
import type { AuthenticatedBrowser } from '../services/auth-service';
import { apiErrorPlugin } from './api-errors';
import { ApiModels } from './api-models';
import { readSignedBuildIdentity } from './build-identity';
import { accountRoutesPlugin } from './routes/account-routes';
import { authRoutesPlugin } from './routes/auth-routes';
import { boxAccessRoutesPlugin } from './routes/box-access-routes';
import { boxWaitlistCorsPlugin, boxWaitlistRoutesPlugin } from './routes/box-waitlist-routes';
import { browserSessionRoutesPlugin } from './routes/browser-session-routes';
import { daemonControlRoutesPlugin } from './routes/daemon-control-routes';
import { daemonLinkClaimRoutesPlugin } from './routes/daemon-link-claim-routes';
import { deviceRoutesPlugin } from './routes/device-routes';
import { edgeRoutesPlugin } from './routes/edge-routes';
import { healthRoutesPlugin } from './routes/health-routes';
import { keyboardSettingsRoutesPlugin } from './routes/keyboard-settings-routes';
import { notificationRoutesPlugin } from './routes/notification-routes';
import { sessionRoutesPlugin } from './routes/session-routes';
import { telemetryRoutesPlugin } from './routes/telemetry-routes';
import { webRoutesPlugin } from './routes/web-routes';
import type { DeviceEventsSseLifetime } from './sse';

export interface ServerAppOptions {
  readonly deviceEventsLifetime: DeviceEventsSseLifetime;
  readonly config: ServerConfig;
  readonly runServerProgram: typeof runServerProgram;
  readonly authorizeRequest: (request: Request) => Promise<AuthenticatedBrowser | null>;
  readonly logger: Logger;
  readonly webIndexFile: string;
  readonly webDistDirectory: string;
}

export function createServerApp({
  deviceEventsLifetime,
  config,
  runServerProgram,
  authorizeRequest,
  logger,
  webIndexFile,
  webDistDirectory,
}: ServerAppOptions) {
  const buildId = process.env.MERKUR_BUILD_ID ?? '';
  const buildIdentity =
    buildId === ''
      ? null
      : readSignedBuildIdentity(
          '/deployment',
          buildId,
          process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '',
        );
  // Unknown request fields are rejected instead of silently normalized away.
  // This is security-critical for enrollment: retired credential fields sent
  // beside the daemon identity key must fail at the HTTP boundary, never be
  // silently ignored as though a second trust mode still existed.
  // Read once at construction: the shell is a build artifact and does not change
  // while the process runs, and the policy must allow exactly the stylesheet the
  // build inlined into it.
  const app = new Elysia({ normalize: false }).use(
    securityHeadersPlugin(readInlineStyleHashes(webIndexFile)),
  );
  // No HTTP tracing plugin. The root span for a request is opened by
  // `runRouteEffect`, which is already the single funnel every Effect route
  // passes through, and its parent is parsed from the request's own
  // `traceparent` header rather than read from ambient context. That removes
  // the two-span-systems bridge behind three trace-corruption incidents; see
  // `observability/telemetry.ts`.
  const { website } = config;
  // Ahead of the error contract, so the website's CORS headers are on every
  // answer the waitlist path gives, failures included.
  if (website !== undefined) app.use(boxWaitlistCorsPlugin(website.origin));
  const api = app
    // Register the shared error contract before the routes that inherit it.
    .use(apiErrorPlugin)
    .get('/api/version', { response: { 200: ApiModels.ServerVersionResponse } }, () => ({
      version: merkurVersion(),
    }))
    .get('/api/build-identity', ({ set }) => {
      set.headers['cache-control'] = 'no-store';
      return buildIdentity;
    })
    .use(
      healthRoutesPlugin({
        runServerProgram,
      }),
    )
    .use(
      authRoutesPlugin({
        runServerProgram,
        authorizeRequest,
        logger,
        publicOrigin: config.publicOrigin,
        trustedProxyHops: config.trustedProxyHops,
        identity: config.authIdentity,
        allowRegistration: config.authAllowRegistration,
      }),
    )
    .use(browserSessionRoutesPlugin({ runServerProgram, authorizeRequest, logger }))
    .use(accountRoutesPlugin({ runServerProgram, authorizeRequest, logger }))
    .use(
      daemonLinkClaimRoutesPlugin({
        runServerProgram,
        authorizeRequest,
        logger,
        trustedProxyHops: config.trustedProxyHops,
      }),
    )
    .use(
      daemonControlRoutesPlugin({
        runServerProgram,
        logger,
        publicOrigin: config.publicOrigin,
        trustedProxyHops: config.trustedProxyHops,
      }),
    )
    .use(
      deviceRoutesPlugin({
        deviceEventsLifetime,
        runServerProgram,
        authorizeRequest,
        logger,
        trustedProxyHops: config.trustedProxyHops,
      }),
    )
    .use(
      boxAccessRoutesPlugin({
        runServerProgram,
        authorizeRequest,
        logger,
        trustedProxyHops: config.trustedProxyHops,
      }),
    )
    .use(
      notificationRoutesPlugin({
        runServerProgram,
        authorizeRequest,
        logger,
      }),
    )
    .use(
      keyboardSettingsRoutesPlugin({
        runServerProgram,
        authorizeRequest,
        logger,
      }),
    )
    .use(
      telemetryRoutesPlugin({
        runServerProgram,
        authorizeRequest,
        logger,
      }),
    )
    .use(
      sessionRoutesPlugin({
        runServerProgram,
        authorizeRequest,
        logger,
        trustedProxyHops: config.trustedProxyHops,
      }),
    )
    .use(
      edgeRoutesPlugin({
        runServerProgram,
        logger,
        trustedProxyHops: config.trustedProxyHops,
      }),
    );
  // Mounted only for a deployment that names its website; without one the path
  // is the application shell's, like any other the API does not answer.
  if (website !== undefined) {
    api.use(
      boxWaitlistRoutesPlugin({
        runServerProgram,
        logger,
        trustedProxyHops: config.trustedProxyHops,
        siteOrigin: website.origin,
      }),
    );
  }
  return api.use(
    webRoutesPlugin({
      logger,
      webIndexFile,
      webDistDirectory,
      publicOrigin: config.publicOrigin,
    }),
  );
}
