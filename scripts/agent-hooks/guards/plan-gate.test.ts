import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GuardContext, HookInput } from '../hook-io';
import {
  evaluatePlanGate,
  isPlanApproval,
  PLAN_GATED_TREES,
  planApproved,
  planGatedTreeOf,
  planMarkerPath,
  recordPlanApproval,
} from './plan-gate';

const ROOT = '/repo';

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    root: ROOT,
    cwd: ROOT,
    home: '/home/agent',
    indexPresent: true,
    planApproved: false,
    ...overrides,
  };
}

function edit(toolName: string, filePath: string): HookInput {
  return {
    sessionId: 's',
    cwd: ROOT,
    hookEventName: 'PreToolUse',
    toolName,
    toolInput: { file_path: filePath },
    raw: {},
  };
}

test('files under a gated tree resolve to that tree from any spelling', () => {
  expect(planGatedTreeOf('packages/auth/src/opaque.ts', context())).toBe('packages/auth');
  expect(planGatedTreeOf('/repo/packages/merkur-e2e/src/lib.rs', context())).toBe(
    'packages/merkur-e2e',
  );
  expect(
    planGatedTreeOf('src/session/policy.rs', context({ cwd: '/repo/apps/daemon/dataplane' })),
  ).toBe('apps/daemon/dataplane/src/session');
  expect(planGatedTreeOf('packages/merkur-identity-seal/src/lib.rs', context())).toBe(
    'packages/merkur-identity-seal',
  );
});

test('files outside the gated trees, and outside the repository, are not gated', () => {
  expect(planGatedTreeOf('packages/auth-ui/src/x.ts', context())).toBeNull();
  expect(planGatedTreeOf('apps/daemon/dataplane/src/sessions.rs', context())).toBeNull();
  expect(planGatedTreeOf('apps/web/src/App.tsx', context())).toBeNull();
  expect(planGatedTreeOf('/elsewhere/packages/auth/x.ts', context())).toBeNull();
  expect(planGatedTreeOf('/repo', context())).toBeNull();
});

test('an edit under a gated tree is denied until the session has an approved plan', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    const decision = evaluatePlanGate(edit(tool, 'packages/auth/src/tokens.ts'), context());
    expect(decision?.kind).toBe('deny');
    if (decision?.kind !== 'deny') return;
    expect(decision.reason).toContain('EnterPlanMode');
    expect(decision.reason).toContain('ExitPlanMode');
    for (const tree of PLAN_GATED_TREES) expect(decision.reason).toContain(tree);
  }
  expect(
    evaluatePlanGate(edit('Edit', 'packages/auth/src/tokens.ts'), context({ planApproved: true })),
  ).toBeNull();
});

test('other tools and ungated files produce nothing', () => {
  expect(evaluatePlanGate(edit('Read', 'packages/auth/src/tokens.ts'), context())).toBeNull();
  expect(evaluatePlanGate(edit('Edit', 'apps/web/src/App.tsx'), context())).toBeNull();
  expect(evaluatePlanGate(edit('Edit', ''), context())).toBeNull();
});

test('ExitPlanMode is the approval signal', () => {
  expect(isPlanApproval({ ...edit('ExitPlanMode', ''), toolInput: { plan: 'x' } })).toBe(true);
  expect(isPlanApproval(edit('Edit', 'x'))).toBe(false);
});

test('the approval marker is per session and only for safe ids', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'plan-gate-'));
  try {
    expect(planApproved('session-1', tmpdir)).toBe(false);
    recordPlanApproval('session-1', tmpdir);
    expect(planApproved('session-1', tmpdir)).toBe(true);
    expect(planApproved('session-2', tmpdir)).toBe(false);
    const marker = planMarkerPath('session-1', tmpdir);
    expect(marker !== null && existsSync(marker)).toBe(true);

    expect(planMarkerPath('../escape', tmpdir)).toBeNull();
    expect(planMarkerPath('', tmpdir)).toBeNull();
    recordPlanApproval('../escape', tmpdir);
    expect(planApproved('../escape', tmpdir)).toBe(false);
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});
