import { expect, test } from 'bun:test';

import type { GuardContext, GuardDecision } from '../hook-io';
import { splitCommandLine } from '../shell-command';
import { evaluateWorkspaceCd, workspacePackageOf } from './workspace-cd';

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

function decide(line: string, ctx: GuardContext = context()): GuardDecision | null {
  for (const command of splitCommandLine(line, ctx.cwd, ctx.home)) {
    const decision = evaluateWorkspaceCd(command, ctx);
    if (decision !== null) return decision;
  }
  return null;
}

test('bunx after cd into a workspace package is denied with the root-relative forms', () => {
  const decision = decide('cd apps/web && bunx foo');
  expect(decision?.kind).toBe('deny');
  if (decision?.kind !== 'deny') return;
  expect(decision.reason).toContain('bun run --cwd apps/web <script>');
  expect(decision.reason).toContain('bun add <dependency> --cwd apps/web');
  expect(decision.reason).toContain('bunx foo apps/web/…');
});

test('package-manager subcommands inside a package are denied', () => {
  expect(decide('cd packages/shared && bun add zod')?.kind).toBe('deny');
  expect(decide('cd apps/server; bun install')?.kind).toBe('deny');
  expect(decide('cd apps/server && bun i')?.kind).toBe('deny');
  expect(decide('cd apps/web && bun x vite')?.kind).toBe('deny');
  expect(decide('cd apps/web && bun update')?.kind).toBe('deny');
  expect(decide('cd apps/web && bun remove x')?.kind).toBe('deny');
  expect(decide('cd apps/web && bun pm ls')?.kind).toBe('deny');
  expect(decide('cd apps/web/src && bunx tsc')?.kind).toBe('deny');
  expect(decide('(cd apps/web && bunx tsc)')?.kind).toBe('deny');
});

test('the hook cwd itself counts as the effective cwd', () => {
  expect(decide('bunx foo', context({ cwd: '/repo/apps/web' }))?.kind).toBe('deny');
  expect(decide('bun add x', context({ cwd: '/repo/packages/keyboard/src' }))?.kind).toBe('deny');
});

test('the root-relative forms are allowed', () => {
  expect(decide('bun run --cwd apps/web build')).toBeNull();
  expect(decide('bunx foo apps/web/src')).toBeNull();
  expect(decide('bun add zod --cwd apps/web')).toBeNull();
  expect(decide('bun install')).toBeNull();
  expect(decide('bunx biome check scripts')).toBeNull();
});

test('bun test, bun run and bun <file> inside a package stay allowed', () => {
  expect(decide('cd apps/web && bun test')).toBeNull();
  expect(decide('cd apps/web && bun run build')).toBeNull();
  expect(decide('cd apps/daemon && bun src/index.ts version')).toBeNull();
  expect(decide('cd docs && bunx something')).toBeNull();
  expect(decide('cd apps && bunx something')).toBeNull();
  expect(decide('cd /elsewhere && bun add x')).toBeNull();
});

test('--help is never denied', () => {
  expect(decide('cd apps/web && bunx --help')).toBeNull();
});

test('workspace package detection', () => {
  expect(workspacePackageOf('/repo/apps/web', ROOT)).toBe('apps/web');
  expect(workspacePackageOf('/repo/apps/web/src/deep', ROOT)).toBe('apps/web');
  expect(workspacePackageOf('/repo/packages/config', ROOT)).toBe('packages/config');
  expect(workspacePackageOf('/repo/apps', ROOT)).toBeNull();
  expect(workspacePackageOf('/repo', ROOT)).toBeNull();
  expect(workspacePackageOf('/repo/docs', ROOT)).toBeNull();
  expect(workspacePackageOf('/other/apps/web', ROOT)).toBeNull();
});
