import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishWebArtifact, verifyWebArtifact, webArtifactInput } from './e2e-web-artifacts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-web-artifact-'));
  roots.push(root);
  for (const directory of ['scripts', 'apps/web', 'apps/server', 'packages'])
    mkdirSync(path.join(root, directory), { recursive: true });
  for (const file of [
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'tsconfig.base.json',
    'scripts/e2e-web-artifacts.ts',
    'scripts/sync-term-wasm.ts',
    'scripts/term-wasm-provenance.ts',
  ])
    writeFileSync(path.join(root, file), '');
  return root;
}

test('build identity covers configuration, source edits, additions and Vite environment files', () => {
  const root = fixture();
  const before = webArtifactInput(root, false);
  expect(webArtifactInput(root, false)).toBe(before);
  expect(webArtifactInput(root, true)).not.toBe(before);
  writeFileSync(path.join(root, 'apps/web/view.ts'), 'first');
  const added = webArtifactInput(root, false);
  expect(added).not.toBe(before);
  writeFileSync(path.join(root, 'apps/web/view.ts'), 'second');
  const edited = webArtifactInput(root, false);
  expect(edited).not.toBe(added);
  writeFileSync(path.join(root, 'apps/server/.env'), 'VITE_OPTION=changed');
  expect(webArtifactInput(root, false)).not.toBe(edited);
});

test('reused artifacts reject changed output bytes, extra files, and a different input identity', () => {
  const root = fixture();
  const dist = path.join(root, 'web');
  mkdirSync(dist);
  const html = '<html>verified</html>';
  const output = createHash('sha256')
    .update(JSON.stringify(['index.html', Buffer.byteLength(html)]))
    .update(html)
    .digest('hex');
  writeFileSync(path.join(dist, 'index.html'), html);
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ input: 'source-a', output }));
  expect(verifyWebArtifact(root, 'source-a')).toBe(dist);
  const store = fixture();
  const first = path.join(store, '.build-first');
  const second = path.join(store, '.build-second');
  const published = path.join(store, 'source-a');
  cpSync(root, first, { recursive: true });
  cpSync(root, second, { recursive: true });
  expect(publishWebArtifact(first, published, 'source-a')).toBe(path.join(published, 'web'));
  expect(publishWebArtifact(second, published, 'source-a')).toBe(path.join(published, 'web'));
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(false);
  cpSync(root, second, { recursive: true });
  writeFileSync(path.join(published, 'web/index.html'), 'corrupt winner');
  expect(() => publishWebArtifact(second, published, 'source-a')).toThrow('bytes changed');
  expect(existsSync(second)).toBe(true);
  expect(() => verifyWebArtifact(root, 'source-b')).toThrow('input mismatch');
  writeFileSync(path.join(dist, 'index.html'), '<html>tampered</html>');
  expect(() => verifyWebArtifact(root, 'source-a')).toThrow('bytes changed');
  writeFileSync(path.join(dist, 'index.html'), html);
  mkdirSync(path.join(dist, 'dist'));
  writeFileSync(path.join(dist, 'dist/extra.js'), 'unexpected');
  expect(() => verifyWebArtifact(root, 'source-a')).toThrow('bytes changed');
});
