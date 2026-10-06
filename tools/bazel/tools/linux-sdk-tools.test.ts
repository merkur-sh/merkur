import { expect, test } from 'bun:test';

const commands: Readonly<Record<string, readonly string[]>> = {
  sh: ['-c', 'printf "%s" "sdk-shell"'],
  mkdir: ['--version'],
  chmod: ['--version'],
  echo: ['--version'],
  git: ['--version'],
  tar: ['--version'],
  gzip: ['--version'],
  python3: ['--version'],
  openssl: ['version', '-a'],
};

for (const [name, args] of Object.entries(commands)) {
  test(`immutable GNU SDK provides ${name}`, async () => {
    const child = Bun.spawn([name, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    process.stdout.write(JSON.stringify({ tool: name, status, stdout, stderr }) + '\n');
    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.length).toBeGreaterThan(0);
  });
}
