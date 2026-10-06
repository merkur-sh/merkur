/**
 * `blogPages()`: the blog, rendered from MDX to static pages before Vite
 * reads them.
 *
 * A post is `blog/posts/<slug>/post.mdx` with its figures beside it in
 * `figures/<name>.tsx` and, if it has one, the picture the index shows for it
 * in `cover.tsx`. `blog/index.mdx` introduces the index and
 * `blog/authorship.mdx` is the authorship policy. `openBlog` loads them
 * through a Vite server of its own, where Solid compiles to strings with no
 * hydration markers, and renders each to a whole document. `blogPages` hands
 * those documents to the page build as HTML inputs, so `figures`,
 * `pageFacts`, the inlined stylesheet, the manifest and the font check treat
 * them as they treat `security.html`.
 *
 * A figure is in its page as a still. `virtual:blog-islands` names the module
 * behind each one for `src/blog/page.ts`, which loads it when the figure nears
 * the viewport; nothing else of Solid reaches a browser, and nothing of the
 * blog reaches a page that is not part of it.
 *
 * Two things decide what is built. `fixtures` adds `fixtures/blog`, the e2e
 * harness's pages, which production never builds. `drafts` builds the posts
 * whose front matter says `draft: true`; the dev server sets it and a build
 * does not.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import mdx from '@mdx-js/rollup';
import solid from '@solidjs/vite-plugin';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import { bundledLanguagesInfo, createHighlighter } from 'shiki';
import { createServer, isRunnableDevEnvironment, type Plugin } from 'vite';

import type { Feed, FeedEntry } from './blog-feed';
import { type PostOutline, remarkPost } from './blog-remark';
import { escapeHtml } from './html';

export interface BlogOptions {
  /** `apps/site`. */
  readonly siteRoot: string;
  /** Whether the harness's pages under `fixtures/blog` are built too. */
  readonly fixtures: boolean;
  /** Whether posts marked `draft: true` are built. */
  readonly drafts: boolean;
}

export interface BlogPage {
  /** The address the page is served at. */
  readonly route: string;
  /** The document's path in the build, from its root. */
  readonly file: string;
  readonly html: string;
}

export interface Blog {
  readonly pages: readonly BlogPage[];
  /** `<slug>/<name>` of every figure, to the module that draws it. */
  readonly islands: Readonly<Record<string, string>>;
  /** The posts as the feed carries them; nothing when there is no post. */
  readonly feed: Feed | null;
}

export interface BlogRenderer {
  /** Renders every page again from what is on disk now. */
  render(): Promise<Blog>;
  close(): Promise<void>;
}

const ISLANDS_MODULE = 'virtual:blog-islands';
/** The modules the blog is rendered and woken with, from this file. */
const RENDER_MODULE = '../blog/render.tsx';
const PAGE_MODULE = '../blog/page.ts';
/** This file's directory, from the site's root, as a page names a script. */
const HERE = '/src/vite';
const INDEX_ROUTE = '/blog';
const POLICY_ROUTE = '/blog/authorship';
/** A post cannot take the address of a page the blog has of its own. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(['authorship', 'feed.xml']);

/** A reader's pace, in words a minute, that a post's reading time is counted at. */
const WORDS_A_MINUTE = 230;

