import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isPlanApproval, recordPlanApproval } from './guards/plan-gate';
import {
  detectHarness,
  findRepoRoot,
  type Harness,
  type HookInput,
  postToolUseFindingsOutput,
  readHookInput,
  runHook,
  truncateOnLine,
  writeStdout,
} from './hook-io';

/**
 * PostToolUse entry.
 *
 * After an edit — Claude's `Edit|Write|MultiEdit` or Codex's `apply_patch` — run Biome over
 * the touched TypeScript/JavaScript files, apply what it can fix safely, and hand back only
 * what it cannot, so a `console.log` or a non-null assertion is reported at the edit rather
 * than at the gate.
 *
 * `--write` is deliberate, reversing an earlier "never `--write`" rule here. The objection
 * was that rewriting a file behind the agent breaks its next `old_string` match — but
 * reporting a wrapped line instead just makes the agent spend a round trip rewriting the
 * file itself, so the bytes move either way. The line between the two is Biome's own:
 * `--write` applies formatting, safe lint fixes and safe assist actions and nothing else,
 * while `--unsafe` is never passed, so every fix that could change behaviour — an unused
 * import, a widened type — still comes back for the agent to decide. Files whose bytes
 * actually moved are named, because that is the cue to re-read before editing them again.
 *
 * After Claude's `ExitPlanMode`, record the session's plan approval for `guards/plan-gate`.
 */

const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const BIOME_TIMEOUT_MS = 15_000;
const CONTEXT_BUDGET_BYTES = 4096;

/** Paths named by an `apply_patch` document. */
export function parseApplyPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Update File|Add File|Move to): (.+)$/.exec(line.trimEnd());
    if (match !== null) {
      const target = match[1]?.trim() ?? '';
      if (target !== '') paths.push(target);
    }
  }
  return paths;
}

function patchTextOf(input: HookInput): string {
  for (const key of ['patch', 'input', 'command']) {
    const value = input.toolInput[key];
    if (typeof value === 'string' && value.includes('*** Begin Patch')) return value;
    if (Array.isArray(value)) {
      const joined = value.filter((item) => typeof item === 'string').join('\n');
      if (joined.includes('*** Begin Patch')) return joined;
    }
  }
  return '';
}

/** Files an edit tool call touched, as given (relative paths are relative to the hook cwd). */
export function editedFilesOf(input: HookInput): string[] {
  if (input.toolName === 'Edit' || input.toolName === 'Write' || input.toolName === 'MultiEdit') {
    const filePath = input.toolInput.file_path;
    return typeof filePath === 'string' && filePath !== '' ? [filePath] : [];
  }
  if (input.toolName === 'apply_patch') return parseApplyPatchPaths(patchTextOf(input));
  return [];
}

export function lintableFiles(
  files: readonly string[],
  cwd: string,
  exists: (candidate: string) => boolean = existsSync,
): string[] {
  return files
    .filter((file) => LINTABLE.test(file))
    .map((file) => path.resolve(cwd, file))
    .filter((file, index, all) => all.indexOf(file) === index && exists(file));
}

export interface FindingsEmission {
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly exitCode: number;
}

/** Claude reads JSON on stdout at exit 0; Codex reads stderr at exit 2. */
export function emissionFor(harness: Harness, findings: string): FindingsEmission {
  const bounded = truncateOnLine(findings.trim(), CONTEXT_BUDGET_BYTES);
  if (harness === 'claude') {
    return { stdout: postToolUseFindingsOutput(bounded), stderr: null, exitCode: 0 };
  }
  return { stdout: null, stderr: bounded, exitCode: 2 };
}

/**
 * What to say after Biome has already fixed what it safely could.
 *
 * Nothing left and nothing moved is silence. Anything reported is labelled as a fix to make
 * in place: without the label a per-edit emission reads as a verification event mid-change,
 * and the reflex it invites — stop and run the gates — is the loop this harness exists to
 * avoid.
 */
export function biomeFindings(output: string, rewritten: readonly string[] = []): string | null {
  const text = output.trim();
  const fixed =
    rewritten.length === 0
      ? null
      : `Biome fixed ${rewritten.join(', ')} in place (formatting, import order). Re-read before your next edit there.`;
  if (text === '') return fixed;
  const remaining = `Biome could not fix these safely — decide them yourself; this is not a verification gate and does not call for a gate run:\n${text}`;
  return fixed === null ? remaining : `${fixed}\n\n${remaining}`;
}

/** File bytes keyed by path; an unreadable file is absent, which reads as "moved". */
function contentsOf(files: readonly string[]): Map<string, string> {
  const contents = new Map<string, string>();
  for (const file of files) {
    try {
      contents.set(file, readFileSync(file, 'utf8'));
    } catch {
      // Unreadable now is a difference from whatever it reads as after.
    }
  }
  return contents;
}

function runBiome(root: string, files: readonly string[]): string | null {
  const biome = path.join(root, 'node_modules', '.bin', 'biome');
  if (!existsSync(biome)) return null;
  const before = contentsOf(files);
  const result = Bun.spawnSync([biome, 'check', '--write', '--no-errors-on-unmatched', ...files], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: BIOME_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const after = contentsOf(files);
  const rewritten = files
    .filter((file) => before.get(file) !== after.get(file))
    .map((file) => path.relative(root, file));
  if (result.success) return biomeFindings('', rewritten);
  return biomeFindings(`${result.stdout.toString()}\n${result.stderr.toString()}`, rewritten);
}

if (import.meta.main) {
  await runHook(async () => {
    const input = await readHookInput();
    if (input === null) return 0;
    if (isPlanApproval(input)) {
      recordPlanApproval(input.sessionId);
      return 0;
    }
    const root = findRepoRoot(input.cwd);
    if (root === null) return 0;

    const files = lintableFiles(editedFilesOf(input), input.cwd);
    if (files.length === 0) return 0;
    const findings = runBiome(root, files);
    if (findings === null) return 0;
    const emission = emissionFor(detectHarness(), findings);
    if (emission.stdout !== null) writeStdout(emission.stdout);
    if (emission.stderr !== null) process.stderr.write(`${emission.stderr}\n`);
    return emission.exitCode;
  });
}
