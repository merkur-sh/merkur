import { expect, test } from 'bun:test';
import {
  changedFiles,
  type E2eOwners,
  e2eOwners,
  parseArgs,
  playwrightPatterns,
  renderPlan,
  selectGates,
} from './gates';

const owners: E2eOwners = new Map([
  ['tests/e2e/auth-cross-tab.e2e.ts', [['bun', 'run', 'test:e2e']]],
  ['tests/e2e/carrier-rebind.e2e.ts', [['bun', 'run', 'test:e2e:rebind']]],
]);

const suites = (plan: ReturnType<typeof selectGates>) => plan.deferred.map((command) => command[2]);

test('prose earns only the docs gate, and an empty diff earns nothing', () => {
  const prose = selectGates(['docs/transport.md', '.claude/rules/edge.md'], owners);
  expect(prose.docsOnly).toBe(true);
  expect(prose.commands).toEqual([['bazel', 'test', '//:check_docs']]);
  expect(renderPlan(selectGates([], owners))).toBe('no gate: nothing changed\n');
});

test('any other change is the whole cached test graph', () => {
  const plan = selectGates(['apps/web/src/view.ts'], owners);
  expect(plan.commands).toEqual([['bazel', 'test', '//...']]);
});

test('Rust and the build graph earn the cached test graph alone; dependencies earn the audit', () => {
  // `//:rust_lint` is a Bazel test, so Clippy's ratchet is inside `bazel test //...`.
  expect(selectGates(['apps/edge/src/lib.rs'], owners).commands).toEqual([
    ['bazel', 'test', '//...'],
  ]);
  expect(selectGates(['tools/bazel/bun/bun.bzl'], owners).commands).toEqual([
    ['bazel', 'test', '//...'],
  ]);
  const dependencies = selectGates(['pnpm-lock.yaml'], owners).commands;
  expect(dependencies).toContainEqual(['bun', 'run', 'check:audit']);
  expect(dependencies).toContainEqual(['bun', 'run', 'check:js-dependency-policy']);
});

test('E2E specs select their owning suites; an unowned spec is an error', () => {
  expect(suites(selectGates(['tests/e2e/auth-cross-tab.e2e.ts'], owners))).toEqual(['test:e2e']);
  expect(suites(selectGates(['tests/e2e/carrier-rebind.e2e.ts'], owners))).toEqual([
    'test:e2e:rebind',
  ]);
  expect(() => selectGates(['tests/e2e/unowned.e2e.ts'], owners)).toThrow('No E2E owner');
});

test('shared E2E fixtures and the native sync select real browser consumers', () => {
  for (const file of ['tests/e2e/fixtures/daemon-process.ts', 'scripts/native-artifacts.ts']) {
    const deferred = suites(selectGates([file], owners));
    expect(deferred).toContain('test:e2e:transport');
    expect(deferred).toContain('test:e2e:rebind');
  }
});

test('full transport subsumes identical latency work, but not calibrated rebind', () => {
  const plan = selectGates(
    ['apps/web/src/terminal-worker.ts', 'tests/e2e/carrier-rebind.e2e.ts'],
    owners,
  );
  expect(suites(plan)).toEqual(['test:e2e:rebind', 'test:e2e:transport']);
});

test('real configuration ownership agrees with the selector', async () => {
  const current = await e2eOwners();
  expect(suites(selectGates(['tests/e2e/auth-cross-tab.e2e.ts'], current))).toEqual(['test:e2e']);
  expect(suites(selectGates(['tests/e2e/carrier-rebind.e2e.ts'], current))).toEqual([
    'test:e2e:rebind',
  ]);
  expect(suites(selectGates(['tests/e2e/nested/terminal.e2e.ts'], current))).toContain(
    'test:e2e:transport',
  );
  expect(
    selectGates(['tests/e2e/display-resync-recovery.e2e.ts'], current).deferred,
  ).toContainEqual(['bun', 'run', 'test:e2e:transport', '--', 'display-resync-recovery.e2e.ts']);
  const config = selectGates(['playwright.edge.config.mjs'], current).deferred;
  expect(config).toContainEqual(['bun', 'run', 'test:e2e:rebind']);
  expect(config).toContainEqual(['bun', 'run', 'test:e2e:transport:reorder']);
});

test('diff discovery includes deleted files and both rename endpoints with spaces', () => {
  const seen: string[][] = [];
  const result = changedFiles('base', (args) => {
    seen.push([...args]);
    if (args[0] === 'status')
      return 'R  apps/web/new name.ts\0apps/server/old name.ts\0 D packages/shared/gone.ts\0';
    if (args[0] === 'merge-base') return 'abc\n';
    return 'packages/auth/deleted.ts\0';
  });
  expect(result).toEqual([
    'apps/server/old name.ts',
    'apps/web/new name.ts',
    'packages/auth/deleted.ts',
    'packages/shared/gone.ts',
  ]);
  expect(seen[2]).toContain('--no-renames');
});

test('Playwright ownership parses literal globs and ignores comments and environment-dependent setup', () => {
  expect(
    playwrightPatterns(`throw new Error('setup env missing');
    // testMatch: ['**/wrong.e2e.ts']
    export default defineConfig({ testDir: './tests/e2e', testMatch: ['**/nested/actual.e2e.ts'] });`),
  ).toEqual({ testDir: './tests/e2e', testMatch: ['**/nested/actual.e2e.ts'] });
  expect(() =>
    playwrightPatterns(`export default defineConfig({testDir:'./tests/e2e',testMatch:dynamic});`),
  ).toThrow('literal glob');
});

test('arguments', () => {
  expect(parseArgs(['--run', '--all', '--files', 'a.ts,b.ts'])).toEqual({
    run: true,
    all: true,
    base: undefined,
    files: ['a.ts', 'b.ts'],
  });
  expect(() => parseArgs(['--force'])).toThrow('unknown argument');
});
