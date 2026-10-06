import { expect, test } from 'bun:test';
import path from 'node:path';

test('selected WASM attribution keeps the original compiler and package boundaries', () => {
  const python = process.env.MERKUR_SELECTED_WASM_PYTHON;
  if (python === undefined || python.length === 0) {
    throw new Error('Selected WASM controls require the declared native Python executable');
  }
  const root = process.cwd();
  const result = Bun.spawnSync(
    [
      python,
      '-B',
      '-I',
      path.join(root, 'tools/bazel/wasm/selected-attribution-test.py'),
      '--helper',
      path.join(root, 'tools/bazel/wasm/selected-attribution.py'),
      '--wasm-inputs',
      path.join(root, 'tools/bazel/packaging/wasm-inputs.py'),
      '--bun',
      process.execPath,
      '--frontend-checker',
      path.join(root, 'tools/bazel/wasm/frontend-check.ts'),
      '--bun-config',
      path.join(root, 'tools/bazel/bun/empty-bunfig.toml'),
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    exit: 0,
    stderr: expect.stringContaining('Ran 57 tests'),
  });
});

test('WASM generators retain the existing original compiled source and license controls', () => {
  const python = process.env.MERKUR_SELECTED_WASM_PYTHON;
  if (python === undefined || python.length === 0) {
    throw new Error('Generator controls require the declared native Python executable');
  }
  const root = process.cwd();
  const result = Bun.spawnSync(
    [
      python,
      '-B',
      '-I',
      path.join(root, 'tools/bazel/wasm/generator-licenses-test.py'),
      path.join(root, 'tools/bazel/packaging/rust-license-metadata-test.py'),
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({
    exit: 0,
    stderr: expect.stringContaining('Ran 26 tests'),
  });
});
