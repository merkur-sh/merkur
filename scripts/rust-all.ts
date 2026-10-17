// Clippy over every first-party target type-checks bins, libs, tests and benches, so it
// needs no separate check build.
await run('bun', ['run', 'rust:lint']);
await run('bun', ['run', 'build:dataplane']);
await run('bun', ['run', 'build:wasm']);

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
