import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CEILINGS_FILE,
  ceilingScope,
  cloneCounts,
  compareCeilings,
  compareCloneCounts,
  deadCodeFindings,
  formatCeilings,
  formatCloneCounts,
  hotspotsOf,
  introducedFindings,
  parseCeilings,
  parseCloneCounts,
  partiallyStaged,
  readFallowReport,
  renamedCloneNotes,
  runRatchetAnalysis,
  tightenCeilings,
} from './check-ratchet';

const everywhere = () => true;

type Analysis = Parameters<typeof runRatchetAnalysis>[0];

/** A declared analysis whose tool answers one request at a time. */
function analyse(
  options: Omit<Analysis, 'fallow'> & {
    readonly fallow: (label: string, args: readonly string[]) => Readonly<Record<string, unknown>>;
  },
): number {
  return runRatchetAnalysis({
    ...options,
    fallow: (analyses) => analyses.map(({ label, args }) => options.fallow(label, args)),
  });
}

function health(findings: readonly Record<string, unknown>[]) {
  return {
    summary: { max_cyclomatic_threshold: 33, max_cognitive_threshold: 45 },
    findings,
  };
}

test('fallow answers only with exit 0 or 1 and a JSON object; anything else is unverified', () => {
  expect(readFallowReport('audit', 1, null, '{"verdict":"fail"}')).toEqual({ verdict: 'fail' });
  expect(readFallowReport('audit', 0, null, '{"verdict":"pass"}')).toEqual({ verdict: 'pass' });
  expect(() => readFallowReport('audit', 2, null, '{}')).toThrow('audit exited 2');
  expect(() => readFallowReport('audit', null, 'SIGTERM', '')).toThrow('killed by SIGTERM');
  expect(() => readFallowReport('audit', 0, null, 'panicked at …')).toThrow('printed no JSON');
  expect(() => readFallowReport('audit', 0, null, '[1]')).toThrow('no JSON object');
});

test('a hotspot is strictly above either threshold; same-name functions keep the larger values', () => {
  const current = hotspotsOf(
    health([
      { path: 'a.ts', name: 'f', cyclomatic: 34, cognitive: 10 },
      { path: 'a.ts', name: 'g', cyclomatic: 33, cognitive: 45 },
      { path: 'a.ts', name: '<arrow>', cyclomatic: 20, cognitive: 50 },
      { path: 'a.ts', name: '<arrow>', cyclomatic: 40, cognitive: 46 },
      { path: 'b.ts', name: 'crapOnly', cyclomatic: 30, cognitive: 40, exceeded: 'crap' },
    ]),
  );
  expect([...current]).toEqual([
    ['a.ts::f', { cyclomatic: 34, cognitive: 10 }],
    ['a.ts::<arrow>', { cyclomatic: 40, cognitive: 50 }],
  ]);
  expect(() => hotspotsOf({ findings: [] })).toThrow('no complexity thresholds');
  expect(() => hotspotsOf(health([{ path: 'a.ts', cyclomatic: 50, cognitive: 50 }]))).toThrow(
    'without path, name or metrics',
  );
});

test('ceilings fail a new hotspot, growth in either metric, a loose ceiling and a gone function', () => {
  const current = new Map([
    ['a.ts::same', { cyclomatic: 40, cognitive: 50 }],
    ['a.ts::grew', { cyclomatic: 40, cognitive: 51 }],
    ['a.ts::shrank', { cyclomatic: 39, cognitive: 50 }],
    ['b.ts::fresh', { cyclomatic: 60, cognitive: 10 }],
  ]);
  const ceilings = {
    'a.ts::same': { cyclomatic: 40, cognitive: 50 },
    'a.ts::grew': { cyclomatic: 40, cognitive: 50 },
    'a.ts::shrank': { cyclomatic: 40, cognitive: 50 },
    'c.ts::deleted': { cyclomatic: 70, cognitive: 70 },
  };
  expect(compareCeilings(current, ceilings, everywhere).map((v) => [v.kind, v.key])).toEqual([
    ['grew', 'a.ts::grew'],
    ['loose', 'a.ts::shrank'],
    ['new', 'b.ts::fresh'],
    ['gone', 'c.ts::deleted'],
  ]);
  expect(compareCeilings(current, ceilings, (file) => file === 'a.ts').map((v) => v.key)).toEqual([
    'a.ts::grew',
    'a.ts::shrank',
  ]);
  expect(compareCeilings(current, ceilings, everywhere)[0]?.detail).toBe(
    'cyclomatic 40, cognitive 50 → cyclomatic 40, cognitive 51',
  );
});

