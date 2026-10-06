import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  buildDirectRedrawLoopCommand,
  directRedrawReadyMarker,
  summarizeDirectRedrawCoverage,
} from './direct-redraw-coverage';

describe('Direct redraw density coverage', () => {
  test('installs once and cannot emit the next ordinal before one input line', async () => {
    const readyPrefix = 'direct-small-ready-abc123';
    const finalMarker = 'direct-small-done-abc123';
    const command = buildDirectRedrawLoopCommand('small-multirow', readyPrefix, finalMarker, 100);
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    const output = { value: '' };
    const stderr = { value: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output.value += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr.value += chunk;
    });
    try {
      await waitForOutput(output, directRedrawReadyMarker(readyPrefix, 0));
      expect(output.value).not.toContain(directRedrawReadyMarker(readyPrefix, 1));

      child.stdin.write('\n');
      await waitForOutput(output, directRedrawReadyMarker(readyPrefix, 1));
      expect(output.value).toContain('direct-small-000-alpha');
      expect(output.value).toContain('direct-small-000-bravo');

      child.stdin.end('\n'.repeat(99));
      const [status] = await closed;
      expect(status).toBe(0);
      expect(stderr.value).toBe('');
      expect(output.value).toContain('direct-small-099-alpha');
      expect(output.value).toContain('direct-small-099-bravo');
      expect(output.value).toContain(finalMarker);
      for (let sample = 0; sample < 100; sample += 1) {
        expect(output.value).toContain(directRedrawReadyMarker(readyPrefix, sample));
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await closed;
      }
    }
  });

  test('rejects an underpowered or injection-shaped redraw driver', () => {
    expect(() => buildDirectRedrawLoopCommand('bounded-cat', 'ready', 'done', 99)).toThrow(
      'invalid Direct redraw-trigger loop contract',
    );
    expect(() =>
      buildDirectRedrawLoopCommand('bounded-cat', 'ready;echo-bad', 'done', 100),
    ).toThrow('invalid Direct redraw-trigger loop contract');
    expect(() => directRedrawReadyMarker('ready', -1)).toThrow(
      'invalid Direct redraw-trigger ready marker',
    );
  });

  test('pins every small and dense window to its exact row/unit/byte population', () => {
    expect(summarizeDirectRedrawCoverage('small-multirow', [2, 3], [1, 2], [80, 120], 2)).toEqual({
      kind: 'small-multirow',
      windowCount: 2,
      minimumRowsPerWindow: 2,
      observedMinimumRows: 2,
      appliedDisplayUnitCount: 3,
      payloadByteCount: 200,
      singletonFullUpdateWindowCount: 1,
      multiUnitWindowCount: 1,
      crossUnitCoverage: 'observed-in-this-population',
    });
    expect(summarizeDirectRedrawCoverage('tmux', [40], [1], [900], 1)).toMatchObject({
      minimumRowsPerWindow: 23,
      observedMinimumRows: 40,
      singletonFullUpdateWindowCount: 1,
      multiUnitWindowCount: 0,
      crossUnitCoverage: 'suite-carrier-repair-multi-unit-sentinel',
    });
  });

  test('rejects a nominal dense redraw that applies only one row in every window', () => {
    expect(() =>
      summarizeDirectRedrawCoverage('bounded-cat', [1, 1], [2, 2], [500, 500], 2),
    ).toThrow('at least 23');
  });

  test('rejects missing windows or empty applied-unit and byte evidence', () => {
    expect(() => summarizeDirectRedrawCoverage('neovim', [30], [1], [], 1)).toThrow('do not match');
    expect(() => summarizeDirectRedrawCoverage('neovim', [30], [0], [50], 1)).toThrow(
      'no applied display unit',
    );
    expect(() => summarizeDirectRedrawCoverage('neovim', [30], [1], [0], 1)).toThrow(
      'no applied display payload bytes',
    );
  });
});

async function waitForOutput(output: { value: string }, marker: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!output.value.includes(marker)) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${marker}`);
    await Bun.sleep(1);
  }
}
