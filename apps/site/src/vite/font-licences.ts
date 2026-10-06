/**
 * `fontLicences()`: publishes the faces' SIL Open Font Licences at
 * `/fonts/OFL-<face>.txt`: Quicksilver's three and the blog's reading face's,
 * and nothing else from Quicksilver's `fonts/`.
 *
 * The pages set the site's own cuts (`src/fonts/`, see `font-coverage.ts`),
 * which the build hashes into `/assets/`. Quicksilver's full faces are not
 * requested by any page, so they are not shipped; the licences are, because
 * the cuts are modified versions of the licensed fonts and fontTools does not
 * carry the licence text into them.
 *
 * Loaded by Vite's config bundler: builtins and types only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Plugin } from 'vite';

const LICENCE = /^OFL-[A-Za-z]+\.txt$/;

export function fontLicences(quicksilverFonts: string, readingLicence: string): Plugin {
  const licences = readdirSync(quicksilverFonts)
    .filter((file) => LICENCE.test(file))
    .sort();
  if (licences.length !== 3) {
    throw new Error(`font-licences: expected three OFL files in ${quicksilverFonts}`);
  }
  if (!LICENCE.test(basename(readingLicence))) {
    throw new Error(`font-licences: ${readingLicence} is not named OFL-<face>.txt`);
  }
  return {
    name: 'merkur-site-font-licences',
    apply: 'build',
    generateBundle() {
      for (const path of [
        ...licences.map((file) => join(quicksilverFonts, file)),
        readingLicence,
      ]) {
        this.emitFile({
          type: 'asset',
          fileName: `fonts/${basename(path)}`,
          source: readFileSync(path),
        });
      }
    },
  };
}
