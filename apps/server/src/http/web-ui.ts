import { existsSync } from 'node:fs';
import path from 'node:path';

import { errorLogContext, type Logger } from '../logger';
import { transportWorkerContentSecurityPolicy } from '../middleware/security-headers';

const API_PATH_PREFIX = '/api/';
const API_PATH_ROOT = '/api';
const ACCEPT_ENCODING_HEADER = 'accept-encoding';
const CACHE_CONTROL_HEADER = 'cache-control';
const CONTENT_ENCODING_HEADER = 'content-encoding';
const CONTENT_TYPE_HEADER = 'content-type';
const VARY_HEADER = 'vary';
const ACCEPT_ENCODING_VARY = 'Accept-Encoding';
const BROTLI_ENCODING = 'br';
const BROTLI_EXTENSION = '.br';
const OCTET_STREAM_CONTENT_TYPE = 'application/octet-stream';
const SLASH = '/';

// Vite emits content-hashed names for main/chunks/css/emitted assets
// (e.g. main.D4x1qGZk.js) — same URL always means same bytes.
const HASHED_ASSET_PATTERN = /\.[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// The HTML shell and the service worker gate deploy rollout; always revalidate.
const NO_CACHE_CONTROL = 'no-cache';
// Unhashed-but-mutable files (worker entries, manifest, icons): the service
// worker is their real cache; bound browser-cache staleness for non-SW loads.
const SHORT_CACHE_CONTROL = 'public, max-age=300';
const SERVICE_WORKER_PATH = '/sw.js';
const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy';
const NODE_ENV_PRODUCTION = 'production';
// Vite emits the transport worker as a content-hashed asset entry. It is the
// only realm that dials WebTransport, so it is the only response that carries
// the broader connect-src; the terminal worker does no networking and must keep
// the document policy.
const TRANSPORT_WORKER_ASSET_PATTERN = /^\/assets\/transport-worker-[A-Za-z0-9_-]+\.js$/;
const TRANSPORT_WORKER_CSP = transportWorkerContentSecurityPolicy(
  process.env.NODE_ENV === NODE_ENV_PRODUCTION,
);

export function isTransportWorkerAssetPath(requestPath: string): boolean {
  return TRANSPORT_WORKER_ASSET_PATTERN.test(requestPath);
}

function cacheControlForPath(requestPath: string): string {
  if (
    requestPath.startsWith('/fonts/') ||
    requestPath.startsWith('/chunks/') ||
    HASHED_ASSET_PATTERN.test(requestPath)
  ) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  if (
    requestPath === SLASH ||
    requestPath.endsWith('.html') ||
    requestPath === SERVICE_WORKER_PATH
  ) {
    return NO_CACHE_CONTROL;
  }
  return SHORT_CACHE_CONTROL;
}

export function isReservedBackendPath(requestPath: string): boolean {
  return requestPath.startsWith(API_PATH_PREFIX) || requestPath === API_PATH_ROOT;
}

export function resolveStaticAssetPath(
  requestPath: string,
  webDistDirectory: string,
): string | null {
  const trimmedPath = requestPath.startsWith(SLASH) ? requestPath.slice(1) : requestPath;
  if (trimmedPath.length === 0 || path.extname(trimmedPath).length === 0) {
    return null;
  }

  const resolvedAssetPath = path.resolve(webDistDirectory, trimmedPath);
  const webDistDirectoryPrefix = `${webDistDirectory}${path.sep}`;
  if (
    resolvedAssetPath !== webDistDirectory &&
    !resolvedAssetPath.startsWith(webDistDirectoryPrefix)
  ) {
    return null;
  }

  if (!existsSync(resolvedAssetPath)) {
    return null;
  }

  return resolvedAssetPath;
}

export function serveStaticAsset(request: Request, sourceFile: string): Response {
  return serveWebFile(request, sourceFile);
}

export function serveWebIndex(webIndexFile: string, logger: Logger, request: Request): Response {
  try {
    return serveWebFile(request, webIndexFile, 'text/html; charset=utf-8', NO_CACHE_CONTROL);
  } catch (error) {
    logger.error('web_index_unavailable', {
      path: webIndexFile,
      ...errorLogContext(error),
    });
    return new Response('Web UI unavailable', {
      status: 503,
      headers: {
        [CONTENT_TYPE_HEADER]: 'text/plain; charset=utf-8',
      },
    });
  }
}

function serveWebFile(
  request: Request,
  sourceFile: string,
  contentTypeOverride?: string,
  cacheControlOverride?: string,
): Response {
  const source = Bun.file(sourceFile);
  const brotliFile = getBrotliFile(sourceFile);
  const serveBrotli = requestAcceptsEncoding(request, BROTLI_ENCODING) && existsSync(brotliFile);
  const requestPath = new URL(request.url).pathname;
  const headers: Record<string, string> = {
    [CONTENT_TYPE_HEADER]: contentTypeOverride ?? (source.type || OCTET_STREAM_CONTENT_TYPE),
    [VARY_HEADER]: ACCEPT_ENCODING_VARY,
    [CACHE_CONTROL_HEADER]: cacheControlOverride ?? cacheControlForPath(requestPath),
  };

  // Set here rather than in the global middleware because a header already on
  // the returned Response wins: Elysia's mergeHeaders only fills in absent keys.
  if (isTransportWorkerAssetPath(requestPath)) {
    headers[CONTENT_SECURITY_POLICY_HEADER] = TRANSPORT_WORKER_CSP;
  }

  if (serveBrotli) {
    headers[CONTENT_ENCODING_HEADER] = BROTLI_ENCODING;
  }

  return new Response(serveBrotli ? Bun.file(brotliFile) : source, { headers });
}

function getBrotliFile(sourceFile: string): string {
  return `${sourceFile}${BROTLI_EXTENSION}`;
}

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
