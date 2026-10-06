import { readFileSync } from 'node:fs';

import { Elysia } from 'elysia';

const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy';
const CROSS_ORIGIN_OPENER_POLICY_HEADER = 'Cross-Origin-Opener-Policy';
const CROSS_ORIGIN_EMBEDDER_POLICY_HEADER = 'Cross-Origin-Embedder-Policy';
const REFERRER_POLICY_HEADER = 'Referrer-Policy';
const PERMISSIONS_POLICY_HEADER = 'Permissions-Policy';
const STRICT_TRANSPORT_SECURITY_HEADER = 'Strict-Transport-Security';
const CONTENT_TYPE_OPTIONS_HEADER = 'X-Content-Type-Options';
const ROBOTS_HEADER = 'X-Robots-Tag';
const NODE_ENV_PRODUCTION = 'production';
/**
 * Scheme-level `https:` in `connect-src` is unavoidable *somewhere*: the direct
 * WebTransport upgrade dials `https://<candidate addr>:<port>` using addresses
 * the daemon advertises at runtime (`apps/web/src/lib/webtransport.ts`), and CSP
 * host-source syntax cannot express "any address, any port" — IPv6 literals have
 * no expressible form at all.
 *
 * It does not have to be in the *document* policy, though. Every
 * `new WebTransport(...)` in the app runs in the transport worker's realm, and a
 * dedicated worker takes its CSP from its own script response rather than
 * inheriting the creating document's (only `blob:`/`data:` workers inherit).
 * So the breadth lives on that one asset — see `transportWorkerContentSecurityPolicy`
 * and its use in `apps/server/src/http/web-ui.ts` — and the document keeps
 * `connect-src 'self'`, which leaves injected code in the document with no
 * general-purpose way to reach an external host.
 *
 * Residual worth knowing: injected code could still construct the legitimate
 * transport worker (`worker-src 'self'`) and drive its message protocol toward
 * an attacker-chosen edge. That is far narrower and noisier than `fetch`, but it
 * is not nothing.
 *
 * Checking the edge inside the worker does not close it. The worker takes the
 * edge URL and its certificate hashes from the document's answer to
 * `request_session`, and nothing it could compare them with is out of the
 * document's reach: messages, same-origin storage, and same-origin requests
 * made with a token the document supplies. A session the server issues for an
 * account the attacker owns also reaches the attacker's own daemon through the
 * real edge, and that daemon names the addresses the worker dials directly.
 */
const CSP_DIRECTIVES_BEFORE_CONNECT =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self';";
const CSP_SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval';";
/**
 * `data:` is for one image and one only: the orb still the build inlines into
 * the shell's stylesheet, so the boot splash paints its mark without a round
 * trip. A `data:` image cannot execute, and `default-src 'self'` would
 * otherwise block it outright.
 */
const CSP_IMG_SRC = "img-src 'self' data:;";
const CSP_WORKER_SRC = "worker-src 'self';";
const DOCUMENT_CONNECT_SRC = "connect-src 'self';";
const TRANSPORT_WORKER_CONNECT_SRC = "connect-src 'self' https:;";

/**
 * `style-src` allows the shell's own inlined stylesheet by hash, and nothing
 * else inline.
 *
 * The build folds the stylesheet into `index.html` so the first paint costs no
 * round trip (see `apps/web/vite.config.ts`). The hashes are read back out of
 * the built HTML at startup rather than written down here: a hardcoded digest
 * that drifts from the shipped bytes does not fail loudly, it silently drops
 * every style in the document. `'unsafe-inline'` is not an option — it would
 * permit any injected style, and it was removed from this policy on purpose.
 */
function styleSrc(hashes: readonly string[]): string {
  return `style-src 'self'${hashes.map((hash) => ` '${hash}'`).join('')};`;
}

function contentSecurityPolicyValue(connectSrc: string, styleHashes: readonly string[]): string {
  return `${CSP_DIRECTIVES_BEFORE_CONNECT} ${connectSrc} ${CSP_SCRIPT_SRC} ${CSP_IMG_SRC} ${styleSrc(styleHashes)} ${CSP_WORKER_SRC}`;
}

