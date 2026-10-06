import path from 'node:path';

import type { GuardContext, GuardDecision, HookInput } from '../hook-io';

/**
 * The blog's authorship policy, mechanised.
 *
 * merkur.sh tells its readers that every word of the blog is written by a person. The words
 * are the MDX under `apps/site/blog`: posts, the index's introduction and the policy itself.
 * An `Edit`, `Write` or `MultiEdit` there is denied, always: no plan, flag or session state
 * unlocks it, because the promise is to the reader and only the author can keep it. The code
 * beside a post (its figures, its cover) is not prose and is not gated, and neither are the
 * harness's own pages under `apps/site/fixtures/blog`.
 */

const AUTHORED_TREE = 'apps/site/blog';
const PROSE_EXTENSION = '.mdx';
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit']);

/** Whether a file is prose of the blog's, from any spelling of its path. */
export function isAuthoredProse(file: string, ctx: GuardContext): boolean {
  const relative = path.relative(ctx.root, path.resolve(ctx.cwd, file)).split(path.sep).join('/');
  return relative.startsWith(`${AUTHORED_TREE}/`) && relative.endsWith(PROSE_EXTENSION);
}

export function evaluateAuthoredProse(input: HookInput, ctx: GuardContext): GuardDecision | null {
  if (!EDIT_TOOLS.has(input.toolName)) return null;
  const filePath = input.toolInput.file_path;
  if (typeof filePath !== 'string' || !isAuthoredProse(filePath, ctx)) return null;
  return {
    kind: 'deny',
    reason: [
      `Denied: \`${filePath}\` is prose of the blog's, and the blog promises its readers that every word is written by a person.`,
      'Do not write, rewrite, correct or translate it. Say what you would change and let the author change it.',
      `A post's figures and cover (\`${AUTHORED_TREE}/posts/<slug>/figures/*.tsx\`, \`cover.tsx\`) are code and are yours to edit.`,
    ].join('\n'),
  };
}
