import { expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('declared Python validates original Rolldown archives and offline registry membership', async () => {
  const python = process.env.MERKUR_ROLLDOWN_REGISTRY_PYTHON;
  if (python === undefined || !path.isAbsolute(python)) {
    throw new Error('Rolldown registry controls require their declared Python executable');
  }
  const child = Bun.spawn(
    [python, '-B', '-I', fileURLToPath(new URL('./rolldown_registry_test.py', import.meta.url))],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: '' } },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, stdout, stderr: status === 0 ? '' : stderr }).toEqual({
    status: 0,
    stdout: '',
    stderr: '',
  });
  expect(stderr).toContain('Ran 8 tests');
  expect(stderr.trim().endsWith('OK')).toBe(true);
});
