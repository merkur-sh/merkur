import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLedger, type TestReservation } from './revocation';
import { nonceRepositoryFiles, publishNonceRepository } from './revocation-inputs';

function reservation(
  a: string,
  b: string,
  state: 'pending' | 'ready' = 'pending',
): TestReservation {
  return {
    snapshot: {
      revision: 'a'.repeat(40),
      ledger: parseLedger({
        '//fixture:a': { nonce: a.repeat(64), state },
        '//fixture:b': { nonce: b.repeat(64), state },
      }),
    },
    labels: ['//fixture:a', '//fixture:b'],
    fresh: state === 'pending' ? ['//fixture:a', '//fixture:b'] : [],
  };
}

test('selected test rotation changes exactly one nonce File and admission changes no repository bytes', () => {
  const before = nonceRepositoryFiles(reservation('a', 'b'));
  const after = nonceRepositoryFiles(reservation('c', 'b'));
  const changed = [...before]
    .filter(([file, bytes]) => after.get(file) !== bytes)
    .map(([file]) => file);
  expect(changed.length).toBe(1);
  expect(changed[0]?.startsWith('nonce/')).toBe(true);
  expect(after.get('BUILD.bazel')).toBe(before.get('BUILD.bazel'));
  expect(
    nonceRepositoryFiles({
      ...reservation('a', 'b'),
      labels: ['//fixture:a'],
      fresh: ['//fixture:a'],
    }),
  ).toEqual(before);
  expect(nonceRepositoryFiles(reservation('a', 'b', 'ready'))).toEqual(before);
  expect(
    [...before.values()].some((bytes) => bytes.includes('pending') || bytes.includes('ready')),
  ).toBe(false);
});

test('nonce File publication is exclusive, regular, readonly and exact, with no caller overwrite', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'merkur-nonce-inputs-'));
  try {
    const selected = reservation('a', 'b');
    publishNonceRepository(directory, selected);
    for (const [file, bytes] of nonceRepositoryFiles(selected)) {
      expect(readFileSync(path.join(directory, file), 'utf8')).toBe(bytes);
      expect(statSync(path.join(directory, file)).isFile()).toBe(true);
      expect(statSync(path.join(directory, file)).mode & 0o777).toBe(0o444);
    }
    expect(() => publishNonceRepository(directory, reservation('c', 'd'))).toThrow();
    for (const [file, bytes] of nonceRepositoryFiles(selected))
      expect(readFileSync(path.join(directory, file), 'utf8')).toBe(bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nonce input publication refuses missing and duplicate selected target epochs', () => {
  const selected = reservation('a', 'b');
  expect(() => nonceRepositoryFiles({ ...selected, labels: ['//fixture:missing'] })).toThrow();
  expect(() =>
    nonceRepositoryFiles({ ...selected, labels: ['//fixture:a', '//fixture:a'] }),
  ).toThrow();
});
