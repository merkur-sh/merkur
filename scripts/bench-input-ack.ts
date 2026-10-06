/** Actual authenticated WASM input/retry/ACK path under a deterministic carrier schedule.
 * The native crypto peer records ordered application admission; no PTY or QUIC cost is measured.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { encodeTextRecord } from '../packages/protocol/src/input-record';
import { createClientSessionFixture, type SessionFixtureWire } from './perf/client-session-fixture';
import { summarizeSamples } from './perf/harness';

export interface InputLabScenario {
  readonly name: string;
  readonly rtt: number;
  readonly count?: number;
  readonly interval?: number;
  readonly ackHoldUntil?: number;
  readonly inputHoldUntil?: number;
  readonly inputDatagramBlackhole?: boolean;
  readonly dropFirstDatagram?: boolean;
}
export const INPUT_LAB_SCENARIOS: readonly InputLabScenario[] = [
  { name: 'clean-6ms', rtt: 6 },
  { name: 'clean-60ms', rtt: 60 },
  { name: 'ACK-stream-held-300ms', rtt: 60, ackHoldUntil: 330 },
  { name: 'input-stream-held-300ms', rtt: 60, inputHoldUntil: 330 },
  { name: 'input-datagrams-blackholed', rtt: 60, inputDatagramBlackhole: true },
  { name: 'first-input-datagram-lost', rtt: 60, dropFirstDatagram: true },
];
export async function runInputScenario(scenario: InputLabScenario) {
  const fixture = await createClientSessionFixture();
  const start = fixture.now();
  const count = scenario.count ?? 24;
  const interval = scenario.interval ?? 50;
  const events: { at: number; order: number; run: () => void | Promise<void> }[] = [];
  let order = 0;
  let datagrams = 0;
  let lastAck = 0;
  const admitted: number[] = [];
  const acknowledged: number[] = [];
  const sent: number[] = [];
  const expected: Uint8Array[] = [];
  let applied = 0;
  const schedule = (at: number, run: () => void | Promise<void>): void => {
    events.push({ at, order: order++, run });
  };
  fixture.incomingWire((_channel, _payload, deliver) => {
    schedule(
      Math.max(fixture.now() - start + scenario.rtt / 2, scenario.ackHoldUntil ?? 0),
      deliver,
    );
  });
  const wire: SessionFixtureWire = async (action, deliver) => {
    if (action.kind === 7) {
      datagrams++;
      if (scenario.inputDatagramBlackhole || (scenario.dropFirstDatagram && datagrams === 1))
        return;
    }
    schedule(
      Math.max(
        fixture.now() - start + scenario.rtt / 2,
        action.kind === 5 && action.channel === 1 ? (scenario.inputHoldUntil ?? 0) : 0,
      ),
      deliver,
    );
  };
  for (let index = 0; index < count; index++)
    schedule(index * interval, async () => {
      const record = encodeTextRecord(['a', 'é', '中', '\u001b[D'][index % 4] ?? 'a');
      expected.push(record);
      sent.push(fixture.now() - start);
      assert(fixture.input(index + 1, record));
      await fixture.settle(wire);
    });
  try {
    for (let steps = 0; steps < 100_000; steps++) {
      if (fixture.session.released_input() === count) break;
      events.sort((a, b) => a.at - b.at || a.order - b.order);
      if (await fixture.step(events[0], start)) events.shift();
      await fixture.settle(wire);
      while (applied < fixture.applied.length) {
        const entry = fixture.applied[applied];
        assert(entry !== undefined);
        assert.equal(entry.sequence, applied + 1);
        assert.deepEqual(Uint8Array.from(entry.record), expected[applied]);
        admitted.push(fixture.now() - start - (sent[applied] ?? 0));
        applied++;
      }
      const ack = fixture.session.released_input();
      while (lastAck < ack) {
        acknowledged.push(fixture.now() - start - (sent[lastAck] ?? 0));
        lastAck++;
      }
    }
    assert.equal(applied, count, 'ordered, exactly once native application admission');
    assert.equal(lastAck, count, 'authenticated ACK converges');
    return {
      scenario: scenario.name,
      requested: count,
      delivered: applied,
      acknowledged: lastAck,
      admissionMs: summarizeSamples(admitted),
      ackMs: summarizeSamples(acknowledged),
      ...fixture.counts(),
    };
  } finally {
    await fixture.close();
  }
}
export function validateInputLabResults(
  results: readonly Awaited<ReturnType<typeof runInputScenario>>[],
): void {
  for (const result of results) {
    assert.equal(result.delivered, result.requested);
    assert.equal(result.acknowledged, result.requested);
  }
}
if (import.meta.main) {
  const results = [];
  for (const scenario of INPUT_LAB_SCENARIOS) results.push(await runInputScenario(scenario));
  validateInputLabResults(results);
  const output =
    process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ??
    '/tmp/merkur-input-ack-lab.json';
  await writeFile(
    output,
    JSON.stringify(
      {
        kind: 'authenticated-wasm-input-ack',
        assumptions:
          'Virtual carrier timing; real Rust Session, hybrid/Noise, ordered native application admission. No QUIC or PTY latency.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(`Validated ${results.length} authenticated runs: ${output}\n`);
}
