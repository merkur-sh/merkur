import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type APIResponse, expect, type Page, test } from '@playwright/test';

import { parseSiteManifest, type SiteManifest } from '../../apps/site/server/manifest';
import { WAITLIST_MESSAGES } from '../../apps/site/src/waitlist';
import { RECORDED_PATH, type RecordedRequest, UPSTREAM_ONLY_HEADERS } from './fake-rybbit';

/**
 * merkur.sh as production serves it: the built pages and assets from the
 * compiled static server, `/analytics/*` proxied to a fake Rybbit upstream
 * (`tests/e2e/start-site.ts`). `bun run test:e2e:site` builds both first,
 * against the production origins and the site id `e2e-site`.
 *
 * The app's origin is production's, `https://app.merkur.sh`, and nothing here
 * reaches it: the waitlist posts are answered by `page.route`, and the one test
 * that follows a Start-free link lands on a page `page.route` answers.
 */

// Playwright runs from the repository root.
const ROOT = process.cwd();
const SITE_ORIGIN = 'https://merkur.sh';
const APP_ORIGIN = 'https://app.merkur.sh';
const SITE_ID = 'e2e-site';
const RYBBIT = `http://127.0.0.1:${process.env.PW_SITE_RYBBIT_PORT}`;
const NO_SUCH_PAGE = '/no-such-page';
const DESK = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
const PHONE_DEVICE = { deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

/**
 * What a first paint waits on, in bytes on the wire: the document with its
 * inlined stylesheet, and the one script it names. The shaders, their masks
 * and everything that moves are asked for after `load` and are not part of it.
 */
const FIRST_PAINT_BUDGET = 40_000;
/** What only the pictures and the motion fetch; none of it may be asked for before `load`. */
const AFTER_LOAD_RESOURCE =
  /\/assets\/(?:(?:motion|client|worker)-[^/]+\.js|(?:icon|word)-[^/]+\.webp)$/;

const REVALIDATED = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REDIRECTED = 'public, max-age=3600';

function readManifest(): SiteManifest {
  return parseSiteManifest(
    JSON.parse(readFileSync(path.join(ROOT, 'apps/site/dist/site-manifest.json'), 'utf8')),
  );
}

function manifestPath(manifest: SiteManifest, pattern: RegExp): string {
  const entry = manifest.files.find((file) => pattern.test(file.path));
  if (entry === undefined) throw new Error(`the manifest lists no ${pattern}`);
  return entry.path;
}

/** The fields every response of the site carries, whatever it is. */
function securityHeaders(manifest: SiteManifest): Record<string, string> {
  const styles = manifest.styleHashes.map((hash) => `'${hash}'`).join(' ');
  return {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self'",
      `connect-src 'self' ${APP_ORIGIN}`,
      "img-src 'self'",
      "font-src 'self'",
      `style-src ${styles}`,
      `form-action ${APP_ORIGIN} 'self'`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    vary: 'Accept-Encoding',
  };
}

function expectHeaders(response: APIResponse, expected: Record<string, string | undefined>): void {
  const headers = response.headers();
  for (const [name, value] of Object.entries(expected)) {
    expect(headers[name], `${response.url()} ${name}`).toBe(value);
  }
  expect(headers['set-cookie'], `${response.url()} set-cookie`).toBeUndefined();
}

async function recorded(): Promise<RecordedRequest[]> {
  const response = await fetch(`${RYBBIT}${RECORDED_PATH}`);
  return (await response.json()) as RecordedRequest[];
}

/** An event a control names: what Rybbit calls it, and the properties a click sends with it. */
type NamedEvent = readonly [name: string, properties: Readonly<Record<string, string>>];

/** The header every page carries: its links to the page's sections and the blog, and the way in. */
const HEADER_EVENTS: readonly NamedEvent[] = [
  ['nav_click', { to: 'product' }],
  ['nav_click', { to: 'security' }],
  ['nav_click', { to: 'source' }],
  ['nav_click', { to: 'blog' }],
  ['nav_click', { to: 'boxes' }],
  ['nav_click', { to: 'faq' }],
  ['cta_sign_in', {}],
];
const FOOTER_EVENTS: readonly NamedEvent[] = [['cta_github', { section: 'footer' }]];
const BLOG_FOOTER_EVENTS: readonly NamedEvent[] = [['cta_github', { section: 'blog-footer' }]];

/**
 * Every event each page names once it has loaded, in document order
 * (`.claude/rules/site.md`, "Analytics"). The waitlist's button is not here: it
 * names `cta_waitlist_submit` only while its field holds an address.
 */
const PAGE_EVENTS = {
  '/': [
    ...HEADER_EVENTS,
    ['cta_start_free', { section: 'hero' }],
    ['cta_how_it_works', {}],
    ['security_tab', { tab: 'encrypted' }],
    ['security_tab', { tab: 'hardware' }],
    ['security_tab', { tab: 'server' }],
    ['cta_security_model', {}],
    ['cta_github', { section: 'source' }],
    ['faq_open', { question: 'what-do-i-install' }],
    ['faq_open', { question: 'which-browsers-work' }],
    ['faq_open', { question: 'can-merkur-see-my-terminal' }],
    ['faq_open', { question: 'blocked-direct-connection' }],
    ['faq_open', { question: 'does-it-work-on-a-phone' }],
    ['faq_open', { question: 'what-does-it-cost' }],
    ['cta_start_free', { section: 'closing' }],
    ['cta_install_copy', {}],
    ...FOOTER_EVENTS,
  ],
  '/security': [
    ...HEADER_EVENTS,
    ['cta_start_free', { section: 'security-page' }],
    ...FOOTER_EVENTS,
  ],
  '/privacy': [...HEADER_EVENTS, ...FOOTER_EVENTS],
  '/terms': [...HEADER_EVENTS, ...FOOTER_EVENTS],
  [NO_SUCH_PAGE]: [...HEADER_EVENTS, ['cta_open_app', {}], ...FOOTER_EVENTS],
  '/blog': [...HEADER_EVENTS, ...BLOG_FOOTER_EVENTS],
  '/blog/authorship': [...HEADER_EVENTS, ...BLOG_FOOTER_EVENTS],
  '/blog/typing-ahead': [
    ...HEADER_EVENTS,
    ['cta_github', { section: 'post' }],
    ...BLOG_FOOTER_EVENTS,
  ],
} satisfies Readonly<Record<string, readonly NamedEvent[]>>;

/** What Rybbit's script would send for a click on each control of the page, in document order. */
function namedEvents(page: Page): Promise<NamedEvent[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-rybbit-event]')].map(
      (element): [string, Record<string, string>] => [
        element.getAttribute('data-rybbit-event') ?? '',
        Object.fromEntries(
          [...element.attributes].flatMap((attribute) =>
            attribute.name.startsWith('data-rybbit-prop-')
              ? [[attribute.name.slice('data-rybbit-prop-'.length), attribute.value]]
              : [],
          ),
        ),
      ],
    ),
  );
}

