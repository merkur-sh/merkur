import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishCapturedSourceInputs } from './captured-source';
import { manifestFromInventory } from './snapshot';
import { withCapturedSourceTree } from './source-tree';

async function fixture(run: (parent: string) => Promise<void>): Promise<void> {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'captured-source-control-'));
  try {
    await run(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('complete captured originals precede distinct generated replacement and survive source removal', async () => {
  await fixture(async (parent) => {
    const original = path.join(parent, 'original');
    const payload = path.join(parent, 'payload');
    const tree = path.join(parent, 'tree');
    const consumer = path.join(parent, 'consumer');
    for (const directory of [original, payload, tree, consumer]) mkdirSync(directory);
    mkdirSync(path.join(original, 'pkg'), { recursive: true });
    writeFileSync(path.join(original, 'pkg/raw.d.ts'), 'original raw declaration', { mode: 0o640 });
    writeFileSync(path.join(original, 'BUILD.bazel'), 'original package boundary', { mode: 0o644 });
    symlinkSync('pkg', path.join(original, 'alias'));
    const source = manifestFromInventory(
      original,
      ['pkg/raw.d.ts', 'BUILD.bazel', 'alias'],
      'head',
    );
    const inputs = {
      'pkg/raw.d.ts': path.join(payload, 'original-declaration'),
      'BUILD.bazel': path.join(payload, 'original-build'),
    };
    writeFileSync(inputs['pkg/raw.d.ts'], 'original raw declaration', { mode: 0o640 });
    writeFileSync(inputs['BUILD.bazel'], 'original package boundary', { mode: 0o644 });
    rmSync(original, { recursive: true });
    await publishCapturedSourceInputs(source, inputs, tree);
    expect(readFileSync(path.join(tree, 'pkg/raw.d.ts'), 'utf8')).toBe('original raw declaration');
    expect(statSync(path.join(tree, 'pkg/raw.d.ts')).mode & 0o777).toBe(0o640);
    expect(readlinkSync(path.join(tree, 'alias'))).toBe('pkg');
    await withCapturedSourceTree({ tree, root: consumer, source }, async (root) => {
      expect(readFileSync(path.join(root, 'alias/raw.d.ts'), 'utf8')).toBe(
        'original raw declaration',
      );
    });
  });
});

test('missing original File, changed bytes and changed mode cannot publish a complete tree', async () => {
  await fixture(async (parent) => {
    const original = path.join(parent, 'original');
    const payload = path.join(parent, 'payload');
    mkdirSync(original);
    mkdirSync(payload);
    writeFileSync(path.join(original, 'raw'), 'captured original', { mode: 0o644 });
    const source = manifestFromInventory(original, ['raw'], 'head');
    const input = path.join(payload, 'raw');
    writeFileSync(input, 'captured original', { mode: 0o644 });
    for (const kind of ['missing-mapping', 'missing-file', 'bytes', 'mode']) {
      const output = path.join(parent, kind);
      mkdirSync(output);
      if (kind === 'missing-file') rmSync(input);
      if (kind === 'bytes') writeFileSync(input, 'fresh generated replacement', { mode: 0o644 });
      if (kind === 'mode') {
        writeFileSync(input, 'captured original');
        chmodSync(input, 0o755);
      }
      await expect(
        publishCapturedSourceInputs(
          source,
          kind === 'missing-mapping' ? {} : { raw: input },
          output,
        ),
      ).rejects.toThrow();
      expect(() => readFileSync(path.join(output, 'raw'))).toThrow();
    }
  });
});

test('fresh and engine-precreated outputs publish; aliases and occupied outputs preserve caller ownership', async () => {
  await fixture(async (parent) => {
    const original = path.join(parent, 'original');
    mkdirSync(original);
    writeFileSync(path.join(original, 'raw'), 'original', { mode: 0o644 });
    const source = manifestFromInventory(original, ['raw'], 'head');
    const inputs = { raw: path.join(original, 'raw') };
    const fresh = path.join(parent, 'fresh');
    await publishCapturedSourceInputs(source, inputs, fresh);
    expect(readFileSync(path.join(fresh, 'raw'), 'utf8')).toBe('original');
    const incumbent = path.join(parent, 'incumbent');
    mkdirSync(incumbent);
    writeFileSync(path.join(incumbent, 'caller'), 'preserve');
    await expect(publishCapturedSourceInputs(source, inputs, incumbent)).rejects.toThrow(
      'exclusive',
    );
    expect(readFileSync(path.join(incumbent, 'caller'), 'utf8')).toBe('preserve');
    const alias = path.join(parent, 'alias');
    symlinkSync(incumbent, alias);
    await expect(publishCapturedSourceInputs(source, inputs, alias)).rejects.toThrow('ordinary');
    expect(readlinkSync(alias)).toBe(incumbent);
    expect(readFileSync(path.join(incumbent, 'caller'), 'utf8')).toBe('preserve');
  });
});
