import { expect, test } from 'bun:test';
import path from 'node:path';

test('native audit snapshots preserve fresh acquisition and complete failure coverage', () => {
  const python = process.env.MERKUR_AUDIT_PYTHON;
  const scratch = process.env.TEST_TMPDIR;
  if (python === undefined || scratch === undefined)
    throw new Error('Audit controls require declared Python and the isolated Bazel test directory');
  const result = Bun.spawnSync(
    [python, '-B', '-I', path.join(import.meta.dir, 'dependency-audit-test.py')],
    {
      env: { HOME: scratch, TMPDIR: scratch, PATH: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  expect({
    exit: result.exitCode,
    error: result.exitCode === 0 ? '' : result.stderr.toString(),
  }).toEqual({ exit: 0, error: '' });
});
