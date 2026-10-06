import { expect, type Page, test } from '@playwright/test';

/**
 * The blog of merkur.sh, as the compiled static server serves it
 * (`playwright.site.config.mjs`, `bun run test:e2e:site`). The build under
 * test has the blog's own pages (`apps/site/blog`: the index and the authorship
 * policy) and the harness's two posts (`apps/site/fixtures/blog`,
 * `MERKUR_SITE_BLOG_FIXTURES=1`): one with every block and three figures, and
 * one with no figure, so a post has a neighbour and the index has a row.
 *
 * What is held here is how the blog is built, whatever it says: a post reads
 * whole without script, a figure is a still until it nears the viewport and
 * the same figure after, and none of it reaches the landing page.
 */

const POST = '/blog/every-block';
const ESSAY = '/blog/typing-ahead';
const INDEX = '/blog';
const POLICY = '/blog/authorship';
const DESK = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
const PHONE_DEVICE = { deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;

/** What only a figure fetches: Solid, the module that mounts it, and the figures themselves. */
const FIGURE_RESOURCE = /\/assets\/(?:web|mount|reconnect|rows|parity|lines|terminal)-[^/]+\.js$/;
/** What only the blog's pages name, besides their scripts. */
const BLOG_RESOURCE = /\/assets\/(?:Literata[^/]*\.woff2|icon-noai-[^/]+\.webp)$/;

/** Every script the landing page fetches: its entry, what moves it, and the two that draw its pictures. */
const LANDING_SCRIPT = /^\/assets\/(?:main|motion|client|worker)-[^/]+\.js$/;

/** How a page was revealed: cut to (`null`), or carried into under these transition names. */
interface Reveal {
  readonly path: string;
  readonly names: readonly string[] | null;
}

/** Console errors, uncaught exceptions and CSP violations, from the first byte. */
async function watchFaults(page: Page): Promise<() => Promise<string[]>> {
  const faults: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(`console: ${message.text()}`);
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

function watchRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (request) => paths.push(new URL(request.url()).pathname));
  return paths;
}

/** Scrolls a figure into view and waits until it has woken. */
async function wake(page: Page, number: number): Promise<void> {
  const stage = page.locator(`#fig-${number} [data-island]`);
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).not.toHaveAttribute('inert');
}

/**
 * A subtree as its elements, attributes and text, attributes in name order.
 * The same figure drawn to a string and drawn in the page orders them
 * differently, and nothing a reader sees depends on that order.
 */
function shape(root: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const attributes = [...node.attributes]
      .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
      .sort()
      .join(' ');
    return `<${node.localName} ${attributes}>${[...node.childNodes].map(walk).join('')}</${node.localName}>`;
  };
  return [...root.childNodes].map(walk).join('');
}

for (const { name, viewport, device } of [
  { name: '1440', viewport: DESK, device: {} },
  { name: '390', viewport: PHONE, device: PHONE_DEVICE },
] as const) {
  test.describe(`the blog at ${name}`, () => {
    test.use({ viewport, ...device });

    for (const at of [POST, ESSAY, INDEX, POLICY]) {
      test(`${at} has no fault and no sideways scroll, top to bottom`, async ({ page }) => {
        const faults = await watchFaults(page);
        await page.goto(at);
        await page.waitForLoadState('load');
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0; y < height; y += viewport.height) {
          await page.evaluate((top) => window.scrollTo(0, top), y);
          await page.waitForTimeout(120);
        }
        await expect(page.locator('[data-island][inert]')).toHaveCount(0);
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        // The page keeps a scrollbar's room, which a hidden scrollbar leaves out of what scrolls.
        expect(widths.scroll).toBeLessThanOrEqual(widths.client);
        expect(await faults()).toEqual([]);
      });
    }
  });
}

