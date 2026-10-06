import { expect, test } from 'bun:test';
import { availableParallelism } from 'node:os';
import { PROTOCOL_SCAN, PROTOCOL_TESTS } from './protocol-gates';
import {
  changedFiles,
  type GateDeps,
  gateDependencies,
  parseArgs,
  playwrightPatterns,
  REAL_HELPER_LANE,
  renderPlan,
  rustWorkspacePlan,
  selectGates,
  verificationPlan,
} from './select-gates';

const parallel = `--parallel=${Math.min(8, availableParallelism())}`;

const deps: GateDeps = {
  testFiles: [
    'apps/web/src/view.test.ts',
    'apps/web/src/mock.test.ts',
    'packages/shared/src/transport.test.ts',
    'scripts/select-gates.test.ts',
    'tests/e2e/global-setup.test.ts',
    PROTOCOL_SCAN,
  ],
  unitOwners: new Map(),
  testClosures: new Map(),
  e2eOwners: new Map([
    ['tests/e2e/auth-cross-tab.e2e.ts', [['bun', 'run', 'test:e2e']]],
    ['tests/e2e/carrier-rebind.e2e.ts', [['bun', 'run', 'test:e2e:rebind']]],
  ]),
};
const commands = (plan: ReturnType<typeof selectGates>) => [
  ...plan.preflight,
  ...plan.bun,
  ...plan.cargo,
];

test('prose and empty diffs do not trigger unit or native work', () => {
  expect(selectGates([], deps).static).toEqual([]);
  const plan = selectGates(['README.md'], deps);
  expect(plan.static).toEqual([['bun', 'run', 'check:docs']]);
  expect(commands(plan)).toEqual([]);
});

test('source suites expand to exact isolated files, never substring filters', () => {
  const plan = selectGates(['apps/web/src/view.ts'], deps);
  expect(plan.bun).toEqual([
    ['bun', 'test', parallel, './apps/web/src/mock.test.ts', './apps/web/src/view.test.ts'],
  ]);
  expect(plan.reasons).toContain('apps/web/src/view.ts → web');
});

test('protocol tests appear once even when their owning suites are selected', () => {
  const plan = selectGates(['packages/shared/src/transport.ts', 'scripts/select-gates.ts'], deps);
  const selected = [...plan.preflight, ...plan.bun].flatMap((command) =>
    command.filter((arg) => arg.startsWith('./')),
  );
  expect(
    selected.filter((file) => file === './packages/shared/src/transport.test.ts'),
  ).toHaveLength(1);
  expect(selected.filter((file) => file === `./${PROTOCOL_SCAN}`)).toHaveLength(1);
  for (const file of PROTOCOL_TESTS) expect(selected).toContain(`./${file}`);
  expect(plan.cargo.flat()).not.toContain('check:protocol');
});

test('unit and full verification include tests-root files with identical isolation', () => {
  for (const mode of ['unit', 'verify'] as const) {
    const plan = verificationPlan(mode, deps.testFiles);
    expect(plan.bun[0]).toContain('./tests/e2e/global-setup.test.ts');
    expect(plan.bun[0]).toContain(parallel);
    expect(plan.preflight[0]).toContain(`./${PROTOCOL_SCAN}`);
    expect(plan.bun[0]).not.toContain(`./${PROTOCOL_SCAN}`);
  }
});

test('Cargo coverage is unioned with protocol coverage without repeating whole crates', () => {
  const plan = selectGates(
    ['apps/edge/src/relay.rs', 'apps/daemon/dataplane/src/display/send.rs'],
    deps,
  );
  expect(plan.cargo.filter((command) => command.includes('merkur-edge'))).toHaveLength(1);
  // The real-helper lane a display change adds is its own `--ignored` run.
  const dataplane = plan.cargo.filter(
    (command) => command.includes('merkur-dataplane') && command !== REAL_HELPER_LANE,
  );
  expect(dataplane).toHaveLength(1);
  expect(dataplane[0]).toContain('display::');
  expect(dataplane[0]).toContain('auth::tests');
});

