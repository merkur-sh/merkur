import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';

import {
  BIOME_CONFIG,
  biomeBinary,
  findSuppressions,
  formatCache,
  GATE,
  isLinted,
  isMeasured,
  lintFiles,
  mergeCache,
  parseCache,
  parsePlugins,
  parseReport,
  RULE_SOURCES,
  readFiles,
  renderSuppressions,
  ruleName,
  splitByCache,
  suppressionFailures,
} from './check-slop';
import { RULES as COMMENT_RULES } from './comment-rules';
import { type Finding, foldFindings, formatBaseline, judge } from './lint-ratchet';

const ROOT = path.resolve(import.meta.dir, '..');

const TYPEOF = 'no-runtime-typeof';

const REFLECT = 'no-reflect-get';

const RULES = new Set([TYPEOF, REFLECT]);

/** One rule's cases: what the rule reports for each, and what was intended where it falls short. */
const Cases = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        code: Schema.String,
        filename: Schema.optionalKey(Schema.String),
        reported: Schema.Int,
        intended: Schema.optionalKey(Schema.Int),
        limit: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
);

function finding(file: string, rule: string, line: number): Finding {
  return { file, rule, line, column: 3, message: `message of ${rule}` };
}

function diagnostic(category: string, message: string, file: string, line: number) {
  return { category, message, location: { path: file, start: { line, column: 7 } } };
}

function biomeReport(
  diagnostics: readonly ReturnType<typeof diagnostic>[],
  linted: number,
  held = { skipped: 0, diagnosticsNotPrinted: 0 },
): string {
  return JSON.stringify({ summary: { changed: 0, unchanged: linted, ...held }, diagnostics });
}

function scratchTree(): string {
  return mkdtempSync(path.join(tmpdir(), 'check-slop-test-'));
}

test('the report folds into findings named by the rule that opens each message', () => {
  const report = biomeReport(
    [
      diagnostic('plugin', `[${TYPEOF}] Parse input at its I/O boundary.`, 'scripts/a.ts', 4),
      diagnostic('plugin', `[${REFLECT}] Read the property\nby name.`, './apps/b.ts', 9),
    ],
    2,
  );

  expect(parseReport(report, RULES)).toEqual({
    findings: [
      {
        file: 'scripts/a.ts',
        rule: TYPEOF,
        line: 4,
        column: 7,
        message: 'Parse input at its I/O boundary.',
      },
      {
        file: 'apps/b.ts',
        rule: REFLECT,
        line: 9,
        column: 7,
        message: 'Read the property\nby name.',
      },
    ],
    fileCount: 2,
  });
  expect(parseReport(biomeReport([], 0), RULES)).toEqual({ findings: [], fileCount: 0 });
});

test('a report Biome did not finish, or one that says it could not lint a file, is no answer', () => {
  const whole = biomeReport([diagnostic('plugin', `[${TYPEOF}] Parse it.`, 'scripts/a.ts', 4)], 1);

  expect(parseReport(whole, RULES).findings).toHaveLength(1);
  expect(() => parseReport(whole.slice(0, -30), RULES)).toThrow('biome wrote no JSON report');
  expect(() => parseReport('', RULES)).toThrow('biome wrote no JSON report');
  expect(() =>
    parseReport(biomeReport([diagnostic('parse', 'expected `)`', 'scripts/a.ts', 1)], 1), RULES),
  ).toThrow('biome could not lint scripts/a.ts: parse: expected `)`');
  expect(() =>
    parseReport(biomeReport([diagnostic('plugin', 'no rule named', 'scripts/a.ts', 1)], 1), RULES),
  ).toThrow('biome could not lint scripts/a.ts: plugin: no rule named');
  expect(() =>
    parseReport(biomeReport([diagnostic('plugin', '[no-such-rule] x', 'a.ts', 1)], 1), RULES),
  ).toThrow('a.ts: no rule file is named no-such-rule');
  expect(() =>
    parseReport(biomeReport([], 3, { skipped: 0, diagnosticsNotPrinted: 20 }), RULES),
  ).toThrow('biome held back 20 diagnostics and skipped 0 files');
  expect(() =>
    parseReport(biomeReport([], 3, { skipped: 2, diagnosticsNotPrinted: 0 }), RULES),
  ).toThrow('biome held back 0 diagnostics and skipped 2 files');
});

