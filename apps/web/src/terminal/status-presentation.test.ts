import { describe, expect, test } from 'bun:test';

import type { TerminalStartupMilestone } from '../perf/terminal-latency';
import {
  decideTerminalStartFailure,
  shouldPublishTerminalStartFailure,
  type TerminalStage,
  terminalStatusCopyStage,
  terminalStatusModeForStage,
} from './status-presentation';

describe('terminal status presentation', () => {
  test('shows success once a frame is usable', () => {
    expect(terminalStatusModeForStage('idle')).toBe('hidden');
    expect(terminalStatusModeForStage('connected')).toBe('success');
  });

  test('presents setup and recovery stages as progress', () => {
    const stages: TerminalStage[] = [
      'signaling',
      'connecting',
      'authenticating',
      'first-frame',
      'reconnecting',
    ];

    for (const stage of stages) {
      expect(terminalStatusModeForStage(stage)).toBe('progress');
    }
    expect(terminalStatusModeForStage('connected', true)).toBe('progress');
  });

  test('a reconnect over a connected stage is described as a reconnect', () => {
    expect(terminalStatusCopyStage('connected', 'progress')).toBe('reconnecting');
    expect(terminalStatusCopyStage('connected', 'success')).toBe('connected');
    expect(terminalStatusCopyStage('first-frame', 'progress')).toBe('first-frame');
    expect(terminalStatusCopyStage('disconnected', 'error')).toBe('disconnected');
  });

  test('presents terminal failures assertively', () => {
    expect(terminalStatusModeForStage('disconnected')).toBe('error');
    expect(terminalStatusModeForStage('failed')).toBe('error');
    expect(terminalStatusModeForStage('failed', true)).toBe('error');
  });

  test('does not let a start rejection overwrite reconnect ownership', () => {
    expect(shouldPublishTerminalStartFailure('signaling')).toBe(true);
    expect(shouldPublishTerminalStartFailure('connecting')).toBe(true);
    expect(shouldPublishTerminalStartFailure('authenticating')).toBe(true);

    expect(shouldPublishTerminalStartFailure('reconnecting')).toBe(false);
    expect(shouldPublishTerminalStartFailure('disconnected')).toBe(false);
    expect(shouldPublishTerminalStartFailure('failed')).toBe(false);
    expect(shouldPublishTerminalStartFailure('first-frame')).toBe(false);
    expect(shouldPublishTerminalStartFailure('connected')).toBe(false);
    expect(shouldPublishTerminalStartFailure('idle')).toBe(false);
  });

  test('retains an edge-failed startup trace through its authoritative GPU-visible milestone', () => {
    const recoverableTrace = new Set<TerminalStartupMilestone>(['transport_start']);
    // `onDisconnected('edge-failed')` owns retry presentation and advances this
    // stage synchronously before the matching start promise rejects.
    const recoverableFailure = decideTerminalStartFailure('reconnecting', true);

    expect(recoverableFailure).toEqual({
      publishFailure: false,
      retainStartupTrace: true,
    });
    for (const milestone of [
      'transport_connected',
      'first_display_applied',
      'first_display_visible',
    ] as const) {
      if (recoverableFailure.retainStartupTrace) recoverableTrace.add(milestone);
    }
    expect(recoverableTrace).toEqual(
      new Set<TerminalStartupMilestone>([
        'transport_start',
        'transport_connected',
        'first_display_applied',
        'first_display_visible',
      ]),
    );

    let definitiveTrace: Set<TerminalStartupMilestone> | null = new Set<TerminalStartupMilestone>([
      'transport_start',
    ]);
    const definitiveFailure = decideTerminalStartFailure('connecting', true);
    expect(definitiveFailure).toEqual({
      publishFailure: true,
      retainStartupTrace: false,
    });
    if (!definitiveFailure.retainStartupTrace) definitiveTrace = null;
    expect(definitiveTrace).toBeNull();
  });
});
