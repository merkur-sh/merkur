import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRANSPORT_CHANNEL_ID } from '@merkur/shared';
import {
  init_display_receiver_calibration,
  initSync,
} from '../apps/web/src/term-wasm/pkg/term_wasm.js';
import { createWasmClientViewerHandleFromInstance } from '../apps/web/src/wasm-loader';
import { generateClientFecFixture } from './perf/client-session-fixture';
import { emitPerfMetric } from './perf/harness';

const FRAMES = Number(process.env.BENCH_FRAMES ?? 100_000);
assert(
  Number.isSafeInteger(FRAMES) && FRAMES > 0 && FRAMES <= 0xffff_fffc && FRAMES % 4 === 0,
  'BENCH_FRAMES must be a positive u32 divisible by four',
);
// Native codec/parity generation and JS fixture allocation stay outside timing.
const fixture = await generateClientFecFixture(FRAMES);
const bytes = Uint8Array.from(Buffer.from(fixture.payload, 'base64'));
const frames: Uint8Array[] = [];
const lengths = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
for (let offset = 0; offset < bytes.length; ) {
  assert(offset + 4 <= bytes.length, 'fixture frame length');
  const length = lengths.getUint32(offset);
  offset += 4;
  assert(length > 0 && offset + length <= bytes.length, 'fixture frame extent');
  frames.push(bytes.subarray(offset, offset + length));
  offset += length;
}
assert.equal(frames.length, FRAMES + 1);
const runtime = initSync({
  module: readFileSync(new URL('../apps/web/src/term-wasm/pkg/term_wasm_bg.wasm', import.meta.url)),
});
const mapping = { epoch: 1, localMinusWire: 0, wireMin: 1, wireMax: 0xffff_ffff };

function exercise(count: number) {
  const terminal = createWasmClientViewerHandleFromInstance(
    runtime.memory,
    init_display_receiver_calibration(fixture.cols, fixture.rows),
  );
  const viewer = terminal.viewer;
  viewer.fence(0, 1);
  let outputs = 0;
  let payloadBytes = 0;
  // Include the production output bridge copies, but exclude real transport I/O.
  function drain(now: number): void {
    for (let kind = viewer.poll_output(now); kind !== 0; kind = viewer.poll_output(now)) {
      const words = new Uint32Array(runtime.memory.buffer, viewer.output_words_ptr(), 7).slice();
      const output = new Uint8Array(
        runtime.memory.buffer,
        viewer.output_bytes_ptr(),
        viewer.output_bytes_len(),
      ).slice();
      assert.equal(words.length, 7);
      payloadBytes += output.length;
      outputs += 1;
    }
  }
  drain(0);
  const snapshot = frames[0];
  assert(snapshot !== undefined);
  assert(terminal.receive(0, TRANSPORT_CHANNEL_ID.displayCommit, snapshot, mapping));
  drain(0);
  const started = performance.now();
  for (let index = 1; index <= count; index++) {
    const frame = frames[index];
    assert(frame !== undefined);
    assert(terminal.receive(index, TRANSPORT_CHANNEL_ID.displayDatagram, frame, mapping));
    drain(index);
  }
  viewer.present_now(count + 1);
  drain(count + 1);
  const elapsedMs = performance.now() - started;
  const result = {
    elapsedMs,
    applied: Number(viewer.applied_frames()) - 1,
    recovered: Number(viewer.recovered_frames()),
    sequence: viewer.applied_sequence(),
    outputs,
    outputBytes: payloadBytes,
    linearMemoryBytes: runtime.memory.buffer.byteLength,
  };
  viewer.free();
  assert.equal(result.applied, count, 'all original and rebuilt frames applied');
  assert.equal(result.recovered, count / 4, 'every omitted fourth frame rebuilt');
  assert.equal(result.sequence, count, 'final omitted sequence applied through recovery');
  return result;
}

exercise(Math.min(FRAMES, 10_000));
const result = exercise(FRAMES);
const framesPerSecond = Math.round((FRAMES / result.elapsedMs) * 1000);
process.stdout.write(
  `${JSON.stringify({
    benchmark: 'fec-retention-admission',
    scope:
      'production ClientViewer WASM reusable ingress, FEC retention/recovery, apply and output copies; native-generated preopened frames; excludes crypto, transport and GPU',
    frames: FRAMES,
    missingEvery: 4,
    framesPerSecond,
    ...result,
    elapsedMs: Number(result.elapsedMs.toFixed(2)),
  })}\n`,
);
emitPerfMetric({
  name: 'fec-retention-admission',
  value: framesPerSecond,
  unit: 'frames/s',
  direction: 'higher',
  sampleSize: FRAMES,
});
