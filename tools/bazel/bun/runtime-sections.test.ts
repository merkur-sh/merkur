import { expect, test } from 'bun:test';

test('the declared Python checks complete native runtime mappings on all four file formats', async () => {
  const python = process.env.MERKUR_RUNTIME_SECTIONS_PYTHON;
  if (python === undefined || !python.startsWith('/')) {
    throw new Error('Runtime mappings require their declared Python executable');
  }
  const child = Bun.spawn(
    [python, '-B', '-I', new URL('./runtime-sections-test.py', import.meta.url).pathname],
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
  expect(stderr).toContain('Ran 14 tests');
  expect(stderr.trim().endsWith('OK')).toBe(true);
});
