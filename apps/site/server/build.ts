import path from 'node:path';

import { createLogger } from '@merkur/logger';

import { readSiteApiOrigin } from '../src/vite/site-environment';
import { parseOrigin } from './config';

/**
 * Compiles the static server into one executable, `apps/site/server/dist/site-server`.
 *
 * Two values are fixed at build time. `NODE_ENV` is `production`, as for the
 * application server. `MERKUR_SITE_API_ORIGIN` is the origin the page was built
 * to post to, which the CSP's `connect-src` and `form-action` must name; it is
 * read by the page build's own `readSiteApiOrigin`, default included, so the
 * two cannot disagree.
 *
 * Inside Docker, `TARGETARCH` (declared as a build argument) selects the Linux
 * executable for the image, because the builder runs on the build platform.
 * Outside Docker there is no target platform, and the executable is for the
 * host that will run it.
 */
const ENTRYPOINT = path.join(import.meta.dir, 'index.ts');
const OUTFILE = path.join(import.meta.dir, 'dist', 'site-server');
const LINUX_TARGETS: Readonly<Record<string, Bun.Build.CompileTarget>> = {
  amd64: 'bun-linux-x64',
  arm64: 'bun-linux-arm64',
};

export interface SiteServerBuild {
  readonly outfile: string;
  readonly apiOrigin: string | undefined;
  /** Docker's `TARGETARCH`, when building an image. */
  readonly targetArch: string | undefined;
}

export function compileTarget(targetArch: string | undefined): Bun.Build.CompileTarget | undefined {
  if (targetArch === undefined) {
    return undefined;
  }
  const target = LINUX_TARGETS[targetArch];
  if (target === undefined) {
    throw new Error(`unsupported TARGETARCH: ${targetArch}`);
  }
  return target;
}

export async function compileSiteServer(build: SiteServerBuild): Promise<void> {
  const apiOrigin = parseOrigin(build.apiOrigin, 'MERKUR_SITE_API_ORIGIN');
  const target = compileTarget(build.targetArch);
  const result = await Bun.build({
    entrypoints: [ENTRYPOINT],
    compile: {
      ...(target === undefined ? {} : { target }),
      outfile: build.outfile,
      // The environment is exactly what the service sets; no file in the
      // working directory can add to it or reconfigure the runtime.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.MERKUR_SITE_API_ORIGIN': JSON.stringify(apiOrigin),
    },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'site server compilation failed');
  }
}

if (import.meta.main) {
  await compileSiteServer({
    outfile: OUTFILE,
    apiOrigin: readSiteApiOrigin(process.env),
    targetArch: process.env.TARGETARCH,
  });
  createLogger('site-server-build').info('site_server_compiled', { outfile: OUTFILE });
}
