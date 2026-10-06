/** Authenticated production Session Noise open, transferable output and SAB publication. */
import {
  createFrameRingReader,
  createFrameRingWriter,
  FRAME_KIND_CLIENT_INGRESS_BASE,
  FRAME_RING_SIZE,
} from '../apps/web/src/terminal/shared-ring';
import { createClientSessionFixture } from './perf/client-session-fixture';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

const samples = Number(process.env.BENCH_SAMPLES ?? 100),
  batch = Number(process.env.BENCH_MAX_BATCH_FRAMES ?? 32);
if (!Number.isSafeInteger(samples) || samples <= 0 || !Number.isSafeInteger(batch) || batch <= 0)
  throw new Error('invalid display-open measurement count');
const peer = await createClientSessionFixture();
try {
  for (const [channel, datagram] of [
    [3, true],
    [4, false],
  ] as const) {
    for (const length of [64, 1024, 16 * 1024, 60 * 1024]) {
      const ring = new SharedArrayBuffer(FRAME_RING_SIZE);
      const writer = createFrameRingWriter(ring),
        reader = createFrameRingReader(ring);
      const plaintext = new Uint8Array(length).fill(0x61);
      const times: number[] = [];
      for (let sample = 0; sample < samples + 10; sample++) {
        const sealed: Uint8Array[] = [];
        for (let index = 0; index < batch; index++)
          sealed.push(await peer.daemonSeal(channel, datagram, plaintext));
        let received = 0;
        const start = performance.now();
        for (const frame of sealed) {
          peer.incoming(channel, frame, datagram);
          peer.drainHost((kind, words, bytes) => {
            if (kind !== 9) return;
            if (!writer.write(bytes, FRAME_KIND_CLIENT_INGRESS_BASE + (words[0] ?? 0), !datagram))
              throw new Error('frame ring refused');
            const entry = reader.tryReadLeased();
            if (
              entry === null ||
              entry.payload.length !== length ||
              entry.payload[0] !== 0x61 ||
              entry.payload[length - 1] !== 0x61
            )
              throw new Error('authenticated open content mismatch');
            entry.release();
            received++;
          });
        }
        const elapsed = performance.now() - start;
        if (received !== batch) throw new Error('authenticated Session dropped fresh frames');
        if (sample >= 10) times.push(elapsed / batch);
      }
      const stats = summarizeSamples(times);
      process.stdout.write(
        `${JSON.stringify({ benchmark: 'e2e-display-open', channel, datagram, length, samples, scope: 'Rust authenticated Noise open, transferable action copies, SAB copy and lease release; sender outside timer', ...stats })}\n`,
      );
      emitPerfMetric({
        name: `e2e-display-open-${channel}-${length}`,
        value: stats.median,
        unit: 'ms/frame',
        direction: 'lower',
        sampleSize: samples,
      });
    }
  }
} finally {
  await peer.close();
}
