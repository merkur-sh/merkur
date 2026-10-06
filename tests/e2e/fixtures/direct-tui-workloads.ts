import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';

export type DirectTuiApplication = 'tmux' | 'neovim';

export interface DirectTuiToolEvidence {
  readonly application: DirectTuiApplication;
  readonly binaryName: 'tmux' | 'nvim';
  readonly path: string;
  readonly version: string;
  /** SHA-256 covers this executable file, not its dynamic libraries/runtime files. */
  readonly hashScope: 'executable-file-only';
  readonly sha256: string;
}

export interface DirectTuiExternalToolsEvidence {
  readonly tmux: DirectTuiToolEvidence;
  readonly neovim: DirectTuiToolEvidence;
}

export interface DirectTuiWorkloadPlan {
  readonly application: DirectTuiApplication;
  readonly readyMarker: string;
  readonly exitMarker: string;
  /** One shell command, including its trailing Enter. */
  readonly launchCommand: string;
  /** One physical byte per measured navigation operation. */
  readonly stepKeys: readonly [string] | readonly [string, string];
  /** Literal content produced by the application, not present in the launch command. */
  readonly initialViewportNeedle: string;
  /** The same state must be visible after each complete operation cycle. */
  readonly completedCycleViewportNeedle: string;
  readonly operationCycleLength: number;
  readonly cleanup:
    | {
        readonly kind: 'tmux-server';
        readonly executablePath: string;
        readonly socketName: string;
      }
    | { readonly kind: 'fixture-file'; readonly path: string };
  readonly exitKeys: readonly string[];
}

export interface DirectTuiActivationFence {
  readonly generation: number;
  /** Raw SPSC order; every member shares `applyAtMs` and the exact transaction below. */
  readonly latestApplyDisplaySeqs: readonly number[];
  /** Last raw-order member, retained only as a convenient diagnostic identity. */
  readonly displaySeq: number;
  readonly presentationTransactionSeq: number;
  readonly renderSeq: number;
  readonly applyAtMs: number;
  readonly commitAtMs: number;
  readonly fenceAtMs: number;
  /** The grid was constant from this request boundary through `proofCutAtMs`. */
  readonly viewportRequestedAtMs: number;
  readonly viewportCompletedAtMs: number;
  /** Main-thread cut taken after the response and immediately before trace capture. */
  readonly proofCutAtMs: number;
  /** Lossless trace capture completed after the post-response proof cut. */
  readonly proofCapturedAtMs: number;
}

export interface DirectTuiViewportProofBounds {
  readonly activatedAtMs: number;
  readonly viewportRequestedAtMs: number;
  readonly viewportCompletedAtMs: number;
  readonly proofCutAtMs: number;
  readonly proofCapturedAtMs: number;
}

export interface DirectCoherentInputWindow {
  readonly measurementId: number;
  readonly startAtMs: number;
  readonly endAtMs: number;
  readonly inputSeq: number;
}

export interface DirectCoherentInputPopulation {
  readonly windowCount: number;
  readonly inputCount: number;
  readonly inputBytesPerWindow: 1;
  readonly windows: readonly DirectCoherentInputWindow[];
}

export interface DirectTuiViewportMatch {
  readonly rowIndex: number;
  readonly rowText: string;
}

export interface DirectTuiViewportMarkerEvidence {
  readonly attempts: number;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly snapshot: DirectTuiViewportSnapshot;
  readonly match: DirectTuiViewportMatch;
}

