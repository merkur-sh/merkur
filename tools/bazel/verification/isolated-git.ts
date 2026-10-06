import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { type GitContext, validGitContext } from './git-context';

/** Native Git interprets declared ignore files with the exact captured index, without user config. */
export function isolatedGitIgnore(
  options: {
    readonly executable: string;
    readonly root: string;
    readonly scratch: string;
    readonly context: GitContext;
    readonly runfiles: string;
    /** Environment from the declared native SDK provider, never inherited user configuration. */
    readonly sdkEnvironment: Readonly<Record<string, string>>;
  },
  run: (ignored: (relative: string) => boolean) => void,
): void {
  if (
    !path.isAbsolute(options.executable) ||
    !path.isAbsolute(options.root) ||
    !path.isAbsolute(options.scratch) ||
    !path.isAbsolute(options.runfiles) ||
    !validGitContext(options.context)
  )
    throw new Error('Declared Git executable, tree, scratch and valid context are required');
  const directory = mkdtempSync(path.join(options.scratch, 'git-ignore-'));
  const gitDir = path.join(directory, 'metadata');
  const env = {
    ...options.sdkEnvironment,
    HOME: directory,
    PATH: path.join(directory, 'no-ambient-tools'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    TEST_SRCDIR: options.runfiles,
    RUNFILES_DIR: options.runfiles,
  };
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
  function git(args: readonly string[], stdin?: string) {
    const result = Bun.spawnSync([options.executable, ...args], {
      cwd: options.root,
      env,
      stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.signalCode) throw new Error('Declared Git was interrupted');
    return result;
  }
  const common = [
    `--git-dir=${gitDir}`,
    `--work-tree=${options.root}`,
    '-c',
    'core.excludesFile=/dev/null',
    '-c',
    'core.fsmonitor=false',
  ];
  try {
    const initialized = git([
      'init',
      '--bare',
      '--template=',
      `--object-format=${options.context.head.length === 64 ? 'sha256' : 'sha1'}`,
      gitDir,
    ]);
    if (initialized.exitCode !== 0)
      throw new Error(`Cannot initialize isolated Git metadata: ${initialized.stderr.toString()}`);
    const index = git(
      [...common, 'update-index', '-z', '--index-info'],
      options.context.index
        .map((entry) => `${entry.mode} ${entry.object}\t${entry.path}\0`)
        .join(''),
    );
    if (index.exitCode !== 0)
      throw new Error(`Cannot materialize captured Git index: ${index.stderr.toString()}`);
    run((relative) => {
      if (
        relative === '' ||
        path.isAbsolute(relative) ||
        relative.includes('\\') ||
        relative.includes('\0') ||
        relative.split('/').some((part) => part === '' || part === '.' || part === '..')
      )
        throw new Error('Documentation requested an unsafe Git path');
      const result = git([...common, 'check-ignore', '--quiet', '--', relative]);
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error('Declared Git ignore interpretation failed');
      return result.exitCode === 0;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