test('a change the image helper can observe builds it, then runs the real-helper lane', () => {
  for (const file of [
    'packages/merkur-image-worker/src/retirement.rs',
    'apps/daemon/dataplane/src/pty/terminal/graphics.rs',
    'apps/daemon/dataplane/src/display/graphics_convergence.rs',
    'Cargo.lock',
  ]) {
    const plan = selectGates([file], deps);
    expect(plan.builds).toEqual([['bun', 'run', 'build:image-worker']]);
    expect(plan.cargo).toContainEqual(REAL_HELPER_LANE);
    expect(plan.cargo).toContainEqual([
      'cargo',
      'test',
      '--locked',
      '-p',
      'merkur-dataplane',
      '--',
      '--ignored',
      'real_helper::',
    ]);
    expect(plan.deferred).toContainEqual(['bun', 'run', 'test:graphics:long']);
  }
  // The helper lane follows the ordinary dataplane run, never replaces it.
  const plan = selectGates(['apps/daemon/dataplane/src/pty/terminal/graphics.rs'], deps);
  const dataplane = plan.cargo.filter((command) => command.includes('merkur-dataplane'));
  expect(dataplane).toHaveLength(2);
  expect(dataplane[0]).toContain('pty::');
  expect(dataplane[0]).not.toContain('--ignored');
  expect(dataplane[1]).toEqual(REAL_HELPER_LANE);
});

test('a dataplane change outside the graphics owner still runs the real-helper lane', () => {
  // The display simulator the `real_helper` modules drive runs ACK provenance, resume,
  // the peer network state and crate-root handlers as the daemon does.
  for (const file of [
    'apps/daemon/dataplane/src/connection.rs',
    'apps/daemon/dataplane/src/session/resume.rs',
    'apps/daemon/dataplane/src/network/peer.rs',
    'apps/daemon/dataplane/src/main.rs',
    'apps/daemon/dataplane/Cargo.toml',
  ]) {
    const plan = selectGates([file], deps);
    expect(plan.builds).toEqual([['bun', 'run', 'build:image-worker']]);
    expect(plan.cargo).toContainEqual(REAL_HELPER_LANE);
  }
});

test('the client, edge, dataplane, transport patches and simulator replay the simulation', () => {
  for (const file of [
    'apps/daemon/dataplane/src/connection.rs',
    'apps/edge/src/relay.rs',
    'packages/merkur-client/src/session.rs',
    'packages/merkur-client-native/src/driver.rs',
    'packages/quinn-proto-patch/src/connection/mod.rs',
    'tools/sim/tests/session.rs',
    'scripts/sim-tests.ts',
  ]) {
    expect(selectGates([file], deps).cargo).toContainEqual(['bun', 'run', 'test:sim']);
  }
  for (const file of ['apps/web/src/view.ts', 'tools/sim/README.md', 'apps/stun/src/main.rs']) {
    expect(selectGates([file], deps).cargo).not.toContainEqual(['bun', 'run', 'test:sim']);
  }
});

test('the crates the Kani proofs compile, and their runner, defer the bounded proofs', () => {
  const kani = ['bun', 'run', 'test:fuzz:kani'];
  for (const file of [
    'packages/merkur-e2e/src/rebind_keeper.rs',
    'packages/merkur-wire/src/input_record.rs',
    'packages/merkur-client/src/input_sequence.rs',
    'tools/bolero/targets.json',
    'scripts/fuzz-tests.ts',
  ]) {
    expect(selectGates([file], deps).deferred).toContainEqual(kani);
  }
  for (const file of ['apps/edge/src/relay.rs', 'tools/bolero/README.md']) {
    expect(selectGates([file], deps).deferred).not.toContainEqual(kani);
  }
});

test('a change the helper cannot observe neither builds it nor runs its lane', () => {
  for (const file of ['apps/edge/src/relay.rs', 'apps/web/src/view.ts']) {
    const plan = selectGates([file], deps);
    expect(plan.builds.flat()).not.toContain('build:image-worker');
    expect(plan.cargo).not.toContainEqual(REAL_HELPER_LANE);
    expect(plan.deferred).not.toContainEqual(['bun', 'run', 'test:graphics:long']);
  }
});

