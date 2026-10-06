import { resolve } from 'node:path';
import { inlineStylesheet } from '@merkur/quicksilver/vite';
import UnoCSS from 'unocss/vite';
import { defineConfig, type UserConfig } from 'vite';
import { FIGURES } from './src/content/figures';
import { blogFeed, FEED_FILE } from './src/vite/blog-feed';
import { blogPages, blogSolid, openBlog } from './src/vite/blog-pages';
import { figures } from './src/vite/figures';
import { fontCoverage } from './src/vite/font-coverage';
import { fontLicences } from './src/vite/font-licences';
import { noSheetPreload } from './src/vite/no-sheet-preload';
import { pageFacts } from './src/vite/page-facts';
import { readSiteEnvironment } from './src/vite/site-environment';
import { NOT_FOUND, ROUTES, siteManifest } from './src/vite/site-manifest';

/**
 * merkur.sh: static pages, plain HTML with the stylesheet inlined and one
 * small module each; everything that animates loads only after `load`.
 *
 * `figures` and `pageFacts` write every number and every sourced fact into
 * the pages before Vite reads them (both are `pre` HTML transforms, in this
 * order), and stop the build on a name with nothing behind it.
 * `inlineStylesheet` then folds the stylesheet into each page, and
 * `siteManifest`, last, lists what the static server may serve. The pages set
 * the site's own cuts of the faces, so of Quicksilver's `fonts/` only the
 * licences ship (`fontLicences`).
 *
 * Environment: `MERKUR_SITE_RYBBIT_SITE_ID` (required), `MERKUR_SITE_ORIGIN`
 * and `MERKUR_SITE_API_ORIGIN` (production unless set); see
 * `readSiteEnvironment`.
 */
const environment = readSiteEnvironment(process.env);

/** What UnoCSS's Vite plugin offers other plugins: its generator, once its config has loaded. */
interface UnoApi {
  getContext(): {
    readonly ready: Promise<unknown>;
    readonly uno: {
      generate(
        tokens: Set<string>,
        options: { preflights: boolean },
      ): Promise<{ matched: Set<string> }>;
    };
  };
}

function isUnoApi(api: unknown): api is UnoApi {
  return typeof api === 'object' && api !== null && 'getContext' in api;
}

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  // The blog is rendered before Vite reads its pages (`blogPages`). A build
  // renders it once; the dev server keeps the renderer and builds drafts too.
  const renderer = await openBlog({
    siteRoot: __dirname,
    fixtures: process.env.MERKUR_SITE_BLOG_FIXTURES === '1',
    drafts: command === 'serve',
  });
  const blog = await renderer.render();
  if (command === 'build') await renderer.close();
  const uno = UnoCSS();
  /** The classes among `classes` that UnoCSS, as this site configures it, knows as utilities. */
  const utilities = async (classes: Set<string>): Promise<string[]> => {
    const api: unknown = uno.find((plugin) => plugin.name === 'unocss:api')?.api;
    if (!isUnoApi(api)) throw new Error('vite.config: UnoCSS has no unocss:api plugin');
    const context = api.getContext();
    await context.ready;
    return [...(await context.uno.generate(classes, { preflights: false })).matched];
  };
  const routes = {
    ...ROUTES,
    ...Object.fromEntries(blog.pages.map((page) => [page.route, page.file])),
  };
  return {
    appType: 'mpa',
    build: {
      // Nothing becomes a data: URI: the CSP's img-src is 'self' only.
      assetsInlineLimit: 0,
      // No polyfill module in front of the page's own script; every browser the
      // page animates in has module preload.
      modulePreload: { polyfill: false },
      rolldownOptions: {
        input: Object.fromEntries(
          [...new Set([...Object.values(routes), NOT_FOUND])].map((page) => [
            // A chunk is named after its page; the manifest wants every one flat under assets/.
            page.replace(/\.html$/, '').replaceAll('/', '-'),
            resolve(__dirname, page),
          ]),
        ),
      },
    },
    plugins: [
      blogPages(blog, renderer, __dirname, utilities),
      blogSolid('dom'),
      uno,
      figures(FIGURES),
      pageFacts(
        {
          siteRoot: __dirname,
          repoRoot: resolve(__dirname, '../..'),
          blog: blog.pages.length > 0,
        },
        environment,
      ),
      fontLicences(
        resolve(__dirname, '../../packages/quicksilver/fonts'),
        resolve(__dirname, 'src/fonts/source/OFL-Literata.txt'),
      ),
      inlineStylesheet(),
      noSheetPreload(),
      siteManifest(
        environment,
        routes,
        blog.feed === null ? {} : { [FEED_FILE]: blogFeed(environment.siteOrigin, blog.feed) },
      ),
      fontCoverage(__dirname),
    ],
  };
});
