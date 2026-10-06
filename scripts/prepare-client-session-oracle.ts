import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLIENT_SESSION_ORACLE_BUILD,
  CLIENT_SESSION_ORACLE_MANIFEST,
  clientSessionOracleExecutable,
  clientSessionOracleManifest,
  clientSessionOracleSource,
  retainClientSessionOracle,
} from './perf/client-session-oracle';

const root = path.resolve(import.meta.dir, '..');
if (import.meta.main) {
  let cached = false;
  try {
    clientSessionOracleExecutable(root);
    cached = true;
  } catch {
    /* deterministic cache miss */
  }
  if (!cached) {
    const source = clientSessionOracleSource(root);
    const env = { ...process.env, CARGO_INCREMENTAL: '0' };
    Reflect.deleteProperty(env, 'RUSTUP_TOOLCHAIN');
    const [command, ...args] = CLIENT_SESSION_ORACLE_BUILD;
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
    const completed = once(child, 'close');
    let output = '';
    if (child.stdout === null) throw new Error('oracle build output missing');
    for await (const chunk of child.stdout) output += String(chunk);
    const [code] = await completed;
    if (code !== 0) throw new Error(`oracle preflight build failed: ${code}`);
    let executable: string | undefined;
    for (const line of output.split('\n')) {
      if (line === '') continue;
      const item = JSON.parse(line) as {
        reason?: string;
        target?: { name?: string };
        executable?: string;
      };
      if (item.reason === 'compiler-artifact' && item.target?.name === 'browser_session_oracle')
        executable = item.executable;
    }
    if (executable === undefined) throw new Error('oracle executable receipt missing');
    const manifest = clientSessionOracleManifest(root, retainClientSessionOracle(root, executable));
    if (manifest.source !== source) throw new Error('oracle source changed during preflight build');
    const file = path.join(root, CLIENT_SESSION_ORACLE_MANIFEST);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(manifest)}\n`);
    clientSessionOracleExecutable(root);
  }
}