test('full verification builds the helper and runs its lane; unit and protocol runs do not', () => {
  const verify = verificationPlan('verify', deps.testFiles);
  expect(verify.builds).toEqual([['bun', 'run', 'build:image-worker']]);
  expect(verify.cargo).toContainEqual(REAL_HELPER_LANE);
  for (const mode of ['unit', 'protocol'] as const) {
    const plan = verificationPlan(mode, deps.testFiles);
    expect(plan.builds).toEqual([]);
    expect(plan.cargo).not.toContainEqual(REAL_HELPER_LANE);
  }
});

test('the Rust workspace run is one whole-crate cargo selection and nothing else', () => {
  const plan = rustWorkspacePlan(['merkur-edge', 'merkur-dataplane', 'term-wasm']);
  expect(plan.cargo).toEqual([
    ['cargo', 'test', '--locked', '-p', 'merkur-dataplane', '-p', 'merkur-edge', '-p', 'term-wasm'],
  ]);
  expect([...plan.builds, ...plan.preflight, ...plan.static, ...plan.bun]).toEqual([]);
  expect(() => rustWorkspacePlan([])).toThrow('empty Rust workspace');
});

test('a whole dataplane test run subsumes its protocol filters', () => {
  const plan = selectGates(
    ['apps/daemon/dataplane/src/main.rs', 'packages/protocol/src/index.ts'],
    deps,
  );
  const dataplane = plan.cargo.filter(
    (command) => command.includes('merkur-dataplane') && command !== REAL_HELPER_LANE,
  );
  expect(dataplane).toHaveLength(1);
  expect(dataplane[0]).not.toContain('--');
});

test('default auth E2E and calibrated rebind select their owning suites', () => {
  expect(
    selectGates(['tests/e2e/auth-cross-tab.e2e.ts'], deps).deferred.map((command) => command[2]),
  ).toEqual(['test:e2e']);
  expect(
    selectGates(['tests/e2e/carrier-rebind.e2e.ts'], deps).deferred.map((command) => command[2]),
  ).toEqual(['test:e2e:rebind']);
  expect(() => selectGates(['tests/e2e/unowned.e2e.ts'], deps)).toThrow('No E2E owner');
});

test('real configuration ownership agrees with the selector', async () => {
  const current = await gateDependencies();
  expect(
    selectGates(['tests/e2e/auth-cross-tab.e2e.ts'], current).deferred.map((command) => command[2]),
  ).toEqual(['test:e2e']);
  expect(
    selectGates(['tests/e2e/carrier-rebind.e2e.ts'], current).deferred.map((command) => command[2]),
  ).toEqual(['test:e2e:rebind']);
  expect(
    selectGates(['tests/e2e/nested/terminal.e2e.ts'], current).deferred.map(
      (command) => command[2],
    ),
  ).toContain('test:e2e:transport');
});

test('shared E2E fixture changes select real browser consumers', () => {
  const plan = selectGates(['tests/e2e/fixtures/daemon-process.ts'], deps);
  expect(plan.bun[0]).toContain('./tests/e2e/global-setup.test.ts');
  expect(plan.deferred.map((command) => command[2])).toContain('test:e2e:transport');
  expect(plan.deferred.map((command) => command[2])).toContain('test:e2e:rebind');
});

test('full transport subsumes identical latency work, but not calibrated rebind', () => {
  const plan = selectGates(
    ['apps/web/src/terminal-worker.ts', 'tests/e2e/carrier-rebind.e2e.ts'],
    deps,
  );
  expect(plan.deferred.map((command) => command[2])).toEqual([
    'test:e2e:rebind',
    'test:e2e:transport',
  ]);
});

