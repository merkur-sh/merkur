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

/**
 * Stop entry: four advisory sweeps of the working tree when the agent finishes — what the
 * diff still has to verify, what the ratchet and the anti-slop baseline already say about
 * it, and what prose it has already invalidated.
 *
 * The verification line exists because the agent used to answer "have I verified this?" the
 * only way it could: by running the gates again. `bun run gates` prints the selected plan
 * and, from the result cache, which of its test files are already green for exactly the
 * bytes they read — so the answer is readable here rather than re-derived there. This hook
 * never spawns a gate lane, and it cannot block a stop even if it wanted to.
 *
 * The one analysis it does run is `scripts/check-ratchet.ts` (about 3 s, alongside the gate
 * plan): the dead code, clones and hotspot growth the diff introduced are the findings
 * cheapest to fix while the agent still holds the change. The pre-commit hook enforces the
 * same ratchet on the staged diff; here it only reports, and a run that does not finish is
 * reported as unverified rather than as silence.
 *
 * `scripts/check-slop.ts` (beside the ratchet) reports on the same terms: the anti-slop
 * findings the tree carries above `lint-baselines/anti-slop.json` come with each rule's repair
 * instruction, and the pre-commit hook enforces them on the staged files. It lints only the
 * files whose bytes it has not seen, so it costs about a second; after a rule or a Biome
 * change it lints the whole tree once, which is given most of this hook's own minute.
 *
 * `scripts/doc-drift.ts --since HEAD` lists prose still naming identifiers, paths, script
 * names and literal values the uncommitted diff removed or changed. Findings go out as a
 * `systemMessage` — visible to the user, never blocking — because "the docs still say the
 * old thing" is the review the agent skips most. `stop_hook_active` means this hook already
 * spoke once for this stop; saying it twice would loop.
 */

export const DOC_DRIFT_SCRIPT = path.join('scripts', 'doc-drift.ts');
export const RATCHET_SCRIPT = path.join('scripts', 'check-ratchet.ts');
export const SLOP_SCRIPT = path.join('scripts', 'check-slop.ts');
const DOC_DRIFT_TIMEOUT_MS = 20_000;
const GATES_TIMEOUT_MS = 20_000;
const RATCHET_TIMEOUT_MS = 20_000;
const SLOP_TIMEOUT_MS = 50_000;
const MESSAGE_BUDGET_BYTES = 4096;

/** This hook already spoke once for this stop; a second message would loop. */
export function spokeAlready(input: HookInput): boolean {
  return input.raw.stop_hook_active === true;
}

export function shouldRunDocDrift(input: HookInput, docDriftScriptExists: boolean): boolean {
  if (spokeAlready(input)) return false;
  return docDriftScriptExists;
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
    'Verification state of the uncommitted diff (`bun run gates`, nothing was run):',
    truncateOnLine(plan, MESSAGE_BUDGET_BYTES),
    'Run `bun run gates --run` once the change is done. Test files already green for these exact inputs are skipped, so running it again after no edit costs seconds.',
  ].join('\n');
}

export function docDriftMessage(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed === '') return null;
  return `Doc drift (scripts/doc-drift.ts --since HEAD):\n${truncateOnLine(trimmed, MESSAGE_BUDGET_BYTES)}`;
}

export interface RatchetRun {
  readonly exitCode: number;
  readonly signalCode: string | null;
  readonly stdout: string;
}

/** What a gate printed, or that it gave no answer; `clean` is the pass that needs no words. */
function gateMessage(
  title: string,
  run: RatchetRun,
  clean: boolean,
  timeoutMs: number,
): string | null {
  if (run.signalCode !== null) {
    return `${title}\nunverified: stopped by ${run.signalCode} after ${timeoutMs / 1000} s`;
  }

  const trimmed = run.stdout.trim();

  if (clean) return null;

  if (trimmed === '') return `${title}\nunverified: exited ${run.exitCode} without output`;

  return `${title}\n${truncateOnLine(trimmed, MESSAGE_BUDGET_BYTES)}`;
}

/** Silent on a clean pass; otherwise what the ratchet printed, or that it gave no answer. */
export function ratchetMessage(run: RatchetRun): string | null {
  return gateMessage(
    'Ratchet (`bun run check:ratchet`, enforced on the staged diff at commit):',
    run,
    run.exitCode === 0 && !run.stdout.trim().includes('\nNOTE'),
    RATCHET_TIMEOUT_MS,
  );
}

/** Silent on a pass; otherwise the findings above the baseline, or that Biome gave no answer. */
export function slopMessage(run: RatchetRun): string | null {
  return gateMessage(
    'Anti-slop baseline (`bun run check:slop`, enforced on the staged files at commit):',
    run,
    run.exitCode === 0,
    SLOP_TIMEOUT_MS,
  );
}

async function runGate(root: string, script: string, timeout: number): Promise<RatchetRun> {
  const child = Bun.spawn(['bun', script], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
    timeout,
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, signalCode: child.signalCode ?? null, stdout };
}

function runDocDrift(root: string): string {
  const result = Bun.spawnSync(['bun', DOC_DRIFT_SCRIPT, '--since', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: DOC_DRIFT_TIMEOUT_MS,
  });
  return result.stdout.toString();
}

/** Print-only: no `--run`, so this selects and reads the cache without executing a gate. */
function runGates(root: string): string {
  const result = Bun.spawnSync(['bun', 'run', 'gates'], {
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
    const sections: string[] = [];
    // Started first so they run while the gate plan is selected.
    const ratchet = existsSync(path.join(root, RATCHET_SCRIPT))
      ? runGate(root, RATCHET_SCRIPT, RATCHET_TIMEOUT_MS)
      : null;
    const slop = existsSync(path.join(root, SLOP_SCRIPT))
      ? runGate(root, SLOP_SCRIPT, SLOP_TIMEOUT_MS)
      : null;
    const verification = verificationMessage(runGates(root));
    if (verification !== null) sections.push(verification);
    const ratchetReport = ratchet === null ? null : ratchetMessage(await ratchet);
    if (ratchetReport !== null) sections.push(ratchetReport);
    const slopReport = slop === null ? null : slopMessage(await slop);
    if (slopReport !== null) sections.push(slopReport);
    if (shouldRunDocDrift(input, existsSync(path.join(root, DOC_DRIFT_SCRIPT)))) {
      const drift = docDriftMessage(runDocDrift(root));
      if (drift !== null) sections.push(drift);
    }
    if (sections.length > 0) writeStdout(systemMessageOutput(sections.join('\n\n')));
    return 0;
  });
}