test('the gate answers for script files outside the generated and vendored trees', () => {
  const linted = [
    'apps/web/src/a.tsx',
    'scripts/b.ts',
    'uno.config.ts',
    'playwright.config.mjs',
    'apps/site/src/c.cts',
    'packages/shared/src/types.d.ts',
    'tools/bazel/bun/runtime.test.ts',
  ];

  const skipped = [
    'docs/security.md',
    'package.json',
    'apps/web/src/styles.css',
    'apps/web/node_modules/solid-js/index.js',
    'packages/e2e-wasm/pkg/e2e_wasm.js',
    'apps/web/dist/assets/index.js',
    'target/debug/build/out.js',
    'packages/vte-patch/examples/parse.ts',
    'packages/term-wasm/vendor/alacritty_terminal/x.ts',
    'apps/server/src/db/generated-types.ts',
    'apps/server/data/seed.ts',
    'packages/shared/test-vectors/vector.ts',
    '.claude/hooks/a.ts',
    '.agents/skills/b.ts',
  ];

  expect(linted.filter(isLinted)).toEqual(linted);
  expect(skipped.filter(isLinted)).toEqual([]);
  // What Biome is handed, the comment rules read too.
  expect(linted.filter(isMeasured)).toEqual(linted);
  expect(skipped.filter(isMeasured)).toEqual([]);
});

test('the gate answers for Rust files outside the excluded trees, for the comment rules alone', () => {
  const rust = [
    'apps/daemon/dataplane/src/main.rs',
    'apps/edge/src/bin/delay_proxy.rs',
    'packages/merkur-wire/src/protocol.rs',
    'packages/merkur-fec/tests/recover.rs',
    'tools/sim/src/lib.rs',
  ];

  const skipped = [
    'Cargo.toml',
    'packages/vte-patch/src/lib.rs',
    'packages/quinn-proto-patch/src/connection/mod.rs',
    'target/clippy/debug/build/out/generated.rs',
    'apps/daemon/dataplane/target/debug/build/out.rs',
    'packages/term-wasm/vendor/alacritty_terminal/src/grid.rs',
  ];

  expect(rust.filter(isMeasured)).toEqual(rust);
  expect(rust.filter(isLinted)).toEqual([]);
  expect(skipped.filter(isMeasured)).toEqual([]);
});

