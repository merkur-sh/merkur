import { describe, expect, test } from 'bun:test';
import type { TransportHintParams } from '../transport-worker-protocol';
import { createTransportHintPublisher } from './transport-hint-publisher';

const NETWORK_HINT: TransportHintParams = {
  profile: 1,
  chunkBytes: 16_384,
  snapshotBytes: 65_536,
};

describe('transport hint publisher', () => {
  test('deduplicates only after worker-local queue depth and cadence are sampled', () => {
    const emitted: Array<readonly [TransportHintParams, number, number]> = [];
    const publisher = createTransportHintPublisher((hint, depth, periodUs) => {
      emitted.push([hint, depth, periodUs]);
    });

    expect(publisher.noteNetworkHint(NETWORK_HINT, 256, 16_667)).toBe(true);
    expect(publisher.noteNetworkHint({ ...NETWORK_HINT }, 256, 16_667)).toBe(false);
    expect(publisher.notePresentationPeriod(256, 16_667)).toBe(false);
    expect(emitted).toEqual([[NETWORK_HINT, 256, 16_667]]);

    // The main-thread tuple is unchanged, but a calibration/monitor edge must
    // immediately publish the new period rather than waiting for network churn.
    expect(publisher.notePresentationPeriod(256, 4_167)).toBe(true);
    expect(publisher.notePresentationPeriod(256, 4_167)).toBe(false);
    expect(emitted[1]).toEqual([{ ...NETWORK_HINT }, 256, 4_167]);

    // Queue capacity is also sampled in this realm and participates in the
    // same exact wire-level dedupe identity.
    expect(publisher.noteNetworkHint({ ...NETWORK_HINT }, 384, 4_167)).toBe(true);
    expect(emitted[2]).toEqual([{ ...NETWORK_HINT }, 384, 4_167]);
  });

  test('a new session lineage republishes the unchanged complete hint', () => {
    let emits = 0;
    const publisher = createTransportHintPublisher(() => {
      emits += 1;
    });
    publisher.noteNetworkHint(NETWORK_HINT, 256, 8_333);
    publisher.resetDelivery();

    expect(publisher.notePresentationPeriod(256, 8_333)).toBe(true);
    expect(emits).toBe(2);
  });

  test('a cadence edge before any network hint is safely inert', () => {
    let emits = 0;
    const publisher = createTransportHintPublisher(() => {
      emits += 1;
    });
    expect(publisher.notePresentationPeriod(256, 2_083)).toBe(false);
    expect(emits).toBe(0);
  });
});
