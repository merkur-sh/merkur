import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const reserved = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'NODE_PATH',
  'BUN_INSTALL',
  'RUNFILES_DIR',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
]);

export function declaredEnvironmentFiles(
  value: unknown,
  runfiles: string,
): Readonly<Record<string, string>> {
  if (
    !path.isAbsolute(runfiles) ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new Error(
      'Environment File mapping requires its engine-owned manifest and absolute runfiles root',
    );
  const result: Record<string, string> = {};
  for (const [variable, relative] of Object.entries(value)) {
    if (
      !/^[A-Z_][A-Z_0-9]*$/.test(variable) ||
      reserved.has(variable) ||
      variable.startsWith('TEST_') ||
      variable.startsWith('XML_') ||
      variable.startsWith('MERKUR_BAZEL_')
    )
      throw new Error('Environment File variable is invalid or reserved');
    if (
      typeof relative !== 'string' ||
      path.isAbsolute(relative) ||
      relative.split('/').some((part) => part === '..' || part === '' || part === '.')
    )
      throw new Error('Environment File escaped its declared runfile identity');
    const file = realpathSync(path.join(runfiles, relative));
    if (!statSync(file).isFile())
      throw new Error('Environment mapping requires a regular declared File');
    result[variable] = file;
  }
  return result;
}

// This synchronous preload runs in the original Bun process before its entrypoint.
// It adds no process wrapper and preserves CLI/test signal and exit semantics.
const manifest = process.env.MERKUR_BAZEL_ENVIRONMENT_FILE_MANIFEST;
if (manifest !== undefined) {
  const root = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  if (root === undefined)
    throw new Error('Declared environment Files lack their engine runfiles root');
  const environment = declaredEnvironmentFiles(JSON.parse(readFileSync(manifest, 'utf8')), root);
  for (const [variable, file] of Object.entries(environment)) process.env[variable] = file;
}
