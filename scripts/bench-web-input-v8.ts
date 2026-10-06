import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Runs `bench-web-input-v8-entry.ts` under V8 (Node): per-keystroke allocation
 * bytes for Rust input/sealing, ring park and the app
 * keybinds listener, first on V8's default tiers and then on Ignition and
 * Sparkplug only, the tiers typing-rate code usually stays in.
 *
 * The entry is bundled for Node with Solid's production browser build pinned
 * by path, so the keybinds listener runs the same Solid the app ships and one
 * Solid instance owns both the root and the listener's scopes. The keybinds
 * module reaches the entry as a virtual module, which keeps the web app's Solid
 * modules out of the scripts type-check project.
 *
 * The interpreted tier's counts repeat to the byte; the default tier's move by
 * tens of bytes between runs with when V8 happens to optimize, so compare a
 * change on the interpreted tier and read the default tier as a range.
 *
 *   bun run scripts/bench-web-input-v8.ts
 */

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const ENTRY = path.join(REPO_ROOT, 'scripts/bench-web-input-v8-entry.ts');
// Real path: the workspace link would resolve Solid's own imports from the
// wrong directory, and one path for every importer means one Solid instance.
const SOLID_BROWSER_BUILD = realpathSync(
  path.join(REPO_ROOT, 'apps/web/node_modules/solid-js/dist/solid.js'),
);
const KEYBINDS_MODULE = path.join(REPO_ROOT, 'apps/web/src/hooks/createKeybinds.ts');
const TIERS: ReadonlyArray<readonly [name: string, flags: readonly string[]]> = [
  ['default', []],
  ['interpreted', ['--no-opt', '--no-maglev']],
];

const outDir = mkdtempSync(path.join(tmpdir(), 'merkur-bench-web-input-v8-'));
try {
  const build = await Bun.build({
    entrypoints: [ENTRY],
    outdir: outDir,
    target: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'web-input-v8-modules',
        setup(builder) {
          builder.onResolve({ filter: /^solid-js$/ }, () => ({ path: SOLID_BROWSER_BUILD }));
          builder.onResolve({ filter: /^bench-web-input-v8:keybinds$/ }, () => ({
            path: 'keybinds',
            namespace: 'bench-web-input-v8',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'bench-web-input-v8' }, () => ({
            contents:
              `export { createRoot } from ${JSON.stringify(SOLID_BROWSER_BUILD)};\n` +
              `export { createKeybinds } from ${JSON.stringify(KEYBINDS_MODULE)};\n`,
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const bundle = build.outputs[0]?.path;
  if (!build.success || bundle === undefined) {
    throw new Error(`bench: bundling failed\n${build.logs.join('\n')}`);
  }
  for (const [tier, flags] of TIERS) {
    const result = Bun.spawnSync(['node', ...flags, bundle], {
      cwd: REPO_ROOT,
      env: { ...process.env, BENCH_V8_TIER: tier, MERKUR_BENCH_REPO_ROOT: REPO_ROOT },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) throw new Error(`bench: node exited ${result.exitCode} (${tier})`);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
