import { afterEach, describe, expect, test } from 'bun:test';

import type { WorkerEvent } from '../../../apps/web/src/terminal-worker-protocol';
import { recordPresentationMeasurementBoundaryInPage } from './presentation-measurement-boundary';

type RingBoundaryWorkerEvent = Extract<WorkerEvent, { kind: 'perf_display_ring_boundary' }>;

const scope = globalThis as unknown as {
  __merkurTerminalPerf?: { record(event: unknown): void };
  __merkurTerminalPerfReadDisplayRingBoundary?: () => Promise<unknown>;
  __merkurPerfDrainStatus?: () => Promise<unknown>;
};

afterEach(() => {
  delete scope.__merkurTerminalPerf;
  delete scope.__merkurTerminalPerfReadDisplayRingBoundary;
  delete scope.__merkurPerfDrainStatus;
});

const ringBoundary: RingBoundaryWorkerEvent = {
  kind: 'perf_display_ring_boundary',
  observationEpoch: 7,
  requestId: 19,
  sessionEpoch: 3,
  atMs: 123.5,
  ringDroppedTotal: 11,
};

function graphicsDrainStatus(firstByte: number, failed: number, queuedCount = 0) {
  return {
    activity: {
      observationEpoch: 3,
      graphicsAsset: { firstByte, consumed: 0, failed },
      input: { queuedCount, queuedSeq: queuedCount },
    },
  };
}

describe('presentation measurement page callback', () => {
  test('canonicalizes an actual display-ring WorkerEvent without retaining its kind or request id', async () => {
    const recorded: unknown[] = [];
    const response: RingBoundaryWorkerEvent = {
      kind: 'perf_display_ring_boundary',
      observationEpoch: 7,
      requestId: 19,
      sessionEpoch: 3,
      atMs: 123.5,
      ringDroppedTotal: 11,
    };
    scope.__merkurTerminalPerf = { record: (event) => recorded.push(event) };
    scope.__merkurTerminalPerfReadDisplayRingBoundary = async () => response;

    const returned = await recordPresentationMeasurementBoundaryInPage({
      id: 41,
      boundaryPhase: 'start',
      boundaryPurpose: 'streaming',
    });

    expect(returned.ringBoundary).toBe(response);
    expect(returned.timedInputBaseline).toBeNull();
    expect(recorded).toEqual([
      {
        kind: 'presentation_measurement_boundary',
        atMs: 123.5,
        measurementId: 41,
        phase: 'start',
        purpose: 'streaming',
      },
      {
        kind: 'display_ring_measurement_boundary',
        atMs: 123.5,
        measurementId: 41,
        phase: 'start',
        observationEpoch: 7,
        sessionEpoch: 3,
        ringDroppedTotal: 11,
      },
    ]);
    expect(recorded[1]).not.toHaveProperty('requestId');
  });

  test('opens a window in the same task that sees its graphics transition, not before', async () => {
    const recorded: unknown[] = [];
    const statuses = [
      graphicsDrainStatus(4, 1),
      graphicsDrainStatus(4, 1),
      graphicsDrainStatus(5, 1),
    ];
    let reads = 0;
    scope.__merkurPerfDrainStatus = async () => statuses[Math.min(reads++, statuses.length - 1)];
    scope.__merkurTerminalPerf = { record: (event) => recorded.push(event) };
    scope.__merkurTerminalPerfReadDisplayRingBoundary = async () => {
      expect(reads).toBe(3);
      return ringBoundary;
    };

    await recordPresentationMeasurementBoundaryInPage({
      id: 5,
      boundaryPhase: 'start',
      boundaryPurpose: 'isolated-interactive',
      afterGraphicsAsset: { phase: 'firstByte', atLeast: 5, failedBaseline: 1, livenessMs: 1_000 },
    });
    expect(reads).toBe(3);
    expect(recorded).toHaveLength(2);
  });

  test('a timed window takes its input baseline from the final asset read, before its boundary', async () => {
    const statuses = [
      graphicsDrainStatus(4, 1, 6),
      graphicsDrainStatus(4, 1, 7),
      graphicsDrainStatus(5, 1, 7),
    ];
    let reads = 0;
    scope.__merkurPerfDrainStatus = async () => statuses[Math.min(reads++, statuses.length - 1)];
    scope.__merkurTerminalPerf = { record: () => {} };
    scope.__merkurTerminalPerfReadDisplayRingBoundary = async () => ringBoundary;

    const returned = await recordPresentationMeasurementBoundaryInPage({
      id: 7,
      boundaryPhase: 'start',
      boundaryPurpose: 'isolated-interactive',
      afterGraphicsAsset: { phase: 'firstByte', atLeast: 5, failedBaseline: 1, livenessMs: 1_000 },
      timedInput: true,
    });
    expect(reads).toBe(3);
    expect(returned.timedInputBaseline).toEqual({
      observationEpoch: 3,
      input: { queuedCount: 7, queuedSeq: 7 },
    });
  });

  test('a timed window without an asset wait reads its baseline once, before its boundary', async () => {
    const recorded: unknown[] = [];
    let reads = 0;
    scope.__merkurPerfDrainStatus = async () => {
      expect(recorded).toEqual([]);
      reads += 1;
      return graphicsDrainStatus(0, 0, 2);
    };
    scope.__merkurTerminalPerf = { record: (event) => recorded.push(event) };
    scope.__merkurTerminalPerfReadDisplayRingBoundary = async () => ringBoundary;

    const returned = await recordPresentationMeasurementBoundaryInPage({
      id: 8,
      boundaryPhase: 'start',
      boundaryPurpose: 'isolated-interactive',
      timedInput: true,
    });
    expect(reads).toBe(1);
    expect(recorded).toHaveLength(2);
    expect(returned.timedInputBaseline).toEqual({
      observationEpoch: 3,
      input: { queuedCount: 2, queuedSeq: 2 },
    });
  });

  test('refuses to open a window once a graphics tile job has failed', async () => {
    const recorded: unknown[] = [];
    scope.__merkurPerfDrainStatus = async () => graphicsDrainStatus(0, 2);
    scope.__merkurTerminalPerf = { record: (event) => recorded.push(event) };
    scope.__merkurTerminalPerfReadDisplayRingBoundary = async () => ringBoundary;

    await expect(
      recordPresentationMeasurementBoundaryInPage({
        id: 6,
        boundaryPhase: 'start',
        boundaryPurpose: 'isolated-interactive',
        afterGraphicsAsset: {
          phase: 'firstByte',
          atLeast: 1,
          failedBaseline: 1,
          livenessMs: 1_000,
        },
      }),
    ).rejects.toThrow(/failed before the window/);
    expect(recorded).toEqual([]);
  });
});