test.describe('a post', () => {
  test.use({ viewport: DESK });

  test.describe('without script', () => {
    test.use({ javaScriptEnabled: false });

    test('reads whole: its sections, figures as stills, notes, code and how it was made', async ({
      page,
    }) => {
      await page.goto(POST);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toContainText('Every block,');
      await expect(page.locator('h2[data-section]')).toHaveCount(5);
      await expect(page.locator('.toc-links a')).toHaveCount(5);
      await expect(page.locator('.figs-link')).toHaveCount(3);
      // A figure is in the page as a still: its first frame, and nothing to press.
      await expect(page.locator('figure.fig')).toHaveCount(3);
      await expect(page.locator('[data-island][inert]')).toHaveCount(3);
      await expect(page.locator('#fig-1 .ft-status').first()).toHaveText(
        'disconnected · lid closed',
      );
      await expect(page.locator('#fig-2 .ft-numbered')).toHaveCount(10);
      await expect(page.locator('#fig-3 .packet')).toHaveCount(30);
      await expect(page.locator('#fig-1 .fig-caption')).toContainText('Simulated.');
      await expect(page.locator('aside.note')).toHaveCount(2);
      await expect(page.locator('.code-line')).toHaveCount(9);
      await expect(page.locator('.code-line[data-marked]')).toHaveCount(1);
      await expect(page.locator('.colophon .made')).toHaveCount(3);
      // The tangent is a plain `details`: closed, and its text is in the page.
      await expect(page.locator('details.tangent')).not.toHaveAttribute('open');
      await expect(page.locator('.tangent-body')).toContainText('TCP would resend');
      // Copying takes script, so the button is not shown.
      await expect(page.locator('.code-copy')).toBeHidden();
    });
  });

  test('says what it is to a crawler: its own address, a description, the feed and a posting', async ({
    request,
  }) => {
    const html = await (await request.get(POST)).text();
    expect(html).toContain('<link rel="canonical" href="https://merkur.sh/blog/every-block">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('type="application/atom+xml"');
    const data = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html)?.[1];
    expect(JSON.parse(data ?? 'null')).toMatchObject({
      '@type': 'BlogPosting',
      headline: 'Every block, in one post.',
      datePublished: '2026-09-24',
      url: 'https://merkur.sh/blog/every-block',
    });
    // The header's link to the blog is the current one here.
    expect(html).toContain(
      '<a href="/blog" data-rybbit-event="nav_click" data-rybbit-prop-to="blog" aria-current="page">Blog</a>',
    );
  });

  test('a figure’s module is fetched only when the figure nears the viewport', async ({ page }) => {
    const requests = watchRequests(page);
    await page.goto(POST);
    await page.waitForLoadState('load');
    await page.waitForTimeout(800);
    const fetched = (name: string): boolean =>
      requests.some((path) => FIGURE_RESOURCE.test(path) && path.includes(`/${name}-`));
    // At the top of the post the first figure is within a viewport of the fold;
    // the second and the third are not.
    await wake(page, 1);
    expect(fetched('reconnect')).toBe(true);
    expect(fetched('web')).toBe(true);
    expect(fetched('rows')).toBe(false);
    expect(fetched('parity')).toBe(false);
    await wake(page, 3);
    expect(fetched('parity')).toBe(true);
  });

  test('a post with no figure never fetches Solid', async ({ page }) => {
    const requests = watchRequests(page);
    await page.goto(ESSAY);
    await page.waitForLoadState('load');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(800);
    expect(requests.filter((path) => FIGURE_RESOURCE.test(path))).toEqual([]);
  });

  test('a woken figure is its still: same elements, same text, and the page does not move', async ({
    page,
    request,
  }) => {
    // At rest: the third figure plays by itself otherwise.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const served = await (await request.get(POST)).text();
    await page.goto(POST);
    const stills = await page.evaluate(
      ({ html, shapeSource }) => {
        const shapeOf = new Function(`return (${shapeSource})`)() as (root: Element) => string;
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        return [...parsed.querySelectorAll('[data-island]')].map(shapeOf);
      },
      { html: served, shapeSource: shape.toString() },
    );
    expect(stills).toHaveLength(3);
    await page.evaluate(() => {
      const state = { shift: 0 };
      Object.defineProperty(window, '__shift', { value: state });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.shift += (entry as unknown as { value: number }).value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    for (const number of [1, 2, 3]) await wake(page, number);
    const woken = await page.evaluate((shapeSource) => {
      const shapeOf = new Function(`return (${shapeSource})`)() as (root: Element) => string;
      return [...document.querySelectorAll('[data-island]')].map(shapeOf);
    }, shape.toString());
    expect(woken).toEqual(stills);
    const shift = await page.evaluate(
      () => (window as unknown as { __shift: { shift: number } }).__shift.shift,
    );
    expect(shift).toBe(0);
  });

  test('figure 1 reconnects: the screen arrives at once, the replay catches up later', async ({
    page,
  }) => {
    await page.goto(POST);
    await wake(page, 1);
    const [stream, screen] = [
      page.locator('#fig-1 .ft-status').nth(0),
      page.locator('#fig-1 .ft-status').nth(1),
    ];
    await page.locator('#fig-1').getByRole('button', { name: 'Reconnect' }).click();
    await expect(screen).toHaveText('caught up after 0.2 s · one screen, 4.0 KB');
    await expect(stream).toContainText('replaying');
    await expect(stream).toHaveText('caught up after 1 min 14 s · 18.4 MB replayed', {
      timeout: 10_000,
    });
    await page.locator('#fig-1').getByRole('button', { name: 'Reset' }).click();
    await expect(stream).toHaveText('disconnected · lid closed');
  });

  test('figure 2 takes the keyboard: a command is typed, run, and its rows are sent', async ({
    page,
  }) => {
    await page.goto(POST);
    await wake(page, 2);
    const terminal = page.locator('#fig-2').getByRole('textbox');
    await terminal.focus();
    await expect(page.locator('#fig-2 .ft-hint')).toHaveText('Esc to stop typing');
    await page.keyboard.type('git log');
    await page.keyboard.press('Enter');
    await expect(page.locator('#fig-2 .ft-rows')).toContainText('a3f9c21 proto: send scrolls');
    await expect(page.locator('#fig-2 .wire-update').first()).toHaveText(/v4190\s*shift ↑1/);
    await expect(page.locator('#fig-2 .wire-sum')).toContainText('rows sent in 8 updates');
    await page.keyboard.press('Escape');
    await expect(page.locator('#fig-2 .ft-hint')).toHaveText('click to type');
  });

  test('figure 3 loses a packet on a click, and the link stops to show it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(POST);
    await wake(page, 3);
    const first = page.locator('#fig-3 .group').first();
    await expect(first.locator('.group-fate')).toHaveText('arrived');
    await first.getByRole('button', { name: 'Lose packet 2 of group 1045' }).click();
    await expect(first.locator('.group-fate')).toHaveText('packet 2 rebuilt on arrival');
    await expect(
      first.getByRole('button', { name: 'Restore packet 2 of group 1045' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#fig-3').getByRole('button', { name: 'Play' })).toBeVisible();
  });

  test('asks for no frames at rest, and the contents follow the section being read', async ({
    page,
  }) => {
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
    await page.goto(POST);
    for (const number of [1, 2, 3]) await wake(page, number);
    await page.locator('#when-packets-go-missing').scrollIntoViewIfNeeded();
    const reading = page.locator('.toc-links a[aria-current]');
    await expect(reading).toHaveText('When packets go missing');
    // One marker travels to the section being read and comes to rest on its link.
    await expect(page.locator('.toc-links')).toHaveAttribute('data-marked', '');
    await expect
      .poll(async () => {
        const bar = await page.locator('.toc-bar').boundingBox();
        const link = await reading.boundingBox();

        return bar !== null && link !== null && Math.abs(bar.y - link.y) < 1;
      })
      .toBe(true);
    // Figure 3 plays on a timer while it is on screen; nothing asks for frames.
    await page.locator('#fig-3').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1_500);
    const frames = () =>
      page.evaluate(() => (window as unknown as { __frames: { frames: number } }).__frames.frames);
    const before = await frames();
    await page.waitForTimeout(1_500);
    expect((await frames()) - before).toBe(0);
  });

  test('a tangent opens and shuts on the spring the questions use, and lands a plain details', async ({
    page,
  }) => {
    const faults = await watchFaults(page);
    await page.goto(POST);
    // The marker is set by the module that also plays the tangents.
    await expect(page.locator('.toc-links')).toHaveAttribute('data-marked', '');
    const tangent = page.locator('details.tangent');
    await tangent.scrollIntoViewIfNeeded();
    const summary = tangent.locator('summary');
    const isOpen = () => tangent.evaluate((details: HTMLDetailsElement) => details.open);

    const settled = () =>
      tangent.evaluate(
        (details: HTMLDetailsElement) =>
          details.style.height === '' && details.style.overflow === '',
      );

    await summary.click();
    await expect.poll(isOpen).toBe(true);
    // Its height is the browser's to play: a whole animation, no frame asked for.
    expect(await tangent.evaluate((details) => details.getAnimations().length)).toBeGreaterThan(0);
    await expect(page.locator('.tangent-body')).toBeVisible();
    await expect.poll(settled).toBe(true);

    await summary.click();
    await expect.poll(isOpen).toBe(false);
    await expect.poll(settled).toBe(true);
    await expect(tangent).not.toHaveAttribute('data-closing', /.*/);
    expect(await faults()).toEqual([]);
  });

  test('copies a code block as it was written, without its line numbers', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(POST);
    const copy = page.locator('.code-copy');
    await copy.scrollIntoViewIfNeeded();
    await copy.click();
    await expect(copy).toHaveText('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.split('\n')).toHaveLength(9);
    expect(copied.startsWith('pub fn diff(grid: &Grid, seen: &RowHashes) -> Update {')).toBe(true);
    await expect(copy).toHaveText('Copy', { timeout: 3_000 });
  });
});

test.describe('the blog and the rest of the site', () => {
  test.use({ viewport: DESK });

  test('the landing page asks for nothing of the blog, top to bottom', async ({ page }) => {
    const requests = watchRequests(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += DESK.height) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(120);
    }
    expect(
      requests.filter((path) => FIGURE_RESOURCE.test(path) || BLOG_RESOURCE.test(path)),
    ).toEqual([]);
    // The blog moves with the landing page's Motion, and that added no file here.
    expect(
      requests.filter(
        (path) => path.startsWith('/assets/') && path.endsWith('.js') && !LANDING_SCRIPT.test(path),
      ),
    ).toEqual([]);
    // One script before `load`, as before the blog.
    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll('script[src]')].map(
        (script) => new URL((script as HTMLScriptElement).src).pathname,
      ),
    );
    expect(scripts.filter((path) => path.startsWith('/assets/'))).toHaveLength(1);
    const blogRules = await page.evaluate(() =>
      [...document.querySelectorAll('style')].some((sheet) =>
        /\.post-body|\.fig-stage|Literata/.test(sheet.textContent ?? ''),
      ),
    );
    expect(blogRules).toBe(false);
  });

  /**
   * Records how each page of the tab was revealed: cut to, or carried into by
   * a view transition and under which names. It outlives a navigation in the
   * tab's session storage.
   */
  async function watchReveals(page: Page): Promise<() => Promise<Reveal[]>> {
    await page.addInitScript(() => {
      window.addEventListener('pagereveal', (event) => {
        if (!(event instanceof PageRevealEvent)) return;

        const record = (names: string[] | null): void => {
          const seen: unknown = JSON.parse(sessionStorage.getItem('reveals') ?? '[]');

          sessionStorage.setItem(
            'reveals',
            JSON.stringify([
              ...(Array.isArray(seen) ? seen : []),
              { path: location.pathname, names },
            ]),
          );
        };

        const transition = event.viewTransition;

        if (transition === null) {
          record(null);

          return;
        }

        void transition.ready.then(() => {
          const GROUP = '::view-transition-group(';
          const names = new Set<string>();

          for (const animation of document.getAnimations()) {
            const pseudo =
              animation.effect instanceof KeyframeEffect ? animation.effect.pseudoElement : null;

            if (pseudo?.startsWith(GROUP) !== true) continue;

            const name = pseudo.slice(GROUP.length, -1);

            // The page itself is in every transition; what is held is what it was given beside.
            if (name !== 'root') names.add(name);
          }

          record([...names].sort());
        });
      });
    });

    return () =>
      page.evaluate((): Reveal[] => JSON.parse(sessionStorage.getItem('reveals') ?? '[]'));
  }

  test('a link carries one page into the next: the header keeps its place and a post’s title travels', async ({
    page,
  }) => {
    const faults = await watchFaults(page);
    const reveals = await watchReveals(page);
    await page.goto('/');
    await page.locator('.top-links a[href="/blog"]').click();
    await expect(page).toHaveURL(INDEX);
    // The newest post from its card, an older one from its row, and back by the page's own link.
    await page.locator(`a.latest[href="${POST}"]`).click();
    await expect(page).toHaveURL(POST);
    await page.locator('a.post-back').click();
    await expect(page).toHaveURL(INDEX);
    await page.locator(`a.row[href="${ESSAY}"]`).click();
    await expect(page).toHaveURL(ESSAY);
    await page.locator('a.lockup').click();
    await expect(page).toHaveURL('/');
    await expect.poll(reveals).toEqual([
      { path: '/', names: null },
      { path: INDEX, names: ['site-header'] },
      { path: POST, names: ['post-every-block', 'site-header'] },
      { path: INDEX, names: ['post-every-block', 'site-header'] },
      { path: ESSAY, names: ['post-typing-ahead', 'site-header'] },
      { path: '/', names: ['site-header'] },
    ]);
    expect(await faults()).toEqual([]);
  });

  for (const { name, viewport } of [
    { name: '1440', viewport: DESK },
    { name: '390', viewport: PHONE },
  ]) {
    test(`the header is one bar on every page, the footer keeps its edges, and the header stays as the page scrolls (${name})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      /** The header's box and each part's, then where the footer's first and last parts end. */
      const measure = (): Promise<string> =>
        page.evaluate(() => {
          const box = (selector: string): DOMRect => {
            const part = document.querySelector(selector);
            if (part === null) throw new Error(`no ${selector}`);
            return part.getBoundingClientRect();
          };
          const header = [
            ...document.querySelectorAll('.top, .top .lockup, .top-links a, .top-signin'),
          ].map((part) => {
            const at = part.getBoundingClientRect();
            return `${at.left},${at.top},${at.width},${at.height}`;
          });
          return [...header, box('.foot-mark').left, box('.foot-links').right].join(' ');
        });
      const places: Record<string, string> = {};
      for (const at of ['/', '/security', '/privacy', '/terms', INDEX, POST, ESSAY, POLICY]) {
        await page.goto(at);
        places[at] = await measure();
        // A page that does not scroll is as wide as one that does only while it keeps a
        // scrollbar's room, and this browser hides its scrollbars: hold the declaration.
        expect(
          await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter),
          at,
        ).toBe('stable');
        // A page no taller than the window has nothing to scroll under the header.
        const scrolls = await page.evaluate(
          () => document.documentElement.scrollHeight > window.innerHeight,
        );
        if (!scrolls) continue;
        await page.mouse.wheel(0, 600);
        await expect.poll(() => page.evaluate(() => window.scrollY), at).toBeGreaterThan(0);
        expect(await measure(), `${at}, scrolled`).toBe(places[at]);
      }
      const home = places['/'];
      for (const [at, place] of Object.entries(places)) expect(place, at).toBe(home);
    });
  }

  test('a transition name is one element’s in every page, or the browser would skip the transition', async ({
    page,
  }) => {
    for (const at of [
      '/',
      '/security',
      '/privacy',
      '/terms',
      '/no-such-page',
      INDEX,
      POST,
      ESSAY,
      POLICY,
    ]) {
      await page.goto(at);

      const names = await page.evaluate(() =>
        [...document.querySelectorAll('*')].flatMap((element) => {
          const name = getComputedStyle(element).viewTransitionName;

          return name === 'none' ? [] : [name];
        }),
      );

      expect(names.length, at).toBeGreaterThan(0);
      expect([...new Set(names)], at).toHaveLength(names.length);
    }
  });

  test('a reader who asked for reduced motion is taken to the next page at once', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reveals = await watchReveals(page);
    await page.goto('/');
    await page.locator('.top-links a[href="/blog"]').click();
    await expect(page).toHaveURL(INDEX);
    await expect.poll(reveals).toEqual([
      { path: '/', names: null },
      { path: INDEX, names: null },
    ]);
    expect(
      await page.locator('main').evaluate((main) => getComputedStyle(main).animationName),
    ).toBe('none');
  });

  test('a page’s own sheet follows the shared one: a link in a document keeps its line', async ({
    page,
  }) => {
    // The document's rule for a link weighs what the shared sheet's does, so it holds only
    // while it comes later: the page links its sheet after the script that carries the shared one.
    await page.goto('/security');
    const line = await page
      .locator('.doc-body a[href^="mailto:"]')
      .evaluate((link) => getComputedStyle(link).textDecorationLine);
    expect(line).toBe('underline');
  });

  test('the index lists the posts newest first, and the policy is where every mark leads', async ({
    page,
  }) => {
    await page.goto(INDEX);
    await expect(page.locator('.latest')).toHaveAttribute('href', POST);
    await expect(page.locator('.latest .ft-wired')).toHaveCount(1);
    await expect(page.locator('.row')).toHaveCount(1);
    await expect(page.locator('.row')).toHaveAttribute('href', ESSAY);
    await page.locator('.human-mark').click();
    await expect(page).toHaveURL(POLICY);
    await expect(page.locator('h1')).toContainText('Written');
  });

  test('the feed carries every post whole', async ({ request }) => {
    const response = await request.get('/blog/feed.xml');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/xml');
    const xml = await response.text();
    expect(xml.match(/<entry>/g)).toHaveLength(2);
    expect(xml).toContain('<id>https://merkur.sh/blog/every-block</id>');
    // A figure is its setup line, its caption and a link to where it runs.
    expect(xml).toContain('Figure 1 runs on the page.');
    expect(xml).not.toContain('data-island');
  });
});
