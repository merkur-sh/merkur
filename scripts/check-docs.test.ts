import { expect, test } from 'bun:test';

import {
  AGENTS_CHAIN_MAX_BYTES,
  AGENTS_MD_MAX_BYTES,
  cargoWorkspacePaths,
  findConfigViolations,
  findFactViolations,
  findGeneratedBlockViolations,
  findHarnessViolations,
  findLayoutViolations,
  findLinkViolations,
  findPathViolations,
  findScriptViolations,
  findWorkspaceViolations,
  headingSlugs,
  type LoaderKey,
  type PinnedFact,
  parseConfigTable,
  parseEnvExample,
  pathCandidate,
  proseLines,
  rulePaths,
} from './check-docs';

const existsIn =
  (files: readonly string[]) =>
  (relative: string): boolean =>
    files.includes(relative);
test('proseLines skips fenced code and numbers lines from 1', () => {
  const source = ['a', '```ts', 'code `apps/nowhere.ts`', '```', 'b', '~~~', 'x', '~~~', 'c'].join(
    '\n',
  );
  expect([...proseLines(source)]).toEqual([
    { line: 1, text: 'a' },
    { line: 5, text: 'b' },
    { line: 9, text: 'c' },
  ]);
});

// C1

test('pathCandidate recognises rooted paths only, and strips suffixes', () => {
  expect(pathCandidate('apps/web/src/main.ts:12')).toBe('apps/web/src/main.ts');
  expect(pathCandidate('docs/transport.md#display')).toBe('docs/transport.md');
  expect(pathCandidate('packages/protocol/')).toBe('packages/protocol');
  expect(pathCandidate('Cargo.lock')).toBeUndefined();
  expect(pathCandidate('apps/web/**')).toBeUndefined();
  expect(pathCandidate('bun run scripts/x.ts')).toBeUndefined();
  expect(pathCandidate('~/.merkur/config.json')).toBeUndefined();
  expect(pathCandidate('MESSAGE_TYPE_DISPLAY_DICT_READY')).toBeUndefined();
});

test('a backticked path that does not exist is a paths violation; fenced code is ignored', () => {
  const source = [
    'See `apps/web/src/main.ts` and `apps/web/src/gone.ts`.',
    'Also `lib.rs` and `missing-file.toml`, which bare names are never checked.',
    '```',
    '`apps/never/in/code.ts`',
    '```',
  ].join('\n');
  const violations = findPathViolations('docs/x.md', source, {
    exists: existsIn(['apps/web/src/main.ts']),
  });
  expect(violations.map((entry) => [entry.line, entry.detail])).toEqual([
    [1, 'apps/web/src/gone.ts'],
  ]);
  expect(violations.every((entry) => entry.check === 'paths')).toBe(true);
});

test('a rooted path also resolves relative to the document directory', () => {
  const violations = findPathViolations(
    '.claude/skills/release/SKILL.md',
    'Run `scripts/release.sh preflight`.'.replace(' preflight', ''),
    { exists: existsIn(['.claude/skills/release/scripts/release.sh']) },
  );
  expect(violations).toEqual([]);
});

// C2

const scriptsOf = (dir: string): ReadonlySet<string> | undefined => {
  if (dir === '.') return new Set(['check', 'check:types', 'test:unit', 'setup', 'dev']);
  if (dir === 'apps/server') return new Set(['telemetry:smoke']);
  return undefined;
};

test('bun run names must exist in the package.json the --cwd selects', () => {
  const source = [
    'Run `bun run check:types`, `bun run setup`, and `bun run --cwd apps/server telemetry:smoke`.',
    'Then `bun run check:nope` and `bun run --cwd apps/web build:web`.',
    'The verification table writes `--cwd apps/server telemetry:smoke`.',
  ].join('\n');
  const violations = findScriptViolations('AGENTS.md', source, { scriptsOf });
  expect(violations.map((entry) => [entry.line, entry.detail, entry.reason])).toEqual([
    [2, 'bun run --cwd apps/web build:web', 'apps/web/package.json does not exist'],
    [2, 'bun run check:nope', 'script "check:nope" is not declared in package.json'],
  ]);
});

test('bare a:b tokens are scripts only when their prefix is a script prefix', () => {
  const source = [
    '`test:unit` and `check:types` pass; `check:dead` is missing.',
    '`bun:test`, `node:fs`, `session::rebind_flow::tests`, and `host:port` are not scripts.',
    '`test:e2e:*` and `bun run check:*|gates` are skipped.',
  ].join('\n');
  const violations = findScriptViolations('AGENTS.md', source, { scriptsOf });
  expect(violations.map((entry) => entry.detail)).toEqual(['check:dead']);
});

test('a bun run of a file path is a path, not a script', () => {
  expect(
    findScriptViolations('x.md', '`bun run scripts/run-edge-harness.ts` and `bun run x.ts`', {
      scriptsOf,
    }),
  ).toEqual([]);
});

