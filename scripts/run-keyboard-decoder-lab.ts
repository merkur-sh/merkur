/**
 * Runs the decoder lab and prints a comparison table.
 *
 *   bun run scripts/run-keyboard-decoder-lab.ts
 *   bun run scripts/run-keyboard-decoder-lab.ts --corpus path/to/commands.txt
 *   bun run scripts/run-keyboard-decoder-lab.ts --json
 *
 * The corpus supplies the causal character prior. It defaults to this
 * repository's own terminal text — every fenced code block in the docs plus
 * every package.json script body — because that is real shell input rather than
 * English prose, and the character statistics of the two differ enough to change
 * the answer. Pass `--corpus` to score against your own shell history.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTACT_ONLY_DECODER,
  createAnchorCommitDecoder,
  createCharacterResolver,
  createLabContext,
  createPriorDecoder,
  createRandomSource,
  type Decoder,
  evaluateSequence,
  generateTouch,
  integrateAccuracy,
  NO_CLIFF_DECODER,
  oracleContains,
  RELEASE_ONLY_DECODER,
  SHIPPED_DECODER,
  TOUCH_MODELS,
} from './keyboard-decoder-lab';

const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
const corpusIndex = arguments_.indexOf('--corpus');
const corpusPath = corpusIndex >= 0 ? arguments_[corpusIndex + 1] : undefined;
const seedIndex = arguments_.indexOf('--seed');
const seed = seedIndex >= 0 ? Number(arguments_[seedIndex + 1]) : 0x4d45_5243;

const context = createLabContext();
const resolve = createCharacterResolver(context.geometry);
const letters = context.geometry.keys.filter((key) => key.definition.id.startsWith('key-'));

const corpus = corpusPath === undefined ? loadRepositoryCorpus() : readFileSync(corpusPath, 'utf8');
const { priorFor, alphabetSize, bigramCount, frequencies } = buildCharacterPrior(corpus);

const decoders: Decoder[] = [
  SHIPPED_DECODER,
  NO_CLIFF_DECODER,
  CONTACT_ONLY_DECODER,
  RELEASE_ONLY_DECODER,
  // What the engine does now: an anchored contact is final at touch-down, so
  // this is `contact-only` on the anchored share and `shipped` everywhere else.
  // It must never score below `shipped`.
  createAnchorCommitDecoder(0),
  createPriorDecoder(0.5),
  createPriorDecoder(1),
  createPriorDecoder(2),
];

// The evaluation text is held out from the prior's corpus so the prior is not
// scored on text it memorised.
const EVALUATION_TEXT = [
  'git status',
  'cd apps/daemon && cargo build --release',
  'grep -rn "displayAck" packages/protocol/src',
  'bun run check:types',
  'ls -la /var/log/merkur',
  'kubectl get pods -n production',
  'ssh deploy@edge-01.internal',
  'tail -f /tmp/dataplane.log | grep -i error',
  'rm -rf node_modules && bun install',
  'docker compose up -d redis',
  'export MERKUR_LOG_LEVEL=debug',
  'curl -s https://localhost:8443/health | jq .status',
].join('\n');

const report = {
  corpus: {
    source: corpusPath ?? 'repository terminal text (docs code fences + package.json scripts)',
    characters: corpus.length,
    alphabetSize,
    bigramCount,
  },
  evaluationCharacters: EVALUATION_TEXT.length,
  integration: [] as Array<Record<string, unknown>>,
  sequence: [] as Array<Record<string, unknown>>,
};

// ---- Exact integration: pure geometry, weighted by real key frequency -----
// Context-dependent priors are deliberately excluded here. A prior's whole value
// is that it changes with the preceding character, and this evaluator has no
// sequence, so scoring one here would measure a context-free bias toward common
// keys rather than the mechanism we care about. Priors are scored below.
for (const parameters of TOUCH_MODELS) {
  const result = integrateAccuracy(
    context,
    CONTACT_ONLY_DECODER,
    parameters,
    letters,
    0.5,
    frequencies,
  );
  report.integration.push({
    touchModel: parameters.id,
    source: parameters.source,
    decoder: CONTACT_ONLY_DECODER.id,
    accuracy: result.accuracy,
    errorsPer40: (1 - result.accuracy) * 40,
    worstKeys: [...result.byKey.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, 5)
      .map(([id, accuracy]) => `${id}:${(accuracy * 100).toFixed(1)}%`),
  });
}

// ---- Sequence replay: every decoder, identical taps -----------------------
for (const parameters of TOUCH_MODELS) {
  const results = evaluateSequence(
    decoders,
    {
      context,
      parameters,
      text: EVALUATION_TEXT,
      seed,
      priorFor,
    },
    resolve,
  );

  // Oracle upper bounds on the same taps.
  const oracle = [2, 4].map((k) => {
    const random = createRandomSource(seed);
    let taps = 0;
    let hit = 0;
    for (let index = 0; index < EVALUATION_TEXT.length; index += 1) {
      const intended = resolve(EVALUATION_TEXT[index] ?? '');
      if (intended === undefined) continue;
      const nextCharacter = EVALUATION_TEXT[index + 1];
      const next = nextCharacter === undefined ? undefined : resolve(nextCharacter);
      const touch = generateTouch(parameters, intended, next, random);
      taps += 1;
      if (oracleContains(context.geometry, k, touch.downX, touch.downY, intended.index)) hit += 1;
    }
    return { decoderId: `oracle-top${k}`, taps, accuracy: taps === 0 ? 0 : hit / taps };
  });

  for (const result of [...results, ...oracle]) {
    report.sequence.push({
      touchModel: parameters.id,
      decoder: result.decoderId,
      accuracy: result.accuracy,
      errorsPer40: (1 - result.accuracy) * 40,
      topConfusions: 'confusions' in result ? result.confusions.slice(0, 3) : [],
    });
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  print();
}

function print(): void {
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
  process.stdout.write(
    `Merkur keyboard decoder lab\n` +
      `corpus=${report.corpus.source}\n` +
      `  ${report.corpus.characters.toLocaleString('en-US')} chars, ` +
      `${report.corpus.alphabetSize} symbols, ${report.corpus.bigramCount.toLocaleString('en-US')} bigrams\n` +
      `evaluation text = ${report.evaluationCharacters} chars of held-out shell commands\n\n`,
  );

  process.stdout.write('Exact integration (contact-point decoders, no sampling noise)\n');
  let lastModel = '';
  for (const row of report.integration) {
    const model = String(row.touchModel);
    if (model !== lastModel) {
      const source = report.integration.find((r) => r.touchModel === model)?.source;
      process.stdout.write(`  ${model}  [${String(source)}]\n`);
      lastModel = model;
    }
    process.stdout.write(
      `    ${String(row.decoder).padEnd(14)} ${percent(Number(row.accuracy)).padStart(7)}  ` +
        `${Number(row.errorsPer40).toFixed(2)} errors per 40 chars\n`,
    );
  }

  process.stdout.write('\nSequence replay over held-out shell commands (paired taps)\n');
  lastModel = '';
  for (const row of report.sequence) {
    const model = String(row.touchModel);
    if (model !== lastModel) {
      process.stdout.write(`  ${model}\n`);
      lastModel = model;
    }
    const confusions = Array.isArray(row.topConfusions)
      ? (row.topConfusions as Array<{ intended: string; predicted: string; count: number }>)
          .map((c) => `${c.intended}->${c.predicted}x${c.count}`)
          .join(' ')
      : '';
    process.stdout.write(
      `    ${String(row.decoder).padEnd(14)} ${percent(Number(row.accuracy)).padStart(7)}  ` +
        `${Number(row.errorsPer40).toFixed(2)} err/40  ${confusions}\n`,
    );
  }

  process.stdout.write(
    '\nThese are synthetic taps drawn from a parametric model. For a question about\n' +
      'the decoder, prefer `bun run simulate:keyboard-replay`, which replays measured\n' +
      'human taps, and its engine-driven mode, which exercises the sample ring and\n' +
      'the release ramp rather than calling the classifier directly.\n',
  );
}

/** Character bigram prior with add-k smoothing, over the keys the layer can type. */
function buildCharacterPrior(text: string): {
  priorFor: (history: string) => Float64Array | undefined;
  alphabetSize: number;
  bigramCount: number;
  frequencies: ReadonlyMap<string, number>;
} {
  const keyCount = context.geometry.keys.length;
  const indexForCharacter = new Map<string, number>();
  for (const key of context.geometry.keys) {
    const value = key.definition.id === 'space' ? ' ' : key.definition.value;
    if (value !== undefined && value.length === 1 && !indexForCharacter.has(value)) {
      indexForCharacter.set(value, key.index);
    }
  }

  const unigram = new Float64Array(keyCount);
  const bigram = new Map<string, Float64Array>();
  let bigramCount = 0;
  let previous = ' ';
  for (const rawCharacter of text.toLowerCase()) {
    const character = rawCharacter === '\n' || rawCharacter === '\t' ? ' ' : rawCharacter;
    const index = indexForCharacter.get(character);
    if (index !== undefined) {
      unigram[index] = (unigram[index] ?? 0) + 1;
      let row = bigram.get(previous);
      if (row === undefined) {
        row = new Float64Array(keyCount);
        bigram.set(previous, row);
      }
      row[index] = (row[index] ?? 0) + 1;
      bigramCount += 1;
    }
    previous = character;
  }

  const SMOOTHING = 0.5;
  const logFrom = (counts: Float64Array): Float64Array => {
    let total = 0;
    for (let index = 0; index < keyCount; index += 1) total += (counts[index] ?? 0) + SMOOTHING;
    const out = new Float64Array(keyCount);
    for (let index = 0; index < keyCount; index += 1) {
      out[index] = Math.log(((counts[index] ?? 0) + SMOOTHING) / total);
    }
    return out;
  };

  const unigramLog = logFrom(unigram);
  const cache = new Map<string, Float64Array>();
  for (const [character, counts] of bigram) cache.set(character, logFrom(counts));

  const frequencies = new Map<string, number>();
  for (const key of context.geometry.keys) {
    frequencies.set(key.definition.id, unigram[key.index] ?? 0);
  }

  return {
    alphabetSize: indexForCharacter.size,
    bigramCount,
    frequencies,
    priorFor(history: string): Float64Array {
      const last = history.length === 0 ? ' ' : (history[history.length - 1] ?? ' ').toLowerCase();
      return cache.get(last) ?? unigramLog;
    },
  };
}

/** Terminal text from this repository: docs code fences plus package.json scripts. */
function loadRepositoryCorpus(): string {
  const root = join(import.meta.dir, '..');
  const parts: string[] = [];

  for (const relative of ['docs', '.']) {
    const directory = join(root, relative);
    let entries: string[] = [];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const path = join(directory, entry);
      try {
        if (!statSync(path).isFile()) continue;
        parts.push(...extractFencedBlocks(readFileSync(path, 'utf8')));
      } catch {}
    }
  }

  for (const relative of ['package.json', 'apps/web/package.json', 'apps/server/package.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(root, relative), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'scripts' in parsed) {
        const scripts = (parsed as { scripts?: Record<string, string> }).scripts ?? {};
        for (const command of Object.values(scripts)) parts.push(command);
      }
    } catch {}
  }

  if (parts.length === 0) throw new Error('No corpus text found; pass --corpus explicitly');
  return parts.join('\n');
}

function extractFencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let inside = false;
  let current: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (inside) {
        blocks.push(current.join('\n'));
        current = [];
      }
      inside = !inside;
      continue;
    }
    if (inside) current.push(line);
  }
  return blocks;
}
