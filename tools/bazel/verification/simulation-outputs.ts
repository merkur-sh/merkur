import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OwnedDirectory } from '../bun/owned-files';
import { readDeclaredInput } from './artifacts';

export interface SimulationOutputSelection {
  readonly label: string;
  readonly configuration: string;
  readonly mode: 'replay' | 'sweep';
}

interface RetentionOptions {
  readonly events: string;
  readonly invocation: string;
  readonly executionRoot: string;
  readonly outputRoot: string;
  readonly directory: OwnedDirectory;
  readonly selections: readonly SimulationOutputSelection[];
  readonly assertCurrent: () => void;
}

interface SimulationAttempt {
  selection: SimulationOutputSelection;
  identity: string;
  payload: Record<string, unknown>;
}

interface AttemptInventory {
  attempts: SimulationAttempt[];
  identities: Set<string>;
  observed: Set<string>;
}

const members = new Set([
  'simulation/scenarios.log',
  'simulation/sweep.log',
  'simulation/regressions.json',
  'simulation/sweep-failures.json',
]);
const prefix = 'test.outputs/';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function selectedTests(options: RetentionOptions): Map<string, SimulationOutputSelection> {
  const selected = new Map<string, SimulationOutputSelection>();
  for (const value of options.selections) {
    if (
      !/^\/\/[^:\s]*:[^:\s]+$/.test(value.label) ||
      typeof value.configuration !== 'string' ||
      value.configuration === '' ||
      !['replay', 'sweep'].includes(value.mode) ||
      selected.has(value.label)
    )
      throw new Error('Simulation diagnostics require exact configured selected tests');
    selected.set(value.label, { ...value });
  }
  if (selected.size === 0 || options.invocation === '')
    throw new Error('Simulation diagnostics require the owned command and selected tests');
  if (!path.isAbsolute(options.executionRoot) || !path.isAbsolute(options.outputRoot))
    throw new Error('Simulation diagnostics require absolute owned roots');
  return selected;
}

function collectAttempt(
  id: unknown,
  payload: unknown,
  selected: ReadonlyMap<string, SimulationOutputSelection>,
  inventory: AttemptInventory,
  problems: string[],
): void {
  if (!record(id) || typeof id.label !== 'string') return;
  const selection = selected.get(id.label);
  if (selection === undefined) return;
  if (
    !record(id.configuration) ||
    id.configuration.id !== selection.configuration ||
    !positive(id.run) ||
    !positive(id.shard) ||
    !positive(id.attempt)
  )
    throw new Error('Simulation diagnostics differ from the selected configured test attempt');
  const identity =
    `target-${encodeURIComponent(selection.label)}/` +
    `configuration-${encodeURIComponent(selection.configuration)}/` +
    `run-${id.run}-shard-${id.shard}-attempt-${id.attempt}`;
  if (inventory.identities.has(identity))
    throw new Error('Simulation diagnostics contain a duplicate test attempt');
  inventory.identities.add(identity);
  inventory.observed.add(selection.label);
  if (!record(payload)) {
    problems.push(`${identity}: the test attempt has no diagnostic payload`);
    return;
  }
  inventory.attempts.push({ selection, identity, payload });
}

function originalCommand(started: boolean, value: unknown, invocation: string): void {
  if (started || !record(value) || value.uuid !== invocation || value.buildToolVersion !== '9.2.0')
    throw new Error('Simulation diagnostics belong to another engine command');
}

function parseAttempts(
  options: RetentionOptions,
  selected: ReadonlyMap<string, SimulationOutputSelection>,
  problems: string[],
): AttemptInventory {
  const inventory: AttemptInventory = {
    attempts: [],
    identities: new Set(),
    observed: new Set(),
  };
  let started = false;
  for (const line of options.events.split('\n').filter((line) => line.trim() !== '')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      problems.push('Simulation diagnostics contain an incomplete or invalid build event');
      continue;
    }
    if (!record(event) || !record(event.id)) {
      problems.push('Simulation diagnostics contain an invalid build event');
      continue;
    }
    if (event.id.started !== undefined) {
      originalCommand(started, event.started, options.invocation);
      started = true;
    }
    collectAttempt(event.id.testResult, event.testResult, selected, inventory, problems);
  }
  if (!started) throw new Error('Simulation diagnostics have no matching owned command');
  return inventory;
}

