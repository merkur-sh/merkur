/**
 * serve.ts — local page server for the real-device acceptance harness.
 *
 * Dependency-free (Bun only). Serves index.html and transpiles the harness
 * .ts files to JS on the fly with Bun's built-in transpiler, so the browser
 * gets native ESM modules without a bundler.
 *
 * The harness PAGE must be a secure context for `new WebTransport(...)` to
 * exist. On the Mac, http://localhost is already a secure context. For the
 * iPhone on the LAN, serve over HTTPS:
 *
 *   1) generate a local cert (e.g. with `mkcert <mac-lan-ip>` or openssl), then
 *   2) WT_PAGE_TLS_CERT=cert.pem WT_PAGE_TLS_KEY=key.pem bun serve.ts
 *
 * Without those env vars it serves plain HTTP (fine for Mac localhost).
 *
 * Run:  bun run spike:ios:web
 * Port: WT_PAGE_PORT (default 8088).
 */

import { join } from 'node:path';
import { file } from 'bun';

const ROOT = import.meta.dir;
const PORT = Number(process.env.WT_PAGE_PORT) || 8088;

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' });

async function serveTs(path: string): Promise<Response> {
  const src = await file(join(ROOT, path)).text();
  const js = await transpiler.transform(src);
  return new Response(js, {
    headers: { 'content-type': 'text/javascript; charset=utf-8' },
  });
}

const certPath = process.env.WT_PAGE_TLS_CERT;
const keyPath = process.env.WT_PAGE_TLS_KEY;
if ((certPath === undefined) !== (keyPath === undefined)) {
  throw new Error('WT_PAGE_TLS_CERT and WT_PAGE_TLS_KEY must be set together');
}
const tls =
  certPath !== undefined && keyPath !== undefined
    ? { cert: file(certPath), key: file(keyPath) }
    : undefined;

const server = Bun.serve({
  port: PORT,
  tls,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path === '/' || path === '') path = '/index.html';

    if (path.endsWith('.ts')) {
      try {
        return await serveTs(path.slice(1));
      } catch (e) {
        return new Response(`transpile error: ${String(e)}`, { status: 500 });
      }
    }

    if (path.endsWith('.html')) {
      const html = await file(join(ROOT, path.slice(1))).text();
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('not found', { status: 404 });
  },
});

const scheme = tls ? 'https' : 'http';
process.stdout.write(
  `[wt-spike] serving ${scheme}://localhost:${server.port}/ (and on your LAN IP for the phone)\n`,
);
if (!tls) {
  process.stdout.write(
    '[wt-spike] plain HTTP: fine for Mac localhost. For the iPhone set WT_PAGE_TLS_CERT/KEY to serve HTTPS.\n',
  );
}
