import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBuddyCredential, credentialHost } from './buildbuddy';

test('transport credential requests are restricted to the configured TLS hosts', () => {
  expect(credentialHost({ uri: 'https://remote.buildbuddy.io' })).toBe('remote.buildbuddy.io');
  expect(credentialHost({ uri: 'grpcs://remote.buildbuddy.io' })).toBe('remote.buildbuddy.io');
  expect(credentialHost({ uri: 'https://app.buildbuddy.io/api/v1/GetInvocation' })).toBe(
    'app.buildbuddy.io',
  );
  for (const uri of [
    'http://remote.buildbuddy.io',
    'https://remote.buildbuddy.io.example.com',
    'https://user:password@remote.buildbuddy.io',
    'https://remote.buildbuddy.io:8443',
    'file:///secret',
  ])
    expect(() => credentialHost({ uri })).toThrow();
  expect(() => credentialHost({ uri: 42 })).toThrow();
});

test('the credential source supplies one literal binding without interpreting Bazel settings', () => {
  const contents =
    '# source\ncommon --remote_header=x-buildbuddy-api-key=synthetic-key # label\nbuild --remote_cache=grpcs://ignored.example\nimport /ignored/file\n';
  expect(buildBuddyCredential(contents)).toBe('synthetic-key');
  for (const source of [
    '',
    '# common --remote_header=x-buildbuddy-api-key=synthetic-key',
    'test --remote_header=x-buildbuddy-api-key=synthetic-key',
    'common --remote_header=x-buildbuddy-api-key=',
    'common --remote_header=x-buildbuddy-api-key=synthetic-key --config=other',
    'common --remote_header=x-buildbuddy-api-key="synthetic-key"',
    'common --remote_header=x-buildbuddy-api-key=synthetic-key\ncommon --remote_header=x-buildbuddy-api-key=second-key',
    'common --remote_header=x-buildbuddy-api-key=synthetic-key\rINJECTED',
  ])
    expect(() => buildBuddyCredential(source)).toThrow();
});

test('the actual helper transports an explicit synthetic credential and keeps rejection output redacted', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'buildbuddy-helper-control-'));
  try {
    const file = path.join(scratch, 'auth.bazelrc');
    writeFileSync(file, 'common --remote_header=x-buildbuddy-api-key=synthetic-key\n', {
      mode: 0o600,
    });
    function invoke(uri: string, operation = 'get', credentialFile = file) {
      return Bun.spawnSync(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          `--config=${process.env.MERKUR_BUN_TEST_CONFIG}`,
          path.join(import.meta.dir, 'buildbuddy.ts'),
          operation,
        ],
        {
          env: {
            HOME: scratch,
            TMPDIR: scratch,
            PATH: '/__no_ambient_path__',
            MERKUR_BUILDBUDDY_AUTH_FILE: credentialFile,
          },
          stdin: new TextEncoder().encode(JSON.stringify({ uri })),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
    }
    const accepted = invoke('grpcs://remote.buildbuddy.io');
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stderr.toString()).toBe('');
    expect(JSON.parse(accepted.stdout.toString())).toEqual({
      headers: { 'x-buildbuddy-api-key': ['synthetic-key'] },
    });
    for (const result of [
      invoke('https://untrusted.example'),
      invoke('http://remote.buildbuddy.io'),
      invoke('grpcs://remote.buildbuddy.io', 'store'),
      invoke('grpcs://remote.buildbuddy.io', 'get', 'relative'),
      invoke('grpcs://remote.buildbuddy.io', 'get', path.join(scratch, 'missing')),
    ]) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.toString()).toBe('BuildBuddy credential helper rejected the request\n');
    }
    writeFileSync(
      file,
      'common --remote_header=x-buildbuddy-api-key=synthetic-key\ncommon --remote_header=x-buildbuddy-api-key=second-key\n',
    );
    const rejected = invoke('grpcs://remote.buildbuddy.io');
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout.toString()).toBe('');
    expect(rejected.stderr.toString()).not.toContain('synthetic-key');
    expect(rejected.stderr.toString()).not.toContain('second-key');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