/** Console errors, uncaught exceptions and CSP violations, from the first byte. */
async function watchFaults(page: Page): Promise<() => Promise<string[]>> {
  const faults: string[] = [];
  page.on('console', (message) => {
    // The browser logs a 404 for the document itself; that answer is the page under test.
    if (message.type() === 'error' && message.location().url !== page.url()) {
      faults.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => faults.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, '__cspViolations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return async () => {
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    return [...faults, ...violations.map((violation) => `csp: ${violation}`)];
  };
}

/**
 * Counts the animation frames the page itself asks for, from the first byte, so
 * a loop started at any point is seen. The render worker's frames are its own.
 */
async function countFrames(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const state = { frames: 0 };
    Object.defineProperty(window, '__frames', { value: state });
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      request((time) => {
        state.frames += 1;
        callback(time);
      });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __frames: { frames: number } }).__frames.frames);
}

/** Settles once the page has loaded, painted, and started everything that moves. */
async function motionStarted(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-faces', 'all');
  await expect(page.locator('script[src="/analytics/script.js"]')).toHaveCount(1);
}

test.describe('headers', () => {
  test('every page, a hashed script, a font, a picture, the 404 page and the health check', async ({
    request,
  }) => {
    const manifest = readManifest();
    const security = securityHeaders(manifest);
    const br = { 'accept-encoding': 'br' };

    for (const page of Object.keys(manifest.routes)) {
      const response = await request.get(page, { headers: br });
      expect(response.status(), page).toBe(200);
      expectHeaders(response, {
        ...security,
        'content-type': 'text/html; charset=utf-8',
        'cache-control': REVALIDATED,
        'content-encoding': 'br',
      });
      expect(response.headers().etag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    }

    const identity = await request.get('/', { headers: { 'accept-encoding': 'identity' } });
    expectHeaders(identity, { 'content-encoding': undefined, 'cache-control': REVALIDATED });

    const script = await request.get(manifestPath(manifest, /^\/assets\/main-[^/]+\.js$/), {
      headers: br,
    });
    expect(script.status()).toBe(200);
    expectHeaders(script, {
      ...security,
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': IMMUTABLE,
      'content-encoding': 'br',
    });

    // A dedicated worker takes its policy from its own script's response.
    const worker = await request.get(manifestPath(manifest, /^\/assets\/worker-[^/]+\.js$/), {
      headers: br,
    });
    expect(worker.status()).toBe(200);
    expectHeaders(worker, { ...security, 'cache-control': IMMUTABLE, 'content-encoding': 'br' });

    for (const [pattern, contentType] of [
      [/^\/assets\/Geist-latin-[^/]+\.woff2$/, 'font/woff2'],
      [/^\/assets\/boxes-wide-[^/]+\.webp$/, 'image/webp'],
    ] as const) {
      const response = await request.get(manifestPath(manifest, pattern), { headers: br });
      expect(response.status()).toBe(200);
      // Already compressed; the build never gives either a brotli sibling.
      expectHeaders(response, {
        ...security,
        'content-type': contentType,
        'cache-control': IMMUTABLE,
        'content-encoding': undefined,
      });
    }

    const missing = await request.get(NO_SUCH_PAGE, { headers: br });
    expect(missing.status()).toBe(404);
    expectHeaders(missing, {
      ...security,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=60',
      'content-encoding': 'br',
    });

    const health = await request.get('/healthz');
    expect(health.status()).toBe(204);
    expectHeaders(health, { ...security, 'cache-control': 'no-store' });
  });

  test('the installer address answers with the app’s own, for curl to follow', async ({
    request,
  }) => {
    const response = await request.get('/install', { maxRedirects: 0 });

    expect(response.status()).toBe(308);
    expectHeaders(response, {
      ...securityHeaders(readManifest()),
      location: `${APP_ORIGIN}/install`,
      'cache-control': REDIRECTED,
    });
    expect((await request.post('/install', { maxRedirects: 0 })).status()).toBe(405);
  });
});

test.describe('what a crawler reads', () => {
  test('robots names the sitemap, and the sitemap lists every page and nothing else', async ({
    request,
  }) => {
    const manifest = readManifest();

    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    const listed = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => match[1],
    );
    expect(listed.sort()).toEqual(
      Object.keys(manifest.routes)
        .map((route) => `${SITE_ORIGIN}${route}`)
        .sort(),
    );
  });

  test('llms.txt is the home page’s summary and questions, and links every other page', async ({
    request,
  }) => {
    const manifest = readManifest();

    const response = await request.get('/llms.txt', { headers: { 'accept-encoding': 'br' } });
    expect(response.status()).toBe(200);
    expectHeaders(response, {
      ...securityHeaders(manifest),
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': REVALIDATED,
      'content-encoding': 'br',
    });
    const text = await response.text();
    expect(text.startsWith('# Merkur\n\n> A terminal for your Mac and Linux machines')).toBe(true);
    expect(text).toContain('- **What do I install?** A small daemon');
    expect(text).toContain(`- App: ${APP_ORIGIN}/`);
    // Nothing a page leaves for the build to fill reaches the file unfilled.
    expect(text).not.toContain('[[');
    // The repository is linked too; only the site's own addresses are compared.
    const linked = [...text.matchAll(/\]\(([^)]+)\)/g)].flatMap((match) =>
      match[1]?.startsWith(`${SITE_ORIGIN}/`) ? [match[1]] : [],
    );
    expect(linked.sort()).toEqual(
      Object.keys(manifest.routes)
        .filter((route) => route !== '/')
        .map((route) => `${SITE_ORIGIN}${route}`)
        .sort(),
    );
  });

  test.describe('in the markup alone', () => {
    test.use({ javaScriptEnabled: false });

    for (const route of ['/', '/security', '/privacy', '/terms']) {
      test(`${route} has one heading, its own address and a description`, async ({ page }) => {
        await page.goto(route);

        await expect(page.locator('h1')).toHaveCount(1);
        await expect(page.locator('h1')).toBeVisible();
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          'href',
          `${SITE_ORIGIN}${route}`,
        );
        expect((await page.title()).length).toBeGreaterThan(10);
        const description = await page.locator('meta[name="description"]').getAttribute('content');
        expect(description?.length ?? 0).toBeGreaterThan(50);
        await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
          'content',
          `${SITE_ORIGIN}${route}`,
        );
        await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
      });
    }

    test('the page nobody asked for is kept out of the index', async ({ page }) => {
      await page.goto(NO_SUCH_PAGE);

      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
      // What the worker draws is in the markup: the number, the line and the orb held on it.
      await expect(page.locator('[data-liquid="lost"]')).toHaveText('404');
      const sky = page.locator('[data-retrograde]');
      await expect(sky.locator('[data-retrograde-line] path')).toHaveAttribute('d', /^M0 1H/);
      await expect
        .poll(() => sky.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
      await expect(sky.locator('[data-retrograde-word]')).toBeVisible();
    });

    test('the home page says everything without script: copy, pictures and every answer', async ({
      page,
    }) => {
      await page.setViewportSize(DESK);
      await page.goto('/');

      await expect(page.locator('h1')).toContainText('Your terminal');
      // Every section a visitor can scroll to has its heading in the markup.
      expect(await page.locator('h2').count()).toBeGreaterThanOrEqual(6);
      // The figures a shader draws over are words in the page.
      await expect(page.locator('[data-liquid="one"]')).toHaveText('1');
      await expect(page.locator('[data-liquid="agpl"]')).toHaveText('AGPL-3.0');
      // The pictures a worker draws are stills until it does.
      for (const still of await page.locator('picture.still img').all()) {
        await still.scrollIntoViewIfNeeded();
        await expect
          .poll(() => still.evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBeGreaterThan(0);
      }
      const questions = page.locator('details[data-question]');
      expect(await questions.count()).toBeGreaterThanOrEqual(6);
      for (const question of await questions.all()) {
        expect((await question.textContent())?.trim().length ?? 0).toBeGreaterThan(80);
      }
    });

    test('the structured data names the product and repeats the page’s own questions', async ({
      page,
    }) => {
      await page.goto('/');

      const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
      expect(blocks.length).toBeGreaterThan(0);
      const nodes = blocks.flatMap((block) => {
        const parsed = JSON.parse(block) as Record<string, unknown>;
        const graph = parsed['@graph'];
        return Array.isArray(graph) ? (graph as Record<string, unknown>[]) : [parsed];
      });
      const types = nodes.map((node) => node['@type']);
      for (const type of ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']) {
        expect(types).toContain(type);
      }
      const faq = nodes.find((node) => node['@type'] === 'FAQPage');
      const entities = (faq?.mainEntity ?? []) as { name: string }[];
      const asked = entities.map((entity) => entity.name);
      expect(asked.length).toBeGreaterThan(0);
      // The question's own words; the mark beside them is not part of it.
      const shown = await page.locator('details[data-question] summary > span').allTextContents();
      expect(asked).toEqual(shown.map((text) => text.trim()));
    });
  });
});

