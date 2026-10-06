import { Elysia, status } from 'elysia';

import type { Logger } from '../../logger';
import { INSTALL_SCRIPT_CONTENT_TYPE, renderInstallScript } from '../install-script';
import {
  isReservedBackendPath,
  resolveStaticAssetPath,
  serveStaticAsset,
  serveWebIndex,
} from '../web-ui';

const STATUS_NOT_FOUND = 404;
/**
 * The legal pages at the URLs people are sent to. The files live under
 * `/legal/` in the web build, outside the app shell and its service worker.
 */
const LEGAL_PAGES: Readonly<Record<string, string>> = {
  '/privacy': '/legal/privacy.html',
  '/terms': '/legal/terms.html',
};

interface WebRoutesOptions {
  readonly logger: Logger;
  readonly webIndexFile: string;
  readonly webDistDirectory: string;
  readonly publicOrigin: string;
}

export function webRoutesPlugin({
  logger,
  webIndexFile,
  webDistDirectory,
  publicOrigin,
}: WebRoutesOptions) {
  return new Elysia({ name: 'web-routes' })
    .get('/install', ({ set }) => {
      set.headers['content-type'] = INSTALL_SCRIPT_CONTENT_TYPE;
      return renderInstallScript(publicOrigin);
    })
    .get('/', ({ request }) => serveWebIndex(webIndexFile, logger, request))
    .get('/privacy', ({ request }) => serveLegalPage(request, '/privacy', webDistDirectory))
    .get('/terms', ({ request }) => serveLegalPage(request, '/terms', webDistDirectory))
    .get('/*', ({ path: requestPath, request }) => {
      if (isReservedBackendPath(requestPath)) {
        return status(STATUS_NOT_FOUND, { error: 'not_found' as const });
      }

      const staticAssetPath = resolveStaticAssetPath(requestPath, webDistDirectory);
      if (staticAssetPath !== null) {
        return serveStaticAsset(request, staticAssetPath);
      }

      return serveWebIndex(webIndexFile, logger, request);
    });
}

function serveLegalPage(request: Request, route: string, webDistDirectory: string) {
  const file = LEGAL_PAGES[route];
  const source = file === undefined ? null : resolveStaticAssetPath(file, webDistDirectory);
  if (source === null) return status(STATUS_NOT_FOUND, { error: 'not_found' as const });
  return serveStaticAsset(request, source);
}
