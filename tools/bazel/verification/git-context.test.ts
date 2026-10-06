import { expect, test } from 'bun:test';
import { captureGitContext, type GitReader, validGitContext } from './git-context';

const base = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const blob = 'c'.repeat(40);

function reader(overrides: ReadonlyMap<string, string> = new Map()): GitReader {
  const responses = new Map<string, string>([
    [`rev-parse --verify ${base}^{commit}`, `${base}\n`],
    [`rev-parse --verify ${candidate}^{commit}`, `${candidate}\n`],
    ['rev-parse --verify HEAD^{commit}', `${candidate}\n`],
    [`rev-parse --verify ${base}^{tree}`, `${'d'.repeat(40)}\n`],
    [`rev-parse --verify ${candidate}^{tree}`, `${'e'.repeat(40)}\n`],
    ['ls-files --stage -z', `100755 ${blob} 0\tscripts/run.sh\0`],
    ['ls-files --cached -v -z', 'H scripts/run.sh\0'],
    ['ls-files --others --exclude-standard -z', 'new file.ts\0'],
    [
      `diff --name-only -z --no-renames --no-ext-diff --no-textconv ${base} ${candidate} --`,
      'deleted.ts\0renamed source.ts\0',
    ],
    [
      `diff --name-only -z --no-renames --no-ext-diff --no-textconv --cached ${candidate} --`,
      'staged.ts\0',
    ],
    ['diff --name-only -z --no-renames --no-ext-diff --no-textconv --', 'unstaged.ts\0'],
  ]);
  return (args) => {
    const key = args.join(' ');
    const result = overrides.get(key) ?? responses.get(key);
    if (result === undefined) throw new Error(`Unexpected Git query: ${key}`);
    return result;
  };
}

test('captures explicit commits, index modes and every ownership change without rename loss', () => {
  const result = captureGitContext(reader(), base, candidate);
  expect(result.base).toBe(base);
  expect(result.candidate).toBe(candidate);
  expect(result.index).toEqual([{ path: 'scripts/run.sh', mode: '100755', object: blob }]);
  expect(result.changed).toEqual([
    'deleted.ts',
    'new file.ts',
    'renamed source.ts',
    'staged.ts',
    'unstaged.ts',
  ]);
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(captureGitContext(reader(), base, candidate).digest).toBe(result.digest);
});

test('index mode and untracked admission each change the live context identity', () => {
  const original = captureGitContext(reader(), base, candidate);
  for (const overrides of [
    new Map([['ls-files --stage -z', `100644 ${blob} 0\tscripts/run.sh\0`]]),
    new Map([['ls-files --others --exclude-standard -z', 'another.ts\0']]),
  ]) {
    expect(captureGitContext(reader(overrides), base, candidate).digest).not.toBe(original.digest);
  }
});

test('live context validation rejects altered inventories and coerced identities', () => {
  const context = captureGitContext(reader(), base, candidate);
  expect(validGitContext(context)).toBe(true);
  for (const invalid of [
    { ...context, digest: '' },
    { ...context, changed: [] },
    { ...context, index: [...context.index, ...context.index] },
    { ...context, untracked: [...context.untracked, ...context.untracked] },
    { ...context, candidate: null },
  ]) {
    expect(validGitContext(invalid)).toBe(false);
  }
  let coerced = false;
  const invalid = {
    ...context,
    base: {
      toString() {
        coerced = true;
        return base;
      },
    },
  };
  expect(validGitContext(invalid)).toBe(false);
  expect(coerced).toBe(false);
});

test('partially staged and unresolved merge states cannot satisfy the live ratchet', () => {
  expect(() =>
    captureGitContext(
      reader(
        new Map([
          ['diff --name-only -z --no-renames --no-ext-diff --no-textconv --', 'staged.ts\0'],
        ]),
      ),
      base,
      candidate,
    ),
  ).toThrow('Partially staged');
  expect(() =>
    captureGitContext(
      reader(new Map([['ls-files --stage -z', `100644 ${blob} 2\tconflict.ts\0`]])),
      base,
      candidate,
    ),
  ).toThrow('unresolved merge');
});

test('NUL records preserve tabs and newlines in source paths', () => {
  const name = 'directory/a\tb\nc.ts';
  const result = captureGitContext(
    reader(
      new Map([
        ['ls-files --stage -z', `120000 ${blob} 0\t${name}\0`],
        ['ls-files --cached -v -z', `H ${name}\0`],
      ]),
    ),
    base,
    candidate,
  );
  expect(result.index[0]?.path).toBe(name);
});

test('an index mutation between Git queries cannot produce an accepted live capture', () => {
  const stable = reader();
  let indexReads = 0;
  const changing: GitReader = (args) => {
    if (args.join(' ') === 'ls-files --stage -z' && ++indexReads === 2) {
      return `100755 ${'f'.repeat(40)} 0\tscripts/run.sh\0`;
    }
    return stable(args);
  };
  expect(() => captureGitContext(changing, base, candidate)).toThrow('changed during capture');
});

test('assume-unchanged and skip-worktree cannot hide changed source from coverage', () => {
  for (const marker of ['h', 'S']) {
    expect(() =>
      captureGitContext(
        reader(new Map([['ls-files --cached -v -z', `${marker} scripts/run.sh\0`]])),
        base,
        candidate,
      ),
    ).toThrow('visibility flags');
  }
});

test('mutable references, truncated records and unsafe or duplicate paths fail closed', () => {
  expect(() => captureGitContext(reader(), 'main', candidate)).toThrow('immutable object');
  for (const value of ['a.ts', '../escape\0', 'a.ts\0a.ts\0', '/absolute\0']) {
    expect(() =>
      captureGitContext(
        reader(new Map([['ls-files --others --exclude-standard -z', value]])),
        base,
        candidate,
      ),
    ).toThrow();
  }
  expect(() =>
    captureGitContext(
      reader(new Map([[`rev-parse --verify ${base}^{commit}`, `${candidate}\n`]])),
      base,
      candidate,
    ),
  ).toThrow('identity changed');
});
