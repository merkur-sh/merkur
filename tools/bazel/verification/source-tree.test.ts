import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manifestFromInventory } from './snapshot';
import { capturedSourcePayload, withCapturedSourceTree } from './source-tree';

async function fixture(run: (parent: string) => Promise<void>): Promise<void> {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'merkur-source-tree-'));
  try {
    await run(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('declared bytes restore modes, empty directories and complete alias referents without live source', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const tree = path.join(parent, 'tree');
    const root = path.join(parent, 'private');
    for (const directory of [source, tree, root]) mkdirSync(directory);
    mkdirSync(path.join(source, 'physical/empty'), { recursive: true });
    writeFileSync(path.join(source, 'physical/run'), 'captured bytes', { mode: 0o750 });
    chmodSync(path.join(source, 'physical'), 0o700);
    symlinkSync('physical', path.join(source, 'alias'));
    const manifest = manifestFromInventory(source, ['alias', 'absent'], 'commit');
    mkdirSync(path.join(tree, 'physical'));
    writeFileSync(path.join(tree, 'physical/run'), 'captured bytes', { mode: 0o444 });
    rmSync(source, { recursive: true });
    await withCapturedSourceTree({ tree, root, source: manifest }, async (captured) => {
      expect(readFileSync(path.join(captured, 'alias/run'), 'utf8')).toBe('captured bytes');
      expect(readlinkSync(path.join(captured, 'alias'))).toBe('physical');
      expect(statSync(path.join(captured, 'physical')).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(captured, 'physical/run')).mode & 0o777).toBe(0o750);
      expect(readdirSync(path.join(captured, 'physical/empty'))).toEqual([]);
      expect(existsSync(path.join(captured, 'absent'))).toBe(false);
      return undefined;
    });
    expect(readdirSync(root)).toEqual([]);
  });
});

test('incomplete or corrupted declared bytes cannot run the consumer and leave no owned files', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const tree = path.join(parent, 'tree');
    const root = path.join(parent, 'private');
    for (const directory of [source, tree, root]) mkdirSync(directory);
    writeFileSync(path.join(source, 'a'), 'original');
    writeFileSync(path.join(source, 'b'), 'original');
    const manifest = manifestFromInventory(source, ['a', 'b'], 'commit');
    writeFileSync(path.join(tree, 'a'), 'original');
    let ran = false;
    const run = () =>
      withCapturedSourceTree({ tree, root, source: manifest }, async () => {
        ran = true;
      });
    await expect(run()).rejects.toThrow();
    expect(ran).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(path.join(tree, 'b'), 'corrupted');
    await expect(run()).rejects.toThrow('differs');
    expect(ran).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

test('source mutation and consumer failure reject admission while cleanup preserves caller entries', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const tree = path.join(parent, 'tree');
    const root = path.join(parent, 'private');
    for (const directory of [source, tree, root]) mkdirSync(directory);
    writeFileSync(path.join(source, 'a'), 'original');
    writeFileSync(path.join(tree, 'a'), 'original');
    const manifest = manifestFromInventory(source, ['a'], 'commit');
    await expect(
      withCapturedSourceTree({ tree, root, source: manifest }, async (captured) => {
        writeFileSync(path.join(captured, 'a'), 'changed');
      }),
    ).rejects.toThrow('changed');
    expect(readdirSync(root)).toEqual([]);
    await expect(
      withCapturedSourceTree({ tree, root, source: manifest }, async () => {
        throw new Error('consumer failure');
      }),
    ).rejects.toThrow('consumer failure');
    writeFileSync(path.join(root, 'caller'), 'preserve');
    await expect(
      withCapturedSourceTree({ tree, root, source: manifest }, async () => {}),
    ).rejects.toThrow('exclusive');
    expect(readFileSync(path.join(root, 'caller'), 'utf8')).toBe('preserve');
  });
});

test('declared tree aliases cannot substitute outside source bytes', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const tree = path.join(parent, 'tree');
    const root = path.join(parent, 'private');
    const outside = path.join(parent, 'outside');
    for (const directory of [source, tree, root, outside]) mkdirSync(directory);
    mkdirSync(path.join(source, 'nested'));
    writeFileSync(path.join(source, 'nested/a'), 'same bytes');
    writeFileSync(path.join(outside, 'a'), 'same bytes');
    const manifest = manifestFromInventory(source, ['nested/a'], 'commit');
    symlinkSync(outside, path.join(tree, 'nested'));
    await expect(
      withCapturedSourceTree({ tree, root, source: manifest }, async () => {}),
    ).rejects.toThrow('escapes');
    expect(readdirSync(root)).toEqual([]);
    expect(readFileSync(path.join(outside, 'a'), 'utf8')).toBe('same bytes');
  });
});

