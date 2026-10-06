import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTestProcess } from '../../../../scripts/test-process';

test('the validation runtime works in a standalone executable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merkur-elysia-'));
  const entry = join(directory, 'probe.ts');
  const executable = join(directory, 'probe');
  const bootstrap = fileURLToPath(new URL('../elysia-runtime.ts', import.meta.url));
  try {
    // Neither TypeBox nor Exact Mirror may depend on node_modules at runtime.
    writeFileSync(
      entry,
      `
      import ${JSON.stringify(bootstrap)};
      import { Elysia, t, validationDetail } from ${JSON.stringify(fileURLToPath(import.meta.resolve('elysia')))};
      const app = new Elysia().post('/', {
        body: t.Object({ name: t.String({ minLength: 1, error: validationDetail('required') }) }),
        response: t.Object({ name: t.String() }),
      }, ({ body }) => body);
      for (const [body, expected] of [[{ name: 'valid', extra: 'strip' }, 200], [{ name: '' }, 422]]) {
        const response = await app.handle(new Request('http://localhost/', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }));
        const result = await response.json();
        if (response.status !== expected || (expected === 200 && (result.name !== 'valid' || 'extra' in result)))
          throw new Error(JSON.stringify({ status: response.status, result }));
      }
      process.stdout.write('ok');
    `,
    );
    const build = await runTestProcess([
      process.execPath,
      'build',
      entry,
      '--target',
      'bun',
      '--compile',
      '--outfile',
      executable,
    ]);
    expect(build.stderr).not.toContain('error:');
    expect(build.exitCode).toBe(0);
    const run = await runTestProcess([executable], { cwd: directory });
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('ok');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
