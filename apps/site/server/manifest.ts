import path from 'node:path';

/**
 * `dist/site-manifest.json`: the one description of what the site serves.
 *
 * The page build writes it; `scripts/compress-site.ts` writes the Brotli
 * siblings and marks them; the static server reads it once at startup and
 * never looks at the filesystem again for a request. Every field is validated
 * here so a malformed build fails the start, not a visitor's request.
 */
export const SITE_MANIFEST_FILE = 'site-manifest.json';

export interface SiteManifestFile {
  /** Exact URL path, already in the normalized form `URL.pathname` produces. */
  readonly path: string;
  /** Path relative to `dist`. */
  readonly file: string;
  readonly contentType: string;
  /** Content-addressed or otherwise never-changing bytes: cached for a year. */
  readonly immutable: boolean;
  /** `<file>.br` exists beside the file. */
  readonly brotli: boolean;
}

export interface SiteManifest {
  /** URL path → HTML document relative to `dist`. */
  readonly routes: Readonly<Record<string, string>>;
  /** HTML document relative to `dist`, served with status 404 for every unknown path. */
  readonly notFound: string;
  readonly files: readonly SiteManifestFile[];
  /** CSP source expressions for every inline `<style>` of every document. */
  readonly styleHashes: readonly string[];
}

export class SiteManifestError extends Error {
  override readonly name = 'SiteManifestError';
}

const MANIFEST_KEYS = ['files', 'notFound', 'routes', 'styleHashes'];
const FILE_KEYS = ['brotli', 'contentType', 'file', 'immutable', 'path'];
const STYLE_HASH_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; ?[a-z0-9_-]+=[a-z0-9_-]+)*$/i;
/** Paths the server answers itself; no manifest entry may shadow them. */
const RESERVED_PATHS: ReadonlySet<string> = new Set(['/healthz', '/install']);
const RESERVED_PREFIX = '/analytics/';

export async function readSiteManifest(distDirectory: string): Promise<SiteManifest> {
  const manifestPath = path.join(distDirectory, SITE_MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = await Bun.file(manifestPath).json();
  } catch (error) {
    throw new SiteManifestError(`${manifestPath} is not readable JSON`, { cause: error });
  }
  return parseSiteManifest(parsed);
}

export async function writeSiteManifest(
  distDirectory: string,
  manifest: SiteManifest,
): Promise<void> {
  await Bun.write(
    path.join(distDirectory, SITE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/** Every HTML document the manifest names, each once: the routes and the 404 page. */
export function siteDocuments(manifest: SiteManifest): readonly string[] {
  return [...new Set([...Object.values(manifest.routes), manifest.notFound])];
}

export function parseSiteManifest(value: unknown): SiteManifest {
  const record = exactRecord(value, MANIFEST_KEYS, 'manifest');
  const routes = parseRoutes(record.routes);
  const notFound = relativeFile(record.notFound, 'notFound');
  const files = parseFiles(record.files, routes);
  const styleHashes = parseStyleHashes(record.styleHashes);
  return { routes, notFound, files, styleHashes };
}

function parseRoutes(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) {
    throw new SiteManifestError('routes must be an object');
  }
  const routes: Record<string, string> = {};
  for (const [urlPath, file] of Object.entries(value)) {
    routes[servedPath(urlPath, `routes[${JSON.stringify(urlPath)}]`)] = relativeFile(
      file,
      `routes[${JSON.stringify(urlPath)}]`,
    );
  }
  if (Object.keys(routes).length === 0) {
    throw new SiteManifestError('routes must name at least one document');
  }
  return routes;
}

function parseFiles(
  value: unknown,
  routes: Readonly<Record<string, string>>,
): readonly SiteManifestFile[] {
  if (!Array.isArray(value)) {
    throw new SiteManifestError('files must be an array');
  }
  const seen = new Set(Object.keys(routes));
  return value.map((entry: unknown, index) => {
    const field = `files[${index}]`;
    const record = exactRecord(entry, FILE_KEYS, field);
    const urlPath = servedPath(record.path, `${field}.path`);
    if (seen.has(urlPath)) {
      throw new SiteManifestError(`${field}.path ${urlPath} is served twice`);
    }
    seen.add(urlPath);
    const contentType = record.contentType;
    if (typeof contentType !== 'string' || !CONTENT_TYPE_PATTERN.test(contentType)) {
      throw new SiteManifestError(`${field}.contentType must be a media type`);
    }
    if (typeof record.immutable !== 'boolean' || typeof record.brotli !== 'boolean') {
      throw new SiteManifestError(`${field}.immutable and ${field}.brotli must be booleans`);
    }
    return {
      path: urlPath,
      file: relativeFile(record.file, `${field}.file`),
      contentType,
      immutable: record.immutable,
      brotli: record.brotli,
    };
  });
}

function parseStyleHashes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new SiteManifestError('styleHashes must be an array');
  }
  return value.map((hash: unknown, index) => {
    if (typeof hash !== 'string' || !STYLE_HASH_PATTERN.test(hash)) {
      throw new SiteManifestError(`styleHashes[${index}] must be a sha256-<base64> source`);
    }
    return hash;
  });
}

/**
 * A URL path the server can match exactly: absolute, and already equal to its
 * own normalized `URL.pathname`, so no dot segment, percent-encoded dot or
 * unencoded character can make two spellings of one entry.
 */
function servedPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw new SiteManifestError(`${field} must be an absolute URL path`);
  }
  if (new URL(value, 'http://site.invalid').pathname !== value) {
    throw new SiteManifestError(`${field} ${value} is not a normalized URL path`);
  }
  if (RESERVED_PATHS.has(value) || value.startsWith(RESERVED_PREFIX)) {
    throw new SiteManifestError(`${field} ${value} is reserved for the server`);
  }
  return value;
}

/** A path inside `dist`: relative, forward slashes, no empty, `.` or `..` segment. */
function relativeFile(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new SiteManifestError(`${field} must be a relative path inside dist`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new SiteManifestError(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new SiteManifestError(`${field} must have exactly the keys ${keys.join(', ')}`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