// C3

test('headingSlugs follows GitHub slugging and suffixes duplicates', () => {
  const source = [
    '# Merkur `Codec` Notes',
    '## Display ACK/resync',
    '## Display ACK/resync',
    '### What `check` cannot tell you',
    '```',
    '# not a heading',
    '```',
  ].join('\n');
  expect(headingSlugs(source)).toEqual([
    'merkur-codec-notes',
    'display-ackresync',
    'display-ackresync-1',
    'what-check-cannot-tell-you',
  ]);
});

test('relative links must resolve and fragments must name a heading', () => {
  const docs: Record<string, string> = {
    'docs/a.md': '# A\n\n## Section One\n',
    'docs/b.md': [
      '# B',
      '',
      'See [a](a.md#section-one), [bad](a.md#section-two), [gone](../missing.md),',
      '[self](#b), [self-bad](#nope), [ext](https://example.com/x#y), ![img](../img.png).',
      '[perf](../PERF.md) and [`transport.md`](./transport.md).',
    ].join('\n'),
  };
  const files = ['docs/a.md', 'docs/b.md', 'img.png'];
  const violations = findLinkViolations('docs/b.md', docs['docs/b.md'] ?? '', {
    exists: existsIn(files),
    readSource: (relative) => docs[relative],
  });
  expect(violations.map((entry) => [entry.line, entry.detail])).toEqual([
    [3, '../missing.md'],
    [3, 'a.md#section-two'],
    [4, '#nope'],
    [5, '../PERF.md'],
    [5, './transport.md'],
  ]);
  expect(violations.every((entry) => entry.check === 'links')).toBe(true);
});

// C4

const facts: readonly PinnedFact[] = [
  {
    name: 'codec-version',
    claims: [{ pattern: /currently `(\d+)`/ }, { pattern: /\bcodec version is (\d+)\b/ }],
    source: { file: 'lib.rs', pattern: /^pub const VERSION: u8 = (\d+);/m },
  },
  {
    name: 'loss-threshold',
    claims: [
      {
        pattern: /`LOSS_PACKET_THRESHOLD` \((\w+)\)/,
        normalize: (raw) => (raw === 'three' ? '3' : raw),
      },
    ],
    source: { file: 'policy.rs', pattern: /LOSS_PACKET_THRESHOLD: u32 = (\d+);/ },
  },
];
const factSources: Record<string, string> = {
  'lib.rs': '/// doc\npub const VERSION: u8 = 24;\n',
  'policy.rs': 'pub const LOSS_PACKET_THRESHOLD: u32 = 3;\n',
};
const readFactSource = (file: string): string | undefined => factSources[file];

test('a prose claim that disagrees with its source constant is a facts violation', () => {
  const docs = [
    {
      file: 'AGENTS.md',
      source: 'The wire version is currently `24`. `LOSS_PACKET_THRESHOLD` (three).',
    },
    { file: 'docs/transport.md', source: 'line\nThe codec version is 23: old.\n' },
  ];
  const violations = findFactViolations(docs, readFactSource, facts);
  expect(violations).toEqual([
    {
      file: 'docs/transport.md',
      line: 2,
      check: 'facts',
      detail: 'codec-version: 23',
      reason: 'lib.rs says 24',
    },
  ]);
});

test('a pinned fact no prose claims is itself a violation, as is a source that no longer matches', () => {
  const docs = [{ file: 'AGENTS.md', source: 'currently `24`.' }];
  const violations = findFactViolations(docs, readFactSource, facts);
  expect(violations.map((entry) => [entry.file, entry.detail])).toEqual([
    ['scripts/check-docs.ts', 'loss-threshold'],
  ]);

  const missingSource = findFactViolations(docs, () => undefined, facts.slice(0, 1));
  expect(missingSource.map((entry) => [entry.file, entry.detail])).toEqual([
    ['lib.rs', 'codec-version'],
  ]);
});

// C5

const README_CONFIG = `# Merkur

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| \`HOST\` | No | Defaults to \`0.0.0.0\`. |
| \`PORT\` | No | Defaults to \`3001\`. |
| \`REDIS_URL\` | Yes | Redis URL. |
| \`SESSION_TOKEN_TTL_MS\` | No | Defaults to \`60000\`. |
| \`BOX_HOST_TOKEN\` | Yes | Bearer token. |
| \`VITE_PIN\` | Build + standalone startup | Pinned. |
| \`GHOST_KEY\` | No | Nobody reads this. |

## Development
`;

