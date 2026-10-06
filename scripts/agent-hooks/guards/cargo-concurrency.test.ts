import { expect, test } from 'bun:test';

import { splitCommandLine } from '../shell-command';
import { bunScriptOf, evaluateCargoStatic, isCargoCommand } from './cargo-concurrency';

const ROOT = '/repo';

function staticDecision(line: string) {
  return evaluateCargoStatic(splitCommandLine(line, ROOT, '/home/agent'));
}

test('rust:check next to rust:lint is denied with the superset', () => {
  const decision = staticDecision('bun run rust:check && bun run rust:lint');
  expect(decision?.kind).toBe('deny');
  if (decision?.kind !== 'deny') return;
  expect(decision.reason).toContain('bun run rust:lint');
  expect(staticDecision('cargo check --workspace && cargo clippy --all-targets')?.kind).toBe(
    'deny',
  );
  expect(staticDecision('bun run rust:lint')).toBeNull();
  expect(staticDecision('bun run rust:check')).toBeNull();
});

test('check next to one of its members is denied', () => {
  expect(staticDecision('bun run check && bun run check:types')?.kind).toBe('deny');
  expect(staticDecision('bun run check:lint; bun run check')?.kind).toBe('deny');
  expect(staticDecision('bun check && bun check:dead')?.kind).toBe('deny');
  expect(staticDecision('bun run check')).toBeNull();
  expect(staticDecision('bun run check:types && bun run check:lint')).toBeNull();
  expect(staticDecision('bun run check && bun run check:audit')).toBeNull();
});

test('verify next to what it already runs is denied', () => {
  expect(staticDecision('bun run verify && bun run check')?.kind).toBe('deny');
  expect(staticDecision('bun run test:unit && bun run verify')?.kind).toBe('deny');
  expect(staticDecision('bun run verify && bun run check:audit')?.kind).toBe('deny');
  expect(staticDecision('bun run verify')).toBeNull();
});

test('two cargo commands with one backgrounded are denied; chained ones are not', () => {
  const decision = staticDecision('cargo test -p a & cargo test -p b');
  expect(decision?.kind).toBe('deny');
  if (decision?.kind !== 'deny') return;
  expect(decision.reason).toContain('cargo test --locked -p <crate-a> -p <crate-b>');
  expect(staticDecision('cargo test -p a && cargo test -p b')).toBeNull();
  expect(staticDecision('bun run rust:lint & cargo test -p merkur-edge')?.kind).toBe('deny');
  expect(staticDecision('cargo test -p a & bun test apps/web')).toBeNull();
  expect(staticDecision('cargo test -p a &')).toBeNull();
});

test('--help never trips the static rules', () => {
  expect(staticDecision('cargo check --help && cargo clippy --help')).toBeNull();
});

test('cargo-backed scripts are recognised', () => {
  const commandOf = (line: string) => {
    const [command] = splitCommandLine(line, ROOT, '/home/agent');
    if (command === undefined) throw new Error(`no command in ${line}`);
    return command;
  };
  expect(isCargoCommand(commandOf('cargo test -p x'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run rust:lint'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run rust:test'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run build:dataplane'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run build:wasm'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run check:protocol'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run check'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run verify'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run bench:display-pipeline:rust'))).toBe(true);
  expect(isCargoCommand(commandOf('bun run --silent check'))).toBe(true);
  expect(isCargoCommand(commandOf('bun test apps/web'))).toBe(false);
  expect(isCargoCommand(commandOf('bun run check:types'))).toBe(false);
  expect(isCargoCommand(commandOf('bun run bench:sse'))).toBe(false);
  expect(isCargoCommand(commandOf('bun run --cwd apps/web build'))).toBe(false);
  expect(bunScriptOf(['bun', 'run', 'check'])).toBe('check');
  expect(bunScriptOf(['bun', 'check'])).toBe('check');
  expect(bunScriptOf(['bunx', 'check'])).toBeNull();
});