const CSP_PRODUCTION_SUFFIX = ' upgrade-insecure-requests;';

/** `sha256-…` source expressions for every `<style>` element in an HTML shell. */
export function inlineStyleHashes(html: string): readonly string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)) {
    const body = match[1];
    if (body === undefined || body.length === 0) continue;
    hashes.push(`sha256-${Bun.CryptoHasher.hash('sha256', body, 'base64')}`);
  }
  return hashes;
}

/**
 * Hashes for the shell at `webIndexFile`, or none when it cannot be read.
 *
 * A missing shell is the normal dev case — Vite serves the app and injects
 * styles through CSSOM, which CSP does not police — so it is not an error. In
 * production the shell is always present, and a shell with no `<style>` yields
 * no hashes and the same `style-src 'self'` the policy had before.
 */
export function readInlineStyleHashes(webIndexFile: string): readonly string[] {
  try {
    return inlineStyleHashes(readFileSync(webIndexFile, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Policy for the transport worker script response. Identical to the document
 * policy except that `connect-src` keeps `https:` so the worker can dial the
 * edge and the direct WebTransport candidates.
 */
export function transportWorkerContentSecurityPolicy(production: boolean): string {
  // The worker realm has no document and therefore no inline stylesheet.
  const value = contentSecurityPolicyValue(TRANSPORT_WORKER_CONNECT_SRC, []);
  return production ? `${value}${CSP_PRODUCTION_SUFFIX}` : value;
}
const COOP_VALUE = 'same-origin';
const COEP_VALUE = 'require-corp';
const REFERRER_POLICY_VALUE = 'no-referrer';
const PERMISSIONS_POLICY_VALUE = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');
const HSTS_VALUE = 'max-age=31536000; includeSubDomains';
const CONTENT_TYPE_OPTIONS_VALUE = 'nosniff';
/**
 * Nothing this server answers belongs in a search index: it is an application
 * shell and an API, and the pages written to be found are the website's. A
 * header rather than a `robots.txt` rule, because a crawler has to be allowed
 * to fetch a page to be told not to list it.
 */
const ROBOTS_VALUE = 'noindex';

const PRODUCTION = process.env.NODE_ENV === NODE_ENV_PRODUCTION;

function securityHeaders(styleHashes: readonly string[]): Record<string, string> {
  const csp = contentSecurityPolicyValue(DOCUMENT_CONNECT_SRC, styleHashes);
  return {
    [CONTENT_SECURITY_POLICY_HEADER]: PRODUCTION ? `${csp}${CSP_PRODUCTION_SUFFIX}` : csp,
    [CROSS_ORIGIN_OPENER_POLICY_HEADER]: COOP_VALUE,
    [CROSS_ORIGIN_EMBEDDER_POLICY_HEADER]: COEP_VALUE,
    [REFERRER_POLICY_HEADER]: REFERRER_POLICY_VALUE,
    [PERMISSIONS_POLICY_HEADER]: PERMISSIONS_POLICY_VALUE,
    [CONTENT_TYPE_OPTIONS_HEADER]: CONTENT_TYPE_OPTIONS_VALUE,
    [ROBOTS_HEADER]: ROBOTS_VALUE,
    ...(PRODUCTION ? { [STRICT_TRANSPORT_SECURITY_HEADER]: HSTS_VALUE } : {}),
  };
}

/**
 * Default response headers rather than an `onAfterHandle` hook.
 *
 * Elysia seeds `set.headers` from the app's default headers when it builds the
 * request context, before routing. That reaches every exit — handler responses,
 * validation failures, thrown errors, and the built-in 404 — whereas an
 * after-handle hook runs only on the success path and left every error response
 * without a policy. It is also immune to plugin ordering and hook scope.
 *
 * Elysia merges these into a returned `Response` only for keys it does not
 * already carry, so the narrower per-asset policy in `web-ui.ts` still wins on
 * the transport worker's own response.
 */
export function securityHeadersPlugin(styleHashes: readonly string[] = []): Elysia {
  return new Elysia({ name: 'security-headers' }).headers(securityHeaders(styleHashes));
}
