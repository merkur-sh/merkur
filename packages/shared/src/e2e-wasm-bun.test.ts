import { expect, test } from 'bun:test';

test('the lazy Bun loader compiles its owned file bytes without copying them', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../../../scripts/bench-bun-wasm-bootstrap.ts', import.meta.url).pathname,
      '--child',
      'probe',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toMatchObject({
    copies: 0,
    copiedBytes: 0,
    modules: 1,
    fingerprint: '5af45893c07601a8118808cd6c700f9ae4f046c42742ec355981a307e46c6739',
  });
});
