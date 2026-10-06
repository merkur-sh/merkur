import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readDeclaredInput,
  readEngineArtifact,
  targetArtifacts,
  verifyEngineArtifact,
} from './artifacts';
import { sanitizeBuildEvents } from './sanitize';

const producer = { label: '//app:binary', configuration: 'configured-platform', group: 'default' };
const bytes = Buffer.from('actual artifact');
const file = {
  name: 'binary',
  pathPrefix: ['bazel-out', 'platform', 'bin'],
  digest: createHash('sha256').update(bytes).digest('hex'),
  length: String(bytes.length),
};

function fixture(): Record<string, unknown>[] {
  return [
    { id: { namedSet: { id: 'leaves' } }, namedSetOfFiles: { files: [file] } },
    { id: { namedSet: { id: 'root' } }, namedSetOfFiles: { fileSets: [{ id: 'leaves' }] } },
    {
      id: {
        targetCompleted: { label: producer.label, configuration: { id: producer.configuration } },
      },
      completed: {
        success: true,
        outputGroup: [{ name: producer.group, fileSets: [{ id: 'root' }] }],
      },
    },
  ];
}

function encode(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

test('external reads require digest and length even though action-owned inputs derive their own receipt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-artifact-authority-'));
  try {
    writeFileSync(path.join(root, 'a'), bytes);
    const input = await readDeclaredInput(root, 'a');
    expect(input.bytes).toEqual(bytes);
    expect(input.artifact).toEqual({ path: 'a', digest: file.digest, length: file.length });
    for (const value of [
      { path: 'a' },
      { path: 'a', digest: file.digest },
      { path: 'a', length: file.length },
      { path: 'a', digest: file.digest, length: '01' },
    ]) {
      const artifact = JSON.parse(JSON.stringify(value));
      await expect(verifyEngineArtifact(root, artifact)).rejects.toThrow('expected');
      await expect(readEngineArtifact(root, artifact)).rejects.toThrow('expected');
    }
    expect(await readEngineArtifact(root, input.artifact)).toEqual(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitized output DAG binds exact producing target/configuration to SHA256 and size', () => {
  const events = sanitizeBuildEvents(encode(fixture()));
  expect(targetArtifacts(events, producer)).toEqual([
    { path: 'bazel-out/platform/bin/binary', digest: file.digest, length: file.length },
  ]);
  expect(() => targetArtifacts(events, { ...producer, configuration: 'other-platform' })).toThrow(
    'producer',
  );
  expect(() => targetArtifacts(events, { ...producer, label: '//other:binary' })).toThrow(
    'producer',
  );
});

test('missing, cyclic, duplicate, conflicting and incomplete engine output evidence fails closed', () => {
  const complete = fixture();
  const negative = [
    complete.slice(1),
    [...complete, complete[0]],
    [...complete, complete[2]],
    [
      complete[0],
      { id: { namedSet: { id: 'root' } }, namedSetOfFiles: { fileSets: [{ id: 'root' }] } },
      complete[2],
    ],
    [
      {
        id: { namedSet: { id: 'leaves' } },
        namedSetOfFiles: { files: [file, { ...file, digest: 'b'.repeat(64) }] },
      },
      ...complete.slice(1),
    ],
    [
      ...complete.slice(0, 2),
      {
        id: {
          targetCompleted: { label: producer.label, configuration: { id: producer.configuration } },
        },
        completed: {
          success: true,
          outputGroup: [{ name: 'default', incomplete: true, fileSets: [{ id: 'root' }] }],
        },
      },
    ],
  ];
  for (const events of negative) expect(() => targetArtifacts(encode(events), producer)).toThrow();
});

test('unhashed files, tree-only evidence, links and unsafe names cannot bind a shipping artifact', () => {
  for (const invalid of [
    { ...file, digest: undefined },
    { ...file, length: '-1' },
    { ...file, length: '01' },
    { ...file, name: '../binary' },
    { ...file, pathPrefix: ['..'] },
    { ...file, symlink: true },
    { ...file, symlink: 'false' },
    { ...file, symlinkTargetPath: 'other' },
  ]) {
    const events = fixture();
    events[0] = { id: { namedSet: { id: 'leaves' } }, namedSetOfFiles: { files: [invalid] } };
    expect(() => targetArtifacts(sanitizeBuildEvents(encode(events)), producer)).toThrow();
  }
});

test('malformed optional output-group flags cannot turn an incomplete receipt into admission', () => {
  for (const incomplete of [true, 'true', 'false', 0, 1, null, {}]) {
    const events = fixture();
    events[2] = {
      id: {
        targetCompleted: { label: producer.label, configuration: { id: producer.configuration } },
      },
      completed: {
        success: true,
        outputGroup: [{ name: 'default', incomplete, fileSets: [{ id: 'root' }] }],
      },
    };
    expect(() => targetArtifacts(sanitizeBuildEvents(encode(events)), producer)).toThrow(
      'incomplete',
    );
  }
});

test('already materialized bytes must match engine digest/type/size and stay confined', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-artifact-'));
  const artifact = targetArtifacts(encode(fixture()), producer)[0];
  if (artifact === undefined) throw new Error('Fixture artifact absent');
  const output = path.join(root, artifact.path);
  mkdirSync(path.dirname(output), { recursive: true });
  try {
    writeFileSync(output, bytes);
    await verifyEngineArtifact(root, artifact);
    writeFileSync(output, Buffer.alloc(bytes.length, 0));
    await expect(verifyEngineArtifact(root, artifact)).rejects.toThrow('differs');
    writeFileSync(output, 'short');
    await expect(verifyEngineArtifact(root, artifact)).rejects.toThrow('size');
    rmSync(output);
    symlinkSync('/etc/passwd', output);
    await expect(verifyEngineArtifact(root, artifact)).rejects.toThrow('escapes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
