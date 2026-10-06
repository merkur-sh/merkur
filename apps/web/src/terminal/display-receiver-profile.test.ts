import { describe, expect, test } from 'bun:test';

import {
  createDisplayReceiverProfileBuffer,
  createDisplayReceiverProfileReader,
  createDisplayReceiverProfileWriter,
} from './display-receiver-profile';

describe('display receiver profile mailbox', () => {
  test('publishes a coalesced bounded posterior without ACK coupling', () => {
    const mailbox = createDisplayReceiverProfileBuffer();
    const writer = createDisplayReceiverProfileWriter(mailbox);
    const reader = createDisplayReceiverProfileReader(mailbox);

    writer.recordRaw(1_500, 4);
    writer.recordCompressed(1_500, 500, true, 10);
    writer.recordCompressed(1_500, 400, true, 14);
    writer.publish(375);

    const profile = reader.readIfChanged();
    expect(profile).not.toBeNull();
    expect(profile?.serviceDebtUs).toBe(375);
    expect(profile?.ageMs).toBeLessThan(100);
    expect(profile?.buckets).toEqual([
      {
        dictionaryClass: 1,
        sizeClass: 2,
        ratioClass: 2,
        sampleCount: 2,
        wireRatioPpm: 300_000,
        meanUs: 8,
        varianceUs2: 8,
        upperUs: 14,
      },
    ]);
    expect(reader.readIfChanged()).toBeNull();
  });

  test('retains only the newest 32 samples', () => {
    const mailbox = createDisplayReceiverProfileBuffer();
    const writer = createDisplayReceiverProfileWriter(mailbox);
    const reader = createDisplayReceiverProfileReader(mailbox);
    for (let value = 1; value <= 40; value += 1) {
      writer.recordCompressed(300, 150, false, value);
    }
    writer.publish(0);
    const bucket = reader.readIfChanged()?.buckets[0];
    expect(bucket?.sampleCount).toBe(32);
    expect(bucket?.meanUs).toBe(25);
  });

  test('keeps wire-ratio cost surfaces distinct at one raw size', () => {
    const mailbox = createDisplayReceiverProfileBuffer();
    const writer = createDisplayReceiverProfileWriter(mailbox);
    const reader = createDisplayReceiverProfileReader(mailbox);
    writer.recordCompressed(2_000, 200, false, 3);
    writer.recordCompressed(2_000, 1_500, false, 40);
    writer.publish(0);
    expect(
      reader.readIfChanged()?.buckets.map((bucket) => [bucket.ratioClass, bucket.meanUs]),
    ).toEqual([
      [0, 3],
      [3, 40],
    ]);
  });

  test('a cache older than the u32 millisecond horizon cannot alias back to fresh', () => {
    const mailbox = createDisplayReceiverProfileBuffer();
    const writer = createDisplayReceiverProfileWriter(mailbox);
    const reader = createDisplayReceiverProfileReader(mailbox);
    writer.recordCompressed(2_000, 200, false, 3);
    writer.publish(0, Date.now() - 51 * 24 * 60 * 60 * 1_000);
    expect(reader.readIfChanged()?.ageMs).toBeGreaterThan(30 * 24 * 60 * 60 * 1_000);
  });
});
