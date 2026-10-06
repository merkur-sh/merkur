import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  adopt,
  adoptionRefusal,
  compareCounts,
  type Finding,
  foldFindings,
  formatBaseline,
  judge,
  NO_FAILURES,
  parseBaseline,
  type RatchetGate,
  renderViolations,
  runTree,
  selectMode,
  summarize,
  tighten,
  tightenCounts,
} from './lint-ratchet';

const GATE: RatchetGate = {
  name: 'check:example',
  baseline: 'lint-baselines/example.json',
  counted: 'findings',
  rules: 'Each rule is stated in rules/.',
};

const TYPEOF = 'no-runtime-typeof';

const REFLECT = 'no-reflect-get';

const everything = { inScope: () => true, exists: () => true };

const SUPPRESSED = {
  sections: 'FAIL  suppression comments:\n  scripts/a.ts:3 — not allowed\n',
  clause: ', 1 suppression comments',
};

function counts(
  ...entries: readonly (readonly [file: string, rule: string, count: number])[]
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();

  for (const [file, rule, count] of entries) {
    const rules = result.get(file) ?? new Map<string, number>();
    rules.set(rule, count);
    result.set(file, rules);
  }

  return result;
}

function finding(file: string, rule: string, line: number): Finding {
  return { file, rule, line, column: 3, message: `message of ${rule}` };
}

test('--write-baseline is refused while a baseline exists', () => {
  expect(adoptionRefusal(GATE, true)).toBe(
    'check:example: refused: lint-baselines/example.json: a baseline exists; lower it with --tighten. Re-adoption means deleting the file first\n',
  );
  expect(adoptionRefusal(GATE, false)).toBeNull();
});

test('findings fold into a count per file and rule', () => {
  const folded = foldFindings([
    finding('scripts/a.ts', TYPEOF, 1),
    finding('scripts/a.ts', TYPEOF, 8),
    finding('scripts/a.ts', REFLECT, 2),
    finding('apps/b.ts', TYPEOF, 5),
  ]);

  expect(folded).toEqual(
    counts(['scripts/a.ts', TYPEOF, 2], ['scripts/a.ts', REFLECT, 1], ['apps/b.ts', TYPEOF, 1]),
  );
});

test('a count above its entry fails and prints every finding with its message', () => {
  const findings = [finding('scripts/a.ts', TYPEOF, 8), finding('scripts/a.ts', TYPEOF, 1)];

  const violations = compareCounts(
    foldFindings(findings),
    counts(['scripts/a.ts', TYPEOF, 1]),
    everything,
  );

  expect(violations).toEqual([
    { file: 'scripts/a.ts', rule: TYPEOF, kind: 'raised', allowed: 1, found: 2 },
  ]);
  expect(renderViolations(GATE, violations, findings)).toBe(
    [
      'FAIL  findings above the baseline (lint-baselines/example.json):',
      `  scripts/a.ts  ${TYPEOF}  allowed 1, found 2`,
      `    scripts/a.ts:1:3 ${TYPEOF} — message of ${TYPEOF}`,
      `    scripts/a.ts:8:3 ${TYPEOF} — message of ${TYPEOF}`,
      '  The baseline is never raised: a finding is fixed by changing the code. Each rule is stated in rules/.',
      '',
    ].join('\n'),
  );
});

test('a file or a rule the baseline does not name is allowed nothing', () => {
  const current = counts(['scripts/new.ts', TYPEOF, 1], ['scripts/a.ts', REFLECT, 3]);
  const baseline = counts(['scripts/a.ts', TYPEOF, 4]);

  expect(compareCounts(current, baseline, everything)).toEqual([
    { file: 'scripts/a.ts', rule: REFLECT, kind: 'raised', allowed: 0, found: 3 },
    { file: 'scripts/a.ts', rule: TYPEOF, kind: 'loose', allowed: 4, found: 0 },
    { file: 'scripts/new.ts', rule: TYPEOF, kind: 'raised', allowed: 0, found: 1 },
  ]);
});

test('a count below its entry is loose and points at --tighten', () => {
  const violations = compareCounts(
    counts(['scripts/a.ts', TYPEOF, 2]),
    counts(['scripts/a.ts', TYPEOF, 5], ['scripts/clean.ts', REFLECT, 1]),
    everything,
  );

  expect(violations).toEqual([
    { file: 'scripts/a.ts', rule: TYPEOF, kind: 'loose', allowed: 5, found: 2 },
    { file: 'scripts/clean.ts', rule: REFLECT, kind: 'loose', allowed: 1, found: 0 },
  ]);
  expect(renderViolations(GATE, violations, [])).toBe(
    [
      'FAIL  baseline above the code; run `bun run check:example --tighten`:',
      `  loose  scripts/a.ts  ${TYPEOF}  allowed 5, found 2`,
      `  loose  scripts/clean.ts  ${REFLECT}  allowed 1, found 0`,
      '',
    ].join('\n'),
  );
});