function attemptOutputs(
  attempt: SimulationAttempt,
  problems: string[],
): { available: Map<string, Record<string, unknown>>; ambiguous: Set<string> } | undefined {
  const { identity, payload } = attempt;
  const outputs = payload.testActionOutput ?? [];
  if (!Array.isArray(outputs)) {
    problems.push(`${identity}: the test output inventory is invalid`);
    return;
  }
  const available = new Map<string, Record<string, unknown>>();
  const ambiguous = new Set<string>();
  for (const value of outputs) {
    if (!record(value) || typeof value.name !== 'string') {
      problems.push(`${identity}: an invalid test output File was reported`);
      continue;
    }
    if (value.name === 'test.outputs__outputs.zip') {
      problems.push(`${identity}: simulation diagnostics require unzipped test outputs`);
      continue;
    }
    if (!value.name.startsWith(`${prefix}simulation/`)) continue;
    const member = value.name.slice(prefix.length);
    if (!members.has(member)) {
      problems.push(`${identity}: unexpected simulation output ${member}`);
      continue;
    }
    if (available.has(member)) ambiguous.add(member);
    available.set(member, value);
  }
  const required =
    attempt.selection.mode === 'replay'
      ? ['simulation/scenarios.log']
      : ['simulation/sweep.log', 'simulation/regressions.json', 'simulation/sweep-failures.json'];
  for (const member of required)
    if (!available.has(member)) problems.push(`${identity}: missing simulation output ${member}`);
  return { available, ambiguous };
}

function outputLocation(value: Record<string, unknown>, executionRoot: string): string {
  if (
    typeof value.uri !== 'string' ||
    value.contents !== undefined ||
    value.symlinkTargetPath !== undefined
  )
    throw new Error('Test output must be an ordinary materialized File URI');
  const uri = new URL(value.uri);
  if (
    uri.protocol !== 'file:' ||
    uri.host !== '' ||
    uri.search !== '' ||
    uri.hash !== '' ||
    uri.username !== '' ||
    uri.password !== ''
  )
    throw new Error('Test output requires its local materialized File URI');
  const relative = path.relative(executionRoot, fileURLToPath(uri));
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('Test output URI escapes its materialized execution root');
  return relative;
}

/**
 * Retain diagnostics from the caller's actual owned command, before its output tree closes.
 * This helper validates BEP structure and File custody; it never establishes test admission.
 * Bazel 9.2 TestAttempt emits name+URI, without digest/length, for these outputs.
 */
export async function retainSimulationOutputs(
  options: RetentionOptions,
): Promise<{ readonly files: readonly string[]; readonly problems: readonly string[] }> {
  options.assertCurrent();
  const selected = selectedTests(options);
  const problems: string[] = [];
  const { attempts, observed } = parseAttempts(options, selected, problems);
  const files: string[] = [];
  for (const attempt of attempts) {
    const outputs = attemptOutputs(attempt, problems);
    if (outputs === undefined) continue;
    const { identity } = attempt;
    for (const [member, value] of outputs.available) {
      if (outputs.ambiguous.has(member)) {
        problems.push(`${identity}: duplicate simulation output ${member}`);
        continue;
      }
      try {
        const relative = outputLocation(value, options.executionRoot);
        options.assertCurrent();
        const input = await readDeclaredInput(options.executionRoot, relative);
        if (
          (value.digest !== undefined && value.digest !== input.artifact.digest) ||
          (value.length !== undefined && value.length !== input.artifact.length)
        )
          throw new Error('Test output differs from its producing File facts');
        options.assertCurrent();
        const destination = `${identity}/${member}`;
        options.directory.write(destination, input.bytes, 0o600);
        options.directory.sync(destination);
        files.push(destination);
      } catch (error) {
        problems.push(`${identity}: ${member}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  for (const selection of selected.values())
    if (!observed.has(selection.label))
      problems.push(`${selection.label}: the selected simulation test has no reported attempt`);
  options.assertCurrent();
  options.directory.verifyCreated(options.outputRoot);
  return { files: Object.freeze(files), problems: Object.freeze(problems) };
}