/** A figure's module, wherever its post lives, and the kit figures share. */
const ISLAND_SOURCES = [/\/blog\/posts\/[^/]+\/figures\/[^/]+\.tsx$/, /\/src\/blog\/kit\//];

/**
 * Solid for the blog: to strings where the pages are rendered, to the DOM
 * where a figure wakes in a page. Neither side hydrates, so the markup carries
 * no hydration key.
 *
 * Babel compiles the JSX (`@solidjs/babel-plugin`).
 */
export function blogSolid(target: 'strings' | 'dom'): Plugin[] {
  const plugin =
    target === 'strings'
      ? solid({
          compiler: 'babel',
          extensions: ['.mdx'],
          solid: { generate: 'ssr', hydratable: false },
        })
      : solid({ compiler: 'babel', include: ISLAND_SOURCES });
  return [plugin].flat();
}

/**
 * Catppuccin Mocha, the terminal palette every post's code and figures are
 * set in, by the name its class goes by (`tk-<name>` in `blog.css`).
 */
const PALETTE: Readonly<Record<string, string>> = {
  '#f5e0dc': 'rosewater',
  '#f2cdcd': 'flamingo',
  '#f5c2e7': 'pink',
  '#cba6f7': 'mauve',
  '#f38ba8': 'red',
  '#eba0ac': 'maroon',
  '#fab387': 'peach',
  '#f9e2af': 'yellow',
  '#a6e3a1': 'green',
  '#94e2d5': 'teal',
  '#89dceb': 'sky',
  '#74c7ec': 'sapphire',
  '#89b4fa': 'blue',
  '#b4befe': 'lavender',
  '#cdd6f4': 'text',
  '#bac2de': 'subtext1',
  '#a6adc8': 'subtext0',
  '#9399b2': 'overlay2',
  '#7f849c': 'overlay1',
  '#6c7086': 'overlay0',
};

/** The modules `openBlog` renders with, as its server loads them. */
interface RenderModule {
  renderPost(
    module: unknown,
    post: PostView,
    context: unknown,
    previous: PostView | null,
    next: PostView | null,
  ): string;
  renderIndex(
    module: unknown,
    title: { title: string; accent: string },
    posts: readonly PostView[],
    cover: unknown,
    context: unknown,
  ): string;
  renderPolicy(module: unknown, title: { title: string; accent: string }, context: unknown): string;
  renderFeedContent(module: unknown, context: unknown): string;
}

/** `PostView` of `src/blog/templates/pages.tsx`, which this file cannot import. */
interface PostView {
  readonly slug: string;
  readonly title: string;
  readonly accent: string;
  readonly dek: string;
  readonly summary: string;
  readonly topic: string;
  readonly date: string;
  readonly dateLong: string;
  readonly dateShort: string;
  readonly year: string;
  readonly minutes: number;
  readonly headings: PostOutline['headings'];
  readonly figures: PostOutline['figures'];
}

type Frontmatter = Readonly<Record<string, unknown>>;
interface PageSource {
  readonly default?: unknown;
  readonly frontmatter?: Frontmatter;
}

interface PostSource {
  readonly slug: string;
  readonly file: string;
  /** Figure name to the module that draws it. */
  readonly figures: Readonly<Record<string, string>>;
  readonly cover: string | null;
}

function findPosts(root: string): PostSource[] {
  const posts = join(root, 'posts');
  if (!existsSync(posts)) return [];
  return readdirSync(posts, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(posts, entry.name);
      const file = join(directory, 'post.mdx');
      if (!existsSync(file)) throw new Error(`blog: ${directory} has no post.mdx`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) || RESERVED_SLUGS.has(entry.name)) {
        throw new Error(`blog: ${entry.name} cannot be a post's address`);
      }
      const figures = join(directory, 'figures');
      const cover = join(directory, 'cover.tsx');
      return {
        slug: entry.name,
        file,
        figures: Object.fromEntries(
          (existsSync(figures) ? readdirSync(figures) : [])
            .filter((name) => name.endsWith('.tsx'))
            .map((name) => [basename(name, '.tsx'), join(figures, name)]),
        ),
        cover: existsSync(cover) ? cover : null,
      };
    });
}

function text(frontmatter: Frontmatter, key: string, page: string): string {
  const value = frontmatter[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`blog: ${page} has no ${key} in its front matter`);
  }
  return value;
}

function postView(slug: string, frontmatter: Frontmatter, outline: PostOutline): PostView {
  const date = text(frontmatter, 'date', slug);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new Error(`blog: ${slug} is dated ${date}; write the date as "2026-09-24"`);
  }
  const day = new Date(`${date}T00:00:00Z`);
  const format = (options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(day);
  return {
    slug,
    title: text(frontmatter, 'title', slug),
    accent: text(frontmatter, 'accent', slug),
    dek: text(frontmatter, 'dek', slug),
    summary: text(frontmatter, 'summary', slug),
    topic: text(frontmatter, 'topic', slug),
    date,
    dateLong: format({ month: 'long', day: 'numeric', year: 'numeric' }),
    dateShort: format({ month: 'short', day: 'numeric' }),
    year: date.slice(0, 4),
    minutes: Math.max(1, Math.round(outline.words / WORDS_A_MINUTE)),
    headings: outline.headings,
    figures: outline.figures,
  };
}

interface DocumentParts {
  /** The page's address, from the site's root. */
  readonly route: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'article' | 'website';
  /** The page's `<main>`. */
  readonly main: string;
  /** A post's day, as `2026-09-24`, when the page is one: it carries a posting for search engines. */
  readonly published: string | null;
  /**
   * What the page shares with the page a link leads to, by selector: the name
   * the browser carries it across under (`base.css`, "Between pages"). A name
   * is one element's in a page.
   */
  readonly carried: Readonly<Record<string, string>>;
}

