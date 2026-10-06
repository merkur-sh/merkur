import { expect, test } from 'bun:test';

import { slopMessage } from './stop';

test('the anti-slop sweep is silent on a pass and speaks on findings and no answer', () => {
  const pass =
    'check:slop: working tree against lint-baselines/anti-slop.json\ncheck:slop: pass (3 findings in 2 files, baseline 3)\n';

  expect(slopMessage({ exitCode: 0, signalCode: null, stdout: pass })).toBeNull();

  const fail =
    'check:slop: working tree against lint-baselines/anti-slop.json\nFAIL  findings above the baseline (lint-baselines/anti-slop.json):\n  scripts/x.ts  no-runtime-typeof  allowed 0, found 1\ncheck:slop: FAIL (4 findings in 2 files, baseline 3)\n';

  const failed = slopMessage({ exitCode: 1, signalCode: null, stdout: fail }) ?? '';

  expect(failed).toContain('scripts/x.ts  no-runtime-typeof  allowed 0, found 1');
  expect(failed).toContain('enforced on the staged files at commit');
  expect(slopMessage({ exitCode: 143, signalCode: 'SIGTERM', stdout: '' })).toContain(
    'unverified: stopped by SIGTERM after 50 s',
  );
  expect(slopMessage({ exitCode: 1, signalCode: null, stdout: '' })).toContain(
    'unverified: exited 1 without output',
  );
});
