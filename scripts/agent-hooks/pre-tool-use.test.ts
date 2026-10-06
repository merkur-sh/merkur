import { expect, test } from 'bun:test';

import type { GuardContext, HookInput } from './hook-io';
import { decidePreToolUse } from './pre-tool-use';

const ROOT = '/repo';

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    root: ROOT,
    cwd: ROOT,
    home: '/home/agent',
    indexPresent: true,
    planApproved: false,
    ...overrides,
  };
}

function bash(command: string): HookInput {
  return {
    sessionId: 's',
    cwd: ROOT,
    hookEventName: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { command },
    raw: {},
  };
}

test('the guards run in order and the first decision wins', () => {
  // cargo-static fires before source-grep on a line that trips both.
  const both = decidePreToolUse(
    bash('bun run rust:check && bun run rust:lint && grep -rn foo apps'),
    context(),
  );
  expect(both?.kind).toBe('deny');
  if (both?.kind !== 'deny') return;
  expect(both.reason).toContain('rust:lint');

  // workspace-cd fires before source-grep.
  const cd = decidePreToolUse(bash('cd apps/web && bunx x && grep -r foo src'), context());
  expect(cd?.kind).toBe('deny');
  if (cd?.kind !== 'deny') return;
  expect(cd.reason).toContain('bun run --cwd apps/web');
});

test('a CodeGraph lookup other than explore is denied; explore is not', () => {
  const node = decidePreToolUse(bash('codegraph node --file apps/web/src/App.tsx'), context());
  expect(node?.kind).toBe('deny');
  if (node?.kind !== 'deny') return;
  expect(node.reason).toContain('codegraph explore "<file path>"');
  expect(decidePreToolUse(bash('codegraph explore "apps/web/src/App.tsx"'), context())).toBeNull();
});

test('a backgrounded cargo pair is denied; a lone cargo line is not', () => {
  expect(decidePreToolUse(bash('cargo test -p a & cargo test -p b'), context())?.kind).toBe('deny');
  expect(decidePreToolUse(bash('cargo test -p merkur-edge'), context())).toBeNull();
});

test('an ordinary line produces nothing', () => {
  expect(decidePreToolUse(bash('git status'), context())).toBeNull();
  expect(decidePreToolUse(bash('grep foo docs/transport.md'), context())).toBeNull();
  expect(decidePreToolUse(bash(''), context())).toBeNull();
});

test('the Grep tool is guarded; other tools are not', () => {
  const grep: HookInput = {
    ...bash(''),
    toolName: 'Grep',
    toolInput: { pattern: 'x', path: 'apps' },
  };
  expect(decidePreToolUse(grep, context())?.kind).toBe('deny');
  const read: HookInput = {
    ...bash(''),
    toolName: 'Read',
    toolInput: { file_path: '/repo/apps/x.ts' },
  };
  expect(decidePreToolUse(read, context())).toBeNull();
});

test('edit tools are gated by plan approval under the trust-boundary trees only', () => {
  const gated: HookInput = {
    ...bash(''),
    toolName: 'Edit',
    toolInput: { file_path: '/repo/packages/auth/src/tokens.ts' },
  };
  expect(decidePreToolUse(gated, context())?.kind).toBe('deny');
  expect(decidePreToolUse(gated, context({ planApproved: true }))).toBeNull();
  const open: HookInput = { ...gated, toolInput: { file_path: '/repo/apps/web/src/App.tsx' } };
  expect(decidePreToolUse(open, context())).toBeNull();
});

test('a Codex-style array command is joined', () => {
  const input: HookInput = { ...bash(''), toolInput: { command: ['grep', '-rn', 'foo', 'apps'] } };
  expect(decidePreToolUse(input, context())?.kind).toBe('deny');
});