export interface DirectTuiViewportMarkerWaitOptions {
  readonly read: () => Promise<DirectTuiViewportSnapshot>;
  readonly assertReaderIdentity: () => Promise<void>;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface DirectTuiViewportSnapshot {
  readonly text: string;
  /** Main-thread shared-clock timestamp immediately before posting the worker query. */
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
}

export interface DirectTuiActivationObservationOptions {
  readonly waitForReady: () => Promise<void>;
  readonly resetObservation: () => Promise<void>;
  readonly now: () => Promise<number>;
  readonly activate: () => Promise<void>;
}

/**
 * Start one TUI from a fresh diagnostic observation.
 *
 * The prior redraw population can legitimately fill the fixed recorder. The
 * ready marker belongs to shell setup, while the activation Enter and every
 * application-produced event belong to the activation proof. Keeping this
 * order in one tested helper prevents an old phase from truncating that proof.
 */
export async function beginDirectTuiActivationObservation(
  options: DirectTuiActivationObservationOptions,
): Promise<number> {
  await options.waitForReady();
  await options.resetObservation();
  const activatedAtMs = await options.now();
  if (!Number.isFinite(activatedAtMs)) {
    throw new Error('Direct TUI activation timestamp is invalid');
  }
  await options.activate();
  return activatedAtMs;
}

export function validateDirectTuiActivationMeasurementBoundary(
  events: readonly TerminalPerfEvent[],
  expected: {
    readonly measurementId: number;
    readonly activatedAtMs: number;
    readonly proofCutAtMs: number;
    readonly sessionEpoch: number;
  },
): string[] {
  const errors: string[] = [];
  if (
    !Number.isSafeInteger(expected.measurementId) ||
    expected.measurementId <= 0 ||
    !Number.isFinite(expected.activatedAtMs) ||
    !Number.isFinite(expected.proofCutAtMs) ||
    expected.proofCutAtMs < expected.activatedAtMs ||
    !Number.isSafeInteger(expected.sessionEpoch) ||
    expected.sessionEpoch <= 0
  ) {
    return ['Direct TUI activation measurement expectation is invalid'];
  }
  const allBoundaries = events.filter(
    (event): event is Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }> =>
      event.kind === 'display_ring_measurement_boundary',
  );
  const boundaries = allBoundaries.filter(
    (event) => event.measurementId === expected.measurementId,
  );
  const starts = boundaries.filter((event) => event.phase === 'start');
  const ends = boundaries.filter((event) => event.phase === 'end');
  if (allBoundaries.length !== 2 || boundaries.length !== 2) {
    errors.push(
      `Direct TUI activation proof has ${allBoundaries.length} ring boundaries, ${boundaries.length} for measurement ${expected.measurementId}`,
    );
  }
  if (starts.length !== 1 || ends.length !== 1) {
    errors.push(
      `Direct TUI activation measurement ${expected.measurementId} has ${starts.length} START and ${ends.length} END boundaries`,
    );
    return errors;
  }
  const start = starts[0];
  const end = ends[0];
  if (start === undefined || end === undefined) return errors;
  if (
    start.sessionEpoch !== expected.sessionEpoch ||
    end.sessionEpoch !== expected.sessionEpoch ||
    start.observationEpoch !== end.observationEpoch
  ) {
    errors.push('Direct TUI activation ring boundaries do not share the calibrated lineage');
  }
  if (
    start.atMs < expected.activatedAtMs ||
    end.atMs <= start.atMs ||
    end.atMs > expected.proofCutAtMs
  ) {
    errors.push('Direct TUI activation ring boundary is outside the activation proof interval');
  }
  const refusedFrameCount = (end.ringDroppedTotal - start.ringDroppedTotal) >>> 0;
  if (refusedFrameCount !== 0) {
    errors.push(`Direct TUI activation receive ring refused ${refusedFrameCount} frames`);
  }
  return errors;
}

/** Required capabilities for the dedicated TUI populations; there is no substitute path. */
export function resolveRequiredDirectTuiTools(
  pathEnvironment = process.env.PATH ?? '',
): DirectTuiExternalToolsEvidence {
  return {
    tmux: inspectRequiredTool('tmux', 'tmux', ['-V'], pathEnvironment),
    neovim: inspectRequiredTool('neovim', 'nvim', ['--version'], pathEnvironment),
  };
}

/** Playwright-serializable access to the profiling-only worker viewport query. */
export async function readDirectTuiViewportSnapshot(): Promise<DirectTuiViewportSnapshot> {
  const read = (
    globalThis as typeof globalThis & {
      __merkurTerminalPerfReadViewportText?: () => Promise<unknown>;
    }
  ).__merkurTerminalPerfReadViewportText;
  if (read === undefined) throw new Error('terminal profiling viewport query is unavailable');
  const requestedAtMs = performance.timeOrigin + performance.now();
  const text = await read();
  if (typeof text !== 'string') throw new Error('terminal profiling viewport query is malformed');
  return {
    text,
    requestedAtMs,
    completedAtMs: performance.timeOrigin + performance.now(),
  };
}

