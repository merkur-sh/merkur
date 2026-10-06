/**
 * How long Merkur takes to show something, from what was measured.
 *
 * The pages' screens do not invent their timing. A key a visitor "types" on
 * the page, the line break its Enter makes, and what a command "prints" are
 * each drawn when the app would draw them on the link the screen names: the
 * delay from an input reaching the browser to the frame that carries the
 * machine's answer being on the glass, measured on a release across round
 * trips and datagram loss. The three are different measurements, because the
 * app treats them differently (`content/latency-model.ts`).
 *
 * A measurement is a grid, and a link between two measured cells is read by
 * interpolating what the app added on top of the round trip in each of them.
 * Nothing is read outside the grid: a link slower or lossier than the last
 * measured cell is not one the pages may show.
 */
import type { LatencyModel } from './content/latency-model';

/** The quantiles each cell records, in order. Below the median a delay is the median. */
const KNOTS = [0.5, 0.95, 0.99, 1] as const;

export interface Latency {
  /**
   * The delay in ms on a link of `rtt` ms and `loss` % at quantile `u` of its
   * distribution: 0.5 is the median key, 0.99 the one in a hundred that waits
   * longest.
   */
  delay(rtt: number, loss: number, u: number): number;
  /** One delay drawn from that link's distribution. */
  sample(rtt: number, loss: number, random: () => number): number;
  /** The slowest and lossiest link the measurement covers. */
  readonly limit: { readonly rtt: number; readonly loss: number };
}

/** The two neighbours of `value` on `axis` and how far between them it lies. */
function bracket(axis: readonly number[], value: number): readonly [number, number, number] {
  const last = axis.length - 1;
  for (let index = 0; index < last; index += 1) {
    const low = axis[index] ?? 0;
    const high = axis[index + 1] ?? low;
    if (value <= high) return [index, index + 1, high === low ? 0 : (value - low) / (high - low)];
  }
  return [last, last, 0];
}

const mix = (from: number, to: number, share: number): number => from + (to - from) * share;

export function createLatency(model: LatencyModel): Latency {
  const rtts = [...new Set(model.cells.map((cell) => cell.rtt))].sort((a, b) => a - b);
  const losses = [...new Set(model.cells.map((cell) => cell.loss))].sort((a, b) => a - b);
  /** What the app added to the round trip at each knot, by cell. */
  const added = new Map<string, readonly number[]>();
  for (const cell of model.cells) {
    const quantiles = cell.fence.split('/').map((value) => Number(value.trim()));
    if (quantiles.length !== KNOTS.length || quantiles.some((value) => !Number.isFinite(value))) {
      throw new Error(`latency model: ${cell.rtt} ms, ${cell.loss} % is not four numbers`);
    }
    added.set(
      `${cell.rtt}/${cell.loss}`,
      quantiles.map((value) => value - cell.rtt),
    );
  }
  const at = (rtt: number, loss: number, knot: number): number => {
    const cell = added.get(`${rtt}/${loss}`);
    const value = cell?.[knot];
    if (value === undefined) throw new Error(`latency model: no cell at ${rtt} ms, ${loss} %`);
    return value;
  };
  const limit = { rtt: rtts[rtts.length - 1] ?? 0, loss: losses[losses.length - 1] ?? 0 };

  const delay = (rtt: number, loss: number, u: number): number => {
    if (rtt < 0 || rtt > limit.rtt || loss < 0 || loss > limit.loss) {
      throw new Error(`latency model: ${rtt} ms at ${loss} % loss was not measured`);
    }
    const [r0, r1, rShare] = bracket(rtts, rtt);
    const [l0, l1, lShare] = bracket(losses, loss);
    const over = (knot: number): number =>
      mix(
        mix(
          at(rtts[r0] ?? 0, losses[l0] ?? 0, knot),
          at(rtts[r1] ?? 0, losses[l0] ?? 0, knot),
          rShare,
        ),
        mix(
          at(rtts[r0] ?? 0, losses[l1] ?? 0, knot),
          at(rtts[r1] ?? 0, losses[l1] ?? 0, knot),
          rShare,
        ),
        lShare,
      );
    const [k0, k1, kShare] = bracket(KNOTS, Math.max(KNOTS[0], Math.min(1, u)));
    return rtt + mix(over(k0), over(k1), kShare);
  };

  return {
    delay,
    sample: (rtt, loss, random) => delay(rtt, loss, random()),
    limit,
  };
}
