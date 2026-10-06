// Selection-only worker: production still has one fixed tile representation.
import init, {
  GraphicsDecoder,
} from '../packages/graphics-codec-probe/pkg/graphics_codec_probe.js';
import initAssets, { GraphicsAssets } from '../packages/graphics-wasm/pkg/graphics_wasm.js';

interface Fixture {
  name: string;
  kind: string;
  side: number;
  stored: number;
  root: string;
  pngRoot: string;
}

interface Measurement {
  kind: string;
  side: number;
  codec: string;
  bytes: number;
  decodeMs: number;
  maxTileMs: number;
  tiles: number;
}

self.onmessage = async () => {
  try {
    const wasm = await init({ module_or_path: '/graphics_codec_probe_bg.wasm' });
    const decoder = new GraphicsDecoder();
    const assetsWasm = await initAssets({ module_or_path: '/graphics_wasm_bg.wasm' });
    const verifier = new GraphicsAssets();
    const fixtures = (await (await fetch('/fixtures/index.json')).json()) as Fixture[];
    const results = new Map<string, Measurement>();
    try {
      for (const fixture of fixtures) {
        const prefix = `/fixtures/${fixture.name}`;
        const [encoded, expected, fast, balanced, up, paeth, deflate] = await Promise.all([
          fetch(`${prefix}.tile`).then((r) => r.arrayBuffer()),
          fetch(`${prefix}.rgba`).then((r) => r.arrayBuffer()),
          fetch(`${prefix}-fast.png`).then((r) => r.blob()),
          fetch(`${prefix}-balanced.png`).then((r) => r.blob()),
          fetch(`${prefix}-fast-up.png`).then((r) => r.blob()),
          fetch(`${prefix}-fast-paeth.png`).then((r) => r.blob()),
          fetch(`${prefix}-libdeflate-1.png`).then((r) => r.blob()),
        ]);
        const root = Uint8Array.from(fixture.root.match(/../g) ?? [], (s) =>
          Number.parseInt(s, 16),
        );
        const bytes = new Uint8Array(encoded);
        const reference = new Uint8Array(expected);
        const pngBytes = new Uint8Array(await deflate.arrayBuffer());
        const pngRoot = Uint8Array.from(fixture.pngRoot.match(/../g) ?? [], (s) =>
          Number.parseInt(s, 16),
        );
        for (const [codec, blob] of [
          ['png-fast', fast],
          ['png-balanced', balanced],
          ['png-fast-up', up],
          ['png-fast-paeth', paeth],
          ['png-libdeflate-1', deflate],
          ['up-zstd-3', fast],
        ] as const) {
          const key = `${fixture.kind}/${fixture.side}/${codec}`;
          let result = results.get(key);
          if (result === undefined) {
            result = {
              kind: fixture.kind,
              side: fixture.side,
              codec,
              bytes: 0,
              decodeMs: 0,
              maxTileMs: 0,
              tiles: 0,
            };
            results.set(key, result);
          }
          result.bytes += codec === 'up-zstd-3' ? bytes.length : blob.size;
          result.tiles += 1;
          // Warm this input once, then include input copy, hash verification,
          // decode, unfilter and owned output copy for the WASM candidate.
          for (let iteration = 0; iteration < 4; iteration += 1) {
            const start = performance.now();
            let output: Uint8Array | null = null;
            let bitmap: ImageBitmap | null = null;
            if (codec === 'up-zstd-3') {
              new Uint8Array(wasm.memory.buffer, decoder.input_ptr(), bytes.length).set(bytes);
              new Uint8Array(wasm.memory.buffer, decoder.root_ptr(), 32).set(root);
              const length = decoder.decode(bytes.length, fixture.stored, fixture.stored);
              if (length !== reference.length)
                throw new Error(`tile decode failed: ${fixture.name}`);
              // Decode may grow private decoder history; refresh the memory view.
              output = new Uint8Array(wasm.memory.buffer, decoder.output_ptr(), length).slice();
            } else {
              if (codec === 'png-libdeflate-1') {
                new Uint8Array(assetsWasm.memory.buffer, verifier.root_ptr(), 32).set(pngRoot);
                if (!verifier.begin(pngBytes.length, fixture.stored, fixture.stored))
                  throw new Error('PNG verification begin');
                for (
                  let offset = 0;
                  offset < pngBytes.length;
                  offset += verifier.input_capacity()
                ) {
                  const chunk = pngBytes.subarray(offset, offset + verifier.input_capacity());
                  new Uint8Array(assetsWasm.memory.buffer, verifier.input_ptr(), chunk.length).set(
                    chunk,
                  );
                  if (!verifier.update(chunk.length)) throw new Error('PNG verification update');
                }
                if (!verifier.finish()) throw new Error('PNG commitment or envelope');
              }
              bitmap = await createImageBitmap(blob, {
                colorSpaceConversion: 'none',
                premultiplyAlpha: 'none',
              });
            }
            const elapsed = performance.now() - start;
            if (iteration > 0) {
              result.decodeMs += elapsed / 3;
              result.maxTileMs = Math.max(result.maxTileMs, elapsed);
            }
            if (output?.some((value, index) => value !== reference[index])) {
              throw new Error(`WASM byte mismatch: ${fixture.name}`);
            }
            if (bitmap !== null) {
              if (bitmap.width !== fixture.stored || bitmap.height !== fixture.stored)
                throw new Error('PNG shape');
              bitmap.close();
            }
          }
        }
      }
      self.postMessage({ results: Array.from(results.values()), userAgent: navigator.userAgent });
    } finally {
      decoder.free();
      verifier.free();
    }
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