/** The name a post's title is carried under, from the index to the post and back. */
function titleName(slug: string): string {
  return `post-${slug}`;
}

/** A blog page's whole document, with the names `pageFacts` fills still in it. */
function blogDocument(parts: DocumentParts): string {
  const title = escapeHtml(parts.title);
  const description = escapeHtml(parts.description);
  // A post may write `[[`; only the document around it names facts.
  const main = parts.main.replaceAll('[[', '&#91;[');
  const address = `[[site.origin]]${parts.route}`;
  // `<` is escaped so no title can close the script element it sits in.
  const posting =
    parts.published === null
      ? ''
      : `\n<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: parts.title,
          description: parts.description,
          datePublished: parts.published,
          url: address,
          mainEntityOfPage: address,
          author: { '@type': 'Person', name: 'Dmytro' },
          publisher: { '@id': '[[site.origin]]/#organization' },
        }).replaceAll('<', '\\u003c')}</script>`;

  const carried = Object.entries(parts.carried)
    .map(([selector, name]) => `${selector}{view-transition-name:${name}}`)
    .join('');

  const names = carried === '' ? '' : `\n<style>${carried}</style>`;

  return `<!doctype html>
<html lang="en" data-rybbit-site="[[rybbit.siteId]]">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Merkur</title>
<meta name="description" content="${description}">
<link rel="canonical" href="[[site.origin]]${parts.route}">
<link rel="alternate" type="application/atom+xml" title="Merkur blog" href="/blog/feed.xml">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="[[color.ground]]">
<meta property="og:type" content="${parts.kind}">
<meta property="og:site_name" content="Merkur">
<meta property="og:url" content="[[site.origin]]${parts.route}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="[[site.origin]]/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/src/brand/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/src/fonts/Geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/src/fonts/InstrumentSerif-Italic-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/src/fonts/Literata-latin.woff2" as="font" type="font/woff2" crossorigin>
<script type="module" src="/src/main.ts"></script>
<script type="module" src="${posix.join(HERE, PAGE_MODULE)}"></script>${posting}${names}
</head>
<body class="blog-page">
<link rel="stylesheet" href="/src/blog/blog.css">
[[part.header]]

${main}

[[part.blogFooter]]
</body>
</html>
`;
}