test('parseConfigTable reads only the ## Configuration table', () => {
  const rows = parseConfigTable(README_CONFIG);
  expect(rows.map((row) => row.key)).toEqual([
    'HOST',
    'PORT',
    'REDIS_URL',
    'SESSION_TOKEN_TTL_MS',
    'BOX_HOST_TOKEN',
    'VITE_PIN',
    'GHOST_KEY',
  ]);
  expect(rows[0]).toEqual({
    line: 7,
    key: 'HOST',
    required: 'No',
    notes: 'Defaults to `0.0.0.0`.',
  });
});

test('parseEnvExample distinguishes uncommented keys from # KEY= placeholders', () => {
  const entries = parseEnvExample(
    ['# comment', 'HOST=0.0.0.0', '# LOG_LEVEL=info', '#  Local: REDIS_URL=x', 'REDIS_URL='].join(
      '\n',
    ),
  );
  expect([...entries.entries()]).toEqual([
    ['HOST', { line: 2, commented: false }],
    ['LOG_LEVEL', { line: 3, commented: true }],
    ['REDIS_URL', { line: 5, commented: false }],
  ]);
});

test('config parity reports every side that disagrees with the loader', () => {
  const loaderKeys = new Map<string, LoaderKey>([
    ['HOST', { required: false, defaultValue: '0.0.0.0' }],
    ['PORT', { required: false, defaultValue: '3000' }],
    ['REDIS_URL', { required: true }],
    ['SESSION_TOKEN_TTL_MS', { required: false, defaultValue: '60000' }],
    ['BOX_HOST_TOKEN', { required: false }],
    ['VITE_PIN', { required: true }],
    ['LOG_LEVEL', { required: false }],
  ]);
  const envExample = [
    'HOST=0.0.0.0',
    '# PORT=3000',
    '# REDIS_URL=',
    '# SESSION_TOKEN_TTL_MS=',
    '# BOX_HOST_TOKEN=',
    'VITE_PIN=',
  ].join('\n');
  const violations = findConfigViolations({
    loaderKeys,
    readme: README_CONFIG,
    envExample,
  });
  expect(
    violations.map((entry) => `${entry.file}:${entry.line} ${entry.detail} — ${entry.reason}`),
  ).toEqual([
    'apps/server/.env.example:1 LOG_LEVEL — optional loader key is not listed; add a `# KEY=` placeholder',
    'apps/server/.env.example:3 REDIS_URL — required loader key must be an uncommented `KEY=` line',
    'README.md:1 LOG_LEVEL — loader key has no row in the ## Configuration table',
    'README.md:8 PORT — Notes must quote the loader default `3000`',
    'README.md:11 BOX_HOST_TOKEN — the loader defaults this key but the Required cell says Yes',
    'README.md:13 GHOST_KEY — row names a key packages/config/src/server-environment.ts does not read',
  ]);
});

// C6

test('a generated block must be present and equal to the rendered text', () => {
  const block = { file: '.claude/skills/verify/SKILL.md', name: 'gate-rules', label: 'gate table' };
  const rendered = '| Changed | Also run | Why |\n| --- |\n';
  const current = `# R\n\n<!-- generated:gate-rules -->\n${rendered}<!-- /generated:gate-rules -->\n`;
  expect(findGeneratedBlockViolations(current, block, rendered)).toEqual([]);

  const stale = current.replace('| --- |', '| old |');
  expect(
    findGeneratedBlockViolations(stale, block, rendered).map((entry) => [
      entry.file,
      entry.line,
      entry.reason,
    ]),
  ).toEqual([
    ['.claude/skills/verify/SKILL.md', 3, 'gate table is stale: run `bun run generate:docs`'],
  ]);

  const absent = findGeneratedBlockViolations('# R\n\n| Changed |', block, rendered);
  expect(absent).toHaveLength(1);
  expect(absent[0]?.reason).toContain('markers absent: wrap the gate table in');
});

// C7

const CARGO = `[workspace]
members = [
  "apps/daemon/dataplane",
  "packages/vte-patch"
]
exclude = [
  "packages/quinn-patch"
]

# comment
[patch.crates-io]
vte = { path = "packages/vte-patch" }
wtransport = { path = "packages/wtransport-patch" }

[profile.release]
opt-level = 3
`;

test('cargoWorkspacePaths unions members, exclude, and patch paths', () => {
  expect(cargoWorkspacePaths(CARGO)).toEqual([
    'apps/daemon/dataplane',
    'packages/quinn-patch',
    'packages/vte-patch',
    'packages/wtransport-patch',
  ]);
});

test('every workspace member needs a Workspace Layout row and every row must exist', () => {
  const readme = `# R

## Workspace Layout

| Path | Role |
| --- | --- |
| \`apps/web\` | Browser app. |
| \`apps/daemon/dataplane\` | Rust. |
| \`packages/vte-patch\` | Vendored. |
| \`spikes/gone\` | Removed spike. |

## Other
`;
  const violations = findWorkspaceViolations({
    cargoToml: CARGO,
    bunWorkspaces: ['apps/web', 'apps/server'],
    readme,
    exists: existsIn(['apps/web', 'apps/server', 'apps/daemon/dataplane', 'packages/vte-patch']),
  });
  expect(violations.map((entry) => [entry.line, entry.detail])).toEqual([
    [1, 'apps/server'],
    [1, 'packages/quinn-patch'],
    [1, 'packages/wtransport-patch'],
    [10, 'spikes/gone'],
  ]);
});