/** Require literal application-produced text in the worker's current visible grid. */
export function matchDirectTuiViewport(
  viewportText: string,
  needle: string,
): DirectTuiViewportMatch {
  if (needle.length === 0 || needle.includes('\n')) {
    throw new Error('Direct TUI viewport needle must be one non-empty row fragment');
  }
  const rows = viewportText.split('\n');
  const rowIndex = rows.findIndex((row) => row.includes(needle));
  const rowText = rows[rowIndex];
  if (rowIndex < 0 || rowText === undefined) {
    throw new Error(`Direct TUI viewport does not contain ${JSON.stringify(needle)}`);
  }
  return { rowIndex, rowText };
}

/**
 * Wait outside every judged window for one exact current-grid marker row.
 *
 * Shell command echo can contain the marker before the application prints its
 * standalone row, so substring-first matching is not an exact readiness
 * oracle. Every retry uses the same page clock deadline and brackets its worker
 * query with the calibrated reader-identity fence.
 */
export async function waitForDirectTuiViewportMarker(
  marker: string,
  options: DirectTuiViewportMarkerWaitOptions,
): Promise<DirectTuiViewportMarkerEvidence> {
  if (marker.length === 0 || marker.includes('\n')) {
    throw new Error('Direct TUI viewport marker must be one non-empty row');
  }
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isFinite(options.pollIntervalMs) ||
    options.pollIntervalMs <= 0
  ) {
    throw new Error('Direct TUI viewport marker wait bounds must be positive and finite');
  }

  let attempts = 0;
  let startedAtMs: number | null = null;
  let deadlineAtMs: number | null = null;
  let priorCompletedAtMs = Number.NEGATIVE_INFINITY;
  while (true) {
    await options.assertReaderIdentity();
    const snapshot = await options.read();
    await options.assertReaderIdentity();
    attempts += 1;
    if (
      !Number.isFinite(snapshot.requestedAtMs) ||
      !Number.isFinite(snapshot.completedAtMs) ||
      snapshot.completedAtMs < snapshot.requestedAtMs ||
      snapshot.requestedAtMs < priorCompletedAtMs
    ) {
      throw new Error('Direct TUI viewport marker query timestamps are invalid or non-monotonic');
    }
    priorCompletedAtMs = snapshot.completedAtMs;
    startedAtMs ??= snapshot.requestedAtMs;
    deadlineAtMs ??= startedAtMs + options.timeoutMs;

    const deadlineError = (): Error =>
      new Error(
        `terminal current viewport did not contain exact marker row before its shared deadline: ${JSON.stringify(
          {
            marker,
            attempts,
            startedAtMs,
            deadlineAtMs,
            lastSnapshot: snapshot,
          },
        )}`,
      );
    if (snapshot.requestedAtMs > deadlineAtMs || snapshot.completedAtMs > deadlineAtMs) {
      throw deadlineError();
    }

    const rows = snapshot.text.split('\n');
    const rowIndex = rows.findIndex((row) => row.replace(/ +$/u, '') === marker);
    const rowText = rows[rowIndex];
    if (rowIndex >= 0 && rowText !== undefined) {
      return {
        attempts,
        startedAtMs,
        deadlineAtMs,
        snapshot,
        match: { rowIndex, rowText },
      };
    }
    if (snapshot.completedAtMs >= deadlineAtMs) {
      throw deadlineError();
    }
    await options.wait(
      Math.min(options.pollIntervalMs, Math.max(0, deadlineAtMs - snapshot.completedAtMs)),
    );
  }
}

