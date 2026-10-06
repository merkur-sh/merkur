import type { Plugin } from 'vite';

/**
 * Keeps a stylesheet out of what a module fetched later preloads.
 *
 * Every sheet is in its page (`inlineStylesheet`), and the CSP refuses one
 * linked from a file. Vite lists a chunk's sheet among what a dynamic import
 * of that chunk preloads, and `modulePreload.resolveDependencies` is never
 * shown the sheets. A blog page takes Motion from the chunk the entry script
 * loads (`src/blog/kit/motion.ts`), which names the entry and so its sheet:
 * the page would ask for a stylesheet it already has and be refused it.
 *
 * So once the pages have been written with their links, the chunks forget
 * their sheets, before Vite writes each chunk's list.
 */
export function noSheetPreload(): Plugin {
  return {
    name: 'merkur-site-no-sheet-preload',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') file.viteMetadata?.importedCss.clear();
      }
    },
  };
}
