import { createHash } from 'node:crypto';

interface Artifact {
  readonly id: number;
  readonly pathFragmentId: number;
}

/** Bazel's own workspace status outputs, consumed by its C++ build-info translation. */
const WORKSPACE_STATUS: ReadonlySet<string> = new Set([
  'bazel-out/stable-status.txt',
  'bazel-out/volatile-status.txt',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid action graph identity');
  }
  return value;
}

function identities(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid action graph identity list');
  return value.map(id);
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(record)) throw new Error('Invalid action graph table');
  return value;
}

function table(rows: readonly Record<string, unknown>[]): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const key = id(row.id);
    if (result.has(key)) throw new Error('Duplicate action graph identity');
    result.set(key, row);
  }
  return result;
}

function configuredAction(action: Record<string, unknown>, allowTestRunner = false): boolean {
  return (
    (allowTestRunner || action.mnemonic !== 'TestRunner') &&
    typeof action.actionKey === 'string' &&
    /^[a-f0-9]{64}$/.test(action.actionKey) &&
    typeof action.mnemonic === 'string' &&
    action.mnemonic !== '' &&
    typeof action.executionPlatform === 'string' &&
    action.executionPlatform !== '' &&
    typeof action.configurationId === 'number' &&
    Number.isSafeInteger(action.configurationId) &&
    action.configurationId > 0 &&
    typeof action.targetId === 'number' &&
    Number.isSafeInteger(action.targetId) &&
    action.targetId > 0
  );
}

