import { afterEach, expect, test } from 'bun:test';
import { releaseHarnessPort, takeHarnessPort } from './harness-ports';

const index = process.env.TEST_PARALLEL_INDEX;

afterEach(() => {
  if (index === undefined) delete process.env.TEST_PARALLEL_INDEX;
  else process.env.TEST_PARALLEL_INDEX = index;
});

test("a worker's ports are its own block's, below the ephemeral ranges, and never held twice", () => {
  process.env.TEST_PARALLEL_INDEX = '3';
  const ports = Array.from({ length: 400 }, () => takeHarnessPort());
  expect(new Set(ports).size).toBe(400);
  expect(Math.min(...ports)).toBe(27_200);
  expect(Math.max(...ports)).toBe(27_599);
  expect(() => takeHarnessPort()).toThrow("all 400 ports of this worker's block are held");

  const [returned] = ports;
  if (returned === undefined) throw new Error('no port was taken');
  releaseHarnessPort(returned);
  expect(takeHarnessPort()).toBe(returned);
  for (const port of ports) releaseHarnessPort(port);
});

test('ports are handed out only inside a worker with a block below the ephemeral range', () => {
  delete process.env.TEST_PARALLEL_INDEX;
  expect(() => takeHarnessPort()).toThrow('inside a Playwright worker');
  process.env.TEST_PARALLEL_INDEX = '16';
  expect(() => takeHarnessPort()).toThrow('no port block below the ephemeral range');
});
