import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Bring the Bazel package set back to `bun.lock` after a dependency changed:
 *
 *   bun tools/bazel/bun/refresh-npm-lock.ts
 *
 * It records the facts of every locked tarball not yet verified, writes a pnpm lock holding
 * exactly Bun's versions, has pnpm resolve it over a copy of the workspace manifests, and
 * compares the result with the packages Bun installed. `pnpm-lock.yaml` is replaced only when
 * that comparison finds no difference. It needs `python3` and `pnpm` on PATH and a clean
 * `bun install`; pnpm applies its own policies, a release-age refusal among them.
 */
const root = path.resolve(import.meta.dir, '../../..');

function run(command: readonly string[], cwd: string): void {
  const result = Bun.spawnSync([...command], { cwd, stdout: 'inherit', stderr: 'inherit' });

  if (result.exitCode !== 0 || result.signalCode)
    throw new Error(`${command.slice(0, 3).join(' ')} failed`);
}

/** The YAML document in `file`, as JSON text. */
function json(file: string, indent?: number): string {
  return JSON.stringify(Bun.YAML.parse(readFileSync(file, 'utf8')), null, indent);
}

run(
  [
    'python3',
    'tools/bazel/bun/acquire_npm_inventory.py',
    '--output',
    'tools/bazel/bun/npm-inventory.json',
  ],
  root,
);

// The acquirer writes plain JSON; the repository keeps the inventory in its formatter's layout.
run(['bun', 'x', 'biome', 'format', '--write', 'tools/bazel/bun/npm-inventory.json'], root);

const scratch = mkdtempSync(path.join(os.tmpdir(), 'merkur-npm-lock-'));

try {
  const lock = path.join(scratch, 'pnpm-lock.yaml');
  const resolved = path.join(scratch, 'pnpm-lock.json');
  const workspace = path.join(scratch, 'workspace.json');

  run(['python3', 'tools/bazel/bun/seed_lock.py', '--output', lock], root);

  for (const pattern of ['apps/*/package.json', 'packages/*/package.json']) {
    for (const manifest of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      mkdirSync(path.dirname(path.join(scratch, manifest)), { recursive: true });
      cpSync(path.join(root, manifest), path.join(scratch, manifest));
    }
  }

  cpSync(path.join(root, 'pnpm-workspace.yaml'), path.join(scratch, 'pnpm-workspace.yaml'));

  // pnpm refuses a project whose manifest names another package manager.
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
    (key, value) => (key === 'packageManager' ? undefined : value),
  );

  writeFileSync(path.join(scratch, 'package.json'), JSON.stringify(manifest, null, 2));
  run(['pnpm', 'install', '--lockfile-only', '--ignore-scripts'], scratch);
  writeFileSync(resolved, `${json(lock, 2)}\n`);
  writeFileSync(workspace, json(path.join(root, 'pnpm-workspace.yaml')));
  run(
    [
      'python3',
      'tools/bazel/bun/audit_installed_graph.py',
      '--pnpm-json',
      resolved,
      '--workspace-json',
      workspace,
      '--output',
      path.join(scratch, 'audit.json'),
    ],
    root,
  );
  cpSync(resolved, path.join(root, 'pnpm-lock.yaml'));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
