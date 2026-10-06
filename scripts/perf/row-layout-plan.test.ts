import { expect, test } from 'bun:test';
import { runTestProcess } from '../test-process';
import { rowLayoutFootprint } from './row-layout-plan';

test('exact-column slabs bound memory by terminal dimensions, not current sparse content', () => {
  expect(rowLayoutFootprint(320, 100, 418)).toEqual({
    slots: 32000,
    liveGlyphs: 418,
    glyphBytes: 1792000,
    backgroundBytes: 896000,
    decorationBytes: 7168000,
    vacantSlots: 31582,
  });
  const maximum = rowLayoutFootprint(512, 192, 98304);
  expect(maximum.glyphBytes + maximum.backgroundBytes + maximum.decorationBytes).toBe(30277632);
  expect(rowLayoutFootprint(384, 256, 1).slots).toBe(98304);
  for (const values of [
    [513, 1, 1],
    [512, 193, 1],
    [1, 257, 1],
    [80, 24, 1921],
    [1.5, 24, 1],
    [80, 24, -1],
  ] as const)
    expect(() => rowLayoutFootprint(values[0], values[1], values[2])).toThrow();
});

test('both storage arms bundle the same shader and untimed nonblank final-image oracle', async () => {
  const result = await runTestProcess(
    [
      'bun',
      '-e',
      `const result = await Bun.build({ entrypoints: ['scripts/perf/row-layout-worker.ts'], target: 'browser', format: 'esm' }); if (!result.success) throw new Error(String(result.logs)); process.stdout.write(await result.outputs[0].text());`,
    ],
    { cwd: new URL('../..', import.meta.url).pathname },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  const source = result.stdout;
  expect(source).toContain('final row-layout image is blank');
  expect(source).toContain('onSubmittedWorkDone');
  expect(source).not.toContain('WebGl2Renderer');
});
