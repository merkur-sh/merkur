import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { manifestFromInventory } from './snapshot';

/**
 * The files Bazel 9.2 reads by name while it loads packages and modules. A source file of any
 * other name reaches the engine only as an action input, which analysis never opens.
 */
const LOADING_FILE =
  /(?:^|\/)(?:BUILD|BUILD\.bazel|MODULE\.bazel|MODULE\.bazel\.lock|REPO\.bazel|WORKSPACE|WORKSPACE\.bazel|WORKSPACE\.bzlmod|\.bazelignore)$|^platform_mappings$|\.(?:bzl|scl|MODULE\.bazel)$/;

/** The planning steps read this file themselves, beside the engine. */
const QUALIFICATION = '.github/bazel/qualification.json';

/** A record's key names a workspace path when it starts with the main repository. */
const WORKSPACE = '@@//';

/**
 * The workspace files the engine's records name. Bazel writes a `KIND:key value` record for
 * every input a repository rule or module extension reads; a workspace file is
 * `FILE:@@//path digest`. A workspace record of any other kind (a directory listing or tree),
 * or a path Bazel had to escape, is one this reader cannot bind to bytes: the answer is then
 * `undefined`.
 */
function recordedWorkspaceFiles(records: readonly string[]): readonly string[] | undefined {
  const files: string[] = [];
  for (const record of records) {
    const separator = record.indexOf(':');
    if (separator === -1 || !record.startsWith(WORKSPACE, separator + 1)) continue;
    const end = record.lastIndexOf(' ');
    const file = record.slice(separator + 1 + WORKSPACE.length, end === -1 ? undefined : end);
    if (
      record.slice(0, separator) !== 'FILE' ||
      end === -1 ||
      file === '' ||
      file.includes('\\') ||
      file.includes(' ')
    )
      return undefined;
    files.push(file);
  }
  return files;
}

function lockRecords(text: string): readonly string[] | undefined {
  const lock: unknown = JSON.parse(text);
  if (lock === null || typeof lock !== 'object' || !('moduleExtensions' in lock)) return undefined;
  const records: string[] = [];
  const extensions = lock.moduleExtensions;
  if (extensions === null || typeof extensions !== 'object') return undefined;
  for (const evaluations of Object.values(extensions)) {
    if (evaluations === null || typeof evaluations !== 'object') return undefined;
    for (const evaluation of Object.values(evaluations)) {
      if (evaluation === null || typeof evaluation !== 'object') return undefined;
      const recorded: unknown = 'recordedInputs' in evaluation ? evaluation.recordedInputs : [];
      if (!Array.isArray(recorded) || recorded.some((entry) => typeof entry !== 'string'))
        return undefined;
      records.push(...recorded);
    }
  }
  return records;
}

/** Every repository marker under the output bases an engine home holds. */
function markerRecords(engineRoot: string): readonly string[] {
  const records: string[] = [];
  let bases: string[];
  try {
    bases = readdirSync(engineRoot);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return records;
    throw error;
  }
  for (const base of bases.sort()) {
    const external = path.join(engineRoot, base, 'external');
    let names: string[];
    try {
      names = readdirSync(external);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        continue;
      throw error;
    }
    for (const name of names.sort())
      if (name.endsWith('.marker'))
        records.push(...readFileSync(path.join(external, name), 'utf8').split('\n'));
  }
  return records;
}

/**
 * The captured paths whose bytes decide what the engine loads and analyses: the files it reads
 * by name, and every workspace file it recorded reading for a repository rule or a module
 * extension. `lock` is the text of `MODULE.bazel.lock`; `engineRoot` holds the output bases of
 * the engine that answers. `undefined` when a record names an input this reader cannot bind.
 */
function loadingInputs(options: {
  readonly paths: readonly string[];
  readonly lock: string;
  readonly engineRoot: string;
}): readonly string[] | undefined {
  const locked = lockRecords(options.lock);
  if (locked === undefined) return undefined;
  const recorded = recordedWorkspaceFiles([...locked, ...markerRecords(options.engineRoot)]);
  if (recorded === undefined) return undefined;
  return [
    ...new Set([
      ...options.paths.filter((file) => LOADING_FILE.test(file)),
      QUALIFICATION,
      ...recorded,
    ]),
  ].sort();
}

/** Which captured path `root` holds, without its bytes: what a glob or a package sees. */
function capturedEntry(root: string, file: string): readonly string[] {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path.join(root, file));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return [file, 'missing'];
    throw error;
  }
  if (info.isSymbolicLink()) return [file, 'symlink', readlinkSync(path.join(root, file))];
  return [file, info.isDirectory() ? 'directory' : 'file'];
}

/**
 * Everything in `root` a planning answer depends on: which of the captured `paths` it holds,
 * and the bytes of its loading inputs. Any other source file reaches the engine only as an
 * action input, and a planning answer holds no action's result.
 */
export function loadingFacts(options: {
  readonly root: string;
  readonly paths: readonly string[];
  readonly engineRoot: string;
}): { readonly paths: readonly (readonly string[])[]; readonly loading: string } | undefined {
  const loading = loadingInputs({
    paths: options.paths,
    lock: readFileSync(path.join(options.root, 'MODULE.bazel.lock'), 'utf8'),
    engineRoot: options.engineRoot,
  });
  if (loading === undefined) return undefined;
  return {
    paths: options.paths.map((file) => capturedEntry(options.root, file)),
    loading: manifestFromInventory(options.root, loading, '').digest,
  };
}