test.describe('analytics', () => {
  test('the proxy serves Rybbit’s script and forwards a beacon with the visitor address and no cookie', async ({
    request,
  }) => {
    const manifest = readManifest();
    const script = await request.get('/analytics/script.js');
    expect(script.status()).toBe(200);
    // Rybbit's own policy fields never become the site's.
    expectHeaders(script, {
      ...securityHeaders(manifest),
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': undefined,
    });
    expect(UPSTREAM_ONLY_HEADERS['strict-transport-security']).not.toBe(
      script.headers()['strict-transport-security'],
    );

    const marker = `beacon-${Date.now()}`;
    const track = await request.post('/analytics/track', {
      headers: {
        'content-type': 'application/json',
        cookie: 'session=must-not-leave',
        'user-agent': 'merkur-site-e2e',
        // The client's own claim, then the one trusted proxy's entry.
        'x-forwarded-for': '203.0.113.7, 198.51.100.23',
      },
      data: { marker },
    });
    expect(track.status()).toBe(200);
    expectHeaders(track, { 'cache-control': 'no-cache' });

    const forwarded = (await recorded()).find((entry) => entry.body.includes(marker));
    expect(forwarded).toMatchObject({ method: 'POST', path: '/api/track' });
    expect(forwarded?.headers['x-forwarded-for']).toBe('198.51.100.23');
    expect(forwarded?.headers['user-agent']).toBe('merkur-site-e2e');
    expect(forwarded?.headers.cookie).toBeUndefined();
  });

  test('the page’s own pageview reaches Rybbit through the site origin, and the site keeps nothing else', async ({
    browser,
    baseURL,
  }) => {
    // Each beacon carries the browser's own user agent, so this visit's are its own.
    const marker = `merkur-site-e2e-${Date.now()}`;
    const context = await browser.newContext({ baseURL, userAgent: marker, viewport: DESK });
    const page = await context.newPage();
    const elsewhere: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== baseURL && url.protocol !== 'data:' && url.protocol !== 'blob:') {
        elsewhere.push(request.url());
      }
    });
    await page.route(`${APP_ORIGIN}/`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app' }),
    );
    await page.goto('/?utm_source=e2e');
    const ours = async () =>
      (await recorded()).filter(
        (entry) => entry.path === '/api/track' && entry.headers['user-agent'] === marker,
      );
    await expect.poll(async () => (await ours()).length).toBeGreaterThan(0);
    const beacon = (await ours())[0];
    // No proxy in front: the visitor is the socket peer.
    expect(beacon?.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(beacon?.headers.cookie).toBeUndefined();
    // The site answers the tracking config itself; Rybbit's own, which fails here, is never read.
    expect(
      (await recorded()).some((entry) => entry.path.startsWith('/api/site/tracking-config/')),
    ).toBe(false);
    await expect(page.locator('script[src="/analytics/script.js"]')).toHaveAttribute(
      'data-site-id',
      SITE_ID,
    );
    expect(await context.cookies()).toEqual([]);

    // Nothing of Rybbit's, and nothing that only moves, is asked for before the window's load event.
    const timing = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (navigation === undefined) throw new Error('no navigation entry');
      return {
        loadStart: navigation.loadEventStart,
        resources: (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map(
          (entry) => ({ path: new URL(entry.name).pathname, start: entry.startTime }),
        ),
      };
    });
    const late = timing.resources.filter(
      (entry) => entry.path.startsWith('/analytics/') || AFTER_LOAD_RESOURCE.test(entry.path),
    );
    expect(late.length).toBeGreaterThan(0);
    for (const entry of late) {
      expect(entry.start, entry.path).toBeGreaterThanOrEqual(timing.loadStart);
    }

    // What the privacy policy says the browser keeps: Rybbit's visitor id, and nothing else.
    const storage = await page.evaluate(async () => ({
      local: Object.keys(localStorage).sort(),
      session: Object.keys(sessionStorage),
      cookie: document.cookie,
      databases: (await indexedDB.databases()).map((database) => database.name),
    }));
    expect(storage).toEqual({
      local: ['rybbit-visitor-id'],
      session: [],
      cookie: '',
      databases: [],
    });
    // Fonts, pictures, scripts and beacons all come from the site's own origin.
    expect(elsewhere).toEqual([]);

    // What the privacy policy says is never recorded: the address's query string, and a
    // link followed off the site.
    await page.locator('a[data-rybbit-event="cta_start_free"]').first().click();
    await page.waitForURL(`${APP_ORIGIN}/`);
    const bodies = (await ours()).map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
    expect(bodies.filter((body) => body.type === 'outbound')).toEqual([]);
    expect(bodies.filter((body) => body.querystring !== '')).toEqual([]);
    expect(
      bodies.filter((body) => body.type === 'custom_event').map((body) => body.event_name),
    ).toEqual(['cta_start_free']);
    await context.close();
  });

  for (const [route, events] of Object.entries(PAGE_EVENTS)) {
    test(`${route} names its events, and no other`, async ({ page }) => {
      await page.goto(route);

      expect(await namedEvents(page)).toEqual(events);
    });
  }

  test('a click on a control that names an event sends it once, with its properties', async ({
    browser,
    baseURL,
  }) => {
    const marker = `merkur-site-e2e-clicks-${Date.now()}`;
    const context = await browser.newContext({ baseURL, userAgent: marker, viewport: DESK });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const sent = async () =>
      (await recorded()).filter(
        (entry) => entry.path === '/api/track' && entry.headers['user-agent'] === marker,
      );
    await page.goto('/');
    // The pageview is the script's last step, so by then it listens for clicks.
    await expect.poll(async () => (await sent()).length).toBeGreaterThan(0);

    await page.locator('[data-sec-tab="1"]').click();
    const summary = page.locator('#what-do-i-install summary');
    await summary.click();
    // Open now, so the click that closes it names nothing.
    await expect(summary).not.toHaveAttribute('data-rybbit-event', /./);
    await summary.click();
    await page.locator('.closing-actions [data-copy]').click();
    // A link to a section of this page: the address changes and the page stays.
    await page.locator('header a[href="/#faq"]').click();
    await page.waitForURL(/#faq$/);

    // Each beacon whole, as the stand-in's script posts it from this page.
    const visit = { site_id: SITE_ID, pathname: '/', querystring: '' };
    const event = ([name, properties]: NamedEvent): string =>
      JSON.stringify({
        ...visit,
        type: 'custom_event',
        event_name: name,
        properties: JSON.stringify(properties),
      });
    const expected = [
      JSON.stringify({ ...visit, type: 'pageview' }),
      event(['security_tab', { tab: 'hardware' }]),
      event(['faq_open', { question: 'what-do-i-install' }]),
      event(['cta_install_copy', {}]),
      event(['nav_click', { to: 'faq' }]),
    ].sort();
    const bodies = async () => (await sent()).map((entry) => entry.body).sort();
    await expect.poll(bodies).toEqual(expected);
    // Nothing follows them: each click was counted once.
    await page.waitForTimeout(300);
    expect(await bodies()).toEqual(expected);
    await context.close();
  });
});

