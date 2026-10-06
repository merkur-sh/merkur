import { expect, test } from 'bun:test';
import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import { packingInputOwnership } from './packing-delivery-inputs';

const input = (
  inputSeq: number,
  atMs: number,
): Extract<TerminalPerfEvent, { kind: 'input_queued' }> => ({
  kind: 'input_queued',
  inputSeq,
  atMs,
  admittedAtMs: atMs,
  byteLength: 1,
});

test('bulk-only and overlap have distinct causal endpoint populations', () => {
  expect(packingInputOwnership([input(1, 10)], 'bulk-only', null).finalOwnedInputSeq).toBe(1);
  const overlap = packingInputOwnership([input(1, 10), input(2, 18)], 'overlap-row', 8);
  expect(overlap.finalOwnedInputSeq).toBe(2);
  expect(overlap.endpointScope).toContain('no synthetic per-input completion');
  expect(overlap.followupEffect).toContain('two-row');
  expect(() => packingInputOwnership([input(1, 10)], 'bulk-only', 1)).toThrow();
  expect(() => packingInputOwnership([input(1, 10)], 'overlap-header', null)).toThrow();
});

test('actual interval is gated rather than silently relabeled after timer slippage', () => {
  for (const [label, minimum, maximum] of [
    [1, 0.5, 4],
    [8, 6, 12],
    [16, 14, 20],
  ] as const) {
    expect(
      packingInputOwnership([input(1, 100), input(2, 100 + minimum)], 'overlap-header', label)
        .actualOffsetMs,
    ).toBe(minimum);
    expect(() =>
      packingInputOwnership([input(1, 100), input(2, 100 + maximum)], 'overlap-header', label),
    ).toThrow();
    expect(() =>
      packingInputOwnership(
        [input(1, 100), input(2, 100 + minimum - 0.1)],
        'overlap-header',
        label,
      ),
    ).toThrow();
  }
  expect(() =>
    packingInputOwnership([input(1, 100), input(2, 116)], 'overlap-header', 1),
  ).toThrow();
});

test('extra, duplicate, noncontiguous, multibyte and invalid input ownership fail closed', () => {
  for (const events of [
    [input(1, 10)],
    [input(1, 10), input(1, 11)],
    [input(1, 10), input(3, 11)],
    [input(1, 10), input(2, 11), input(3, 12)],
    [input(0, 10), input(1, 11)],
    [input(1, 10), { ...input(2, 11), byteLength: 2 }],
    [input(1, 10), { ...input(2, 11), admittedAtMs: 9 }],
  ])
    expect(() => packingInputOwnership(events, 'overlap-row', 1)).toThrow();
  expect(
    packingInputOwnership([input(0xffff_ffff, 10), input(1, 11)], 'overlap-header', 1)
      .finalOwnedInputSeq,
  ).toBe(1);
});
