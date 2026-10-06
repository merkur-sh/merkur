import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';

import { isTransportWorkerAssetPath } from '../http/web-ui';
import {
  inlineStyleHashes,
  securityHeadersPlugin,
  transportWorkerContentSecurityPolicy,
} from './security-headers';

async function responseHeaders(styleHashes: readonly string[] = []): Promise<Headers> {
  const app = new Elysia().use(securityHeadersPlugin(styleHashes)).get('/', () => 'ok');
  const response = await app.handle(new Request('https://merkur.test/'));
  return response.headers;
}

async function contentSecurityPolicy(styleHashes: readonly string[] = []): Promise<string> {
  return (await responseHeaders(styleHashes)).get('Content-Security-Policy') ?? '';
}

function directive(policy: string, name: string): string {
  return (
    policy
      .split(';')
      .map((entry) => entry.trim())
      .find((entry) => entry === name || entry.startsWith(`${name} `)) ?? ''
  );
}

describe('security headers', () => {
  test('serves a content security policy', async () => {
    expect(await contentSecurityPolicy()).not.toBe('');
  });

  test('keeps every response out of search indexes', async () => {
    expect((await responseHeaders()).get('X-Robots-Tag')).toBe('noindex');
  });

  test('no directive permits inline execution or styling', async () => {
    const policy = await contentSecurityPolicy();
    // The build inlines the stylesheet into the shell, so there IS a `<style>`
    // element — allowed by its own hash, which permits exactly those bytes and
    // nothing else an injection could add. `unsafe-inline` stays out, and a
    // hash source does not reintroduce it. Runtime `element.style` / `cssText`
    // writes are CSSOM and stay exempt from CSP either way.
    //
    // The `<style>`-element check alone is not sufficient, and once was not:
    // Solid hoists the constant properties of a JSX `style` object into the
    // compiled template's HTML as a literal `style="..."` attribute, which this
    // policy blocks while the same declaration written as `element.style` would
    // have been exempt. Constant styling belongs in a class; only values that
    // actually vary at runtime belong in `style`.
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-hashes'");
  });

  test('script-src allows only same-origin scripts plus wasm compilation', async () => {
    const policy = await contentSecurityPolicy();
    expect(directive(policy, 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    // Full `unsafe-eval` would re-enable string-to-code execution for the whole
    // bundle; `wasm-unsafe-eval` only permits WebAssembly compilation.
    expect(policy).not.toContain("'unsafe-eval'");
  });

  test('style-src is same-origin plus the shell stylesheet hashes it was given', async () => {
    // No shell (dev, or a build with no inline style) must not widen the policy.
    expect(directive(await contentSecurityPolicy(), 'style-src')).toBe("style-src 'self'");
    const policy = await contentSecurityPolicy(['sha256-aaa', 'sha256-bbb']);
    expect(directive(policy, 'style-src')).toBe("style-src 'self' 'sha256-aaa' 'sha256-bbb'");
  });

  test('shell style hashes are derived from the built HTML, so they cannot drift', () => {
    // Exactly the bytes between the tags, so the digest tracks the stylesheet
    // the build actually inlined rather than a value written down beside it.
    const html = '<html><head><style>body{color:red}</style></head><body></body></html>';
    const [hash, ...rest] = inlineStyleHashes(html);
    expect(rest).toEqual([]);
    expect(hash).toBe(
      `sha256-${new Bun.CryptoHasher('sha256').update('body{color:red}', 'utf8').digest('base64')}`,
    );
    // A shell with no inline style yields nothing to allow.
    expect(inlineStyleHashes('<html><head></head><body></body></html>')).toEqual([]);
    // Attribute-bearing and empty style elements are handled without widening.
    expect(inlineStyleHashes('<style media="print">a{b:c}</style>')).toHaveLength(1);
    expect(inlineStyleHashes('<style></style>')).toEqual([]);
  });

  test('locks down document-level injection vectors', async () => {
    const policy = await contentSecurityPolicy();
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
    expect(directive(policy, 'worker-src')).toBe("worker-src 'self'");
  });

  test('the document cannot reach any external host', async () => {
    // Everything the document itself talks to is same-origin. The scheme-level
    // `https:` the direct WebTransport upgrade needs lives on the transport
    // worker's own response instead, so injected code running in the document
    // has no general-purpose way out.
    expect(directive(await contentSecurityPolicy(), 'connect-src')).toBe("connect-src 'self'");
  });

  test('only the transport worker response widens connect-src', async () => {
    // A dedicated worker takes its CSP from its own script response rather than
    // inheriting the document's, which is what lets these two differ. Verified
    // across Chromium, Firefox, and WebKit before this split was adopted.
    const workerPolicy = transportWorkerContentSecurityPolicy(false);
    expect(directive(workerPolicy, 'connect-src')).toBe("connect-src 'self' https:");

    // Everything else must stay identical to the document policy, so the worker
    // realm is not accidentally looser in some other dimension.
    const documentPolicy = await contentSecurityPolicy();
    for (const name of [
      'default-src',
      'base-uri',
      'object-src',
      'frame-ancestors',
      'form-action',
      'script-src',
      'style-src',
      'worker-src',
    ]) {
      expect(directive(workerPolicy, name)).toBe(directive(documentPolicy, name));
    }
  });

  test('the transport worker asset is matched by path, and no other worker is', async () => {
    expect(isTransportWorkerAssetPath('/assets/transport-worker-DMToEl7V.js')).toBe(true);
    // The terminal worker does no networking and must keep the document policy.
    expect(isTransportWorkerAssetPath('/assets/terminal-worker-B-Y03Ake.js')).toBe(false);
    expect(isTransportWorkerAssetPath('/index.html')).toBe(false);
    expect(isTransportWorkerAssetPath('/sw.js')).toBe(false);
    expect(isTransportWorkerAssetPath('/assets/transport-worker-DMToEl7V.js.map')).toBe(false);
  });

  test('refuses content-type sniffing', async () => {
    expect((await responseHeaders()).get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('sets isolation and referrer headers', async () => {
    const headers = await responseHeaders();
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  test('denies powerful device permissions by default', async () => {
    const permissionsPolicy = (await responseHeaders()).get('Permissions-Policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(permissionsPolicy).toContain(`${feature}=()`);
    }
  });
});
