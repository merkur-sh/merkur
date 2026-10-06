import { expect, test } from 'bun:test';

test('the declared Python checks the complete Kani test-action lifecycle', async () => {
  const python = process.env.MERKUR_KANI_TEST_PYTHON;
  if (python === undefined || !python.startsWith('/')) {
    throw new Error('Kani lifecycle controls require their declared Python executable');
  }
  const child = Bun.spawn(
    [python, '-B', '-I', new URL('./kani_runner_test.py', import.meta.url).pathname],
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
  expect(stderr).toContain('Ran 10 tests');
  expect(stderr.trim().endsWith('OK')).toBe(true);
}, 30_000);