test('an entry for a file that is gone fails as gone', () => {
  const violations = compareCounts(
    counts(),
    counts(['scripts/deleted.ts', TYPEOF, 2], ['scripts/deleted.ts', REFLECT, 7]),
    { inScope: () => true, exists: (file) => file !== 'scripts/deleted.ts' },
  );

  expect(violations).toEqual([
    { file: 'scripts/deleted.ts', rule: REFLECT, kind: 'gone', allowed: 7, found: 0 },
    { file: 'scripts/deleted.ts', rule: TYPEOF, kind: 'gone', allowed: 2, found: 0 },
  ]);
  expect(renderViolations(GATE, violations, [])).toContain(
    `  gone   scripts/deleted.ts  ${TYPEOF}  allowed 2, found 0\n`,
  );
});

test('a run over some files answers only for those files', () => {
  const current = counts(['scripts/staged.ts', TYPEOF, 2], ['scripts/other.ts', TYPEOF, 9]);

  const baseline = counts(
    ['scripts/staged.ts', TYPEOF, 1],
    ['scripts/other.ts', TYPEOF, 1],
    ['scripts/unstaged-deletion.ts', TYPEOF, 1],
  );

  const staged = { inScope: (file: string) => file === 'scripts/staged.ts', exists: () => false };

  expect(compareCounts(current, baseline, staged)).toEqual([
    { file: 'scripts/staged.ts', rule: TYPEOF, kind: 'raised', allowed: 1, found: 2 },
  ]);
  expect(summarize(GATE, current, baseline, staged.inScope)).toBe(
    '2 findings in 1 files, baseline 1',
  );
  expect(summarize(GATE, current, baseline, () => true)).toBe('11 findings in 2 files, baseline 3');
  expect(summarize({ ...GATE, counted: 'baselined findings' }, current, baseline, () => true)).toBe(
    '11 baselined findings in 2 files, baseline 3',
  );
});

test('--tighten lowers and removes entries, and refuses to raise or add one', () => {
  const current = counts(
    ['scripts/lower.ts', TYPEOF, 2],
    ['scripts/raise.ts', TYPEOF, 6],
    ['scripts/raise.ts', REFLECT, 1],
    ['scripts/new.ts', TYPEOF, 1],
  );

  const baseline = counts(
    ['scripts/lower.ts', TYPEOF, 5],
    ['scripts/lower.ts', REFLECT, 3],
    ['scripts/raise.ts', TYPEOF, 4],
    ['scripts/fixed.ts', TYPEOF, 1],
  );

  const next = tightenCounts(current, baseline);

  expect(next).toEqual(counts(['scripts/lower.ts', TYPEOF, 2], ['scripts/raise.ts', TYPEOF, 4]));
  // What is left after tightening is exactly what it refused: the run exits non-zero and names it.
  expect(compareCounts(current, next, everything)).toEqual([
    { file: 'scripts/new.ts', rule: TYPEOF, kind: 'raised', allowed: 0, found: 1 },
    { file: 'scripts/raise.ts', rule: REFLECT, kind: 'raised', allowed: 0, found: 1 },
    { file: 'scripts/raise.ts', rule: TYPEOF, kind: 'raised', allowed: 4, found: 6 },
  ]);
  expect(compareCounts(counts(['scripts/lower.ts', TYPEOF, 2]), next, everything)).toEqual([
    { file: 'scripts/raise.ts', rule: TYPEOF, kind: 'loose', allowed: 4, found: 0 },
  ]);
});

test('the baseline is written in one key order whatever order the findings arrive in', () => {
  const forward = counts(
    ['apps/web/src/b.ts', TYPEOF, 2],
    ['apps/web/src/b.ts', REFLECT, 1],
    ['apps/web/src/a.ts', TYPEOF, 3],
    ['apps/web/src/zero.ts', TYPEOF, 0],
  );

  const backward = counts(
    ['apps/web/src/a.ts', TYPEOF, 3],
    ['apps/web/src/b.ts', REFLECT, 1],
    ['apps/web/src/b.ts', TYPEOF, 2],
  );

  const text = `{
  "apps/web/src/a.ts": {
    "${TYPEOF}": 3
  },
  "apps/web/src/b.ts": {
    "${REFLECT}": 1,
    "${TYPEOF}": 2
  }
}
`;

  expect(formatBaseline(forward)).toBe(text);
  expect(formatBaseline(backward)).toBe(text);
  expect(formatBaseline(parseBaseline(GATE, text))).toBe(text);
  expect(formatBaseline(counts())).toBe('{}\n');
});

