import { expect, test } from 'bun:test';
import { greenTestFiles } from '../../../scripts/verification-junit';

test('uses the pinned Bun runtime', () => {
  expect(Bun.version).toBe('1.4.2');
});

test('resolves an ESM dependency from the declared root closure', async () => {
  const { Effect } = await import('effect');
  expect(Effect.runSync(Effect.succeed(41))).toBe(41);
});

test('loads the locked native parser addon in Bun', async () => {
  const { parseSync } = await import('oxc-parser');
  const parsed = parseSync('fixture.ts', 'export const answer: number = 6 * 7;');
  expect(parsed.errors).toEqual([]);
  expect(parsed.program.body[0]?.type).toBe('ExportNamedDeclaration');
});

test('starts a worker from declared runfiles', async () => {
  const worker = new Worker(new URL('./runtime-worker.ts', import.meta.url).href);
  try {
    const received = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
      worker.onerror = reject;
    });
    worker.postMessage(17);
    expect(await received).toEqual({ version: '1.4.2', doubled: 34 });
  } finally {
    worker.terminate();
  }
});

test('JUnit rejects missing, truncated and inconsistent success reports', () => {
  for (const report of [
    '',
    '<testsuites>',
    '<testsuites tests="1" failures="0" skipped="0"></testsuites>',
    '<testsuites tests="0" failures="0" skipped="0" errors="1"></testsuites>',
  ]) {
    expect(greenTestFiles(report, process.cwd(), ['runtime.test.ts'])).toEqual([]);
  }
});