/** Failure-safe cleanup targets only the unique resources minted by this plan. */
export async function cleanupDirectTuiWorkload(plan: DirectTuiWorkloadPlan): Promise<void> {
  if (plan.cleanup.kind === 'fixture-file') {
    if (!/^\/tmp\/merkur-direct-nvim-[a-z0-9_-]{1,64}\.rs$/iu.test(plan.cleanup.path)) {
      throw new Error('refusing to remove a non-benchmark Neovim path');
    }
    rmSync(plan.cleanup.path, { force: true });
    return;
  }
  if (!/^merkur-direct-[a-z0-9_-]{1,64}$/iu.test(plan.cleanup.socketName)) {
    throw new Error('refusing to address a non-benchmark tmux socket');
  }
  // Awaited, never synchronous: this also runs under Bun, whose synchronous spawn can lose a
  // child's exit (oven-sh/bun#34069).
  const { executablePath, socketName } = plan.cleanup;
  const result = await new Promise<{ status: number; stderr: string }>((resolve, reject) => {
    execFile(
      executablePath,
      ['-L', socketName, 'kill-server'],
      { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' },
      (error, _stdout, stderr) => {
        if (error === null) resolve({ status: 0, stderr });
        else if (typeof error.code === 'number') resolve({ status: error.code, stderr });
        else reject(new Error(`failed to execute exact tmux cleanup: ${error.message}`));
      },
    );
  });
  const stderr = result.stderr.trim();
  const ownedServerAlreadyAbsent =
    result.status === 1 &&
    !stderr.includes('\n') &&
    stderr.startsWith('no server running on ') &&
    stderr.endsWith(`/${socketName}`);
  if (result.status !== 0 && !ownedServerAlreadyAbsent) {
    throw new Error(`exact tmux cleanup exited ${String(result.status)}: ${stderr}`);
  }
}

/**
 * Reconstruct one explicit one-byte input for every coherent redraw operation.
 *
 * The raw boundary and input identities are the workload oracle. Timestamp
 * overlap, a missing boundary, or an input outside every window fails instead
 * of being repaired from aggregate report counts.
 */
export function summarizeDirectCoherentInputWindows(
  events: readonly TerminalPerfEvent[],
  expectedWindowCount: number,
): DirectCoherentInputPopulation {
  if (!Number.isSafeInteger(expectedWindowCount) || expectedWindowCount <= 0) {
    throw new Error('Direct coherent-redraw window count must be a positive safe integer');
  }

  const windowsById = new Map<number, { startAtMs: number | null; endAtMs: number | null }>();
  let boundaryCount = 0;
  for (const event of events) {
    if (event.kind !== 'presentation_measurement_boundary' || event.purpose !== 'coherent-redraw') {
      continue;
    }
    boundaryCount += 1;
    if (!Number.isSafeInteger(event.measurementId) || !Number.isFinite(event.atMs)) {
      throw new Error('Direct coherent-window boundary identity is invalid');
    }
    const window = windowsById.get(event.measurementId) ?? {
      startAtMs: null,
      endAtMs: null,
    };
    if (event.phase === 'start') {
      if (window.startAtMs !== null) {
        throw new Error(`Direct coherent window ${event.measurementId} has duplicate START`);
      }
      window.startAtMs = event.atMs;
    } else {
      if (window.endAtMs !== null) {
        throw new Error(`Direct coherent window ${event.measurementId} has duplicate END`);
      }
      window.endAtMs = event.atMs;
    }
    windowsById.set(event.measurementId, window);
  }
  if (windowsById.size !== expectedWindowCount || boundaryCount !== expectedWindowCount * 2) {
    throw new Error(
      `Direct trace retained ${windowsById.size} coherent windows/${boundaryCount} boundaries; expected ${expectedWindowCount}/${expectedWindowCount * 2}`,
    );
  }

  const orderedWindows = [...windowsById].map(([measurementId, window]) => {
    if (window.startAtMs === null || window.endAtMs === null || window.endAtMs < window.startAtMs) {
      throw new Error(`Direct coherent window ${measurementId} is incomplete or inverted`);
    }
    return {
      measurementId,
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
    };
  });
  orderedWindows.sort(
    (left, right) => left.startAtMs - right.startAtMs || left.measurementId - right.measurementId,
  );
  for (let index = 1; index < orderedWindows.length; index += 1) {
    const previous = orderedWindows[index - 1];
    const current = orderedWindows[index];
    if (previous === undefined || current === undefined) {
      throw new Error('Direct coherent-window ordering is incomplete');
    }
    if (current.startAtMs <= previous.endAtMs) {
      throw new Error(
        `Direct coherent windows ${previous.measurementId}/${current.measurementId} overlap`,
      );
    }
  }

  const inputs = events
    .map((event, eventOrdinal) => ({ event, eventOrdinal }))
    .filter(
      (
        entry,
      ): entry is {
        event: Extract<TerminalPerfEvent, { kind: 'input_queued' }>;
        eventOrdinal: number;
      } => entry.event.kind === 'input_queued',
    )
    .sort(
      (left, right) => left.event.atMs - right.event.atMs || left.eventOrdinal - right.eventOrdinal,
    );
  if (inputs.length !== expectedWindowCount) {
    throw new Error(
      `Direct trace retained ${inputs.length} inputs; expected ${expectedWindowCount}`,
    );
  }

  const seenInputSeqs = new Set<number>();
  const assignedInputSeqs = new Set<number>();
  for (const { event: input } of inputs) {
    if (
      !Number.isSafeInteger(input.inputSeq) ||
      input.inputSeq <= 0 ||
      !Number.isFinite(input.atMs) ||
      input.byteLength !== 1
    ) {
      throw new Error(`Direct coherent input ${input.inputSeq} is not one valid admitted byte`);
    }
    if (seenInputSeqs.has(input.inputSeq)) {
      throw new Error(`Direct coherent input sequence ${input.inputSeq} is duplicated`);
    }
    seenInputSeqs.add(input.inputSeq);
  }
  for (let index = 1; index < inputs.length; index += 1) {
    const previous = inputs[index - 1]?.event.inputSeq;
    const current = inputs[index]?.event.inputSeq;
    if (previous === undefined || current === undefined) {
      throw new Error('Direct coherent input sequence population is incomplete');
    }
    const expected = previous === 0xffff_ffff ? 1 : previous + 1;
    if (current !== expected) {
      throw new Error(
        `Direct coherent input sequence ${current} is not contiguous after ${previous}`,
      );
    }
  }

  const windows: DirectCoherentInputWindow[] = [];
  for (const window of orderedWindows) {
    const owned = inputs.filter(
      ({ event }) => event.atMs >= window.startAtMs && event.atMs <= window.endAtMs,
    );
    if (owned.length !== 1) {
      throw new Error(
        `Direct coherent window ${window.measurementId} owns ${owned.length} inputs; expected 1`,
      );
    }
    const input = owned[0]?.event;
    if (input === undefined) {
      throw new Error(`Direct coherent window ${window.measurementId} has no input`);
    }
    if (assignedInputSeqs.has(input.inputSeq)) {
      throw new Error(`Direct coherent input ${input.inputSeq} belongs to multiple windows`);
    }
    assignedInputSeqs.add(input.inputSeq);
    windows.push({ ...window, inputSeq: input.inputSeq });
  }
  if (assignedInputSeqs.size !== inputs.length) {
    throw new Error('Direct trace contains an input outside every coherent window');
  }

  return {
    windowCount: windows.length,
    inputCount: inputs.length,
    inputBytesPerWindow: 1,
    windows,
  };
}

/**
 * Join the last pre-query visual apply through its exact commit and GPU fence.
 *
 * The worker viewport reply has no worker-side sample revision. The proof is
 * nevertheless exact when the authoritative grid is constant from immediately
 * before the request through an immediate post-reply proof cut:
 * whichever instant in that interval the worker read, it observed the same
 * grid. Any visual apply at either boundary or through the immediate proof cut
 * fails closed; snapshot completion is only the lossless capture envelope.
 */
export function findDirectTuiActivationFence(
  events: readonly TerminalPerfEvent[],
  bounds: DirectTuiViewportProofBounds,
): DirectTuiActivationFence | null {
  const {
    activatedAtMs,
    viewportRequestedAtMs,
    viewportCompletedAtMs,
    proofCutAtMs,
    proofCapturedAtMs,
  } = bounds;
  if (
    !Number.isFinite(activatedAtMs) ||
    !Number.isFinite(viewportRequestedAtMs) ||
    !Number.isFinite(viewportCompletedAtMs) ||
    !Number.isFinite(proofCutAtMs) ||
    !Number.isFinite(proofCapturedAtMs) ||
    viewportRequestedAtMs <= activatedAtMs ||
    viewportCompletedAtMs < viewportRequestedAtMs ||
    proofCutAtMs < viewportCompletedAtMs ||
    proofCapturedAtMs < proofCutAtMs
  ) {
    throw new Error('Direct TUI activation/query/proof timestamps are invalid');
  }
  const commits = new Map<string, Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>>();
  const fences = new Map<number, Extract<TerminalPerfEvent, { kind: 'frame_complete' }>>();
  let latestRenderStart: Extract<TerminalPerfEvent, { kind: 'render_start' }> | null = null;
  for (const event of events) {
    if (Number.isFinite(event.atMs) && event.atMs > proofCapturedAtMs) {
      throw new Error('Direct TUI proof trace contains an event after its capture timestamp');
    }
    if (
      event.kind === 'session_start' &&
      event.atMs >= activatedAtMs &&
      event.atMs <= proofCutAtMs
    ) {
      return null;
    }
    if (
      event.kind === 'presentation_commit' &&
      event.atMs > activatedAtMs &&
      event.atMs < viewportRequestedAtMs &&
      event.authoritativeVisualChange
    ) {
      const key = `${event.generation}:${event.transactionSeq}`;
      if (commits.has(key)) throw new Error(`Direct TUI transaction ${key} committed twice`);
      commits.set(key, event);
    } else if (
      event.kind === 'frame_complete' &&
      event.atMs > activatedAtMs &&
      event.atMs < viewportRequestedAtMs
    ) {
      if (fences.has(event.renderSeq)) {
        throw new Error(`Direct TUI render ${event.renderSeq} completed twice`);
      }
      fences.set(event.renderSeq, event);
    } else if (
      event.kind === 'render_start' &&
      event.atMs > activatedAtMs &&
      event.atMs <= proofCutAtMs
    ) {
      if (latestRenderStart === null || event.atMs > latestRenderStart.atMs) {
        latestRenderStart = event;
      } else if (event.atMs === latestRenderStart.atMs) {
        throw new Error('Direct TUI latest render-start identity is timestamp-ambiguous');
      }
    }
  }
  let latestApplies: Array<Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }>> = [];
  for (const event of events) {
    if (
      event.kind === 'worker_display_applied' &&
      event.authoritativeVisualMutation === true &&
      event.atMs >= viewportRequestedAtMs &&
      event.atMs <= proofCutAtMs
    ) {
      return null;
    }
    if (
      event.kind !== 'worker_display_applied' ||
      event.atMs <= activatedAtMs ||
      event.atMs >= viewportRequestedAtMs ||
      event.authoritativeVisualMutation !== true
    ) {
      continue;
    }
    const latestApply = latestApplies[0];
    if (latestApply === undefined || event.atMs > latestApply.atMs) latestApplies = [event];
    else if (event.atMs === latestApply.atMs) latestApplies.push(event);
  }
  const latestApply = latestApplies.at(-1);
  if (latestApply === undefined) return null;
  if (latestApply.presentationTransactionSeq === 0) return null;
  if (
    latestApplies.some(
      (event) =>
        event.generation !== latestApply.generation ||
        event.presentationTransactionSeq !== latestApply.presentationTransactionSeq,
    )
  ) {
    throw new Error('Direct TUI latest authoritative apply is transaction-ambiguous');
  }
  const latestApplyDisplaySeqs = latestApplies.map((event) => event.displaySeq);
  if (new Set(latestApplyDisplaySeqs).size !== latestApplyDisplaySeqs.length) {
    throw new Error('Direct TUI latest authoritative apply identity is duplicated');
  }
  const commit = commits.get(`${latestApply.generation}:${latestApply.presentationTransactionSeq}`);
  if (
    commit === undefined ||
    commit.atMs < latestApply.atMs ||
    commit.atMs >= viewportRequestedAtMs
  ) {
    return null;
  }
  const fence = fences.get(commit.renderSeq);
  if (fence === undefined || fence.atMs < commit.atMs || fence.atMs >= viewportRequestedAtMs) {
    return null;
  }
  if (
    latestRenderStart === null ||
    latestRenderStart.renderSeq !== commit.renderSeq ||
    latestRenderStart.atMs < latestApply.atMs ||
    latestRenderStart.atMs > commit.atMs ||
    commit.atMs > fence.atMs
  ) {
    return null;
  }
  if (
    events.some(
      (event) =>
        event.kind === 'worker_display_applied' &&
        event.atMs > latestApply.atMs &&
        event.atMs <= proofCutAtMs &&
        event.generation !== latestApply.generation,
    )
  ) {
    return null;
  }
  return {
    generation: latestApply.generation,
    latestApplyDisplaySeqs,
    displaySeq: latestApply.displaySeq,
    presentationTransactionSeq: latestApply.presentationTransactionSeq,
    renderSeq: commit.renderSeq,
    applyAtMs: latestApply.atMs,
    commitAtMs: commit.atMs,
    fenceAtMs: fence.atMs,
    viewportRequestedAtMs,
    viewportCompletedAtMs,
    proofCutAtMs,
    proofCapturedAtMs,
  };
}

