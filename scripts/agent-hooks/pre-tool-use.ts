import os from 'node:os';

import { evaluateAuthoredProse } from './guards/authored-prose';
import { evaluateCargoStatic } from './guards/cargo-concurrency';
import { evaluateCodegraphLookup } from './guards/codegraph-lookup';
import { evaluateCommitHooks } from './guards/commit-hooks';
import { evaluatePlanGate, planApproved } from './guards/plan-gate';
import { evaluateGrepTool, evaluateSourceGrepCommand } from './guards/source-grep';
import { evaluateWorkspaceCd } from './guards/workspace-cd';
import {
  denyOutput,
  findRepoRoot,
  type GuardContext,
  type GuardDecision,
  type HookInput,
  hasCodegraphIndex,
  readHookInput,
  runHook,
  warnOutput,
  writeStdout,
} from './hook-io';
import { splitCommandLine } from './shell-command';

/**
 * PreToolUse entry: one process runs every guard, first denial wins.
 *
 * Edit tools see two guards, authored-prose then plan-gate. Shell lines run cargo-static → workspace-cd →
 * source-grep → codegraph-lookup → commit-hooks: the static Cargo rules go first because they
 * describe the whole line; the other four look at one command each. Source-grep only warns,
 * so its warning goes out when no later guard denies the line.
 */

function commandLineOf(input: HookInput): string | null {
  const command = input.toolInput.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((item) => typeof item === 'string')) {
    return command.join(' ');
  }
  return null;
}

export function decidePreToolUse(input: HookInput, ctx: GuardContext): GuardDecision | null {
  if (input.toolName === 'Grep') return evaluateGrepTool(input.toolInput, ctx);
  const authoredProse = evaluateAuthoredProse(input, ctx);
  if (authoredProse !== null) return authoredProse;
  const planGate = evaluatePlanGate(input, ctx);
  if (planGate !== null) return planGate;
  if (input.toolName !== 'Bash') return null;
  const line = commandLineOf(input);
  if (line === null || line.trim() === '') return null;

  const commands = splitCommandLine(line, ctx.cwd, ctx.home);
  const cargoStatic = evaluateCargoStatic(commands);
  if (cargoStatic !== null) return cargoStatic;

  for (const command of commands) {
    const decision = evaluateWorkspaceCd(command, ctx);
    if (decision !== null) return decision;
  }
  // A source sweep only warns, so the guards after it still run and a denial among them wins.
  let warning: GuardDecision | null = null;
  for (const command of commands) {
    warning ??= evaluateSourceGrepCommand(command, ctx);
  }
  for (const command of commands) {
    const decision = evaluateCodegraphLookup(command);
    if (decision !== null) return decision;
  }
  for (const command of commands) {
    const decision = evaluateCommitHooks(command);
    if (decision !== null) return decision;
  }
  return warning;
}

if (import.meta.main) {
  await runHook(async () => {
    const input = await readHookInput();
    if (input === null) return 0;
    const root = findRepoRoot(input.cwd);
    if (root === null) return 0;
    const ctx: GuardContext = {
      root,
      cwd: input.cwd,
      home: os.homedir(),
      indexPresent: hasCodegraphIndex(root),
      planApproved: planApproved(input.sessionId),
    };
    const decision = decidePreToolUse(input, ctx);
    if (decision !== null) {
      writeStdout(
        decision.kind === 'deny' ? denyOutput(decision.reason) : warnOutput(decision.reason),
      );
    }
    return 0;
  });
}
