/** What one kind of controller work cost this process: how often it ran and for how long. */
export interface StageTime {
  readonly name: string;
  readonly count: number;
  readonly ms: number;
}

const totals = new Map<string, { count: number; ms: number }>();

function add(name: string, started: number): void {
  const total = totals.get(name) ?? { count: 0, ms: 0 };
  total.count += 1;
  total.ms += performance.now() - started;
  totals.set(name, total);
}

/** Run `work`, adding its wall time to the stage `name`. A stage holds no verification fact. */
export function timed<T>(name: string, work: () => T): T {
  const started = performance.now();
  try {
    return work();
  } finally {
    add(name, started);
  }
}

/** As `timed`, to the settlement of `work`. A stage inside another is counted in both. */
export async function timedAsync<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    add(name, started);
  }
}

/** Every stage this process ran, the longest first. */
export function stageTimes(): readonly StageTime[] {
  return [...totals]
    .map(([name, total]) => ({ name, count: total.count, ms: Math.round(total.ms) }))
    .sort((left, right) => right.ms - left.ms || (left.name < right.name ? -1 : 1));
}
