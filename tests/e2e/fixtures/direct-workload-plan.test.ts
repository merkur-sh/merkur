import { expect, test } from 'bun:test';
import {
  DIRECT_TYPING_WORKLOADS,
  directIrregularTypingSteps,
  directTypingGpuTraceEnabled,
  directWorkloadSelection,
} from './direct-workload-plan';

test('default includes the complete Direct population', () => {
  expect(directWorkloadSelection(undefined)).toEqual({
    diagnosticWorkload: null,
    typing: true,
    redraw: true,
    tmux: true,
    neovim: true,
    completeSuitePopulation: true,
  });
});

test('each diagnostic selects one workload and never claims the complete suite', () => {
  for (const selected of ['typing', 'redraw', 'tmux', 'neovim'] as const) {
    const scope = directWorkloadSelection(selected);
    expect(scope.diagnosticWorkload).toBe(selected);
    expect(scope.completeSuitePopulation).toBe(false);
    for (const workload of ['typing', 'redraw', 'tmux', 'neovim'] as const) {
      expect(scope[workload]).toBe(workload === selected);
    }
  }
  expect(() => directWorkloadSelection('')).toThrow();
  expect(() => directWorkloadSelection('all')).toThrow();
});

test('irregular typing remains separate from every regular cadence', () => {
  expect(DIRECT_TYPING_WORKLOADS.map((workload) => workload.name)).toEqual([
    'typing-0ms',
    'typing-8ms',
    'typing-16ms',
    'typing-33ms',
    'typing-80ms',
    'typing-100ms',
    'typing-irregular-100ms',
  ]);
  const steps = directIrregularTypingSteps();
  expect(steps).toHaveLength(240);
  expect(steps.reduce((sum, step) => sum + step.delayMs, 0)).toBe(24_000);
  expect(new Set(steps.map((step) => step.delayMs)).size).toBe(10);
  for (let cycle = 0; cycle < 6; cycle += 1) {
    const run = steps.slice(cycle * 40, cycle * 40 + 40);
    expect(
      run
        .slice(0, 20)
        .map((step) => step.key)
        .join(''),
    ).toBe('0123456789abcdefghij');
    expect(run.slice(20).every((step) => step.key === 'Backspace')).toBe(true);
    expect(run.reduce((sum, step) => sum + step.delayMs, 0)).toBe(4_000);
  }
});

test('GPU typing diagnostics trace exactly two unchanged populations', () => {
  const original = JSON.stringify(DIRECT_TYPING_WORKLOADS);
  expect(DIRECT_TYPING_WORKLOADS).toHaveLength(7);
  expect(
    DIRECT_TYPING_WORKLOADS.filter((workload) => directTypingGpuTraceEnabled(true, workload)).map(
      (workload) => workload.name,
    ),
  ).toEqual(['typing-100ms', 'typing-irregular-100ms']);
  expect(
    DIRECT_TYPING_WORKLOADS.some((workload) => directTypingGpuTraceEnabled(false, workload)),
  ).toBe(false);
  expect(JSON.stringify(DIRECT_TYPING_WORKLOADS)).toBe(original);
});
