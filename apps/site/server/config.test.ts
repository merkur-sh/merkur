import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { parseSiteServerConfig, SiteConfigError } from './config';
import { type FixtureSite, writeFixtureSite } from './test-support';

const VALID_ENVIRONMENT = {
  PORT: '8080',
  RYBBIT_HOST: 'https://app.rybbit.io',
  TRUSTED_PROXY_HOPS: '1',
};

describe('parseSiteServerConfig', () => {
  test('reads the environment, the defined API origin and the dist argument', () => {
    expect(
      parseSiteServerConfig({
        environment: VALID_ENVIRONMENT,
        apiOrigin: 'https://merkur.sh',
        args: ['/site/dist'],
      }),
    ).toEqual({
      distDirectory: '/site/dist',
      port: 8080,
      rybbitHost: 'https://app.rybbit.io',
      trustedProxyHops: 1,
      apiOrigin: 'https://merkur.sh',
    });
  });

  const refused: ReadonlyArray<
    readonly [string, Record<string, string | undefined>, string | undefined, string[]]
  > = [
    [
      'a missing RYBBIT_HOST',
      { ...VALID_ENVIRONMENT, RYBBIT_HOST: undefined },
      'https://merkur.sh',
      ['dist'],
    ],
    [
      'a RYBBIT_HOST with a path',
      { ...VALID_ENVIRONMENT, RYBBIT_HOST: 'https://app.rybbit.io/api' },
      'https://merkur.sh',
      ['dist'],
    ],
    [
      'a RYBBIT_HOST with a trailing slash',
      { ...VALID_ENVIRONMENT, RYBBIT_HOST: 'https://app.rybbit.io/' },
      'https://merkur.sh',
      ['dist'],
    ],
    [
      'a non-HTTP RYBBIT_HOST',
      { ...VALID_ENVIRONMENT, RYBBIT_HOST: 'ftp://app.rybbit.io' },
      'https://merkur.sh',
      ['dist'],
    ],
    ['a missing PORT', { ...VALID_ENVIRONMENT, PORT: undefined }, 'https://merkur.sh', ['dist']],
    ['port zero', { ...VALID_ENVIRONMENT, PORT: '0' }, 'https://merkur.sh', ['dist']],
    ['a port past 65535', { ...VALID_ENVIRONMENT, PORT: '65536' }, 'https://merkur.sh', ['dist']],
    [
      'a missing TRUSTED_PROXY_HOPS',
      { ...VALID_ENVIRONMENT, TRUSTED_PROXY_HOPS: undefined },
      'https://merkur.sh',
      ['dist'],
    ],
    [
      'nine proxy hops',
      { ...VALID_ENVIRONMENT, TRUSTED_PROXY_HOPS: '9' },
      'https://merkur.sh',
      ['dist'],
    ],
    ['a missing API origin', VALID_ENVIRONMENT, undefined, ['dist']],
    ['an API origin with a path', VALID_ENVIRONMENT, 'https://merkur.sh/api', ['dist']],
    ['no dist argument', VALID_ENVIRONMENT, 'https://merkur.sh', []],
    ['two dist arguments', VALID_ENVIRONMENT, 'https://merkur.sh', ['dist', 'other']],
  ];
  for (const [name, environment, apiOrigin, args] of refused) {
    test(`refuses ${name}`, () => {
      expect(() => parseSiteServerConfig({ environment, apiOrigin, args })).toThrow(
        SiteConfigError,
      );
    });
  }
});

describe('startup', () => {
  let fixture: FixtureSite;
  beforeAll(async () => {
    fixture = await writeFixtureSite();
  });
  afterAll(async () => {
    await rm(fixture.distDirectory, { recursive: true, force: true });
  });

  async function start(environment: Record<string, string>, args: string[]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'index.ts'), ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        MERKUR_SITE_API_ORIGIN: 'https://merkur.sh',
        ...environment,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { stdout, exitCode };
  }

  test('exits without RYBBIT_HOST', async () => {
    const { stdout, exitCode } = await start({ PORT: '8080', TRUSTED_PROXY_HOPS: '1' }, [
      fixture.distDirectory,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('site_server_start_failed');
    expect(stdout).toContain('RYBBIT_HOST is required');
  });

  test('exits when the manifest names a file the build did not write', async () => {
    await rm(path.join(fixture.distDirectory, 'robots.txt'));
    const { stdout, exitCode } = await start({ ...VALID_ENVIRONMENT, PORT: '8080' }, [
      fixture.distDirectory,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('robots.txt is named by the manifest but not readable');
  });
});
