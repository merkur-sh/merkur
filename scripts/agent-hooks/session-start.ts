import { existsSync } from 'node:fs';
import path from 'node:path';

import { findRepoRoot, hasCodegraphIndex, readHookInput, runHook, writeStdout } from './hook-io';

/**
 * SessionStart entry: the facts a fresh session needs before its first tool call and
 * cannot cheaply discover — whether it is in a worktree (the MCP server answers for the
 * primary checkout there), whether the CodeGraph index exists, and which generated
 * artifacts are missing along with the one command that builds each.
 *
 * In a worktree without an index the hook builds it here (about a second) rather than
 * telling the agent to; every lookup after that is the shell form.
 */

export interface GeneratedArtifact {
  readonly path: string;
  readonly command: string;
}

export const GENERATED_ARTIFACTS: readonly GeneratedArtifact[] = [
  { path: 'packages/term-wasm/pkg', command: 'bun run build:wasm' },
  { path: 'apps/web/src/term-wasm/pkg', command: 'bun run sync:wasm' },
  {
    path: 'packages/e2e-wasm/pkg',
    command: 'bun run build:e2e-wasm   (bun run setup never builds it)',
  },
  { path: 'apps/server/.env', command: 'bun run setup' },
];

export interface SessionStartState {
  readonly root: string;
  readonly worktree: boolean;
  readonly indexPresent: boolean;
  /** The index was absent and this hook just built it. */
  readonly indexBuilt: boolean;
  readonly missing: readonly GeneratedArtifact[];
}

export function isWorktree(cwd: string, gitCommonDir: string | null): boolean {
  if (cwd.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) return true;
  if (gitCommonDir === null) return false;
  const trimmed = gitCommonDir.trim();
  return trimmed !== '' && trimmed !== '.git';
}

export function composeSessionStartContext(state: SessionStartState): string {
  const lines: string[] = [];
  if (state.worktree) {
    lines.push(
      `Worktree checkout at ${state.root}: use the shell form \`codegraph explore "<query>"\` for code lookups — the CodeGraph MCP server is bound to the primary checkout and would answer for the wrong tree.`,
    );
  }
  if (state.indexBuilt) {
    lines.push('CodeGraph index was missing and has been built (`codegraph init .`).');
  } else if (!state.indexPresent) {
    lines.push(
      'CodeGraph index missing: run `codegraph init .` (about a second) before the first code lookup; grep over source is denied either way.',
    );
  }
  if (state.missing.length > 0) {
    lines.push('Missing generated artifacts (build before anything executes them):');
    for (const artifact of state.missing) {
      lines.push(`  ${artifact.path}  →  ${artifact.command}`);
    }
  }
  // No standing "remember to verify" line: it fired whether or not the session touched code,
  // and a permanent nudge toward verification is what produced the re-verification loop. The
  // Stop hook reports the diff's actual gate state instead, from the result cache.
  return lines.join('\n');
}

function gitCommonDirOf(root: string): string | null {
  const result = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5_000,
  });
  return result.success ? result.stdout.toString() : null;
}

function buildIndex(root: string): boolean {
  const result = Bun.spawnSync(['codegraph', 'init', '.'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 120_000,
  });
  return result.success && hasCodegraphIndex(root);
}

if (import.meta.main) {
  await runHook(async () => {
    const input = await readHookInput();
    if (input === null) return 0;
    const root = findRepoRoot(input.cwd);
    if (root === null) return 0;
    const worktree = isWorktree(root, gitCommonDirOf(root));
    let indexPresent = hasCodegraphIndex(root);
    let indexBuilt = false;
    if (!indexPresent && worktree) {
      indexBuilt = buildIndex(root);
      indexPresent = indexBuilt;
    }
    const missing = GENERATED_ARTIFACTS.filter(
      (artifact) => !existsSync(path.join(root, artifact.path)),
    );
    writeStdout(composeSessionStartContext({ root, worktree, indexPresent, indexBuilt, missing }));
    return 0;
  });
}