/** Opens the blog: the server its pages are rendered through stays up until `close`. */
export async function openBlog(options: BlogOptions): Promise<BlogRenderer> {
  const roots = [
    join(options.siteRoot, 'blog'),
    ...(options.fixtures ? [join(options.siteRoot, 'fixtures/blog')] : []),
  ];
  // A site with no post has no blog, and needs nothing started to say so.
  if (roots.flatMap(findPosts).length === 0) {
    return { render: async () => ({ pages: [], islands: {}, feed: null }), close: async () => {} };
  }
  const outlines = new Map<string, PostOutline>();
  const server = await createServer({
    configFile: false,
    root: options.siteRoot,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        enforce: 'pre',
        ...mdx({
          jsx: true,
          jsxImportSource: '@solidjs/web',
          elementAttributeNameCase: 'html',
          remarkPlugins: [
            remarkGfm,
            remarkFrontmatter,
            remarkMdxFrontmatter,
            remarkPost((file, outline) => outlines.set(file, outline)),
          ],
        }),
      },
      blogSolid('strings'),
    ],
  });
  const environment = server.environments.ssr;
  if (environment === undefined || !isRunnableDevEnvironment(environment)) {
    await server.close();
    throw new Error('blog: the render server has no runnable environment');
  }
  const { runner } = environment;
  const highlighter = await createHighlighter({ themes: ['catppuccin-mocha'], langs: [] });

  const highlight = (
    code: string,
    lang: string,
  ): { name: string; lines: { text: string; tone: string }[][] } => {
    const info = bundledLanguagesInfo.find(
      (entry) => entry.id === lang || entry.aliases?.includes(lang) === true,
    );
    if (info === undefined) throw new Error(`blog: no language named ${lang}`);
    const lines = highlighter
      .codeToTokensBase(code, { lang: info.id as never, theme: 'catppuccin-mocha' })
      .map((line) =>
        line.map((token) => {
          const tone = PALETTE[(token.color ?? '').toLowerCase()];
          if (tone === undefined) {
            throw new Error(`blog: ${token.color} is not a colour of the terminal palette`);
          }
          return { text: token.content, tone };
        }),
      );
    return { name: info.name, lines };
  };

  const first = (name: string): string | null =>
    roots.map((root) => join(root, name)).find((file) => existsSync(file)) ?? null;

  const render = async (): Promise<Blog> => {
    // Every module runs again; one whose file has not changed is not compiled again, so
    // its outline is the one its last compile recorded.
    runner.clearCache();
    const sources = roots.flatMap(findPosts);
    const slugs = new Set<string>();
    for (const source of sources) {
      if (slugs.has(source.slug)) throw new Error(`blog: two posts are named ${source.slug}`);
      slugs.add(source.slug);
    }

    const loaded: {
      source: PostSource;
      module: PageSource;
      view: PostView;
      languages: readonly string[];
    }[] = [];
    for (const source of sources) {
      const module: PageSource = await runner.import(source.file);
      const frontmatter = module.frontmatter ?? {};
      if (frontmatter.draft === true && !options.drafts) continue;
      const outline = outlines.get(source.file);
      if (outline === undefined) throw new Error(`blog: ${source.file} was not outlined`);
      for (const figure of outline.figures) {
        if (source.figures[figure.island] === undefined) {
          throw new Error(`blog: ${source.slug} has no figures/${figure.island}.tsx`);
        }
      }
      loaded.push({
        source,
        module,
        view: postView(source.slug, frontmatter, outline),
        languages: outline.languages,
      });
    }
    if (loaded.length === 0) return { pages: [], islands: {}, feed: null };
    loaded.sort((a, b) => b.view.date.localeCompare(a.view.date));

    const indexFile = first('index.mdx');
    const policyFile = first('authorship.mdx');
    if (indexFile === null || policyFile === null) {
      throw new Error(
        'blog: a post is published, so blog/index.mdx and blog/authorship.mdx must be',
      );
    }
    const indexModule: PageSource = await runner.import(indexFile);
    const policyModule: PageSource = await runner.import(policyFile);
    for (const lang of new Set([...outlines.values()].flatMap((outline) => outline.languages))) {
      const info = bundledLanguagesInfo.find(
        (entry) => entry.id === lang || entry.aliases?.includes(lang) === true,
      );
      if (info === undefined) throw new Error(`blog: no language named ${lang}`);
      await highlighter.loadLanguage(info.id as never);
    }

    const templates: RenderModule = await runner.import(posix.join(HERE, RENDER_MODULE));
    const pages: BlogPage[] = [];
    const islands: Record<string, string> = {};
    const entries: FeedEntry[] = [];
    const component = async (file: string): Promise<unknown> => {
      const module: { default?: unknown } = await runner.import(file);
      if (typeof module.default !== 'function') {
        throw new Error(`blog: ${file} has no default export to draw`);
      }
      return module.default;
    };

    for (const [index, { source, module, view }] of loaded.entries()) {
      const figures: Record<string, unknown> = {};
      for (const figure of view.figures) {
        const file = source.figures[figure.island] ?? '';
        figures[figure.island] = await component(file);
        islands[`${source.slug}/${figure.island}`] = file;
      }
      entries.push({
        slug: source.slug,
        title: `${view.title} ${view.accent}`,
        summary: view.summary,
        date: view.date,
        content: templates.renderFeedContent(module, { slug: source.slug, figures, highlight }),
      });
      pages.push({
        route: `/blog/${source.slug}`,
        file: `blog/${source.slug}.html`,
        html: blogDocument({
          route: `/blog/${source.slug}`,
          title: `${view.title} ${view.accent}`,
          description: view.summary,
          kind: 'article',
          // Newest first: the post before this one in time is the next in the list.
          main: templates.renderPost(
            module,
            view,
            { slug: source.slug, figures, highlight },
            loaded[index + 1]?.view ?? null,
            loaded[index - 1]?.view ?? null,
          ),
          published: view.date,
          carried: { '.post-title': titleName(source.slug) },
        }),
      });
    }

    const plain = { slug: 'blog', figures: {}, highlight };
    const indexTitle = {
      title: text(indexModule.frontmatter ?? {}, 'title', 'index.mdx'),
      accent: text(indexModule.frontmatter ?? {}, 'accent', 'index.mdx'),
    };
    const latest = loaded[0];
    pages.push({
      route: INDEX_ROUTE,
      file: 'blog/index.html',
      html: blogDocument({
        route: INDEX_ROUTE,
        title: `${indexTitle.title} ${indexTitle.accent}`,
        description: text(indexModule.frontmatter ?? {}, 'summary', 'index.mdx'),
        kind: 'website',
        main: templates.renderIndex(
          indexModule,
          indexTitle,
          loaded.map((post) => post.view),
          latest === undefined || latest.source.cover === null
            ? null
            : await component(latest.source.cover),
          plain,
        ),
        published: null,
        carried: Object.fromEntries(
          loaded.map(({ source }) => [
            `a[href="/blog/${source.slug}"] :is(.latest-title,.row-title)`,
            titleName(source.slug),
          ]),
        ),
      }),
    });
    const policyTitle = {
      title: text(policyModule.frontmatter ?? {}, 'title', 'authorship.mdx'),
      accent: text(policyModule.frontmatter ?? {}, 'accent', 'authorship.mdx'),
    };
    pages.push({
      route: POLICY_ROUTE,
      file: 'blog/authorship.html',
      html: blogDocument({
        route: POLICY_ROUTE,
        title: `${policyTitle.title} ${policyTitle.accent}`,
        description: text(policyModule.frontmatter ?? {}, 'summary', 'authorship.mdx'),
        kind: 'website',
        main: templates.renderPolicy(policyModule, policyTitle, plain),
        published: null,
        carried: {},
      }),
    });
    return {
      pages,
      islands,
      feed: { title: `Merkur · ${indexTitle.title} ${indexTitle.accent}`, entries },
    };
  };

  return {
    render,
    close: async () => {
      highlighter.dispose();
      await server.close();
    },
  };
}

