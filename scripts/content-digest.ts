import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Content addressing shared by the artifact reuse in `e2e-web-artifacts.ts` and the anti-slop
 * cache in `check-slop.ts`.
 *
 * Both answer the same question — "have these exact inputs already produced a result I can
 * trust?" — so both hash file bytes rather than timestamps: a parallel session touching the
 * worktree, a `git checkout` restoring an identical file, and a rebuild that changes nothing
 * all leave the digest where it was.
 */

const EXCLUDED = new Set(['node_modules', 'dist', 'target', '.git', 'test-results']);

export function treeFiles(root: string, directory: string, excludeGenerated = false): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (excludeGenerated && EXCLUDED.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...treeFiles(root, file, excludeGenerated));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Non-regular artifact input: ${file}`);
  }
  return files.sort();
}

export function digestFiles(root: string, files: readonly string[]): string {
  const hash = new Bun.CryptoHasher('sha256');
  for (const file of [...files].sort()) {
    const body = readFileSync(path.join(root, file));
    hash.update(JSON.stringify([file, body.byteLength]));
    hash.update(body);
  }
  return hash.digest('hex');
}