test('tightening lowers and drops ceilings but never raises or adds one', () => {
  const current = new Map([
    ['a.ts::lower', { cyclomatic: 35, cognitive: 60 }],
    ['a.ts::higher', { cyclomatic: 50, cognitive: 50 }],
    ['b.ts::fresh', { cyclomatic: 90, cognitive: 90 }],
  ]);
  const ceilings = {
    'a.ts::lower': { cyclomatic: 40, cognitive: 60 },
    'a.ts::higher': { cyclomatic: 40, cognitive: 40 },
    'c.ts::gone': { cyclomatic: 40, cognitive: 40 },
  };
  expect(tightenCeilings(current, ceilings)).toEqual({
    'a.ts::lower': { cyclomatic: 35, cognitive: 60 },
    'a.ts::higher': { cyclomatic: 40, cognitive: 40 },
  });
});

test('the ceilings file round-trips sorted and rejects anything that is not a ceiling', () => {
  const text = formatCeilings({
    'b.ts::g': { cyclomatic: 40, cognitive: 1 },
    'a.ts::f': { cyclomatic: 50, cognitive: 2 },
  });
  expect(text.indexOf('a.ts::f')).toBeLessThan(text.indexOf('b.ts::g'));
  expect(text.endsWith('}\n')).toBe(true);
  expect(parseCeilings(text)).toEqual({
    'a.ts::f': { cyclomatic: 50, cognitive: 2 },
    'b.ts::g': { cyclomatic: 40, cognitive: 1 },
  });
  expect(() => parseCeilings('nope')).toThrow('is not JSON');
  expect(() => parseCeilings('[]')).toThrow('not a JSON object');
  expect(() => parseCeilings('{"a.ts": {"cyclomatic": 1, "cognitive": 1}}')).toThrow('path::name');
  expect(() => parseCeilings('{"a.ts::f": {"cyclomatic": "1", "cognitive": 1}}')).toThrow();
});

test('a run measures the files it changed, and everything when the ceilings or thresholds moved', () => {
  const touched = ceilingScope(['a.ts', 'b.ts'], false);
  expect([touched('a.ts'), touched('c.ts')]).toEqual([true, false]);
  const ceilings = ceilingScope(['a.ts', CEILINGS_FILE], false);
  expect(ceilings('c.ts')).toBe(true);
  expect(ceilingScope(['.fallowrc.json'], false)('c.ts')).toBe(true);
  const staged = ceilingScope(['a.ts', CEILINGS_FILE], true);
  expect([staged('a.ts'), staged('c.ts')]).toEqual([true, false]);
});

test('a staged file with unstaged edits is named; untouched ones are not', () => {
  expect(partiallyStaged(['b.ts', 'a.ts', 'c.ts'], ['c.ts', 'd.ts', 'a.ts'])).toEqual([
    'a.ts',
    'c.ts',
  ]);
  expect(partiallyStaged(['a.ts'], [])).toEqual([]);
  expect(partiallyStaged(['AGENTS.md', 'a.ts'], ['AGENTS.md', 'a.ts'])).toEqual(['a.ts']);
});

test('only findings the audit attributes to the change are reported', () => {
  const report = {
    dead_code: {
      unused_files: [
        { path: 'new.ts', introduced: true },
        { path: 'old.ts', introduced: false },
      ],
      unused_exports: [{ path: 'a.ts', line: 3, export_name: 'x', introduced: true }],
      circular_dependencies: [{ files: ['a.ts', 'b.ts'], introduced: true }],
      total_issues: 4,
    },
    complexity: {
      findings: [
        { path: 'c.ts', line: 9, name: 'big', cyclomatic: 40, cognitive: 50, introduced: true },
        { path: 'c.ts', line: 90, name: 'old', cyclomatic: 90, cognitive: 90, introduced: false },
      ],
    },
    duplication: {
      clone_groups: [
        {
          line_count: 7,
          introduced: true,
          instances: [
            { file: 'd.ts', start_line: 1, end_line: 7 },
            { file: 'e.ts', start_line: 10, end_line: 16 },
          ],
        },
        { introduced: false, instances: [{ file: 'f.ts', start_line: 1, end_line: 5 }] },
      ],
    },
  };
  expect(introducedFindings(report)).toEqual([
    'unused_files: new.ts',
    'unused_exports: a.ts:3 x',
    'circular_dependencies: a.ts → b.ts',
    'complexity: c.ts:9 big (cyclomatic 40, cognitive 50)',
    'clone (7 lines): d.ts:1-7, e.ts:10-16',
  ]);
});

