import { describe, expect, test } from 'bun:test';
import { createECDH } from 'node:crypto';
import { ConfigProvider, Effect, Redacted } from 'effect';

import { loadServerConfig, MIN_SESSION_TOKEN_TTL_MS, OpaqueWebBuildPin } from './server-config';

const OPAQUE_SERVER_SETUP =
  'vyR7ewWtDdnfxU9MRNWEe8h5iNJ34K03Ebhh8kCjtN7gBCOX9zs6n9SHAFRwXcd4juUL6EWRm0IRF40gSSEc8Y6PwsHNbCpj5V94McaEgFt_ptz-wy2cZCUgVpJrSusGml8FeZBo9aSfBUDVW8bW5I5XwafKzgMQ4lMiFeZ8BCs';
const OPAQUE_SERVER_PUBLIC_KEY = '_lV018BV4Yes2R8Lq3TmVchsl3XYbxFxC3aHCOGyy1E';

describe('server config', () => {
  test('validates Redis and database endpoints without revealing credentials', async () => {
    for (const url of [
      'https://redis.test',
      'redis://redis.test:0',
      'redis://redis.test:99999',
      'redis://redis.test/not-a-db',
      'redis://redis.test?secret=hidden',
    ]) {
      await expect(loadConfig({ REDIS_URL: url })).rejects.toThrow('REDIS_URL');
    }
    expect(
      Redacted.value(
        (await loadConfig({ REDIS_URL: 'rediss://user:password@redis.test:6380/2' })).redisUrl,
      ),
    ).toBe('rediss://user:password@redis.test:6380/2');
    for (const url of [
      'file:',
      'ftp://db.test',
      'https://user:password@db.test', // trufflehog:ignore dummy .test credentials
    ]) {
      await expect(loadConfig({ DB_URL: url })).rejects.toThrow('DB_URL');
    }
    for (const url of [':memory:', 'file:./data/test.db', 'libsql://db.test', 'https://db.test']) {
      expect((await loadConfig({ DB_URL: url })).dbUrl).toBe(url);
    }
  });

  test('the website is absent or a validated origin, with Rybbit complete or absent', async () => {
    const rybbit = {
      RYBBIT_HOST: 'https://rybbit.test',
      RYBBIT_SITE_ID: 'site-1',
      RYBBIT_API_KEY: 'rb_test_key',
    };
    expect((await loadConfig({})).website).toBeUndefined();
    expect((await loadConfig({ SITE_ORIGIN: 'https://merkur.test' })).website).toEqual({
      origin: 'https://merkur.test',
      rybbit: undefined,
    });

    const counted = (await loadConfig({ SITE_ORIGIN: 'https://merkur.test', ...rybbit })).website;
    expect(counted?.origin).toBe('https://merkur.test');
    expect(counted?.rybbit?.host).toBe('https://rybbit.test');
    expect(counted?.rybbit?.siteId).toBe('site-1');
    expect(counted?.rybbit === undefined ? null : Redacted.value(counted.rybbit.apiKey)).toBe(
      'rb_test_key',
    );

    // Rybbit counts joins of a website, so it is refused without one.
    await expect(loadConfig(rybbit)).rejects.toThrow('SITE_ORIGIN');
    for (const name of ['RYBBIT_HOST', 'RYBBIT_SITE_ID', 'RYBBIT_API_KEY'] as const) {
      await expect(
        loadConfig({ SITE_ORIGIN: 'https://merkur.test', ...rybbit, [name]: undefined }),
      ).rejects.toThrow(name);
    }
    for (const name of ['SITE_ORIGIN', 'RYBBIT_HOST']) {
      for (const origin of [
        'ftp://example.com',
        'https://user@example.com',
        'https://example.com/',
        'https://example.com/api',
        'https://example.com?query=1',
      ]) {
        await expect(
          loadConfig({ SITE_ORIGIN: 'https://merkur.test', ...rybbit, [name]: origin }),
        ).rejects.toThrow(name);
      }
    }
  });

  test('box hosting is disabled or a complete validated configuration', async () => {
    expect((await loadConfig({})).boxHost).toBeUndefined();
    for (const fields of [
      { BOX_HOST_URL: 'https://box.test' },
      { BOX_HOST_TOKEN: 'test' },
      { BOX_HOST_URL: 'https://user@box.test', BOX_HOST_TOKEN: 'test' },
      { BOX_HOST_TIMEOUT_MS: '-1' },
      { BOX_HOST_TIMEOUT_MS: '0' },
      { BOX_HOST_TIMEOUT_MS: '2147483648' },
    ]) {
      await expect(loadConfig(fields)).rejects.toThrow('BOX_HOST');
    }
    const config = await loadConfig({
      BOX_HOST_URL: 'https://box.test',
      BOX_HOST_TOKEN: 'test',
      BOX_HOST_TIMEOUT_MS: '9000',
    });
    expect(config.boxHost?.url).toBe('https://box.test');
    expect(config.boxHost?.timeoutMs).toBe(9000);
    expect(config.boxHost === undefined ? undefined : Redacted.value(config.boxHost.token)).toBe(
      'test',
    );
  });

  test('web push requires a complete matching canonical keypair', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.alloc(32, 1));
    const fields = {
      WEB_PUSH_VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'),
      WEB_PUSH_VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString('base64url'),
      WEB_PUSH_CONTACT: 'mailto:admin@merkur.test',
    };
    expect((await loadConfig({})).webPush).toBeUndefined();
    const config = await loadConfig(fields);
    expect(config.webPush?.publicKey).toBe(fields.WEB_PUSH_VAPID_PUBLIC_KEY);
    expect(
      config.webPush === undefined ? undefined : Redacted.value(config.webPush.privateKey),
    ).toBe(fields.WEB_PUSH_VAPID_PRIVATE_KEY);
    for (const key of Object.keys(fields)) {
      const partial = Object.fromEntries(Object.entries(fields).filter(([name]) => name !== key));
      await expect(loadConfig(partial)).rejects.toThrow('Web push');
    }
    for (const invalid of [
      { WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 2).toString('base64url') },
      { WEB_PUSH_VAPID_PUBLIC_KEY: `${fields.WEB_PUSH_VAPID_PUBLIC_KEY}=` },
      { WEB_PUSH_CONTACT: 'http://admin.test' },
      { WEB_PUSH_CONTACT: 'mailto:invalid' },
    ])
      await expect(loadConfig({ ...fields, ...invalid })).rejects.toThrow('Web push');
  });

  test('rejects invalid STUN ports and malformed IPv6 authorities', async () => {
    for (const endpoint of [
      'stun.test:0',
      'stun.test:99999',
      'stun.test:03478',
      '[invalid]:3478',
      'stun.test',
    ]) {
      await expect(loadConfig({ STUN_SERVERS: `${endpoint},other.test:3479` })).rejects.toThrow(
        'STUN_SERVERS',
      );
    }
    expect((await loadConfig({ STUN_SERVERS: '[::1]:3478,stun.test:80' })).stunServers).toEqual([
      '[::1]:3478',
      'stun.test:80',
    ]);
  });

  test('an injected artifact pin cannot be replaced by a valid runtime pin', async () => {
    const provider = ConfigProvider.fromUnknown(requiredEntries());
    await expect(
      Effect.runPromise(
        loadServerConfig.pipe(
          Effect.provide(ConfigProvider.layer(provider)),
          Effect.provideService(OpaqueWebBuildPin, Buffer.alloc(32, 5).toString('base64url')),
        ),
      ),
    ).rejects.toThrow('VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY');
  });
  test('requires REDIS_URL', async () => {
    const provider = ConfigProvider.fromUnknown(withoutRequiredEntry('REDIS_URL'));

    await expect(
      Effect.runPromise(Effect.provide(loadServerConfig, ConfigProvider.layer(provider))),
    ).rejects.toThrow();
  });

  test('loads config with required fields', async () => {
    const config = await loadConfig({});

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3000);
  });

  test('leaves telemetry unset when no Axiom variables are supplied', async () => {
    const config = await loadConfig({});

    expect(config.telemetry).toBeUndefined();
  });

  test('loads the Axiom telemetry group with a default endpoint and environment', async () => {
    const config = await loadConfig({
      AXIOM_TOKEN: 'xaat-token',
      AXIOM_DATASET: 'merkur',
      AXIOM_METRICS_DATASET: 'merkur-metrics',
      AXIOM_PERF_DATASET: 'merkur-perf',
    });

    expect(config.telemetry).toEqual({
      axiomToken: Redacted.make('xaat-token'),
      axiomDataset: 'merkur',
      axiomMetricsDataset: 'merkur-metrics',
      axiomPerfDataset: 'merkur-perf',
      axiomEndpoint: 'https://api.axiom.co',
      environment: 'development',
    });
  });

  test('rejects a partially configured telemetry group', async () => {
    const complete = {
      AXIOM_TOKEN: 'xaat-token',
      AXIOM_DATASET: 'merkur',
      AXIOM_METRICS_DATASET: 'merkur-metrics',
      AXIOM_PERF_DATASET: 'merkur-perf',
    };
    for (const omitted of Object.keys(complete)) {
      const partial = { ...complete };
      delete partial[omitted as keyof typeof complete];
      await expect(loadConfig(partial)).rejects.toThrow();
    }
  });

  test('rejects a non-origin Axiom endpoint and strips a trailing slash', async () => {
    const group = {
      AXIOM_TOKEN: 'xaat-token',
      AXIOM_DATASET: 'merkur',
      AXIOM_METRICS_DATASET: 'merkur-metrics',
      AXIOM_PERF_DATASET: 'merkur-perf',
    };

    await expect(loadConfig({ ...group, AXIOM_ENDPOINT: 'api.axiom.co' })).rejects.toThrow();
    await expect(
      loadConfig({ ...group, AXIOM_ENDPOINT: 'https://api.axiom.co/?a=1' }),
    ).rejects.toThrow();

    const config = await loadConfig({ ...group, AXIOM_ENDPOINT: 'https://api.eu.axiom.co/' });
    expect(config.telemetry?.axiomEndpoint).toBe('https://api.eu.axiom.co');
  });

  test('requires a canonical 64-byte EDGE_ATTACH_TICKET_KEY', async () => {
    await expect(
      Effect.runPromise(
        Effect.provide(
          loadServerConfig,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown(withoutRequiredEntry('EDGE_ATTACH_TICKET_KEY')),
          ),
        ),
      ),
    ).rejects.toThrow();
    for (const invalid of [
      Buffer.alloc(32, 1).toString('base64url'),
      `${Buffer.alloc(64, 1).toString('base64url')}=`,
      'not-base64!',
    ]) {
      await expect(loadConfig({ EDGE_ATTACH_TICKET_KEY: invalid })).rejects.toThrow();
    }
    const config = await loadConfig({});
    expect(config.edgeAttachTicketKey).toEqual(new Uint8Array(64).fill(0x78));
  });

  test('requires EDGE_REGISTRATION_KEYS_JSON', async () => {
    const provider = ConfigProvider.fromUnknown(
      withoutRequiredEntry('EDGE_REGISTRATION_KEYS_JSON'),
    );

    await expect(
      Effect.runPromise(Effect.provide(loadServerConfig, ConfigProvider.layer(provider))),
    ).rejects.toThrow();
  });

  test('requires an explicit strong token HMAC secret and registration policy', async () => {
    for (const missing of ['TOKEN_HMAC_SECRET', 'AUTH_ALLOW_REGISTRATION']) {
      const provider = ConfigProvider.fromUnknown(withoutRequiredEntry(missing));
      await expect(
        Effect.runPromise(Effect.provide(loadServerConfig, ConfigProvider.layer(provider))),
      ).rejects.toThrow();
    }
    const validSecret = Buffer.alloc(64, 0xaa).toString('base64url');
    expect(
      Redacted.value((await loadConfig({ TOKEN_HMAC_SECRET: validSecret })).tokenHmacSecret),
    ).toBe(validSecret);
    for (const tokenHmacSecret of [
      'short',
      'change-me-before-production',
      Buffer.alloc(32).toString('base64url'),
      `${validSecret}=`,
      ` ${validSecret}`,
    ]) {
      await expect(loadConfig({ TOKEN_HMAC_SECRET: tokenHmacSecret })).rejects.toThrow();
    }
  });

  test('requires an explicit account identity', async () => {
    const provider = ConfigProvider.fromUnknown(withoutRequiredEntry('AUTH_IDENTITY'));
    await expect(
      Effect.runPromise(Effect.provide(loadServerConfig, ConfigProvider.layer(provider))),
    ).rejects.toThrow();
    await expect(loadConfig({ AUTH_IDENTITY: 'phone' })).rejects.toThrow();

    const config = await loadConfig({});
    expect(config.authIdentity).toBe('username');
    expect(config.emailDelivery).toBeUndefined();
  });

  test('email identity requires Resend delivery and defaults its endpoint', async () => {
    const email = { AUTH_IDENTITY: 'email' };
    await expect(loadConfig(email)).rejects.toThrow();
    await expect(loadConfig({ ...email, RESEND_API_KEY: 're_test' })).rejects.toThrow();
    await expect(
      loadConfig({ ...email, EMAIL_FROM: 'Merkur <signin@merkur.test>' }),
    ).rejects.toThrow();
    await expect(
      loadConfig({
        ...email,
        RESEND_API_KEY: 're_test',
        EMAIL_FROM: 'Merkur <signin@merkur.test>',
        RESEND_API_URL: 'not a url',
      }),
    ).rejects.toThrow();

    const config = await loadConfig({
      ...email,
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'Merkur <signin@merkur.test>',
    });
    expect(config.authIdentity).toBe('email');
    expect(config.emailDelivery).toEqual({
      resendApiKey: Redacted.make('re_test'),
      from: 'Merkur <signin@merkur.test>',
      resendApiUrl: 'https://api.resend.com',
    });
    const stubbed = await loadConfig({
      ...email,
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'Merkur <signin@merkur.test>',
      RESEND_API_URL: 'http://127.0.0.1:4010/',
    });
    expect(stubbed.emailDelivery?.resendApiUrl).toBe('http://127.0.0.1:4010');
  });

  test('username identity refuses every mail variable', async () => {
    for (const [name, value] of [
      ['RESEND_API_KEY', 're_test'],
      ['EMAIL_FROM', 'Merkur <signin@merkur.test>'],
      ['RESEND_API_URL', 'https://api.resend.com'],
    ] as const) {
      await expect(loadConfig({ [name]: value })).rejects.toThrow();
    }
  });

  test('requires one stable OPAQUE setup and matching server/browser pins', async () => {
    for (const name of [
      'OPAQUE_SERVER_SETUP',
      'OPAQUE_SERVER_PUBLIC_KEY',
      'VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY',
    ]) {
      const provider = ConfigProvider.fromUnknown(withoutRequiredEntry(name));
      await expect(
        Effect.runPromise(Effect.provide(loadServerConfig, ConfigProvider.layer(provider))),
      ).rejects.toThrow();
    }
    expect(Redacted.value((await loadConfig({})).opaqueServerSetup)).toBe(OPAQUE_SERVER_SETUP);
    expect((await loadConfig({})).opaqueServerPublicKey).toBe(OPAQUE_SERVER_PUBLIC_KEY);
    await expect(loadConfig({ OPAQUE_SERVER_SETUP: 'not-a-setup' })).rejects.toThrow();
    await expect(
      loadConfig({ OPAQUE_SERVER_PUBLIC_KEY: Buffer.alloc(32).toString('base64url') }),
    ).rejects.toThrow();
    await expect(
      loadConfig({
        VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY: Buffer.alloc(32).toString('base64url'),
      }),
    ).rejects.toThrow();
    await expect(
      loadConfig({ VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY: 'not-a-public-key' }),
    ).rejects.toThrow();
  });

  test('validates port, canonical public origin, and bounded session token TTL', async () => {
    for (const port of ['0', '65536', '-1']) {
      await expect(loadConfig({ PORT: port })).rejects.toThrow();
    }
    for (const publicOrigin of [
      'ftp://example.com',
      'https://user@example.com',
      'https://example.com/',
      'https://example.com/path',
      'https://example.com?query=1',
    ]) {
      await expect(loadConfig({ PUBLIC_ORIGIN: publicOrigin })).rejects.toThrow();
    }
    for (const ttl of ['0', '-1', String(MIN_SESSION_TOKEN_TTL_MS - 1), '300001']) {
      await expect(loadConfig({ SESSION_TOKEN_TTL_MS: ttl })).rejects.toThrow();
    }
    expect(
      (await loadConfig({ SESSION_TOKEN_TTL_MS: String(MIN_SESSION_TOKEN_TTL_MS) }))
        .sessionTokenTtlMs,
    ).toBe(MIN_SESSION_TOKEN_TTL_MS);
  });

  test('requires an exact canonical ML-DSA-87 session-token seed', async () => {
    const seed = Buffer.alloc(32, 7).toString('base64url');
    const config = await loadConfig({ SESSION_TOKEN_MLDSA87_SEED: seed });
    expect(config.sessionTokenSigningKey.publicKey).toEqual(
      Buffer.from(config.sessionTokenVerifyKeyB64, 'base64url'),
    );
    expect(config.sessionTokenVerifyKeyB64).toHaveLength(3_456);

    for (const invalid of ['', `${seed}=`, seed.slice(1), '~'.repeat(43)]) {
      await expect(loadConfig({ SESSION_TOKEN_MLDSA87_SEED: invalid })).rejects.toThrow();
    }
  });

  test('requires an exact canonical 64-byte access-token HMAC key', async () => {
    const key = Buffer.alloc(64, 0x55).toString('base64url');
    expect((await loadConfig({ ACCESS_TOKEN_HMAC_KEY: key })).accessTokenHmacKey).toEqual(
      new Uint8Array(Buffer.alloc(64, 0x55)),
    );
    for (const invalid of ['', `${key}=`, key.slice(1), '~'.repeat(86)]) {
      await expect(loadConfig({ ACCESS_TOKEN_HMAC_KEY: invalid })).rejects.toThrow();
    }
  });

  test('requires one distinct canonical 64-byte registration key per edge id', async () => {
    const first = Buffer.alloc(64, 0x11).toString('base64url');
    const second = Buffer.alloc(64, 0x22).toString('base64url');
    const config = await loadConfig({
      EDGE_REGISTRATION_KEYS_JSON: JSON.stringify({ 'fra-1': first, 'iad-1': second }),
    });
    expect(config.edgeRegistrationKeys.get('fra-1')).toEqual(
      new Uint8Array(Buffer.alloc(64, 0x11)),
    );
    expect(config.edgeRegistrationKeys.get('iad-1')).toEqual(
      new Uint8Array(Buffer.alloc(64, 0x22)),
    );

    for (const invalid of [
      '{}',
      JSON.stringify({ '-bad': first }),
      JSON.stringify({ 'iad-1': first.slice(1) }),
      JSON.stringify({ 'fra-1': first, 'iad-1': first }),
      JSON.stringify({ 'iad-1': second, 'fra-1': first }),
      `{ "fra-1":"${first}" }`,
    ]) {
      await expect(loadConfig({ EDGE_REGISTRATION_KEYS_JSON: invalid })).rejects.toThrow();
    }
  });

  test('requires an explicit bounded trusted proxy hop count', async () => {
    // No default: guessing here either hands out a spoofable rate-limit key or
    // buckets every client together.
    await expect(
      Effect.runPromise(
        Effect.provide(
          loadServerConfig,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown(withoutRequiredEntry('TRUSTED_PROXY_HOPS')),
          ),
        ),
      ),
    ).rejects.toThrow();

    for (const hops of ['-1', '9', '1.5']) {
      await expect(loadConfig({ TRUSTED_PROXY_HOPS: hops })).rejects.toThrow();
    }

    for (const hops of ['0', '1', '8']) {
      const config = await loadConfig({ TRUSTED_PROXY_HOPS: hops });
      expect(config.trustedProxyHops).toBe(Number.parseInt(hops, 10));
    }
  });

  test('box-host STUN observers default to none and must name STUN_SERVERS entries', async () => {
    expect((await loadConfig({})).boxHostStunObservers).toEqual([]);
    const config = await loadConfig({ BOX_HOST_STUN_OBSERVERS: ' stun.test:3479 ' });
    expect(config.boxHostStunObservers).toEqual(['stun.test:3479']);
    // An entry that is not in STUN_SERVERS would exclude nothing.
    for (const invalid of ['other.test:3479', 'stun.test:3479,stun.test:3479']) {
      await expect(loadConfig({ BOX_HOST_STUN_OBSERVERS: invalid })).rejects.toThrow();
    }
  });
});

