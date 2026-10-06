/**
 * De-risk probe: can Playwright's Chromium open a native WebTransport session to
 * the local self-signed merkur-edge using serverCertificateHashes? This is the
 * make-or-break primitive for a browser-over-edge reproduction harness. It only
 * checks that the H3/QUIC session `.ready` resolves — the edge is a blind splice
 * relay, so no data is exchanged here.
 *
 * Requires a local edge already listening on EDGE_URL with cert EDGE_CERT_HASH
 * (base64 sha-256). Playwright starts its own localhost secure-context origin.
 * Run:
 *   EDGE_URL=https://[::1]:4433 EDGE_CERT_HASH=... \
 *   bunx playwright test -c playwright.edge-probe.config.mjs
 */
import { expect, test } from './fixtures/test';

const EDGE_URL = process.env.EDGE_URL ?? 'https://[::1]:4433';
const EDGE_CERT_HASH = process.env.EDGE_CERT_HASH ?? '';
test('chromium can open a WebTransport session to the local edge', async ({ page, baseURL }) => {
  expect(EDGE_CERT_HASH, 'EDGE_CERT_HASH env must be set').not.toBe('');
  if (baseURL === undefined) {
    throw new Error('edge probe requires baseURL from playwright.edge-probe.config.mjs');
  }
  await page.goto(baseURL);

  const result = await page.evaluate(
    async ([url, certHashB64]) => {
      // base64 -> Uint8Array (32-byte sha-256 digest).
      const bin = atob(certHashB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      if (typeof (globalThis as { WebTransport?: unknown }).WebTransport !== 'function') {
        return { ok: false, stage: 'unsupported', error: 'WebTransport is not defined' };
      }
      try {
        const wt = new WebTransport(url, {
          serverCertificateHashes: [{ algorithm: 'sha-256', value: bytes }],
        });
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('ready timeout')), 8000),
        );
        await Promise.race([wt.ready, timeout]);
        wt.close();
        return { ok: true, stage: 'ready', error: '' };
      } catch (err) {
        return { ok: false, stage: 'handshake', error: String(err) };
      }
    },
    [EDGE_URL, EDGE_CERT_HASH] as const,
  );

  // biome-ignore lint/suspicious/noConsole: probe diagnostic
  console.log(`[wt-probe] url=${EDGE_URL} ${JSON.stringify(result)}`);
  expect(result.ok, `WebTransport failed at ${result.stage}: ${result.error}`).toBe(true);
});
