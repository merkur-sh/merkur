import { expect, test } from 'bun:test';

import type { GuardContext, HookInput } from '../hook-io';
import { evaluateAuthoredProse, isAuthoredProse } from './authored-prose';

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

function edit(toolName: string, filePath: string): HookInput {
  return {
    sessionId: 's',
    cwd: ROOT,
    hookEventName: 'PreToolUse',
    toolName,
    toolInput: { file_path: filePath },
    raw: {},
  };
}

test('the blog’s MDX is prose from any spelling of its path', () => {
  expect(isAuthoredProse('apps/site/blog/index.mdx', context())).toBe(true);
  expect(isAuthoredProse('/repo/apps/site/blog/authorship.mdx', context())).toBe(true);
  expect(
    isAuthoredProse('blog/posts/shipping-screens/post.mdx', context({ cwd: '/repo/apps/site' })),
  ).toBe(true);
});

test('a post’s code, the harness’s pages and everything else are not', () => {
  expect(isAuthoredProse('apps/site/blog/posts/a/figures/rows.tsx', context())).toBe(false);
  expect(isAuthoredProse('apps/site/blog/posts/a/cover.tsx', context())).toBe(false);
  expect(isAuthoredProse('apps/site/fixtures/blog/index.mdx', context())).toBe(false);
  expect(isAuthoredProse('apps/site/blogs/index.mdx', context())).toBe(false);
  expect(isAuthoredProse('/elsewhere/apps/site/blog/index.mdx', context())).toBe(false);
});

test('writing the blog’s prose is denied, with or without an approved plan', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    for (const planApproved of [false, true]) {
      const decision = evaluateAuthoredProse(
        edit(tool, 'apps/site/blog/posts/a/post.mdx'),
        context({ planApproved }),
      );
      expect(decision?.kind).toBe('deny');
      expect(decision?.reason).toContain('every word is written by a person');
    }
  }
});

test('reading it, and editing anything else, passes', () => {
  expect(evaluateAuthoredProse(edit('Read', 'apps/site/blog/index.mdx'), context())).toBeNull();
  expect(
    evaluateAuthoredProse(edit('Edit', 'apps/site/blog/posts/a/figures/rows.tsx'), context()),
  ).toBeNull();
  expect(evaluateAuthoredProse(edit('Edit', 'apps/site/src/blog/page.ts'), context())).toBeNull();
});
