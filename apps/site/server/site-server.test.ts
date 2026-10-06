import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

import { TRACKING_CONFIG } from './rybbit-proxy';
import { contentSecurityPolicy, type LoadedSite, loadSite, startSiteServer } from './site-server';
import {
  closedPort,
  FIXTURE_PATHS,
  type FixtureSite,
  rawRequest,
  silentLogger,
  writeFixtureSite,
} from './test-support';

const API_ORIGIN = 'https://merkur.sh';
const UPSTREAM_TIMEOUT_MS = 300;
const SCRIPT_SOURCE = `window.rybbit = {${'/* track */'.repeat(40)}};`;
const SCRIPT_BROTLI = brotliCompressSync(SCRIPT_SOURCE);

interface UpstreamRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const upstreamRequests: UpstreamRequest[] = [];
let upstream: Bun.Server<undefined>;
let fixture: FixtureSite;
let site: LoadedSite;
const servers: Bun.Server<undefined>[] = [];

/** Rybbit Cloud as the proxy sees it, plus the failures a real upstream has. */
function startFakeRybbit(): Bun.Server<undefined> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      upstreamRequests.push({
        method: request.method,
        target: `${url.pathname}${url.search}`,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      const leaky = {
        'set-cookie': 'rybbit=visitor; Path=/; HttpOnly',
        'access-control-allow-origin': '*',
        'strict-transport-security': 'max-age=1',
        nel: '{"report_to":"rybbit","max_age":86400}',
        'cache-control': 'private, max-age=9',
      };
      switch (`${url.pathname}${url.search}`) {
        case '/api/script.js?encoded':
          return new Response(SCRIPT_BROTLI, {
            headers: {
              'content-type': 'application/javascript',
              'content-encoding': 'br',
              'content-length': String(SCRIPT_BROTLI.byteLength),
            },
          });
        case '/api/script.js?explode':
          return new Response('upstream broke', { status: 500 });
        case '/api/script.js?redirect':
          return new Response(null, {
            status: 302,
            headers: { location: 'https://elsewhere.test/' },
          });
        case '/api/script.js?stall':
          await Bun.sleep(UPSTREAM_TIMEOUT_MS * 4);
          return new Response('late');
        case '/api/script.js?missing':
          return Response.json({ error: 'Site not found' }, { status: 404, headers: leaky });
        case '/api/script.js':
        case '/api/script.js?v=2':
          if (request.headers.get('if-none-match') === '"script-v1"') {
            return new Response(null, { status: 304, headers: { ...leaky, etag: '"script-v1"' } });
          }
          return new Response('window.rybbit = {};', {
            headers: { ...leaky, 'content-type': 'application/javascript', etag: '"script-v1"' },
          });
        case '/api/track':
          return Response.json({ success: true }, { headers: leaky });
        default:
          // Rybbit's own tracking config included: the site answers that itself.
          return new Response('unexpected upstream path', { status: 500 });
      }
    },
  });
}

function startSite(options: { trustedProxyHops?: number; rybbitHost?: string } = {}): number {
  const server = startSiteServer({
    site,
    hostname: '127.0.0.1',
    port: 0,
    rybbitHost: options.rybbitHost ?? `http://127.0.0.1:${upstream.port}`,
    trustedProxyHops: options.trustedProxyHops ?? 1,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    logger: silentLogger,
  });
  servers.push(server);
  if (server.port === undefined) {
    throw new Error('site server has no port');
  }
  return server.port;
}

let port: number;
const url = (target: string) => `http://127.0.0.1:${port}${target}`;

function lastUpstream(): UpstreamRequest {
  const request = upstreamRequests.at(-1);
  if (request === undefined) {
    throw new Error('upstream saw no request');
  }
  return request;
}

beforeAll(async () => {
  upstream = startFakeRybbit();
  fixture = await writeFixtureSite();
  site = await loadSite(fixture.distDirectory, API_ORIGIN);
  port = startSite();
});

afterAll(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  upstream.stop(true);
  await rm(fixture.distDirectory, { recursive: true, force: true });
});

