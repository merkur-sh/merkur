import { createHash } from 'node:crypto';
import path from 'node:path';

import { errorLogContext, type Logger } from '@merkur/logger';

import { readSiteManifest, SiteManifestError, type SiteManifestFile } from './manifest';
import {
  createRybbitProxy,
  isTrackingConfigPath,
  matchRybbitRoute,
  type RybbitProxy,
  TRACKING_CONFIG,
  TRACKING_CONFIG_CACHE_CONTROL,
} from './rybbit-proxy';

/**
 * The site's static server.
 *
 * Every byte it can serve is read into memory at startup from the paths
 * `dist/site-manifest.json` names, and each URL is an exact key in one map. A
 * request never reaches the filesystem, so no spelling of a path — dot
 * segments, encoded dots, doubled slashes — can name a file the build did not
 * list. The response headers of every representation are built once, too.
 */

/** `/analytics/track` is the only route with a body; Bun answers 413 past this. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const UPSTREAM_TIMEOUT_MS = 5_000;

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/**
 * Browsers revalidate every navigation; the CDN holds an hour and may serve a
 * stale copy for a day while it refetches. A deploy purges the CDN's HTML
 * (`docs/releases.md`), so the hour is never what bounds a release.
 */
const REVALIDATED_CACHE_CONTROL = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';
const NOT_FOUND_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';
const NO_STORE = 'no-store';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const HEALTH_PATH = '/healthz';
/**
 * The installer is the app's (`apps/server/src/http/install-script.ts`), but
 * the command the site prints names the site: `curl -fsSL merkur.sh/install`.
 * curl follows this to the app, which serves the script for its own origin.
 */
const INSTALL_PATH = '/install';
/** The site has one host. Its `www.` alias answers with the same address on the bare host. */
const WWW_PREFIX = 'www.';
const STATUS_PERMANENT_REDIRECT = 308;
const REDIRECT_CACHE_CONTROL = 'public, max-age=3600';
const ACCEPT_ENCODING_HEADER = 'accept-encoding';
const IF_NONE_MATCH_HEADER = 'if-none-match';
const BROTLI_ENCODING = 'br';
const BROTLI_EXTENSION = '.br';
const GET_HEAD = 'GET, HEAD';
const ETAG_HASH_CHARACTERS = 22;

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

interface Representation {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly etag: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The same fields minus the representation metadata a 304 must not restate. */
  readonly notModifiedHeaders: Readonly<Record<string, string>>;
}

interface StaticResource {
  readonly identity: Representation;
  readonly brotli: Representation | null;
}

export interface LoadedSite {
  readonly resources: ReadonlyMap<string, StaticResource>;
  readonly notFound: StaticResource;
  /** Security headers and `Vary`, on every response the server sends. */
  readonly baseHeaders: Readonly<Record<string, string>>;
  /** Where `/install` sends a client: the app's own installer. */
  readonly installLocation: string;
}

export interface SiteServerOptions {
  readonly site: LoadedSite;
  readonly hostname: string;
  readonly port: number;
  readonly rybbitHost: string;
  readonly trustedProxyHops: number;
  readonly upstreamTimeoutMs: number;
  readonly logger: Logger;
}

/**
 * The document policy, sent on every response: a dedicated worker takes its
 * CSP from its own script response, so the replay worker gets the same one.
 * `style-src` admits exactly the build's inline stylesheets by hash; the
 * manifest carries them because the build is what inlined them.
 */
export function contentSecurityPolicy(apiOrigin: string, styleHashes: readonly string[]): string {
  const styleSources =
    styleHashes.length === 0 ? "'none'" : styleHashes.map((hash) => `'${hash}'`).join(' ');
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    "img-src 'self'",
    "font-src 'self'",
    `style-src ${styleSources}`,
    // The waitlist form posts to the app, which sends a form posted without
    // script back here, and a redirect answers to form-action too.
    `form-action ${apiOrigin} 'self'`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * HSTS without `preload`: the application's origin does not send it either
 * (`apps/server/src/middleware/security-headers.ts`), and preload is a
 * commitment for the whole registrable domain, not for this service alone.
 */
function baseHeaders(apiOrigin: string, styleHashes: readonly string[]): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(apiOrigin, styleHashes),
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    vary: 'Accept-Encoding',
  };
}

