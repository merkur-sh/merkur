import { promises as fs } from 'node:fs';
import path from 'node:path';

const [bindings, output, moduleName, executable, ...flags] = process.argv.slice(2);
if (
  bindings === undefined ||
  output === undefined ||
  moduleName === undefined ||
  executable === undefined ||
  flags.length === 0
) {
  throw new Error('WASM optimization requires its bindings, output, module, tool and exact flags');
}
await fs.cp(bindings, output, { recursive: true, dereference: true });
const wasm = path.join(output, `${moduleName}_bg.wasm`);
const optimized = path.join(output, `${moduleName}_optimized.wasm`);
const result = Bun.spawnSync([executable, wasm, '-o', optimized, ...flags], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if (result.exitCode !== 0) throw new Error(`Declared WASM optimizer exited ${result.exitCode}`);
await fs.rename(optimized, wasm);
