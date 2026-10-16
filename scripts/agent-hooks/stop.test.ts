import { expect, test } from 'bun:test';

import type { HookInput } from './hook-io';
import { docDriftMessage, spokeAlready, verificationMessage } from './stop';

function stop(raw: Record<string, unknown>): HookInput {
  return { sessionId: 's', cwd: '/repo', hookEventName: 'Stop', toolName: '', toolInput: {}, raw };
}

test('doc drift speaks only on findings, labelled and bounded', () => {
  expect(docDriftMessage(0, 'doc-drift: 0 removed/changed identifier(s) since HEAD\n')).toBeNull();
  expect(docDriftMessage(1, '  \n')).toBeNull();
  expect(docDriftMessage(2, 'fatal: bad revision\n')).toBeNull();
  const message = docDriftMessage(1, 'docs/x.md:3 fooBar (removed in apps/a.ts)\n');
  expect(message).toBe(
    'Doc drift (scripts/doc-drift.ts --since HEAD):\ndocs/x.md:3 fooBar (removed in apps/a.ts)',
  );
  const long = Array.from({ length: 300 }, (_, index) => `docs/x.md:${index} token${index}`).join(
    '\n',
  );
  const bounded = docDriftMessage(1, long) ?? '';
  expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(4096 + 60);
});

test('the verification report is the plan without its per-file reasons, handed to CI', () => {
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
  expect(message).toContain('CI runs this plan after the push');
  expect(message).not.toContain('gates --run');
  expect(message).not.toContain('selection reasons');
  expect(message).not.toContain('→ web');
});

test('a clean tree and an unreadable plan both stay silent', () => {
  expect(verificationMessage('no gate: nothing changed\n')).toBeNull();
  expect(verificationMessage('')).toBeNull();
  expect(verificationMessage('   \n  ')).toBeNull();
  expect(verificationMessage('# selection reasons\n# a → b')).toBeNull();
});

test('a stop this hook already answered stays silent', () => {
  expect(spokeAlready(stop({ stop_hook_active: true }))).toBe(true);
  expect(spokeAlready(stop({}))).toBe(false);
});