function expectSecurityHeaders(response: { headers: { get(name: string): string | null } }): void {
  expect(response.headers.get('content-security-policy')).toBe(
    contentSecurityPolicy(API_ORIGIN, fixture.styleHashes),
  );
  expect(response.headers.get('strict-transport-security')).toBe(
    'max-age=63072000; includeSubDomains',
  );
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(response.headers.get('permissions-policy')).toBe(
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
  expect(response.headers.get('vary')).toBe('Accept-Encoding');
  expect(response.headers.get('set-cookie')).toBeNull();
}

describe('the addresses the server answers without a file', () => {
  test('/install sends a client to the app’s installer, and takes no body', async () => {
    const response = await fetch(url('/install'), { redirect: 'manual' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`${API_ORIGIN}/install`);
    expectSecurityHeaders(response);
    const posted = await fetch(url('/install'), { method: 'POST', redirect: 'manual' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET, HEAD');
  });

  test('the www alias answers with the same address on the bare host', async () => {
    const response = await rawRequest(
      port,
      'GET /security?from=mail HTTP/1.1\r\nHost: www.merkur.sh\r\nConnection: close\r\n\r\n',
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://merkur.sh/security?from=mail');
    // Even the installer's address: one hop to the bare host, the next to the app.
    const install = await rawRequest(
      port,
      'GET /install HTTP/1.1\r\nHost: www.merkur.sh\r\nConnection: close\r\n\r\n',
    );
    expect(install.headers.get('location')).toBe('https://merkur.sh/install');
  });
});

describe('content security policy', () => {
  test('names the manifest style hashes, the API origin, and nothing broader', () => {
    const [homeHash, securityHash] = fixture.styleHashes;
    expect(contentSecurityPolicy(API_ORIGIN, fixture.styleHashes)).toBe(
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
        "connect-src 'self' https://merkur.sh; img-src 'self'; font-src 'self'; " +
        `style-src '${homeHash}' '${securityHash}'; form-action https://merkur.sh 'self'; ` +
        "base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
    );
  });

  test('admits no inline style when the build inlined none', () => {
    expect(contentSecurityPolicy(API_ORIGIN, [])).toContain("style-src 'none';");
  });
});

describe('documents and files', () => {
  test('serves each route with the document cache policy and security headers', async () => {
    for (const [target, file] of [
      ['/', 'index.html'],
      ['/security', 'security.html'],
      ['/?utm_source=launch', 'index.html'],
    ] as const) {
      const response = await fetch(url(target), { headers: { 'accept-encoding': 'identity' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      );
      expect(response.headers.get('content-encoding')).toBeNull();
      expectSecurityHeaders(response);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture.fileBytes(file));
    }
  });

  test('caches hashed assets, fonts and recordings for a year and mutable files like documents', async () => {
    const expected = {
      [FIXTURE_PATHS.script]: [
        'public, max-age=31536000, immutable',
        'text/javascript; charset=utf-8',
      ],
      [FIXTURE_PATHS.font]: ['public, max-age=31536000, immutable', 'font/woff2'],
      [FIXTURE_PATHS.recording]: [
        'public, max-age=31536000, immutable',
        'application/octet-stream',
      ],
      [FIXTURE_PATHS.robots]: [
        'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
        'text/plain; charset=utf-8',
      ],
    };
    for (const [target, [cacheControl, contentType]] of Object.entries(expected)) {
      const response = await fetch(url(target), { headers: { 'accept-encoding': 'identity' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(cacheControl ?? '');
      expect(response.headers.get('content-type')).toBe(contentType ?? '');
      expectSecurityHeaders(response);
      await response.arrayBuffer();
    }
  });

  test('serves the 404 document with status 404 and a one-minute CDN lifetime', async () => {
    const response = await fetch(url('/pricing'), { headers: { 'accept-encoding': 'identity' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    expectSecurityHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture.fileBytes('404.html'));
  });

  test('answers HEAD with the GET headers and no body', async () => {
    const get = await fetch(url(FIXTURE_PATHS.script), {
      headers: { 'accept-encoding': 'identity' },
    });
    const getBody = await get.arrayBuffer();
    const head = await fetch(url(FIXTURE_PATHS.script), {
      method: 'HEAD',
      headers: { 'accept-encoding': 'identity' },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(getBody.byteLength));
    expect(head.headers.get('etag')).toBe(get.headers.get('etag'));
    expect(head.headers.get('cache-control')).toBe(get.headers.get('cache-control'));
    expectSecurityHeaders(head);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const missing = await fetch(url('/nowhere'), { method: 'HEAD' });
    expect(missing.status).toBe(404);
    expect((await missing.arrayBuffer()).byteLength).toBe(0);
  });
});

describe('brotli negotiation', () => {
  test('sends the brotli sibling only to a client that accepts br', async () => {
    const identityBytes = fixture.fileBytes('assets/main-Ab12Cd34.js');
    const compressed = await fetch(url(FIXTURE_PATHS.script), {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
      decompress: false,
    });
    expect(compressed.headers.get('content-encoding')).toBe('br');
    const brotliBytes = new Uint8Array(await compressed.arrayBuffer());
    expect(brotliBytes.byteLength).toBeLessThan(identityBytes.byteLength);
    expect(new Uint8Array(brotliDecompressSync(brotliBytes))).toEqual(identityBytes);

    for (const acceptEncoding of ['gzip, deflate', 'br;q=0, gzip', 'identity']) {
      const identity = await fetch(url(FIXTURE_PATHS.script), {
        headers: { 'accept-encoding': acceptEncoding },
        decompress: false,
      });
      expect(identity.headers.get('content-encoding')).toBeNull();
      expect(identity.headers.get('etag')).not.toBe(compressed.headers.get('etag'));
      expect(new Uint8Array(await identity.arrayBuffer())).toEqual(identityBytes);
    }
  });

  test('compresses documents and the 404 page, never an already-compressed font', async () => {
    for (const target of ['/', '/security', '/missing', FIXTURE_PATHS.recording]) {
      const response = await fetch(url(target), {
        headers: { 'accept-encoding': 'br' },
        decompress: false,
      });
      expect(response.headers.get('content-encoding')).toBe('br');
      await response.arrayBuffer();
    }
    const font = await fetch(url(FIXTURE_PATHS.font), {
      headers: { 'accept-encoding': 'br' },
      decompress: false,
    });
    expect(font.headers.get('content-encoding')).toBeNull();
    expect(new Uint8Array(await font.arrayBuffer())).toEqual(
      fixture.fileBytes('fonts/Inter-Var.woff2'),
    );
  });

  test('a client without Accept-Encoding gets identity bytes', async () => {
    const response = await rawRequest(
      port,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeUndefined();
    expect(response.body).toBe(new TextDecoder().decode(fixture.fileBytes('index.html')));
  });
});

describe('conditional requests', () => {
  test('revalidates a representation by its entity tag', async () => {
    const first = await fetch(url('/'), {
      headers: { 'accept-encoding': 'br' },
      decompress: false,
    });
    await first.arrayBuffer();
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);

    for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const revalidated = await fetch(url('/'), {
        headers: { 'accept-encoding': 'br', 'if-none-match': ifNoneMatch },
        decompress: false,
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get('etag')).toBe(etag);
      expect(revalidated.headers.get('content-type')).toBeNull();
      expect(revalidated.headers.get('cache-control')).toBe(first.headers.get('cache-control'));
      expectSecurityHeaders(revalidated);
    }

    const changed = await fetch(url('/'), {
      headers: { 'accept-encoding': 'identity', 'if-none-match': etag },
    });
    expect(changed.status).toBe(200);
    await changed.arrayBuffer();
  });

  test('never answers a missing path with 304', async () => {
    const response = await fetch(url('/missing'), { headers: { 'if-none-match': '*' } });
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });
});

describe('paths that name no manifest entry', () => {
  test('dot segments, encoded dots, build files and near misses all get the 404 document', async () => {
    const notFoundBody = new TextDecoder().decode(fixture.fileBytes('404.html'));
    for (const target of [
      '/assets/../index.html',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/%2E%2E/site-manifest.json',
      '/assets/..%2f..%2fsite-manifest.json',
      '/assets/..%5c..%5cindex.html',
      '/site-manifest.json',
      '/index.html',
      '/index.html.br',
      '/assets/main-Ab12Cd34.js.br',
      '/assets/main-Ab12Cd34.js/',
      '//assets/main-Ab12Cd34.js',
      '/security/',
      '/SECURITY',
      '/analytics/replay.js',
      '/analytics/metrics.js',
      '/analytics/site/tracking-config/..%2f..%2fapi',
    ]) {
      const response = await rawRequest(
        port,
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
      expect({ target, status: response.status }).toEqual({ target, status: 404 });
      expect(response.body).toBe(notFoundBody);
    }
  });
});

describe('methods', () => {
  test('refuses every method but GET and HEAD outside the track beacon', async () => {
    for (const [method, target, allow] of [
      ['POST', '/', 'GET, HEAD'],
      ['POST', '/nowhere', 'GET, HEAD'],
      ['PUT', FIXTURE_PATHS.script, 'GET, HEAD'],
      ['DELETE', '/security', 'GET, HEAD'],
      ['OPTIONS', '/', 'GET, HEAD'],
      ['POST', '/healthz', 'GET, HEAD'],
      ['POST', '/analytics/script.js', 'GET, HEAD'],
      ['POST', '/analytics/site/tracking-config/abc123', 'GET, HEAD'],
      ['POST', '/analytics/identify', 'GET, HEAD'],
      ['GET', '/analytics/track', 'POST'],
      ['PUT', '/analytics/track', 'POST'],
    ] as const) {
      const before = upstreamRequests.length;
      const response = await fetch(url(target), { method, body: method === 'GET' ? null : 'x' });
      expect({ method, target, status: response.status }).toEqual({ method, target, status: 405 });
      expect(response.headers.get('allow')).toBe(allow);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expectSecurityHeaders(response);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(upstreamRequests.length).toBe(before);
    }
  });

  test('reports health with an empty 204', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(url('/healthz'), { method });
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expectSecurityHeaders(response);
    }
  });
});

describe('rybbit proxy', () => {
  test('forwards each route to its exact upstream path and query', async () => {
    const cases = [
      ['GET', '/analytics/script.js', '/api/script.js'],
      ['GET', '/analytics/script.js?v=2', '/api/script.js?v=2'],
      ['POST', '/analytics/track', '/api/track'],
    ] as const;
    for (const [method, target, upstreamTarget] of cases) {
      const response = await fetch(url(target), {
        method,
        body: method === 'POST' ? '{"type":"pageview"}' : null,
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(lastUpstream().method).toBe(method);
      expect(lastUpstream().target).toBe(upstreamTarget);
    }
  });

  test('forwards the beacon body and the browser headers, without cookies or hop-by-hop fields', async () => {
    const body = JSON.stringify({
      site_id: 'abc123',
      type: 'custom_event',
      event_name: 'faq_open',
    });
    const response = await rawRequest(
      port,
      [
        'POST /analytics/track HTTP/1.1',
        'Host: merkur.sh',
        'Connection: close, X-Nominated',
        'Keep-Alive: timeout=5',
        'TE: trailers',
        'Trailer: X-Checksum',
        'Proxy-Authorization: Basic c2VjcmV0',
        'Proxy-Connection: keep-alive',
        'X-Nominated: private',
        'Cookie: session=abc',
        'X-Forwarded-For: 203.0.113.9, 198.51.100.7',
        'Origin: https://merkur.sh',
        'Referer: https://merkur.sh/',
        'User-Agent: Mozilla/5.0 (Macintosh) Test',
        'Accept: */*',
        'Accept-Language: en-GB,en;q=0.9',
        'Sec-Fetch-Site: same-origin',
        'Sec-Fetch-Mode: cors',
        'Sec-Fetch-Dest: empty',
        'Content-Type: text/plain;charset=UTF-8',
        'Transfer-Encoding: chunked',
        '',
        `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`,
      ].join('\r\n'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeUndefined();
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(JSON.parse(response.body)).toEqual({ success: true });

    const forwarded = lastUpstream();
    expect(new TextDecoder().decode(forwarded.body)).toBe(body);
    expect(forwarded.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    expect(forwarded.headers.get('transfer-encoding')).toBeNull();
    for (const dropped of [
      'cookie',
      'keep-alive',
      'te',
      'trailer',
      'proxy-authorization',
      'proxy-connection',
      'x-nominated',
    ]) {
      expect({ dropped, value: forwarded.headers.get(dropped) }).toEqual({ dropped, value: null });
    }
    expect(forwarded.headers.get('connection') ?? '').not.toContain('X-Nominated');
    expect(forwarded.headers.get('host')).toBe(`127.0.0.1:${upstream.port}`);
    expect(forwarded.headers.get('x-forwarded-for')).toBe('198.51.100.7');
    expect(
      Object.fromEntries(
        [
          'origin',
          'referer',
          'user-agent',
          'accept',
          'accept-language',
          'sec-fetch-site',
          'sec-fetch-mode',
          'sec-fetch-dest',
          'content-type',
        ].map((name) => [name, forwarded.headers.get(name)]),
      ),
    ).toEqual({
      origin: 'https://merkur.sh',
      referer: 'https://merkur.sh/',
      'user-agent': 'Mozilla/5.0 (Macintosh) Test',
      accept: '*/*',
      'accept-language': 'en-GB,en;q=0.9',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'content-type': 'text/plain;charset=UTF-8',
    });
  });

  test('relays only the content fields of the upstream response, under the route cache policy', async () => {
    const script = await fetch(url('/analytics/script.js'));
    expect(script.status).toBe(200);
    expect(await script.text()).toBe('window.rybbit = {};');
    expect(script.headers.get('content-type')).toBe('application/javascript');
    expect(script.headers.get('etag')).toBe('"script-v1"');
    expect(script.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(script.headers.get('access-control-allow-origin')).toBeNull();
    expect(script.headers.get('nel')).toBeNull();
    expectSecurityHeaders(script);

    const missing = await fetch(url('/analytics/script.js?missing'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(await missing.json()).toEqual({ error: 'Site not found' });
    expectSecurityHeaders(missing);
  });

  test('passes a conditional request through and relays the 304', async () => {
    const response = await fetch(url('/analytics/script.js'), {
      headers: { 'if-none-match': '"script-v1"' },
    });
    expect(response.status).toBe(304);
    expect(lastUpstream().headers.get('if-none-match')).toBe('"script-v1"');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expectSecurityHeaders(response);
  });

  test('relays the upstream encoding untouched', async () => {
    const response = await fetch(url('/analytics/script.js?encoded'), {
      headers: { 'accept-encoding': 'br' },
      decompress: false,
    });
    expect(lastUpstream().headers.get('accept-encoding')).toBe('br');
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(SCRIPT_BROTLI));
    expect(brotliDecompressSync(bytes).toString()).toBe(SCRIPT_SOURCE);
  });

  test('answers the tracking config itself, the same fixed policy for any site id, never from Rybbit', async () => {
    const before = upstreamRequests.length;
    for (const target of [
      '/analytics/site/tracking-config/abc123',
      '/analytics/site/tracking-config/e2e-site?x=1',
    ]) {
      const config = await fetch(url(target));
      expect(config.status).toBe(200);
      expect(config.headers.get('content-type')).toBe('application/json');
      expect(config.headers.get('cache-control')).toBe('public, max-age=300');
      expectSecurityHeaders(config);
      expect(await config.json()).toEqual({
        trackInitialPageView: true,
        trackSpaNavigation: false,
        trackUrlParams: false,
        trackOutbound: false,
        webVitals: true,
        trackErrors: false,
        sessionReplay: false,
        trackButtonClicks: false,
        trackCopy: false,
        trackFormInteractions: false,
        featureFlagsEnabled: false,
      });
    }
    const head = await fetch(url('/analytics/site/tracking-config/abc123'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(TRACKING_CONFIG.trackUrlParams).toBe(false);
    expect(upstreamRequests.length).toBe(before);
  });

  test('answers HEAD on a script route without a body', async () => {
    const response = await fetch(url('/analytics/script.js'), { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(lastUpstream().method).toBe('HEAD');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('takes the visitor address under the configured proxy hops', async () => {
    const hops = [
      [1, '203.0.113.9, 198.51.100.7', '198.51.100.7'],
      [2, '203.0.113.9, 198.51.100.7', '203.0.113.9'],
      [1, '2001:db8::7', '2001:db8::7'],
      [3, '203.0.113.9, 198.51.100.7', '127.0.0.1'],
      [1, 'not-an-address', '127.0.0.1'],
      [0, '203.0.113.9', '127.0.0.1'],
      [1, null, '127.0.0.1'],
    ] as const;
    for (const [trustedProxyHops, forwardedFor, expected] of hops) {
      const hopsPort = startSite({ trustedProxyHops });
      const response = await fetch(`http://127.0.0.1:${hopsPort}/analytics/script.js`, {
        headers: forwardedFor === null ? {} : { 'x-forwarded-for': forwardedFor },
      });
      await response.arrayBuffer();
      const seen = lastUpstream().headers.get('x-forwarded-for') ?? '';
      expect({ trustedProxyHops, forwardedFor, seen: seen.replace(/^::ffff:/, '') }).toEqual({
        trustedProxyHops,
        forwardedFor,
        seen: expected,
      });
    }
  });

  test('turns an upstream error, redirect, timeout or refusal into a bare 502', async () => {
    const unreachable = startSite({ rybbitHost: `http://127.0.0.1:${closedPort()}` });
    for (const target of [
      url('/analytics/script.js?explode'),
      url('/analytics/script.js?redirect'),
      url('/analytics/script.js?stall'),
      `http://127.0.0.1:${unreachable}/analytics/script.js`,
    ]) {
      const response = await fetch(target);
      expect({ target, status: response.status }).toEqual({ target, status: 502 });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('location')).toBeNull();
      expectSecurityHeaders(response);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
  });

  test('caps the beacon body at 64 KiB', async () => {
    const limit = 64 * 1024;
    const accepted = await fetch(url('/analytics/track'), {
      method: 'POST',
      body: new Uint8Array(limit).fill(0x61),
    });
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();
    expect(lastUpstream().body.byteLength).toBe(limit);

    const before = upstreamRequests.length;
    const refused = await fetch(url('/analytics/track'), {
      method: 'POST',
      body: new Uint8Array(limit + 1).fill(0x61),
    });
    expect(refused.status).toBe(413);
    expect(upstreamRequests.length).toBe(before);
  });
});
