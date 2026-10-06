import { expect, test } from 'bun:test';

import {
  type E2eSpecInputs,
  e2eScriptsOf,
  e2eTableRows,
  GENERATED_BLOCKS,
  gateRuleAlsoRunCell,
  gateRuleChangedCell,
  parsePlaywrightTestMatch,
  parseSpecListConstant,
  renderE2eSpecTable,
  renderGateRulesTable,
  replaceGenerated,
} from './generate-docs';
import { RULES, type Rule } from './select-gates';

const HARNESS = 'scripts/run-edge-harness.ts';

const sources: Record<string, string> = {
  [HARNESS]: `// Every other spec in \`playwright.edge.config.mjs\`'s testMatch is parallel.
const LATENCY_SPECS = ['startup-latency.e2e.ts', 'transport-latency.e2e.ts'];
const FUNCTIONAL_SPECS = [
  'carrier-rebind.e2e.ts',
  'terminal.e2e.ts',
];`,
  'scripts/run-edge-topology-harness.ts': `spawn('bunx', ['playwright', 'test', '-c', 'playwright.edge-topology.config.mjs'])`,
};
const readSource = (file: string): string | undefined => sources[file];

const inputs: E2eSpecInputs = {
  configs: [
    { file: 'playwright.config.mjs', specs: ['app', 'auth-resilience'] },
    {
      file: 'playwright.edge.config.mjs',
      specs: [
        'carrier-rebind',
        'display-resync-recovery',
        'startup-latency',
        'terminal',
        'transport-latency',
      ],
    },
    { file: 'playwright.edge-topology.config.mjs', specs: ['edge-topology'] },
  ],
  scripts: [
    ['test:e2e', 'playwright test'],
    ['test:e2e:transport', `bun run ${HARNESS}`],
    ['test:e2e:latency', `bun run ${HARNESS} transport-latency.e2e.ts --workers=1`],
    [
      'test:e2e:latency:impaired',
      `EDGE_NETWORK_PROFILE=typical EDGE_NETWORK_DATAGRAM_LOSS_PERCENT=3 EDGE_NETWORK_REORDER=moderate bun run ${HARNESS} transport-latency.e2e.ts --workers=1`,
    ],
    [
      'test:e2e:transport:reorder',
      `EDGE_NETWORK_PROFILE=typical EDGE_NETWORK_SCENARIO=handshake-split bun run ${HARNESS} carrier-rebind.e2e.ts --workers=1`,
    ],
    ['test:e2e:edge-topology', 'bun run scripts/run-edge-topology-harness.ts'],
  ],
  latencySpecs: ['startup-latency', 'transport-latency'],
  functionalSpecs: ['carrier-rebind', 'terminal'],
  drivers: [
    { file: 'scripts/run-terminal-network-matrix.ts', specs: ['display-resync-recovery'] },
    { file: 'scripts/run-terminal-packing-delivery.ts', specs: ['terminal-packing-delivery'] },
  ],
  allSpecs: [
    'app',
    'auth-resilience',
    'carrier-rebind',
    'display-resync-recovery',
    'edge-topology',
    'startup-latency',
    'terminal',
    'terminal-direct-reference',
    'terminal-packing-delivery',
    'transport-latency',
  ],
};

test('parsePlaywrightTestMatch reads both the array and the single-string forms', () => {
  const array = `export default defineConfig({
  testDir: './tests/e2e',
  testMatch: [
    '**/app.e2e.ts',
    '**/auth-cross-tab.e2e.ts',
  ],
  workers: 1,
});`;
  expect(parsePlaywrightTestMatch(array)).toEqual(['app', 'auth-cross-tab']);

  const single = `export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/edge-sweep.e2e.ts',
  workers: 1,
});`;
  expect(parsePlaywrightTestMatch(single)).toEqual(['edge-sweep']);
  expect(parsePlaywrightTestMatch('export default {}')).toEqual([]);
});

test('parseSpecListConstant reads a named spec list and ignores the rest of the file', () => {
  const harness = sources[HARNESS] ?? '';
  expect(parseSpecListConstant(harness, 'LATENCY_SPECS')).toEqual([
    'startup-latency',
    'transport-latency',
  ]);
  expect(parseSpecListConstant(harness, 'FUNCTIONAL_SPECS')).toEqual([
    'carrier-rebind',
    'terminal',
  ]);
  expect(parseSpecListConstant(harness, 'MISSING')).toEqual([]);
});

test('e2eScriptsOf keeps only test:e2e* scripts, in declaration order', () => {
  const packageJson = JSON.stringify({
    scripts: {
      'test:unit': 'bun test',
      'test:e2e:rebind': 'x',
      'test:e2e': 'playwright test',
      check: 'y',
    },
  });
  expect(e2eScriptsOf(packageJson)).toEqual([
    ['test:e2e:rebind', 'x'],
    ['test:e2e', 'playwright test'],
  ]);
});

