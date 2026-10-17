/**
 * Builds the website's deployment, the bytes the site image serves: `site-server` and the
 * precompressed `dist/`. `//tools/bazel/release:site` runs it inside a checkout of the
 * repository, on Linux x64, the server's platform.
 *
 *   bun run scripts/build-site-deployment.ts <absolute output directory>
 *
 * The pages and the server are built against `MERKUR_SITE_ORIGIN`, `MERKUR_SITE_API_ORIGIN`
 * and `MERKUR_SITE_RYBBIT_SITE_ID`; none has a default, so a build that does not name them fails
 * here, not in a visitor's browser.
 */

import { cpSync } from 'node:fs';
import path from 'node:path';
import { outputArgument } from './output-argument';

const ROOT = path.resolve(import.meta.dir, '..');

if (import.meta.main) {
  const output = outputArgument(
    'bun run scripts/build-site-deployment.ts <absolute output directory>',
  );
  for (const name of ['MERKUR_SITE_ORIGIN', 'MERKUR_SITE_API_ORIGIN', 'MERKUR_SITE_RYBBIT_SITE_ID'])
    if ((process.env[name] ?? '') === '') throw new Error(`${name} is required`);
  const build = Bun.spawn([process.execPath, '--bun', 'run', 'build:site'], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await build.exited;
  if (code !== 0) throw new Error(`build:site exited ${code}`);
  cpSync(path.join(ROOT, 'apps/site/server/dist/site-server'), path.join(output, 'site-server'));
  cpSync(path.join(ROOT, 'apps/site/dist'), path.join(output, 'dist'), { recursive: true });
}
