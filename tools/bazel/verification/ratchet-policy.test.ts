import { expect, test } from 'bun:test';
import { runCapturedRatchetPolicy } from './ratchet-policy';

test('the complete captured source satisfies the existing three ratchet policies', async () => {
  expect(await runCapturedRatchetPolicy()).toBe(0);
}, 180_000);
