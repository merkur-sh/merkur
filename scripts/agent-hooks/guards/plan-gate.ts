import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GuardContext, GuardDecision, HookInput } from '../hook-io';

/**
 * The plan-mode rule for the trust-boundary trees, mechanised.
 *
 * CLAUDE.md says: plan before changing the trees below. Prose keeps that rule when the
 * agent remembers it; this guard keeps it always. The exact signal is one the harness
 * already emits: `ExitPlanMode` completes only when the user approves the plan, so its
 * PostToolUse event records an approval marker for the session, and an `Edit`, `Write` or
 * `MultiEdit` under a gated tree is denied until that marker exists. One approved plan
 * covers the session; a resumed session keeps its id and therefore its approval.
 *
 * Codex has no plan mode and no `ExitPlanMode`; its edits arrive as `apply_patch`, which
 * this guard does not look at, so the rule is Claude-only by construction.
 */

export const PLAN_GATED_TREES: readonly string[] = [
  'packages/auth',
  'packages/merkur-e2e',
  'apps/daemon/dataplane/src/session',
  'packages/merkur-identity-seal',
];

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit']);
const PLAN_APPROVAL_TOOL = 'ExitPlanMode';
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** The gated tree a file lives under, or `null` when it is outside every gated tree. */
export function planGatedTreeOf(file: string, ctx: GuardContext): string | null {
  const relative = path.relative(ctx.root, path.resolve(ctx.cwd, file)).split(path.sep).join('/');
  if (relative === '' || relative === '..' || relative.startsWith('../')) return null;
  if (path.isAbsolute(relative)) return null;
  for (const tree of PLAN_GATED_TREES) {
    if (relative === tree || relative.startsWith(`${tree}/`)) return tree;
  }
  return null;
}

/** Where a session's approval marker lives; `null` for an id that is not a safe file name. */
export function planMarkerPath(sessionId: string, tmpdir: string = os.tmpdir()): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  return path.join(tmpdir, 'merkur-agent-hooks', 'approved-plans', sessionId);
}

export function isPlanApproval(input: HookInput): boolean {
  return input.toolName === PLAN_APPROVAL_TOOL;
}

export function recordPlanApproval(sessionId: string, tmpdir: string = os.tmpdir()): void {
  const marker = planMarkerPath(sessionId, tmpdir);
  if (marker === null) return;
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, `${new Date().toISOString()}\n`);
}

export function planApproved(
  sessionId: string,
  tmpdir: string = os.tmpdir(),
  exists: (candidate: string) => boolean = existsSync,
): boolean {
  const marker = planMarkerPath(sessionId, tmpdir);
  return marker !== null && exists(marker);
}

export function evaluatePlanGate(input: HookInput, ctx: GuardContext): GuardDecision | null {
  if (!EDIT_TOOLS.has(input.toolName)) return null;
  const filePath = input.toolInput.file_path;
  if (typeof filePath !== 'string' || filePath === '') return null;
  const tree = planGatedTreeOf(filePath, ctx);
  if (tree === null || ctx.planApproved) return null;
  return {
    kind: 'deny',
    reason: [
      `Denied: \`${filePath}\` is under \`${tree}\`, one of the trees CLAUDE.md gates behind plan mode, and no plan has been approved in this session.`,
      'Call EnterPlanMode, write the plan, and let the user approve it through ExitPlanMode; that approval unlocks every gated tree for the rest of the session.',
      `Gated trees: ${PLAN_GATED_TREES.join(', ')}.`,
    ].join('\n'),
  };
}
