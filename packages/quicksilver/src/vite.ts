/**
 * Vite plugins every Quicksilver surface builds with.
 *
 * This module is loaded by the runtime itself, not by a bundler: Vite
 * externalises a config file's bare imports, so Node (or Bun) imports this
 * file directly. It therefore imports only builtins and types, never a
 * relative module, whose extensionless specifier Node would not resolve.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, Rollup } from 'vite';

const FONTS_DIRECTORY = fileURLToPath(new URL('../fonts', import.meta.url));

/**
 * What `fonts/` may hold, and the type each is served as. The directory is the
 * manifest — every file in it ships — so a file of any other kind stops the
 * build instead of shipping unannounced.
 */
const FONT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The UI faces and their licences at `/fonts/<file>`: served from this
 * package in development and emitted into the bundle at build time.
 *
 * Emitted rather than copied from a public directory, so a plugin that reads
 * the bundle sees them. Not `enforce: 'post'`: its `generateBundle` has to run
 * before the post plugins that hash or list the bundle, such as a service
 * worker's precache manifest.
 *
 * Each URL is declared external: the `@font-face` blocks name them, and they
 * resolve at runtime against what this plugin serves or emits, never through
 * the module graph. Without the declaration Vite reports every one as a URL
 * that "didn't resolve at build time".
 */
export function quicksilverFonts(): Plugin {
  const files = readdirSync(FONTS_DIRECTORY).sort();
  for (const file of files) {
    if (FONT_CONTENT_TYPES[extname(file)] === undefined) {
      throw new Error(`quicksilver-fonts: ${file} is not a font or licence file`);
    }
  }
  return {
    name: 'quicksilver-fonts',
    config() {
      return { build: { rolldownOptions: { external: files.map((file) => `/fonts/${file}`) } } };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? '';
        const file = pathname.startsWith('/fonts/') ? pathname.slice('/fonts/'.length) : '';
        const contentType = files.includes(file) ? FONT_CONTENT_TYPES[extname(file)] : undefined;
        if (contentType === undefined) {
          next();
          return;
        }
        response.setHeader('Content-Type', contentType);
        response.end(readFileSync(join(FONTS_DIRECTORY, file)));
      });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({
          type: 'asset',
          fileName: `fonts/${file}`,
          originalFileName: join(FONTS_DIRECTORY, file),
          source: readFileSync(join(FONTS_DIRECTORY, file)),
        });
      }
    },
  };
}

/**
 * Folds every emitted stylesheet into each page that links it and drops the
 * `<link>`.
 *
 * A render-blocking stylesheet is a round trip before the first paint, and
 * Firefox has no paint holding: it paints white for the whole of that trip
 * rather than keeping the previous frame the way Chromium and WebKit do.
 * Measured at 340 ms of full-screen white on a production cold load, tracking
 * time-to-stylesheet exactly (`PERF.md`, 2026-09-08). Declaring a background
 * does not help, because until that stylesheet lands there is no paint at all
 * to apply it to.
 *
 * Inlining removes the request outright, so a page paints from its own bytes.
 * Each stylesheet is dropped from the bundle afterwards, so a later plugin
 * that lists the bundle (a service-worker precache manifest) does not carry a
 * file nothing requests; a stylesheet no page links stops the build. A server
 * that pins `style-src` by hash derives the hashes from the built pages, so
 * the two cannot drift.
 */
export function inlineStylesheet(): Plugin {
  return {
    name: 'quicksilver-inline-stylesheet',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.values(bundle).filter(
        (output): output is Rollup.OutputAsset => output.type === 'asset',
      );
      const sheets = assets.filter((asset) => asset.fileName.endsWith('.css'));
      const pages = assets.filter((asset) => asset.fileName.endsWith('.html'));
      if (sheets.length === 0 || pages.length === 0) {
        throw new Error('inline-stylesheet: expected emitted stylesheets and pages');
      }
      const inlined = new Set<string>();
      for (const page of pages) {
        let source = assetText(page);
        for (const sheet of sheets) {
          const link = new RegExp(
            `<link[^>]+href="/?${sheet.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`,
          );
          if (!link.test(source)) continue;
          const style = `<style>${assetText(sheet)}</style>`;
          source = source.replace(link, () => style);
          inlined.add(sheet.fileName);
        }
        page.source = source;
      }
      for (const sheet of sheets) {
        if (!inlined.has(sheet.fileName)) {
          throw new Error(`inline-stylesheet: no page links ${sheet.fileName}`);
        }
        delete bundle[sheet.fileName];
      }
    },
  };
}

function assetText(asset: Rollup.OutputAsset): string {
  return typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString();
}
