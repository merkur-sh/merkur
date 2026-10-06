/**
 * Before-cutover boundary measurement. JSC runs production WASM with identical
 * frames in both arms. The terminal arm stages/validates/applies/releases;
 * the viewer arm also runs Rust lineage, FEC and presentation admission.
 * This measures component cost, not network, worker, GPU or input-to-photon latency.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ClientViewer, init_regular, initSync } from '../apps/web/src/term-wasm/pkg/term_wasm.js';
import {
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  writeU32BE,
} from '../packages/shared/src';
import { perfEnvInteger, summarizeSamples } from './perf/harness';
import { ingressFixture } from './term-wasm-ingress-fixture';

const samples = perfEnvInteger('BENCH_SAMPLES', 1000, 100);
const [wasmBytes, font] = await Promise.all([
  readFile(new URL('../apps/web/src/term-wasm/pkg/term_wasm_bg.wasm', import.meta.url)),
  readFile(new URL('../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf', import.meta.url)),
]);
const runtime = initSync({ module: wasmBytes });
const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');
for (const dirtyRows of [0, 1, 8, 36]) {
  for (const styled of dirtyRows === 0 ? [false] : [false, true]) {
    const terminal = init_regular(1200, 720, font, 14, 1.2, 1);
    const viewer = new ClientViewer(init_regular(1200, 720, font, 14, 1.2, 1));
    const terminalSamples: number[] = [];
    const viewerSamples: number[] = [];
    const snapshot = ingressFixture(120, 36, 36, 0, styled);
    snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    const phases = [0, 1].map((phase) => ingressFixture(120, 36, dirtyRows, phase, styled));
    const maximum = Math.max(snapshot.byteLength, ...phases.map((frame) => frame.byteLength));
    const terminalPointer = terminal.reserve_display_frame_input(maximum);
    const viewerPointer = viewer.reserve_ingress(maximum);
    if (terminalPointer === 0 || viewerPointer === 0)
      throw new Error('ingress reservation refused');
    try {
      viewer.fence(0, 1);
      while (viewer.poll_output(0) !== 0) {}
      if (!terminal.apply_state_seq(snapshot, 0)) throw new Error('snapshot oracle refused');
      new Uint8Array(runtime.memory.buffer, viewerPointer, snapshot.byteLength).set(snapshot);
      if (!viewer.receive(0, 4, snapshot.byteLength)) throw new Error('snapshot boundary refused');
      viewer.present_now(0);
      terminal.commit_presentation_state();
      let oracleChecks = 0;
      for (let ordinal = 0; ordinal < samples + 100; ordinal += 1) {
        const frame = phases[ordinal % 2];
        if (frame === undefined) throw new Error('missing phase');
        const seq = ordinal + 1;
        writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, seq);
        for (const arm of ordinal % 2 === 0 ? ['terminal', 'viewer'] : ['viewer', 'terminal']) {
          const started = performance.now();
          if (arm === 'terminal') {
            new Uint8Array(runtime.memory.buffer, terminalPointer, frame.byteLength).set(frame);
            const handle = terminal.stage_display_frame_input(frame.byteLength);
            if (handle === 0) throw new Error('terminal stage refused');
            try {
              if (!terminal.validate_staged_frame(handle))
                throw new Error('terminal validation refused');
              if (!terminal.apply_staged_delta_seq(handle, seq))
                throw new Error('terminal apply refused');
            } finally {
              terminal.release_staged_frame(handle);
            }
          } else {
            new Uint8Array(runtime.memory.buffer, viewerPointer, frame.byteLength).set(frame);
            if (!viewer.receive(ordinal + 1, 3, frame.byteLength))
              throw new Error('viewer boundary refused');
          }
          const elapsed = performance.now() - started;
          if (ordinal >= 100) (arm === 'terminal' ? terminalSamples : viewerSamples).push(elapsed);
        }
        // Presentation, ACK serialization and oracle work are outside ingress timing.
        viewer.present_now(ordinal + 1);
        terminal.commit_presentation_state();
        while (viewer.poll_output(ordinal + 1) !== 0) {}
        for (let row = 0; row < 36; row += 1) {
          if (terminal.row_hash(row) !== viewer.row_hash(row)) {
            throw new Error(`authority mismatch at sample ${ordinal}, row ${row}`);
          }
          if (terminal.display_row_version(row) !== viewer.display_row_version(row)) {
            throw new Error(`row sequence mismatch at sample ${ordinal}, row ${row}`);
          }
        }
        if (terminal.presentation_viewport_rows() !== viewer.presentation_viewport_rows()) {
          throw new Error(`presentation mismatch at sample ${ordinal}`);
        }
        oracleChecks += 1;
      }
      process.stdout.write(
        `${JSON.stringify({
          engine: 'Bun/JSC',
          wasmSha256,
          dirtyRows,
          styled,
          payloadBytes: phases[0]?.byteLength,
          samples,
          warmups: 100,
          oracleChecks,
          unit: 'ms/datagram',
          terminal: summarizeSamples(terminalSamples),
          viewer: summarizeSamples(viewerSamples),
          scope:
            'staged terminal boundary versus shared viewer ingress; excludes TS receive logic and presentation/ACK work',
        })}\n`,
      );
    } finally {
      viewer.free();
      terminal.free();
    }
  }
}
