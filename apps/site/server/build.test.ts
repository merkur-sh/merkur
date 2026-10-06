import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { compileSiteServer, compileTarget } from './build';
import { closedPort, type FixtureSite, writeFixtureSite } from './test-support';

describe('compileTarget', () => {
  test("maps Docker's TARGETARCH to the Linux executable and leaves the host build alone", () => {
    expect(compileTarget('amd64')).toBe('bun-linux-x64');
    expect(compileTarget('arm64')).toBe('bun-linux-arm64');
    expect(compileTarget(undefined)).toBeUndefined();
    expect(() => compileTarget('riscv64')).toThrow('unsupported TARGETARCH: riscv64');
  });
});

describe('compiled executable', () => {
  let fixture: FixtureSite;
  let buildDirectory: string;
  let executable: string;

  beforeAll(async () => {
    fixture = await writeFixtureSite();
    buildDirectory = await mkdtemp(path.join(os.tmpdir(), 'merkur-site-server-'));
    executable = path.join(buildDirectory, 'site-server');
    await compileSiteServer({
      outfile: executable,
      apiOrigin: 'https://api.merkur.test',
      targetArch: undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await rm(fixture.distDirectory, { recursive: true, force: true });
    await rm(buildDirectory, { recursive: true, force: true });
  });

  test('refuses to compile without the API origin', async () => {
    await expect(
      compileSiteServer({ outfile: executable, apiOrigin: undefined, targetArch: undefined }),
    ).rejects.toThrow('MERKUR_SITE_API_ORIGIN is required');
  });

  test('serves the site with the API origin it was compiled with', async () => {
    const port = closedPort();
    const child = Bun.spawn([executable, fixture.distDirectory], {
      // No MERKUR_SITE_API_ORIGIN here: the executable carries it.
      env: {
        PORT: String(port),
        RYBBIT_HOST: 'https://app.rybbit.io',
        TRUSTED_PROXY_HOPS: '1',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    try {
      const reader = child.stdout.getReader();
      let output = '';
      while (!output.includes('site_server_started')) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error(`site server exited before starting: ${output}`);
        }
        output += new TextDecoder().decode(value);
      }
      reader.releaseLock();

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(204);
      const home = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'accept-encoding': 'br' },
        decompress: false,
      });
      expect(home.status).toBe(200);
      expect(home.headers.get('content-encoding')).toBe('br');
      expect(home.headers.get('content-security-policy')).toContain(
        "connect-src 'self' https://api.merkur.test;",
      );
      expect(home.headers.get('content-security-policy')).toContain(
        "form-action https://api.merkur.test 'self';",
      );
      await home.arrayBuffer();

      // SIGTERM stops the server through its own handler; the process then
      // exits normally rather than dying of the signal.
      child.kill('SIGTERM');
      expect(await child.exited).toBe(0);
      expect(child.signalCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  }, 30_000);
});
