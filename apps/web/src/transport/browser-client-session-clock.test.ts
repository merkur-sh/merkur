import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./browser-client-session.ts', import.meta.url), 'utf8');
function body(name: string): string {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  }', start);
  if (start < 0 || end < start) throw new Error(`missing ${name}`);
  return source.slice(start, end + 4);
}

test('ACK telemetry retains the host receipt clock instead of rounding before input admission', () => {
  const acknowledgements: number[][] = [];
  let ack = 1;
  const context = {
    session: {
      input_ack_local: () => ack,
      input_ack_at: () => 10, // The scheduling clock has whole-millisecond precision.
      network_rtt_ms: () => 0,
      released_input: () => 0,
    },
    acknowledgedProjection: 0,
    released: 0,
    performance: { timeOrigin: 1_000, now: () => 10.95 },
    host: { inputAcknowledged: (...args: number[]) => acknowledgements.push(args) },
  };
  const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `${body('releaseInput')}\nglobalThis.release = releaseInput;`,
  );
  const release = runInNewContext(`${program}\nglobalThis.release;`, context) as () => void;
  release();
  release();
  expect(acknowledgements).toEqual([[1, 1_010.95, 0]]);
  expect(acknowledgements[0]?.[1]).toBeGreaterThan(1_010.8); // Input admission this turn.
  ack = 2;
  release();
  expect(acknowledgements).toHaveLength(2);
});
