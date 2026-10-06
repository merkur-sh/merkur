import { expect, test } from 'bun:test';

import type { HookInput } from './hook-io';
import {
  biomeFindings,
  editedFilesOf,
  emissionFor,
  lintableFiles,
  parseApplyPatchPaths,
} from './post-tool-use';

function input(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return {
    sessionId: 's',
    cwd: '/repo',
    hookEventName: 'PostToolUse',
    toolName,
    toolInput,
    raw: {},
  };
}

const PATCH = [
  '*** Begin Patch',
  '*** Update File: apps/web/src/a.ts',
  '@@',
  '-old',
  '+new',
  '*** Add File: packages/shared/src/b.ts',
  '+export const b = 1;',
  '*** Delete File: apps/web/src/gone.ts',
  '*** Update File: docs/x.md',
  '*** Move to: docs/y.md',
  '*** End Patch',
].join('\n');

test('apply_patch paths are parsed from Update, Add and Move headers', () => {
  expect(parseApplyPatchPaths(PATCH)).toEqual([
    'apps/web/src/a.ts',
    'packages/shared/src/b.ts',
    'docs/x.md',
    'docs/y.md',
  ]);
  expect(parseApplyPatchPaths('')).toEqual([]);
});

test('edited files come from file_path for Claude and the patch text for Codex', () => {
  expect(editedFilesOf(input('Edit', { file_path: '/repo/a.ts' }))).toEqual(['/repo/a.ts']);
  expect(editedFilesOf(input('Write', { file_path: '/repo/b.tsx' }))).toEqual(['/repo/b.tsx']);
  expect(editedFilesOf(input('MultiEdit', { file_path: '/repo/c.ts', edits: [] }))).toEqual([
    '/repo/c.ts',
  ]);
  expect(editedFilesOf(input('apply_patch', { command: PATCH }))).toHaveLength(4);
  expect(editedFilesOf(input('apply_patch', { patch: PATCH }))).toHaveLength(4);
  expect(editedFilesOf(input('apply_patch', { input: PATCH }))).toHaveLength(4);
  expect(editedFilesOf(input('apply_patch', { command: ['apply_patch', PATCH] }))).toHaveLength(4);
  expect(editedFilesOf(input('Bash', { command: 'ls' }))).toEqual([]);
  expect(editedFilesOf(input('Edit', {}))).toEqual([]);
});

test('only existing TypeScript/JavaScript files are linted, resolved against the cwd', () => {
  const exists = (candidate: string) => !candidate.endsWith('missing.ts');
  expect(
    lintableFiles(
      [
        'a.ts',
        '/abs/b.tsx',
        'c.js',
        'd.jsx',
        'e.mjs',
        'f.cjs',
        'g.md',
        'h.rs',
        'missing.ts',
        'a.ts',
      ],
      '/repo',
      exists,
    ),
  ).toEqual([
    '/repo/a.ts',
    '/abs/b.tsx',
    '/repo/c.js',
    '/repo/d.jsx',
    '/repo/e.mjs',
    '/repo/f.cjs',
  ]);
});

test('findings go to Claude as JSON on stdout and to Codex as stderr with exit 2', () => {
  const claude = emissionFor('claude', 'Found 1 error.\n');
  expect(claude.exitCode).toBe(0);
  expect(claude.stderr).toBeNull();
  expect(JSON.parse(claude.stdout ?? '')).toEqual({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Found 1 error.' },
    systemMessage: 'Found 1 error.',
  });
  const codex = emissionFor('codex', 'Found 1 error.\n');
  expect(codex.exitCode).toBe(2);
  expect(codex.stdout).toBeNull();
  expect(codex.stderr).toBe('Found 1 error.');
});

test('findings are bounded at 4 KB', () => {
  const long = Array.from({ length: 500 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join(
    '\n',
  );
  const emission = emissionFor('codex', long);
  expect(Buffer.byteLength(emission.stderr ?? '', 'utf8')).toBeLessThanOrEqual(4096);
  expect(emission.stderr?.endsWith('x')).toBe(true);
});

test('what Biome already fixed is reported as done, with the cue to re-read', () => {
  const fixed = biomeFindings('', ['apps/web/src/view.ts']);
  expect(fixed).toContain('fixed apps/web/src/view.ts in place');
  expect(fixed).toContain('Re-read before your next edit');
  // Formatting it fixed itself is not a finding: nothing is left for the agent to do.
  expect(fixed).not.toContain('could not fix');
});

test('what Biome could not fix safely is handed back, never as a gate to run', () => {
  const findings = biomeFindings('  view.ts:1:1 lint/suspicious/noConsole  \n');
  expect(findings).toContain('could not fix these safely');
  expect(findings).toContain('not a verification gate');
  expect(findings).toContain('noConsole');
  expect(findings).not.toContain('fixed ');
});

test('a fixed file and a remaining finding are both reported, fix first', () => {
  const both = biomeFindings('view.ts:1:1 lint/suspicious/noConsole', ['apps/web/src/view.ts']);
  expect(both?.indexOf('fixed apps/web/src/view.ts')).toBeLessThan(
    both?.indexOf('could not fix') ?? 0,
  );
});

test('a clean edit that needed no rewrite says nothing at all', () => {
  expect(biomeFindings('   ')).toBeNull();
  expect(biomeFindings('', [])).toBeNull();
});
