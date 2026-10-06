import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type GitContext, validGitContext } from './git-context';

export interface GitObjectEvidence {
  readonly contextDigest: string;
  readonly packDigest: string;
  readonly packBytes: number;
  /** Exact ancestry boundaries of the acquired object closure. */
  readonly shallow: readonly string[];
}

/**
 * Import a declared object closure into private Git metadata. Ratchet analyses can
 * create their own baseline worktrees without opening the original checkout's .git.
 */
export function withGitObjects(
  options: {
    readonly executable: string;
    readonly root: string;
    readonly scratch: string;
    readonly pack: string;
    readonly evidence: GitObjectEvidence;
    readonly context: GitContext;
    readonly sdkEnvironment: Readonly<Record<string, string>>;
  },
  run: (environment: Readonly<Record<string, string>>) => void,
): void {
  const evidence = options.evidence;
  if (
    !validGitContext(options.context) ||
    ![options.executable, options.root, options.scratch, options.pack].every(path.isAbsolute) ||
    evidence.contextDigest !== options.context.digest ||
    !/^[a-f0-9]{64}$/.test(evidence.packDigest) ||
    !Number.isSafeInteger(evidence.packBytes) ||
    evidence.packBytes < 12 ||
    !Array.isArray(evidence.shallow) ||
    new Set(evidence.shallow).size !== evidence.shallow.length ||
    evidence.shallow.some(
      (id) => !new RegExp(`^[a-f0-9]{${options.context.head.length}}$`).test(id),
    )
  )
    throw new Error('Invalid declared Git object evidence');
  const pack = readFileSync(options.pack);
  if (
    pack.length !== evidence.packBytes ||
    pack.subarray(0, 4).toString() !== 'PACK' ||
    createHash('sha256').update(pack).digest('hex') !== evidence.packDigest
  )
    throw new Error('Declared Git object bytes differ from their evidence');
  const sdkKeys = new Set([
    'DYLD_LIBRARY_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH',
    'GIT_EXEC_PATH',
    'GIT_TEMPLATE_DIR',
    'OPENSSL_CONF',
    'OPENSSL_MODULES',
    'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
  ]);
  if (Object.keys(options.sdkEnvironment).some((key) => !sdkKeys.has(key)))
    throw new Error('Git SDK environment contains an undeclared setting');
  const marker = path.join(options.root, '.git');
  if (existsSync(marker)) throw new Error('Ratchet requires a private tree without Git metadata');
  const directory = mkdtempSync(path.join(options.scratch, 'git-objects-'));
  const metadata = path.join(directory, 'metadata');
  const environment = {
    ...options.sdkEnvironment,
    HOME: directory,
    PATH: path.dirname(options.executable),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  let ownedMarker: ReturnType<typeof lstatSync> | undefined;
  const failures: unknown[] = [];
  function git(args: readonly string[], input?: Uint8Array): string {
    const result = Bun.spawnSync([options.executable, ...args], {
      cwd: options.root,
      env: environment,
      stdin: input === undefined ? 'ignore' : input,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0 || result.signalCode)
      throw new Error(`Declared Git object operation failed: ${result.stderr.toString()}`);
    return result.stdout.toString();
  }
  try {
    git([
      'init',
      '--bare',
      '--template=',
      `--object-format=${options.context.head.length === 64 ? 'sha256' : 'sha1'}`,
      metadata,
    ]);
    const prefix = [`--git-dir=${metadata}`];
    git([...prefix, 'index-pack', '--stdin'], pack);
    if (evidence.shallow.length > 0)
      writeFileSync(path.join(metadata, 'shallow'), `${evidence.shallow.join('\n')}\n`);
    for (const id of evidence.shallow)
      if (git([...prefix, 'rev-parse', '--verify', `${id}^{commit}`]).trim() !== id)
        throw new Error('Git ancestry boundary does not identify an acquired commit');
    for (const [id, tree] of [
      [options.context.base, options.context.baseTree],
      [options.context.candidate, options.context.candidateTree],
    ])
      if (git([...prefix, 'rev-parse', '--verify', `${id}^{tree}`]).trim() !== tree)
        throw new Error('Git object closure does not match captured source identities');
    git([...prefix, 'update-ref', 'HEAD', options.context.head]);
    git([...prefix, 'config', 'core.bare', 'false']);
    git([...prefix, 'config', 'core.worktree', options.root]);
    git([...prefix, 'config', 'core.excludesFile', '/dev/null']);
    git([...prefix, 'config', 'core.fsmonitor', 'false']);
    git(
      [...prefix, 'update-index', '-z', '--index-info'],
      Buffer.from(
        options.context.index
          .map((entry) => `${entry.mode} ${entry.object}\t${entry.path}\0`)
          .join(''),
      ),
    );
    git([...prefix, 'fsck', '--connectivity-only', '--no-reflogs']);
    writeFileSync(marker, `gitdir: ${metadata}\n`, { flag: 'wx' });
    ownedMarker = lstatSync(marker);
    run(environment);
  } catch (error) {
    failures.push(error);
  }
  if (ownedMarker !== undefined) {
    try {
      const current = lstatSync(marker);
      if (
        !current.isFile() ||
        current.dev !== ownedMarker.dev ||
        current.ino !== ownedMarker.ino ||
        current.ctimeMs !== ownedMarker.ctimeMs ||
        readFileSync(marker, 'utf8') !== `gitdir: ${metadata}\n`
      )
        throw new Error('Private Git marker ownership changed during analysis');
      rmSync(marker);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Git object analysis and cleanup failed');
}
