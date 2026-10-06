import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configuredExecutionPlacement,
  executionLogFileRecords,
  executionLogRecords,
  validateExecutionPlacement,
} from './bazel-engine';
import type { ExecutorPool } from './executor-policy';

const pool: ExecutorPool = {
  platform: 'linux-arm64',
  provider: 'hosted',
  pool: 'control-linux-arm64',
  executionPlatform: '//control:linux_arm64',
  imageDigest: 'a'.repeat(64),
  sdkDigest: 'b'.repeat(64),
  containerImage: `registry.invalid/control@sha256:${'a'.repeat(64)}`,
};

function graph() {
  return {
    targets: [
      { id: 1, label: '//control:hermetic' },
      { id: 2, label: '//control:live' },
    ],
    actions: [
      { mnemonic: 'TestRunner', targetId: 1, executionPlatform: pool.executionPlatform },
      {
        mnemonic: 'TestRunner',
        targetId: 2,
        executionPlatform: '@@platforms//host:host',
        executionInfo: [{ key: 'no-remote', value: '1' }],
      },
    ],
  };
}

function spawn(): Record<string, unknown> {
  return {
    mnemonic: 'TestRunner',
    targetLabel: '//control:hermetic',
    runner: 'remote',
    cacheHit: false,
    remotable: true,
    status: '',
    exitCode: 0,
    platform: {
      properties: [
        { name: 'Arch', value: 'arm64' },
        { name: 'OSFamily', value: 'linux' },
        { name: 'Pool', value: pool.pool },
        { name: 'container-image', value: pool.containerImage },
        { name: 'use-self-hosted-executors', value: 'false' },
      ],
    },
  };
}

test('configured remote tests must choose the requested platform; explicit local checks stay local', () => {
  const value = graph();
  expect(
    configuredExecutionPlacement(
      JSON.stringify(value),
      ['//control:hermetic', '//control:live'],
      pool.executionPlatform,
    ),
  ).toEqual(['//control:hermetic']);
  const action = value.actions[0];
  if (action === undefined) throw new Error('Control action missing');
  action.executionPlatform = '@@//control:linux_arm64';
  expect(
    configuredExecutionPlacement(
      JSON.stringify(value),
      ['//control:hermetic'],
      pool.executionPlatform,
    ),
  ).toEqual(['//control:hermetic']);
  action.executionPlatform = '@@platforms//host:host';
  expect(() =>
    configuredExecutionPlacement(
      JSON.stringify(value),
      ['//control:hermetic'],
      pool.executionPlatform,
    ),
  ).toThrow('another execution platform');
  expect(() =>
    configuredExecutionPlacement(
      JSON.stringify(graph()),
      ['//control:missing'],
      pool.executionPlatform,
    ),
  ).toThrow('omits');
});

test('Bazel concatenated pretty protobuf JSON preserves braces and escaped quotes inside strings', () => {
  const first = { ...spawn(), commandArgs: ['brace } {', 'quote " slash \\', 'unicode \u{1F980}'] };
  const second = { ...spawn(), targetLabel: '//control:second' };
  const text = JSON.stringify(first, null, 2) + JSON.stringify(second, null, 2);
  expect(executionLogRecords(text)).toEqual([first, second]);
  expect(() => executionLogRecords(text.slice(0, -1))).toThrow('truncated');
  expect(() => executionLogRecords('[{}]')).toThrow('complete');
  expect(() => executionLogRecords('{} garbage')).toThrow('complete');
});

test('native placement accepts complete unsorted logs and still rejects a bad selected result', () => {
  const first = spawn();
  const second = { ...spawn(), targetLabel: '//control:second' };
  const build = { mnemonic: 'Rustc', targetLabel: '//control:binary' };
  const labels = ['//control:hermetic', '//control:second'];
  for (const order of [
    [second, build, first],
    [first, second, build],
  ]) {
    const records = executionLogRecords(
      order.map((row) => JSON.stringify(row, null, 2)).join('\n'),
    );
    expect(records).toEqual(order);
    expect(() => validateExecutionPlacement(records, labels, pool)).not.toThrow();
    expect(() =>
      validateExecutionPlacement(
        records.map((row) =>
          row.targetLabel === '//control:second' ? { ...row, cacheHit: true } : row,
        ),
        labels,
        pool,
      ),
    ).toThrow();
  }
});

test('file logs preserve split UTF-8, escapes and large objects; malformed tails still fail', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'merkur-execution-log-control-'));
  const file = path.join(directory, 'execution.json');
  try {
    const prefix = '{"payload":"';
    const padding = 'x'.repeat(64 * 1024 - prefix.length - 1);
    for (const boundary of ['🦀', '"', '}']) {
      const first = { payload: padding + boundary + 'y'.repeat(128 * 1024) };
      const second = spawn();
      const text = `${JSON.stringify(first)}\n${JSON.stringify(second, null, 2)}`;
      writeFileSync(file, text);
      expect([...executionLogFileRecords(file)]).toEqual([first, second]);
      expect(() =>
        validateExecutionPlacement(executionLogFileRecords(file), ['//control:hermetic'], pool),
      ).not.toThrow();
      writeFileSync(file, text.slice(0, -1));
      expect(() => [...executionLogFileRecords(file)]).toThrow('truncated');
      writeFileSync(file, `${text} foreign`);
      expect(() => [...executionLogFileRecords(file)]).toThrow('complete');
    }
    writeFileSync(file, Buffer.from([0x7b, 0x22, 0xff]));
    expect(() => [...executionLogFileRecords(file)]).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh native placement rejects cache hits, fallback runners, missing tests and foreign properties', () => {
  expect(() => validateExecutionPlacement([spawn()], ['//control:hermetic'], pool)).not.toThrow();
  for (const change of [
    { runner: 'remote cache hit', cacheHit: true },
    { runner: 'darwin-sandbox' },
    { runner: 'remote', cacheHit: undefined },
    { status: 'TIMEOUT' },
    { exitCode: 1 },
    { platform: { properties: [{ name: 'Pool', value: 'foreign' }] } },
  ])
    expect(() =>
      validateExecutionPlacement([{ ...spawn(), ...change }], ['//control:hermetic'], pool),
    ).toThrow();
  expect(() => validateExecutionPlacement([], ['//control:hermetic'], pool)).toThrow('omits');
  expect(() =>
    validateExecutionPlacement([spawn()], ['//control:hermetic', '//control:missing'], pool),
  ).toThrow('omits');
  expect(() => validateExecutionPlacement([spawn()], [], pool)).toThrow('omits');
});