test('a plain playwright script takes the default config and its whole testMatch', () => {
  const row = e2eTableRows(inputs, readSource).find((entry) => entry.command === 'test:e2e');
  expect(row).toEqual({
    command: 'test:e2e',
    config: 'playwright.config.mjs',
    profile: 'default',
    specs: ['app', 'auth-resilience'],
    phase: 'one Playwright run',
  });
});

test('the unfiltered harness run lists the serial and parallel phases from the harness constants', () => {
  const row = e2eTableRows(inputs, readSource).find(
    (entry) => entry.command === 'test:e2e:transport',
  );
  expect(row?.config).toBe('playwright.edge.config.mjs');
  expect(row?.specs).toEqual([
    'carrier-rebind',
    'startup-latency',
    'terminal',
    'transport-latency',
  ]);
  expect(row?.phase).toContain('serial `--workers=1`: `startup-latency`, `transport-latency`');
  expect(row?.phase).toContain('then 2 functional specs in parallel');
});

test('a filtered harness run names only its spec and renders its EDGE_NETWORK_* profile', () => {
  const rows = e2eTableRows(inputs, readSource);
  const impaired = rows.find((entry) => entry.command === 'test:e2e:latency:impaired');
  expect(impaired?.specs).toEqual(['transport-latency']);
  expect(impaired?.profile).toBe('`typical`, 3% loss, moderate reorder');
  expect(impaired?.phase).toBe('one Playwright run, `--workers=1`');

  const reorder = rows.find((entry) => entry.command === 'test:e2e:transport:reorder');
  expect(reorder?.profile).toBe('`typical`, `handshake-split` scenario');
});

test('a harness script that names its config in a spawn call resolves to that config', () => {
  const row = e2eTableRows(inputs, readSource).find(
    (entry) => entry.command === 'test:e2e:edge-topology',
  );
  expect(row?.config).toBe('playwright.edge-topology.config.mjs');
  expect(row?.specs).toEqual(['edge-topology']);
});

test('the rendered block has the five columns and the two trailing bullets', () => {
  const block = renderE2eSpecTable(inputs, readSource);
  const lines = block.split('\n');
  expect(lines[0]).toBe('| Command | Config | Profile | Specs | Phase |');
  expect(lines[1]).toBe('| --- | --- | --- | --- | --- |');
  expect(block).toContain(
    '| `test:e2e:latency` | `playwright.edge.config.mjs` | default | `transport-latency` | one Playwright run, `--workers=1` |',
  );
  // Reachable only by filter: in a config, but in no script's effective spec set.
  expect(block).toContain(
    '- Reachable only by an explicit filter (pass the spec name to the harness): `display-resync-recovery` (`playwright.edge.config.mjs`; driven by `scripts/run-terminal-network-matrix.ts`).',
  );
  // In no config at all, with and without a driver script.
  expect(block).toContain(
    '- In no config, so no `test:e2e*` script can select them: `terminal-direct-reference` (no script drives it); `terminal-packing-delivery` (driven by `scripts/run-terminal-packing-delivery.ts`).',
  );
  expect(block.endsWith('\n')).toBe(true);
});

test('rendering is deterministic', () => {
  expect(renderE2eSpecTable(inputs, readSource)).toBe(renderE2eSpecTable(inputs, readSource));
});

test('replaceGenerated swaps only the text between the markers and keeps them', () => {
  const document = `# Title

intro

<!-- generated:e2e-specs -->
| old |
<!-- /generated:e2e-specs -->

outro
`;
  const next = replaceGenerated(document, 'e2e-specs', '| new |\n');
  expect(next).toBe(`# Title

intro

<!-- generated:e2e-specs -->
| new |
<!-- /generated:e2e-specs -->

outro
`);
  // Idempotent: a second replacement with the same block changes nothing.
  expect(next === undefined ? undefined : replaceGenerated(next, 'e2e-specs', '| new |\n')).toBe(
    next,
  );
});

test('replaceGenerated reports absent or reversed markers rather than appending', () => {
  expect(replaceGenerated('no markers here', 'e2e-specs', 'x')).toBeUndefined();
  expect(replaceGenerated('<!-- generated:e2e-specs -->', 'e2e-specs', 'x')).toBeUndefined();
  expect(
    replaceGenerated(
      '<!-- /generated:e2e-specs -->\n<!-- generated:e2e-specs -->',
      'e2e-specs',
      'x',
    ),
  ).toBeUndefined();
});

// Gate-selection table

