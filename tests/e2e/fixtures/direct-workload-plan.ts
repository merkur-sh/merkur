import type { DirectTuiApplication } from './direct-tui-workloads';

export type DirectDiagnosticWorkload = 'typing' | 'redraw' | DirectTuiApplication;

/** Selection changes capture scope only; it never relaxes a selected phase's gates. */
export function directWorkloadSelection(value: string | undefined) {
  if (
    value !== undefined &&
    value !== 'typing' &&
    value !== 'redraw' &&
    value !== 'tmux' &&
    value !== 'neovim'
  ) {
    throw new Error('DIRECT_DIAGNOSTIC_WORKLOAD must be typing, redraw, tmux or neovim');
  }
  const diagnosticWorkload: DirectDiagnosticWorkload | null = value ?? null;
  return {
    diagnosticWorkload,
    typing: value === undefined || value === 'typing',
    redraw: value === undefined || value === 'redraw',
    tmux: value === undefined || value === 'tmux',
    neovim: value === undefined || value === 'neovim',
    completeSuitePopulation: value === undefined,
  };
}

// Ten intended per-input delays average 100 ms (~120 WPM at five characters/word).
// This is a deterministic irregular injection workload, not a human typing trace.
const IRREGULAR_DELAYS_MS = [30, 40, 60, 70, 90, 110, 130, 140, 160, 170] as const;

export const DIRECT_TYPING_WORKLOADS = [
  ...[0, 8, 16, 33, 80, 100].map((cadenceMs) => ({
    name: `typing-${cadenceMs}ms`,
    cadenceMs,
    pattern: 'regular' as const,
    delayPatternMs: [cadenceMs],
  })),
  {
    name: 'typing-irregular-100ms',
    cadenceMs: 100,
    pattern: 'irregular' as const,
    delayPatternMs: IRREGULAR_DELAYS_MS,
  },
] as const;

/** Tracing never filters the seven phase populations or changes their input driver. */
export function directTypingGpuTraceEnabled(
  traceRequested: boolean,
  workload: (typeof DIRECT_TYPING_WORKLOADS)[number],
): boolean {
  return traceRequested && workload.cadenceMs === 100;
}

/** Retains the same six 20-printable/20-backspace class runs as regular typing. */
export function directIrregularTypingSteps() {
  const printable = '0123456789abcdefghij';
  return Array.from({ length: 240 }, (_, ordinal) => {
    const classOrdinal = ordinal % 40;
    const key = classOrdinal < 20 ? printable[classOrdinal] : 'Backspace';
    const delayMs = IRREGULAR_DELAYS_MS[ordinal % IRREGULAR_DELAYS_MS.length];
    if (key === undefined || delayMs === undefined) throw new Error('invalid typing ordinal');
    return { ordinal, key, delayMs };
  });
}
