import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { greenTestFiles } from '../../../scripts/verification-junit';
import { withDeclaredDragonfly } from './dragonfly-runtime';

export async function runDragonflyTests(testFiles: readonly string[]): Promise<void> {
  const executable = process.env.MERKUR_DRAGONFLY_BIN;
  const loader = process.env.MERKUR_DRAGONFLY_LOADER;
  const sdk = process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
  const scratch = process.env.TEST_TMPDIR;
  const config = process.env.MERKUR_BUN_TEST_CONFIG;
  if (
    executable === undefined ||
    loader === undefined ||
    sdk === undefined ||
    scratch === undefined ||
    config === undefined
  )
    throw new Error(
      'Dragonfly operation requires its declared executable, Bun config and engine scratch',
    );
  const root = await realpath(process.cwd());
  if (testFiles.length === 0 || new Set(testFiles).size !== testFiles.length)
    throw new Error('Dragonfly requires the complete explicit suite inventory');
  const selected = await Promise.all(
    testFiles.map(async (file) => {
      if (
        path.isAbsolute(file) ||
        file.split('/').includes('..') ||
        !file.endsWith('.dragonfly.test.ts')
      )
        throw new Error(
          'Dragonfly test must be an explicit original source inside the copied runtime',
        );
      const physical = await realpath(path.join(root, file));
      if (!physical.startsWith(`${root}${path.sep}`) || !(await stat(physical)).isFile())
        throw new Error('Dragonfly source escaped its copied runtime');
      return physical;
    }),
  );
  const directory = await mkdtemp(path.join(scratch, 'dragonfly-'));
  const lifetime = new AbortController();
  const interrupt = () => lifetime.abort(new Error('Dragonfly operation interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const outputs = process.env.TEST_UNDECLARED_OUTPUTS_DIR ?? scratch;
  const report = path.join(outputs, 'bun-junit.xml');
  try {
    await mkdir(outputs, { recursive: true });
    await rm(report, { force: true });
    await withDeclaredDragonfly(
      {
        executable,
        loader,
        libraryDirectory: path.join(sdk, 'lib'),
        directory,
        signal: lifetime.signal,
      },
      async (redisUrl, signal) => {
        const child = Bun.spawn(
          [
            process.execPath,
            '--no-install',
            '--no-env-file',
            `--config=${config}`,
            '--preload',
            path.join(root, 'scripts/test-preload.ts'),
            'test',
            ...selected,
            '--reporter=junit',
            '--reporter-outfile',
            report,
          ],
          {
            cwd: root,
            env: { ...process.env, DRAGONFLY_TEST_URL: redisUrl },
            signal,
            stdout: 'inherit',
            stderr: 'inherit',
          },
        );
        const status = await child.exited;
        signal.throwIfAborted();
        const xml = await readFile(report, 'utf8');
        const xmlOutput = process.env.XML_OUTPUT_FILE;
        if (xmlOutput !== undefined) await writeFile(xmlOutput, xml);
        if (status !== 0 || child.signalCode !== null)
          throw new Error(`Original Dragonfly suites failed (${status})`);
        if (greenTestFiles(xml, root, selected).length !== selected.length)
          throw new Error(
            'Dragonfly report does not establish a complete pass for every original suite',
          );
      },
    );
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await runDragonflyTests(process.argv.slice(2));
