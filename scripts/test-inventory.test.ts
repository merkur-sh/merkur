import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverTests, testCommand, testDependents } from './test-inventory';
import { runTestProcess } from './test-process';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('untracked source tests are discovered once; build trees and fixture modules are not tests', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-inventory-'));
  roots.push(root);
  const source = [
    'apps/web/src/view.test.ts',
    'packages/shared/a.test.ts',
    'tests/e2e/fixtures/clock.test.ts',
    'scripts/gate.test.ts',
  ];
  for (const file of [
    ...source,
    'dist/stun-host/build/packages/shared/a.test.ts',
    'apps/web/dist/view.test.ts',
    'tests/e2e/fixtures/test.ts',
    'packages/shared/node_modules/dependency/x.test.ts',
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  }
  expect(discoverTests(root)).toEqual(source.sort());
  expect(testCommand(discoverTests(root)).slice(3)).toEqual(source.map((file) => `./${file}`));
  expect(() => testCommand([])).toThrow('empty');
});

test('import ownership traverses aliases, TS generics, TSX, dynamic imports and cycles', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-inventory-'));
  roots.push(root);
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['packages/shared/*'] } },
    }),
    'apps/web/view.test.ts': "import './view'; const identity = <T>(value: T): T => value;",
    'apps/web/view.tsx':
      "import { value } from '@shared/value'; export const view = <div>{value}</div>;",
    'packages/shared/value.ts': "export const value = 1; import('./lazy');",
    'packages/shared/lazy.ts': "import './value';",
    'tests/another.test.ts': "import '../packages/shared/lazy';",
    'tests/unrelated.test.ts': '',
  };
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  const { owners } = testDependents(root, discoverTests(root));
  expect(owners.get('packages/shared/value.ts')).toEqual([
    'apps/web/view.test.ts',
    'tests/another.test.ts',
  ]);
  expect(owners.get('apps/web/view.tsx')).toEqual(['apps/web/view.test.ts']);
  expect(owners.get('tests/unrelated.test.ts')).toEqual(['tests/unrelated.test.ts']);
});

test('Bun directory discovery also excludes generated release copies with the repository config', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-bun-discovery-'));
  roots.push(root);
  const config = Bun.TOML.parse(readFileSync(new URL('../bunfig.toml', import.meta.url), 'utf8'));
  if (!('test' in config)) throw new Error('Missing repository test configuration');
  const testConfig = config.test as { pathIgnorePatterns: string[] };
  writeFileSync(
    path.join(root, 'bunfig.toml'),
    `[test]\npathIgnorePatterns = ${JSON.stringify(testConfig.pathIgnorePatterns)}\n`,
  );
  for (const file of [
    'packages/shared/original.test.ts',
    'dist/stun-host/build/packages/shared/original.test.ts',
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(
      path.join(root, file),
      file.startsWith('dist/')
        ? 'throw new Error("GENERATED-COPY-RAN");'
        : 'import {test,expect} from "bun:test";test("source",()=>expect(true).toBe(true));',
    );
  }
  const result = await runTestProcess([process.execPath, 'test', 'packages'], { cwd: root });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain('1 pass');
  expect(result.stderr).not.toContain('GENERATED-COPY-RAN');
});