function loadConfig(entries: Record<string, string | undefined>) {
  const provider = ConfigProvider.fromUnknown({
    ...requiredEntries(),
    ...entries,
  });

  return Effect.runPromise(Effect.provide(loadServerConfig, ConfigProvider.layer(provider)));
}

function requiredEntries(): Record<string, string> {
  return {
    ACCESS_TOKEN_HMAC_KEY: Buffer.alloc(64, 0x55).toString('base64url'),
    REDIS_URL: 'redis://127.0.0.1:6379',
    SESSION_TOKEN_MLDSA87_SEED: Buffer.alloc(32).toString('base64url'),
    EDGE_REGISTRATION_KEYS_JSON: JSON.stringify({
      'local-dev-1': Buffer.alloc(64, 0x33).toString('base64url'),
    }),
    STUN_TICKET_KEY: Buffer.alloc(64, 0x77).toString('base64url'),
    EDGE_ATTACH_TICKET_KEY: Buffer.alloc(64, 0x78).toString('base64url'),
    STUN_SERVERS: 'stun.test:3478,stun.test:3479',
    TOKEN_HMAC_SECRET: Buffer.alloc(64, 0xaa).toString('base64url'),
    AUTH_ALLOW_REGISTRATION: 'true',
    AUTH_IDENTITY: 'username',
    OPAQUE_SERVER_SETUP,
    OPAQUE_SERVER_PUBLIC_KEY,
    VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY: OPAQUE_SERVER_PUBLIC_KEY,
    TRUSTED_PROXY_HOPS: '1',
  };
}

function withoutRequiredEntry(name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(requiredEntries()).filter(([key]) => key !== name));
}
