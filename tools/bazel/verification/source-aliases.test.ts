import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCapturedDocsAliases } from './docs';
import { captureGitContext } from './git-context';
import { manifestFromInventory, type SourceManifest } from './snapshot';
import { restoreSourceAliases } from './source-aliases';

function fixture(run: (source: string, copy: string, aliases: SourceManifest) => void): void {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'merkur-source-aliases-'));
  const source = path.join(parent, 'source');
  const copy = path.join(parent, 'copy');
  mkdirSync(path.join(source, 'actual'), { recursive: true });
  mkdirSync(copy);
  writeFileSync(path.join(source, 'actual', 'prose.md'), 'declared prose', { mode: 0o644 });
  symlinkSync('actual', path.join(source, 'alias'));
  cpSync(path.join(source, 'actual'), path.join(copy, 'actual'), { recursive: true });
  const aliases = manifestFromInventory(source, ['alias'], 'a'.repeat(40));
  try {
    run(source, copy, aliases);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('captured directory aliases restore exact target and logical file modes in a private copy', () => {
  fixture((source, copy) => {
    chmodSync(path.join(source, 'actual'), 0o700);
    chmodSync(path.join(copy, 'actual'), 0o755);
    const aliases = manifestFromInventory(source, ['alias'], 'a'.repeat(40));
    restoreSourceAliases(copy, aliases);
    expect(readlinkSync(path.join(copy, 'alias'))).toBe('actual');
    expect(statSync(path.join(copy, 'alias', 'prose.md')).mode & 0o777).toBe(0o644);
    expect(statSync(path.join(copy, 'alias')).mode & 0o777).toBe(0o700);
  });
});

test('alias chains restore complete captured referents before aliases in lexical order', () => {
  fixture((source, copy) => {
    symlinkSync('actual/prose.md', path.join(source, 'middle'));
    symlinkSync('middle', path.join(source, 'first'));
    const aliases = manifestFromInventory(source, ['first', 'middle'], 'a'.repeat(40));
    restoreSourceAliases(copy, aliases);
    expect(readlinkSync(path.join(copy, 'first'))).toBe('middle');
    expect(readlinkSync(path.join(copy, 'middle'))).toBe('actual/prose.md');
    expect(statSync(path.join(copy, 'first')).isFile()).toBe(true);
  });
});

test('directory aliases restore captured nested aliases without omitting referent inventory', () => {
  fixture((source, copy) => {
    symlinkSync('prose.md', path.join(source, 'actual', 'nested'));
    const aliases = manifestFromInventory(source, ['alias'], 'a'.repeat(40));
    restoreSourceAliases(copy, aliases);
    expect(readlinkSync(path.join(copy, 'alias', 'nested'))).toBe('prose.md');
    expect(statSync(path.join(copy, 'alias', 'nested')).isFile()).toBe(true);
  });
});

test('missing, extra and changed referent bytes cannot restore an alias', () => {
  for (const mutation of ['missing', 'extra', 'changed']) {
    fixture((source, copy, aliases) => {
      if (mutation === 'missing') rmSync(path.join(copy, 'actual', 'prose.md'));
      else if (mutation === 'extra') writeFileSync(path.join(copy, 'actual', 'extra.md'), 'extra');
      else writeFileSync(path.join(copy, 'actual', 'prose.md'), 'different');
      expect(() => restoreSourceAliases(copy, aliases)).toThrow();
      expect(readlinkSync(path.join(source, 'alias'))).toBe('actual');
    });
  }
});

test('alias restoration cannot mutate the captured workspace or redirect to a different referent', () => {
  fixture((source, copy, aliases) => {
    expect(() => restoreSourceAliases(source, aliases)).toThrow('private copy');
    const first = aliases.inputs[0];
    if (first === undefined) throw new Error('Fixture alias missing');
    const input = { ...first, target: 'other' };
    input.digest = createHash('sha256')
      .update(JSON.stringify({ target: input.target, referent: input.referent }))
      .digest('hex');
    const forged = {
      ...aliases,
      inputs: [input],
      digest: createHash('sha256')
        .update(JSON.stringify([input]))
        .digest('hex'),
    };
    expect(() => restoreSourceAliases(copy, forged)).toThrow('does not match');
  });
});

function capturedAliasContext(paths: readonly string[]) {
  const head = 'a'.repeat(40);
  return captureGitContext(
    (args) => {
      if (args[0] === 'rev-parse') return `${head}\n`;
      if (args.includes('--stage'))
        return paths.map((name) => `120000 ${head} 0\t${name}\0`).join('');
      if (args.includes('-v')) return paths.map((name) => `H ${name}\0`).join('');
      return '';
    },
    head,
    head,
  );
}

test('documentation validates already reconstructed aliases without mutating original or private bytes', () => {
  fixture((source, copy, aliases) => {
    restoreSourceAliases(copy, aliases);
    const before = statSync(path.join(copy, 'actual/prose.md'));
    validateCapturedDocsAliases(copy, capturedAliasContext(['alias']), aliases);
    expect(readlinkSync(path.join(copy, 'alias'))).toBe('actual');
    expect(readlinkSync(path.join(source, 'alias'))).toBe('actual');
    expect(statSync(path.join(copy, 'actual/prose.md')).mtimeMs).toBe(before.mtimeMs);
    expect(manifestFromInventory(copy, ['alias'], aliases.commit).digest).toBe(aliases.digest);
  });
});

test('documentation refuses changed aliases, referent bytes or modes and mismatched captured index', () => {
  for (const mutation of ['alias', 'bytes', 'mode', 'index', 'head']) {
    fixture((_source, copy, aliases) => {
      restoreSourceAliases(copy, aliases);
      if (mutation === 'alias') {
        rmSync(path.join(copy, 'alias'));
        symlinkSync('actual/prose.md', path.join(copy, 'alias'));
      }
      if (mutation === 'bytes') writeFileSync(path.join(copy, 'actual/prose.md'), 'different');
      if (mutation === 'mode') chmodSync(path.join(copy, 'actual/prose.md'), 0o755);
      const context = capturedAliasContext(mutation === 'index' ? [] : ['alias']);
      const captured = mutation === 'head' ? { ...aliases, commit: 'b'.repeat(40) } : aliases;
      expect(() => validateCapturedDocsAliases(copy, context, captured)).toThrow('captured');
    });
  }
});
