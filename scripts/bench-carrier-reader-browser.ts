/** Paired production CarrierReader batches in Chromium, Gecko and WebKit, with a null arm. */
import { chromium, firefox, webkit } from '@playwright/test';
import { carrierReaderSources } from './perf/carrier-reader-source';

interface BrowserSummary {
  median: number;
  min: number;
  max: number;
}
interface BrowserSample {
  before: number;
  after: number;
  delta: number;
  nullDelta: number;
}
interface BrowserCaseResult {
  mode: 'record' | 'exact';
  length: number;
  splits: number;
  before: BrowserSummary;
  after: BrowserSummary;
  delta: BrowserSummary;
  nullDelta: BrowserSummary;
  samples: BrowserSample[];
}

declare global {
  interface Window {
    reportCarrierCase(result: BrowserCaseResult): Promise<void>;
  }
}

const { production, comparison } = carrierReaderSources();

for (const engine of [chromium, firefox, webkit]) {
  if (process.env.BENCH_ENGINE !== undefined && process.env.BENCH_ENGINE !== engine.name())
    continue;
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.exposeFunction('reportCarrierCase', (result: BrowserCaseResult) => {
      process.stdout.write(
        `${JSON.stringify({ engine: engine.name(), version: browser.version(), result })}\n`,
      );
    });
    const results = await page.evaluate(
      async ({ production, comparison, selected }) => {
        const report = (result: BrowserCaseResult) => window.reportCarrierCase(result);
        type Reader = {
          record(): Promise<Uint8Array | null>;
          exact(length: number): Promise<Uint8Array | null>;
          dispose(): void;
        };
        type ReaderConstructor = {
          new (reader: ReadableStreamDefaultReader<Uint8Array>): Reader;
          prototype: Reader;
        };
        type Case = { mode: 'record' | 'exact'; length: number; splits: number };
        const constructors: ReaderConstructor[] = [
          new Function(comparison)(),
          new Function(production)(),
          new Function(comparison)(),
        ];
        const median = (values: number[]) =>
          values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

        function cases(): Case[] {
          const definitions: Case[] = [];
          for (const mode of ['record', 'exact'] as const)
            for (const length of [0, 64, 16_384])
              for (let splits = 0; splits < (mode === 'record' ? 8 : 1); splits++)
                definitions.push({ mode, length, splits });
          return definitions;
        }

        function chunks(definition: Case): Uint8Array[] {
          const { mode, length, splits } = definition;
          const bytes = new Uint8Array(length + (mode === 'record' ? 4 : 0)).fill(97);
          if (mode === 'exact') return [bytes];
          new DataView(bytes.buffer).setUint32(0, length);
          const parts: Uint8Array[] = [];
          let start = 0;
          for (let at = 1; at < 4; at++) {
            if ((splits & (1 << (at - 1))) === 0) continue;
            parts.push(bytes.subarray(start, at), new Uint8Array());
            start = at;
          }
          parts.push(bytes.subarray(start));
          return parts;
        }

        function newReader(
          Constructor: ReaderConstructor,
          parts: readonly Uint8Array[],
          count: number,
        ): Reader {
          const input = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let ordinal = 0; ordinal < count * parts.length; ordinal++) {
                const part = parts[ordinal % parts.length];
                if (part === undefined) throw new Error('missing carrier fixture chunk');
                controller.enqueue(part);
              }
              controller.close();
            },
          });
          const SharedReader = constructors[0];
          if (SharedReader === undefined) throw new Error('missing browser reader');
          const reader = new SharedReader(input.getReader());
          reader.record = Constructor.prototype.record;
          return reader;
        }

        async function runBatch(
          Constructor: ReaderConstructor,
          definition: Case,
          parts: readonly Uint8Array[],
          count: number,
        ): Promise<number> {
          const reader = newReader(Constructor, parts, count);
          let checksum = 0;
          const began = performance.now();
          for (let index = 0; index < count; index++) {
            const body =
              definition.mode === 'record'
                ? await reader.record()
                : await reader.exact(definition.length);
            if (
              body === null ||
              body.length !== definition.length ||
              (definition.length > 0 && body[0] !== 97)
            )
              throw new Error('carrier byte oracle diverged');
            checksum += body.length;
          }
          const elapsed = ((performance.now() - began) * 1_000_000) / count;
          if (checksum !== count * definition.length)
            throw new Error('carrier byte count diverged');
          reader.dispose();
          return elapsed;
        }

        async function measure(definition: Case) {
          const parts = chunks(definition);
          for (const Constructor of constructors)
            await runBatch(Constructor, definition, parts, 512);
          type Sample = { before: number; after: number; delta: number; nullDelta: number };
          const samples: Sample[] = [];
          for (let sample = 0; sample < 11; sample++) {
            const values: number[] = [];
            for (const arm of [0, 1, 1, 0, 0, 2, 2, 0]) {
              const Constructor = constructors[arm];
              if (Constructor === undefined) throw new Error('missing browser arm');
              values.push(await runBatch(Constructor, definition, parts, 128));
            }
            const average = (left: number, right: number) => {
              const first = values[left];
              const second = values[right];
              if (first === undefined || second === undefined)
                throw new Error('missing browser measurement');
              return (first + second) / 2;
            };
            samples.push({
              before: average(0, 3),
              after: average(1, 2),
              delta: average(1, 2) - average(0, 3),
              nullDelta: average(5, 6) - average(4, 7),
            });
          }
          const summary = (key: keyof (typeof samples)[number]) => {
            const values = samples.map((sample) => sample[key]);
            return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
          };
          return {
            ...definition,
            before: summary('before'),
            after: summary('after'),
            delta: summary('delta'),
            nullDelta: summary('nullDelta'),
            samples,
          };
        }

        const results = [];
        for (const definition of cases()) {
          if (
            selected !== undefined &&
            selected !== `${definition.mode}/${definition.length}/${definition.splits}`
          )
            continue;
          const result = await measure(definition);
          results.push(result);
          await report(result);
        }
        return results;
      },
      { production, comparison, selected: process.env.BENCH_BROWSER_CASE },
    );
    if (results.length === 0) throw new Error('no browser carrier cases selected');
  } finally {
    await browser.close();
  }
}