test.describe('waitlist', () => {
  test.use({ viewport: DESK });

  const cases = [
    { name: '204', outcome: 'done', answer: { status: 204 } },
    {
      name: 'a refused address',
      outcome: 'refused',
      answer: { status: 400, body: '{"error":"email_refused"}' },
    },
    { name: 'the rate limit', outcome: 'limited', answer: { status: 429 } },
    { name: 'a network failure', outcome: 'unreached', answer: null },
  ] as const;

  for (const { name, outcome, answer } of cases) {
    test(`says what happened on ${name}`, async ({ page, baseURL }) => {
      const posted: string[] = [];
      await page.route(`${APP_ORIGIN}/api/box-waitlist`, async (route) => {
        posted.push(`${route.request().method()} ${route.request().postData()}`);
        expect(route.request().headers().cookie).toBeUndefined();
        if (answer === null) {
          await route.abort('failed');
          return;
        }
        await route.fulfill({
          status: answer.status,
          headers: {
            'access-control-allow-origin': baseURL ?? '',
            'content-type': 'application/json',
          },
          body: 'body' in answer ? answer.body : '',
        });
      });
      await page.goto('/#waitlist');
      const form = page.locator('form[data-waitlist]');
      const field = form.locator('input[name="email"]');
      const status = form.locator('[role="status"]');
      const submit = form.locator('[type="submit"]');
      await expect(status).toHaveText(WAITLIST_MESSAGES.idle);

      await field.fill('not-an-address');
      // Rybbit counts the click, so only a click that will send names the event.
      await expect(submit).not.toHaveAttribute('data-rybbit-event', /./);
      await submit.click();
      await expect(status).toHaveText(WAITLIST_MESSAGES.invalid);
      expect(posted).toEqual([]);

      await field.fill('  visitor@example.com ');
      await expect(submit).toHaveAttribute('data-rybbit-event', 'cta_waitlist_submit');
      await submit.click();
      await expect(status).toHaveText(WAITLIST_MESSAGES[outcome]);
      expect(posted).toEqual(['POST email=visitor%40example.com']);
      // The button kept its focus through the send.
      await expect(submit).toBeFocused();
      await expect(field).toHaveAttribute('aria-invalid', outcome === 'done' ? 'false' : 'true');
      if (outcome === 'done') {
        // On the list: the form has nothing left to send.
        await expect(submit).toHaveText('On the list');
        await expect(submit).toHaveAttribute('aria-disabled', 'true');
        await expect(submit).not.toHaveAttribute('data-rybbit-event', /./);
        // Forced: the button says it is off, which is what a click would wait out.
        await submit.click({ force: true });
        expect(posted).toHaveLength(1);
      } else {
        await expect(submit).toHaveAttribute('aria-disabled', 'false');
      }
    });
  }
});

