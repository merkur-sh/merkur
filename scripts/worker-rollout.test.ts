import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

async function source(path: string): Promise<string> {
  return Bun.file(resolve(root, path)).text();
}

describe('browser worker rollout ABI', () => {
  test('main pins content-hashed worker dependencies instead of mutable fixed URLs', async () => {
    const [transportClient, terminalClient, viteConfig] = await Promise.all([
      source('apps/web/src/transport-worker-client.ts'),
      source('apps/web/src/terminal-worker-client.ts'),
      source('apps/web/vite.config.ts'),
    ]);

    // Assert the module-URL form rather than a whole formatted call: the
    // pinning invariant is the Vite-resolved relative specifier, and an exact
    // call-site string breaks on reformatting without the pin ever regressing.
    expect(transportClient).toContain("new URL('./transport-worker.ts', import.meta.url)");
    expect(terminalClient).toContain("new URL('./terminal-worker.ts', import.meta.url)");
    expect(transportClient).not.toContain("'/transport-worker.js'");
    expect(terminalClient).not.toContain("'/terminal-worker.js'");

    // Top-level fixed worker entries bypass Vite's worker dependency graph and
    // can pair an old main bundle with a new SAB/message ABI after SW takeover.
    expect(viteConfig).not.toMatch(/['"]terminal-worker['"]\s*:/);
    expect(viteConfig).not.toMatch(/['"]transport-worker['"]\s*:/);
  });
});
