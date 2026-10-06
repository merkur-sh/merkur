import { expect, test } from 'bun:test';

import type { GuardDecision } from '../hook-io';
import { splitCommandLine } from '../shell-command';
import { evaluateCodegraphLookup } from './codegraph-lookup';

function decide(line: string): GuardDecision | null {
  for (const command of splitCommandLine(line, '/repo', '/home/agent')) {
    const decision = evaluateCodegraphLookup(command);
    if (decision !== null) return decision;
  }
  return null;
}

test('node, query, files, callers, callees and impact are denied with the explore forms', () => {
  const decision = decide('codegraph node --file apps/web/src/App.tsx --offset 1 --limit 200');
  expect(decision?.kind).toBe('deny');
  if (decision?.kind !== 'deny') return;
  expect(decision.reason).toContain('`codegraph node`');
  expect(decision.reason).toContain('codegraph explore "<file path>"');
  expect(decision.reason).toContain('codegraph explore "<file path> <symbol>"');
  for (const sub of ['node createAppController', 'query Foo', 'files', 'callers x', 'callees x']) {
    expect(decide(`codegraph ${sub}`)?.kind).toBe('deny');
  }
  expect(decide('codegraph impact x')?.kind).toBe('deny');
});

test('every spelling that runs the subcommand is caught', () => {
  expect(decide('/Users/me/.local/bin/codegraph node x')?.kind).toBe('deny');
  expect(decide('codegraph --no-color node x')?.kind).toBe('deny');
  expect(decide('cd apps && codegraph callers x | head -50')?.kind).toBe('deny');
  expect(decide('echo $(codegraph query x)')?.kind).toBe('deny');
});

test('explore, index maintenance and --help stay allowed', () => {
  expect(decide('codegraph explore "apps/web/src/App.tsx"')).toBeNull();
  expect(decide('codegraph explore node')).toBeNull();
  expect(decide('codegraph init .')).toBeNull();
  expect(decide('codegraph sync')).toBeNull();
  expect(decide('codegraph index -f .')).toBeNull();
  expect(decide('codegraph status')).toBeNull();
  expect(decide('codegraph --help')).toBeNull();
  expect(decide('codegraph node --help')).toBeNull();
  expect(decide('grep node docs/transport.md')).toBeNull();
});

test('a commit message that names the denied forms is not a lookup', () => {
  expect(
    decide("git commit -F - <<'EOF'\ndeny `codegraph node` and\ncodegraph callers x\nEOF"),
  ).toBeNull();
  expect(decide('git commit -m "retire codegraph node"')).toBeNull();
});
