// Lists the Bun entry points whose import graph reaches the e2e WebAssembly
// registry without registering the Bun instantiator, as the bundler itself
// resolves them. Run by `e2e-wasm-entry-points.test.ts` in a fresh process:
// repeated `Bun.build` calls inside the test runner stop resolving workspace
// aliases part-way through, so an in-process scan skips entries silently.

import process from 'node:process';

const ENTRY_GLOBS = [
  'scripts/*.ts',
  'scripts/ci/*.ts',
  'apps/server/scripts/*.ts',
  'apps/server/migrations/*.ts',
  'apps/*/src/index.ts',
];
// Optional imports no Bun entry here reaches at runtime: Playwright's BiDi
// mapper and the V8 input bench's virtual modules. Everything else must resolve.
const EXTERNAL = ['*.wasm', 'chromium-bidi/*', 'bench-web-input-v8:*'];

const entries: string[] = [];
for (const pattern of ENTRY_GLOBS) {
  for await (const file of new Bun.Glob(pattern).scan('.')) {
    if (!file.endsWith('.test.ts')) entries.push(file);
  }
}
entries.sort();

const failed: string[] = [];
const offenders: string[] = [];
for (const entry of entries) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    metafile: true,
    throw: false,
    external: EXTERNAL,
  });
  if (!result.success || result.metafile === undefined) {
    failed.push(entry);
    continue;
  }
  const inputs = Object.keys(result.metafile.inputs);
  const reaches = inputs.some((input) => input.endsWith('packages/shared/src/e2e-wasm-runtime.ts'));
  const registers = inputs.some((input) => input.endsWith('packages/shared/src/e2e-wasm-bun.ts'));
  if (reaches && !registers) offenders.push(entry);
}

process.stdout.write(`${JSON.stringify({ entries: entries.length, failed, offenders })}\n`);