export async function loadSite(distDirectory: string, apiOrigin: string): Promise<LoadedSite> {
  const manifest = await readSiteManifest(distDirectory);
  const base = baseHeaders(apiOrigin, manifest.styleHashes);
  const documents = new Map(
    await Promise.all(
      [...new Set(Object.values(manifest.routes))].map(
        async (file) =>
          [file, await loadDocument(distDirectory, file, base, REVALIDATED_CACHE_CONTROL)] as const,
      ),
    ),
  );
  const resources = new Map<string, StaticResource>();
  for (const [urlPath, file] of Object.entries(manifest.routes)) {
    resources.set(urlPath, requireDocument(documents, file));
  }
  const files = await Promise.all(
    manifest.files.map(
      async (entry) => [entry.path, await loadFile(distDirectory, entry, base)] as const,
    ),
  );
  for (const [urlPath, resource] of files) {
    resources.set(urlPath, resource);
  }
  return {
    resources,
    notFound: await loadDocument(distDirectory, manifest.notFound, base, NOT_FOUND_CACHE_CONTROL),
    baseHeaders: base,
    installLocation: `${apiOrigin}${INSTALL_PATH}`,
  };
}

export function startSiteServer(options: SiteServerOptions): Bun.Server<undefined> {
  const proxy = createRybbitProxy({
    host: options.rybbitHost,
    trustedProxyHops: options.trustedProxyHops,
    timeoutMs: options.upstreamTimeoutMs,
    baseHeaders: options.site.baseHeaders,
    logger: options.logger,
  });
  const noStore = { ...options.site.baseHeaders, 'cache-control': NO_STORE };
  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    development: false,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: createSiteFetch(options.site, proxy),
    error(error) {
      options.logger.error('site_request_failed', errorLogContext(error));
      return new Response(null, { status: 500, headers: noStore });
    },
  });
}

function createSiteFetch(
  site: LoadedSite,
  proxy: RybbitProxy,
): (request: Request, server: Bun.Server<undefined>) => Response | Promise<Response> {
  const noStore = { ...site.baseHeaders, 'cache-control': NO_STORE };
  const onlyGetHead = { ...noStore, allow: GET_HEAD };
  const onlyPost = { ...noStore, allow: 'POST' };
  const trackingConfig = new TextEncoder().encode(JSON.stringify(TRACKING_CONFIG));
  const trackingConfigHeaders = {
    ...site.baseHeaders,
    'content-type': 'application/json',
    'cache-control': TRACKING_CONFIG_CACHE_CONTROL,
  };

  const redirect = (location: string): Response =>
    new Response(null, {
      status: STATUS_PERMANENT_REDIRECT,
      headers: { ...site.baseHeaders, location, 'cache-control': REDIRECT_CACHE_CONTROL },
    });

  return (request, server) => {
    const url = new URL(request.url);
    const method = request.method;
    const readOnly = method === 'GET' || method === 'HEAD';

    if (url.hostname.startsWith(WWW_PREFIX)) {
      return redirect(
        `https://${url.hostname.slice(WWW_PREFIX.length)}${url.pathname}${url.search}`,
      );
    }
    if (url.pathname === INSTALL_PATH) {
      return readOnly
        ? redirect(site.installLocation)
        : new Response(null, { status: 405, headers: onlyGetHead });
    }

    if (url.pathname === HEALTH_PATH) {
      return new Response(null, {
        status: readOnly ? 204 : 405,
        headers: readOnly ? noStore : onlyGetHead,
      });
    }

    if (isTrackingConfigPath(url.pathname)) {
      if (!readOnly) return new Response(null, { status: 405, headers: onlyGetHead });
      return new Response(trackingConfig, { status: 200, headers: trackingConfigHeaders });
    }

    const route = matchRybbitRoute(url.pathname);
    if (route !== null) {
      const admitted = route.method === 'POST' ? method === 'POST' : readOnly;
      if (!admitted) {
        return new Response(null, {
          status: 405,
          headers: route.method === 'POST' ? onlyPost : onlyGetHead,
        });
      }
      return proxy(request, route, url.search, server);
    }

    if (!readOnly) {
      return new Response(null, { status: 405, headers: onlyGetHead });
    }
    const resource = site.resources.get(url.pathname);
    return resource === undefined
      ? serveResource(request, site.notFound, 404)
      : serveResource(request, resource, 200);
  };
}

