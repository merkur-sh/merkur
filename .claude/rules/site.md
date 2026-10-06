---
paths:
  - "apps/site/**"
  - "tests/e2e/site.e2e.ts"
  - "tests/e2e/start-site.ts"
  - "tests/e2e/fake-rybbit.ts"
  - "playwright.site.config.mjs"
  - "scripts/compress-site.ts"
  - ".github/workflows/deploy-site.yml"
  - "tests/e2e/site-blog.e2e.ts"
---

# Website (`apps/site`, merkur.sh)

Static pages built by Vite (`appType: 'mpa'`) and served by their own compiled static
server (`apps/site/server`), on a different origin from the app (`app.merkur.sh`). No
Effect, no WASM, no WebGPU. Solid is in two places only, both the blog's: it renders the
blog's pages to strings at build time, and it draws a post's figures once they wake (see
Blog). `docs/releases.md` ("Website") covers the image, the deploy workflow and the CDN.

## The page is its markup

- Every state a visitor can see is in the HTML. CSS under `@media (scripting: enabled)`
  picks one by attribute (`data-s`, `data-sec`); script only flips the attribute. The page
  must read whole with script off: `site.e2e.ts` loads it that way.
- The CSP is `script-src 'self'` and `style-src` by hash: no inline `<script>` (the JSON-LD
  data block is the one exemption, in `pageStyleHashes`) and no `style=""` attribute.
  Script may set `element.style` and run WAAPI.
- Numbers and sourced facts are never typed into a page: `[[name.key]]` is filled by
  `pageFacts` (`src/vite/page-facts.ts`) and `[[fig:…]]` by `figures`, and the build stops
  on a name with nothing behind it. The legal pages embed the app's own
  `apps/web/public/legal/*.html`; edit the text there.
- A screen that shows the product working plays at the speed the product has. The delay
  from a key, from Enter's line break and from what a command writes to its frame comes
  from `latency.ts`, which reads the three measured grids in `content/latency-model.ts`
  (a release, round trips against loss; each cell a measured row, held by
  `bun run check:figures`). Rows a command writes in one go are one write in
  `sim-script.ts` and land in one frame. Never write a latency, a jitter or a loss
  penalty into a screen, never stagger rows by hand, and never show a link outside the
  grids: measure the link first.
- `src/parts/{header,footer}.html` are shared by every page through `[[part.*]]`.
- A class name that is also a UnoCSS utility (`field`, `w92`, `c-blue`) silently takes the
  utility's rules. Name classes so they cannot collide.
- `main.ts` carries the sheet every page shares (`styles/base.css`); a page links its own
  (`styles/site.css`, `src/blog/blog.css`) as the **first thing in `<body>`**. A page's rule
  that weighs what a shared one does (`:where(.doc-body) a`, `.noai` over `.liq`) holds
  only while it comes later. The build sets both sheets in the head in the order the page
  names them, script first; the dev server injects `main.ts`'s sheet at the end of the
  head, so only a link in the body follows it there. Check a style change on both.
- A character Geist has no glyph for (an arrow, a prompt mark) is set alone in
  `<span class="tg">`; the build names any other.
- Text reads at 4.5:1 or better on the ground it sits on, a mock screen's included: the
  audit checks text under `aria-hidden` too. Quicksilver's `--faint` is 3.6:1 at best, so
  no text is set in it; the small print is `--note` (`base.css`), and a terminal's dim
  ink is the palette's overlay 2. A control at rest is quieter by colour, never by
  `opacity`, which takes its text under the ratio.

## What moves

- `main.ts` is the only script before `load`. After the first paint it loads `motion.ts`,
  which loads `gfx/client.ts` unless the reader asked for reduced motion.
- Every animation script starts is Motion (`motion`); timers (`motion/clock.ts`:
  `onScreen`, `createAgenda`) only say when. Which `animate` matters, because the page runs
  no `requestAnimationFrame` loop at rest and the e2e spec counts them:
  - `animateMini` for anything that repeats or plays unprompted (loops, pills, colour
    flashes, the pane clock). It hands the browser a whole WAAPI animation; write
    `transform` as a string and no script runs while it plays.
  - `animate` (the hybrid one) only for springs a visitor causes: a question opening, a
    card under the pointer, a section arriving. It drives independent transforms (`y`,
    `rotateX`, `scale`), colours and plain numbers from its own frame loop, which ends
    when the spring settles.
  - `scroll()` takes a callback, never an animation: an animation handed to it is sampled
    on every frame in a browser without scroll timelines (Gecko).
