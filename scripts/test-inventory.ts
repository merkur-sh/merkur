import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';

export const TEST_ROOTS = ['apps', 'packages', 'scripts', 'tests'] as const;
const OUTPUT_DIRECTORIES = new Set(['node_modules', 'dist', 'target', '.git', 'test-results']);
const TEST_NAME = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** Source ownership, independent of Git tracking and generated release copies. */
export function discoverTests(root: string): string[] {
  const files: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (OUTPUT_DIRECTORIES.has(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && TEST_NAME.test(entry.name)) files.push(file);
    }
  }
  for (const directory of TEST_ROOTS) if (existsSync(path.join(root, directory))) visit(directory);
  return files.sort();
}

/**
 * Worker processes for the bun lane. Measured on 14 cores against the full inventory: 4 took
 * 23 s and 8 took 15 s, while 12 lost to contention (61 s, twenty 5-second timeouts).
 */
const TEST_WORKERS = 8;

export function testCommand(files: readonly string[]): readonly string[] {
  if (files.length === 0) throw new Error('Refusing an empty test selection');
  return [
    'bun',
    'test',
    `--parallel=${Math.min(TEST_WORKERS, availableParallelism())}`,
    ...[...new Set(files)].sort().map((file) => `./${file}`),
  ];
}

/** A file's resolved imports, split by whether the graph walk continues through them. */
interface Resolved {
  /** Source the walk recurses into, and whose own imports are therefore edges too. */
  readonly modules: readonly string[];
  /** Imported bytes with no imports of their own: WASM, JSON, CSS. */
  readonly assets: readonly string[];
}

export interface TestGraph {
  /**
   * Source file → the tests whose import closure reaches it. Gate selection reads this, so
   * it holds modules only: an asset selects its owning suite through the directory rule.
   */
  readonly owners: ReadonlyMap<string, readonly string[]>;
  /**
   * Test file → every repo file its closure reaches, itself and its assets included. This
   * is the input set of one test, which is what the verification cache keys on.
   */
  readonly closures: ReadonlyMap<string, readonly string[]>;
}

/** Compiler-parsed import closure, including literal dynamic imports and workspace aliases. */
export function testDependents(root: string, tests: readonly string[]): TestGraph {
  root = realpathSync(root);
  const ts = new Bun.Transpiler({ loader: 'ts' });
  const tsx = new Bun.Transpiler({ loader: 'tsx' });
  const imports = new Map<string, Resolved>();
  const owners = new Map<string, string[]>();
  const closures = new Map<string, readonly string[]>();
  function dependencies(file: string): Resolved {
    const cached = imports.get(file);
    if (cached !== undefined) return cached;
    const absolute = path.join(root, file);
    const modules: string[] = [];
    const assets: string[] = [];
    const parser = /\.[jt]sx$/.test(file) ? tsx : ts;
    for (const item of parser.scan(readFileSync(absolute, 'utf8')).imports) {
      let resolved: string;
      try {
        resolved = Bun.resolveSync(item.path, path.dirname(absolute));
      } catch {
        continue;
      } // Missing imports remain type/build errors, not graph edges.
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || relative.split(path.sep).includes('node_modules')) continue;
      if (/\.[cm]?[jt]sx?$/.test(relative)) modules.push(relative);
      else assets.push(relative);
    }
    const found: Resolved = { modules, assets };
    imports.set(file, found);
    return found;
  }
  for (const test of tests) {
    const visited = new Set<string>();
    function visit(file: string) {
      if (visited.has(file)) return;
      visited.add(file);
      const list = owners.get(file) ?? [];
      list.push(test);
      owners.set(file, list);
      const resolved = dependencies(file);
      for (const asset of resolved.assets) visited.add(asset);
      for (const dependency of resolved.modules) visit(dependency);
    }
    visit(test);
    closures.set(test, [...visited].sort());
  }
  return { owners, closures };
}
