import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquiredPack } from './git-inputs';

test('the same object identities read the kept pack; other identities or damaged bytes produce anew', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'merkur-object-pack-'));
  try {
    const directory = path.join(parent, 'pack');
    let produced = 0;
    const produce = () => Buffer.from(`PACK encoding ${++produced}`);
    expect(acquiredPack(undefined, 'a\n', produce).toString()).toBe('PACK encoding 1');
    expect(acquiredPack(undefined, 'a\n', produce).toString()).toBe('PACK encoding 2');

    expect(acquiredPack(directory, 'a\n', produce).toString()).toBe('PACK encoding 3');
    expect(acquiredPack(directory, 'a\n', produce).toString()).toBe('PACK encoding 3');
    expect(acquiredPack(directory, 'a\nb\n', produce).toString()).toBe('PACK encoding 4');
    expect(acquiredPack(directory, 'a\n', produce).toString()).toBe('PACK encoding 5');

    writeFileSync(path.join(directory, 'objects.pack'), 'PACK damaged');
    expect(acquiredPack(directory, 'a\n', produce).toString()).toBe('PACK encoding 6');
    expect(acquiredPack(directory, 'a\n', produce).toString()).toBe('PACK encoding 6');
    expect(() => acquiredPack('relative', 'a\n', produce)).toThrow('absolute');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
