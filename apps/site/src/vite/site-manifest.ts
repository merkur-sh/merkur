/**
 * `site-manifest.json`: everything the site's static server may serve, and
 * the facts it needs to serve each file, written beside the build.
 *
 * The server matches exact paths against this list and never resolves a URL
 * against the filesystem, so a file is reachable only if it is here. The shape
 * and every rule on it are the server's (`server/manifest.ts`); the plugin
 * parses what it wrote with the server's own parser, so a manifest the server
 * would refuse to start on stops the build instead.
 *
 * - `routes`: page path → HTML file; `notFound`: the page for anything else.
 * - `files`: every other emitted file, by URL path, with its content type,
 *   whether its name carries a content hash (`immutable`), and whether a
 *   brotli sibling `<file>.br` exists.
 * - `styleHashes`: the CSP `style-src` hash of every inline `<style>` in every
 *   page, since the stylesheet is inlined.
 *
 * The plugin writes `brotli: false` throughout, because nothing is compressed
 * yet; `scripts/compress-site.ts` then writes the siblings and marks them. Build
 * order: `bun run build:site`.
 *
 * A page that carries an inline script or a `style` attribute stops the build:
 * the CSP allows neither, so the page would render broken rather than fail.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import {
  parseSiteManifest,
  SITE_MANIFEST_FILE,
  type SiteManifest,
  type SiteManifestFile,
} from '../../server/manifest';
import { afterBuild } from './after-build';
import { LLMS_FILE, llmsText } from './llms-txt';
import type { SiteEnvironment } from './site-environment';

export const ROUTES: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/security': 'security.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/contact': 'contact.html',
};
export const NOT_FOUND = '404.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mrec': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

/** Vite's default asset name, `assets/<name>-<hash>.<ext>`: the hash is 8 url-safe characters. */
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

function listFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(relative(directory, path).split(sep).join('/'));
      else throw new Error(`site-manifest: ${path} is neither a file nor a directory`);
    }
  };
  walk(directory);
  return found.sort();
}

/** The CSP hashes of a page's inline stylesheets; throws on anything the CSP would block. */
export function pageStyleHashes(html: string, page: string): string[] {
  for (const script of html.matchAll(/<script\b([^>]*)>/g)) {
    const attributes = script[1] ?? '';
    // Structured data is a data block: nothing runs it, so the CSP has nothing to refuse.
    if (/\stype="application\/ld\+json"/.test(attributes)) continue;
    if (!/\ssrc=/.test(attributes)) throw new Error(`site-manifest: ${page} has an inline script`);
  }
  if (/<[a-z][^>]*\sstyle=/i.test(html))
    throw new Error(`site-manifest: ${page} has a style attribute`);
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    (match) =>
      `sha256-${createHash('sha256')
        .update(match[1] ?? '')
        .digest('base64')}`,
  );
}

export function buildSiteManifest(
  dist: string,
  routes: Readonly<Record<string, string>>,
): SiteManifest {
  const pages = [...Object.values(routes), NOT_FOUND];
  const styleHashes = new Set<string>();
  for (const page of pages) {
    const path = join(dist, page);
    if (!existsSync(path)) throw new Error(`site-manifest: the build has no ${page}`);
    for (const hash of pageStyleHashes(readFileSync(path, 'utf8'), page)) styleHashes.add(hash);
  }
  if (styleHashes.size === 0)
    throw new Error('site-manifest: no page carries an inline stylesheet');
  const files: SiteManifestFile[] = [];
  for (const file of listFiles(dist)) {
    if (pages.includes(file) || file === SITE_MANIFEST_FILE || file.endsWith('.br')) continue;
    const contentType = CONTENT_TYPES[extname(file)];
    if (contentType === undefined) throw new Error(`site-manifest: no content type for ${file}`);
    if (extname(file) === '.html')
      throw new Error(`site-manifest: ${file} is a page with no route`);
    const immutable = file.startsWith('assets/');
    if (immutable && !HASHED_ASSET.test(file)) {
      throw new Error(`site-manifest: ${file} is under assets/ without a content hash`);
    }
    files.push({ path: `/${file}`, file, contentType, immutable, brotli: false });
  }
  // The server's own parser: its path, key and hash rules hold at build time.
  return parseSiteManifest({
    routes,
    notFound: NOT_FOUND,
    files,
    styleHashes: [...styleHashes].sort(),
  });
}

/** `sitemap.xml`: every page at its address on the site's own origin. */
export function sitemap(siteOrigin: string, routes: Readonly<Record<string, string>>): string {
  const urls = Object.keys(routes)
    .map((path) => `  <url><loc>${siteOrigin}${path}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** `robots.txt`: everything may be crawled, and the sitemap says what there is. */
export function robots(siteOrigin: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`;
}

/**
 * Writes the sitemap and `robots.txt` for the site's origin and `llms.txt`
 * from the built pages, then the manifest that lists them, once the bundle
 * and the public files are on disk.
 */
export function siteManifest(
  environment: SiteEnvironment,
  routes: Readonly<Record<string, string>>,
  /** Files the build writes beside its pages, by their path from the build's root: the blog's feed. */
  written: Readonly<Record<string, string>>,
): Plugin {
  const { siteOrigin } = environment;
  return afterBuild('merkur-site-manifest', (outDir) => {
    writeFileSync(join(outDir, 'sitemap.xml'), sitemap(siteOrigin, routes));
    writeFileSync(join(outDir, 'robots.txt'), robots(siteOrigin));
    writeFileSync(
      join(outDir, LLMS_FILE),
      llmsText(
        environment,
        Object.fromEntries(
          Object.entries(routes).map(([route, page]) => [
            route,
            readFileSync(join(outDir, page), 'utf8'),
          ]),
        ),
      ),
    );
    for (const [file, content] of Object.entries(written)) {
      mkdirSync(dirname(join(outDir, file)), { recursive: true });
      writeFileSync(join(outDir, file), content);
    }
    const manifest = buildSiteManifest(outDir, routes);
    writeFileSync(join(outDir, SITE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  });
}
