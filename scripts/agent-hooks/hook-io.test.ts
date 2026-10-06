import { expect, test } from 'bun:test';

import {
  denyOutput,
  detectHarness,
  findRepoRoot,
  hasCodegraphIndex,
  parseHookInput,
  postToolUseFindingsOutput,
  truncateOnLine,
} from './hook-io';

test('a hook payload is parsed into the shared shape', () => {
  const input = parseHookInput(
    JSON.stringify({
      session_id: 'abc',
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      extra: 1,
    }),
  );
  expect(input).not.toBeNull();
  expect(input?.sessionId).toBe('abc');
  expect(input?.cwd).toBe('/repo');
  expect(input?.hookEventName).toBe('PreToolUse');
  expect(input?.toolName).toBe('Bash');
  expect(input?.toolInput).toEqual({ command: 'ls' });
  expect(input?.raw.extra).toBe(1);
});

test('garbage and non-object payloads parse to null; missing fields default', () => {
  expect(parseHookInput('not json')).toBeNull();
  expect(parseHookInput('[]')).toBeNull();
  expect(parseHookInput('"x"')).toBeNull();
  const sparse = parseHookInput('{}');
  expect(sparse?.sessionId).toBe('');
  expect(sparse?.toolName).toBe('');
  expect(sparse?.toolInput).toEqual({});
  expect(sparse?.cwd).not.toBe('');
});

test('the repo root is the nearest ancestor with .codegraph', () => {
  const exists = (candidate: string) => candidate === '/home/u/repo/.codegraph';
  expect(findRepoRoot('/home/u/repo/apps/web/src', exists)).toBe('/home/u/repo');
  expect(findRepoRoot('/home/u/repo', exists)).toBe('/home/u/repo');
  expect(findRepoRoot('/home/u/other', exists)).toBeNull();
  expect(hasCodegraphIndex('/r', (candidate) => candidate === '/r/.codegraph/codegraph.db')).toBe(
    true,
  );
  expect(hasCodegraphIndex('/r', () => false)).toBe(false);
});

test('the harness is Claude iff CLAUDE_PROJECT_DIR is set', () => {
  expect(detectHarness({ CLAUDE_PROJECT_DIR: '/repo' })).toBe('claude');
  expect(detectHarness({ CLAUDE_PROJECT_DIR: '' })).toBe('codex');
  expect(detectHarness({})).toBe('codex');
});

test('decision payloads carry the documented shapes', () => {
  expect(JSON.parse(denyOutput('why'))).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'why',
    },
  });
  expect(JSON.parse(postToolUseFindingsOutput('f'))).toEqual({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'f' },
    systemMessage: 'f',
  });
});

test('truncation cuts on a line boundary inside the byte budget', () => {
  expect(truncateOnLine('short', 100)).toBe('short');
  const text = 'line one\nline two\nline three';
  expect(truncateOnLine(text, 20)).toBe('line one\nline two');
  expect(truncateOnLine(text, 9)).toBe('line one');
  expect(truncateOnLine('nonewline'.repeat(4), 10)).toBe('nonewlinen');
  expect(Buffer.byteLength(truncateOnLine('é'.repeat(50), 7), 'utf8')).toBeLessThanOrEqual(7);
});
