import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { declaredBrowserExecutable } from '../../../scripts/perf/browser-runtime';

const version = '151.0.7922.34';

/** These controls qualify the browser a runner declares; none declared is a refusal. */
function requiredBrowserExecutable(kind: 'chromium' | 'headless-shell'): string {
  const executable = declaredBrowserExecutable(kind);
  if (executable === undefined)
    throw new Error(`Browser qualification requires the declared ${kind} executable`);
  return executable;
}

for (const kind of ['chromium', 'headless-shell'] as const) {
  test(`the declared ${kind} executable has the pinned version`, async () => {
    const executable = requiredBrowserExecutable(kind);
    const child = Bun.spawn([executable, '--version'], {
      env: { PATH: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
    expect(stdout.trim().endsWith(` ${version}`)).toBe(true);
  });

  test(`the declared ${kind} payload executes JavaScript and WebAssembly in a private profile`, async () => {
    const scratch = process.env.TEST_TMPDIR;
    if (scratch === undefined) throw new Error('Browser qualification requires Bazel test scratch');
    const directory = await mkdtemp(path.join(scratch, `browser-${kind}-`));
    try {
      const executable = requiredBrowserExecutable(kind);
      // Pass a private profile and only the declared browser's loader inputs.
      // Native OS/browser/GPU services still need independent qualification.
      const env: NodeJS.ProcessEnv = {
        HOME: directory,
        TMPDIR: directory,
        PATH: '',
        LANG: 'C.UTF-8',
        TZ: 'UTC',
      };
      const sdk = process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
      if (sdk !== undefined && process.platform === 'linux') {
        env.LD_LIBRARY_PATH = path.join(sdk, 'lib');
      }
      // Synchronous execution makes --dump-dom's own load completion the signal.
      // The empty module still crosses the browser's actual WASM compiler path.
      const page = `<html><body><script>
const wasm = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
const instance = new WebAssembly.Instance(wasm);
document.body.dataset.runtime = 6 * 7 === 42 && Object.keys(instance.exports).length === 0
  ? 'javascript-wasm-complete' : 'failed';
</script></body></html>`;
      const child = Bun.spawn(
        [
          executable,
          '--headless',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
          '--password-store=basic',
          '--use-mock-keychain',
          `--user-data-dir=${path.join(directory, 'profile')}`,
          '--dump-dom',
          `data:text/html,${encodeURIComponent(page)}`,
        ],
        { env, stdout: 'pipe', stderr: 'pipe' },
      );
      const [result, dom, diagnostics] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ result, diagnostics: result === 0 ? '' : diagnostics }).toEqual({
        result: 0,
        diagnostics: '',
      });
      expect(dom).toContain('data-runtime="javascript-wasm-complete"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
