import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The declared checker scans the captured tree; its packages resolve from this test's inputs.
import { scanDocsWithIgnoreLookup } from '../../../scripts/check-docs';
import { validateCapturedDocsAliases } from './docs';
import { validGitContext } from './git-context';
import { isolatedGitIgnore } from './isolated-git';
import { validSourceManifest } from './snapshot';
import { capturedSourcePayload, withCapturedSourceTree } from './source-tree';

test('all documentation policies hold for the declared source tree and captured index', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const payload = process.env.MERKUR_CAPTURED_SOURCE_PAYLOAD;
  const git = process.env.MERKUR_VERIFICATION_GIT;
  const runfiles = process.env.TEST_SRCDIR;
  const scratch = process.env.TEST_TMPDIR;
  const context: unknown = JSON.parse(readFileSync(path.join(here, 'current-git.json'), 'utf8'));
  const source: unknown = JSON.parse(readFileSync(path.join(here, 'full-source.json'), 'utf8'));
  const aliases: unknown = JSON.parse(readFileSync(path.join(here, 'source-aliases.json'), 'utf8'));
  if (
    payload === undefined ||
    !path.isAbsolute(payload) ||
    git === undefined ||
    runfiles === undefined ||
    scratch === undefined ||
    !validGitContext(context)
  )
    throw new Error('Fresh captured Git facts and declared native SDK tools are required');
  if (!validSourceManifest(source) || source.commit !== context.head)
    throw new Error('Complete captured documentation source facts are required');
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
  const parent = mkdtempSync(path.join(scratch, 'captured-docs-'));
  const root = path.join(parent, 'source');
  mkdirSync(root);
  try {
    const original = capturedSourcePayload(payload, runfiles, source);
    await withCapturedSourceTree({ ...original, root, source }, async (capturedRoot) => {
      validateCapturedDocsAliases(capturedRoot, context, aliases);
      isolatedGitIgnore(
        { executable: git, root: capturedRoot, scratch, context, runfiles, sdkEnvironment },
        (ignored) => {
          expect(scanDocsWithIgnoreLookup(capturedRoot, ignored)).toEqual([]);
        },
      );
    });
  } finally {
    rmSync(parent, { recursive: true });
  }
}, 180_000);
