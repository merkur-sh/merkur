import { expect, test } from 'bun:test';
import { recordClientSessionObservation } from './client-session-observation';
import { createPerfRingBuffer, createPerfRingWriter } from './perf-ring';

test('Rust grid observation crosses the peer boundary as owned hash words only in its enabled epoch', () => {
  const writer = createPerfRingWriter(createPerfRingBuffer(4));
  const sent: { value: Record<string, unknown>; transfer: Transferable[] }[] = [];
  const peer = {
    postMessage(value: Record<string, unknown>, transfer: Transferable[]) {
      sent.push({ value, transfer });
    },
  } as unknown as MessagePort;
  const hashes = [0x12345678, 0x90abcdef];
  const message = {
    kind: 'perf_grid_convergence_response',
    observationEpoch: 7,
    probeId: 9,
    generation: 1,
    lastAdmittedDisplaySeq: 3,
    cols: 80,
    rows: 1,
    rowHashes: hashes,
  } as const;
  recordClientSessionObservation(writer, message, 100, 8, peer);
  expect(sent).toHaveLength(0);
  recordClientSessionObservation(writer, message, 100, 7, peer);
  expect(sent).toHaveLength(1);
  const output = sent[0];
  if (output === undefined || !(output.value.rowHashes instanceof ArrayBuffer))
    throw new Error('missing owned grid output');
  expect(output.transfer).toEqual([output.value.rowHashes]);
  hashes.fill(0);
  expect(Array.from(new Uint32Array(output.value.rowHashes))).toEqual([0x12345678, 0x90abcdef]);
  expect(writer.writtenCount).toBe(0);
});