- Three things stay in the stylesheet: a page's arrival, which plays at first paint before
  any script has loaded (the hero's parts on the home page, the whole `<main>` elsewhere),
  the passage between pages, and hover and focus transitions on links and buttons, which
  must work with script off.
- An arrival starts from `opacity: 0.01`, never `0`. Chrome counts text as painted only
  once its opacity is above zero, and a fade the compositor runs repaints nothing until
  it ends, so a headline rising from 0 is reported as the largest paint when its
  animation finishes. `test:e2e:site` holds the headline to the first frame.
- **Between pages** (`base.css`) is a cross-document view transition, opted into by
  `@view-transition` in the shared sheet: the page left dissolves over the one arriving, the
  header (`site-header`) stays, and a post's title travels between the blog's index and the
  post (`post-<slug>`, a `<style>` `blogDocument` writes). Chromium and WebKit run it;
  Gecko has none yet, so there the old page is cut and the new one only arrives.
  - A `view-transition-name` used twice in a page makes the browser skip the whole
    transition. `test:e2e:site` checks every page; name by slug, never by class alone.
  - The transition takes input while it plays: keep it under a third of a second.
  - It cannot be seen on the dev server, which sets the shared sheet by script after the
    page is shown. Use the build: `bun run build:site:e2e`, then
    `PW_SITE_PORT=<port> bun --no-env-file run tests/e2e/start-site.ts`. WebKit refuses
    that server over plain HTTP (the CSP upgrades requests), so serve `dist` without the
    header to look at Safari's engine.
- One module worker (`gfx/worker.ts`) owns every WebGL context through `OffscreenCanvas`
  and the only frame loop, which stops when nothing it draws is on screen. Each picture is
  a still in the markup until the worker has drawn into its canvas.
- The 404 page's sky is one line (`gfx/retrograde-orbit.ts`) read twice: the build draws
  the stars, the dotted line and the orb held at the top of its loop as `[[retrograde.*]]`,
  the line's paths in unit boxes the stylesheet stretches, and the worker draws the orb's
  trip over them from the boxes' measured place (`gfx/retrograde.ts`). Its first frame is
  the still. In a stretched drawing a filter on a path is measured in stretched units (set
  it on the `<svg>`), and Gecko stretches the cap of a zero-length stroke (place a point
  by percentage in a drawing with no `viewBox`).

## Blog

`/blog`, `/blog/<slug>`, `/blog/authorship` and `/blog/feed.xml`, built by `blogPages()`
(`src/vite/blog-pages.ts`) from `apps/site/blog/`. With no post there, the build has no
blog: no route, no header link, nothing started.

- **Every word is the owner's.** The site promises it (`/blog/authorship`). Never write,
  rewrite, correct or translate `apps/site/blog/**/*.mdx`; the PreToolUse hook denies it
  (`scripts/agent-hooks/guards/authored-prose.ts`). Say what you would change. A post's
  figures and cover are code, and yours. `apps/site/fixtures/blog` holds the e2e harness's
  two posts (`MERKUR_SITE_BLOG_FIXTURES=1`, set by `build:site:e2e`): `every-block`, with
  every block and three figures, and `typing-ahead`, with no figure, so a post has a
  neighbour and the index a row. They never ship, their words are the harness's, and the
  specs hold nothing a published post says.
- **A post** is `blog/posts/<slug>/post.mdx`: front matter (`title`, `accent`, `dek`,
  `summary`, `date`, `topic`, `draft`), Markdown, and the blocks of
  `src/blog/templates/blocks.tsx` (`Figure`, `Tangent`, `TradeOffs`, `Swatch`, `Colophon`,
  `EndMatter`, `Glyph`). A footnote becomes a margin note; a fenced block names
  `file=<name>` and may `mark=<line>`. `blog-remark.ts` numbers figures, addresses
  sections and counts the words. Templates run at build time only.
- **A figure** is `posts/<slug>/figures/<name>.tsx`, one default-exported Solid component
  with no props, named by `<Figure island="<name>">`. The build renders it into the page
  as a still (`inert`); `src/blog/page.ts` fetches its module when it nears the viewport
  and `mount.ts` renders the same component in its place. So:
  - Its first frame is its still: no `Math.random`, clock or media query before
    `onSettled`. The e2e spec compares the two and counts layout shift.
  - It runs on the server too. Touch the browser only in handlers and `onSettled`; a
    cleanup must be safe where nothing was started. What `onSettled` starts it stops by
    returning a function: `onCleanup` inside it halts every figure on the page under the
    dev server, and a build does not say so. Open the post on the dev server after a change.
  - No `style` prop (the CSP refuses the attribute): state is a class or `data-*`. An
    `<input>`'s first value is a literal attribute.
  - It moves only while on screen (`kit/on-screen.ts`) and asks for no frames at rest.
  - Its arithmetic lives in `<name>.model.ts`, pure and tested; a number its caption
    states is the model's.
  - What figures share is `src/blog/kit/`. Nothing of the blog imports `motion`, `motion/`
    or `gfx/`: a shared module becomes a chunk the landing page would fetch.
- **What moves is the home page's Motion, and the home page's code where it fits.**
  `src/motion.ts`, which every page fetches after `load`, re-exports `animate`,
  `animateMini`, `spring` and `unfold` for the blog; a new name there must be one the home
  page already uses. The blog imports it dynamically and **by name**
  (`const { animate } = await import(…)`): taken whole, the bundler builds an object of
  the module's exports and the home page's entry script grows. `test:e2e:site` fails on a
  script the home page did not fetch before. So:
  - A block that rises as it is reached carries `data-reveal`; `motion/reveal.ts` finds it
    on every page. A tangent opens through `motion/unfold.ts`, as a question does.
  - A figure is mounted once Motion has resolved, so it calls `kit/motion.ts`'s `flash`,
    `arrive`, `places` and `settle` directly. A state change (a row sent, a line pushed
    down, a status replaced) is one of those, not a CSS transition.
  - `src/blog/page.ts` is the one script a blog page adds; after `load` it fetches
    `moves.ts` (the contents' marker, the tangents, a press).
  - The rules of "What moves" hold: `animateMini` for what a figure plays unprompted,
    `animate` for a spring the reader causes.
  - A module fetched later must not preload a stylesheet (`src/vite/no-sheet-preload.ts`):
    every sheet is inlined and the CSP refuses a linked one.
- After several edits to `vite.config.ts` the dev server can answer 504 for its own
  pre-bundled `motion` and the blog's script stops silently; restart it.
- **Solid 2 here** compiles with Babel (`blogSolid`). `render()` listens on the element it
  is given, so a figure is rendered in place, never moved. `Dynamic` marks its element for
  hydration, so every tag MDX asks for is a written-out component.
- **Nothing of the blog is in another page.** Blog markup sets no UnoCSS utility (the build
  refuses one), Literata is declared in `blog.css`, and the e2e spec fails on a blog asset
  requested by the landing page. The faces are cut from the build that has the fixtures.

## Analytics

Rybbit's script is fetched after the first paint, through the site's own `/analytics/`
proxy. The site answers the script's tracking config itself (`TRACKING_CONFIG` in
`server/rybbit-proxy.ts`): a pageview, Web Vitals, and a click on a control that names an
event. Nothing else is recorded, and no script of the site's calls Rybbit.

- A control names its event in the markup: `data-rybbit-event="<name>"`, and
  `data-rybbit-prop-<key>="<value>"` for where it is or which one it is. Rybbit counts every
  click on it, so a control whose click sometimes does nothing names the event only while the
  click will do it: the waitlist's button while its field holds an address
  (`waitlist.ts`), a question's summary while the question is closed (`main.ts`).
- A property says which control was pressed, never anything about the visitor or what
  they typed.
- `PAGE_EVENTS` in `tests/e2e/site.e2e.ts` lists every event of every page; a control
  that gains, loses or renames one changes that list in the same commit.

| Event | Properties | The click |
| --- | --- | --- |
| `cta_start_free` | `section`: `hero`, `closing`, `security-page` | A "Start free" button, to the app |
| `cta_sign_in` | | The header's "Sign in", to the app |
| `cta_open_app` | | "Back to orbit" on the 404 page |
| `cta_install_copy` | | "Copy" beside the install command |
| `cta_waitlist_submit` | | "Join the waitlist", with an address the form will send |
| `cta_github` | `section`: `source`, `footer`, `blog-footer`, `post`, `contact` | A link to the repository |
| `cta_how_it_works` | | The hero's second button |
| `cta_security_model` | | The security section's link to `/security` |
| `nav_click` | `to`: `product`, `security`, `source`, `blog`, `boxes`, `faq` | A link in the header |
| `security_tab` | `tab`: `encrypted`, `hardware`, `server` | A tab of the security section |
| `faq_open` | `question`: the question's id | A question opened by its summary |

The app server sends one more, `waitlist_joined`, when an address new to the list is added
(`apps/server/src/services/rybbit-events.ts`): the form cannot tell a new address from a
repeated one.

## After a change

| Changed | Run |
| --- | --- |
| Any copy or markup | `bun run --cwd apps/site build`, `bun run --cwd apps/site subset-fonts`, build again: the faces are cut to the characters the pages use, and the build fails on one that is missing. Build with `MERKUR_SITE_BLOG_FIXTURES=1` for the cut, so it holds the harness's pages too |
| An icon path or a liquid word | `bun run --cwd apps/site render-marks` (the blog's icon is `src/blog/noai-icon.ts`) |
| A shader, or the boxes or planet layout | build, `bun run --cwd apps/site render-stills`, build |
| The first screen | `bun run --cwd apps/site render-og` |
| Anything | `bun run test:e2e:site` |

The server compiles `MERKUR_SITE_API_ORIGIN` in, because its CSP must name the origin the
pages post to; the pages and the server read it through the same `site-environment.ts`.
The site answers `/install` with a 308 to the app's installer and a `www.` host with a 308
to the bare host. The Boxes waitlist posts to the app server's `/api/box-waitlist`, which
exists only while that server has `SITE_ORIGIN` set.

It deploys from `main` by itself, once the CI run of a push ends green, unsigned and
separately from a release tag: a pushed site change goes live without another step.
`gh workflow run deploy-site.yml --ref main` deploys the newest commit again.
