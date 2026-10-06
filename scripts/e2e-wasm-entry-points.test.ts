// Every Bun entry point whose import graph reaches the e2e WebAssembly
// registry must also register the Bun instantiator.
//
// Shared and auth modules reach ML-DSA-87, SHA-2 and HMAC through
// `packages/shared/src/e2e-wasm-runtime.ts` and never import the glue
// themselves (see that file). A process that reaches them without importing
// `e2e-wasm-bun` compiles and starts, then throws "not instantiated" at its
// first signature: release verification did exactly that in `verify-linux-x64`.
// The bundler's own import graph is the exact answer; `e2e-wasm-entry-scan.ts`
// asks it in a fresh process, and an entry it cannot build fails this too.

import { expect, test } from 'bun:test';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test('every Bun entry point that reaches the e2e registry registers the Bun instantiator', async () => {
  const scan = Bun.spawn(['bun', 'run', path.join(ROOT, 'scripts/e2e-wasm-entry-scan.ts')], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const [output, exitCode] = await Promise.all([new Response(scan.stdout).text(), scan.exited]);
  expect(exitCode).toBe(0);
  const result = JSON.parse(output) as {
    readonly entries: number;
    readonly failed: readonly string[];
    readonly offenders: readonly string[];
  };
  expect(result.entries).toBeGreaterThan(100);
  expect(result.failed).toEqual([]);
  expect(result.offenders).toEqual([]);
}, 600_000);
