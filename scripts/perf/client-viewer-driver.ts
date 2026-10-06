/** Production Rust viewer boundary used by browser component benchmarks. */
import { readFileSync } from 'node:fs';
import {
  ClientViewer,
  init_display_receiver_calibration,
  initSync,
} from '../../apps/web/src/term-wasm/pkg/term_wasm.js';
import {
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  writeU32BE,
} from '../../packages/shared/src';
import { ingressFixture } from '../term-wasm-ingress-fixture';

const runtime = initSync({
  module: readFileSync(
    new URL('../../apps/web/src/term-wasm/pkg/term_wasm_bg.wasm', import.meta.url),
  ),
});
export function createViewerDriver(cols = 120, rows = 40) {
  const viewer = new ClientViewer(init_display_receiver_calibration(cols, rows));
  viewer.set_presentation_ready(true);
  viewer.fence(0, 1);
  let sequence = 0;
  let outputs = 0;
  function drain(now: number) {
    while (viewer.poll_output(now) !== 0) outputs++;
  }
  function receive(bytes: Uint8Array, channel = 3, now = sequence + 1) {
    const pointer = viewer.reserve_ingress(bytes.length);
    if (pointer === 0) throw new Error('viewer ingress refused');
    new Uint8Array(runtime.memory.buffer, pointer, bytes.length).set(bytes);
    if (!viewer.receive(now, channel, bytes.length)) throw new Error('viewer boundary refused');
  }
  const snapshot = ingressFixture(cols, rows, rows, 0, false);
  snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
  receive(snapshot, 4, 0);
  viewer.present_now(0);
  drain(0);
  if (viewer.generation() !== 1) throw new Error('viewer snapshot was not admitted');
  return {
    viewer,
    memory: runtime.memory,
    receive,
    drain,
    apply(frame: Uint8Array, channel = 3) {
      sequence++;
      writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, sequence);
      receive(frame, channel, sequence);
      viewer.present_now(sequence);
      drain(sequence);
      if (viewer.applied_sequence() !== sequence)
        throw new Error(`viewer did not apply sequence ${sequence}`);
    },
    pollOutput(now: number) {
      const kind = viewer.poll_output(now);
      if (kind === 0) return null;
      return {
        kind,
        words: new Uint32Array(runtime.memory.buffer, viewer.output_words_ptr(), 7).slice(),
        bytes: new Uint8Array(
          runtime.memory.buffer,
          viewer.output_bytes_ptr(),
          viewer.output_bytes_len(),
        ).slice(),
      };
    },
    outputs: () => outputs,
    close() {
      viewer.free();
    },
  };
}
