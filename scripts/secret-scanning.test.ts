import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installSecretScanning, scanStagedSecrets } from './secret-scanning';
import { linkTestExecutable } from './test-executables';
import pin from './trufflehog.json';

const directories: string[] = [];
const script = path.join(import.meta.dir, 'secret-scanning.ts');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  return stdout.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'merkur-secret-hook-test-'));
  directories.push(root);
  await git(root, 'init', '--quiet');
  await git(root, 'config', 'user.name', 'Hook test');
  await git(root, 'config', 'user.email', 'hook@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function toolDirectory(root: string): string {
  return path.join(root, '.git', 'merkur-tools', `trufflehog-${pin.version}`);
}

function fixtureShell(): string {
  const shell = Bun.which('sh');
  if (shell === null) throw new Error('Secret scanner qualification requires its declared shell');
  return shell;
}

function fixtureBun(): string {
  return `'${process.execPath.replaceAll("'", "'\\''")}'`;
}

async function scanner(root: string, version = pin.version): Promise<void> {
  const directory = toolDirectory(root);
  await mkdir(directory, { recursive: true });
  // The executable is a shared shim, so it runs without a first-launch assessment; it hands
  // its own directory's fake to Bun, and `$0` keeps that directory where Bun would resolve
  // the link away.
  linkTestExecutable(
    directory,
    'trufflehog',
    `#!${fixtureShell()}\nexec ${fixtureBun()} "\${0%/*}/fake.js" "$@"\n`,
  );
  // The fake scanner records the actual exported files, and fails on a harmless
  // sentinel. These tests exercise real Git indexes without contacting providers.
  await writeFile(
    path.join(directory, 'fake.js'),
    `if (process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(`trufflehog ${version}\n`)});
  process.exit(0);
}
const files = {};
for (const name of new Bun.Glob('**/*').scanSync({ dot: true })) {
  files[name] = Buffer.from(await Bun.file(name).arrayBuffer()).toString('base64');
}
await Bun.write(import.meta.dir + '/capture.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), files }));
const failure = Bun.file(import.meta.dir + '/exit-code');
process.exit(await failure.exists() ? Number(await failure.text()) : Object.values(files).some(value => Buffer.from(value, 'base64').toString().includes('STAGED_TEST_SECRET')) ? 183 : 0);
`,
  );
}

async function capture(root: string): Promise<{
  cwd: string;
  args: string[];
  files: Record<string, string>;
}> {
  return JSON.parse(await readFile(path.join(toolDirectory(root), 'capture.json'), 'utf8'));
}

async function stage(root: string, name: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), contents);
  await git(root, 'add', '--', name);
}

