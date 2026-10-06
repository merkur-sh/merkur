import { describe, expect, test } from 'bun:test';

import type { LatencyModel } from './content/latency-model';
import { LATENCY_MODELS } from './content/latency-model';
import { createLatency } from './latency';

/** A grid whose every number is easy to check by hand. */
const GRID: LatencyModel = {
  measures: 'a key',
  ledger: 'ledger/none.md',
  release: 'v0.0.0',
  cells: [
    { rtt: 0, loss: 0, fence: '2 / 4 / 6 / 10' },
    { rtt: 0, loss: 10, fence: '2 / 4 / 6 / 10' },
    { rtt: 100, loss: 0, fence: '110 / 120 / 130 / 150' },
    { rtt: 100, loss: 10, fence: '120 / 160 / 200 / 300' },
  ],
};

describe('latency model', () => {
  const latency = createLatency(GRID);

  test('reads a measured cell back at each of its quantiles', () => {
    expect(latency.delay(100, 0, 0.5)).toBeCloseTo(110);
    expect(latency.delay(100, 0, 0.95)).toBeCloseTo(120);
    expect(latency.delay(100, 0, 0.99)).toBeCloseTo(130);
    expect(latency.delay(100, 0, 1)).toBeCloseTo(150);
    expect(latency.delay(100, 10, 0.99)).toBeCloseTo(200);
  });

  test('never claims a key is faster than the median one', () => {
    expect(latency.delay(100, 0, 0)).toBeCloseTo(110);
    expect(latency.delay(100, 0, 0.3)).toBeCloseTo(110);
  });

  test('between cells, interpolates what the app adds to the round trip', () => {
    // At 50 ms the round trip is 50; the app's share is halfway between 2 and 10.
    expect(latency.delay(50, 0, 0.5)).toBeCloseTo(50 + 6);
    // Halfway in loss too: the shares 10 and 20 at 100 ms, 2 and 2 at 0 ms.
    expect(latency.delay(100, 5, 0.5)).toBeCloseTo(100 + 15);
    expect(latency.delay(50, 5, 0.5)).toBeCloseTo(50 + (2 + 15) / 2);
    // And between two quantiles of one cell.
    expect(latency.delay(100, 0, 0.97)).toBeCloseTo(125);
  });

  test('refuses a link the measurement does not cover', () => {
    expect(latency.limit).toEqual({ rtt: 100, loss: 10 });
    expect(() => latency.delay(101, 0, 0.5)).toThrow('was not measured');
    expect(() => latency.delay(50, 11, 0.5)).toThrow('was not measured');
  });

  test('draws from the distribution with the random number it is given', () => {
    expect(latency.sample(100, 0, () => 0.95)).toBeCloseTo(120);
  });

  test('refuses a cell that is not four numbers', () => {
    expect(() =>
      createLatency({ ...GRID, cells: [{ rtt: 0, loss: 0, fence: '1 / 2 / 3' }] }),
    ).toThrow('is not four numbers');
  });
});

describe('the measured grids the pages use', () => {
  for (const model of LATENCY_MODELS) {
    test(`${model.measures}: a full grid whose quantiles rise and never beat the round trip`, () => {
      const rtts = [...new Set(model.cells.map((cell) => cell.rtt))];
      const losses = [...new Set(model.cells.map((cell) => cell.loss))];
      expect(model.cells).toHaveLength(rtts.length * losses.length);
      for (const cell of model.cells) {
        const quantiles = cell.fence.split('/').map((value) => Number(value.trim()));
        expect(quantiles).toHaveLength(4);
        expect([...quantiles].sort((a, b) => a - b)).toEqual(quantiles);
        expect(quantiles[0]).toBeGreaterThan(cell.rtt);
      }
      // Every link the grid covers can be read.
      const latency = createLatency(model);
      for (const rtt of rtts) {
        for (const loss of losses) expect(latency.delay(rtt, loss, 0.5)).toBeGreaterThan(rtt);
      }
    });
  }

  test('cover the same links, so one screen can read all of them', () => {
    const links = (model: LatencyModel): string[] =>
      model.cells.map((cell) => `${cell.rtt}/${cell.loss}`).sort();
    const [first, ...rest] = LATENCY_MODELS;
    for (const model of rest) expect(links(model)).toEqual(first === undefined ? [] : links(first));
  });
});
