import { createHash } from 'node:crypto';

export interface IndexEntry {
  readonly path: string;
  readonly mode: string;
  readonly object: string;
}

export interface GitContext {
  readonly base: string;
  readonly candidate: string;
  readonly head: string;
  readonly baseTree: string;
  readonly candidateTree: string;
  readonly index: readonly IndexEntry[];
  readonly untracked: readonly string[];
  readonly committed: readonly string[];
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly changed: readonly string[];
  readonly digest: string;
}

export type GitReader = (args: readonly string[]) => string;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error('Git context requires a full immutable object identity');
  }
  return value;
}

function sourcePath(value: string): string {
  if (
    value === '' ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Git context contains an unsafe source path');
  }
  return value;
}

function records(value: string): string[] {
  if (value === '') return [];
  if (!value.endsWith('\0')) throw new Error('Git context contains truncated NUL records');
  return value.slice(0, -1).split('\0');
}

function paths(value: string): string[] {
  const result = records(value).map(sourcePath).sort();
  if (new Set(result).size !== result.length) throw new Error('Duplicate Git context path');
  return result;
}

function indexEntries(value: string): IndexEntry[] {
  const entries = records(value).map((row) => {
    const separator = row.indexOf('\t');
    if (separator < 0) throw new Error('Malformed Git index record');
    const header = row.slice(0, separator).split(' ');
    const mode = header[0];
    const identity = header[1];
    if (
      header.length !== 3 ||
      !['100644', '100755', '120000', '160000'].includes(mode ?? '') ||
      identity === undefined ||
      mode === undefined
    ) {
      throw new Error('Malformed Git index identity');
    }
    if (header[2] !== '0') throw new Error('Git index contains unresolved merge entries');
    return { path: sourcePath(row.slice(separator + 1)), mode, object: object(identity) };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('Duplicate Git index entry');
  }
  return entries;
}

export function validGitContext(value: unknown): value is GitContext {
  if (!record(value) || !Array.isArray(value.index)) return false;
  const captured = value;
  try {
    function identity(value: unknown): string {
      if (typeof value !== 'string') throw new Error('Invalid Git identity type');
      return object(value);
    }
    const base = identity(value.base);
    const candidate = identity(value.candidate);
    const head = identity(value.head);
    const baseTree = identity(value.baseTree);
    const candidateTree = identity(value.candidateTree);
    const index = value.index.map((entry) => {
      if (!record(entry) || typeof entry.path !== 'string' || typeof entry.object !== 'string') {
        throw new Error('Invalid index');
      }
      if (
        typeof entry.mode !== 'string' ||
        !['100644', '100755', '120000', '160000'].includes(entry.mode)
      ) {
        throw new Error('Invalid index mode');
      }
      return { path: sourcePath(entry.path), mode: entry.mode, object: object(entry.object) };
    });
    const names = index.map((entry) => entry.path);
    if (
      new Set(names).size !== names.length ||
      JSON.stringify(names) !== JSON.stringify([...names].sort())
    ) {
      return false;
    }
    function list(name: string): string[] {
      const values = captured[name];
      if (!Array.isArray(values) || !values.every((entry) => typeof entry === 'string')) {
        throw new Error('Invalid Git path list');
      }
      const result = values.map(sourcePath);
      if (
        new Set(result).size !== result.length ||
        JSON.stringify(result) !== JSON.stringify([...result].sort())
      ) {
        throw new Error('Noncanonical Git path list');
      }
      return result;
    }
    const untracked = list('untracked');
    const committed = list('committed');
    const staged = list('staged');
    const unstaged = list('unstaged');
    const changed = list('changed');
    if (
      staged.some((name) => unstaged.includes(name)) ||
      untracked.some((name) => names.includes(name))
    ) {
      return false;
    }
    const union = [...new Set([...committed, ...staged, ...unstaged, ...untracked])].sort();
    if (JSON.stringify(union) !== JSON.stringify(changed)) return false;
    const facts = {
      base,
      candidate,
      head,
      baseTree,
      candidateTree,
      index,
      untracked,
      committed,
      staged,
      unstaged,
      changed,
    };
    return value.digest === createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  } catch {
    return false;
  }
}

/** Read fresh Git facts; the caller supplies the declared, isolated Git command adapter. */
export function captureGitContext(
  read: GitReader,
  base: string,
  candidate: string,
  indexOnly = false,
): GitContext {
  object(base);
  object(candidate);
  function resolve(identity: string): string {
    const result = read(['rev-parse', '--verify', `${identity}^{commit}`]).trim();
    if (object(result) !== identity) throw new Error('Git commit identity changed during capture');
    return result;
  }
  resolve(base);
  resolve(candidate);
  const head = object(read(['rev-parse', '--verify', 'HEAD^{commit}']).trim());
  const baseTree = object(read(['rev-parse', '--verify', `${base}^{tree}`]).trim());
  const candidateTree = object(read(['rev-parse', '--verify', `${candidate}^{tree}`]).trim());
  if (indexOnly && (base !== head || candidate !== head))
    throw new Error('Staged verification compares the current index against its exact HEAD');
  const index = indexEntries(read(['ls-files', '--stage', '-z']));
  function checkedIndexFlags(): string[] {
    const marked = records(read(['ls-files', '--cached', '-v', '-z']));
    const names = marked
      .map((row) => {
        if (!row.startsWith('H ')) {
          throw new Error('Git index visibility flags cannot hide source changes');
        }
        return sourcePath(row.slice(2));
      })
      .sort();
    if (JSON.stringify(names) !== JSON.stringify(index.map((entry) => entry.path))) {
      throw new Error('Git index ownership changed during capture');
    }
    return names;
  }
  const indexFlags = checkedIndexFlags();
  const untracked = indexOnly
    ? []
    : paths(read(['ls-files', '--others', '--exclude-standard', '-z']));
  const diffOptions = [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
  ];
  const committed = paths(read([...diffOptions, base, candidate, '--']));
  const staged = paths(read([...diffOptions, '--cached', candidate, '--']));
  const unstaged = indexOnly ? [] : paths(read([...diffOptions, '--']));
  // Git commands read independent views. Reject any changed fact before returning a capture;
  // the frontend also repeats this capture after snapshot materialization and execution.
  const finalIndex = indexEntries(read(['ls-files', '--stage', '-z']));
  const finalUntracked = indexOnly
    ? []
    : paths(read(['ls-files', '--others', '--exclude-standard', '-z']));
  const finalStaged = paths(read([...diffOptions, '--cached', candidate, '--']));
  const finalUnstaged = indexOnly ? [] : paths(read([...diffOptions, '--']));
  const finalHead = object(read(['rev-parse', '--verify', 'HEAD^{commit}']).trim());
  const finalBaseTree = object(read(['rev-parse', '--verify', `${base}^{tree}`]).trim());
  const finalCandidateTree = object(read(['rev-parse', '--verify', `${candidate}^{tree}`]).trim());
  const finalCommitted = paths(read([...diffOptions, base, candidate, '--']));
  const finalIndexFlags = checkedIndexFlags();
  if (
    head !== finalHead ||
    baseTree !== finalBaseTree ||
    candidateTree !== finalCandidateTree ||
    JSON.stringify([committed, indexFlags]) !== JSON.stringify([finalCommitted, finalIndexFlags]) ||
    JSON.stringify([index, untracked, staged, unstaged]) !==
      JSON.stringify([finalIndex, finalUntracked, finalStaged, finalUnstaged])
  ) {
    throw new Error('Git context changed during capture');
  }
  const partiallyStaged = staged.filter((name) => unstaged.includes(name));
  if (partiallyStaged.length > 0) {
    throw new Error(
      `Partially staged files cannot satisfy the live ratchet: ${partiallyStaged.join(', ')}`,
    );
  }
  const facts = {
    base,
    candidate,
    head,
    baseTree,
    candidateTree,
    index,
    untracked,
    committed,
    staged,
    unstaged,
    changed: [...new Set([...committed, ...staged, ...unstaged, ...untracked])].sort(),
  };
  return {
    ...facts,
    digest: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
  };
}