const GATE_RULES: readonly Rule[] = [
  { name: 'docs', globs: ['**/*.md', '.claude/**'], effects: { noGate: true } },
  {
    name: 'web-hot-path',
    globs: [
      { label: 'the hot-path list', globs: ['apps/web/src/a.ts'] },
      'apps/web/src/terminal/**',
    ],
    exclude: ['**/*.test.ts'],
    effects: { deferred: ['test:e2e:latency'] },
    note: 'A test file is not the render path.',
  },
  {
    name: 'term-wasm',
    globs: ['packages/term-wasm/**'],
    effects: {
      builds: ['build:wasm', 'sync:wasm'],
      rustLint: true,
      crates: ['term-wasm'],
      bunTestDir: 'apps/web',
    },
  },
  {
    name: 'dataplane',
    globs: ['apps/daemon/dataplane/src/**'],
    effects: { rustLint: true, crates: ['merkur-dataplane'] },
  },
  {
    name: 'stun',
    globs: ['apps/stun/src/**'],
    effects: {
      rustLint: true,
      crates: ['merkur-stun'],
      bunTestFiles: ['apps/server/src/services/stun-ticket-service.test.ts'],
      deferred: ['test:natlab'],
    },
  },
  {
    name: 'real-helper',
    globs: ['packages/merkur-image-worker/**'],
    effects: {
      builds: ['build:image-worker'],
      realHelper: true,
      deferred: ['test:graphics:long'],
    },
  },
  { name: 'dependencies', globs: ['package.json'], effects: { audit: true } },
  {
    name: 'protocol',
    globs: ['packages/protocol/**'],
    effects: { protocol: true, deferred: ['test:e2e:transport'] },
  },
];

test('the Changed cell lists globs, prints a group by its label, and names the exclusions', () => {
  expect(gateRuleChangedCell(GATE_RULES[0] as Rule)).toBe('`**/*.md`, `.claude/**`');
  expect(gateRuleChangedCell(GATE_RULES[1] as Rule)).toBe(
    'the hot-path list, `apps/web/src/terminal/**` (except `**/*.test.ts`)',
  );
});

test('the Also run cell follows the plan phases: builds, cargo lane, bun lane, deferred', () => {
  const cells = GATE_RULES.map(gateRuleAlsoRunCell);
  expect(cells).toEqual([
    '`check:docs` only',
    'by hand: `test:e2e:latency`',
    'first `build:wasm`, then `sync:wasm`; `rust:lint`; `cargo test --locked -p term-wasm`; isolated source tests under `apps/web`',
    '`rust:lint`; `cargo test --locked -p merkur-dataplane` filtered to the changed modules',
    '`rust:lint`; `cargo test --locked -p merkur-stun`; isolated `apps/server/src/services/stun-ticket-service.test.ts`; then, by hand: `test:natlab`',
    'first `build:image-worker`; `cargo test --locked -p merkur-dataplane -- --ignored real_helper::`; then, by hand: `test:graphics:long`',
    '`check:audit`',
    '`check:protocol`; then, by hand: `test:e2e:transport`',
  ]);
});

test('the gate table has one row per rule in rule order, with the note in the last column', () => {
  const lines = renderGateRulesTable(GATE_RULES).split('\n');
  expect(lines[0]).toBe('| Changed | Also run | Why |');
  expect(lines[1]).toBe('| --- | --- | --- |');
  expect(lines).toHaveLength(GATE_RULES.length + 3);
  expect(lines[2]).toBe('| `**/*.md`, `.claude/**` | `check:docs` only |  |');
  expect(lines[3]).toBe(
    '| the hot-path list, `apps/web/src/terminal/**` (except `**/*.test.ts`) | by hand: `test:e2e:latency` | A test file is not the render path. |',
  );
  expect(lines[lines.length - 1]).toBe('');
});

test('a rule with no globs cannot render: it would be a row nothing ever matches', () => {
  expect(() =>
    renderGateRulesTable([{ name: 'empty', globs: [], effects: { audit: true } }]),
  ).toThrow('gate rule empty has no globs');
});

test('the checked-in rules render one row each and every row names a gate', () => {
  const lines = renderGateRulesTable(RULES).split('\n').slice(2, -1);
  expect(lines).toHaveLength(RULES.length);
  for (const line of lines) {
    expect(line).toMatch(/^\| .+ \| .+ \| .* \|$/);
  }
});

test('every generated block names a distinct marker in prose or the environment template', () => {
  const names = GENERATED_BLOCKS.map((block) => block.name);
  expect(new Set(names).size).toBe(names.length);
  for (const block of GENERATED_BLOCKS) {
    expect(block.file.endsWith('.md') || block.file === 'apps/server/.env.example').toBe(true);
  }
});