test('one read hands Biome the script files only, and both sets of rules fold into one entry', async () => {
  const root = scratchTree();

  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'src/a.ts'),
      [
        '// kept for now',
        "export const text = (value: string | number) => (typeof value === 'string' ? value : '');",
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(root, 'src/b.rs'), 'fn b() {} // hopefully\n');

    const reading = readFiles(root, ['src/a.ts', 'src/b.rs']);

    expect([...reading.digests.keys()]).toEqual(['src/a.ts']);
    expect(reading.suppressions).toEqual([]);
    expect(reading.comments.map((found) => [found.file, found.rule, found.line])).toEqual([
      ['src/a.ts', 'comment-for-now', 1],
      ['src/b.rs', 'comment-hopefully', 1],
    ]);

    const biome = await lintFiles(biomeBinary(), root, [...reading.digests.keys()]);

    expect(formatBaseline(foldFindings([...biome, ...reading.comments]))).toBe(`{
  "src/a.ts": {
    "comment-for-now": 1,
    "${TYPEOF}": 1
  },
  "src/b.rs": {
    "comment-hopefully": 1
  }
}
`);
    // A Rust file is no script: handed to Biome, it is a file Biome did not lint.
    await expect(lintFiles(biomeBinary(), root, ['src/a.ts', 'src/b.rs'])).rejects.toThrow(
      'biome linted 1 of the 2 files it was given',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('no Biome rule is named as a comment rule is', () => {
  const plugins = parsePlugins(readFileSync(path.join(ROOT, BIOME_CONFIG), 'utf8'));
  const comment = new Set(COMMENT_RULES.map((rule) => rule.name));

  expect(plugins.map(ruleName).filter((name) => comment.has(name))).toEqual([]);
  expect(plugins.map(ruleName).filter((name) => name.startsWith('comment-'))).toEqual([]);
});

test('a comment that switches the plugin rules off is a suppression, in every spelling', () => {
  const source = [
    '// biome-ignore lint: every rule',
    'export const a = 1; // biome-ignore lint/plugin: the plugin category',
    '/* biome-ignore lint/plugin/no-reflect-get: one rule by name */',
    '/*',
    '  biome-ignore lint/suspicious/noConsole lint/plugin: beside a built-in rule',
    '*/',
    '//biome-ignore-all lint/plugin: the whole file',
    'export const b = <div>{/* biome-ignore-start lint(plugin): a range */}</div>;',
    '// biome-ignore-end lint/plugin',
    '',
  ].join('\n');

  expect(findSuppressions('apps/web/src/a.tsx', source)).toEqual(
    [1, 2, 3, 5, 7, 8, 9].map((line) => ({ file: 'apps/web/src/a.tsx', line })),
  );
});

test('a suppression of a built-in rule, and the same words outside a comment, are not one', () => {
  const source = [
    '// biome-ignore lint/suspicious/noConsole: the CLI prints its own output',
    '// biome-ignore lint/suspicious: a group of built-in rules',
    '// biome-ignore format: a table kept in columns',
    '// biome-ignore lint/suspicious/noConsole: lint needs this, lint/plugin does not',
    "export const é = '😀 // biome-ignore lint/plugin: in a string';",
    'export const t = `/* biome-ignore lint: in a template */`;',
    'export const r = /biome-ignore lint/;',
    'export const j = <p>// biome-ignore lint/plugin: in JSX text</p>;',
    '',
  ].join('\n');

  expect(findSuppressions('apps/web/src/b.tsx', source)).toEqual([]);
  expect(findSuppressions('c.ts', 'export const plain = 1;\n')).toEqual([]);
  expect(() => findSuppressions('d.ts', 'export const x = (;\n// biome-ignore lint: x\n')).toThrow(
    'could not parse d.ts to read its comments',
  );
});

test('each suppression is reported at its line and counted in the verdict', () => {
  const suppressions = [
    { file: 'scripts/b.ts', line: 9 },
    { file: 'scripts/a.ts', line: 12 },
    { file: 'scripts/a.ts', line: 3 },
  ];

  const section = [
    'FAIL  suppression comments:',
    '  scripts/a.ts:3 — suppression comments are not allowed; fix the finding',
    '  scripts/a.ts:12 — suppression comments are not allowed; fix the finding',
    '  scripts/b.ts:9 — suppression comments are not allowed; fix the finding',
    '',
  ].join('\n');

  expect(renderSuppressions(suppressions)).toBe(section);
  expect(renderSuppressions([])).toBe('');
  expect(suppressionFailures(suppressions)).toEqual({
    sections: section,
    clause: ', 3 suppression comments',
  });
  expect(suppressionFailures([])).toEqual({ sections: '', clause: '' });
});

test('a run names the baseline, where the rules are stated, and its own --tighten', () => {
  const findings = [finding('scripts/a.ts', TYPEOF, 8), finding('scripts/a.ts', TYPEOF, 1)];
  const failures = suppressionFailures([{ file: 'scripts/a.ts', line: 3 }]);

  const baseline = new Map([
    ['scripts/a.ts', new Map([[TYPEOF, 1]])],
    ['scripts/clean.ts', new Map([[REFLECT, 1]])],
  ]);

  const everything = { inScope: () => true, exists: () => true };

  expect(judge(GATE, 'working tree', { findings, failures }, baseline, everything)).toEqual({
    code: 1,
    output: [
      'check:slop: working tree against lint-baselines/anti-slop.json',
      'FAIL  findings above the baseline (lint-baselines/anti-slop.json):',
      `  scripts/a.ts  ${TYPEOF}  allowed 1, found 2`,
      `    scripts/a.ts:1:3 ${TYPEOF} — message of ${TYPEOF}`,
      `    scripts/a.ts:8:3 ${TYPEOF} — message of ${TYPEOF}`,
      '  The baseline is never raised: a finding is fixed by changing the code. Each Biome rule is stated at the head of its file in tools/biome/slop/, each comment rule in scripts/comment-rules.ts.',
      'FAIL  baseline above the code; run `bun run check:slop --tighten`:',
      `  loose  scripts/clean.ts  ${REFLECT}  allowed 1, found 0`,
      'FAIL  suppression comments:',
      '  scripts/a.ts:3 — suppression comments are not allowed; fix the finding',
      'check:slop: FAIL (2 findings in 1 files, baseline 2, 1 suppression comments)',
      '',
    ].join('\n'),
  });
});

test('a file is linted again only when its bytes are new under these rules', () => {
  const kept = finding('scripts/kept.ts', TYPEOF, 4);

  const cache = {
    rules: 'rule-set',
    files: new Map([
      ['scripts/kept.ts', { digest: 'k1', findings: [kept] }],
      ['scripts/clean.ts', { digest: 'c1', findings: [] }],
      ['scripts/edited.ts', { digest: 'e1', findings: [finding('scripts/edited.ts', TYPEOF, 1)] }],
      ['scripts/deleted.ts', { digest: 'd1', findings: [] }],
    ]),
  };

  const digests = new Map([
    ['scripts/kept.ts', 'k1'],
    ['scripts/clean.ts', 'c1'],
    ['scripts/edited.ts', 'e2'],
    ['scripts/new.ts', 'n1'],
  ]);

  const split = splitByCache(digests, cache);

  expect(split).toEqual({ known: [kept], pending: ['scripts/edited.ts', 'scripts/new.ts'] });

  const fresh = [finding('scripts/new.ts', REFLECT, 2), finding('scripts/new.ts', TYPEOF, 6)];
  const whole = mergeCache(cache, digests, split.pending, fresh, true);

  expect([...whole.files]).toEqual([
    ['scripts/kept.ts', { digest: 'k1', findings: [kept] }],
    ['scripts/clean.ts', { digest: 'c1', findings: [] }],
    ['scripts/edited.ts', { digest: 'e2', findings: [] }],
    ['scripts/new.ts', { digest: 'n1', findings: fresh }],
  ]);
  expect(splitByCache(digests, whole)).toEqual({ known: [kept, ...fresh], pending: [] });
  // A run over some files leaves the entries of the others where they were.
  expect([...mergeCache(cache, digests, split.pending, fresh, false).files.keys()]).toEqual([
    'scripts/kept.ts',
    'scripts/clean.ts',
    'scripts/edited.ts',
    'scripts/deleted.ts',
    'scripts/new.ts',
  ]);
});

test('a cache written under another rule set, or one that cannot be read, is empty', () => {
  const cache = {
    rules: 'rule-set',
    files: new Map([
      ['scripts/b.ts', { digest: 'b1', findings: [finding('scripts/b.ts', TYPEOF, 4)] }],
      ['scripts/a.ts', { digest: 'a1', findings: [] }],
    ]),
  };

  const text = formatCache(cache);

  expect(text).toBe(
    `{"rules":"rule-set","files":{"scripts/a.ts":{"digest":"a1","findings":[]},"scripts/b.ts":{"digest":"b1","findings":[{"file":"scripts/b.ts","rule":"${TYPEOF}","line":4,"column":3,"message":"message of ${TYPEOF}"}]}}}\n`,
  );
  expect(parseCache(text, 'rule-set').files).toEqual(cache.files);
  expect(parseCache(text, 'other rules')).toEqual({ rules: 'other rules', files: new Map() });
  expect(parseCache(text.slice(0, 40), 'rule-set').files.size).toBe(0);
  expect(parseCache('', 'rule-set').files.size).toBe(0);
});

test('the configuration lists every rule file, and every rule has cases it reports and passes', () => {
  const plugins = parsePlugins(readFileSync(path.join(ROOT, BIOME_CONFIG), 'utf8'));

  const onDisk = readdirSync(path.join(ROOT, RULE_SOURCES))
    .filter((file) => file.endsWith('.grit'))
    .map((file) => `${RULE_SOURCES}${file}`);

  expect(plugins).toEqual(onDisk.sort());

  const cases = Schema.decodeSync(Cases)(
    readFileSync(path.join(ROOT, RULE_SOURCES, 'cases.json'), 'utf8'),
  );

  expect(Object.keys(cases)).toEqual(plugins.map(ruleName));

  for (const [rule, entries] of Object.entries(cases)) {
    expect([rule, entries.some((entry) => entry.reported > 0)]).toEqual([rule, true]);
    expect([rule, entries.some((entry) => entry.reported === 0)]).toEqual([rule, true]);

    // A case the rule does not reach says what was intended and why it falls short.
    for (const entry of entries) {
      expect([entry.code, entry.intended === undefined]).toEqual([
        entry.code,
        entry.limit === undefined,
      ]);
      expect([entry.code, entry.intended]).not.toEqual([entry.code, entry.reported]);
    }
  }
});

test('every rule reports exactly what its cases say, run by Biome as the gate runs it', async () => {
  const cases = Schema.decodeSync(Cases)(
    readFileSync(path.join(ROOT, RULE_SOURCES, 'cases.json'), 'utf8'),
  );

  const root = scratchTree();
  const expected: (readonly [rule: string, code: string, reported: number])[] = [];
  const files: string[] = [];

  try {
    for (const [rule, entries] of Object.entries(cases)) {
      for (const [index, entry] of entries.entries()) {
        const file = path.join(rule, String(index), entry.filename ?? 'case.ts');
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), `${entry.code}\n`);
        expected.push([rule, entry.code, entry.reported]);
        files.push(file);
      }
    }

    const findings = await lintFiles(biomeBinary(), root, files);
    const found = foldFindings(findings);

    const reported = expected.map(
      ([rule, code], index) => [rule, code, found.get(files[index] ?? '')?.get(rule) ?? 0] as const,
    );

    expect(reported).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('a file Biome cannot parse, or does not lint, leaves the run unverified', async () => {
  const root = scratchTree();

  try {
    writeFileSync(path.join(root, 'broken.ts'), 'export const x = (;\n');
    writeFileSync(path.join(root, 'fine.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(root, 'notes.md'), 'prose\n');

    expect(await lintFiles(biomeBinary(), root, ['fine.ts'])).toEqual([]);
    await expect(lintFiles(biomeBinary(), root, ['fine.ts', 'broken.ts'])).rejects.toThrow(
      'biome could not lint broken.ts: parse:',
    );
    await expect(lintFiles(biomeBinary(), root, ['fine.ts', 'notes.md'])).rejects.toThrow(
      'biome linted 1 of the 2 files it was given',
    );
    await expect(lintFiles(biomeBinary(), root, ['fine.ts', 'gone.ts'])).rejects.toThrow(
      'gone.ts: internalError/io: No such file or directory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
