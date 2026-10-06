import { expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('declared repository input action preserves exact file namespaces and bytes', async () => {
  const output = new URL('../wasm/input_tree_fixture/', import.meta.url);
  expect(
    await Bun.file(new URL('tools/bazel/wasm/fixtures/input-tree/one.txt', output)).text(),
  ).toBe('declared first input\n');
  expect(
    await Bun.file(new URL('tools/bazel/wasm/fixtures/input-tree/nested/two.txt', output)).text(),
  ).toBe('declared nested input\n');
});

test('repository tree rejects escapes, malformed input maps and missing declared files', async () => {
  const temporary = process.env.TEST_TMPDIR;
  if (temporary === undefined)
    throw new Error('Repository tree controls require isolated test space');
  const owner = await fs.mkdtemp(path.join(temporary, 'input-tree-control-'));
  try {
    const input = path.join(owner, 'input.txt');
    await fs.writeFile(input, 'controlled bytes');
    await fs.chmod(input, 0o755);
    const positiveManifest = path.join(owner, 'positive.json');
    const positiveOutput = path.join(owner, 'positive-output');
    await fs.writeFile(positiveManifest, JSON.stringify({ 'scripts/executable': input }));
    const positive = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        `--config=${process.env.MERKUR_BUN_TEST_CONFIG}`,
        new URL('../wasm/input-tree.ts', import.meta.url).pathname,
        positiveManifest,
        positiveOutput,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(positive.exitCode, positive.stderr.toString()).toBe(0);
    const copied = path.join(positiveOutput, 'scripts/executable');
    expect(await fs.readFile(copied, 'utf8')).toBe('controlled bytes');
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o755);
    const malformed: unknown[] = [
      { '../escaped.txt': input },
      { '/absolute.txt': input },
      { 'double//slash.txt': input },
      { 'valid.txt': 7 },
      { 'valid.txt': path.join(owner, 'missing.txt') },
      null,
      [],
    ];
    for (const [index, mapping] of malformed.entries()) {
      const manifest = path.join(owner, `manifest-${index}.json`);
      await fs.writeFile(manifest, JSON.stringify(mapping));
      const result = Bun.spawnSync(
        [
          process.execPath,
          '--no-env-file',
          `--config=${process.env.MERKUR_BUN_TEST_CONFIG}`,
          new URL('../wasm/input-tree.ts', import.meta.url).pathname,
          manifest,
          path.join(owner, `output-${index}`),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(result.exitCode).not.toBe(0);
    }
    expect(await Bun.file(path.join(owner, 'escaped.txt')).exists()).toBe(false);
  } finally {
    await fs.rm(owner, { recursive: true, force: true });
  }
});