/** Two cached, visually distinct full-screen panes switched by literal C-n. */
export function buildTmuxSwitchWorkload(
  tool: DirectTuiToolEvidence,
  token: string,
): DirectTuiWorkloadPlan {
  requireTool(tool, 'tmux');
  requireToken(token);
  const socket = `merkur-direct-${token}`;
  const session = `direct-${token}`;
  const readyMarker = `direct-tmux-ready-${token}`;
  const exitMarker = `direct-tmux-exit-${token}`;
  const markerA = `MERKUR-TMUX-A-${token}`;
  const markerB = `MERKUR-TMUX-B-${token}`;
  const paneANeedle = `ALPHA-02-${'ALPHA-'.repeat(14)}`;
  const tmux = `TMUX= ${shellQuote(tool.path)} -L ${shellQuote(socket)} -f /dev/null`;
  const paneA = `/bin/sh -c ${shellQuote(tmuxPaneScript(markerA, 'ALPHA-', 45))}`;
  const paneB = `/bin/sh -c ${shellQuote(tmuxPaneScript(markerB, 'BRAVO-', 81))}`;
  const setup = [
    `${tmux} new-session -d -s ${shellQuote(session)} -x 160 -y 50 ${shellQuote(paneA)}`,
    `${tmux} new-window -d -t ${shellQuote(`${session}:`)} -n second ${shellQuote(paneB)}`,
    `${tmux} set-option -t ${shellQuote(session)} status off`,
    `${tmux} set-option -s escape-time 0`,
    `${tmux} bind-key -n C-n next-window`,
    `${tmux} bind-key -n C-x detach-client`,
    `${tmux} select-window -t ${shellQuote(`${session}:0`)}`,
  ].join(' && ');
  const launchCommand =
    `if ${setup}; then ${markerPrint(readyMarker)}; IFS= read -r _merkur_tui_go; ` +
    `${tmux} attach-session -t ${shellQuote(session)}; _merkur_tui_status=$?; ` +
    `${tmux} kill-server >/dev/null 2>&1 || :; ` +
    `[ "$_merkur_tui_status" -eq 0 ] && ${markerPrint(exitMarker)}; fi\n`;
  return {
    application: 'tmux',
    readyMarker,
    exitMarker,
    launchCommand,
    stepKeys: ['Control+n'],
    initialViewportNeedle: paneANeedle,
    completedCycleViewportNeedle: paneANeedle,
    operationCycleLength: 2,
    cleanup: { kind: 'tmux-server', executablePath: tool.path, socketName: socket },
    exitKeys: ['Control+x'],
  };
}

