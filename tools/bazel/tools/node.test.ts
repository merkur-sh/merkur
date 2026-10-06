import { expect, test } from 'bun:test';

test('the declared Node distribution executes a native child with the pinned version', async () => {
  const child = Bun.spawn(
    ['node', '--input-type=module', '-e', 'process.stdout.write(JSON.stringify(process.versions))'],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '' } },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status).toBe(0);
  expect(stderr).toBe('');
  const versions: Record<string, string> = JSON.parse(stdout);
  expect(versions.node).toBe('26.5.1');
  expect(versions.v8).toBeDefined();
  expect(versions.openssl).toBeDefined();
});

test('the declared V8 allocation counter measures allocations without a GC proxy', async () => {
  const child = Bun.spawn(
    [
      'node',
      '--input-type=module',
      '-e',
      `import v8 from 'node:v8';
const before = v8.getHeapStatistics().total_allocated_bytes;
globalThis.retained = Array.from({ length: 10000 }, (_, index) => ({ index }));
const after = v8.getHeapStatistics().total_allocated_bytes;
process.stdout.write(JSON.stringify({ before, after }));`,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '' } },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status).toBe(0);
  expect(stderr).toBe('');
  const counts: Record<string, unknown> = JSON.parse(stdout);
  expect(typeof counts.before).toBe('number');
  expect(typeof counts.after).toBe('number');
  if (typeof counts.before !== 'number' || typeof counts.after !== 'number') {
    throw new Error('The selected V8 toolchain has no allocation counter');
  }
  expect(counts.after).toBeGreaterThan(counts.before);
});
