/**
 * Renders the site's share image and icons from the real artefacts: the built
 * home page and the Quicksilver orb still.
 *
 * - `public/og.png`, 1200 × 630: the top of the built home page at that size,
 *   so the image is the page's own lockup, headline and faces, not a second
 *   drawing of them.
 * - `src/brand/favicon.png` (32 px), which the pages link through the build so
 *   it is served under a content hash, and `public/apple-touch-icon.png`
 *   (180 px), which iOS asks for by name: the orb still.
 *
 * Run it after the first screen changes and commit what it writes:
 *
 *   MERKUR_SITE_RYBBIT_SITE_ID=placeholder bun run --cwd apps/site build
 *   bun run --cwd apps/site render-og
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLORS } from '@merkur/quicksilver/tokens';
import { chromium } from '@playwright/test';

import { serveDist } from './dist-server';

const site = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const orb = `data:image/webp;base64,${readFileSync(
  site('../../packages/quicksilver/assets/orb-still.webp'),
).toString('base64')}`;

const server = serveDist();
const browser = await chromium.launch();
try {
  const og = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await og.goto(`${server.origin}/`, { waitUntil: 'load' });
  await og.evaluate(async () => {
    await document.fonts.ready;
    // The first screen's pictures are eager; a lazy one further down never loads here.
    await Promise.all(
      [...document.images]
        .filter((image) => image.loading !== 'lazy')
        .map((image) => image.decode()),
    );
  });
  writeFileSync(
    site('public/og.png'),
    await og.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } }),
  );

  const icons = await browser.newPage();
  for (const [file, size] of [
    ['src/brand/favicon.png', 32],
    ['public/apple-touch-icon.png', 180],
  ] as const) {
    const png = await icons.evaluate(
      async ({ source, size, ground }) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('render-og: no 2D context');
        // The touch icon is square on the home screen, so it sits on the ground;
        // the tab icon keeps the orb's own round edge.
        if (size > 32) {
          context.fillStyle = ground;
          context.fillRect(0, 0, size, size);
        }
        const inset = size > 32 ? Math.round(size * 0.14) : 0;
        context.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
        return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
      },
      { source: orb, size, ground: COLORS.ground },
    );
    writeFileSync(site(file), Buffer.from(png, 'base64'));
  }
} finally {
  await browser.close();
  await server.stop();
}
process.stdout.write(
  'render-og: wrote public/og.png, public/apple-touch-icon.png, src/brand/favicon.png\n',
);
