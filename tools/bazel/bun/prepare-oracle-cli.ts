import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { admittedInputs, declaredTools } from '../verification/cli';
import { prepareClientSessionOracle } from './prepare-oracle';

export function oraclePreparationArguments(
  root: string,
  args: readonly string[],
): {
  credentialFile: string;
  admitFile?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (
      (name !== '--credential-file' && name !== '--admit-file') ||
      value === undefined ||
      !path.isAbsolute(value) ||
      values.has(name)
    )
      throw new Error('Oracle preparation requires distinct absolute declared File arguments');
    values.set(name, value);
  }
  return {
    credentialFile: values.get('--credential-file') ?? path.join(root, '.bazelrc.local'),
    ...(values.has('--admit-file') ? { admitFile: values.get('--admit-file') } : {}),
  };
}

if (import.meta.main) {
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY;
  if (workspace === undefined || !path.isAbsolute(workspace))
    throw new Error('Oracle preparation requires its declared absolute workspace');
  const root = realpathSync(workspace);
  const options = oraclePreparationArguments(root, process.argv.slice(2));
  const tools = declaredTools(options.credentialFile);
  // macOS reaches its temporary directory through an alias; the engine binds physical roots.
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'merkur-oracle-preparation-')));
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Oracle preparation interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await prepareClientSessionOracle({
      root,
      directory,
      tools,
      signal: cancellation.signal,
      admittedUntracked: await admittedInputs(options.admitFile),
    });
  } catch (error) {
    // The engine's own stdout and stderr stay in its private command directory.
    throw new Error(`Oracle preparation failed; engine evidence ${directory}`, { cause: error });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
