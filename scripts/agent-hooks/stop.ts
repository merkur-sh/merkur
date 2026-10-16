import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  findRepoRoot,
  type HookInput,
  readHookInput,
  runHook,
  systemMessageOutput,
  truncateOnLine,
  writeStdout,
} from './hook-io';
import { editedFiles, uncommittedEdits } from './session-edits';

/**
 * Stop entry: what this session's uncommitted files still owe, read without running a gate.
 *
 * Sessions share the checkout, so the working tree's diff is everyone's. The hook speaks only
 * about the files this session edited (`session-edits.ts`) that still differ from `HEAD`; a
 * session that edited nothing, or has committed what it edited, gets silence.
 *
 * Two sections, each silent when it has nothing to say:
 *
 * - The gate plan for those files (`bun run gates --files …`, print-only): which suites own
 *   them and which of their test files are already green for exactly these bytes. CI runs the
 *   plan after the push; locally the agent runs only the narrowest proof (AGENTS.md
 *   Verification), and the pre-commit hook holds the staged files to the ratchet and the
 *   anti-slop baseline, so neither runs here.
 * - `scripts/doc-drift.ts --since HEAD --files …`: prose still naming identifiers, paths, script
 *   names and literal values those files removed or changed, the review the agent skips most.
 *
 * Findings go out as a `systemMessage`, visible to the user, never blocking.
 * `stop_hook_active` means this hook already spoke once for this stop; saying it twice would
 * loop.
 */

export const DOC_DRIFT_SCRIPT = path.join('scripts', 'doc-drift.ts');
const DOC_DRIFT_TIMEOUT_MS = 20_000;
const GATES_TIMEOUT_MS = 20_000;
const MESSAGE_BUDGET_BYTES = 4096;

/** This hook already spoke once for this stop; a second message would loop. */
export function spokeAlready(input: HookInput): boolean {
  return input.raw.stop_hook_active === true;
}

/**
 * The gate plan, minus its per-file selection reasons — those run to hundreds of lines and
 * the commands are the part that answers the question.
 */
export function verificationMessage(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed === '' || trimmed.startsWith('no gate:')) return null;
  const lines = trimmed.split('\n');
  const reasons = lines.indexOf('# selection reasons');
  const plan = (reasons === -1 ? lines : lines.slice(0, reasons)).join('\n').trim();
  if (plan === '') return null;
  return [
    'Gate plan for the files this session edited (`bun run gates --files …`, nothing was run):',
    truncateOnLine(plan, MESSAGE_BUDGET_BYTES),
    'CI runs this plan after the push. Locally run only the narrowest proof: the one test file or `cargo test -p <crate> <filter>` that reproduces the failure and then passes.',
  ].join('\n');
}

/** Doc drift speaks only when the script found mentions, which it signals by exiting 1 under `--fail`. */
export function docDriftMessage(exitCode: number, output: string): string | null {
  const trimmed = output.trim();
  if (exitCode !== 1 || trimmed === '') return null;
  return `Doc drift (scripts/doc-drift.ts --since HEAD):\n${truncateOnLine(trimmed, MESSAGE_BUDGET_BYTES)}`;
}

function runDocDrift(root: string, files: readonly string[]): string | null {
  const result = Bun.spawnSync(
    ['bun', DOC_DRIFT_SCRIPT, '--since', 'HEAD', '--files', files.join(','), '--fail'],
    { cwd: root, stdout: 'pipe', stderr: 'ignore', timeout: DOC_DRIFT_TIMEOUT_MS },
  );
  return docDriftMessage(result.exitCode, result.stdout.toString());
}

/** Print-only: no `--run`, so this selects and reads the cache without executing a gate. */
function runGates(root: string, files: readonly string[]): string {
  const result = Bun.spawnSync(['bun', 'run', 'gates', '--files', files.join(',')], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: GATES_TIMEOUT_MS,
  });
  return result.stdout.toString();
}

if (import.meta.main) {
  await runHook(async () => {
    const input = await readHookInput();
    if (input === null) return 0;
    const root = findRepoRoot(input.cwd);
    if (root === null) return 0;
    if (spokeAlready(input)) return 0;
    const files = uncommittedEdits(root, editedFiles(input.sessionId));
    if (files.length === 0) return 0;
    const sections: string[] = [];
    const verification = verificationMessage(runGates(root, files));
    if (verification !== null) sections.push(verification);
    if (existsSync(path.join(root, DOC_DRIFT_SCRIPT))) {
      const drift = runDocDrift(root, files);
      if (drift !== null) sections.push(drift);
    }
    if (sections.length > 0) writeStdout(systemMessageOutput(sections.join('\n\n')));
    return 0;
  });
}
