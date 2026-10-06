import { expect, test } from 'bun:test';
import { runInputScenario } from './bench-input-ack';

test('authenticated ACK releases exact original input records while datagrams are blackholed', async () => {
  const result = await runInputScenario({
    name: 'reliable-under-datagram-loss',
    rtt: 6,
    count: 4,
    inputDatagramBlackhole: true,
  });
  expect(result.delivered).toBe(4);
  expect(result.acknowledged).toBe(4);
  expect(result.reliableInputs).toBeGreaterThan(0);
}, 120_000);
test('withheld authenticated ACK retains and retries records without duplicate application admission', async () => {
  const result = await runInputScenario({ name: 'ACK-held', rtt: 6, count: 1, ackHoldUntil: 200 });
  expect(result.delivered).toBe(1);
  expect(result.acknowledged).toBe(1);
  expect(result.datagrams).toBeGreaterThan(1);
}, 120_000);
