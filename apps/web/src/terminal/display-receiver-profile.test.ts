import { describe, expect, test } from 'bun:test';

import {
  createDisplayReceiverProfileBuffer,
  createDisplayReceiverProfileReader,
  createDisplayReceiverProfileWriter,
  DISPLAY_RECEIVER_PROFILE_BUCKETS,
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

  test('unchanged publications preserve buckets while advancing debt and revision', () => {
    const mailbox = createDisplayReceiverProfileBuffer();
    const writer = createDisplayReceiverProfileWriter(mailbox);
    const reader = createDisplayReceiverProfileReader(mailbox);
    writer.recordRaw(300, 4);
    writer.recordCompressed(300, 150, false, 12);
    writer.publish(5);
    const first = reader.readIfChanged();

    // A raw baseline changes future penalties, never previous observations.
    writer.recordRaw(300, 20);
    writer.publish(17);
    const second = reader.readIfChanged();
    expect(second?.buckets).toEqual(first?.buckets);
    expect(second?.serviceDebtUs).toBe(17);
    expect(second?.sampleRevision).toBe((first?.sampleRevision ?? 0) + 1);

    writer.recordCompressed(300, 150, false, 20);
    writer.publish(0);
    expect(reader.readIfChanged()?.buckets[0]?.meanUs).toBe(8);

    for (let value = 1; value <= 40; value += 1) writer.recordRaw(300, value);
    writer.recordCompressed(300, 30, true, 50);
    writer.recordCompressed(300, 30, true, 60);
    writer.publish(0);
    expect(reader.readIfChanged()?.buckets[1]?.meanUs).toBe(31);
  });

  test('a replacement writer clears every old bucket on its first publication', () => {
    const mailbox = createDisplayReceiverProfileBuffer();
    const reader = createDisplayReceiverProfileReader(mailbox);
    const first = createDisplayReceiverProfileWriter(mailbox);
    first.recordCompressed(300, 150, false, 12);
    first.recordCompressed(12_000, 1_000, true, 25);
    first.publish(5);
    expect(reader.readIfChanged()?.buckets).toHaveLength(2);

    const replacement = createDisplayReceiverProfileWriter(mailbox);
    replacement.recordCompressed(900, 300, true, 7);
    replacement.publish(0);
    expect(reader.readIfChanged()?.buckets).toEqual([
      {
        dictionaryClass: 1,
        sizeClass: 1,
        ratioClass: 2,
        sampleCount: 1,
        wireRatioPpm: 333_333,
        meanUs: 7,
        varianceUs2: 0,
        upperUs: 7,
      },
    ]);
    replacement.publish(9);
    expect(reader.readIfChanged()?.buckets).toHaveLength(1);
  });

  test('sparse updates match independent full-window statistics across every bucket', () => {
    const mailbox = createDisplayReceiverProfileBuffer();
    const writer = createDisplayReceiverProfileWriter(mailbox);
    const reader = createDisplayReceiverProfileReader(mailbox);
    const observations = Array.from(
      { length: DISPLAY_RECEIVER_PROFILE_BUCKETS },
      (): number[] => [],
    );
    const sizes = [256, 900, 1_800, 3_600, 7_000, 12_000];
    const ratios = [0.1, 0.2, 0.4, 0.8];
    for (let round = 0; round < 75; round += 1) {
      for (const [bucket, samples] of observations.entries()) {
        if (round !== 0 && (bucket + round) % 3 === 0) continue;
        const sizeClass = Math.floor(bucket / 4) % 6;
        const raw = sizes[sizeClass] ?? 0;
        const ratio = ratios[bucket % 4] ?? 0;
        const value = (((round * 97 + bucket * 13) % 251) + 0.123456) * 1.137;
        writer.recordCompressed(raw, raw * ratio, bucket >= 24, value);
        samples.push(value);
        if (samples.length > 32) samples.shift();
      }
      writer.publish(round);
      const buckets = reader.readIfChanged()?.buckets;
      expect(buckets).toHaveLength(DISPLAY_RECEIVER_PROFILE_BUCKETS);
      for (const [bucket, samples] of observations.entries()) {
        const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        const variance =
          samples.length > 1
            ? samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1)
            : 0;
        expect(buckets?.[bucket]?.sampleCount).toBe(samples.length);
        expect(buckets?.[bucket]?.meanUs).toBe(Math.round(mean));
        expect(buckets?.[bucket]?.varianceUs2).toBe(Math.round(variance));
        expect(buckets?.[bucket]?.upperUs).toBe(
          Math.round(mean + 1.645 * Math.sqrt(variance * (1 + 1 / samples.length))),
        );
        expect(buckets?.[bucket]?.wireRatioPpm).toBe(Math.round((ratios[bucket % 4] ?? 0) * 1e6));
      }
    }
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
