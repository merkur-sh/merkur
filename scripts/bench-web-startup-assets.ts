import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';
import {
  terminalBlockingFontUrls,
  terminalPromotionFontUrls,
} from '../apps/web/src/terminal/font-loader';
import { DEFAULT_TERMINAL_FONT } from '../apps/web/src/terminal/fonts';
import { emitPerfMetric } from './perf/harness';

const ROOT = path.resolve(import.meta.dir, '..');
const PUBLIC_ROOT = path.join(ROOT, 'apps', 'web', 'public');
const PRODUCTION_BROTLI_QUALITY = 11;

// The critical path is the boot face; everything else lands after first paint.
const blockingAssets = await readLocalAssets(terminalBlockingFontUrls(DEFAULT_TERMINAL_FONT));
const backgroundAssets = await readLocalAssets(terminalPromotionFontUrls(DEFAULT_TERMINAL_FONT));
const allAssets = [...blockingAssets, ...backgroundAssets];
const allBrotliAssetBytes = await brotliByteLengths(allAssets, PRODUCTION_BROTLI_QUALITY);

const blockingRawBytes = byteLength(blockingAssets);
const blockingBrotliBytes = sumBytes(allBrotliAssetBytes.slice(0, blockingAssets.length));
const allRawBytes = byteLength(allAssets);
const allBrotliBytes = sumBytes(allBrotliAssetBytes);
const brotliReductionPercent =
  allBrotliBytes === 0 ? 0 : ((allBrotliBytes - blockingBrotliBytes) / allBrotliBytes) * 100;
const brotliCriticalFractionPercent =
  allBrotliBytes === 0 ? 0 : (blockingBrotliBytes / allBrotliBytes) * 100;

for (const metric of [
  {
    name: 'terminal-font-critical-path-asset-count',
    value: blockingAssets.length,
    unit: 'assets',
    direction: 'lower' as const,
  },
  {
    name: 'terminal-font-critical-path-raw-bytes',
    value: blockingRawBytes,
    unit: 'bytes',
    direction: 'lower' as const,
  },
  {
    name: 'terminal-font-critical-path-brotli-bytes',
    value: blockingBrotliBytes,
    unit: 'bytes',
    direction: 'lower' as const,
  },
  {
    name: 'terminal-font-total-raw-bytes',
    value: allRawBytes,
    unit: 'bytes',
    direction: 'lower' as const,
  },
  {
    name: 'terminal-font-total-brotli-bytes',
    value: allBrotliBytes,
    unit: 'bytes',
    direction: 'lower' as const,
  },
  {
    name: 'terminal-font-critical-path-brotli-fraction',
    value: brotliCriticalFractionPercent,
    unit: 'percent',
    direction: 'lower' as const,
  },
  {
    name: 'terminal-font-critical-path-brotli-reduction-vs-all-styles',
    value: brotliReductionPercent,
    unit: 'percent',
    direction: 'higher' as const,
  },
] as const) {
  emitPerfMetric({ ...metric, sampleSize: 1 });
}

process.stdout.write(
  `web startup assets: blocking=${blockingAssets.length}/${allAssets.length} ` +
    `raw=${blockingRawBytes}/${allRawBytes}B brotli-q${PRODUCTION_BROTLI_QUALITY}=` +
    `${blockingBrotliBytes}/${allBrotliBytes}B ` +
    `critical-reduction=${brotliReductionPercent.toFixed(2)}%\n`,
);

async function readLocalAssets(urls: readonly string[]): Promise<readonly Uint8Array[]> {
  return Promise.all(
    urls.map(async (assetUrl) => {
      const url = new URL(assetUrl, 'https://merkur.local');
      if (url.origin !== 'https://merkur.local' || !url.pathname.startsWith('/fonts/')) {
        throw new Error(`startup asset benchmark requires a local font URL: ${assetUrl}`);
      }

      const assetPath = path.join(PUBLIC_ROOT, decodeURIComponent(url.pathname));
      const relativePath = path.relative(PUBLIC_ROOT, assetPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`startup asset escapes the web public directory: ${assetUrl}`);
      }
      return readFile(assetPath);
    }),
  );
}

function byteLength(assets: readonly Uint8Array[]): number {
  return assets.reduce((total, asset) => total + asset.byteLength, 0);
}

function sumBytes(lengths: readonly number[]): number {
  return lengths.reduce((total, length) => total + length, 0);
}

async function brotliByteLengths(
  assets: readonly Uint8Array[],
  quality: number,
): Promise<readonly number[]> {
  const compress = promisify(brotliCompress);
  const compressed = await Promise.all(
    assets.map((asset) =>
      compress(asset, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
        },
      }),
    ),
  );
  return compressed.map((asset) => asset.byteLength);
}
