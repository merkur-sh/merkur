import { expect, test } from 'bun:test';

import { composeSessionStartContext, GENERATED_ARTIFACTS, isWorktree } from './session-start';

test('a worktree is detected by path or by a foreign git common dir', () => {
  expect(isWorktree('/Users/u/repo/.claude/worktrees/probe', '.git')).toBe(true);
  expect(isWorktree('/Users/u/repo', '/Users/u/repo/.git\n')).toBe(true);
  expect(isWorktree('/Users/u/repo', '.git\n')).toBe(false);
  expect(isWorktree('/Users/u/repo', null)).toBe(false);
});

test('a ready primary checkout says nothing at all', () => {
  const context = composeSessionStartContext({
    root: '/repo',
    worktree: false,
    indexPresent: true,
    indexBuilt: false,
    missing: [],
  });
  // No standing verification nudge: the Stop hook reports the diff's real gate state, and a
  // permanent reminder to verify is what drove the re-verification loop.
  expect(context).toBe('');
  expect(context).not.toContain('gates');
});

test('a worktree names the shell form and reports a built index', () => {
  const context = composeSessionStartContext({
    root: '/repo/.claude/worktrees/probe',
    worktree: true,
    indexPresent: true,
    indexBuilt: true,
    missing: [],
  });
  expect(context).toContain('shell form `codegraph explore');
  expect(context).toContain('bound to the primary checkout');
  expect(context).toContain('has been built');
});

test('a missing index in the primary checkout is a request to build it', () => {
  const context = composeSessionStartContext({
    root: '/repo',
    worktree: false,
    indexPresent: false,
    indexBuilt: false,
    missing: [],
  });
  expect(context).toContain('run `codegraph init .`');
  expect(context).toContain('denied either way');
});

test('missing artifacts are listed with their build command', () => {
  const context = composeSessionStartContext({
    root: '/repo',
    worktree: false,
    indexPresent: true,
    indexBuilt: false,
    missing: GENERATED_ARTIFACTS,
  });
  expect(context).toContain('packages/term-wasm/pkg  →  bun run build:wasm');
  expect(context).toContain('apps/web/src/term-wasm/pkg  →  bun run sync:wasm');
  expect(context).toContain('packages/e2e-wasm/pkg  →  bun run build:e2e-wasm');
  expect(context).toContain('setup never builds it');
  expect(context).toContain('apps/server/.env  →  bun run setup');
  expect(context.endsWith('apps/server/.env  →  bun run setup')).toBe(true);
});
