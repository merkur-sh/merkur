import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';

import {
  readSiteManifest,
  type SiteManifest,
  siteDocuments,
  writeSiteManifest,
} from '../apps/site/server/manifest';

/**
 * `bun run scripts/compress-site.ts <dist directory>`
 *
 * Writes a quality-11 Brotli sibling (`<file>.br`) for every document and
 * every manifest file whose format is not already compressed, then records
 * `brotli: true` on those manifest entries. The static server reads the flag
 * and never probes for a sibling. Documents are HTML, so they are always
 * compressed and carry no flag.
 *
 * Runs after the page build has written `site-manifest.json` and before the
 * server is compiled; it is idempotent.
 */
const compress = promisify(brotliCompress);

/** Formats whose own encoding leaves Brotli nothing to take. */
const PRECOMPRESSED_MEDIA_TYPES = new Set([
  'font/woff2',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const BROTLI_EXTENSION = '.br';

export function brotliCompressible(contentType: string): boolean {
  return !PRECOMPRESSED_MEDIA_TYPES.has(mediaType(contentType));
}

export async function compressSite(distDirectory: string): Promise<SiteManifest> {
  const manifest = await readSiteManifest(distDirectory);
  const targets = new Map<string, number>();
  for (const document of siteDocuments(manifest)) {
    targets.set(document, constants.BROTLI_MODE_TEXT);
  }
  for (const entry of manifest.files) {
    if (brotliCompressible(entry.contentType)) {
      targets.set(entry.file, brotliMode(entry.contentType));
    }
  }
  await Promise.all(
    [...targets].map(async ([file, mode]) => {
      const source = path.join(distDirectory, file);
      const bytes = await Bun.file(source).bytes();
      const compressed = await compress(bytes, {
        params: {
          [constants.BROTLI_PARAM_MODE]: mode,
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
        },
      });
      await Bun.write(`${source}${BROTLI_EXTENSION}`, compressed);
    }),
  );
  const compressed: SiteManifest = {
    ...manifest,
    files: manifest.files.map((entry) => ({
      ...entry,
      brotli: brotliCompressible(entry.contentType),
    })),
  };
  await writeSiteManifest(distDirectory, compressed);
  return compressed;
}

function mediaType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

function brotliMode(contentType: string): number {
  const type = mediaType(contentType);
  if (type.startsWith('font/')) {
    return constants.BROTLI_MODE_FONT;
  }
  if (
    type.startsWith('text/') ||
    type.endsWith('/javascript') ||
    type.endsWith('/json') ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  ) {
    return constants.BROTLI_MODE_TEXT;
  }
  return constants.BROTLI_MODE_GENERIC;
}

if (import.meta.main) {
  const [distDirectory, ...extra] = process.argv.slice(2);
  if (distDirectory === undefined || extra.length > 0) {
    process.stderr.write('usage: bun run scripts/compress-site.ts <dist directory>\n');
    process.exit(2);
  }
  const manifest = await compressSite(distDirectory);
  const compressedFiles = manifest.files.filter((entry) => entry.brotli).length;
  process.stdout.write(
    `compressed ${siteDocuments(manifest).length} documents and ${compressedFiles} of ${manifest.files.length} files\n`,
  );
}
