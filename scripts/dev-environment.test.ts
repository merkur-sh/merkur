import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Redacted } from 'effect';
import {
  developmentServerOrigin,
  serverProcessEnvironment,
  toolEnvironment,
} from './dev-environment';
import { prepareDevelopmentEnvironment } from './dev-server-env';

test('internal URLs respect server ports, wildcard bindings, and IPv6', () => {
  expect(developmentServerOrigin('127.0.0.1', 3200)).toBe('http://127.0.0.1:3200');
  expect(developmentServerOrigin('0.0.0.0', 3201)).toBe('http://127.0.0.1:3201');
  expect(developmentServerOrigin('::', 3202)).toBe('http://[::1]:3202');
  expect(developmentServerOrigin('::1', 3203)).toBe('http://[::1]:3203');
});

test('compiler and unrelated child environments never inherit server credentials', () => {
  const source = {
    PATH: '/tools',
    HOME: '/home/test',
    TOKEN_HMAC_SECRET: 'secret',
    SESSION_TOKEN_MLDSA87_SEED: 'seed',
    VITE_ACCIDENTAL_SECRET: 'secret',
    RUSTUP_TOOLCHAIN: 'ambient',
  };
  expect(toolEnvironment(source)).toEqual({
    PATH: `${path.dirname(process.execPath)}${path.delimiter}/tools`,
    HOME: '/home/test',
  });
  const server = serverProcessEnvironment(source, source);
  expect(server.TOKEN_HMAC_SECRET).toBe('secret');
  expect(server.VITE_ACCIDENTAL_SECRET).toBeUndefined();
  expect(server.RUSTUP_TOOLCHAIN).toBeUndefined();
});

test('child tools select rustup proxies ahead of a system compiler', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'merkur-tool-path-'));
  try {
    const system = path.join(directory, 'system');
    const proxies = path.join(directory, 'proxies');
    await Promise.all([mkdir(system), mkdir(proxies)]);
    for (const binary of [
      path.join(system, 'cargo'),
      path.join(proxies, 'rustup'),
      path.join(proxies, 'cargo'),
    ]) {
      await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    const environment = toolEnvironment({
      PATH: `${system}${path.delimiter}${proxies}`,
      RUSTUP_TOOLCHAIN: 'ambient',
    });
    expect(Bun.which('cargo', { PATH: environment.PATH })).toBe(path.join(proxies, 'cargo'));
    expect(environment.PATH?.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    expect(environment.RUSTUP_TOOLCHAIN).toBeUndefined();
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ scripts: { probe: 'bun --version' } }),
    );
    const child = Bun.spawn([process.execPath, '--bun', '--no-env-file', 'run', 'probe'], {
      cwd: directory,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe(process.versions.bun);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fresh setup persists and validates the Redis URL it was given', async () => {
  const candidate = await Effect.runPromise(
    prepareDevelopmentEnvironment('', {
      REDIS_URL: 'rediss://user:literal$PASSWORD@redis.test:6380/2',
    }),
  );
  expect(Redacted.value(candidate.config.redisUrl)).toBe(
    'rediss://user:literal$PASSWORD@redis.test:6380/2',
  );
  expect(candidate.contents).toContain('literal\\$PASSWORD');
  const repeated = await Effect.runPromise(prepareDevelopmentEnvironment(candidate.contents, {}));
  expect(repeated.added).toEqual([]);
  expect(repeated.contents).toBe(candidate.contents);
  expect(Redacted.value(repeated.config.redisUrl)).toBe(Redacted.value(candidate.config.redisUrl));
  expect(Redacted.value(repeated.config.opaqueServerSetup)).toBe(
    Redacted.value(candidate.config.opaqueServerSetup),
  );
});