test('WASM prerequisites are ordered and composite builds subsume their members', () => {
  const plan = selectGates(['packages/term-wasm/src/lib.rs', 'packages/e2e-wasm/src/lib.rs'], deps);
  expect(plan.builds).toEqual([
    ['bun', 'run', 'build:wasm'],
    ['bun', 'run', 'sync:wasm'],
  ]);
  expect(
    plan.preflight.some((command) => command.includes('scripts/check-wasm-artifacts.ts')),
  ).toBe(true);
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

test('a module change selects consumers across workspace boundaries without unrelated siblings', () => {
  const plan = selectGates(['packages/shared/src/transport.ts'], {
    ...deps,
    unitOwners: new Map([['packages/shared/src/transport.ts', ['apps/web/src/view.test.ts']]]),
  });
  expect(plan.bun[0]).toContain('./apps/web/src/view.test.ts');
  expect(plan.bun[0]).not.toContain('./apps/web/src/mock.test.ts');
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

test('an edge spec outside the default harness phases is explicitly executed', async () => {
  const current = await gateDependencies();
  const plan = selectGates(['tests/e2e/display-resync-recovery.e2e.ts'], current);
  expect(plan.deferred).toContainEqual([
    'bun',
    'run',
    'test:e2e:transport',
    '--',
    'display-resync-recovery.e2e.ts',
  ]);
});

test('edge configuration changes cover calibrated suites and specs omitted from default phases', async () => {
  const plan = selectGates(['playwright.edge.config.mjs'], await gateDependencies());
  expect(plan.deferred).toContainEqual(['bun', 'run', 'test:e2e:rebind']);
  expect(plan.deferred).toContainEqual(['bun', 'run', 'test:e2e:transport:reorder']);
  expect(plan.deferred).toContainEqual([
    'bun',
    'run',
    'test:e2e:transport',
    '--',
    'display-resync-recovery.e2e.ts',
  ]);
});

test('--force is parsed and the plan names the bun lane files the cache must account for', () => {
  expect(parseArgs(['--run', '--force']).force).toBe(true);
  expect(parseArgs(['--run']).force).toBe(false);
  const plan = selectGates(['apps/web/src/view.ts', 'apps/daemon/dataplane/src/input.rs'], deps);
  // A Rust file is covered by its crate, not by the bun lane, so it never invalidates tests.
  expect(plan.bunInputs).toEqual(['apps/web/src/view.ts']);
  expect(plan.tests).toContain('apps/web/src/view.test.ts');
});

test('a printed plan states what the result cache already proves', () => {
  const plan = selectGates(['apps/web/src/view.ts'], deps);
  const rendered = renderPlan(plan, {
    cache: {
      fresh: ['apps/web/src/view.test.ts'],
      cached: ['apps/web/src/mock.test.ts'],
      keys: new Map(),
      unclaimed: [],
    },
  });
  expect(rendered).toContain('1 of 2 test files; 1 already green for these inputs');
  expect(rendered).toContain(`bun test ${parallel} ./apps/web/src/view.test.ts`);
  expect(rendered).not.toContain('./apps/web/src/mock.test.ts');
});

test('an unclaimed changed file is reported as the reason the cache was dropped', () => {
  const plan = selectGates(['apps/web/src/view.ts'], deps);
  const rendered = renderPlan(plan, {
    cache: {
      fresh: plan.tests,
      cached: [],
      keys: new Map(),
      unclaimed: ['apps/web/fixtures/frame.json'],
    },
  });
  expect(rendered).toContain('cache dropped: 1 changed file(s) no test closure names');
});

test('authenticated benchmark import closure schedules one oracle preflight ahead of parallel lanes', () => {
  const fixture = 'scripts/perf/client-session-fixture.ts';
  const testFile = 'scripts/bench-input-ack.test.ts';
  const owned: GateDeps = {
    ...deps,
    testFiles: [testFile],
    testClosures: new Map([[testFile, [testFile, fixture]]]),
    unitOwners: new Map([[fixture, [testFile]]]),
  };
  const plan = selectGates([fixture], owned);
  expect(
    plan.preflight.filter((command) =>
      command.includes('scripts/prepare-client-session-oracle.ts'),
    ),
  ).toHaveLength(1);
  expect(plan.bun.flat()).toContain(`./${testFile}`);
  expect(selectGates(['README.md'], owned).preflight).toEqual([]);
});

test('protocol expansion prepares the authenticated oracle before its added tests run', () => {
  const plans = [
    selectGates(['apps/server/src/http/routes/session-routes.ts'], deps),
    verificationPlan('protocol', deps.testFiles),
  ];
  for (const plan of plans) {
    expect(plan.tests).toContain('scripts/perf/client-session-fixture.test.ts');
    expect(
      plan.preflight.filter((command) =>
        command.includes('scripts/prepare-client-session-oracle.ts'),
      ),
    ).toHaveLength(1);
  }
});
