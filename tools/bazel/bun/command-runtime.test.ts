import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeclaredInput } from '../verification/artifacts';

const runner = fileURLToPath(new URL('./run-test.ts', import.meta.url));
const artifacts = fileURLToPath(new URL('../verification/artifacts.ts', import.meta.url));

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'merkur-command-runtime-')));
  const original = path.join(root, 'original');
  const runfiles = path.join(root, 'runfiles');
  const scratch = path.join(root, 'scratch');
  const outputs = path.join(root, 'outputs');
  for (const directory of [original, runfiles, scratch, outputs]) await mkdir(directory);
  const files: Record<string, { runfile: string; link: boolean }> = {};
  async function declare(relative: string, content: string) {
    const source = path.join(original, relative);
    const runfile = `_main/${relative}`;
    const presentation = path.join(runfiles, runfile);
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(presentation), { recursive: true });
    await writeFile(source, content);
    if (files[relative] === undefined) await symlink(source, presentation);
    files[relative] = { runfile, link: false };
  }
  await declare('bunfig.toml', '');
  const manifest = path.join(root, 'runtime-inputs.json');
  async function execute(inventory: readonly string[], cwd = '') {
    await writeFile(manifest, JSON.stringify({ files, cwd, config: 'bunfig.toml' }));
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        '--config=tools/bazel/bun/empty-bunfig.toml',
        runner,
        manifest,
        runfiles,
        ...inventory,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: '',
          HOME: scratch,
          TEST_TMPDIR: scratch,
          TEST_UNDECLARED_OUTPUTS_DIR: outputs,
        },
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, stdout, stderr };
  }
  return {
    root,
    original,
    runfiles,
    outputs,
    declare,
    execute,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('declared commands read copied regular descriptors and inputs with exact literal arguments', async () => {
  const f = await fixture();
  try {
    await f.declare('tools/bazel/verification/artifacts.ts', await readFile(artifacts, 'utf8'));
    await f.declare('descriptor.json', JSON.stringify({ file: 'inputs/content.txt' }));
    await f.declare('inputs/content.txt', 'declared input\n');
    await f.declare(
      'scripts/command.ts',
      `import { existsSync, lstatSync } from 'node:fs';
import { readDeclaredInput } from '../tools/bazel/verification/artifacts';
const descriptor = await readDeclaredInput(process.cwd(), 'descriptor.json');
const { file } = JSON.parse(descriptor.bytes.toString());
const input = await readDeclaredInput(process.cwd(), file);
if (!lstatSync('descriptor.json').isFile() || !lstatSync(file).isFile())
  throw new Error('Command inputs were not materialized as regular Files');
if (existsSync('undeclared.txt')) throw new Error('Command materialized an undeclared input');
if (Bun.which('git') !== null) throw new Error('Command acquired an ambient utility');
process.stdout.write(JSON.stringify({ content: input.bytes.toString(), args: process.argv.slice(2),
  cwd: process.cwd(), runfiles: process.env.MERKUR_BAZEL_RUNFILES_ROOT }));
`,
    );
    await writeFile(path.join(f.runfiles, '_main', 'undeclared.txt'), 'not declared\n');
    await expect(
      readDeclaredInput(path.join(f.runfiles, '_main'), 'descriptor.json'),
    ).rejects.toThrow('escapes');
    const args = ['literal with spaces', 'literal\nnewline', '$(not-a-shell)'];
    const result = await f.execute(['--command', 'run', './scripts/command.ts', ...args]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.content).toBe('declared input\n');
    expect(output.args).toEqual(args);
    expect(output.cwd.startsWith(path.join(f.root, 'scratch', 'bun-runtime-'))).toBe(true);
    expect(output.runfiles).toBe(f.runfiles);
    await expect(readFile(path.join(f.outputs, 'bun-junit.xml'), 'utf8')).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test('declared command failures propagate their exact exit status without a fabricated JUnit report', async () => {
  const f = await fixture();
  try {
    await f.declare(
      'scripts/fail.ts',
      'process.stderr.write("declared failure\\n"); process.exit(23);',
    );
    const result = await f.execute(['--command', 'run', 'scripts/fail.ts']);
    expect(result.status).toBe(23);
    expect(result.stderr).toContain('declared failure');
    await expect(readFile(path.join(f.outputs, 'bun-junit.xml'), 'utf8')).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test('command mode cannot run undeclared scripts or package scripts', async () => {
  const f = await fixture();
  try {
    await f.declare('package.json', JSON.stringify({ scripts: { ambient: 'git status' } }));
    await writeFile(path.join(f.runfiles, '_main', 'undeclared.ts'), 'process.exit(0);');
    for (const args of [
      ['--command', 'run', 'undeclared.ts'],
      ['--command', 'run', 'ambient'],
      ['--command', 'test', 'undeclared.ts'],
    ]) {
      const result = await f.execute(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Bazel Bun command');
    }
  } finally {
    await f.close();
  }
});

test('ordinary test mode retains declared preloads and complete JUnit validation', async () => {
  const f = await fixture();
  try {
    await f.declare('bunfig.toml', '[test]\npreload = ["./scripts/preload.ts"]\n');
    await f.declare(
      'scripts/preload.ts',
      "process.env.MERKUR_COMMAND_CONTROL = 'declared preload';",
    );
    await f.declare(
      'scripts/ordinary.test.ts',
      `import { expect, test } from 'bun:test';
test('declared preload survives the shared materializer', () => {
  expect(process.env.MERKUR_COMMAND_CONTROL).toBe('declared preload');
});
`,
    );
    const result = await f.execute(['scripts/ordinary.test.ts']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('1 pass');
    expect(await readFile(path.join(f.outputs, 'bun-junit.xml'), 'utf8')).toContain('<testsuites');
  } finally {
    await f.close();
  }
});

test('declared command entry points preserve nested working directories and TypeScript aliases', async () => {
  const f = await fixture();
  try {
    await f.declare('alias.ts', 'export const value = 42;');
    await f.declare(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { 'declared-alias': ['./alias.ts'] } },
      }),
    );
    await f.declare('nested/tsconfig.json', '{"extends":"../tsconfig.json"}');
    await f.declare('nested/marker.txt', 'nested declared marker\n');
    await f.declare(
      'nested/command.ts',
      `import { value } from 'declared-alias';
import { readFileSync } from 'node:fs';
import path from 'node:path';
if (path.basename(process.cwd()) !== 'nested') throw new Error('Declared cwd changed');
if (value !== 42) throw new Error('Declared alias changed');
process.stdout.write(readFileSync('marker.txt', 'utf8'));
`,
    );
    const result = await f.execute(['--command', 'run', 'nested/command.ts'], 'nested');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('nested declared marker\n');
  } finally {
    await f.close();
  }
});
