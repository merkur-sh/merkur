/**
 * Captures the stills of the two large shader pictures, the boxes and the
 * planet, from the built page itself: what the render worker draws, at each
 * layout's size, on a transparent ground.
 *
 * The page shows a still until the worker has drawn its first frame, and
 * keeps it for a reader who asked for no motion, so the still is a frame of
 * the real picture rather than a drawing of it.
 *
 * Writes `src/gfx/stills/<picture>-<layout>.webp`. Run it after a shader or a
 * picture's box changes and commit what it writes:
 *
 *   MERKUR_SITE_RYBBIT_SITE_ID=placeholder bun run --cwd apps/site build
 *   bun run --cwd apps/site render-stills
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { serveDist } from './dist-server';

const site = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

const LAYOUTS = [
  { name: 'wide', width: 1440, height: 900, scale: 2 },
  { name: 'narrow', width: 390, height: 844, scale: 2 },
] as const;
const PICTURES = [
  { name: 'boxes', canvas: 'canvas[data-boxes]' },
  // The planet resolves out of noise over its first two seconds; wait it out.
  { name: 'planet', canvas: 'canvas[data-ascii]' },
] as const;
const SETTLE_MS = 3200;

const server = serveDist();
// The pictures are drawn on the GPU; a software rasteriser would bake its own look in.
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
try {
  mkdirSync(site('src/gfx/stills'), { recursive: true });
  for (const layout of LAYOUTS) {
    const page = await browser.newPage({
      viewport: { width: layout.width, height: layout.height },
      deviceScaleFactor: layout.scale,
    });
    await page.goto(`${server.origin}/`, { waitUntil: 'load' });
    for (const picture of PICTURES) {
      const canvas = page.locator(picture.canvas);
      await canvas.scrollIntoViewIfNeeded();
      await page.locator(`[data-drawn] > ${picture.canvas}`).waitFor();
      await page.waitForTimeout(SETTLE_MS);
      // Only the canvas: nothing behind it, nothing over it.
      await page.addStyleTag({
        content: `*, *::before, *::after { background: none !important; border-color: transparent !important; box-shadow: none !important; }
          .boxes-glow, .planet-hint, .still { display: none !important; }`,
      });
      const png = await canvas.screenshot({ omitBackground: true });
      const webp = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        return canvas.toDataURL('image/webp', 0.86).slice('data:image/webp;base64,'.length);
      }, png.toString('base64'));
      writeFileSync(
        site(`src/gfx/stills/${picture.name}-${layout.name}.webp`),
        Buffer.from(webp, 'base64'),
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.stop();
}
process.stdout.write('render-stills: wrote boxes and planet, wide and narrow\n');
