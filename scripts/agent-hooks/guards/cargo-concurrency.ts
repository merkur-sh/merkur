import path from 'node:path';

import type { GuardDecision } from '../hook-io';
import type { SimpleCommand } from '../shell-command';

/**
 * "Batch what you selected", mechanised.
 *
 * Static rules over one command line: a line that pays for the same compile twice —
 * `rust:check` next to `rust:lint`, `check` next to one of its members, `verify` next to
 * what it already runs, or two Cargo commands with one backgrounded — is refused with the
 * batched form. Whether a Cargo command from an earlier tool call is still running is not
 * this guard's question: Cargo's own target-dir lock serializes that, deterministically.
 */

/** Root `package.json` scripts whose body is (or runs) Cargo. */
const CARGO_BACKED_SCRIPTS: ReadonlySet<string> = new Set([
  'build:dataplane',
  'build:wasm',
  'build:e2e-wasm',
  'check:protocol',
  'check',
  'verify',
  'bench:scroll-prepare',
  'bench:display-pipeline:rust',
  'bench:compression-planner',
  'bench:packing:whole-span:full',
  'bench:packing:whole-span:owner',
  'bench:display-ack:rust',
  'spike:ios:server',
]);

const CHECK_MEMBERS: ReadonlySet<string> = new Set([
  'check:types',
  'check:latency-boundaries',
  'check:span-lifetimes',
  'check:span-attributes',
  'check:lint',
  'check:dead',
  'check:files',
  'check:exports',
  'check:ratchet',
  'check:protocol',
]);

const VERIFY_MEMBERS: ReadonlySet<string> = new Set(['check', 'check:audit', 'test:unit']);

/** The root script a `bun run X` / `bun X` invokes, if any. */
export function bunScriptOf(argv: readonly string[]): string | null {
  if (path.basename(argv[0] ?? '') !== 'bun') return null;
  let index = 1;
  if (argv[index] === 'run') index += 1;
  while (index < argv.length) {
    const word = argv[index] ?? '';
    if (word === '--cwd' || word === '--filter' || word === '-F') {
      // A package-local script is not a root script.
      return null;
    }
    if (word.startsWith('-')) {
      index += 1;
      continue;
    }
    return word;
  }
  return null;
}

export function isCargoCommand(command: SimpleCommand): boolean {
  const tool = path.basename(command.argv[0] ?? '');
  if (tool === 'cargo' || tool === 'rustc') return true;
  const script = bunScriptOf(command.argv);
  if (script === null) return false;
  return script.startsWith('rust:') || CARGO_BACKED_SCRIPTS.has(script);
}

function cargoSubcommand(command: SimpleCommand): string | null {
  if (path.basename(command.argv[0] ?? '') !== 'cargo') return null;
  return command.argv.slice(1).find((word) => !word.startsWith('-')) ?? null;
}

function describe(command: SimpleCommand): string {
  return `\`${command.argv.join(' ')}\``;
}

export function evaluateCargoStatic(commands: readonly SimpleCommand[]): GuardDecision | null {
  if (commands.some((command) => command.hasHelp)) return null;
  const scripts = new Set<string>();
  const cargoSubs = new Set<string>();
  const cargoCommands: SimpleCommand[] = [];
  for (const command of commands) {
    const script = bunScriptOf(command.argv);
    if (script !== null) scripts.add(script);
    const sub = cargoSubcommand(command);
    if (sub !== null) cargoSubs.add(sub);
    if (isCargoCommand(command)) cargoCommands.push(command);
  }

  const checkAndLint =
    (scripts.has('rust:check') && scripts.has('rust:lint')) ||
    (cargoSubs.has('check') && cargoSubs.has('clippy'));
  if (checkAndLint) {
    return {
      kind: 'deny',
      reason:
        'Denied: `rust:check` together with `rust:lint` (or `cargo check` with `cargo clippy`) compiles the workspace twice — Clippy `--all-targets` is a strict superset of check and uses different metadata.\nRun only: bun run rust:lint',
    };
  }

  if (scripts.has('check')) {
    const member = [...scripts].find((script) => CHECK_MEMBERS.has(script));
    if (member !== undefined) {
      return {
        kind: 'deny',
        reason: `Denied: \`bun run check\` already runs \`${member}\`; running both pays for it twice.\nRun only: bun run check`,
      };
    }
  }

  if (scripts.has('verify')) {
    const member = [...scripts].find((script) => VERIFY_MEMBERS.has(script));
    if (member !== undefined) {
      return {
        kind: 'deny',
        reason: `Denied: \`bun run verify\` already runs \`${member}\` (verify = check ∥ check:audit ∥ test:unit).\nRun only: bun run verify`,
      };
    }
  }

  const backgrounded = cargoCommands.find((command) => command.background);
  if (cargoCommands.length >= 2 && backgrounded !== undefined) {
    return {
      kind: 'deny',
      reason: [
        `Denied: ${describe(backgrounded)} backgrounded next to another Cargo command — Cargo serializes on the target-dir lock, so the second one only queues and the shell reports them out of order.`,
        'Batch them into one invocation instead:',
        '  cargo test --locked -p <crate-a> -p <crate-b>            # several crates',
        '  cargo test --locked -p <crate> -- <filter-a> <filter-b>  # several filters',
        'or chain them with `&&`. Cargo and `bun test` may overlap; two Cargo commands may not.',
      ].join('\n'),
    };
  }
  return null;
}
