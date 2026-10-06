import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { moduleRequests } from './module-requests';

test('parsed fixtures and mocked originals run in separate fresh materializations', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'merkur-test-closure-')));
  try {
    const runfiles = path.join(root, 'runfiles');
    const scratch = path.join(root, 'scratch');
    await mkdir(path.join(runfiles, 'tests'), { recursive: true });
    await mkdir(scratch);
    const sources: Record<string, string> = {
      'empty-bunfig.toml': '',
      'original.ts': "export const value = 'original';\n",
      'fixture.txt': 'declared-fixture-bytes\n',
      'mocked.test.ts': `
        import { expect, mock, test } from 'bun:test';
        mock.module('./original.ts', () => ({ value: 'mocked' }));
        const { value } = await import('./original.ts');
        test('mocked module and declared fixture', async () => {
          expect(value).toBe('mocked');
          expect(await Bun.file(\`\${import.meta.dir}/fixture.txt\`).text())
            .toBe('declared-fixture-bytes\\n');
        });
      `,
      'original.test.ts': `
        import { expect, test } from 'bun:test';
        import { value } from './original.ts';
        import { readFile } from 'node:fs/promises';
        import { join } from 'node:path';
        test('original module and declared fixture', async () => {
          expect(value).toBe('original');
          expect(await readFile(join(import.meta.dir, 'fixture.txt'), 'utf8'))
            .toBe('declared-fixture-bytes\\n');
        });
      `,
    };
    for (const [file, bytes] of Object.entries(sources)) {
      await writeFile(path.join(runfiles, 'tests', file), bytes);
    }
    // This extra runfile must stay absent from each copied private test tree.
    await writeFile(path.join(runfiles, 'tests', 'undeclared.txt'), 'ambient-input');
    const runner = new URL('./run-test.ts', import.meta.url).pathname;
    const jobs = ['mocked.test.ts', 'original.test.ts'].map(async (file) => {
      const source = sources[file];
      if (source === undefined) throw new Error('Missing test source');
      const parsed = moduleRequests(file, source);
      expect(parsed.computedFiles).toBe(0);
      expect(parsed.computedImports).toBe(0);
      const originals = parsed.requests.filter((request) => request.startsWith('.'));
      const closure = [
        ...new Set([file, 'empty-bunfig.toml', ...originals, ...parsed.relativeFiles]),
      ];
      expect(closure.some((input) => path.normalize(input) === 'fixture.txt')).toBe(true);
      expect(closure.some((input) => path.normalize(input) === 'original.ts')).toBe(true);
      const manifest = path.join(root, `${file}.manifest.json`);
      await writeFile(
        manifest,
        JSON.stringify({
          cwd: '',
          config: 'tests/empty-bunfig.toml',
          files: Object.fromEntries(
            closure.map((input) => [
              path.join('tests', path.normalize(input)),
              {
                runfile: path.join('tests', path.normalize(input)),
                link: false,
              },
            ]),
          ),
        }),
      );
      const output = path.join(root, `${file}.outputs`);
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          `--config=${path.join(runfiles, 'tests', 'empty-bunfig.toml')}`,
          runner,
          manifest,
          runfiles,
          path.join('tests', file),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            TEST_TMPDIR: scratch,
            TEST_TIMEOUT: '60',
            TEST_UNDECLARED_OUTPUTS_DIR: output,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const xml = await readFile(path.join(output, 'bun-junit.xml'), 'utf8');
      expect({ status, diagnostic: status === 0 ? '' : stdout + stderr + xml }).toEqual({
        status: 0,
        diagnostic: '',
      });
      expect(xml).toContain('tests="1"');
    });
    await Promise.all(jobs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
