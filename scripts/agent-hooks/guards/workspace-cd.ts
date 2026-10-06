import path from 'node:path';

import type { GuardContext, GuardDecision } from '../hook-io';
import type { SimpleCommand } from '../shell-command';

/**
 * "Run every script from the repo root", mechanised.
 *
 * `cd apps/web && bunx <tool>` resolves the workspace package rather than the root, and has
 * previously upgraded `solid-js` to a release candidate and codemodded `vite.config.ts` as a
 * side effect. The same applies to every `bun` subcommand that touches `package.json` or the
 * lockfile. `bun test`, `bun run` and `bun <file>` inside a package are harmless and stay
 * allowed; the replacements for the denied forms are spelled out in the reason.
 */

const PACKAGE_MANAGER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'x',
  'add',
  'install',
  'i',
  'update',
  'remove',
  'rm',
  'link',
  'unlink',
  'pm',
  'outdated',
  'patch',
]);

const WORKSPACE_PACKAGE = /^(apps|packages)\/[^/]+/;

/** The `apps/<name>` or `packages/<name>` prefix of a cwd inside a workspace package. */
export function workspacePackageOf(cwd: string, root: string): string | null {
  const relative = path.relative(root, path.resolve(cwd));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const match = WORKSPACE_PACKAGE.exec(relative.split(path.sep).join('/'));
  return match === null ? null : match[0];
}

function deniedForm(argv: readonly string[]): string | null {
  const tool = path.basename(argv[0] ?? '');
  if (tool === 'bunx') return 'bunx';
  if (tool !== 'bun') return null;
  const sub = argv[1] ?? '';
  return PACKAGE_MANAGER_SUBCOMMANDS.has(sub) ? `bun ${sub}` : null;
}

export function evaluateWorkspaceCd(
  command: SimpleCommand,
  ctx: GuardContext,
): GuardDecision | null {
  if (command.hasHelp) return null;
  const form = deniedForm(command.argv);
  if (form === null) return null;
  const pkg = workspacePackageOf(command.cwd, ctx.root);
  if (pkg === null) return null;
  const tool = command.argv[form === 'bunx' ? 1 : 2] ?? '<tool>';
  return {
    kind: 'deny',
    reason: [
      `Denied: \`${form}\` with cwd inside \`${pkg}\` — inside a workspace package it resolves the package instead of the root and has upgraded dependencies and codemodded configs before.`,
      'Run from the repository root instead:',
      `  bun run --cwd ${pkg} <script>        # a package-local script`,
      `  bun add <dependency> --cwd ${pkg}     # a package-local dependency`,
      `  bunx ${tool} ${pkg}/…                 # a tool that takes the directory as an argument`,
    ].join('\n'),
  };
}
