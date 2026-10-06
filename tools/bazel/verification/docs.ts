import { type GitContext, validGitContext } from './git-context';
import { manifestFromInventory, validSourceManifest } from './snapshot';

/** Validate aliases already reconstructed from the complete immutable captured tree. */
export function validateCapturedDocsAliases(
  root: string,
  context: GitContext,
  aliases: unknown,
): void {
  if (!validGitContext(context))
    throw new Error('Complete captured documentation Git facts are required');
  const inventory = context.index
    .filter((entry) => entry.mode === '120000')
    .map((entry) => entry.path);
  if (
    !validSourceManifest(aliases) ||
    aliases.commit !== context.head ||
    JSON.stringify(aliases.inputs.map((input) => input.path)) !== JSON.stringify(inventory) ||
    manifestFromInventory(root, inventory, context.head).digest !== aliases.digest
  )
    throw new Error('Complete captured documentation Git and alias facts are required');
}
