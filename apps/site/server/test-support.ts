import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '@merkur/logger';

import { compressSite } from '../../../scripts/compress-site';
import { SITE_MANIFEST_FILE, type SiteManifest } from './manifest';

/**
 * A built site in miniature: three documents, a hashed script, a font, a
 * replay recording and a mutable text file, compressed by the real
 * `scripts/compress-site.ts` step.
 */
export interface FixtureSite {
  readonly distDirectory: string;
  readonly styleHashes: readonly string[];
  /** The identity bytes of a file the fixture wrote, by its path in `dist`. */
  fileBytes(file: string): Uint8Array<ArrayBuffer>;
}

export const FIXTURE_PATHS = {
  script: '/assets/main-Ab12Cd34.js',
  font: '/fonts/Inter-Var.woff2',
  recording: '/replay/hero-Zx98Yw76.mrec',
  robots: '/robots.txt',
} as const;

const HOME_STYLE = 'body{color:#0b0b0f;background:#f4f4f6}';
const SECURITY_STYLE = 'main{max-width:72ch}';

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

export async function writeFixtureSite(): Promise<FixtureSite> {
  const distDirectory = await mkdtemp(path.join(os.tmpdir(), 'merkur-site-dist-'));
  const encoder = new TextEncoder();
  const document = (title: string, style: string) =>
    encoder.encode(
      `<!doctype html><html lang="en"><head><title>${title}</title><style>${style}</style></head>` +
        `<body><h1>${title}</h1>${'<p>Your terminal, from any browser.</p>'.repeat(20)}` +
        `<script type="module" src="${FIXTURE_PATHS.script}"></script></body></html>`,
    );
  const bytes: Record<string, Uint8Array<ArrayBuffer>> = {
    'index.html': document('Merkur', HOME_STYLE),
    'security.html': document('Security', SECURITY_STYLE),
    '404.html': document('Not found', HOME_STYLE),
    'assets/main-Ab12Cd34.js': encoder.encode(
      `export const frames = ${JSON.stringify(Array.from({ length: 200 }, (_, index) => index))};\n`,
    ),
    'fonts/Inter-Var.woff2': Uint8Array.from({ length: 512 }, (_, index) => (index * 97) % 256),
    'replay/hero-Zx98Yw76.mrec': Uint8Array.from({ length: 4096 }, (_, index) => index % 7),
    'robots.txt': encoder.encode('User-agent: *\nAllow: /\n'),
  };
  for (const [file, content] of Object.entries(bytes)) {
    await Bun.write(path.join(distDirectory, file), content);
  }
  const styleHashes = [HOME_STYLE, SECURITY_STYLE].map(
    (style) => `sha256-${createHash('sha256').update(style, 'utf8').digest('base64')}`,
  );
  const manifest: SiteManifest = {
    routes: { '/': 'index.html', '/security': 'security.html' },
    notFound: '404.html',
    files: [
      {
        path: FIXTURE_PATHS.script,
        file: 'assets/main-Ab12Cd34.js',
        contentType: 'text/javascript; charset=utf-8',
        immutable: true,
        brotli: false,
      },
      {
        path: FIXTURE_PATHS.font,
        file: 'fonts/Inter-Var.woff2',
        contentType: 'font/woff2',
        immutable: true,
        brotli: false,
      },
      {
        path: FIXTURE_PATHS.recording,
        file: 'replay/hero-Zx98Yw76.mrec',
        contentType: 'application/octet-stream',
        immutable: true,
        brotli: false,
      },
      {
        path: FIXTURE_PATHS.robots,
        file: 'robots.txt',
        contentType: 'text/plain; charset=utf-8',
        immutable: false,
        brotli: false,
      },
    ],
    styleHashes,
  };
  await Bun.write(path.join(distDirectory, SITE_MANIFEST_FILE), JSON.stringify(manifest));
  await compressSite(distDirectory);
  return {
    distDirectory,
    styleHashes,
    fileBytes(file) {
      const content = bytes[file];
      if (content === undefined) {
        throw new Error(`the fixture wrote no ${file}`);
      }
      return content;
    },
  };
}

export interface RawResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/**
 * One HTTP/1.1 exchange written byte for byte, for what `fetch` would
 * normalize or refuse to send: dot segments, hop-by-hop fields, chunked bodies.
 */
export function rawRequest(port: number, request: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    // The response is complete at its Content-Length (every response here has
    // one); the server may keep the connection open after it.
    const complete = (): RawResponse | null => {
      const text = Buffer.concat(chunks).toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      if (split < 0) {
        return null;
      }
      const [statusLine = '', ...headerLines] = text.slice(0, split).split('\r\n');
      const headers = new Map<string, string>();
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const body = text.slice(split + 4);
      const length = Number(headers.get('content-length') ?? 0);
      if (body.length < length) {
        return null;
      }
      return { status: Number(statusLine.split(' ')[1]), headers, body: body.slice(0, length) };
    };
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const response = complete();
      if (response !== null) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('connection closed before a complete response')));
  });
}

/** A port nothing listens on: bound by the kernel, then released. */
export function closedPort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) {
    throw new Error('probe server has no port');
  }
  return port;
}
