import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function declaredExecutable(): string {
  const executable = process.env.MERKUR_VERIFICATION_BAZEL;
  if (executable === undefined || !path.isAbsolute(executable))
    throw new Error('An absolute declared Bazel executable is required');
  return executable;
}

function metadata(): Record<string, unknown> {
  const file = process.env.MERKUR_VERIFICATION_BAZEL_ACQUISITION;
  if (file === undefined || !path.isAbsolute(file))
    throw new Error('Declared Bazel acquisition metadata is required');
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed Bazel acquisition metadata');
  return value as Record<string, unknown>;
}

test('the declared native Bazel payload matches the independent pins and native architecture', () => {
  const acquisition = metadata();
  if (typeof acquisition.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(acquisition.sha256))
    throw new Error('Declared Bazel acquisition SHA-256 is malformed');
  const platform = `${process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`;
  const pins: { version: string; binaries: Record<string, string> } = JSON.parse(
    readFileSync('.github/bazel/engine-pins.json', 'utf8'),
  );
  const expectedSha256 = pins.binaries[platform];
  if (expectedSha256 === undefined || !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error('Independent Bazel pin is absent or malformed for the native platform');
  expect(Object.keys(acquisition).sort()).toEqual(['pins', 'platform', 'sha256', 'url', 'version']);
  expect(acquisition.platform).toBe(platform);
  expect(acquisition.version).toBe('9.2.0');
  expect(acquisition.version).toBe(pins.version);
  expect(acquisition.sha256).toBe(expectedSha256);
  expect(acquisition.pins).toBe('//:.github/bazel/engine-pins.json');
  expect(acquisition.url).toBe(
    `https://github.com/bazelbuild/bazel/releases/download/9.2.0/bazel-9.2.0-${platform}`,
  );
  const bytes = readFileSync(declaredExecutable());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(acquisition.sha256);
  if (process.platform === 'darwin') {
    expect(bytes.subarray(0, 4).toString('hex')).toBe('cffaedfe');
    expect(bytes.readUInt32LE(4)).toBe(process.arch === 'arm64' ? 0x0100000c : 0x01000007);
  } else if (process.platform === 'linux') {
    expect(bytes.subarray(0, 6).toString('hex')).toBe('7f454c460201');
    expect(bytes.readUInt16LE(18)).toBe(process.arch === 'arm64' ? 183 : 62);
  } else throw new Error('Unsupported Bazel native platform');
});

test('the exact declared Bazel runs only its version command with a cold HOME and no PATH', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'merkur-bazel-engine-version-'));
  try {
    const child = Bun.spawn([declaredExecutable(), '--version'], {
      cwd: home,
      env: { HOME: home, TMPDIR: home, PATH: '/__no_ambient_bazel_tools__' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('bazel 9.2.0\n');
    expect(stderr).toBe('');
    expect(readdirSync(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an absent exact executable rejects a PATH replacement without running it or creating cache', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'merkur-bazel-engine-missing-'));
  try {
    writeFileSync(path.join(home, 'bazel'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const before = readdirSync(home);
    expect(() =>
      Bun.spawn([path.join(home, 'absent-declared-engine'), '--version'], {
        cwd: home,
        env: { HOME: home, PATH: home },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    ).toThrow();
    expect(readdirSync(home)).toEqual(before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
