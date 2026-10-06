export interface TestProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a child to completion from a test and return its exit code and what it wrote.
 *
 * A test never spawns synchronously. `Bun.spawnSync`, `execFileSync` and `execSync` wait on one
 * private event loop per process; a poll finalized during such a wait leaves that loop
 * miscounted, and every later synchronous spawn in the worker loses its child's exit. It then
 * spins past every timeout, or returns empty output once the test's timeout kills the child
 * (oven-sh/bun#34069). A child awaited on the worker's own loop has no such window.
 */
export async function runTestProcess(
  command: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly stdin?: string;
    /** Milliseconds after which the child is killed; its exit code is then non-zero. */
    readonly timeout?: number;
  } = {},
): Promise<TestProcessResult> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}