// C8

test('rulePaths reads inline lists, comma lists, and YAML lists', () => {
  expect(rulePaths('---\npaths: ["apps/web/**", "packages/keyboard/**"]\n---\nbody')).toEqual([
    'apps/web/**',
    'packages/keyboard/**',
  ]);
  expect(rulePaths('---\npaths: apps/web/**, packages/keyboard/**\n---\n')).toEqual([
    'apps/web/**',
    'packages/keyboard/**',
  ]);
  expect(
    rulePaths('---\ndescription: x\npaths:\n  - "apps/edge/**"\n  - Cargo.toml\n---\n'),
  ).toEqual(['apps/edge/**', 'Cargo.toml']);
  expect(rulePaths('no frontmatter')).toBeUndefined();
  expect(rulePaths('---\ndescription: x\n---\n')).toBeUndefined();
});

test('harness shape: rule globs, skill frontmatter, AGENTS.md budgets, CLAUDE.md import', () => {
  const violations = findHarnessViolations({
    rules: [
      { file: '.claude/rules/edge.md', source: '---\npaths: ["apps/edge/**"]\n---\n' },
      { file: '.claude/rules/ghost.md', source: '---\npaths: ["apps/ghost/**"]\n---\n' },
      { file: '.claude/rules/open.md', source: '# no frontmatter\n' },
    ],
    skills: [
      {
        file: '.claude/skills/release/SKILL.md',
        dir: 'release',
        source: '---\nname: release\ndescription: Cut a release.\n---\n',
      },
      {
        file: '.claude/skills/verify/SKILL.md',
        dir: 'verify',
        source: `---\nname: verify-gates\ndescription: ${'x'.repeat(1025)}\n---\n`,
      },
    ],
    agents: [
      { file: 'AGENTS.md', bytes: AGENTS_MD_MAX_BYTES + 1 },
      { file: 'apps/server/AGENTS.md', bytes: 100 },
      { file: 'apps/server/src/AGENTS.md', bytes: AGENTS_CHAIN_MAX_BYTES - AGENTS_MD_MAX_BYTES },
    ],
    claudeMd: '\n# CLAUDE.md\n',
    globMatches: (glob) => (glob === 'apps/edge/**' ? 3 : 0),
  });
  expect(violations.map((entry) => `${entry.file} ${entry.detail}`)).toEqual([
    '.claude/rules/ghost.md apps/ghost/**',
    '.claude/rules/open.md paths',
    '.claude/skills/verify/SKILL.md description: 1025 chars',
    '.claude/skills/verify/SKILL.md name: verify-gates',
    `AGENTS.md ${AGENTS_MD_MAX_BYTES + 1} B`,
    `apps/server/src/AGENTS.md ${AGENTS_CHAIN_MAX_BYTES + 101} B`,
    'CLAUDE.md # CLAUDE.md',
  ]);
});

test('a well-formed harness passes', () => {
  expect(
    findHarnessViolations({
      rules: [{ file: '.claude/rules/edge.md', source: '---\npaths: ["apps/edge/**"]\n---\n' }],
      skills: [
        {
          file: '.claude/skills/release/SKILL.md',
          dir: 'release',
          source: '---\nname: release\ndescription: Cut a release.\n---\n',
        },
      ],
      agents: [
        { file: 'AGENTS.md', bytes: 10_000 },
        { file: 'apps/web/AGENTS.md', bytes: 200 },
      ],
      claudeMd: '@AGENTS.md\n\nClaude-only notes.\n',
      globMatches: () => 1,
    }),
  ).toEqual([]);
});

// C8

test('reference prose is undated outside inline code and fenced blocks', () => {
  const docs = [
    {
      file: 'docs/transport.md',
      source: [
        'Verdicts are 2·RTO.',
        'Production on 2026-09-08 is why.',
        'A literal `2026-09-08` inside code is not prose.',
        '```',
        'run --since 2026-09-01',
        '```',
      ].join('\n'),
    },
    { file: 'docs/edge-profile-2026-09-13.md', source: '# Profile\n' },
    { file: 'README.md', source: 'Released 2026-09-13.\n' },
  ];
  expect(findLayoutViolations(docs).map((v) => `${v.file}:${v.line} ${v.detail}`)).toEqual([
    'docs/edge-profile-2026-09-13.md:1 edge-profile-2026-09-13.md',
    'docs/transport.md:2 2026-09-08',
  ]);
});
