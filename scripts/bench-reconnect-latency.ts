/** Real authenticated Rust Session recovery, with imposed virtual carrier RTT.
 * This measures core recovery ordering; browser networking, QUIC and OS outage detection are excluded.
 */
import assert from 'node:assert/strict';
import {
  createClientSessionFixture,
  type SessionFixtureAction,
  type SessionFixtureWire,
} from './perf/client-session-fixture';
import { emitPerfMetric } from './perf/harness';

export async function measureReconnect(rttMs: number, outageMs: number, allCarriers = false) {
  const fixture = await createClientSessionFixture();
  const initialLineage = fixture.lineage();
  const start = fixture.now();
  const phases: { first_dial: number | null; rebind_sent: number | null; usable: number | null } = {
    first_dial: null,
    rebind_sent: null,
    usable: null,
  };
  const events: { at: number; order: number; run: () => Promise<void> }[] = [];
  let order = 0;
  let dials = 0;
  const observe = (action: SessionFixtureAction): void => {
    const elapsed = fixture.now() - start;
    if (action.kind === 3) {
      dials++;
      phases.first_dial ??= elapsed;
    }
    if (action.kind === 6) phases.rebind_sent ??= elapsed;
  };
  const wire: SessionFixtureWire = async (_action, deliver) => {
    events.push({
      at: Math.max(fixture.now() - start + rttMs, outageMs),
      order: order++,
      run: deliver,
    });
  };
  try {
    fixture.recover(allCarriers);
    for (let steps = 0; steps < 100_000; steps++) {
      await fixture.settle(wire, observe);
      if (fixture.lineage() !== initialLineage && fixture.session.is_ready()) {
        phases.usable = fixture.now() - start;
        break;
      }
      events.sort((a, b) => a.at - b.at || a.order - b.order);
      if (await fixture.step(events[0], start)) events.shift();
    }
    assert(phases.usable !== null, 'readiness must follow authenticated generation commitment');
    // Completion includes data HELLO and an authenticated ACK for retained input.
    fixture.input(1, Uint8Array.of(0, 97));
    await fixture.settle();
    assert.equal(fixture.session.released_input(), 1);
    return {
      scenario: allCarriers ? 'closed-carriers' : 'closed-carrier',
      rttMs,
      outageMs,
      phases,
      dials,
      lineage: fixture.lineage(),
    };
  } finally {
    await fixture.close();
  }
}
if (import.meta.main) {
  const argument = (name: string, defaultValue: number): number => {
    const value = Number(
      process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? defaultValue,
    );
    assert(Number.isFinite(value) && value >= 0);
    return value;
  };
  const rtt = argument('rtt', 85),
    outage = argument('outage', 0),
    reps = argument('reps', 3);
  const results = [];
  for (let rep = 0; rep < reps; rep++) {
    results.push(await measureReconnect(rtt, outage));
    results.push(await measureReconnect(rtt, outage, true));
  }
  process.stdout.write(
    JSON.stringify(
      {
        assumptions:
          'Real WASM Session and native hybrid/Noise peer; imposed virtual RTT/outage, no QUIC or OS timing.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  for (const result of results) {
    emitPerfMetric({
      name: `reconnect.${result.scenario}.usable`,
      value: result.phases.usable ?? 0,
      unit: 'ms',
      direction: 'lower',
      percentile: 0.5,
      sampleSize: 1,
    });
    emitPerfMetric({
      name: `reconnect.${result.scenario}.dials`,
      value: result.dials,
      unit: 'count',
      direction: 'lower',
      sampleSize: 1,
    });
  }
}
