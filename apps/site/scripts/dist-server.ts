/**
 * The built site on a local port, for the scripts that draw from it
 * (`render-og.ts`, `render-stills.ts`): exact files under `dist`, `/` as the
 * home page, and none of the static server's headers, so a script may add a
 * style of its own.
 */
import { existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function serveDist(): { readonly origin: string; stop(): Promise<void> } {
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error('apps/site/dist has no index.html; build the site first');
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const file = normalize(join(dist, pathname === '/' ? 'index.html' : pathname));
      if (!file.startsWith(`${dist}${sep}`) || !existsSync(file)) {
        return new Response(null, { status: 404 });
      }
      return new Response(Bun.file(file));
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop() };
}