test('sandbox carriers of one physical tree are read; a carrier of another member is refused', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const engine = path.join(parent, 'engine');
    const tree = path.join(parent, 'tree');
    const root = path.join(parent, 'private');
    for (const directory of [source, engine, tree, root]) mkdirSync(directory);
    for (const directory of [source, engine, tree]) mkdirSync(path.join(directory, 'nested'));
    for (const directory of [source, engine]) {
      writeFileSync(path.join(directory, 'nested/a'), 'same bytes');
      writeFileSync(path.join(directory, 'b'), 'same bytes');
    }
    const manifest = manifestFromInventory(source, ['nested/a', 'b'], 'commit');
    symlinkSync(path.join(engine, 'nested/a'), path.join(tree, 'nested/a'));
    symlinkSync(path.join(engine, 'b'), path.join(tree, 'b'));
    await withCapturedSourceTree({ tree, root, source: manifest }, async (captured) => {
      expect(readFileSync(path.join(captured, 'nested/a'), 'utf8')).toBe('same bytes');
    });
    rmSync(path.join(tree, 'b'));
    symlinkSync(path.join(engine, 'nested/a'), path.join(tree, 'b'));
    await expect(
      withCapturedSourceTree({ tree, root, source: manifest }, async () => {}),
    ).rejects.toThrow('escapes');
    rmSync(path.join(tree, 'b'));
    symlinkSync(path.join(source, 'b'), path.join(tree, 'b'));
    await expect(
      withCapturedSourceTree({ tree, root, source: manifest }, async () => {}),
    ).rejects.toThrow('escapes');
    expect(readdirSync(root)).toEqual([]);
  });
});

test('private output is outside declared inputs and read-only captured root modes cleanly restore', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const tree = path.join(parent, 'tree');
    const root = path.join(parent, 'private');
    for (const directory of [source, tree, root]) mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(source, 'a'), 'original');
    writeFileSync(path.join(tree, 'a'), 'original');
    chmodSync(source, 0o555);
    try {
      const manifest = manifestFromInventory(source, ['a'], 'commit');
      const nested = path.join(tree, 'nested');
      mkdirSync(nested);
      let ran = false;
      await expect(
        withCapturedSourceTree({ tree, root: nested, source: manifest }, async () => {
          ran = true;
        }),
      ).rejects.toThrow('exclusive');
      expect(ran).toBe(false);
      await withCapturedSourceTree({ tree, root, source: manifest }, async (captured) => {
        expect(statSync(captured).mode & 0o777).toBe(0o555);
      });
      expect(readdirSync(root)).toEqual([]);
      expect(statSync(root).mode & 0o777).toBe(0o700);
    } finally {
      chmodSync(source, 0o700);
    }
  });
});

test('undeclared files and empty directories cannot satisfy captured source membership', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const tree = path.join(parent, 'tree');
    for (const directory of [source, tree]) mkdirSync(directory);
    writeFileSync(path.join(source, 'a'), 'original');
    writeFileSync(path.join(tree, 'a'), 'original');
    const manifest = manifestFromInventory(source, ['a'], 'commit');
    for (const kind of ['file', 'directory']) {
      const root = path.join(parent, kind);
      mkdirSync(root);
      await expect(
        withCapturedSourceTree({ tree, root, source: manifest }, async (captured) => {
          const extra = path.join(captured, 'unowned');
          if (kind === 'file') writeFileSync(extra, 'new source');
          else mkdirSync(extra);
        }),
      ).rejects.toThrow('membership');
      expect(readdirSync(root)).toEqual(['unowned']);
    }
  });
});

test('an original payload rebuilds the same source from files named by its mapping', async () => {
  await fixture(async (parent) => {
    const source = path.join(parent, 'source');
    const runfiles = path.join(parent, 'runfiles');
    const payload = path.join(runfiles, 'context/payload');
    for (const directory of [source, payload]) mkdirSync(directory, { recursive: true });
    mkdirSync(path.join(source, 'nested'));
    writeFileSync(path.join(source, 'nested/run'), 'captured bytes', { mode: 0o750 });
    writeFileSync(path.join(source, 'plain'), 'plain bytes', { mode: 0o644 });
    const manifest = manifestFromInventory(source, ['nested/run', 'plain'], 'commit');
    rmSync(source, { recursive: true });
    writeFileSync(path.join(payload, 'one'), 'captured bytes', { mode: 0o750 });
    writeFileSync(path.join(payload, 'two'), 'plain bytes', { mode: 0o644 });
    const mapping = path.join(runfiles, 'context/source_payload.json');
    const files = { 'nested/run': 'payload/one', plain: 'payload/two' };
    writeFileSync(mapping, JSON.stringify({ directory: 'context', files }));
    const original = capturedSourcePayload(mapping, runfiles, manifest);
    const rebuild = (name: string) => {
      const root = path.join(parent, name);
      mkdirSync(root);
      return withCapturedSourceTree({ ...original, root, source: manifest }, async (captured) => {
        expect(readFileSync(path.join(captured, 'nested/run'), 'utf8')).toBe('captured bytes');
        expect(statSync(path.join(captured, 'nested/run')).mode & 0o777).toBe(0o750);
        expect(readFileSync(path.join(captured, 'plain'), 'utf8')).toBe('plain bytes');
      });
    };
    await rebuild('first');
    chmodSync(path.join(payload, 'one'), 0o700);
    await expect(rebuild('mode')).rejects.toThrow('mode differs');
    chmodSync(path.join(payload, 'one'), 0o750);
    writeFileSync(path.join(payload, 'two'), 'other bytes');
    await expect(rebuild('bytes')).rejects.toThrow('differs');
    writeFileSync(
      mapping,
      JSON.stringify({ directory: 'context', files: { plain: 'payload/two' } }),
    );
    expect(() => capturedSourcePayload(mapping, runfiles, manifest)).toThrow('membership');
    writeFileSync(mapping, JSON.stringify({ directory: '../context', files }));
    expect(() => capturedSourcePayload(mapping, runfiles, manifest)).toThrow('portable');
  });
});
