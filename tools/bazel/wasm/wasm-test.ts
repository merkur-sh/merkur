import { statSync } from 'node:fs';
import path from 'node:path';

function executableFile(value: string | undefined, role: string): string {
  if (!value || !path.isAbsolute(value) || !statSync(value).isFile()) {
    throw new Error(`WASM cipher requires its declared ${role} File`);
  }
  return value;
}

export function wasmCipherInvocation(environment: NodeJS.ProcessEnv) {
  const harness = executableFile(environment.MERKUR_WASM_TEST_HARNESS, 'test harness');
  const runner = executableFile(environment.MERKUR_WASM_TEST_RUNNER, 'test runner');
  const node = executableFile(environment.MERKUR_WASM_TEST_NODE, 'Node runtime');
  const temporary = environment.TEST_TMPDIR;
  if (!temporary || !path.isAbsolute(temporary) || !statSync(temporary).isDirectory()) {
    throw new Error('WASM cipher requires the owning Bazel test temporary directory');
  }
  // The original CLI invokes `node --expose-gc <generated run.mjs>` and appends
  // its cwd and generated directory to NODE_PATH. All Node/browser mode and
  // flag overrides start absent, as in the original cipher test invocation.
  return {
    cmd: [runner, harness],
    env: { PATH: path.dirname(node), HOME: temporary, TMPDIR: temporary },
  };
}

export async function runWasmCipher(environment: NodeJS.ProcessEnv): Promise<number> {
  const invocation = wasmCipherInvocation(environment);
  const harness = invocation.cmd[1];
  if (!harness) throw new Error('Missing declared WASM test harness');
  const module = new WebAssembly.Module(await Bun.file(harness).arrayBuffer());
  // The upstream runner returns success for zero tests. Refuse a build-only
  // module before it can produce that empty pass for the cipher obligation.
  if (
    !WebAssembly.Module.exports(module).some(
      (entry) =>
        entry.kind === 'function' &&
        entry.name.startsWith('__wbgt_') &&
        entry.name.includes('::wasm_chacha::tests::'),
    )
  ) {
    throw new Error('WASM harness contains no original SIMD cipher tests');
  }
  const child = Bun.spawn({
    ...invocation,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await child.exited;
}

if (import.meta.main) process.exitCode = await runWasmCipher(process.env);
