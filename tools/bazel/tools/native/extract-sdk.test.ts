import { expect, test } from 'bun:test';
import path from 'node:path';

test('declared SDK extraction refuses incompatible native dependency members', () => {
  const python = process.env.MERKUR_NATIVE_SDK_PYTHON;
  if (python === undefined || !path.isAbsolute(python))
    throw new Error('SDK loader controls require the exact declared Python executable');
  const child = Bun.spawnSync(
    [python, '-B', '-I', new URL('./extract-sdk-test.py', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(new TextDecoder().decode(child.stderr)).toContain('Ran 19 tests');
  expect(child.exitCode).toBe(0);
});