/** Deterministic highlighted Rust buffer navigated by literal C-f/C-b. */
export function buildNeovimNavigationWorkload(
  tool: DirectTuiToolEvidence,
  token: string,
): DirectTuiWorkloadPlan {
  requireTool(tool, 'nvim');
  requireToken(token);
  const file = `/tmp/merkur-direct-nvim-${token}.rs`;
  const readyMarker = `direct-nvim-ready-${token}`;
  const exitMarker = `direct-nvim-exit-${token}`;
  const fill = 'navigation_payload_'.repeat(6);
  const firstLineNeedle = 'pub fn merkur_line_0001()';
  const createFixture =
    `: > ${shellQuote(file)}; _merkur_line=1; ` +
    `while [ "$_merkur_line" -le 2400 ]; do ` +
    `printf 'pub fn merkur_line_%04d() { let value = "%s"; }\\n' ` +
    `"$_merkur_line" ${shellQuote(fill)} >> ${shellQuote(file)}; ` +
    `_merkur_line=$((_merkur_line+1)); done`;
  const editor =
    `${shellQuote(tool.path)} -u NONE -N --noplugin -n -i NONE -R ` +
    `--cmd ${shellQuote('set shortmess+=I')} ` +
    `--cmd ${shellQuote('set noswapfile noundofile nowrap nonumber norelativenumber laststatus=0 showtabline=0 noshowmode noruler')} ` +
    `-c ${shellQuote('set filetype=rust | syntax enable | normal! gg')} ${shellQuote(file)}`;
  const launchCommand =
    `if ${createFixture}; then ${markerPrint(readyMarker)}; IFS= read -r _merkur_tui_go; ` +
    `${editor}; _merkur_tui_status=$?; rm -f ${shellQuote(file)}; ` +
    `[ "$_merkur_tui_status" -eq 0 ] && ${markerPrint(exitMarker)}; fi\n`;
  return {
    application: 'neovim',
    readyMarker,
    exitMarker,
    launchCommand,
    stepKeys: ['Control+f', 'Control+b'],
    initialViewportNeedle: firstLineNeedle,
    completedCycleViewportNeedle: firstLineNeedle,
    operationCycleLength: 2,
    cleanup: { kind: 'fixture-file', path: file },
    exitKeys: ['Escape', ':q!', 'Enter'],
  };
}

