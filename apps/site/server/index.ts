import { createLogger, errorLogContext } from '@merkur/logger';

import { parseSiteServerConfig } from './config';
import { loadSite, startSiteServer, UPSTREAM_TIMEOUT_MS } from './site-server';

/**
 * `site-server <dist directory>`: serves merkur.sh from the build's
 * manifest and proxies Rybbit. A bad environment or a manifest that names a
 * missing file stops the start, so a broken build never passes the health
 * check that would put it in front of visitors.
 */
const LISTEN_HOSTNAME = '0.0.0.0';
const logger = createLogger('site-server');

try {
  const config = parseSiteServerConfig({
    environment: process.env,
    // Replaced by a string literal in the compiled executable (`build.ts`).
    apiOrigin: process.env.MERKUR_SITE_API_ORIGIN,
    args: process.argv.slice(2),
  });
  const site = await loadSite(config.distDirectory, config.apiOrigin);
  const server = startSiteServer({
    site,
    hostname: LISTEN_HOSTNAME,
    port: config.port,
    rybbitHost: config.rybbitHost,
    trustedProxyHops: config.trustedProxyHops,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    logger,
  });
  logger.info('site_server_started', {
    port: server.port,
    paths: site.resources.size,
    rybbitHost: config.rybbitHost,
  });
  // Railway stops the previous container with SIGTERM once the next one is
  // healthy. Stop listening and let the requests in flight finish; the process
  // exits when the last connection closes.
  process.once('SIGTERM', () => {
    logger.info('site_server_stopping', {});
    void server.stop();
  });
} catch (error) {
  logger.error('site_server_start_failed', errorLogContext(error));
  process.exitCode = 1;
}