describe('staged secret scanning', () => {
  test('empty initial index and deletion-only commits do not need a scanner', async () => {
    const root = await repository();
    expect(await scanStagedSecrets(root)).toBe(0);
    await stage(root, 'removed.txt', 'old contents');
    await git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'initial');
    await git(root, 'rm', '--quiet', 'removed.txt');
    expect(await scanStagedSecrets(root)).toBe(0);
  });

  test('scans initial staged bytes, unusual paths and binary bytes without changing the index', async () => {
    const root = await repository();
    await scanner(root);
    const name = 'nested/space tab\tnewline\n雪.txt';
    const bytes = Buffer.from([0, 255, 1, 10, 128]);
    await stage(root, name, bytes);
    await stage(root, '-leading-dash', 'staged');
    await writeFile(path.join(root, name), 'unstaged');
    await writeFile(path.join(root, 'untracked'), 'not staged');
    const before = await git(root, 'write-tree');
    expect(await scanStagedSecrets(root)).toBe(0);
    const result = await capture(root);
    expect(result.files).toEqual({
      [name]: bytes.toString('base64'),
      '-leading-dash': Buffer.from('staged').toString('base64'),
    });
    expect(result.args).toContain('--results=verified,unknown');
    expect(result.args).toContain('--fail-on-scan-errors');
    expect(result.args).toContain('--fail');
    expect(await git(root, 'write-tree')).toBe(before);
    expect(await Bun.file(path.join(root, name)).text()).toBe('unstaged');
    await expect(stat(result.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a clean working copy cannot hide a staged secret, and unstaged secrets do not block clean staged bytes', async () => {
    const root = await repository();
    await scanner(root);
    await stage(root, 'partial.txt', 'STAGED_TEST_SECRET');
    await writeFile(path.join(root, 'partial.txt'), 'clean');
    expect(await scanStagedSecrets(root)).toBe(183);
    await git(root, 'add', 'partial.txt');
    await writeFile(path.join(root, 'partial.txt'), 'STAGED_TEST_SECRET');
    expect(await scanStagedSecrets(root)).toBe(0);
  });

  test('renamed files are scanned and symlink targets are never read', async () => {
    const root = await repository();
    await scanner(root);
    await stage(root, 'old.txt', 'content');
    await git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'initial');
    await git(root, 'mv', 'old.txt', 'renamed.txt');
    await writeFile(path.join(root, 'outside'), 'STAGED_TEST_SECRET');
    await symlink(path.join(root, 'outside'), path.join(root, 'link'));
    await git(root, 'add', 'link');
    expect(await scanStagedSecrets(root)).toBe(0);
    expect((await capture(root)).files).toEqual({
      'renamed.txt': Buffer.from('content').toString('base64'),
      link: Buffer.from(path.join(root, 'outside')).toString('base64'),
    });
  });

  test('missing and mismatched scanners block staged files', async () => {
    const root = await repository();
    await stage(root, 'file', 'content');
    await expect(scanStagedSecrets(root)).rejects.toThrow('setup:hooks');
    await scanner(root, '0.0.0');
    await expect(scanStagedSecrets(root)).rejects.toThrow('setup:hooks');
  });

  test('scanner errors propagate and the private export is removed', async () => {
    const root = await repository();
    await scanner(root);
    await stage(root, 'file', 'content');
    await writeFile(path.join(toolDirectory(root), 'exit-code'), '17');
    expect(await scanStagedSecrets(root)).toBe(17);
    await expect(stat((await capture(root)).cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('honors GIT_INDEX_FILE instead of reading the default index', async () => {
    const root = await repository();
    await scanner(root);
    await stage(root, 'file', 'STAGED_TEST_SECRET');
    const alternate = path.join(root, '.git', 'alternate-index');
    await copyFile(path.join(root, '.git', 'index'), alternate);
    await stage(root, 'file', 'clean');
    const staged = Bun.spawn([process.execPath, script, 'staged'], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: alternate },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await staged.exited).toBe(183);
    expect(await scanStagedSecrets(root)).toBe(0);
  });

  test('an installed hook blocks git commit -a using its temporary index', async () => {
    const root = await repository();
    await scanner(root);
    await stage(root, 'file', 'clean');
    await git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'initial');
    await mkdir(path.join(root, '.githooks'));
    await writeFile(
      path.join(root, '.githooks/pre-commit'),
      `#!${fixtureShell()}\nexec ${fixtureBun()} "$MERKUR_TEST_SCANNER_SCRIPT" staged\n`,
    );
    await installSecretScanning(root);
    await installSecretScanning(root);
    const head = await git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'file'), 'STAGED_TEST_SECRET');
    const commit = Bun.spawn(['git', 'commit', '-am', 'must fail'], {
      cwd: root,
      env: { ...process.env, MERKUR_TEST_SCANNER_SCRIPT: script },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await commit.exited).not.toBe(0);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'config', '--get', 'core.hooksPath')).toBe('.githooks');
  });

  test('installation preserves existing custom hook configuration and executable hooks', async () => {
    const root = await repository();
    await git(root, 'config', 'core.hooksPath', 'custom-hooks');
    await expect(installSecretScanning(root)).rejects.toThrow('Existing core.hooksPath');
    expect(await git(root, 'config', '--get', 'core.hooksPath')).toBe('custom-hooks');
    await git(root, 'config', '--unset', 'core.hooksPath');
    const hook = path.join(root, '.git/hooks/pre-push');
    const source = `#!${fixtureShell()}\nexit 0\n`;
    await writeFile(hook, source);
    await chmod(hook, 0o755);
    await expect(installSecretScanning(root)).rejects.toThrow('Existing Git hook pre-push');
    expect(await Bun.file(hook).text()).toBe(source);
  });

  test('linked worktrees share the pinned binary but scan their own index', async () => {
    const root = await repository();
    await scanner(root);
    await stage(root, 'file', 'clean');
    await git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'initial');
    const linked = path.join(root, 'linked');
    await git(root, 'worktree', 'add', '--quiet', '--detach', linked);
    await stage(linked, 'file', 'STAGED_TEST_SECRET');
    expect(await scanStagedSecrets(linked)).toBe(183);
    expect(await scanStagedSecrets(root)).toBe(0);
  });

  test('a checksum mismatch installs neither a binary nor Git hook configuration', async () => {
    const root = await repository();
    const download = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('corrupt archive'));
    try {
      await expect(installSecretScanning(root)).rejects.toThrow('checksum mismatch');
      expect(await Bun.file(path.join(toolDirectory(root), 'trufflehog')).exists()).toBe(false);
      expect(
        await Bun.spawn(['git', 'config', '--get', 'core.hooksPath'], {
          cwd: root,
          stdout: 'ignore',
          stderr: 'ignore',
        }).exited,
      ).toBe(1);
    } finally {
      download.mockRestore();
    }
  });
});
