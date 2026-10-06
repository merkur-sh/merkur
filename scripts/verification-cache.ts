import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digestFiles, fileDigests } from './content-digest';
import type { GateDeps, GatePlan } from './select-gates';
import { testDependents } from './test-inventory';

/**
 * The verification result cache: which test files are already proven green for the exact
 * bytes they read.
 *
 * It exists because "has this diff been verified?" was not a fact anything could read. Every
 * run wrote to a fresh directory with no link to the tree it verified, so the only way to
 * answer was to run the gates again — after a compaction, after a subagent returned, after
 * any edit. The answer was never "re-run less"; it is that a re-run with nothing changed
 * costs nothing, so asking again is free.
 *
 * A test's inputs are its compiler-parsed import closure, which `testDependents` already
 * walks. What the closure cannot see — a fixture opened with `readFileSync` at runtime — is
 * handled by the caller passing `unclaimed`: a changed file the bun lane covers that no
 * closure names drops the whole cache for that run, because nothing here can prove which
 * test reads it.
 */

/** Bump when the key derivation changes; every prior entry stops matching. */
export const CACHE_VERSION = 'merkur-gate-cache-v1';

/** Files that change what every test run means, whatever the test imports. */
const GLOBAL_INPUTS: readonly string[] = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.base.json',
  'scripts/test-preload.ts',
  'scripts/verification-executor.ts',
  'scripts/verification-junit.ts',
];

export interface CacheEntry {
  readonly key: string;
  readonly ranAt: string;
}

export interface CacheFile {
  readonly version: string;
  readonly entries: Readonly<Record<string, CacheEntry>>;
}

export interface TestPartition {
  /** Tests whose inputs are not proven; these run. */
  readonly fresh: readonly string[];
  /** Tests already green for exactly these inputs; these do not. */
  readonly cached: readonly string[];
  readonly keys: ReadonlyMap<string, string>;
  /** Changed files the bun lane covers that no closure claims; any entry empties `cached`. */
  readonly unclaimed: readonly string[];
}

const EMPTY: CacheFile = { version: CACHE_VERSION, entries: {} };

export function cacheEnabled(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.MERKUR_GATE_CACHE !== '0';
}

export function cachePath(root: string): string {
  return path.join(root, 'test-results', 'verification', 'cache.json');
}

/** A cache that cannot be read, parsed, or whose version moved is an empty cache, never an error. */
export function readCache(root: string): CacheFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cachePath(root), 'utf8'));
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY;
  if (!('version' in parsed) || parsed.version !== CACHE_VERSION) return EMPTY;
  if (!('entries' in parsed) || typeof parsed.entries !== 'object' || parsed.entries === null)
    return EMPTY;
  const entries: Record<string, CacheEntry> = {};
  for (const [test, entry] of Object.entries(parsed.entries)) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (!('key' in entry) || typeof entry.key !== 'string') continue;
    const ranAt = 'ranAt' in entry && typeof entry.ranAt === 'string' ? entry.ranAt : '';
    entries[test] = { key: entry.key, ranAt };
  }
  return { version: CACHE_VERSION, entries };
}

export function globalInputDigest(root: string): string {
  return digestFiles(root, GLOBAL_INPUTS);
}

/**
 * One key per test: the bytes of everything it imports, plus the inputs no import names —
 * the toolchain that runs it and the workspace configuration that resolves it.
 */
export function testKeys(
  root: string,
  closures: ReadonlyMap<string, readonly string[]>,
  global: string = globalInputDigest(root),
  runtime: { readonly bun: string; readonly platform: string; readonly arch: string } = {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
  },
): Map<string, string> {
  const digest = fileDigests(root);
  const keys = new Map<string, string>();
  for (const [test, closure] of closures) {
    const hash = new Bun.CryptoHasher('sha256');
    hash.update(`${CACHE_VERSION}\0`);
    hash.update(JSON.stringify(runtime));
    hash.update(global);
    for (const file of [...closure].sort()) hash.update(JSON.stringify([file, digest(file)]));
    keys.set(test, hash.digest('hex'));
  }
  return keys;
}

/**
 * Split the selected tests into what must run and what is already proven.
 *
 * `bunInputs` are the changed files the bun lane is responsible for. One of them that no
 * closure names is a file this module cannot reason about, so every cached result is
 * discarded rather than trusted — the conservative direction, and the only one that stays
 * deterministic.
 */
export function partitionTests(
  selected: readonly string[],
  bunInputs: readonly string[],
  closures: ReadonlyMap<string, readonly string[]>,
  keys: ReadonlyMap<string, string>,
  cache: CacheFile,
): TestPartition {
  const claimed = new Set<string>();
  for (const closure of closures.values()) for (const file of closure) claimed.add(file);
  const unclaimed = bunInputs.filter((file) => !claimed.has(file)).sort();
  if (unclaimed.length > 0) return { fresh: [...selected], cached: [], keys, unclaimed };
  const fresh: string[] = [];
  const cached: string[] = [];
  for (const test of selected) {
    const key = keys.get(test);
    if (key !== undefined && cache.entries[test]?.key === key) cached.push(test);
    else fresh.push(test);
  }
  return { fresh, cached, keys, unclaimed };
}

/**
 * The partition for one plan, the single entry point both the printed plan and the executor
 * use. With the cache off every selected test is fresh, so the printed plan stays honest
 * about what `--force` is going to do.
 */
export function planPartition(root: string, plan: GatePlan, deps?: GateDeps): TestPartition {
  if (!cacheEnabled() || plan.tests.length === 0)
    return { fresh: [...plan.tests], cached: [], keys: new Map(), unclaimed: [] };
  // `gates` has already walked every test's closure; the other entry points select no files,
  // so the plan's own tests are the whole graph they need.
  const closures = deps?.testClosures ?? testDependents(root, plan.tests).closures;
  const keys = testKeys(root, closures);
  return partitionTests(plan.tests, plan.bunInputs, closures, keys, readCache(root));
}

/** Record files whose complete runner results passed, even when another file failed. */
export function recordGreen(
  root: string,
  tests: readonly string[],
  keys: ReadonlyMap<string, string>,
  attempted: readonly string[] = tests,
): void {
  if (attempted.length === 0) return;
  const current = readCache(root);
  const entries: Record<string, CacheEntry> = { ...current.entries };
  for (const test of attempted) delete entries[test];
  const ranAt = new Date().toISOString();
  for (const test of tests) {
    const key = keys.get(test);
    if (key !== undefined) entries[test] = { key, ranAt };
  }
  const file = cachePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: CACHE_VERSION, entries }, null, 2)}\n`);
}