function serveResource(request: Request, resource: StaticResource, status: 200 | 404): Response {
  const representation =
    resource.brotli !== null && requestAcceptsEncoding(request, BROTLI_ENCODING)
      ? resource.brotli
      : resource.identity;
  if (status === 200 && matchesIfNoneMatch(request, representation.etag)) {
    return new Response(null, { status: 304, headers: representation.notModifiedHeaders });
  }
  return new Response(representation.body, { status, headers: representation.headers });
}

async function loadDocument(
  distDirectory: string,
  file: string,
  base: Readonly<Record<string, string>>,
  cacheControl: string,
): Promise<StaticResource> {
  // Every document is HTML, which `scripts/compress-site.ts` always compresses.
  return loadResource(distDirectory, file, true, {
    ...base,
    'content-type': HTML_CONTENT_TYPE,
    'cache-control': cacheControl,
  });
}

function loadFile(
  distDirectory: string,
  entry: SiteManifestFile,
  base: Readonly<Record<string, string>>,
): Promise<StaticResource> {
  return loadResource(distDirectory, entry.file, entry.brotli, {
    ...base,
    'content-type': entry.contentType,
    'cache-control': entry.immutable ? IMMUTABLE_CACHE_CONTROL : REVALIDATED_CACHE_CONTROL,
  });
}

async function loadResource(
  distDirectory: string,
  file: string,
  brotli: boolean,
  headers: Readonly<Record<string, string>>,
): Promise<StaticResource> {
  const absolute = path.join(distDirectory, file);
  const identity = representation(await readBytes(absolute), headers, null);
  if (!brotli) {
    return { identity, brotli: null };
  }
  const compressed = representation(
    await readBytes(`${absolute}${BROTLI_EXTENSION}`),
    headers,
    BROTLI_ENCODING,
  );
  return { identity, brotli: compressed };
}

function representation(
  body: Uint8Array<ArrayBuffer>,
  headers: Readonly<Record<string, string>>,
  encoding: string | null,
): Representation {
  const hash = createHash('sha256').update(body).digest('base64url');
  const etag = `"${hash.slice(0, ETAG_HASH_CHARACTERS)}"`;
  const { 'content-type': _contentType, ...notModified } = headers;
  return {
    body,
    etag,
    headers: {
      ...headers,
      etag,
      ...(encoding === null ? {} : { 'content-encoding': encoding }),
    },
    notModifiedHeaders: { ...notModified, etag },
  };
}

async function readBytes(file: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await Bun.file(file).bytes();
  } catch (error) {
    throw new SiteManifestError(`${file} is named by the manifest but not readable`, {
      cause: error,
    });
  }
}

function requireDocument(
  documents: ReadonlyMap<string, StaticResource>,
  file: string,
): StaticResource {
  const document = documents.get(file);
  if (document === undefined) {
    throw new SiteManifestError(`document ${file} was not loaded`);
  }
  return document;
}

/** As `apps/server/src/http/web-ui.ts` negotiates: listed with a nonzero quality. */
function requestAcceptsEncoding(request: Request, encoding: string): boolean {
  const acceptEncoding = request.headers.get(ACCEPT_ENCODING_HEADER);
  if (acceptEncoding === null) {
    return false;
  }
  return acceptEncoding
    .split(',')
    .map(parseAcceptedEncoding)
    .some((accepted) => accepted.encoding === encoding && accepted.quality > 0);
}

function parseAcceptedEncoding(value: string): { encoding: string; quality: number } {
  const [encoding = '', ...parameters] = value.trim().toLowerCase().split(';');
  const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
  if (qualityParameter === undefined) {
    return { encoding, quality: 1 };
  }
  const quality = Number.parseFloat(qualityParameter.trim().slice(2));
  return { encoding, quality: Number.isNaN(quality) ? 0 : quality };
}

/** RFC 9110 §13.1.2: `*`, or any listed tag equal under weak comparison. */
function matchesIfNoneMatch(request: Request, etag: string): boolean {
  const value = request.headers.get(IF_NONE_MATCH_HEADER);
  if (value === null) {
    return false;
  }
  return value
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || (tag.startsWith('W/') ? tag.slice(2) : tag) === etag);
}
