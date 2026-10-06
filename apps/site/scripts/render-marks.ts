/**
 * Bakes the masks the liquid-metal marks are drawn from (`src/gfx/marks.ts`).
 *
 * A mask holds a mark's shape in red and a blurred copy of it in green, which
 * the shader reads as the height of a surface. Baking them here, in Chromium
 * and in the page's own faces, means the render worker needs no font, no
 * canvas filter and no text layout, and every engine draws the same mark.
 *
 * - An icon is the stroked path of its still in `index.html`, so the page
 *   names each path once.
 * - A word is set in the face, size and box the stylesheet gives its still.
 *
 * Writes `src/gfx/marks/<name>.webp` and `src/gfx/marks/marks.json` (each
 * word's box and font size in CSS pixels). Run it when an icon's path or a word changes and
 * commit what it writes: `bun run --cwd apps/site render-marks`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import { NOAI_ICON_PATH } from '../src/blog/noai-icon';

const site = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const face = (path: string): string =>
  `data:font/woff2;base64,${readFileSync(site(path)).toString('base64')}`;

/** An icon's mask is square, this many pixels a side: 60 CSS pixels at 2x, with room to spare. */
const ICON_PIXELS = 128;
/** The "no AI" icon's mask: 100 CSS pixels at 2x, with room to spare. */
const NOAI_ICON_PIXELS = 256;
/** Words are baked at twice their CSS size. */
const WORD_SCALE = 2;

/** The words, as the stylesheet sets their stills: face, size, box height and baseline. */
const WORDS = [
  { name: 'one', text: '1', font: "500 128px 'Geist'", size: 128, height: 124, baseline: 0.88 },
  {
    name: 'ms',
    text: 'ms',
    font: "italic 400 72px 'Instrument Serif'",
    size: 72,
    height: 124,
    baseline: 0.88,
  },
  {
    name: 'agpl',
    text: 'AGPL-3.0',
    font: "600 148px 'Geist'",
    size: 148,
    height: 156,
    baseline: 0.84,
  },
  { name: 'lost', text: '404', font: "500 240px 'Geist'", size: 240, height: 200, baseline: 0.86 },
] as const;

const html = readFileSync(site('index.html'), 'utf8');
const icons = new Map<string, string>();
for (const [, name, path] of html.matchAll(
  /data-liquid-icon="([a-z]+)"[^>]*><svg[^>]*><path d="([^"]+)"/g,
)) {
  if (name === undefined || path === undefined) continue;
  const known = icons.get(name);
  if (known !== undefined && known !== path) {
    throw new Error(`render-marks: index.html draws the ${name} icon two ways`);
  }
  icons.set(name, path);
}
if (icons.size === 0) throw new Error('render-marks: index.html has no liquid icons');
const iconPixels = new Map([...icons.keys()].map((name) => [name, ICON_PIXELS]));
// The blog's icon is drawn by its templates, and as large as 100 CSS pixels.
icons.set('noai', NOAI_ICON_PATH);
iconPixels.set('noai', NOAI_ICON_PIXELS);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><style>
@font-face { font-family: 'Geist'; src: url(${face('../../packages/quicksilver/fonts/Geist-latin.woff2')}); font-weight: 100 900; }
@font-face { font-family: 'Instrument Serif'; font-style: italic; src: url(${face('src/fonts/source/InstrumentSerif-Italic-latin.woff2')}); }
</style>`);
  const baked = await page.evaluate(
    async ({ icons, words, wordScale }) => {
      /** Draws with `paint`, sharp and blurred, and packs the two alphas into one opaque image. */
      const pack = async (
        width: number,
        height: number,
        blur: number,
        paint: (context: CanvasRenderingContext2D) => void,
      ): Promise<string> => {
        const layer = (radius: number): Uint8ClampedArray => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (context === null) throw new Error('no 2D context');
          if (radius > 0) context.filter = `blur(${radius}px)`;
          paint(context);
          return context.getImageData(0, 0, width, height).data;
        };
        const shape = layer(0);
        const soft = layer(blur);
        // Grey, side by side: a lossy encoder keeps luma whole and would smear two colour
        // channels into each other.
        const out = new ImageData(width * 2, height);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const from = (y * width + x) * 4 + 3;
            const sharp = (y * width * 2 + x) * 4;
            const blurred = sharp + width * 4;
            const height01 = Math.min(255, (soft[from] ?? 0) * 1.6);
            out.data.fill(shape[from] ?? 0, sharp, sharp + 3);
            out.data.fill(height01, blurred, blurred + 3);
            out.data[sharp + 3] = 255;
            out.data[blurred + 3] = 255;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width * 2;
        canvas.height = height;
        canvas.getContext('2d')?.putImageData(out, 0, 0);
        return canvas.toDataURL('image/webp', 0.9).slice('data:image/webp;base64,'.length);
      };

      const files: Record<string, string> = {};
      for (const [name, path, pixels] of icons) {
        files[`icon-${name}`] = await pack(pixels, pixels, pixels * 0.022, (context) => {
          context.scale(pixels / 24, pixels / 24);
          context.translate(0.5, 0.5);
          context.scale(23 / 24, 23 / 24);
          context.lineWidth = 2.5;
          context.lineCap = 'round';
          context.lineJoin = 'round';
          context.strokeStyle = '#fff';
          context.stroke(new Path2D(path));
        });
      }
      const boxes: Record<string, { width: number; height: number; size: number }> = {};
      for (const word of words) {
        await document.fonts.load(word.font, word.text);
        const measure = document.createElement('canvas').getContext('2d');
        if (measure === null) throw new Error('no 2D context');
        measure.font = word.font;
        const metrics = measure.measureText(word.text);
        const pad = word.size * 0.07;
        const left = metrics.actualBoundingBoxLeft;
        const cssWidth = Math.ceil(left + metrics.actualBoundingBoxRight + pad * 2);
        const width = Math.round(cssWidth * wordScale);
        const height = Math.round(word.height * wordScale);
        boxes[word.name] = { width: cssWidth, height: word.height, size: word.size };
        files[`word-${word.name}`] = await pack(
          width,
          height,
          Math.max(width, height) * 0.012,
          (context) => {
            context.font = word.font.replace(`${word.size}px`, `${word.size * wordScale}px`);
            context.textBaseline = 'alphabetic';
            context.fillStyle = '#fff';
            context.fillText(word.text, (pad + left) * wordScale, height * word.baseline);
          },
        );
      }
      return { files, boxes };
    },
    {
      icons: [...icons].map(
        ([name, path]) => [name, path, iconPixels.get(name) ?? ICON_PIXELS] as const,
      ),
      words: WORDS,
      wordScale: WORD_SCALE,
    },
  );
  mkdirSync(site('src/gfx/marks'), { recursive: true });
  for (const [name, png] of Object.entries(baked.files)) {
    writeFileSync(site(`src/gfx/marks/${name}.webp`), Buffer.from(png, 'base64'));
  }
  writeFileSync(site('src/gfx/marks/marks.json'), `${JSON.stringify(baked.boxes, null, 2)}\n`);
  process.stdout.write(`render-marks: wrote ${Object.keys(baked.files).sort().join(', ')}\n`);
} finally {
  await browser.close();
}