test.describe('waitlist without script', () => {
  test.use({ viewport: DESK, javaScriptEnabled: false });

  test('the app sends the posted form back to the line that says the address was taken', async ({
    page,
    baseURL,
  }) => {
    await page.route(`${APP_ORIGIN}/api/box-waitlist`, (route) =>
      route.fulfill({ status: 303, headers: { location: `${baseURL}/#waitlist-done` } }),
    );
    await page.goto('/#waitlist');
    const form = page.locator('form[data-waitlist]');
    await expect(page.locator('#waitlist-done')).toBeHidden();
    await form.locator('input[name="email"]').fill('visitor@example.com');
    await form.locator('[type="submit"]').click();
    await page.waitForURL(/#waitlist-done$/);
    await expect(page.locator('#waitlist-done')).toBeVisible();
    await expect(form.locator('[role="status"]')).toBeHidden();
  });
});

for (const { name, viewport, device } of [
  { name: '1440', viewport: DESK, device: {} },
  { name: '390', viewport: PHONE, device: PHONE_DEVICE },
] as const) {
  test.describe(`at ${name}`, () => {
    test.use({ viewport, ...device });

    for (const at of ['/', '/security', '/privacy', '/terms', NO_SUCH_PAGE]) {
      test(`${at} has no fault and no sideways scroll, top to bottom`, async ({ page }) => {
        const faults = await watchFaults(page);
        await page.goto(at);
        await motionStarted(page);
        // Bring every section on screen once, so each picture and scene starts.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0; y < height; y += viewport.height) {
          await page.evaluate((top) => window.scrollTo(0, top), y);
          await page.waitForTimeout(120);
        }
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        // The page keeps a scrollbar's room, which a hidden scrollbar leaves out of what scrolls.
        expect(widths.scroll).toBeLessThanOrEqual(widths.client);
        expect(await faults()).toEqual([]);
      });
    }

    test('the first paint is within its budget, and nothing that moves is in it', async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForLoadState('load');
      const before = await page.evaluate(() => {
        const navigation = performance.getEntriesByType(
          'navigation',
        )[0] as PerformanceNavigationTiming;
        return {
          document: navigation.transferSize,
          resources: (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
            .filter((entry) => entry.startTime < navigation.loadEventStart)
            .map((entry) => ({
              path: new URL(entry.name).pathname,
              kind: entry.initiatorType,
              bytes: entry.transferSize,
            })),
        };
      });
      expect(before.resources.filter((entry) => AFTER_LOAD_RESOURCE.test(entry.path))).toEqual([]);
      expect(before.resources.filter((entry) => entry.path.startsWith('/analytics/'))).toEqual([]);
      const scripts = before.resources.filter((entry) => entry.path.endsWith('.js'));
      const firstPaint = before.document + scripts.reduce((sum, entry) => sum + entry.bytes, 0);
      expect(firstPaint).toBeGreaterThan(0);
      expect(firstPaint).toBeLessThanOrEqual(FIRST_PAINT_BUDGET);
    });

    test('the headline is the largest paint, and the first frame has it', async ({ page }) => {
      await page.goto('/');
      // A headline that rises from nothing is reported when its animation ends,
      // so the paints are read once it has, and a frame has followed.
      const paints = await page.evaluate(async () => {
        const headline = document.querySelector('h1');
        if (headline === null) throw new Error('no headline');
        await Promise.all(headline.getAnimations().map((animation) => animation.finished));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const largest = await new Promise<PerformanceEntry | undefined>((resolve) => {
          new PerformanceObserver((list, observer) => {
            observer.disconnect();
            resolve(list.getEntries().at(-1));
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        });
        return {
          first: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
          largest: largest?.startTime,
          element:
            largest !== undefined && 'element' in largest && largest.element instanceof Element
              ? largest.element.tagName
              : undefined,
        };
      });
      expect(paints.element).toBe('H1');
      expect(paints.first).toBeGreaterThan(0);
      expect(paints.largest).toBe(paints.first);
    });
  });
}

test.describe('what moves', () => {
  test.use({ viewport: DESK });

  test('one worker draws every picture, and the page itself asks for no frames at rest', async ({
    page,
  }) => {
    const frames = await countFrames(page);
    await page.goto('/');
    await motionStarted(page);

    // The orb's still gives way to the worker's canvas once it has drawn.
    await expect(page.locator('header canvas').first()).toBeVisible();
    await expect.poll(() => page.workers().length).toBe(1);

    await page.locator('#boxes').scrollIntoViewIfNeeded();
    await expect(page.locator('#boxes [data-drawn]')).toHaveCount(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);

    // At rest at the top of the page: the hero plays on timers and the
    // compositor, the worker owns the only frame loop.
    const before = await frames();
    await page.waitForTimeout(1_000);
    expect((await frames()) - before).toBe(0);
    expect(page.workers()).toHaveLength(1);
  });

  test('on the page nobody asked for the worker takes the orb along its line, and the page asks for no frames', async ({
    page,
  }) => {
    const frames = await countFrames(page);
    const faults = await watchFaults(page);
    await page.goto(NO_SUCH_PAGE);
    await motionStarted(page);

    // The canvas takes the place of the orb the still holds at the top of the loop.
    const sky = page.locator('[data-retrograde]');
    await expect(sky).toHaveAttribute('data-drawn', '');
    await expect(sky.locator('img')).toBeHidden();
    await expect(page.locator('[data-liquid="lost"] canvas')).toBeVisible();
    await expect.poll(() => page.workers().length).toBe(1);

    // The word goes when the orb sets out from the edge again, and is back once it turns.
    const word = sky.locator('[data-retrograde-word]');
    await expect(word).toHaveCSS('opacity', '0');
    await expect(word).toHaveCSS('opacity', '1');

    const before = await frames();
    await page.waitForTimeout(1_000);
    expect((await frames()) - before).toBe(0);
    expect(await faults()).toEqual([]);
  });

  test('a reader who asked for reduced motion finds the orb held at the top of its loop', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(NO_SUCH_PAGE);
    await motionStarted(page);
    await page.waitForTimeout(600);

    expect(page.workers()).toEqual([]);
    const sky = page.locator('[data-retrograde]');
    await expect(sky).not.toHaveAttribute('data-drawn', /.*/);
    await expect(sky.locator('img')).toBeVisible();
    await expect(sky.locator('[data-retrograde-word]')).toHaveCSS('opacity', '1');
  });

  test('the pictures follow the layout when the window takes a new width', async ({ page }) => {
    const faults = await watchFaults(page);
    await page.goto('/');
    await motionStarted(page);
    const figure = page.locator('[data-liquid="one"]');
    await figure.scrollIntoViewIfNeeded();
    const word = figure.locator('canvas');
    await expect(word).toBeVisible();
    const width = () => word.evaluate((canvas) => canvas.getBoundingClientRect().width);
    const wide = await width();

    await page.setViewportSize(PHONE);
    // The figure is set smaller on a phone, and the canvas over it takes that size.
    await expect.poll(width).toBeLessThan(wide);
    await expect(figure).toHaveAttribute('data-drawn', '');
    await page.locator('#boxes').scrollIntoViewIfNeeded();
    await expect(page.locator('#boxes [data-drawn]')).toHaveCount(1);
    const fills = await page.locator('#boxes canvas').evaluate((canvas) => {
      const box = canvas.getBoundingClientRect();
      const parent = canvas.parentElement?.getBoundingClientRect();
      return parent !== undefined && Math.abs(box.width - parent.width) < 1;
    });
    expect(fills).toBe(true);
    expect(page.workers()).toHaveLength(1);
    expect(await faults()).toEqual([]);
  });

  test('a reader who asked for reduced motion gets the page at rest, with its stills', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const faults = await watchFaults(page);
    await page.goto('/');
    await motionStarted(page);
    await page.waitForTimeout(600);

    expect(page.workers()).toEqual([]);
    await expect(page.locator('img[data-orb]').first()).toBeVisible();
    await expect(page.locator('[data-drawn]')).toHaveCount(0);
    // The finished session, not its first moment.
    await expect(page.locator('[data-term]').first()).toHaveAttribute('data-s', '5');
    // The controls still work: a second security pane opens when asked.
    await page.locator('#boxes').scrollIntoViewIfNeeded();
    const tabs = page.locator('[data-sec] [role="tab"]');
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    expect(await faults()).toEqual([]);
  });

  test('a question opens on a click and closes on the next, and settles as a plain details', async ({
    page,
  }) => {
    const faults = await watchFaults(page);
    await page.goto('/');
    await motionStarted(page);
    const question = page.locator('#what-do-i-install');
    await question.scrollIntoViewIfNeeded();
    const summary = question.locator('summary');
    const isOpen = () => question.evaluate((details: HTMLDetailsElement) => details.open);
    const settled = () =>
      question.evaluate(
        (details: HTMLDetailsElement) =>
          details.style.height === '' && details.style.overflow === '',
      );

    await summary.click();
    await expect.poll(isOpen).toBe(true);
    await expect(question.locator('p')).toBeVisible();
    await expect.poll(settled).toBe(true);

    // Shut only once the close has played, and nothing of the spring is left on it.
    await summary.click();
    await expect.poll(isOpen).toBe(false);
    await expect.poll(settled).toBe(true);
    await expect(question).not.toHaveAttribute('data-closing', /.*/);

    // Clicks faster than the spring end where the last one pointed.
    for (let click = 0; click < 5; click += 1) await summary.click();
    await expect.poll(isOpen).toBe(true);
    await expect.poll(settled).toBe(true);
    expect(await faults()).toEqual([]);
  });

  test('copying the install command says so and moves nothing beside it', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await motionStarted(page);
    const row = page.locator('.closing-actions');
    await row.scrollIntoViewIfNeeded();
    const copy = row.locator('[data-copy]');
    const places = () =>
      row.evaluate((element) =>
        [...element.querySelectorAll('.btn-site, .cmd, [data-copy]')].map((part) => {
          const box = part.getBoundingClientRect();
          return [Math.round(box.left), Math.round(box.width)];
        }),
      );
    const before = await places();

    await copy.click();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'curl -fsSL merkur.sh/install | sh',
    );
    // Its press has sprung back before the row is measured again.
    await expect
      .poll(() => copy.evaluate((button) => getComputedStyle(button).transform))
      .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    expect(await places()).toEqual(before);
    await expect(copy).toHaveText('Copy');
    expect(await places()).toEqual(before);
  });

  test('a question named by the address opens on its answer', async ({ page }) => {
    await page.goto('/#what-does-it-cost');

    const question = page.locator('#what-does-it-cost');
    await expect(question).toHaveAttribute('open', '');
    // Opened by the address, not by a click, so it names no event to count.
    await expect(question.locator('summary')).not.toHaveAttribute('data-rybbit-event', /./);
  });
});
