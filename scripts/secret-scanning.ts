import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pin from './trufflehog.json';

/** Shared pinned engine flags for ordinary and declared staged blob consumers. */
export const SECRET_SCAN_ARGUMENTS: readonly string[] = Object.freeze([
  'filesystem',
  '.',
  '--results=verified,unknown',
  '--fail',
  '--fail-on-scan-errors',
  '--no-update',
  '--github-actions',
  '--log-level=-1',
]);

async function command(root: string, args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: Buffer.from(stdout), stderr };
}

async function git(root: string, args: string[]): Promise<Buffer> {
  const result = await command(root, ['git', ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout;
}

async function scannerPath(root: string): Promise<string> {
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    .toString()
    .trim();
  return path.join(common, 'merkur-tools', `trufflehog-${pin.version}`, 'trufflehog');
}

async function verifyScanner(binary: string): Promise<void> {
  const result = await command(path.dirname(binary), [binary, '--version']);
  const version = `${result.stdout}${result.stderr}`.trim();
  if (result.exitCode !== 0 || version !== `trufflehog ${pin.version}`) {
    throw new Error(
      `TruffleHog ${pin.version} is required; remove ${binary} and run bun run setup:hooks.`,
    );
  }
}

export async function installSecretScanning(root: string): Promise<void> {
  const configured = await command(root, ['git', 'config', '--get', 'core.hooksPath']);
  if (configured.exitCode !== 0 && configured.exitCode !== 1) {
    throw new Error('Cannot read Git hook configuration.');
  }
  const hooksPath = configured.stdout.toString().trim();
  if (hooksPath && hooksPath !== '.githooks') {
    throw new Error(
      `Existing core.hooksPath=${hooksPath}; resolve it before installing Merkur hooks.`,
    );
  }
  if (!hooksPath) {
    const hooks = path.resolve(
      root,
      (await git(root, ['rev-parse', '--git-path', 'hooks'])).toString().trim(),
    );
    for (const entry of await readdir(hooks, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    })) {
      if (entry.name.endsWith('.sample')) continue;
      if ((await stat(path.join(hooks, entry.name))).mode & 0o111) {
        throw new Error(
          `Existing Git hook ${entry.name}; resolve it before installing Merkur hooks.`,
        );
      }
    }
  }

  const binary = await scannerPath(root);
  if (!(await Bun.file(binary).exists())) {
    const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
    const platform = `${process.platform}-${architecture}`;
    const checksum = Object.entries(pin.checksums).find(([key]) => key === platform)?.[1];
    if (!checksum) throw new Error(`No pinned TruffleHog binary for ${platform}.`);
    const directory = path.dirname(binary);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(directory, 'install-'));
    try {
      const archive = `trufflehog_${pin.version}_${process.platform}_${architecture}.tar.gz`;
      const response = await fetch(
        `https://github.com/trufflesecurity/trufflehog/releases/download/v${pin.version}/${archive}`,
      );
      if (!response.ok) throw new Error(`TruffleHog download failed: HTTP ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
        throw new Error('TruffleHog archive checksum mismatch.');
      }
      const archivePath = path.join(temporary, archive);
      await writeFile(archivePath, bytes, { mode: 0o600 });
      const unpack = await command(root, [
        'tar',
        '-xzf',
        archivePath,
        '-C',
        temporary,
        'trufflehog',
      ]);
      if (unpack.exitCode !== 0) throw new Error('Cannot extract TruffleHog.');
      const executable = path.join(temporary, 'trufflehog');
      await chmod(executable, 0o700);
      await verifyScanner(executable);
      await rename(executable, binary);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await verifyScanner(binary);
  await chmod(path.join(root, '.githooks/pre-commit'), 0o755);
  await git(root, ['config', '--local', 'core.hooksPath', '.githooks']);
  process.stdout.write(`Installed pre-commit secret scanning with TruffleHog ${pin.version}.\n`);
}

export async function scanStagedSecrets(root: string): Promise<number> {
  // Raw, NUL-delimited records bind each path to its immutable staged blob. No
  // checkout filters, working-tree reads, or index writes participate in the scan.
  const raw = await git(root, [
    'diff',
    '--cached',
    '--raw',
    '--no-abbrev',
    '--no-renames',
    '--no-ext-diff',
    '-z',
    '--diff-filter=ACMTU',
  ]);
  const records = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
  const blobs: { name: string; object: string }[] = [];
  for (let index = 0; index < records.length - 1; index += 2) {
    const header = records[index];
    const name = records[index + 1];
    const [, mode, , object, status] = header?.split(' ') ?? [];
    if (!name || !object || !mode || !status || status === 'U') {
      throw new Error('Cannot scan an unresolved or malformed Git index.');
    }
    // Gitlinks name commits in another repository, not file contents in this one.
    if (mode === '160000') continue;
    blobs.push({ name, object });
  }
  if (blobs.length === 0) return 0;

  const binary = await scannerPath(root);
  if (!(await Bun.file(binary).exists())) {
    throw new Error('Secret scanner is not installed; run bun run setup:hooks.');
  }
  await verifyScanner(binary);
  const temporary = await mkdtemp(path.join(tmpdir(), 'merkur-staged-secrets-'));
  try {
    for (const blob of blobs) {
      const destination = path.resolve(temporary, blob.name);
      if (!destination.startsWith(`${temporary}${path.sep}`)) {
        throw new Error('Staged path escapes the scan directory.');
      }
      await mkdir(path.dirname(destination), { recursive: true });
      // Symlink blobs are written as ordinary text: never follow their targets.
      await writeFile(destination, await git(root, ['cat-file', 'blob', blob.object]), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    process.stderr.write(`Scanning ${blobs.length} staged file(s) for secrets...\n`);
    const scan = Bun.spawn([binary, ...SECRET_SCAN_ARGUMENTS], {
      cwd: temporary,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await scan.exited;
    if (exitCode !== 0) {
      process.stderr.write(
        'Secret scan failed; commit blocked. Review findings or scanner errors above.\n',
      );
    }
    return exitCode;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const root = (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).toString().trim();
    if (process.argv[2] === 'install') await installSecretScanning(root);
    else if (process.argv[2] === 'staged') process.exitCode = await scanStagedSecrets(root);
    else throw new Error('Usage: bun run scripts/secret-scanning.ts <install|staged>');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
