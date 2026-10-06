/**
 * Captures the orb's resting frame as `packages/quicksilver/assets/orb-still.webp`.
 *
 * The boot splash paints this still under the live orb so the mark is on
 * screen before WebGL has drawn a frame. It has to be the shader's own output:
 * a hand-drawn stand-in reads as a different mark next to the live one, and a
 * still taken at any time other than `ORB_REST_TIME` makes the orb jerk as the
 * splash hands over. So this drives the real app, in a real (headed) browser
 * on the real GPU, with reduced motion on — which makes `MerkurOrb` draw
 * exactly its rest frame once and stop — and photographs that canvas with
 * every ancestor made transparent, so the still carries the shader's own alpha
 * and can sit on any ground, the paper field included.
 *
 * Lossy WebP with alpha rather than PNG or JPEG: at quality 0.85 the 192px
 * frame is about 5 KB, where the same pixels are 40 KB as PNG and 9 KB as a
 * JPEG that had to be flattened onto one fixed colour to lose its alpha.
 *
 * Usage, with `bun run dev` serving the app:
 *
 *   bun run scripts/capture-orb-still.ts [origin]
 *
 * The origin defaults to the dev stack's browser-facing one. The API is held
 * for the duration of the capture so the app stays on its splash.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:3000';
const OUTPUT = resolve(import.meta.dir, '../packages/quicksilver/assets/orb-still.webp');
/** CSS size of the splash orb; the still is captured at 2x. */
const ORB_CSS_PX = 96;
const WEBP_QUALITY = 0.85;

const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 480 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  await page.route('**/api/**', async (route) => {
    await new Promise((settle) => setTimeout(settle, 20_000));
    await route.continue();
  });
  await page.goto(ORIGIN, { waitUntil: 'commit' });
  // Solid's splash, not the shell's: the shell's is a still already.
  await page.waitForFunction(
    () =>
      document.body.dataset.phase === 'bootstrapping' &&
      document.getElementById('boot-splash') === null &&
      document.querySelector('canvas') !== null,
  );
  await page.addStyleTag({
    content:
      'html, body, body * { background: transparent !important; background-image: none !important; }',
  });
  await page.waitForTimeout(300);

  const box = await page.locator('canvas').first().boundingBox();
  if (box === null) throw new Error('splash orb canvas has no layout box');
  const png = await page.screenshot({
    omitBackground: true,
    clip: { x: Math.round(box.x), y: Math.round(box.y), width: ORB_CSS_PX, height: ORB_CSS_PX },
  });

  const encoder = await context.newPage();
  await encoder.setContent(
    `<img id="still" src="data:image/png;base64,${png.toString('base64')}">`,
  );
  const bytes = await encoder.evaluate(async (quality) => {
    const image = document.getElementById('still');
    if (!(image instanceof HTMLImageElement)) throw new Error('still image missing');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const draw = canvas.getContext('2d');
    if (draw === null) throw new Error('2d context unavailable');
    draw.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((settle) =>
      canvas.toBlob(settle, 'image/webp', quality),
    );
    if (blob === null) throw new Error('webp encode failed');
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, WEBP_QUALITY);

  writeFileSync(OUTPUT, Buffer.from(bytes));
  process.stdout.write(`wrote ${OUTPUT} (${bytes.length} bytes, ${ORB_CSS_PX * 2}px)\n`);
} finally {
  await browser.close();
}
