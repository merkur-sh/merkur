import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Redacted } from 'effect';
import { probeRedis, redisEndpoint } from './dev-redis';

test('Redis preflight authenticates, selects a database, and refuses bad credentials', async () => {
  const server = await startRedis([]);
  try {
    const url = Redacted.make(`redis://:merkur-test-only@127.0.0.1:${server.port}/2`);
    await Effect.runPromise(probeRedis(url));
    expect(redisEndpoint(url)).toBe(`redis://127.0.0.1:${server.port}/2`);
    await expect(
      Effect.runPromise(probeRedis(Redacted.make(`redis://:wrong@127.0.0.1:${server.port}`))),
    ).rejects.toThrow('authentication or connection failed');
    await expect(
      Effect.runPromise(
        probeRedis(Redacted.make(`rediss://:merkur-test-only@127.0.0.1:${server.port}`)),
      ),
    ).rejects.toThrow();
  } finally {
    server.process.kill();
    await server.process.exited;
  }
}, 10_000);

test('Redis preflight establishes authenticated TLS with an explicitly trusted CA', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'merkur-redis-tls-'));
  let server: Awaited<ReturnType<typeof startRedis>> | undefined;
  try {
    const certificate = path.join(dir, 'cert.pem');
    const key = path.join(dir, 'key.pem');
    const config = path.join(dir, 'openssl.cnf');
    await writeFile(
      config,
      '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
    );
    const openssl = Bun.spawn(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        config,
        '-keyout',
        key,
        '-out',
        certificate,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    expect(await openssl.exited).toBe(0);
    server = await startRedis(
      [
        '--tls-cert-file',
        certificate,
        '--tls-key-file',
        key,
        '--tls-ca-cert-file',
        certificate,
        '--tls-auth-clients',
        'no',
      ],
      true,
    );
    const url = `rediss://:merkur-test-only@127.0.0.1:${server.port}/2`;
    await expect(Effect.runPromise(probeRedis(Redacted.make(url)))).rejects.toThrow();
    // CA loading is process-local. Isolate the trusted fixture from every other test.
    const modulePath = path.join(import.meta.dir, 'dev-redis.ts');
    const code = `import { Effect, Redacted } from 'effect'; import { probeRedis } from ${JSON.stringify(modulePath)}; await Effect.runPromise(probeRedis(Redacted.make(process.env.MERKUR_TEST_REDIS_URL ?? '')));`;
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', code], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: certificate, MERKUR_TEST_REDIS_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const details = await new Response(child.stderr).text();
    expect(await child.exited, details).toBe(0);
  } finally {
    if (server !== undefined) {
      server.process.kill();
      await server.process.exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

async function startRedis(extra: string[], tls = false) {
  const executable = Bun.which('redis-server');
  if (executable === null) throw new Error('Redis preflight tests require redis-server');
  const reservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop(true);
  const process = Bun.spawn(
    [
      executable,
      '--bind',
      '127.0.0.1',
      '--port',
      tls ? '0' : String(port),
      ...(tls ? ['--tls-port', String(port)] : []),
      '--save',
      '',
      '--appendonly',
      'no',
      '--requirepass',
      'merkur-test-only',
      ...extra,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const reader = process.stdout.getReader();
  let buffered = '';
  try {
    while (!buffered.includes('Ready to accept connections')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Redis fixture exited: ${buffered}`);
      buffered += new TextDecoder().decode(value);
    }
    return { port, process };
  } catch (error) {
    process.kill();
    await process.exited;
    throw error;
  } finally {
    reader.releaseLock();
  }
}
