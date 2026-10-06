/**
 * Cuts the site's faces from Quicksilver's and records what each holds.
 *
 * Quicksilver's latin faces hold every weight of Geist and JetBrains Mono and
 * every latin glyph of Instrument Serif. The pages set far less, so each face
 * is cut to the characters the built pages and their script actually use
 * (Geist and JetBrains Mono also keep all of printable ASCII), and the two
 * variable faces to the weight range the pages set, by fontTools, from the
 * files Quicksilver ships. The terminal marks neither face has are cut from
 * the app terminal's own face as `Merkur Terminal`, and what that face lacks
 * too is recorded as drawn by the platform.
 *
 * Writes `src/fonts/<face>.woff2` and `src/fonts/subset.json`, which
 * `uno.config.ts` declares the faces from and `fontCoverage()` checks every
 * build against. Run it after the copy changes and commit what it writes:
 *
 *   MERKUR_SITE_RYBBIT_SITE_ID=placeholder bun run --cwd apps/site build   # may stop on coverage
 *   bun run --cwd apps/site subset-fonts
 *
 * It needs Python 3 with fontTools and brotli (`pip install fonttools brotli`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BLOG_FONT_SUBSETS,
  blogPagesOf,
  builtPages,
  classCharacters,
  FONT_SUBSETS,
  pageCharacters,
  SERIF_CLASSES,
  SERIF_FACE,
  SERIF_ITALIC_CLASSES,
  SERIF_ITALIC_FACE,
  TERMINAL_FACE,
  terminalCharacters,
} from '../src/vite/font-coverage';

const at = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const PRINTABLE_ASCII = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
  String.fromCharCode(0x20 + index),
).join('');

async function python(program: string, job: unknown, what: string): Promise<Uint8Array> {
  const child = Bun.spawn(['python3', '-c', program], {
    stdin: Buffer.from(JSON.stringify(job)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`subset-fonts: fontTools failed on ${what}:\n${stderr}`);
  return stdout;
}

const COVERED = `
import json, sys
from fontTools.ttLib import TTFont
job = json.loads(sys.stdin.read())
cmap = TTFont(job["source"], lazy=True).getBestCmap()
sys.stdout.write(json.dumps("".join(c for c in job["text"] if ord(c) in cmap)))
`;

/** The characters of `text` the face at `source` has a glyph for. */
async function covered(source: string, text: string): Promise<string> {
  const out = await python(COVERED, { source: at(`../../${source}`), text }, source);
  return JSON.parse(new TextDecoder().decode(out)) as string;
}

const faceOf = (file: string) => {
  const face = FONT_SUBSETS.find((entry) => entry.file === file);
  if (face === undefined) throw new Error(`subset-fonts: no face ${file}`);
  return face;
};

const pages = builtPages(at('dist'));
const text = [...new Set(PRINTABLE_ASCII + pageCharacters(at('dist'), pages))].sort().join('');
/** What the blog's pages set: the reading face is cut to it, and to nothing of the other pages. */
const reading = pageCharacters(at('dist'), blogPagesOf(pages));
const readingText = [...new Set(PRINTABLE_ASCII + reading)].sort().join('');
const wanted: Readonly<Record<string, string>> = {
  [SERIF_FACE]: classCharacters(at('dist'), SERIF_CLASSES),
  [SERIF_ITALIC_FACE]: classCharacters(at('dist'), SERIF_ITALIC_CLASSES),
};
const marks = terminalCharacters(at('dist'));
const terminal = await covered(faceOf(TERMINAL_FACE).source, marks);
const platform = [...marks].filter((character) => !terminal.includes(character)).join('');

const SUBSET = `
import io, json, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset
job = json.loads(sys.stdin.read())
font = TTFont(job["source"], lazy=False)
options = subset.Options()
options.layout_features = ["*"]
subsetter = subset.Subsetter(options)
subsetter.populate(text=job["text"])
subsetter.subset(font)
limits = {}
if job["weight"] is not None:
    low, high = job["weight"]
    limits["wght"] = low if low == high else (low, high)
if job["opticalSize"] is not None:
    limits["opsz"] = job["opticalSize"]
if limits:
    font = instancer.instantiateVariableFont(font, limits)
font.flavor = "woff2"
out = io.BytesIO()
font.save(out)
sys.stdout.buffer.write(out.getvalue())
`;

mkdirSync(at('src/fonts'), { recursive: true });
const record: Record<string, unknown> = {};
for (const face of [...FONT_SUBSETS, ...BLOG_FONT_SUBSETS]) {
  const source = at(`../../${face.source}`);
  const ofBlog = BLOG_FONT_SUBSETS.includes(face);
  const characters = await covered(
    face.source,
    face.file === TERMINAL_FACE ? terminal : ofBlog ? readingText : (wanted[face.file] ?? text),
  );
  const cut = await python(
    SUBSET,
    {
      source,
      text: characters,
      weight: face.weight?.split(' ').map(Number) ?? null,
      opticalSize: face.opticalSize ?? null,
    },
    face.file,
  );
  writeFileSync(at(`src/fonts/${face.file}`), cut);
  record[face.file] = {
    family: face.family,
    weight: face.weight ?? '400',
    source: face.source,
    sourceSha256: sha256(readFileSync(source)),
    sha256: sha256(cut),
    bytes: cut.byteLength,
    characters,
    ...(face.file === TERMINAL_FACE ? { platform } : {}),
    ...(ofBlog
      ? { lacking: [...reading].filter((character) => !characters.includes(character)).join('') }
      : {}),
  };
}
writeFileSync(at('src/fonts/subset.json'), `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(
  `subset-fonts: ${[...FONT_SUBSETS, ...BLOG_FONT_SUBSETS].map((face) => face.file).join(', ')}; serif set by ${[...SERIF_CLASSES, ...SERIF_ITALIC_CLASSES].join(', ')}\n`,
);