test('a baseline that is not positive counts per file and rule is refused', () => {
  for (const text of ['', '[]', '{"a.ts": 1}', '{"a.ts": {"r": 0}}', '{"a.ts": {"r": 1.5}}']) {
    expect(() => parseBaseline(GATE, text)).toThrow('lint-baselines/example.json is not');
  }
});

test('a check prints what it measured against, each failure, and one verdict line', () => {
  const findings = [finding('scripts/a.ts', TYPEOF, 4), finding('scripts/a.ts', TYPEOF, 9)];
  const clean = { findings, failures: NO_FAILURES };
  const baseline = counts(['scripts/a.ts', TYPEOF, 2]);

  expect(judge(GATE, 'working tree', clean, baseline, everything)).toEqual({
    code: 0,
    output: [
      'check:example: working tree against lint-baselines/example.json',
      'check:example: pass (2 findings in 1 files, baseline 2)',
      '',
    ].join('\n'),
  });
  expect(
    judge(GATE, 'staged files', clean, counts(['scripts/a.ts', TYPEOF, 1]), everything),
  ).toEqual({
    code: 1,
    output: [
      'check:example: staged files against lint-baselines/example.json',
      'FAIL  findings above the baseline (lint-baselines/example.json):',
      `  scripts/a.ts  ${TYPEOF}  allowed 1, found 2`,
      `    scripts/a.ts:4:3 ${TYPEOF} — message of ${TYPEOF}`,
      `    scripts/a.ts:9:3 ${TYPEOF} — message of ${TYPEOF}`,
      '  The baseline is never raised: a finding is fixed by changing the code. Each rule is stated in rules/.',
      'check:example: FAIL (2 findings in 1 files, baseline 1)',
      '',
    ].join('\n'),
  });
  // What a gate fails on its own account fails the run with the baseline met.
  expect(
    judge(GATE, 'working tree', { findings, failures: SUPPRESSED }, baseline, everything),
  ).toEqual({
    code: 1,
    output: [
      'check:example: working tree against lint-baselines/example.json',
      'FAIL  suppression comments:',
      '  scripts/a.ts:3 — not allowed',
      'check:example: FAIL (2 findings in 1 files, baseline 2, 1 suppression comments)',
      '',
    ].join('\n'),
  });
});

test('--tighten returns the lowered baseline, and fails on what it would have had to raise', () => {
  const baseline = counts(['scripts/a.ts', TYPEOF, 5], ['scripts/fixed.ts', REFLECT, 1]);
  const lowered = [finding('scripts/a.ts', TYPEOF, 4)];

  expect(tighten(GATE, { findings: lowered, failures: NO_FAILURES }, baseline, () => true)).toEqual(
    {
      counts: counts(['scripts/a.ts', TYPEOF, 1]),
      code: 0,
      output: 'check:example: wrote lint-baselines/example.json (2 entries lowered or removed)\n',
    },
  );

  const raised = [...lowered, finding('scripts/new.ts', REFLECT, 7)];

  expect(tighten(GATE, { findings: raised, failures: NO_FAILURES }, baseline, () => true)).toEqual({
    counts: counts(['scripts/a.ts', TYPEOF, 1]),
    code: 1,
    output: [
      'check:example: wrote lint-baselines/example.json (2 entries lowered or removed)',
      'FAIL  findings above the baseline (lint-baselines/example.json):',
      `  scripts/new.ts  ${REFLECT}  allowed 0, found 1`,
      `    scripts/new.ts:7:3 ${REFLECT} — message of ${REFLECT}`,
      '  The baseline is never raised: a finding is fixed by changing the code. Each rule is stated in rules/.',
      'check:example: FAIL (--tighten never raises or adds an entry; 2 findings in 2 files, baseline 1)',
      '',
    ].join('\n'),
  });
  expect(tighten(GATE, { findings: lowered, failures: SUPPRESSED }, baseline, () => true)).toEqual({
    counts: counts(['scripts/a.ts', TYPEOF, 1]),
    code: 1,
    output: [
      'check:example: wrote lint-baselines/example.json (2 entries lowered or removed)',
      'FAIL  suppression comments:',
      '  scripts/a.ts:3 — not allowed',
      'check:example: FAIL (--tighten never raises or adds an entry; 1 findings in 1 files, baseline 1, 1 suppression comments)',
      '',
    ].join('\n'),
  });
});

