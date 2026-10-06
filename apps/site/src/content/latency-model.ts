/**
 * How long Merkur takes to show the machine's answer, as measured.
 *
 * Three things were measured, because the app treats them differently:
 *
 * - a key: from a typed key reaching the browser to the frame carrying the
 *   machine's echo of it being on the glass. The app sends an echo at once.
 * - a line break: from Enter to the frame that moves the line up. Enter is
 *   never predicted, and the frame scrolls the whole screen.
 * - a command's output: from Enter to the whole of what the command wrote
 *   being on the glass, the slowest of the answers measured (one row, and six
 *   rows from an executed program).
 *
 * Each cell is one link: a round trip in ms and a datagram loss in %. `fence`
 * is that link's row of the ledger entry's table, verbatim: the p50, p95, p99
 * and maximum in ms. The pages' screens draw their timing from these
 * (`latency.ts`), so nothing a visitor watches is faster than the release was.
 *
 * `bun run check:figures` holds every cell to the entry it names. To change a
 * number, measure again and write a new entry; never edit one here.
 *
 * The round trip of 0 is the loopback run, which has no network to lose a
 * datagram on, so its row stands for every loss.
 */
export interface LatencyCell {
  /** Application round trip, browser to machine and back, in ms. */
  readonly rtt: number;
  /** Datagram loss in each direction, in %. */
  readonly loss: number;
  /** `p50 / p95 / p99 / max` in ms, as the ledger's table prints them. */
  readonly fence: string;
}

export interface LatencyModel {
  /** What was timed, as the checks name it. */
  readonly measures: string;
  /** The entry in the private `merkur-private-docs` repository the cells are rows of. */
  readonly ledger: string;
  /** The release measured. */
  readonly release: string;
  readonly cells: readonly LatencyCell[];
}

const LOSSES = [0, 1, 3, 9] as const;
/** The loopback row, once for every loss. */
const loopback = (fence: string): LatencyCell[] => LOSSES.map((loss) => ({ rtt: 0, loss, fence }));

export const KEY_LATENCY: LatencyModel = {
  measures: 'a key',
  ledger: 'ledger/2026-10-04-latency-grid-for-the-site.md',
  release: 'v0.70.1',
  cells: [
    ...loopback('1.57 / 2.18 / 3.15 / 6.87'),
    { rtt: 50, loss: 0, fence: '58.5 / 66.9 / 72.4 / 72.4' },
    { rtt: 50, loss: 1, fence: '58.3 / 67.4 / 75.5 / 98.0' },
    { rtt: 50, loss: 3, fence: '57.8 / 69.3 / 92.8 / 95.5' },
    { rtt: 50, loss: 9, fence: '59.7 / 79.7 / 91.7 / 103.8' },
    { rtt: 120, loss: 0, fence: '130.4 / 143.2 / 154.2 / 157.4' },
    { rtt: 120, loss: 1, fence: '130.8 / 144.2 / 152.6 / 165.6' },
    { rtt: 120, loss: 3, fence: '130.3 / 143.4 / 153.2 / 161.2' },
    { rtt: 120, loss: 9, fence: '132.0 / 155.9 / 167.8 / 176.6' },
    { rtt: 200, loss: 0, fence: '215.6 / 230.9 / 240.2 / 254.8' },
    { rtt: 200, loss: 1, fence: '216.4 / 233.8 / 251.4 / 252.2' },
    { rtt: 200, loss: 3, fence: '243.1 / 396.8 / 412.0 / 419.5' },
    { rtt: 200, loss: 9, fence: '307.0 / 555.0 / 597.1 / 597.4' },
  ],
};

const OUTPUT_LEDGER = 'ledger/2026-10-04-command-output-grid-for-the-site.md';

export const LINE_BREAK_LATENCY: LatencyModel = {
  measures: 'a line break',
  ledger: OUTPUT_LEDGER,
  release: 'v0.70.1',
  cells: [
    ...loopback('6.63 / 10.9 / 11.9 / 11.9'),
    { rtt: 50, loss: 0, fence: '57.8 / 62.5 / 65.1 / 66.0' },
    { rtt: 50, loss: 1, fence: '57.9 / 62.8 / 68.6 / 126.4' },
    { rtt: 50, loss: 3, fence: '57.8 / 62.5 / 128.4 / 131.1' },
    { rtt: 50, loss: 9, fence: '59.7 / 173.8 / 209.9 / 229.5' },
    { rtt: 120, loss: 0, fence: '131.4 / 138.3 / 147.0 / 147.8' },
    { rtt: 120, loss: 1, fence: '131.2 / 144.4 / 158.3 / 297.2' },
    { rtt: 120, loss: 3, fence: '130.4 / 266.8 / 313.6 / 336.6' },
    { rtt: 120, loss: 9, fence: '132.7 / 285.5 / 374.1 / 482.7' },
    { rtt: 200, loss: 0, fence: '212.5 / 226.1 / 246.0 / 248.4' },
    { rtt: 200, loss: 1, fence: '213.9 / 245.4 / 442.1 / 458.5' },
    { rtt: 200, loss: 3, fence: '215.2 / 234.7 / 241.5 / 473.4' },
    { rtt: 200, loss: 9, fence: '216.7 / 486.6 / 619.9 / 622.7' },
  ],
};

export const OUTPUT_LATENCY: LatencyModel = {
  measures: 'command output',
  ledger: OUTPUT_LEDGER,
  release: 'v0.70.1',
  cells: [
    ...loopback('11.3 / 15.3 / 17.3 / 19.1'),
    { rtt: 50, loss: 0, fence: '61.5 / 65.8 / 66.3 / 66.9' },
    { rtt: 50, loss: 1, fence: '61.9 / 67.8 / 68.9 / 122.4' },
    { rtt: 50, loss: 3, fence: '62.1 / 67.1 / 123.2 / 124.3' },
    { rtt: 50, loss: 9, fence: '60.7 / 224.2 / 257.9 / 461.8' },
    { rtt: 120, loss: 0, fence: '134.4 / 147.0 / 152.0 / 161.6' },
    { rtt: 120, loss: 1, fence: '134.6 / 140.5 / 150.9 / 320.8' },
    { rtt: 120, loss: 3, fence: '134.1 / 144.2 / 318.2 / 403.0' },
    { rtt: 120, loss: 9, fence: '134.7 / 332.4 / 445.8 / 499.0' },
    { rtt: 200, loss: 0, fence: '219.0 / 243.6 / 253.2 / 257.7' },
    { rtt: 200, loss: 1, fence: '218.5 / 228.8 / 248.9 / 615.2' },
    { rtt: 200, loss: 3, fence: '219.5 / 253.0 / 608.5 / 624.8' },
    { rtt: 200, loss: 9, fence: '221.6 / 571.8 / 635.1 / 1025.7' },
  ],
};

/** Every grid the pages read, for the checks that hold them to their entries. */
export const LATENCY_MODELS: readonly LatencyModel[] = [
  KEY_LATENCY,
  LINE_BREAK_LATENCY,
  OUTPUT_LATENCY,
];
