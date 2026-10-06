import { describe, expect, test } from 'bun:test';
import path from 'node:path';

describe('sign-release-manifest CLI', () => {
  test('initializes its argument contract before parsing argv', async () => {
    const script = path.join(import.meta.dir, 'sign-release-manifest.ts');
    const process = Bun.spawn([Bun.which('bun') ?? 'bun', 'run', script], {
      cwd: path.resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--expires-at must be a positive integer');
    expect(stderr).not.toContain("Cannot access 'ARGUMENT_NAMES' before initialization");
  });
});