test("--write-baseline returns every count, and a gate's own failures are never part of it", () => {
  const findings = [finding('scripts/a.ts', TYPEOF, 4), finding('scripts/b.ts', REFLECT, 9)];
  const all = counts(['scripts/a.ts', TYPEOF, 1], ['scripts/b.ts', REFLECT, 1]);

  expect(adopt(GATE, { findings, failures: NO_FAILURES })).toEqual({
    counts: all,
    code: 0,
    output:
      'check:example: wrote lint-baselines/example.json (2 findings in 2 files, baseline 2)\n',
  });
  expect(adopt(GATE, { findings, failures: SUPPRESSED })).toEqual({
    counts: all,
    code: 1,
    output: [
      'check:example: wrote lint-baselines/example.json (2 findings in 2 files, baseline 2, 1 suppression comments)',
      'FAIL  suppression comments:',
      '  scripts/a.ts:3 — not allowed',
      '',
    ].join('\n'),
  });
});

test('the arguments select one mode, and an argument that is no mode is no answer', () => {
  const modes = new Map([
    ['--tighten', 'tighten'],
    ['--write-baseline', 'write-baseline'],
  ]);

  expect(selectMode([], modes, 'check')).toBe('check');
  expect(selectMode(['--tighten'], modes, 'check')).toBe('tighten');
  expect(() => selectMode(['--staged'], modes, 'check')).toThrow(
    'unknown argument --staged; see the header of this script',
  );
});

test('a run over the tree adopts once, checks against the file, and tightens it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lint-ratchet-test-'));
  const baselineFile = path.join(root, GATE.baseline);
  const kept = finding('scripts/a.ts', TYPEOF, 4);
  const two = [kept, finding('scripts/gone.ts', REFLECT, 9)];
  let measured = 0;

  const measure = (findings: readonly Finding[]) => async () => {
    measured += 1;

    return { findings, failures: NO_FAILURES };
  };

  try {
    mkdirSync(path.join(root, 'scripts'));
    writeFileSync(path.join(root, 'scripts/a.ts'), '');

    await expect(runTree(GATE, root, 'check', measure(two))).rejects.toThrow(
      'lint-baselines/example.json is missing; run --write-baseline',
    );
    expect(await runTree(GATE, root, 'write-baseline', measure(two))).toMatchObject({
      code: 0,
      output:
        'check:example: wrote lint-baselines/example.json (2 findings in 2 files, baseline 2)\n',
    });
    expect(readFileSync(baselineFile, 'utf8')).toBe(formatBaseline(foldFindings(two)));
    expect(await runTree(GATE, root, 'check', measure(two))).toEqual({
      code: 0,
      output: [
        'check:example: working tree against lint-baselines/example.json',
        'check:example: pass (2 findings in 2 files, baseline 2)',
        '',
      ].join('\n'),
    });

    // A baseline that exists is not measured over.
    measured = 0;
    expect(await runTree(GATE, root, 'write-baseline', measure([]))).toEqual({
      code: 1,
      output:
        'check:example: refused: lint-baselines/example.json: a baseline exists; lower it with --tighten. Re-adoption means deleting the file first\n',
    });
    expect(measured).toBe(0);

    // An entry with no finding left is loose while its file is on disk and gone once it is not.
    expect((await runTree(GATE, root, 'check', measure([]))).output).toBe(
      [
        'check:example: working tree against lint-baselines/example.json',
        'FAIL  baseline above the code; run `bun run check:example --tighten`:',
        `  loose  scripts/a.ts  ${TYPEOF}  allowed 1, found 0`,
        `  gone   scripts/gone.ts  ${REFLECT}  allowed 1, found 0`,
        'check:example: FAIL (0 findings in 0 files, baseline 2)',
        '',
      ].join('\n'),
    );
    expect(await runTree(GATE, root, 'tighten', measure([kept]))).toMatchObject({
      code: 0,
      output: 'check:example: wrote lint-baselines/example.json (1 entries lowered or removed)\n',
    });
    expect(readFileSync(baselineFile, 'utf8')).toBe(`{
  "scripts/a.ts": {
    "${TYPEOF}": 1
  }
}
`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
