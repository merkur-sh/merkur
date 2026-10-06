import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inlineStylesheet, quicksilverFonts } from '@merkur/quicksilver/vite';
import solid from '@solidjs/vite-plugin';
import UnoCSS from 'unocss/vite';
import { defineConfig, type Plugin } from 'vite';
import { encodeBuildMarker } from '../../packages/shared/src/build-identity';

const APP_BUILD_ID = process.env.MERKUR_BUILD_ID ?? randomUUID();

const BACKEND_HTTP_ORIGIN = process.env.MERKUR_BACKEND_ORIGIN;
const TERM_WASM_HASH = createHash('sha256')
  .update(readFileSync(resolve(__dirname, 'src/term-wasm/pkg/term_wasm_bg.wasm')))
  .digest('hex');

function listPublicFiles(dir: string, prefix = ''): Array<{ urlPath: string; absPath: string }> {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ urlPath: string; absPath: string }> = [];
  for (const entry of entries) {
    const urlPath = `${prefix}/${entry.name}`;
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listPublicFiles(absPath, urlPath));
    } else if (entry.isFile()) {
      files.push({ urlPath, absPath });
    }
  }
  return files;
}

function buildMarker(): Plugin {
  return {
    name: 'merkur-build-marker',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'merkur-build.json',
        source: encodeBuildMarker(APP_BUILD_ID),
      });
    },
  };
}

/**
 * Injects the real emitted-file list and a whole-build content hash into the
 * service worker (see the `__MERKUR_*__` tokens in `src/sw.ts`). The hash
 * covers every bundle output and every `public/` file, so ANY byte change —
 * including unhashed worker entries and wasm copied from `public/` — produces
 * a new `sw.js`, which is what triggers the browser's SW update + precache
 * swap. Fonts are excluded from the shell manifest and service-worker routing;
 * their versioned URLs use the browser HTTP cache, while a font swap still
 * rolls the build id.
 */
/**
 * `/privacy` and `/terms` in development, as the server routes them in
 * production (`apps/server/src/http/routes/web-routes.ts`): the files are
 * public assets under `/legal/`, and without this the dev server would answer
 * both paths with the app shell. `/legal/orb.js`, the pages' one script, is the
 * `legal-orb` entry's stable name in a build; in development it is served from
 * its source.
 */
function legalPageRoutes(): Plugin {
  const pages: Readonly<Record<string, string>> = {
    '/privacy': '/legal/privacy.html',
    '/terms': '/legal/terms.html',
    '/legal/orb.js': '/src/legal/orb.ts',
  };
  return {
    name: 'merkur-legal-page-routes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const page = request.url === undefined ? undefined : pages[request.url.split('?')[0] ?? ''];
        if (page !== undefined) request.url = page;
        next();
      });
    },
  };
}

