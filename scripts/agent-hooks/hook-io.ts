import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Shared I/O for the agent hooks.
 *
 * Every hook in this directory runs on every tool call of every agent session, in both
 * Claude Code and Codex, so this layer keeps two promises: it never imports anything
 * outside the standard library (startup is the whole cost), and it never wedges the agent —
 * an input that cannot be parsed is a "no opinion", never a failure.
 *
 * The wire contract is the one both harnesses share: JSON on stdin describing the event,
 * JSON on stdout carrying a decision. The shapes are documented per function below.
 */

export type Harness = 'claude' | 'codex';

export interface HookInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly hookEventName: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** The whole payload, for event-specific fields (`prompt`, `stop_hook_active`, …). */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A guard either denies with a reason or has no opinion (`null` at the call site). */
export interface GuardDecision {
  readonly kind: 'deny';
  readonly reason: string;
}

/**
 * Everything a guard may know about the world. Guards are pure functions of a command and
 * this record; the entry script fills it from the filesystem, tests fill it by hand.
 */
export interface GuardContext {
  readonly root: string;
  readonly cwd: string;
  /** The user's home directory: what `~` expands to in a shell line. */
  readonly home: string;
  readonly indexPresent: boolean;
  /** `ExitPlanMode` has completed in this session (see `guards/plan-gate.ts`). */
  readonly planApproved: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** Parse a hook payload; `null` means "not a hook payload we understand" and the caller exits 0. */
export function parseHookInput(text: string): HookInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const toolInput = parsed.tool_input;
  return {
    sessionId: stringField(parsed, 'session_id'),
    cwd: stringField(parsed, 'cwd') || process.cwd(),
    hookEventName: stringField(parsed, 'hook_event_name'),
    toolName: stringField(parsed, 'tool_name'),
    toolInput: isRecord(toolInput) ? toolInput : {},
    raw: parsed,
  };
}

export async function readHookInput(): Promise<HookInput | null> {
  try {
    const text = await Bun.stdin.text();
    return parseHookInput(text);
  } catch {
    return null;
  }
}

/**
 * The repository root is the nearest ancestor holding `.codegraph/`. Only
 * `.codegraph/.gitignore` is committed, but that is enough: the directory exists in every
 * checkout and every worktree, indexed or not.
 */
export function findRepoRoot(
  cwd: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  let current = path.resolve(cwd);
  for (;;) {
    if (exists(path.join(current, '.codegraph'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export const CODEGRAPH_DB_RELATIVE = path.join('.codegraph', 'codegraph.db');

export function hasCodegraphIndex(
  root: string,
  exists: (candidate: string) => boolean = existsSync,
): boolean {
  return exists(path.join(root, CODEGRAPH_DB_RELATIVE));
}

/** Claude Code exports `CLAUDE_PROJECT_DIR` to every hook; Codex exports nothing of the kind. */
export function detectHarness(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Harness {
  return typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR !== ''
    ? 'claude'
    : 'codex';
}

/** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`. */
export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * PostToolUse findings. Claude reads JSON on stdout (the agent sees `additionalContext`, the
 * user sees `systemMessage`); Codex reads stderr and treats exit 2 as "show the agent".
 */
export function postToolUseFindingsOutput(findings: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: findings },
    systemMessage: findings,
  });
}

export function systemMessageOutput(message: string): string {
  return JSON.stringify({ systemMessage: message });
}

export function writeStdout(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Run a hook's main body under the "never wedge the agent" rule: whatever throws, the
 * process exits 0 with nothing on stdout, which every harness reads as "no opinion".
 */
export async function runHook(body: () => Promise<number | undefined>): Promise<void> {
  let code = 0;
  try {
    code = (await body()) ?? 0;
  } catch {
    code = 0;
  }
  process.exit(code);
}

/** Truncate at a byte budget, cutting on the last newline inside it. */
export function truncateOnLine(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // A streaming decode withholds an incomplete trailing sequence instead of replacing it.
  const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  let cut = new TextDecoder('utf-8').decode(bytes, { stream: true });
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  return cut;
}
