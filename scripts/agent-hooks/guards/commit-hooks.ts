import path from 'node:path';

import type { GuardDecision } from '../hook-io';
import type { SimpleCommand } from '../shell-command';

/**
 * `git commit --no-verify` (or `-n`) skips `.githooks/pre-commit`, the one place every commit
 * meets the secret scan and the ratchet (`scripts/check-ratchet.ts --staged`). Commits go
 * straight to main, so there is no later stage that would catch what the hook would have.
 */

/** Git global options that take their value as the next word. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

/** `git commit` short options whose value follows, either attached or as the next word. */
const COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);

function commitArguments(argv: readonly string[]): readonly string[] | null {
  if (path.basename(argv[0] ?? '') !== 'git') return null;
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? '';
    if (GLOBAL_OPTIONS_WITH_VALUE.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word === 'commit' ? argv.slice(index + 1) : null;
  }
  return null;
}

/** Whether the arguments of a `git commit` ask to skip its hooks. */
export function skipsCommitHooks(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? '';
    if (word === '--') return false;
    if (word === '--no-verify') return true;
    if (!word.startsWith('-') || word.startsWith('--')) continue;
    for (let position = 1; position < word.length; position += 1) {
      const flag = word[position] ?? '';
      if (flag === 'n') return true;
      if (COMMIT_SHORT_OPTIONS_WITH_VALUE.has(flag)) {
        if (position === word.length - 1) index += 1;
        break;
      }
    }
  }
  return false;
}

export function evaluateCommitHooks(command: SimpleCommand): GuardDecision | null {
  const args = commitArguments(command.argv);
  if (args === null || !skipsCommitHooks(args)) return null;
  return {
    kind: 'deny',
    reason:
      'Denied: `git commit --no-verify` skips `.githooks/pre-commit`: the secret scan, the ratchet (`bun run check:ratchet --staged`) and the anti-slop baseline (`bun run check:slop --staged`). Fix what the hook reports and commit without `--no-verify`/`-n`.',
  };
}