function inspectRequiredTool(
  application: DirectTuiApplication,
  binaryName: DirectTuiToolEvidence['binaryName'],
  versionArgs: readonly string[],
  pathEnvironment: string,
): DirectTuiToolEvidence {
  const path = resolveExecutable(binaryName, pathEnvironment);
  let versionOutput: string;
  try {
    versionOutput = execFileSync(path, [...versionArgs], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(
      `Direct TUI benchmark requires a working ${binaryName} binary at ${path}: ${formatError(error)}`,
    );
  }
  const version = versionOutput
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (version === undefined) {
    throw new Error(`Direct TUI benchmark could not read ${binaryName} version at ${path}`);
  }
  return {
    application,
    binaryName,
    path,
    version,
    hashScope: 'executable-file-only',
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function resolveExecutable(binaryName: string, pathEnvironment: string): string {
  for (const directory of pathEnvironment.split(delimiter)) {
    const candidate = resolve(directory === '' ? process.cwd() : directory, binaryName);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the declared PATH. Dedicated performance cases fail
      // explicitly below rather than substituting a different application.
    }
  }
  throw new Error(`Direct TUI benchmark requires ${binaryName} on PATH`);
}

function tmuxPaneScript(marker: string, prefix: string, color: number): string {
  const fill = prefix.repeat(14);
  return (
    `printf '\\033[2J\\033[H'; _merkur_row=1; ` +
    `while [ "$_merkur_row" -le 40 ]; do ` +
    `printf '\\033[2K\\033[38;5;${color}m${prefix}%02d-${fill}\\033[0m\\n' ` +
    `"$_merkur_row"; _merkur_row=$((_merkur_row+1)); done; ` +
    `printf '\\033[H\\033[2K%s' ${shellQuote(marker)}; ` +
    `while :; do sleep 3600; done`
  );
}

function markerPrint(marker: string): string {
  return `printf '\\033[2K\\r%s\\n' ${shellQuote(marker)}`;
}

function requireTool(
  tool: DirectTuiToolEvidence,
  binaryName: DirectTuiToolEvidence['binaryName'],
): void {
  const application = binaryName === 'tmux' ? 'tmux' : 'neovim';
  if (
    tool.application !== application ||
    tool.binaryName !== binaryName ||
    !isAbsolute(tool.path) ||
    tool.version.trim().length === 0 ||
    tool.hashScope !== 'executable-file-only' ||
    !/^[0-9a-f]{64}$/.test(tool.sha256)
  ) {
    throw new Error(`invalid ${binaryName} capability evidence`);
  }
}

function requireToken(token: string): void {
  if (!/^[a-z0-9_-]{1,64}$/i.test(token)) {
    throw new Error('Direct TUI workload token must contain only ASCII letters, digits, _ or -');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
