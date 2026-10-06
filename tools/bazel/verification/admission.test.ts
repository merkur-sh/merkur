import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitSourceInputs } from './admission';
import { captureGitContext } from './git-context';
import { manifestFromInventory } from './snapshot';

const head = 'a'.repeat(40);

function git(tracked: readonly string[]) {
  return captureGitContext(
    (args) => {
      if (args[0] === 'rev-parse') return `${head}\n`;
      if (args.includes('-v')) return tracked.map((name) => `H ${name}\0`).join('');
      if (args.includes('--stage')) {
        return tracked.map((name) => `100644 ${head} 0\t${name}\0`).join('');
      }
      return '';
    },
    head,
    head,
  );
}

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-admission-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('tracked inputs need no admission; declared untracked bytes require exact approval', () => {
  fixture((root) => {
    writeFileSync(path.join(root, 'tracked.ts'), 'export const tracked = 1;');
    writeFileSync(path.join(root, 'local.json'), '{"private":"local input"}');
    const manifest = manifestFromInventory(root, ['tracked.ts', 'local.json'], head);
    const context = git(['tracked.ts']);
    expect(() => admitSourceInputs(manifest, context, [])).toThrow('local.json');
    expect(admitSourceInputs(manifest, context, ['local.json'])).toEqual(['local.json']);
  });
});

test('a tracked file symlink does not approve its ignored physical referent', () => {
  fixture((root) => {
    writeFileSync(path.join(root, 'private.json'), 'private fixture bytes');
    symlinkSync('private.json', path.join(root, 'input.json'));
    const manifest = manifestFromInventory(root, ['input.json'], head);
    const context = git(['input.json']);
    expect(() => admitSourceInputs(manifest, context, [])).toThrow('private.json');
    expect(admitSourceInputs(manifest, context, ['private.json'])).toEqual(['private.json']);
  });
});

test('parent aliases admit their physical tracked bytes and each link separately', () => {
  fixture((root) => {
    mkdirSync(path.join(root, 'actual'));
    writeFileSync(path.join(root, 'actual', 'source.ts'), 'export const source = 1;');
    symlinkSync('actual', path.join(root, 'alias'));
    const manifest = manifestFromInventory(root, ['alias/source.ts'], head);
    expect(admitSourceInputs(manifest, git(['actual/source.ts', 'alias']), [])).toEqual([]);
    expect(() => admitSourceInputs(manifest, git(['actual/source.ts']), [])).toThrow('alias');
    expect(admitSourceInputs(manifest, git(['actual/source.ts']), ['alias'])).toEqual(['alias']);
  });
});

test('directory inputs cannot implicitly upload untracked descendants', () => {
  fixture((root) => {
    mkdirSync(path.join(root, 'source'));
    writeFileSync(path.join(root, 'source', 'tracked.ts'), 'tracked');
    writeFileSync(path.join(root, 'source', 'private.txt'), 'private fixture');
    const manifest = manifestFromInventory(root, ['source'], head);
    const context = git(['source/tracked.ts']);
    expect(() => admitSourceInputs(manifest, context, ['source'])).toThrow('source/private.txt');
    expect(admitSourceInputs(manifest, context, ['source/private.txt'])).toEqual([
      'source/private.txt',
    ]);
  });
});

test('reserved engine namespaces, invalid facts and duplicate approvals fail closed', () => {
  fixture((root) => {
    writeFileSync(path.join(root, 'source.ts'), 'source');
    const manifest = manifestFromInventory(root, ['source.ts'], head);
    const context = git([]);
    expect(() => admitSourceInputs(manifest, context, ['source.ts', 'source.ts'])).toThrow(
      'Duplicate source admission',
    );
    expect(() => admitSourceInputs(manifest, context, ['external/source.ts'])).toThrow('reserved');
    expect(() => admitSourceInputs(manifest, { ...context, digest: '' }, ['source.ts'])).toThrow(
      'invalid Git context',
    );
    expect(() => admitSourceInputs({ ...manifest, digest: '' }, context, ['source.ts'])).toThrow(
      'invalid source manifest',
    );
  });
});
