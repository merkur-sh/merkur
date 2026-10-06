import { expect, test } from 'bun:test';
import { createDisplayAckBenchmarkDriver } from './bench-display-ack-drain';

test('real viewer ACKs seal on the authenticated session and advance cumulative authority', async () => {
  const driver = await createDisplayAckBenchmarkDriver(3);
  try {
    expect(await driver.runBatch()).toMatchObject({ drained: 3, lastSequence: 3 });
    expect(await driver.runBatch()).toMatchObject({ drained: 3, lastSequence: 6 });
  } finally {
    await driver.close();
  }
}, 30_000);
test('an ACK crosses from the viewer to the session without a JavaScript object', async () => {
  const driver = await createDisplayAckBenchmarkDriver(1);
  try {
    // Warm both paths, then count: the port message this ring replaced minted
    // nineteen objects an ACK across the two workers.
    driver.measureOutputObjects(64);
    const measured = driver.measureOutputObjects(512);
    expect(measured.acks).toBeGreaterThanOrEqual(512);
    expect(Math.abs(measured.objectsPerAck)).toBeLessThan(0.1);
  } finally {
    await driver.close();
  }
}, 30_000);
test('invalid batch is refused before authentication and allocation', async () => {
  await expect(createDisplayAckBenchmarkDriver(0)).rejects.toThrow(
    'batchSize must be a positive safe integer',
  );
});
