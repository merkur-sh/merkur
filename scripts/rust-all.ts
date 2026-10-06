// Clippy with `--all-targets` type-checks bins, libs, tests and benches, so it
// is a strict superset of `rust:check`. Running both would pay for two separate
// compilations of the same workspace for no extra coverage.
await run('bun', ['run', 'rust:lint']);
await run('bun', ['run', 'build:dataplane']);
await run('bun', ['run', 'build:wasm']);
await run('bun', ['run', 'sync:wasm']);

export {};

async function run(command: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([command, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
