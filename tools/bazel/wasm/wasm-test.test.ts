import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWasmCipher, wasmCipherInvocation } from './wasm-test';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'merkur-wasm-test-boundary-'));
  directories.push(directory);
  const harness = path.join(directory, 'harness.wasm');
  const runner = path.join(directory, 'runner');
  writeFileSync(harness, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  writeFileSync(runner, 'synthetic runner File');
  return {
    directory,
    environment: {
      MERKUR_WASM_TEST_HARNESS: harness,
      MERKUR_WASM_TEST_RUNNER: runner,
      MERKUR_WASM_TEST_NODE: process.execPath,
      TEST_TMPDIR: directory,
    },
  };
}

test('the actual configured-producer predicates refuse conflicting later compiler options', () => {
  const python = process.env.MERKUR_WASM_TEST_CONTROL_PYTHON;
  if (!python || !path.isAbsolute(python)) throw new Error('Declared WASM control Python required');
  const result = Bun.spawnSync({
    cmd: [
      python,
      '-B',
      '-I',
      fileURLToPath(new URL('./wasm-test-controls.py', import.meta.url)),
      fileURLToPath(new URL('./wasm-test.bzl', import.meta.url)),
    ],
    env: { PATH: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain('Ran 10 tests');
});

test('uses the original runner argv and only declared Node directory despite ambient overrides', () => {
  const { environment } = fixture();
  const invocation = wasmCipherInvocation({
    ...environment,
    PATH: '/ambient',
    NODE_ARGS: '--inspect,--require=ambient.js',
    NODE_OPTIONS: '--require=ambient.js',
    NODE_PATH: '/ambient/modules',
    WASM_BINDGEN_USE_BROWSER: '1',
    WASM_BINDGEN_TEST_ONLY_WEB: '1',
    WASM_BINDGEN_TEST_TIMEOUT: '0',
  });
  expect(invocation.cmd).toEqual([
    environment.MERKUR_WASM_TEST_RUNNER,
    environment.MERKUR_WASM_TEST_HARNESS,
  ]);
  expect(invocation.env).toEqual({
    PATH: path.dirname(environment.MERKUR_WASM_TEST_NODE),
    HOME: environment.TEST_TMPDIR,
    TMPDIR: environment.TEST_TMPDIR,
  });
});

test('requires every configured regular File and the owning test temporary directory', () => {
  const { environment, directory } = fixture();
  for (const name of [
    'MERKUR_WASM_TEST_HARNESS',
    'MERKUR_WASM_TEST_RUNNER',
    'MERKUR_WASM_TEST_NODE',
    'TEST_TMPDIR',
  ]) {
    expect(() => wasmCipherInvocation({ ...environment, [name]: undefined })).toThrow();
    expect(() => wasmCipherInvocation({ ...environment, [name]: 'relative' })).toThrow();
  }
  expect(() =>
    wasmCipherInvocation({ ...environment, MERKUR_WASM_TEST_RUNNER: directory }),
  ).toThrow();
});

test('refuses a build-only WASM module before the original runner can report zero tests as success', async () => {
  const { environment } = fixture();
  await expect(runWasmCipher(environment)).rejects.toThrow('no original SIMD cipher tests');
  writeFileSync(environment.MERKUR_WASM_TEST_HARNESS, '!<arch>\nrlib');
  await expect(runWasmCipher(environment)).rejects.toThrow();
});

test('forwards real process failure and exact argv through a synthetic compiled-harness control', async () => {
  const { environment, directory } = fixture();
  // A valid tiny module with one function export exercises the process boundary;
  // it does not claim to be the genuine Cargo-produced cipher harness.
  const name = Buffer.from('__wbgt_0_merkur_e2e::wasm_chacha::tests::synthetic');
  const exports = Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([0, 0])]);
  writeFileSync(
    environment.MERKUR_WASM_TEST_HARNESS,
    Buffer.concat([
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
      Buffer.from([1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, exports.length]),
      exports,
      Buffer.from([10, 4, 1, 2, 0, 11]),
    ]),
  );
  const result = path.join(directory, 'child.json');
  writeFileSync(
    environment.MERKUR_WASM_TEST_RUNNER,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(result)}, JSON.stringify({argv:process.argv.slice(2), env:process.env}));\nprocess.exitCode=7;\n`,
  );
  chmodSync(environment.MERKUR_WASM_TEST_RUNNER, 0o755);
  expect(
    await runWasmCipher({ ...environment, NODE_ARGS: '--inspect', NODE_OPTIONS: 'poison' }),
  ).toBe(7);
  const recorded = JSON.parse(readFileSync(result, 'utf8')) as {
    argv: string[];
    env: Record<string, string>;
  };
  expect(recorded.argv).toEqual([environment.MERKUR_WASM_TEST_HARNESS]);
  expect(recorded.env.NODE_ARGS).toBeUndefined();
  expect(recorded.env.NODE_OPTIONS).toBeUndefined();
  expect(recorded.env.PATH).toBe(path.dirname(environment.MERKUR_WASM_TEST_NODE));
});
