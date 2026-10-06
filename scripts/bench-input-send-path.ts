/** JSC allocations at the production Rust input/seal boundary, authenticated outside timing. */
import { fullGC, heapStats } from 'bun:jsc';
import {
  createClientSessionFixture,
  type SessionFixtureAction,
} from './perf/client-session-fixture';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

export interface InputSendPathMeasurement {
  readonly keystrokes: number;
  readonly pathObjects: number;
  readonly controlObjects: number;
  readonly objectsPerKeystroke: number;
  readonly datagramsIssued: number;
  readonly reliableRecords: number;
}
function liveCells() {
  return Object.values(heapStats().objectTypeCounts).reduce((sum, value) => sum + value, 0);
}
export async function createInputSendPathBenchmarkDriver() {
  const peer = await createClientSessionFixture();
  const key = Uint8Array.of(0, 97);
  let sequence = 0;
  const pending: SessionFixtureAction[] = [];
  function keystroke() {
    if (!peer.input(++sequence, key)) return false;
    for (;;) {
      const action = peer.pollIo();
      if (action === null) break;
      pending.push(action);
    }
    return true;
  }
  async function settle() {
    for (const action of pending) {
      if (action.kind === 7 && action.topSequence !== 0)
        peer.session.input_datagram_sent(peer.now(), action.conn, action.topSequence);
      await peer.transmit(action);
    }
    pending.length = 0;
    await peer.settle();
  }
  return {
    keystroke,
    settle,
    async measure(keystrokes: number): Promise<InputSendPathMeasurement> {
      if (!Number.isSafeInteger(keystrokes) || keystrokes <= 0 || keystrokes > 256)
        throw new Error('keystrokes must fit native outbox count credit');
      const before = peer.counts();
      fullGC();
      const cells = liveCells();
      for (let index = 0; index < keystrokes; index++)
        if (!keystroke()) throw new Error('Rust input refused');
      const pathObjects = liveCells() - cells;
      await settle();
      const after = peer.counts();
      return {
        keystrokes,
        pathObjects,
        controlObjects: 0,
        objectsPerKeystroke: pathObjects / keystrokes,
        datagramsIssued: after.datagrams - before.datagrams,
        reliableRecords: after.reliableInputs - before.reliableInputs,
      };
    },
    verifyLastFrames() {
      if (peer.applied.length !== sequence || peer.session.input_ack_local() !== sequence)
        throw new Error('encrypted daemon input/ACK did not advance exactly once');
    },
    close: () => peer.close(),
  };
}
if (import.meta.main) {
  const driver = await createInputSendPathBenchmarkDriver();
  try {
    const samples = Number(process.env.BENCH_SAMPLES ?? 9),
      keys = Number(process.env.BENCH_KEYSTROKES ?? 256);
    const values: number[] = [];
    for (let index = 0; index < samples; index++) {
      const value = await driver.measure(keys);
      driver.verifyLastFrames();
      process.stdout.write(
        `${JSON.stringify({ scope: 'WASM input and sealed output copies; authenticated delivery/ACK oracle outside allocation capture', ...value })}\n`,
      );
      values.push(value.objectsPerKeystroke);
    }
    emitPerfMetric({
      name: 'input-send-objects-per-keystroke',
      value: summarizeSamples(values).median,
      unit: 'objects/keystroke',
      direction: 'lower',
      sampleSize: samples,
    });
  } finally {
    await driver.close();
  }
}
