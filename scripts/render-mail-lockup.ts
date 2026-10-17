/**
 * Renders the lockup every Merkur email opens with, the orb beside the
 * Instrument Serif wordmark as the site's header sets them, into
 * `apps/server/src/services/mail-lockup.png`.
 *
 * An image, because no mail client this has to look right in loads the
 * wordmark's face: Gmail drops `@font-face`, and a remote font is remote
 * content that Outlook, Thunderbird and Apple Mail's "Block All Remote
 * Content" refuse. The mail carries the image inline (`cid:`), so it shows
 * with remote content blocked. It is flattened onto `ground`, the card it
 * sits on: the orb's surface is noise, and with alpha a client that paints
 * the card another colour would still show the mark whole, but every client
 * that keeps the card's colour gets the same pixels as the site.
 *
 * Usage: bun run scripts/render-mail-lockup.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { COLORS } from '@merkur/quicksilver/tokens';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dir, '..');
const OUTPUT = resolve(ROOT, 'apps/server/src/services/mail-lockup.png');
/** The site header's lockup (`.lockup`, `apps/site/src/styles/base.css`), a step smaller. */
const ORB_CSS_PX = 26;
const GAP_CSS_PX = 11;
const WORDMARK_CSS_PX = 30;
/** Phones draw mail at 3x; a 2x image is soft there. */
const SCALE = 3;

const dataUri = (path: string, type: string): string =>
  `data:${type};base64,${readFileSync(resolve(ROOT, path)).toString('base64')}`;

const page = `<!doctype html>
<style>
  @font-face {
    font-family: 'Instrument Serif';
    src: url('${dataUri('packages/quicksilver/fonts/InstrumentSerif-latin.woff2', 'font/woff2')}') format('woff2');
  }
  html, body { margin: 0; background: ${COLORS.ground}; }
  .lockup {
    display: inline-flex;
    align-items: center;
    gap: ${GAP_CSS_PX}px;
    padding: 2px 3px 2px 0;
    background: ${COLORS.ground};
  }
  img { width: ${ORB_CSS_PX}px; height: ${ORB_CSS_PX}px; display: block; }
  span {
    font: 400 ${WORDMARK_CSS_PX}px/1 'Instrument Serif';
    letter-spacing: -0.02em;
    color: ${COLORS.ink};
    padding-bottom: 2px;
    -webkit-font-smoothing: antialiased;
  }
</style>
<div class="lockup"><img src="${dataUri('packages/quicksilver/assets/orb-still.webp', 'image/webp')}" alt=""><span>Merkur</span></div>`;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const tab = await context.newPage();
  await tab.setContent(page);
  await tab.evaluate(() => document.fonts.ready);
  const png = await tab.locator('.lockup').screenshot({ type: 'png' });
  writeFileSync(OUTPUT, png);
  const box = await tab.locator('.lockup').boundingBox();
  if (box === null) throw new Error('the lockup has no box');
  process.stdout.write(
    `${OUTPUT}: ${Math.round(box.width)}x${Math.round(box.height)} CSS px, ${png.byteLength} bytes\n`,
  );
} finally {
  await browser.close();
}
