import { expect, test } from 'bun:test';
import path from 'node:path';

test('original Darwin compiler archives preserve complete declared closures and refuse escapes', () => {
  const python = process.env.MERKUR_NATIVE_SDK_PYTHON;
  if (python === undefined || !path.isAbsolute(python))
    throw new Error('Compiler archive controls require the exact declared Python executable');
  const child = Bun.spawnSync(
    [python, '-B', '-I', new URL('./darwin-compiler-test.py', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: '', PYTHONPATH: '', PYTHONHOME: '' } },
  );
  expect(new TextDecoder().decode(child.stderr)).toContain('Ran 24 tests');
  expect(child.exitCode).toBe(0);
});