/**
 * Hands the blog's documents to the page build, and in development renders
 * them again on every request, so a saved post is the next reload.
 */
export function blogPages(
  first: Blog,
  renderer: BlogRenderer,
  siteRoot: string,
  /** The classes among `classes` that UnoCSS knows as utilities. */
  utilities: (classes: Set<string>) => Promise<string[]>,
): Plugin {
  let blog = first;
  const document = (id: string): string | undefined =>
    blog.pages.find((page) => resolve(siteRoot, page.file) === id)?.html;
  /**
   * Stops on a class of the blog's that UnoCSS also knows as a utility.
   * UnoCSS reads every page Vite builds, so such a class would take the
   * utility's rules and write them into the sheet every page carries.
   */
  const refuseUtilities = async (): Promise<void> => {
    const classes = new Set<string>();
    for (const page of blog.pages) {
      for (const [, names = ''] of page.html.matchAll(/\bclass="([^"]*)"/g)) {
        for (const name of names.split(/\s+/)) if (name !== '') classes.add(name);
      }
    }
    const matched = await utilities(classes);
    if (matched.length > 0) {
      throw new Error(
        `blog: ${matched.sort().join(', ')}: a class of the blog's is also a UnoCSS utility; name it something else`,
      );
    }
  };
  return {
    name: 'merkur-site-blog-pages',
    enforce: 'pre',
    async buildStart() {
      await refuseUtilities();
    },
    resolveId(id) {
      if (id === ISLANDS_MODULE) return `\0${ISLANDS_MODULE}`;
      return document(id) === undefined ? null : id;
    },
    load(id) {
      if (id === `\0${ISLANDS_MODULE}`) {
        const entries = Object.entries(blog.islands).map(
          ([name, file]) => `  ${JSON.stringify(name)}: () => import(${JSON.stringify(file)}),`,
        );
        return `export const islands = {\n${entries.join('\n')}\n};\n`;
      }
      return document(id) ?? null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const route = (request.url ?? '').split('?')[0] ?? '';
        if (route !== INDEX_ROUTE && !route.startsWith(`${INDEX_ROUTE}/`)) {
          next();
          return;
        }
        void (async () => {
          blog = await renderer.render();
          await refuseUtilities();
          const islands = server.moduleGraph.getModuleById(`\0${ISLANDS_MODULE}`);
          if (islands !== undefined) server.moduleGraph.invalidateModule(islands);
          const page = blog.pages.find((entry) => entry.route === route);
          if (page === undefined) {
            next();
            return;
          }
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(await server.transformIndexHtml(route, page.html));
        })().catch(next);
      });
    },
  };
}
