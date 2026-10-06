import { expect, test } from 'bun:test';
import {
  compareGpuPixels,
  coveringNoticeDurations,
  qualifyGpuOfferCadence,
} from './bench-webgpu-terminal';

test('delivered cadence qualification rejects stretched workloads without filtering slow renders', () => {
  const offers = Array.from({ length: 100 }, (_, index) => ({
    ordinal: index + 1,
    scheduledAtMs: index * 8,
    offeredAtMs: index * 8 + 2,
  }));
  expect(qualifyGpuOfferCadence(offers)).toEqual([]);
  expect(
    qualifyGpuOfferCadence(
      offers.map((offer, index) => ({ ...offer, offeredAtMs: offer.offeredAtMs + index * 100 })),
    ),
  ).toHaveLength(3);
  expect(qualifyGpuOfferCadence([])).toHaveLength(1);
});

test('coverage includes superseded offers, not just surviving submissions', () => {
  expect(
    coveringNoticeDurations(
      [
        { ordinal: 1, offeredAtMs: 10, scheduledAtMs: 10 },
        { ordinal: 2, offeredAtMs: 11, scheduledAtMs: 11 },
        { ordinal: 3, offeredAtMs: 12, scheduledAtMs: 12 },
      ],
      [
        { ordinal: 2, mainReceivedAtMs: 15 },
        { ordinal: 3, mainReceivedAtMs: 16 },
      ],
    ),
  ).toEqual([5, 4, 4]);
});

test('invalid or uncovered completion populations fail instead of inventing zero latency', () => {
  const offers = [{ ordinal: 2, offeredAtMs: 10, scheduledAtMs: 10 }];
  expect(() => coveringNoticeDurations(offers, [])).toThrow();
  expect(() => coveringNoticeDurations(offers, [{ ordinal: 2, mainReceivedAtMs: 9 }])).toThrow();
  expect(() =>
    coveringNoticeDurations(offers, [
      { ordinal: 2, mainReceivedAtMs: 12 },
      { ordinal: 1, mainReceivedAtMs: 13 },
    ]),
  ).toThrow();
});

test('full pixel comparison preserves differences and permits only one quantization level', () => {
  expect(compareGpuPixels(new Uint8Array([0, 10, 255]), new Uint8Array([1, 8, 255]))).toEqual({
    channels: 3,
    differingChannels: 2,
    aboveTolerance: 1,
    maximumError: 2,
  });
  expect(() => compareGpuPixels(new Uint8Array(0), new Uint8Array(0))).toThrow();
  expect(() => compareGpuPixels(new Uint8Array(3), new Uint8Array(2))).toThrow();
});