test('renamed-clone notes skip what the exact audit already fails', () => {
  const exact = {
    duplication: {
      clone_groups: [
        { introduced: true, instances: [{ file: 'a.ts', start_line: 10, end_line: 20 }] },
      ],
    },
  };
  const semantic = {
    duplication: {
      clone_groups: [
        {
          introduced: true,
          line_count: 12,
          instances: [
            { file: 'a.ts', start_line: 8, end_line: 21 },
            { file: 'b.ts', start_line: 1, end_line: 12 },
          ],
        },
        {
          introduced: true,
          line_count: 6,
          instances: [
            { file: 'c.ts', start_line: 1, end_line: 6 },
            { file: 'd.ts', start_line: 3, end_line: 8 },
          ],
        },
        { introduced: false, instances: [{ file: 'e.ts', start_line: 1, end_line: 6 }] },
      ],
    },
  };
  expect(renamedCloneNotes(semantic, exact)).toEqual(['clone (6 lines): c.ts:1-6, d.ts:3-8']);
});

function ratchetFixture(check: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'ratchet-analysis-'));
  try {
    mkdirSync(path.join(root, 'fallow-baselines'));
    writeFileSync(path.join(root, CEILINGS_FILE), '{}\n');
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('declared analysis keeps exact, semantic and health requests and audit verdicts', () => {
  ratchetFixture((root) => {
    const calls: { label: string; args: readonly string[] }[] = [];
    const options = {
      root,
      base: 'abc123',
      changed: ['a.ts'],
      staged: true,
      diffArgs: ['--diff-file', path.join(root, 'staged.diff')],
    };
    for (const [verdict, expected] of [
      ['pass', 0],
      ['warn', 0],
      ['fail', 1],
    ] as const) {
      calls.length = 0;
      const result = analyse({
        ...options,
        fallow: (label, args) => {
          calls.push({ label, args });
          return label === 'fallow health' ? health([]) : { verdict };
        },
      });
      expect(result).toBe(expected);
      expect(calls).toEqual([
        { label: 'fallow audit', args: ['audit', '--base', options.base, ...options.diffArgs] },
        {
          label: 'fallow audit (semantic)',
          args: [
            'audit',
            '--config',
            '.fallowrc.semantic.json',
            '--base',
            options.base,
            ...options.diffArgs,
          ],
        },
        { label: 'fallow health', args: ['health'] },
      ]);
    }
    calls.length = 0;
    expect(
      analyse({
        ...options,
        changed: [],
        fallow: (label, args) => {
          calls.push({ label, args });
          return {};
        },
      }),
    ).toBe(0);
    expect(calls).toEqual([]);
  });
});

test('declared analysis refuses invalid audit answers and missing health thresholds', () => {
  ratchetFixture((root) => {
    const options = { root, base: 'abc123', changed: ['a.ts'], staged: false, diffArgs: [] };
    for (const verdict of [undefined, null, 'PASS', true, 0]) {
      expect(() =>
        analyse({
          ...options,
          fallow: (label) => (label === 'fallow health' ? health([]) : { verdict }),
        }),
      ).toThrow('fallow audit returned verdict');
    }
    for (const [exit, signal, text, error] of [
      [2, null, '{}', 'exited 2'],
      [null, 'SIGTERM', '', 'killed by SIGTERM'],
      [0, null, 'not JSON', 'printed no JSON'],
      [0, null, '[]', 'no JSON object'],
    ] as const) {
      expect(() =>
        analyse({
          ...options,
          fallow: (label) => readFallowReport(label, exit, signal, text),
        }),
      ).toThrow(error);
    }
    expect(() =>
      analyse({
        ...options,
        fallow: (label) => (label === 'fallow health' ? { findings: [] } : { verdict: 'pass' }),
      }),
    ).toThrow('no complexity thresholds');
  });
});

test('declared analysis reads unchanged ceilings and fails new, grown, loose and gone hotspots', () => {
  ratchetFixture((root) => {
    const ceilings = formatCeilings({ 'a.ts::f': { cyclomatic: 40, cognitive: 50 } });
    const file = path.join(root, CEILINGS_FILE);
    writeFileSync(file, ceilings);
    const options = { root, base: 'abc123', changed: ['a.ts'], staged: false, diffArgs: [] };
    for (const [findings, expected] of [
      [[{ path: 'a.ts', name: 'f', cyclomatic: 40, cognitive: 50 }], 0],
      [[{ path: 'a.ts', name: 'f', cyclomatic: 40, cognitive: 51 }], 1],
      [[{ path: 'a.ts', name: 'f', cyclomatic: 39, cognitive: 50 }], 1],
      [[{ path: 'a.ts', name: 'new', cyclomatic: 40, cognitive: 50 }], 1],
      [[], 1],
    ] as const) {
      expect(
        analyse({
          ...options,
          fallow: (label) => (label === 'fallow health' ? health(findings) : { verdict: 'pass' }),
        }),
      ).toBe(expected);
      expect(readFileSync(file, 'utf8')).toBe(ceilings);
    }
    expect(
      analyse({
        ...options,
        changed: ['unrelated.ts'],
        fallow: (label) => (label === 'fallow health' ? health([]) : { verdict: 'pass' }),
      }),
    ).toBe(0);
    expect(
      analyse({
        ...options,
        changed: [CEILINGS_FILE],
        fallow: (label) => (label === 'fallow health' ? health([]) : { verdict: 'pass' }),
      }),
    ).toBe(1);
    expect(
      analyse({
        ...options,
        changed: [CEILINGS_FILE],
        staged: true,
        fallow: (label) => (label === 'fallow health' ? health([]) : { verdict: 'pass' }),
      }),
    ).toBe(0);
    writeFileSync(file, 'not JSON');
    expect(() =>
      analyse({
        ...options,
        fallow: (label) => (label === 'fallow health' ? health([]) : { verdict: 'pass' }),
      }),
    ).toThrow('is not JSON');
    rmSync(file);
    expect(() =>
      analyse({
        ...options,
        fallow: (label) => (label === 'fallow health' ? health([]) : { verdict: 'pass' }),
      }),
    ).toThrow('is missing; run --init');
  });
});

test('dead code the baseline does not hold fails, and entries the tree lost are loose', () => {
  const deadCode = {
    total_issues: 1,
    summary: { unused_files: 1 },
    unused_files: [{ path: 'apps/web/src/stray.ts' }],
    unused_exports: [],
    next_steps: [{ command: 'fallow fix' }],
    workspace_diagnostics: [{ message: 'not a finding' }],
    baseline: { entries: 23, matched: 21 },
  };
  expect(deadCodeFindings(deadCode)).toEqual({
    added: ['unused_files: apps/web/src/stray.ts'],
    loose: 2,
  });
  expect(deadCodeFindings({ baseline: { entries: 3, matched: 3 } })).toEqual({
    added: [],
    loose: 0,
  });
  expect(() => deadCodeFindings({})).toThrow('no baseline match');
});

test('clones are held per file by instance count, whatever moves inside or around them', () => {
  const group = (spans: readonly [string, number, number][]) => ({
    line_count: 10,
    instances: spans.map(([file, start, end]) => ({ file, start_line: start, end_line: end })),
  });
  const dupes = {
    clone_groups: [
      group([
        ['scripts/a.ts', 40, 49],
        ['scripts/b.ts', 1, 10],
      ]),
      group([
        ['scripts/a.ts', 90, 99],
        ['scripts/c.ts', 5, 14],
      ]),
    ],
  };
  const counts = cloneCounts(dupes);
  expect(Object.fromEntries(counts)).toEqual({
    'scripts/a.ts': 2,
    'scripts/b.ts': 1,
    'scripts/c.ts': 1,
  });
  expect(parseCloneCounts(formatCloneCounts(counts))).toEqual(counts);
  // Same counts at other lines: nothing changed.
  expect(compareCloneCounts(counts, counts, dupes)).toEqual({ added: [], loose: [] });
  // A file that gained a clone names every group it is in; one that lost one is loose.
  const baseline = new Map([
    ['scripts/a.ts', 1],
    ['scripts/b.ts', 1],
    ['scripts/c.ts', 1],
    ['scripts/gone.ts', 2],
  ]);
  const { added, loose } = compareCloneCounts(counts, baseline, dupes);
  expect(added).toHaveLength(2);
  expect(loose).toEqual(['scripts/gone.ts: allowed 2, found 0']);
  expect(() => parseCloneCounts('{"a.ts": 0}')).toThrow('positive clone count');
});
