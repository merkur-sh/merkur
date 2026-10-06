import { expect, test } from 'bun:test';

import type { HookInput } from './hook-io';
import {
  docDriftMessage,
  ratchetMessage,
  shouldRunDocDrift,
  spokeAlready,
  verificationMessage,
} from './stop';

function stop(raw: Record<string, unknown>): HookInput {
  return { sessionId: 's', cwd: '/repo', hookEventName: 'Stop', toolName: '', toolInput: {}, raw };
}

test('the sweep runs once per stop and only when the script exists', () => {
  expect(shouldRunDocDrift(stop({}), true)).toBe(true);
  expect(shouldRunDocDrift(stop({ stop_hook_active: false }), true)).toBe(true);
  expect(shouldRunDocDrift(stop({ stop_hook_active: true }), true)).toBe(false);
  expect(shouldRunDocDrift(stop({}), false)).toBe(false);
});

test('empty output is no message; findings are labelled and bounded', () => {
  expect(docDriftMessage('')).toBeNull();
  expect(docDriftMessage('  \n')).toBeNull();
  const message = docDriftMessage('docs/x.md:3 fooBar (removed in apps/a.ts)\n');
  expect(message).toBe(
    'Doc drift (scripts/doc-drift.ts --since HEAD):\ndocs/x.md:3 fooBar (removed in apps/a.ts)',
  );
  const long = Array.from({ length: 300 }, (_, index) => `docs/x.md:${index} token${index}`).join(
    '\n',
  );
  const bounded = docDriftMessage(long) ?? '';
  expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(4096 + 60);
});

test('the verification report is the plan without its per-file reasons', () => {
  const plan = [
    '# 2 changed files',
    '# static (always)',
    'bun run check:types',
    '# bun lane (may overlap cargo): 1 of 12 test files; 11 already green for these inputs',
    'bun test --parallel=4 ./apps/web/src/view.test.ts',
    '# selection reasons',
    '# apps/web/src/view.ts → web',
  ].join('\n');
  const message = verificationMessage(plan);
  expect(message).toContain('11 already green for these inputs');
  expect(message).toContain('bun run check:types');
  expect(message).toContain('bun run gates --run');
  expect(message).not.toContain('selection reasons');
  expect(message).not.toContain('→ web');
});

test('a clean tree and an unreadable plan both stay silent', () => {
  expect(verificationMessage('no gate: nothing changed\n')).toBeNull();
  expect(verificationMessage('')).toBeNull();
  expect(verificationMessage('   \n  ')).toBeNull();
  expect(verificationMessage('# selection reasons\n# a → b')).toBeNull();
});

test('the ratchet is silent on a clean pass and speaks on notes, failures and no answer', () => {
  const pass =
    'check:ratchet: working tree against abc\ncheck:ratchet: pass (108 hotspots checked)\n';
  expect(ratchetMessage({ exitCode: 0, signalCode: null, stdout: pass })).toBeNull();

  const notes = `check:ratchet: working tree against abc\nNOTE  renamed-identifier clones introduced (review; not a gate):\n  clone (6 lines): a.ts:1-6, b.ts:1-6\ncheck:ratchet: pass (1 hotspots checked)\n`;
  expect(ratchetMessage({ exitCode: 0, signalCode: null, stdout: notes })).toContain(
    'clone (6 lines): a.ts:1-6, b.ts:1-6',
  );

  const fail =
    'check:ratchet: working tree against abc\nFAIL  introduced by this change (fallow audit):\n  unused_files: x.ts\ncheck:ratchet: FAIL (1 hotspots checked)\n';
  const failed = ratchetMessage({ exitCode: 1, signalCode: null, stdout: fail }) ?? '';
  expect(failed).toContain('unused_files: x.ts');
  expect(failed).toContain('enforced on the staged diff at commit');

  expect(ratchetMessage({ exitCode: 143, signalCode: 'SIGTERM', stdout: '' })).toContain(
    'unverified: stopped by SIGTERM after 20 s',
  );
  expect(ratchetMessage({ exitCode: 1, signalCode: null, stdout: '' })).toContain(
    'unverified: exited 1 without output',
  );
});

test('a stop this hook already answered stays silent on both sweeps', () => {
  expect(spokeAlready(stop({ stop_hook_active: true }))).toBe(true);
  expect(spokeAlready(stop({}))).toBe(false);
});
