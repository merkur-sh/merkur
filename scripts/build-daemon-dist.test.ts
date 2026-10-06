import { expect, test } from 'bun:test';

const origin = 'https://merkur.test';
const pin = Buffer.alloc(32).toString('base64url');

test('release builds refuse missing or noncanonical account pins before creating artifacts', async () => {
  for (const [accountOrigin, accountPin, error] of [
    [undefined, pin, 'require MERKUR_PUBLIC_ORIGIN'],
    [origin, undefined, 'require MERKUR_PUBLIC_ORIGIN'],
    ['http://merkur.test', pin, 'canonical HTTPS origin'],
    [`${origin}/path`, pin, 'canonical HTTPS origin'],
    [origin, Buffer.alloc(31).toString('base64url'), 'exactly 32 bytes'],
    [origin, `${pin}=`, 'canonical base64url'],
  ] as const) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MERKUR_RELEASE_MLDSA87_PUBLIC_KEY: 'A'.repeat(3456),
    };
    if (accountOrigin === undefined) delete env.MERKUR_PUBLIC_ORIGIN;
    else env.MERKUR_PUBLIC_ORIGIN = accountOrigin;
    if (accountPin === undefined) delete env.MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
    else env.MERKUR_OPAQUE_SERVER_PUBLIC_KEY = accountPin;
    const child = Bun.spawn(
      ['bun', 'run', 'scripts/build-daemon-dist.ts', '--version', 'v1.0.0', '--sequence', '1'],
      {
        cwd: new URL('..', import.meta.url).pathname,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(errors).toContain(error);
    expect(output).not.toContain('built ');
  }
});
