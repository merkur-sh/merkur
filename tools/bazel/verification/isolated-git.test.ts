import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureGitContext } from './git-context';
import { isolatedGitIgnore } from './isolated-git';

test('native Git preserves tracked exclusions and nested rules without ambient metadata or config', () => {
  const tool = Bun.which('git');
  if (tool === null) throw new Error('Declared native Git required');
  const runfiles = process.env.TEST_SRCDIR;
  if (runfiles === undefined) throw new Error('Engine runfiles required');
  const sdkEnvironment = Object.fromEntries(
    [
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
    ].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-isolated-git-'));
  const head = 'a'.repeat(40);
  const context = captureGitContext(
    (args) => {
      if (args[0] === 'rev-parse') return `${head}\n`;
      if (args.includes('-v')) return 'H tracked.output\0';
      if (args.includes('--stage')) return `100644 ${head} 0\ttracked.output\0`;
      return '';
    },
    head,
    head,
  );
  try {
    writeFileSync(path.join(root, '.gitignore'), '*.output\nignored/\n!keep.output\n');
    mkdirSync(path.join(root, 'nested'));
    writeFileSync(path.join(root, 'nested', '.gitignore'), 'specific.txt\n');
    isolatedGitIgnore(
      { executable: tool, root, scratch: root, context, runfiles, sdkEnvironment },
      (ignored) => {
        expect(ignored('missing.output')).toBe(true);
        expect(ignored('tracked.output')).toBe(false);
        expect(ignored('keep.output')).toBe(false);
        expect(ignored('nested/specific.txt')).toBe(true);
        expect(ignored('nested/unmatched.txt')).toBe(false);
        expect(ignored('ignored/child.txt')).toBe(true);
        expect(() => ignored('../private')).toThrow('unsafe');
      },
    );
    expect(() =>
      isolatedGitIgnore(
        {
          executable: tool,
          root,
          scratch: root,
          context: { ...context, digest: '' },
          runfiles,
          sdkEnvironment,
        },
        () => {},
      ),
    ).toThrow('valid context');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
