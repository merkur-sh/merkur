import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { fillPageFacts, readMachineLimit, readReleaseFingerprint } from './page-facts';
import { readSiteApiOrigin, readSiteEnvironment } from './site-environment';

const repo = (path: string): string =>
  fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

describe('the build environment', () => {
  test('the Rybbit site id is required and the origins default to production', () => {
    expect(() => readSiteEnvironment({})).toThrow('MERKUR_SITE_RYBBIT_SITE_ID is required');
    expect(readSiteEnvironment({ MERKUR_SITE_RYBBIT_SITE_ID: 'abc123' })).toEqual({
      siteOrigin: 'https://merkur.sh',
      appOrigin: 'https://app.merkur.sh',
      rybbitSiteId: 'abc123',
    });
  });

  test('an origin is a bare https origin, or plain http on loopback', () => {
    const env = { MERKUR_SITE_RYBBIT_SITE_ID: 'x' };
    expect(() => readSiteEnvironment({ ...env, MERKUR_SITE_ORIGIN: 'https://merkur.sh/' })).toThrow(
      'bare https origin',
    );
    expect(() =>
      readSiteEnvironment({ ...env, MERKUR_SITE_API_ORIGIN: 'http://app.merkur.sh' }),
    ).toThrow('bare https origin');
    expect(
      readSiteEnvironment({ ...env, MERKUR_SITE_API_ORIGIN: 'http://127.0.0.1:3100' }).appOrigin,
    ).toBe('http://127.0.0.1:3100');
  });

  test('the server build reads the API origin the pages were built against, with no site id', () => {
    expect(readSiteApiOrigin({})).toBe('https://app.merkur.sh');
    expect(readSiteApiOrigin({ MERKUR_SITE_API_ORIGIN: 'http://127.0.0.1:3100' })).toBe(
      'http://127.0.0.1:3100',
    );
    expect(() => readSiteApiOrigin({ MERKUR_SITE_API_ORIGIN: 'https://app.merkur.sh/' })).toThrow(
      'bare https origin',
    );
  });
});

describe('facts read from their sources', () => {
  test('the release fingerprint is the one SECURITY.md publishes', () => {
    const fingerprint = readReleaseFingerprint(readFileSync(repo('SECURITY.md'), 'utf8'));
    expect(fingerprint).toMatch(/^[0-9a-f]{8}( [0-9a-f]{8}){7}$/);
    expect(() => readReleaseFingerprint('## Release key\n\nnone here\n')).toThrow(
      'no release-key fingerprint',
    );
  });

  test('the machine limit is the constant the link-claim service enforces', () => {
    const service = readFileSync(repo('apps/server/src/services/machine-usage.ts'), 'utf8');
    const limit = readMachineLimit(service);
    expect(service).toContain(limit.line);
    expect(readMachineLimit('export const MAX_LINKED_MACHINES = 3;')).toEqual({
      line: 'export const MAX_LINKED_MACHINES = 3;',
      value: 3,
      word: 'three',
    });
    expect(() => readMachineLimit('const MAX_LINKED_MACHINES = 3;')).toThrow('no single-digit');
  });
});

describe('filling a page', () => {
  const facts = new Map([
    ['site.host', { text: 'Mac "home" <1>' }],
    ['site.mark', { html: '<rect/>' }],
  ]);

  test('text is escaped, drawn markup is not', () => {
    expect(fillPageFacts('[[site.host]] [[site.mark]]', facts, '/')).toBe(
      'Mac &quot;home&quot; &lt;1&gt; <rect/>',
    );
  });

  test('a name with no fact, or any name left over, stops the build', () => {
    expect(() => fillPageFacts('[[site.user]]', facts, '/security.html')).toThrow(
      '/security.html names [[site.user]], no such fact',
    );
    expect(() => fillPageFacts('[[ site.host ]]', facts, '/')).toThrow('which is not a fact');
  });
});
