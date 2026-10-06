/** Sample the brand still and shader into compiled terminal cells; runtime does no rendering. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dir, '..');
const source = readFileSync(resolve(root, 'packages/quicksilver/assets/orb-still.webp'));
const digest = createHash('sha256').update(source).digest('hex');
const shaderPath = resolve(root, 'packages/quicksilver/src/orb.ts');
const shaderDigest = createHash('sha256').update(readFileSync(shaderPath)).digest('hex');
const bundle = await Bun.build({ entrypoints: [shaderPath], target: 'browser', format: 'esm' });
const output = bundle.outputs[0];
if (!bundle.success || output === undefined) throw new Error('Orb shader bundle failed');
const shaderUrl = `data:text/javascript;base64,${Buffer.from(await output.text()).toString('base64')}`;
// Twelve frames per second over four seconds: smooth motion for a tiny terminal mark.
const frameCount = 48;
// Square half-cell pixels: 22 columns by 11 rows, and 12 by 6.
const sizes = [
  { width: 22, height: 22 },
  { width: 12, height: 12 },
];
// Sixteen source pixels per half cell of the large mark, averaged.
const renderSize = 352;

interface Sampled {
  readonly width: number;
  readonly height: number;
  /** sRGB, three bytes per half cell. */
  readonly colors: number[];
  /** Fraction of each half cell inside the disc. */
  readonly coverage: number[];
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const rasters = await page.evaluate(
    async ({ url, shaderUrl, frameCount, sizes, renderSize }) => {
      const linear = Array.from({ length: 256 }, (_, value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      const encode = (value: number) => {
        const c = Math.min(1, Math.max(0, value));
        const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
        return Math.round(s * 255);
      };
      const read = document.createElement('canvas');
      const pixels = (image: CanvasImageSource, side: number) => {
        read.width = side;
        read.height = side;
        const context = read.getContext('2d', { willReadFrequently: true });
        if (context === null) throw new Error('Orb conversion needs a canvas');
        context.clearRect(0, 0, side, side);
        context.drawImage(image, 0, 0, side, side);
        return context.getImageData(0, 0, side, side).data;
      };
      // The sphere's square, measured once so every frame shares one disc.
      const disc = (data: Uint8ClampedArray, side: number) => {
        let top = side;
        let bottom = -1;
        let left = side;
        let right = -1;
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            if ((data[(y * side + x) * 4 + 3] ?? 0) >= 128) {
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
              left = Math.min(left, x);
              right = Math.max(right, x);
            }
          }
        }
        const radius = Math.max(bottom - top + 1, right - left + 1) / 2;
        return {
          x: (left + right + 1) / 2 - radius,
          y: (top + bottom + 1) / 2 - radius,
          side: radius * 2,
        };
      };
      // Premultiplied, linear-light box filter: grooves average into the
      // light they carry instead of aliasing into noise. Coverage is the
      // analytic disc, so the rim never shimmers with the surface.
      const sample = (
        data: Uint8ClampedArray,
        side: number,
        square: { x: number; y: number; side: number },
        width: number,
        height: number,
      ) => {
        const colors: number[] = [];
        const coverage: number[] = [];
        for (let j = 0; j < height; j++) {
          for (let i = 0; i < width; i++) {
            const x0 = Math.floor(square.x + (square.side * i) / width);
            const x1 = Math.ceil(square.x + (square.side * (i + 1)) / width);
            const y0 = Math.floor(square.y + (square.side * j) / height);
            const y1 = Math.ceil(square.y + (square.side * (j + 1)) / height);
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let y = Math.max(0, y0); y < Math.min(side, y1); y++) {
              for (let x = Math.max(0, x0); x < Math.min(side, x1); x++) {
                const at = (y * side + x) * 4;
                const alpha = (data[at + 3] ?? 0) / 255;
                r += (linear[data[at] ?? 0] ?? 0) * alpha;
                g += (linear[data[at + 1] ?? 0] ?? 0) * alpha;
                b += (linear[data[at + 2] ?? 0] ?? 0) * alpha;
                a += alpha;
              }
            }
            colors.push(...(a > 0 ? [encode(r / a), encode(g / a), encode(b / a)] : [0, 0, 0]));
            let inside = 0;
            for (let v = 0; v < 8; v++) {
              for (let u = 0; u < 8; u++) {
                const px = ((i + (u + 0.5) / 8) / width) * 2 - 1;
                const py = ((j + (v + 0.5) / 8) / height) * 2 - 1;
                if (px * px + py * py <= 1) inside++;
              }
            }
            coverage.push(inside / 64);
          }
        }
        return { width, height, colors, coverage };
      };

      const image = new Image();
      image.src = url;
      await image.decode();
      const stillSide = image.naturalWidth;
      const stillPixels = pixels(image, stillSide);
      const stillDisc = disc(stillPixels, stillSide);
      const still = sizes.map(({ width, height }) =>
        sample(stillPixels, stillSide, stillDisc, width, height),
      );

      const shader = (await import(shaderUrl)) as typeof import('../packages/quicksilver/src/orb');
      const canvas = document.createElement('canvas');
      const result = shader.createOrbSurface(canvas, renderSize, 1);
      if (!result.ok) throw new Error(`Orb shader unavailable: ${result.failure.reason}`);
      let square: { x: number; y: number; side: number } | null = null;
      const frames = Array.from({ length: frameCount }, (_, index) => {
        const phase = (index / frameCount) * Math.PI * 2;
        // A cosine excursion returns to the rest frame with zero velocity at the seam.
        result.surface.draw(shader.ORB_REST_TIME + (1 - Math.cos(phase)) * 1.5);
        const data = pixels(canvas, renderSize);
        square ??= disc(data, renderSize);
        const fixed = square;
        return sizes.map(({ width, height }) => sample(data, renderSize, fixed, width, height));
      });
      result.surface.destroy();
      return { still, frames };
    },
    {
      url: `data:image/webp;base64,${source.toString('base64')}`,
      shaderUrl,
      frameCount,
      sizes,
      renderSize,
    },
  );

  const cells = ({ width, height, colors, coverage }: Sampled) => {
    const pixel = (x: number, y: number): readonly number[] | null => {
      const at = y * width + x;
      // A half cell has binary coverage: it is in the disc when most of it is.
      return y < height && (coverage[at] ?? 0) >= 0.5 ? colors.slice(at * 3, at * 3 + 3) : null;
    };
    const colored: string[] = [];
    const monochrome: string[] = [];
    const shades = [' ', '░', '▒', '▓', '█'];
    for (let y = 0; y < height; y += 2) {
      let color = '';
      let mono = '';
      for (let x = 0; x < width; x++) {
        const top = pixel(x, y);
        const bottom = pixel(x, y + 1);
        if (top !== null && bottom !== null) {
          color += `\x1b[38;2;${top.join(';')}m\x1b[48;2;${bottom.join(';')}m▀`;
        } else if (top !== null || bottom !== null) {
          color += `\x1b[49m\x1b[38;2;${(top ?? bottom ?? []).join(';')}m${top === null ? '▄' : '▀'}`;
        } else {
          color += '\x1b[49m ';
        }
        const covered = [top, bottom].filter((value) => value !== null);
        const luminance = covered.flat().reduce((sum, value) => sum + value, 0);
        mono +=
          covered.length === 0
            ? ' '
            : (shades[Math.min(4, 1 + Math.floor(luminance / (covered.length * 3 * 64)))] ?? '█');
      }
      colored.push(`${color}\x1b[m`);
      monochrome.push(mono);
    }
    return { width, height: height / 2, colored, monochrome };
  };
  const art = rasters.still.map(cells);
  const frames = rasters.frames.map((frame) => frame.map(cells));
  const large = art[0];
  const small = art[1];
  if (large === undefined || small === undefined) throw new Error('Orb rasters are missing');
  const rustString = (value: string): string =>
    JSON.stringify(value).replaceAll('\\u001b', '\\x1b');
  const rustArt = (name: string, size: number, value: typeof large): string =>
    `pub(super) const ${name}_WIDTH: u16 = ${value.width};\n` +
    `pub(super) const ${name}_HEIGHT: u16 = ${value.height};\n` +
    (['colored', 'monochrome'] as const)
      .map(
        (kind) =>
          `pub(super) static ${name}_${kind.toUpperCase()}: [[&str; ${value.height}]; FRAME_COUNT] = [\n${frames
            .map((frame) => {
              const art = frame[size];
              if (art === undefined) throw new Error('Orb animation size missing');
              return `    [\n${art[kind].map((row) => `        ${rustString(row)},`).join('\n')}\n    ],`;
            })
            .join('\n')}\n];\n`,
      )
      .join('\n');
  const header = `Generated by scripts/generate-cli-orb.ts from orb-still.webp. SHA-256: ${digest}`;
  writeFileSync(
    resolve(root, 'apps/tui/src/orb.rs'),
    `// Generated by scripts/generate-cli-orb.ts from the Merkur orb shader. SHA-256: ${shaderDigest}\n` +
      `// 48 frames, twelve per second, in one seamless four-second loop.\n\n` +
      `pub(super) const FRAME_COUNT: usize = ${frameCount};\n\n${rustArt('LARGE', 0, large)}\n${rustArt('SMALL', 1, small)}`,
  );
  writeFileSync(
    resolve(root, 'apps/daemon/src/cli/orb.ts'),
    `// ${header}\nexport const CLI_ORB =\n  '${large.colored.join('\n').replaceAll('\x1b', '\\u001b').replaceAll('\n', '\\n')}';\n`,
  );
  process.stdout.write('Generated native and command-help orb cells.\n');
} finally {
  await browser.close();
}
