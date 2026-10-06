import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverTests, testDependents } from './test-inventory';
import {
  CACHE_VERSION,
  cacheEnabled,
  cachePath,
  partitionTests,
  readCache,
  recordGreen,
  testKeys,
} from './verification-cache';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A miniature repo: one test importing one module, plus a test that imports nothing. */
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-gate-cache-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': '{}',
    'bun.lock': '',
    'bunfig.toml': '',
    'tsconfig.base.json': '{}',
    'scripts/test-preload.ts': '',
    'scripts/verification-executor.ts': '',
    'scripts/verification-junit.ts': '',
    'packages/shared/value.ts': 'export const value = 1;',
    'apps/web/view.test.ts':
      "import { value } from '../../packages/shared/value'; export { value };",
    'tests/alone.test.ts': '',
  };
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  return root;
}

function keysOf(root: string): Map<string, string> {
  return testKeys(root, testDependents(root, discoverTests(root)).closures);
}

test('a test key covers its import closure, not the rest of the repo', () => {
  const root = fixture();
  const before = keysOf(root);

  writeFileSync(path.join(root, 'packages/shared/value.ts'), 'export const value = 2;');
  const afterImport = keysOf(root);
  expect(afterImport.get('apps/web/view.test.ts')).not.toBe(before.get('apps/web/view.test.ts'));
  expect(afterImport.get('tests/alone.test.ts')).toBe(before.get('tests/alone.test.ts'));

  writeFileSync(path.join(root, 'packages/shared/unrelated.ts'), 'export const other = 1;');
  const afterUnrelated = keysOf(root);
  expect(afterUnrelated.get('apps/web/view.test.ts')).toBe(
    afterImport.get('apps/web/view.test.ts'),
  );
});

test('a key is stable across runs and moves with the workspace inputs every test reads', () => {
  const root = fixture();
  expect(keysOf(root).get('tests/alone.test.ts')).toBe(keysOf(root).get('tests/alone.test.ts'));
  const before = keysOf(root).get('tests/alone.test.ts');
  writeFileSync(path.join(root, 'bun.lock'), 'changed');
  expect(keysOf(root).get('tests/alone.test.ts')).not.toBe(before);
});

test('starting a forced run revokes old evidence even if the process never reports results', () => {
  const root = fixture();
  const tests = discoverTests(root);
  recordGreen(root, tests, keysOf(root));
  recordGreen(root, [], new Map(), ['apps/web/view.test.ts']);
  expect(Object.keys(readCache(root).entries)).toEqual(['tests/alone.test.ts']);
});

test('a green result is read back only for the key that produced it', () => {
  const root = fixture();
  const tests = discoverTests(root);
  const closures = testDependents(root, tests).closures;

  const before = partitionTests(tests, [], closures, keysOf(root), readCache(root));
  expect(before.cached).toEqual([]);
  expect(before.fresh).toEqual(tests);

  recordGreen(root, tests, keysOf(root));
  const green = partitionTests(tests, [], closures, keysOf(root), readCache(root));
  expect(green.cached).toEqual(tests);
  expect(green.fresh).toEqual([]);

  writeFileSync(path.join(root, 'packages/shared/value.ts'), 'export const value = 3;');
  const moved = partitionTests(tests, [], closures, keysOf(root), readCache(root));
  expect(moved.fresh).toEqual(['apps/web/view.test.ts']);
  expect(moved.cached).toEqual(['tests/alone.test.ts']);
});

test('a changed file no closure names discards every cached result', () => {
  const root = fixture();
  const tests = discoverTests(root);
  const closures = testDependents(root, tests).closures;
  recordGreen(root, tests, keysOf(root));

  // A fixture opened at runtime is invisible to the import graph, so nothing here can prove
  // which test reads it: the conservative direction is to run them all.
  const unclaimed = partitionTests(
    tests,
    ['apps/web/fixtures/frame.json'],
    closures,
    keysOf(root),
    readCache(root),
  );
  expect(unclaimed.unclaimed).toEqual(['apps/web/fixtures/frame.json']);
  expect(unclaimed.cached).toEqual([]);
  expect(unclaimed.fresh).toEqual(tests);

  // A changed file the graph does name is ordinary: its dependents miss, the rest stay green.
  const claimed = partitionTests(
    tests,
    ['packages/shared/value.ts'],
    closures,
    keysOf(root),
    readCache(root),
  );
  expect(claimed.unclaimed).toEqual([]);
  expect(claimed.cached).toEqual(tests);
});

test('an unreadable, malformed or superseded cache is an empty cache, never an error', () => {
  const root = fixture();
  expect(readCache(root).entries).toEqual({});

  mkdirSync(path.dirname(cachePath(root)), { recursive: true });
  writeFileSync(cachePath(root), 'not json');
  expect(readCache(root).entries).toEqual({});

  writeFileSync(
    cachePath(root),
    JSON.stringify({ version: 'merkur-gate-cache-v0', entries: { 'a.test.ts': { key: 'k' } } }),
  );
  expect(readCache(root).entries).toEqual({});

  writeFileSync(
    cachePath(root),
    JSON.stringify({ version: CACHE_VERSION, entries: { 'a.test.ts': { key: 'k' } } }),
  );
  expect(readCache(root).entries['a.test.ts']?.key).toBe('k');
});

test('the cache is off when the environment says so', () => {
  expect(cacheEnabled({})).toBe(true);
  expect(cacheEnabled({ MERKUR_GATE_CACHE: '1' })).toBe(true);
  expect(cacheEnabled({ MERKUR_GATE_CACHE: '0' })).toBe(false);
});