/** Bazel aquery repeats shared actions before the execution graph coalesces them. */
function engineActions(
  rows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((action) => {
    // An action key alone omits input content and paths. Only the complete same
    // configured record can be repeated; competing output producers still reject.
    if (!configuredAction(action)) return true;
    const identity = JSON.stringify(action);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

class ActionGraph {
  readonly actions: readonly Record<string, unknown>[];
  readonly targets: ReadonlyMap<number, Record<string, unknown>>;
  readonly configurations: ReadonlyMap<number, Record<string, unknown>>;
  private readonly fragments: ReadonlyMap<number, Record<string, unknown>>;
  private readonly artifacts: ReadonlyMap<number, Record<string, unknown>>;
  private readonly sets: ReadonlyMap<number, Record<string, unknown>>;
  private readonly paths = new Map<number, string>();
  private readonly visiting = new Set<number>();
  private readonly producers = new Map<number, Record<string, unknown>>();
  private readonly outputPaths = new Map<string, Record<string, unknown>>();
  private readonly trees = new Map<string, Record<string, unknown>>();
  private readonly sourceClosures = new Map<Record<string, unknown>, ReadonlySet<string>>();

  constructor(text: string) {
    const graph: unknown = JSON.parse(text);
    if (!record(graph)) throw new Error('Invalid action graph');
    this.fragments = table(records(graph.pathFragments));
    this.artifacts = table(records(graph.artifacts));
    this.sets = table(records(graph.depSetOfFiles));
    this.targets = table(records(graph.targets ?? []));
    this.configurations = table(records(graph.configuration ?? []));
    this.actions = engineActions(records(graph.actions));
    if (this.actions.length === 0) throw new Error('Action graph is empty');
    for (const action of this.actions) {
      for (const key of identities(action.outputIds)) {
        const name = this.artifactPath(key);
        const previous = this.producers.get(key) ?? this.outputPaths.get(name);
        if (previous !== undefined && !this.sharedAction(previous, action))
          throw new Error('Duplicate action output producer');
        this.producers.set(key, previous ?? action);
        this.outputPaths.set(name, previous ?? action);
        if (this.artifacts.get(key)?.isTreeArtifact === true) {
          this.trees.set(name, previous ?? action);
        }
      }
    }
  }

  private sharedAction(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
    if (!configuredAction(left) || !configuredAction(right) || left.actionKey !== right.actionKey)
      return false;
    const signature = (action: Record<string, unknown>): string => {
      const omitted = new Set(['targetId', 'inputDepSetIds', 'outputIds', 'primaryOutputId']);
      const fields = Object.fromEntries(
        Object.entries(action)
          .filter(([key]) => !omitted.has(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const artifacts = (keys: readonly number[]): readonly string[] =>
        keys
          .map((key) =>
            JSON.stringify({
              path: this.artifactPath(key),
              tree: this.artifacts.get(key)?.isTreeArtifact === true,
            }),
          )
          .sort();
      return JSON.stringify({
        fields,
        inputs: artifacts(this.actionInputs(action)),
        outputs: artifacts(identities(action.outputIds)),
        primary: this.artifactPath(id(action.primaryOutputId)),
      });
    };
    return signature(left) === signature(right);
  }

  private fragmentPath(key: number): string {
    const cached = this.paths.get(key);
    if (cached !== undefined) return cached;
    if (this.visiting.has(key)) throw new Error('Cyclic action graph path');
    const fragment = this.fragments.get(key);
    if (fragment === undefined) throw new Error('Missing action graph path');
    const label = fragment.label;
    if (
      typeof label !== 'string' ||
      label === '' ||
      label === '.' ||
      label === '..' ||
      label.includes('/') ||
      label.includes('\\') ||
      label.includes('\0')
    )
      throw new Error('Unsafe action graph path');
    this.visiting.add(key);
    const prefix =
      fragment.parentId === undefined ? '' : `${this.fragmentPath(id(fragment.parentId))}/`;
    this.visiting.delete(key);
    const result = prefix + label;
    this.paths.set(key, result);
    return result;
  }

  private artifactPath(key: number): string {
    const artifact = this.artifacts.get(key) as Artifact | undefined;
    if (artifact === undefined) throw new Error('Missing action graph artifact');
    return this.fragmentPath(id(artifact.pathFragmentId));
  }

  private actionInputs(action: Record<string, unknown>): readonly number[] {
    const artifacts = new Set<number>();
    const seen = new Set<number>();
    const active = new Set<number>();
    const visit = (key: number): void => {
      if (active.has(key)) throw new Error('Cyclic action graph input set');
      if (seen.has(key)) return;
      const set = this.sets.get(key);
      if (set === undefined) throw new Error('Missing action graph input set');
      active.add(key);
      for (const artifact of identities(set.directArtifactIds)) {
        this.artifactPath(artifact);
        artifacts.add(artifact);
      }
      for (const nested of identities(set.transitiveDepSetIds)) visit(nested);
      active.delete(key);
      seen.add(key);
    };
    for (const key of identities(action.inputDepSetIds)) visit(key);
    return [...artifacts];
  }

  sources(roots: readonly Record<string, unknown>[], nonceRepository?: string): readonly string[] {
    const sources = new Set<string>();
    const active = new Set<Record<string, unknown>>();
    const visit = (action: Record<string, unknown>): ReadonlySet<string> => {
      if (active.has(action)) throw new Error('Cyclic generated action dependency');
      const existing = this.sourceClosures.get(action);
      if (existing !== undefined) return existing;
      active.add(action);
      const closure = new Set<string>();
      for (const key of this.actionInputs(action)) {
        const name = this.artifactPath(key);
        let producer = this.producers.get(key) ?? this.outputPaths.get(name);
        if (producer === undefined) {
          const segments = name.split('/');
          for (let end = segments.length - 1; end > 0; end--) {
            producer = this.trees.get(segments.slice(0, end).join('/'));
            if (producer !== undefined) break;
          }
        }
        if (producer !== undefined) {
          for (const source of visit(producer)) closure.add(source);
        } else if (WORKSPACE_STATUS.has(name)) {
          // The engine writes these itself; aquery lists no action and they hold no source.
        } else if (name.startsWith('bazel-out/')) {
          throw new Error(`Incomplete action graph: missing producer for ${name}`);
        } else if (
          nonceRepository === undefined
            ? !name.startsWith('external/')
            : name.startsWith(`${nonceRepository}/`)
        )
          closure.add(name);
      }
      active.delete(action);
      this.sourceClosures.set(action, closure);
      return closure;
    };
    for (const root of roots) for (const source of visit(root)) sources.add(source);
    if (sources.size === 0 && nonceRepository === undefined)
      throw new Error('Action graph declares no first-party source inputs');
    return [...sources].sort();
  }
}

/** Read first-party bytes from a full aquery deps(set(...)) configured action graph. */
export function declaredSourcePaths(text: string): readonly string[] {
  const graph = new ActionGraph(text);
  return graph.sources(graph.actions);
}

/** Follow generated-artifact producers to every source read by each configured test action. */
export function testSourcePaths(
  text: string,
  labels: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  if (labels.length === 0 || new Set(labels).size !== labels.length) {
    throw new Error('Configured test inventory is empty or duplicated');
  }
  const graph = new ActionGraph(text);
  const runners = new Map<string, Record<string, unknown>[]>();
  for (const action of graph.actions) {
    if (action.mnemonic !== 'TestRunner') continue;
    const target = graph.targets.get(id(action.targetId));
    if (target === undefined || typeof target.label !== 'string') {
      throw new Error('Test action has no target identity');
    }
    const roots = runners.get(target.label) ?? [];
    roots.push(action);
    runners.set(target.label, roots);
  }
  return new Map(
    labels.map((label) => {
      const actions = runners.get(label);
      if (actions === undefined || actions.length !== 1) {
        throw new Error(`Expected exactly one configured test action for ${label}`);
      }
      return [label, graph.sources(actions)];
    }),
  );
}

/** Follow generated runfiles producers; aquery's structural actionKey omits input bytes. */
export function testNonceInputPaths(
  text: string,
  labels: readonly string[],
  repository: string,
): ReadonlyMap<string, string> {
  if (
    labels.length === 0 ||
    new Set(labels).size !== labels.length ||
    !/^external\/[^/\\\0]+$/.test(repository) ||
    ['.', '..'].includes(repository.slice('external/'.length))
  )
    throw new Error('Nonce binding requires a unique test inventory and exact repository path');
  const graph = new ActionGraph(text);
  const runners = new Map<string, string[]>();
  const owners = new Map<string, string>();
  for (const action of graph.actions) {
    const inputs = graph.sources([action], repository);
    if (action.mnemonic !== 'TestRunner' && inputs.length === 0) continue;
    const target = graph.targets.get(id(action.targetId));
    const label = target?.label;
    if (typeof label !== 'string' || !/^\/\/[^:\s\\\0]*:[^:\s\\\0]+$/.test(label))
      throw new Error('Nonce input has no canonical main-workspace test owner');
    const expected = `${repository}/nonce/${createHash('sha256').update(label).digest('hex')}.txt`;
    const configuration = graph.configurations.get(id(action.configurationId));
    const checksum = configuration?.checksum;
    if (
      !configuredAction(action, true) ||
      typeof checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(checksum) ||
      (configuration?.isTool !== undefined && configuration.isTool !== false) ||
      (owners.has(label) && owners.get(label) !== checksum) ||
      !['TestRunner', 'RunfilesTree'].includes(String(action.mnemonic)) ||
      inputs.length !== 1 ||
      inputs[0] !== expected
    )
      throw new Error(`Nonce must belong only to its test and runfiles tree: ${label}`);
    owners.set(label, checksum);
    if (action.mnemonic === 'TestRunner') {
      const paths = runners.get(label) ?? [];
      paths.push(expected);
      runners.set(label, paths);
    }
  }
  return new Map(
    labels.map((label) => {
      const paths = runners.get(label);
      const file = paths?.[0];
      if (paths?.length !== 1 || file === undefined)
        throw new Error(`Expected exactly one nonce-bound configured test action for ${label}`);
      return [label, file];
    }),
  );
}