function swPrecacheManifest(): Plugin {
  return {
    name: 'merkur-sw-precache-manifest',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const shell = new Set<string>(['/', '/index.html']);
      for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const content = output.type === 'chunk' ? output.code : output.source;
        hash.update(fileName);
        hash.update(typeof content === 'string' ? Buffer.from(content) : Buffer.from(content));
        if (fileName === 'sw.js' || fileName === 'index.html') continue;
        if (fileName.startsWith('fonts/') && !fileName.endsWith('.woff2')) continue;
        // The legal pages' script, like the pages, bypasses the worker.
        if (fileName.startsWith('legal/')) continue;
        shell.add(`/${fileName}`);
      }
      for (const { urlPath, absPath } of listPublicFiles(resolve(__dirname, 'public'))) {
        hash.update(urlPath);
        hash.update(readFileSync(absPath));
        // Public `/fonts` is the terminal's directory — multi-megabyte .ttf
        // faces the renderer fetches itself, plus their provenance files. The
        // UI .woff2 faces, the only fonts the shell cache carries, are emitted
        // into the bundle by `quicksilverFonts` and enter the shell above. See
        // `bypasses` in src/service-worker-routing.ts.
        if (urlPath.startsWith('/fonts/')) continue;
        // The legal pages bypass the worker and are not part of the shell.
        if (urlPath.startsWith('/legal/')) continue;
        shell.add(urlPath);
      }

      const buildId = hash.digest('hex').slice(0, 16);
      const sw = bundle['sw.js'];
      if (sw === undefined || sw.type !== 'chunk') {
        throw new Error('sw.js chunk missing from bundle; cannot inject precache manifest');
      }
      // The minifier may emit the tokens as ", ' or ` strings.
      sw.code = sw.code
        .replace(
          /["'`]__MERKUR_SHELL_MANIFEST__["'`]/,
          JSON.stringify(JSON.stringify([...shell].sort())),
        )
        .replace(/["'`]__MERKUR_BUILD_ID__["'`]/, JSON.stringify(buildId));
    },
  };
}

export default defineConfig(({ command }) => {
  if (command === 'serve' && BACKEND_HTTP_ORIGIN === undefined) {
    throw new Error('MERKUR_BACKEND_ORIGIN must be supplied by bun run dev or bun run dev:web');
  }
  return {
    // Entrypoints supply the public build inputs explicitly; plugins never inherit server dotenv.
    envDir: false,
    // The release version, folded into the bundle (and every worker bundle) so
    // `merkurVersion()` answers in the browser the way it already does in the
    // server and daemon. `Dockerfile` sets `MERKUR_VERSION` to the required
    // deployment commit in `build:web`'s environment; a source run reports 'dev'.
    //
    // A `define` rather than a `VITE_` variable because this is not operator
    // configuration — it is stamped by whoever built the artifact, and the worker
    // bundles need it too.
    define: {
      'process.env.MERKUR_VERSION': JSON.stringify(process.env.MERKUR_VERSION ?? 'dev'),
      'process.env.MERKUR_BUILD_ID': JSON.stringify(APP_BUILD_ID),
      'process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY': JSON.stringify(
        process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '',
      ),
      'process.env.MERKUR_TERM_WASM_HASH': JSON.stringify(TERM_WASM_HASH),
    },
    // `inlineStylesheet` folds the stylesheet into the shell, which is what lets
    // the boot splash in `index.html` paint from the document's own bytes. It
    // runs before `swPrecacheManifest`: both are post-enforced, so they run in
    // array order, and the manifest must hash the shell that actually ships and
    // must not list a stylesheet that no longer exists. `quicksilverFonts` is a
    // normal plugin, so the UI faces it emits are in the bundle both of them see.
    plugins: [
      UnoCSS(),
      solid(),
      quicksilverFonts(),
      buildMarker(),
      inlineStylesheet(),
      swPrecacheManifest(),
      legalPageRoutes(),
    ],
    resolve: {
      alias: {
        '@merkur/config/retry-schedules': resolve(
          __dirname,
          '../../packages/config/src/retry-schedules.ts',
        ),
        '@merkur/logger': resolve(__dirname, '../../packages/logger/src/index.ts'),
        '@merkur/protocol/channel': resolve(__dirname, '../../packages/protocol/src/channel.ts'),
        '@merkur/protocol': resolve(__dirname, '../../packages/protocol/src/index.ts'),
        '@merkur/shared/api-schema': resolve(__dirname, '../../packages/shared/src/api-schema.ts'),
        '@merkur/shared/build-identity': resolve(
          __dirname,
          '../../packages/shared/src/build-identity.ts',
        ),
        '@merkur/shared/e2e-wasm-runtime': resolve(
          __dirname,
          '../../packages/shared/src/e2e-wasm-runtime.ts',
        ),
        '@merkur/shared/recovery-outcome': resolve(
          __dirname,
          '../../packages/shared/src/recovery-outcome.ts',
        ),
        '@merkur/shared/opaque-password-policy': resolve(
          __dirname,
          '../../packages/shared/src/opaque-password-policy.ts',
        ),
        '@merkur/shared/schema-check': resolve(
          __dirname,
          '../../packages/shared/src/schema-check.ts',
        ),
        '@merkur/shared/transport': resolve(__dirname, '../../packages/shared/src/transport.ts'),
        '@merkur/shared/user-authorization': resolve(
          __dirname,
          '../../packages/shared/src/user-authorization.ts',
        ),
        '@merkur/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
    },
    server: {
      allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev'],
      // Cross-origin isolation so the terminal worker's SharedArrayBuffer ring is
      // available in dev, matching the production server's security headers.
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      fs: {
        allow: [resolve(__dirname, '../..')],
      },
      proxy: {
        '/api': {
          target: BACKEND_HTTP_ORIGIN,
          changeOrigin: true,
          // `/api/daemon/control` is a WebSocket, and in development this proxy
          // is the only route to it: a linked daemon dials PUBLIC_ORIGIN, which
          // is this dev server, because the server checks that origin against the
          // one the browser signed into its delegation certificate. Without this
          // the HTTP half of a daemon works and its control link never connects.
          ws: true,
        },
        '/install': {
          target: BACKEND_HTTP_ORIGIN,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          sw: resolve(__dirname, 'src/sw.ts'),
          'legal-orb': resolve(__dirname, './src/legal/orb.ts'),
        },
        output: {
          // `main` is referenced by Vite-generated HTML and carries a content
          // hash. Worker constructors use static new URL(..., import.meta.url)
          // dependencies, so Vite also content-hashes them and pins the matching
          // ABI in this exact main bundle. Only the browser-registered service
          // worker must retain its stable `/sw.js` entry URL, and the legal pages,
          // which Vite does not process, name their script `/legal/orb.js`.
          entryFileNames: (chunk) =>
            chunk.name === 'main'
              ? '[name].[hash].js'
              : chunk.name === 'legal-orb'
                ? 'legal/orb.js'
                : '[name].js',
          chunkFileNames: 'chunks/[name].[hash].js',
          assetFileNames: (asset) => {
            if (asset.name?.endsWith('.css')) {
              return 'styles.[hash].css';
            }
            // The main thread and the transport worker both instantiate
            // `e2e_wasm_bg.wasm`; the worker build names it
            // `assets/[name]-[hash]`, so one URL serves both realms from one
            // precache entry instead of two copies.
            if (asset.name?.endsWith('.wasm')) {
              return 'assets/[name]-[hash][extname]';
            }
            return '[name].[hash][extname]';
          },
        },
      },
    },
  };
});
