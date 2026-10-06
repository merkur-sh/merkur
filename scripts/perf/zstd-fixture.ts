import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');

/** The fixture the runner declares on PATH; a source run uses the workspace's release build. */
export function zstdFixtureExecutable(): string {
  return (
    Bun.which('zstd-fixture') ??
    path.join(
      ROOT,
      'target/rust/release',
      process.platform === 'win32' ? 'zstd-fixture.exe' : 'zstd-fixture',
    )
  );
}

/** As above, and a source run first brings the workspace's release build up to date. */
export async function builtZstdFixtureExecutable(): Promise<string> {
  if (Bun.which('zstd-fixture') === null) {
    const command = [
      'cargo',
      'build',
      '--manifest-path',
      'Cargo.toml',
      '-p',
      'zstd-fixture',
      '--release',
      '--locked',
    ];
    const child = Bun.spawn(command, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${command.join(' ')} exited ${exitCode}`);
  }
  return zstdFixtureExecutable();
}
