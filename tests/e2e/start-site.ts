/**
 * `playwright.site.config.mjs`'s web server: merkur.sh as production runs
 * it. The compiled static server (`apps/site/server/dist/site-server`) serves
 * the built `apps/site/dist` and proxies `/analytics/*` to a fake Rybbit
 * upstream on its own port. `bun run test:e2e:site` builds both first.
 *
 * `TRUSTED_PROXY_HOPS=1`, production's value: a request with no
 * `X-Forwarded-For` is addressed by its socket peer, and one that carries a
 * chain is addressed by its rightmost entry.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { startFakeRybbit } from './fake-rybbit';

const ROOT = path.resolve(import.meta.dir, '../..');
const SERVER = path.join(ROOT, 'apps/site/server/dist/site-server');
const DIST = path.join(ROOT, 'apps/site/dist');

function port(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

const sitePort = port('PW_SITE_PORT');
const rybbitPort = port('PW_SITE_RYBBIT_PORT');
for (const required of [SERVER, path.join(DIST, 'site-manifest.json')]) {
  if (!existsSync(required)) {
    throw new Error(`${path.relative(ROOT, required)} is missing: run bun run test:e2e:site`);
  }
}

const upstream = startFakeRybbit(rybbitPort);
const server = Bun.spawn([SERVER, DIST], {
  cwd: ROOT,
  env: {
    PORT: String(sitePort),
    RYBBIT_HOST: `http://127.0.0.1:${rybbitPort}`,
    TRUSTED_PROXY_HOPS: '1',
  },
  stdout: 'inherit',
  stderr: 'inherit',
});

const stop = (): void => {
  server.kill('SIGTERM');
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

process.exitCode = await server.exited;
void upstream.stop(true);
