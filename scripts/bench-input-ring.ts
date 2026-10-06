/** Real SAB custody into Rust Session and authenticated cumulative ACK release. */
import {
  createInputRingReader,
  createInputRingWriter,
  INPUT_RING_SIZE,
} from '../apps/web/src/transport/input-ring';
import { createClientSessionFixture } from './perf/client-session-fixture';
import { emitPerfMetric, summarizeSamples } from './perf/harness';
import { createBenchPtyInputLane } from './perf/pty-input-lane';

const samples = Number(process.env.BENCH_SAMPLES ?? 1000),
  batch = Number(process.env.BENCH_BATCH_SIZE ?? 128);
if (
  !Number.isSafeInteger(samples) ||
  samples <= 0 ||
  !Number.isSafeInteger(batch) ||
  batch <= 0 ||
  batch > 256
)
  throw new Error('invalid input benchmark count');
const peer = await createClientSessionFixture();
const ring = new SharedArrayBuffer(INPUT_RING_SIZE);
const writer = createInputRingWriter(ring),
  reader = createInputRingReader(ring);
const lane = createBenchPtyInputLane(peer, reader);
const key = Uint8Array.of(0, 97);
const times: number[] = [];
let sequence = 0;
try {
  for (let sample = 0; sample < samples + 100; sample++) {
    const start = performance.now();
    for (let index = 0; index < batch; index++)
      if (!writer.write(++sequence, key)) throw new Error('input ring refused');
    lane.admit();
    const admissionMs = performance.now() - start;
    if (writer.bufferedEntries() !== batch)
      throw new Error('ring custody released before authenticated ACK');
    await lane.flush();
    if (writer.bufferedEntries() !== 0 || peer.session.input_ack_local() !== sequence)
      throw new Error('authenticated ACK failed to release ring');
    if (sample >= 100) times.push(admissionMs);
  }
  if (peer.applied.length !== sequence) throw new Error('daemon input duplicated or lost');
  const stats = summarizeSamples(times);
  process.stdout.write(
    `${JSON.stringify({ benchmark: 'input-ring', batch, samples, scope: 'SAB publish/read/copy plus Rust admission/sealing; authenticated delivery outside timer', ...stats })}\n`,
  );
  emitPerfMetric({
    name: 'input-ring-batch-latency',
    value: stats.median,
    unit: 'ms/batch',
    direction: 'lower',
    sampleSize: samples,
  });
} finally {
  await peer.close();
}
