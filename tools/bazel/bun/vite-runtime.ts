import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** Resolve only the declared original-source Vite package used by this action. */
export function sourceBuiltViteModule(packageRoot: string): string {
  if (!path.isAbsolute(packageRoot) || !statSync(packageRoot).isDirectory())
    throw new Error('Vite requires its exact materialized source-built package directory');
  const root = realpathSync(packageRoot);
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('name' in manifest) ||
    manifest.name !== 'vite' ||
    !('version' in manifest) ||
    manifest.version !== '8.2.2'
  )
    throw new Error('Vite execution requires its original source-built8.2.2 package');
  const module = realpathSync(Bun.resolveSync('vite', root));
  const relative = path.relative(root, module);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Vite resolved outside its actual declared source-built package');
  return module;
}
