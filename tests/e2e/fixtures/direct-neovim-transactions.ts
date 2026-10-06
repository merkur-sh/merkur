import type {
  TerminalPerfEvent,
  TerminalRenderGate,
} from '../../../apps/web/src/perf/terminal-latency';

import type { DirectCoherentInputPopulation } from './direct-tui-workloads';
import { type ReferenceDistribution, referenceDistribution } from './terminal-redraw-reference';

export const DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT = 100;
export const DIRECT_NEOVIM_SHOWCMD_ROW_COUNT = 1;
export const DIRECT_NEOVIM_DENSE_ROW_MINIMUM = 23;

type DisplayAppliedEvent = Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }>;
type DisplayReceivedEvent = Extract<TerminalPerfEvent, { kind: 'display_received' }>;
type PresentationCommitEvent = Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>;
type RenderStartEvent = Extract<TerminalPerfEvent, { kind: 'render_start' }>;
type RenderEndEvent = Extract<TerminalPerfEvent, { kind: 'render_end' }>;
type FrameCompleteEvent = Extract<TerminalPerfEvent, { kind: 'frame_complete' }>;

export type DirectNeovimTransactionKind = 'showcmd-early-feedback' | 'dense-page-redraw';

export type DirectNeovimShowcmdOutcome = 'rendered' | 'obsolete-before-receipt';

export interface DirectNeovimSenderPresentationEvidence {
  readonly kind: DirectNeovimTransactionKind;
  readonly generation: number;
  readonly inputSeq: number;
  readonly presentationId: number;
  readonly rowPredecessorPresentationId: number;
  readonly firstDisplaySeq: number;
  readonly lastDisplaySeq: number;
  readonly memberDisplaySeqs: readonly number[];
  readonly memberRowCounts: readonly number[];
  readonly memberByteLengths: readonly number[];
  readonly firstReceiveTraceOrdinal: number;
  readonly firstReceivedAtMs: number;
  readonly lastReceivedAtMs: number;
  readonly firstAppliedAtMs: number;
  readonly stateReadyTraceOrdinal: number;
  /** Exact point at which every member of this sender presentation had applied. */
  readonly stateReadyAtMs: number;
  readonly senderAppliedDisplayUnitCount: number;
  readonly visualAppliedDisplayUnitCount: number;
  readonly nonvisualAppliedDisplayUnitCount: number;
  readonly senderRowCount: number;
  readonly senderByteLength: number;
}

export interface DirectNeovimRenderedSegmentEvidence {
  /** Contiguous visual ownership partition in raw worker-apply order. */
  readonly segmentOrdinal: number;
  readonly generation: number;
  readonly inputSeq: number;
  readonly presentationId: number;
  readonly transactionSeq: number;
  readonly renderSeq: number;
  readonly firstDisplaySeq: number;
  readonly lastDisplaySeq: number;
  readonly memberDisplaySeqs: readonly number[];
  readonly memberApplyTraceOrdinals: readonly number[];
  readonly firstReceiveTraceOrdinal: number;
  readonly firstReceivedAtMs: number;
  readonly stateReadyTraceOrdinal: number;
  readonly stateReadyAtMs: number;
  readonly renderWantedAtMs: number;
  readonly renderStartTraceOrdinal: number;
  readonly renderStartAtMs: number;
  readonly renderEndTraceOrdinal: number;
  readonly renderEndAtMs: number;
  readonly commitTraceOrdinal: number;
  readonly commitAtMs: number;
  /** Browser-observed WebGL sync command readiness; not physical GPU completion or photons. */
  readonly observedWebglSyncReadinessAtMs: number;
  readonly readinessTraceOrdinal: number;
  readonly previousUnreadyPollAtMs: number;
  readonly completionDisposition: FrameCompleteEvent['completionDisposition'];
  /** Exact newer submission existed before this command-readiness observation. */
  readonly supersededBeforeReadiness: boolean;
  readonly gate: TerminalRenderGate;
  /** Exact completed render descriptor that opened a fence-bearing gate, else zero. */
  readonly fenceReleasedRenderSeq: number;
  readonly fenceReleasedAtMs: number;
  readonly opportunityEnteredAtMs: number;
  readonly opportunityDelayMs: number;
  readonly fenceWaitMs: number;
  readonly opportunityWaitMs: number;
  readonly refreshPeriodMs: number;
  readonly commitReason: PresentationCommitEvent['reason'];
  readonly commitEndSeen: boolean;
  /** Applied display members; not a proxy UDP carrier-packet count. */
  readonly appliedDisplayUnitCount: number;
  readonly rowCount: number;
  readonly byteLength: number;
  readonly inputToFirstReceiveMs: number;
  readonly firstReceiveToStateReadyMs: number;
  readonly stateReadyToRenderStartMs: number;
  readonly renderCpuMs: number;
  readonly renderEndToObservedWebglSyncReadinessMs: number;
  readonly inputToObservedWebglSyncReadinessMs: number;
  readonly lastUnreadyPollToObservedReadinessMs: number;
}

export interface DirectNeovimRenderedPresentationEvidence
  extends DirectNeovimSenderPresentationEvidence {
  readonly outcome: 'rendered';
  /** Every visual partition, ordered by its first raw worker-apply ordinal. */
  readonly renderedSegments: readonly DirectNeovimRenderedSegmentEvidence[];
  readonly renderedSegmentCount: number;
  /** Index of the segment containing the last authoritative member in raw apply order. */
  readonly finalSegmentIndex: number;
  readonly visualRowCount: number;
  readonly visualByteLength: number;
  readonly firstCommitTraceOrdinal: number;
  readonly lastCommitTraceOrdinal: number;
  readonly firstCommitAtMs: number;
  readonly lastCommitAtMs: number;
  /** Last visual commit minus first visual commit for this one sender presentation. */
  readonly senderPresentationCommitExposureMs: number;
}

export interface DirectNeovimObsoleteShowcmdEvidence
  extends DirectNeovimSenderPresentationEvidence {
  readonly kind: 'showcmd-early-feedback';
  readonly outcome: 'obsolete-before-receipt';
  readonly transactionSeq: null;
  readonly renderSeq: null;
  /** Producer-later dense presentation fully applied before this nonvisual frame arrived. */
  readonly laterDensePresentationId: number;
  readonly laterDenseLastDisplaySeq: number;
  readonly denseStateReadyBeforeShowcmdReceiptMs: number;
}

export type DirectNeovimShowcmdEvidence =
  | DirectNeovimRenderedPresentationEvidence
  | DirectNeovimObsoleteShowcmdEvidence;

export type DirectNeovimTransactionEvidence = DirectNeovimRenderedSegmentEvidence;

export interface DirectNeovimSupplementalNonvisualEvidence
  extends DirectNeovimSenderPresentationEvidence {
  readonly outcome: 'supplemental-nonvisual';
  readonly transactionSeq: 0;
}

export interface DirectNeovimNonmemberEvidence {
  readonly generation: number;
  readonly inputSeq: number;
  readonly displaySeq: number;
  readonly presentationId: number;
  readonly rowPredecessorPresentationId: number;
  readonly receiveTraceOrdinal: number;
  readonly receivedAtMs: number;
  readonly applyTraceOrdinal: number;
  readonly appliedAtMs: number;
  readonly rowCount: number;
  readonly byteLength: number;
}

export interface DirectNeovimWindowEvidence {
  readonly ordinal: number;
  readonly measurementId: number;
  readonly windowStartAtMs: number;
  readonly windowEndAtMs: number;
  readonly inputAtMs: number;
  readonly inputSeq: number;
  readonly showcmd: DirectNeovimShowcmdEvidence;
  readonly dense: DirectNeovimRenderedPresentationEvidence;
  /** Complete successor-linked updates that applied no new authoritative pixels. */
  readonly supplementalNonvisualPresentations: readonly DirectNeovimSupplementalNonvisualEvidence[];
  /** Exact 0/0 nonmembers, retained separately from sender-presentation membership. */
  readonly nonmemberDisplayUnits: readonly DirectNeovimNonmemberEvidence[];
  /** Distinct application updates; this span is not partial-redraw exposure. */
  readonly applicationTransactionSpan: {
    readonly firstReceiveMs: number;
    readonly stateReadyMs: number;
    readonly renderStartMs: number | null;
    readonly commitMs: number | null;
    readonly observedWebglSyncReadinessMs: number | null;
  };
  readonly denseScheduling: {
    readonly priorReadinessBlocked: boolean;
    readonly stateReadyBeforeFenceOwnerReadinessMs: number;
    readonly fenceReleaseOwner: {
      readonly renderSeq: number;
      readonly inputSeq: number;
      readonly completionDisposition: FrameCompleteEvent['completionDisposition'];
      readonly readinessTraceOrdinal: number;
      readonly observedWebglSyncReadinessAtMs: number;
      readonly releasedAtMs: number;
      readonly releaseObservationLagMs: number;
      readonly isSameWindowShowcmd: boolean;
    } | null;
  };
}

export interface DirectNeovimTransactionPopulation {
  readonly schemaVersion: 4;
  readonly interpretation: {
    readonly applicationBoundary: string;
    readonly completionBoundary: string;
    readonly crossTransactionSpan: string;
    readonly renderReadinessCensus: string;
  };
  readonly windowCount: number;
  /** Canonical sender presentations: one showcmd plus one dense update per input. */
  readonly transactionCount: number;
  /** Actual authoritative renderer segments; obsolete showcmd receives are not imputed. */
  readonly renderedTransactionCount: number;
  readonly denseRenderedSegmentCount: number;
  readonly splitDenseWindowCount: number;
  readonly showcmdRowCount: number;
  readonly denseMinimumRows: number;
  readonly showcmdOutcomeCounts: Readonly<Record<DirectNeovimShowcmdOutcome, number>>;
  readonly supplementalNonvisualPresentationCount: number;
  readonly nonmemberDisplayUnitCount: number;
  readonly denseGateCounts: Readonly<Record<TerminalRenderGate, number>>;
  readonly denseFinalGateCounts: Readonly<Record<TerminalRenderGate, number>>;
  readonly priorReadinessBlockedDensePageCount: number;
  readonly showcmdCompletionDispositionCounts: Readonly<
    Record<FrameCompleteEvent['completionDisposition'], number>
  >;
  readonly denseCompletionDispositionCounts: Readonly<
    Record<FrameCompleteEvent['completionDisposition'], number>
  >;
  readonly denseFinalCompletionDispositionCounts: Readonly<
    Record<FrameCompleteEvent['completionDisposition'], number>
  >;
  readonly renderReadinessCensus: {
    /** Raw-order maximum of submitted renders still awaiting command readiness. */
    readonly maximumOutstandingSubmissionCount: number;
    /** Windows where dense submission occurred before showcmd command readiness. */
    readonly depthTwoOverlapWindowCount: number;
    /** The terminal dense update that clears publication debt for the next input. */
    readonly terminalLatestSubmittedWindowCount: number;
  };
  readonly distributions: {
    readonly inputToShowcmdFirstReceiveMs: ReferenceDistribution;
    readonly inputToShowcmdObservedWebglSyncReadinessMs: ReferenceDistribution;
    readonly inputToShowcmdObservedWebglSyncReadinessByDispositionMs: Readonly<
      Record<FrameCompleteEvent['completionDisposition'], ReferenceDistribution>
    >;
    readonly showcmdRenderEndToObservedWebglSyncReadinessByDispositionMs: Readonly<
      Record<FrameCompleteEvent['completionDisposition'], ReferenceDistribution>
    >;
    readonly showcmdToDenseFirstReceiveMs: ReferenceDistribution;
    readonly showcmdToDenseStateReadyMs: ReferenceDistribution;
    readonly showcmdToDenseRenderStartMs: ReferenceDistribution;
    readonly showcmdToDenseCommitMs: ReferenceDistribution;
    readonly showcmdToDenseObservedWebglSyncReadinessMs: ReferenceDistribution;
    readonly obsoleteDenseStateReadyBeforeShowcmdReceiptMs: ReferenceDistribution;
    readonly denseFirstReceiveToStateReadyMs: ReferenceDistribution;
    readonly denseStateReadyToRenderStartMs: ReferenceDistribution;
    readonly denseRenderCpuMs: ReferenceDistribution;
    readonly denseRenderEndToObservedWebglSyncReadinessMs: ReferenceDistribution;
    readonly inputToDenseObservedWebglSyncReadinessMs: ReferenceDistribution;
    readonly denseRenderedSegmentCount: ReferenceDistribution;
    readonly denseSenderPresentationCommitExposureMs: ReferenceDistribution;
    readonly priorReadinessBlockedMs: ReferenceDistribution;
    readonly fenceReleaseToDenseRenderStartMs: ReferenceDistribution;
  };
  /** Exact raw identities/timestamps for every input; distributions are derived only from these. */
  readonly windows: readonly DirectNeovimWindowEvidence[];
}

/** Resizes/context replacement are outside the pinned steady navigation workload. */
export function validateDirectNeovimSteadyTransactions(
  population: DirectNeovimTransactionPopulation,
): readonly string[] {
  const errors: string[] = [];
  const renderedShowcmdCount = population.showcmdOutcomeCounts.rendered;
  const showcmdDispositionCount =
    population.showcmdCompletionDispositionCounts['latest-submitted'] +
    population.showcmdCompletionDispositionCounts.superseded +
    population.showcmdCompletionDispositionCounts.invalidated;
  const denseDispositionCount =
    population.denseCompletionDispositionCounts['latest-submitted'] +
    population.denseCompletionDispositionCounts.superseded +
    population.denseCompletionDispositionCounts.invalidated;
  const denseFinalDispositionCount =
    population.denseFinalCompletionDispositionCounts['latest-submitted'] +
    population.denseFinalCompletionDispositionCounts.superseded +
    population.denseFinalCompletionDispositionCounts.invalidated;
  const denseGateCount =
    population.denseGateCounts.immediate +
    population.denseGateCounts.fence +
    population.denseGateCounts.opportunity +
    population.denseGateCounts['fence-and-opportunity'];
  const denseFinalGateCount =
    population.denseFinalGateCounts.immediate +
    population.denseFinalGateCounts.fence +
    population.denseFinalGateCounts.opportunity +
    population.denseFinalGateCounts['fence-and-opportunity'];
  if (
    renderedShowcmdCount + population.showcmdOutcomeCounts['obsolete-before-receipt'] !==
      population.windowCount ||
    population.renderedTransactionCount !==
      population.denseRenderedSegmentCount + renderedShowcmdCount ||
    showcmdDispositionCount !== renderedShowcmdCount ||
    denseDispositionCount !== population.denseRenderedSegmentCount ||
    denseFinalDispositionCount !== population.windowCount ||
    denseGateCount !== population.denseRenderedSegmentCount ||
    denseFinalGateCount !== population.windowCount
  ) {
    errors.push('steady Neovim phase has inconsistent sender/render outcome accounting');
  }
  const invalidatedCount =
    population.showcmdCompletionDispositionCounts.invalidated +
    population.denseCompletionDispositionCounts.invalidated;
  if (invalidatedCount !== 0) {
    errors.push(
      `steady Neovim phase recorded ${invalidatedCount} semantically invalidated completions`,
    );
  }
  if (
    population.renderReadinessCensus.terminalLatestSubmittedWindowCount !== population.windowCount
  ) {
    errors.push(
      `steady Neovim phase cleared publication debt in ${population.renderReadinessCensus.terminalLatestSubmittedWindowCount}/${population.windowCount} terminal dense completions`,
    );
  }
  const actualSplitDenseWindowCount = population.windows.filter(
    (window) => window.dense.renderedSegmentCount > 1,
  ).length;
  if (
    population.denseRenderedSegmentCount !== population.windowCount ||
    population.splitDenseWindowCount !== 0 ||
    population.splitDenseWindowCount !== actualSplitDenseWindowCount ||
    population.windows.some(
      (window) =>
        window.dense.renderedSegmentCount !== 1 ||
        window.dense.senderPresentationCommitExposureMs !== 0,
    )
  ) {
    errors.push(
      `steady Neovim phase split ${population.splitDenseWindowCount}/${population.windowCount} dense sender presentations across ${population.denseRenderedSegmentCount} renderer segments`,
    );
  }
  return errors;
}

/**
 * Reconstruct Neovim's two intentional synchronous application updates for
 * every page-navigation input.
 *
 * With Neovim's pinned default `showcmd`, Ctrl-F/Ctrl-B first emits one
 * complete status-row presentation and then one complete dense page redraw.
 * Treating their cross-update span as a torn Merkur redraw is wrong; treating
 * the first row as sufficient dense coverage is equally wrong. This oracle
 * therefore proves both complete sender presentations independently. A showcmd
 * that arrives only after the producer-later dense state is already applied is
 * retained as an explicitly obsolete nonvisual update rather than assigned an
 * invented renderer completion. Legal late-tail delivery can split one complete
 * dense sender presentation across multiple renderer transactions. Every visual
 * partition is retained in raw apply order with its exact commit, submission and
 * readiness owner; the steady-workload coherence gate separately rejects a split.
 */
export function summarizeDirectNeovimTransactions(
  events: readonly TerminalPerfEvent[],
  inputPopulation: DirectCoherentInputPopulation,
): DirectNeovimTransactionPopulation {
  if (
    inputPopulation.windowCount !== DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT ||
    inputPopulation.inputCount !== DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT ||
    inputPopulation.inputBytesPerWindow !== 1 ||
    inputPopulation.windows.length !== DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT
  ) {
    throw new Error(
      `Direct Neovim transaction oracle requires exactly ${DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT} one-byte windows`,
    );
  }

  const eventOrdinal = new Map<TerminalPerfEvent, number>();
  for (let ordinal = 0; ordinal < events.length; ordinal += 1) {
    const event = events[ordinal];
    if (event !== undefined) eventOrdinal.set(event, ordinal);
  }
  const inputBySeq = uniqueEventMap(
    events.filter(
      (event): event is Extract<TerminalPerfEvent, { kind: 'input_queued' }> =>
        event.kind === 'input_queued',
    ),
    (event) => event.inputSeq,
    'input',
  );
  const renderStarts = events.filter(
    (event): event is RenderStartEvent => event.kind === 'render_start',
  );
  const renderStartBySeq = uniqueEventMap(renderStarts, (event) => event.renderSeq, 'render_start');
  const renderEndBySeq = uniqueEventMap(
    events.filter((event): event is RenderEndEvent => event.kind === 'render_end'),
    (event) => event.renderSeq,
    'render_end',
  );
  const frameCompleteBySeq = uniqueEventMap(
    events.filter((event): event is FrameCompleteEvent => event.kind === 'frame_complete'),
    (event) => event.renderSeq,
    'frame_complete',
  );
  const commits = events.filter(
    (event): event is PresentationCommitEvent => event.kind === 'presentation_commit',
  );
  const applies = events.filter(
    (event): event is DisplayAppliedEvent => event.kind === 'worker_display_applied',
  );
  const receives = events.filter(
    (event): event is DisplayReceivedEvent => event.kind === 'display_received',
  );
  const commitByTransaction = uniqueEventMap(
    commits,
    (event) => transactionKey(event.generation, event.transactionSeq),
    'presentation transaction',
  );
  const appliesByFrame = uniqueEventMap(
    applies,
    (event) => frameKey(event.generation, event.displaySeq),
    'applied display',
  );
  const appliesByTransaction = new Map<string, DisplayAppliedEvent[]>();
  for (const event of applies) {
    if (!validPositiveU32(event.presentationTransactionSeq)) continue;
    const key = transactionKey(event.generation, event.presentationTransactionSeq);
    const owned = appliesByTransaction.get(key);
    if (owned === undefined) appliesByTransaction.set(key, [event]);
    else owned.push(event);
  }
  const receivesByFrame = new Map<string, DisplayReceivedEvent[]>();
  for (const event of receives) {
    const key = frameKey(event.generation, event.displaySeq);
    const owned = receivesByFrame.get(key);
    if (owned === undefined) receivesByFrame.set(key, [event]);
    else owned.push(event);
  }

  const windows = [...inputPopulation.windows].sort(
    (left, right) => left.startAtMs - right.startAtMs || left.measurementId - right.measurementId,
  );
  const evidence: DirectNeovimWindowEvidence[] = [];
  const ownedTransactions = new Set<string>();
  const ownedRenderSeqs = new Set<number>();
  const showcmdDispositions = dispositionCounts();
  const denseDispositions = dispositionCounts();
  const denseFinalDispositions = dispositionCounts();
  const gateCounts = renderGateCounts();
  const finalGateCounts = renderGateCounts();
  const showcmdOutcomeCounts: Record<DirectNeovimShowcmdOutcome, number> = {
    rendered: 0,
    'obsolete-before-receipt': 0,
  };
  const ownedDisplayFrames = new Set<string>();
  let priorReadinessBlockedDensePageCount = 0;
  let supplementalNonvisualPresentationCount = 0;
  let nonmemberDisplayUnitCount = 0;
  let denseRenderedSegmentCount = 0;
  let splitDenseWindowCount = 0;
  let previousSenderTail: { presentationId: number; lastDisplaySeq: number } | null = null;
  let previousRenderedSegment: DirectNeovimRenderedSegmentEvidence | null = null;

  for (let ordinal = 0; ordinal < windows.length; ordinal += 1) {
    const window = windows[ordinal];
    if (window === undefined) throw new Error(`Direct Neovim window ${ordinal} is missing`);
    const previous = windows[ordinal - 1];
    if (
      !Number.isFinite(window.startAtMs) ||
      !Number.isFinite(window.endAtMs) ||
      window.endAtMs <= window.startAtMs ||
      (previous !== undefined && window.startAtMs <= previous.endAtMs)
    ) {
      throw new Error(`Direct Neovim window ${ordinal} is inverted or overlaps its predecessor`);
    }
    const input = inputBySeq.get(window.inputSeq);
    const previousEvidence = evidence[ordinal - 1];
    if (
      input === undefined ||
      input.byteLength !== 1 ||
      input.atMs < window.startAtMs ||
      input.atMs > window.endAtMs ||
      (previousEvidence !== undefined &&
        input.inputSeq !== nextPositiveU32(previousEvidence.inputSeq))
    ) {
      throw new Error(`Direct Neovim window ${ordinal} lacks its exact one-byte input`);
    }
    const windowApplies = applies.filter(
      (event) =>
        event.inputSeq === input.inputSeq &&
        event.atMs >= window.startAtMs &&
        event.atMs <= window.endAtMs,
    );
    const positiveMembers = windowApplies.filter((event) => event.presentationMemberCount > 0);
    const membersByPresentation = new Map<string, DisplayAppliedEvent[]>();
    for (const member of positiveMembers) {
      const key = presentationKey(member.generation, member.presentationId);
      const owned = membersByPresentation.get(key);
      if (owned === undefined) membersByPresentation.set(key, [member]);
      else owned.push(member);
    }
    const senderGroups = [...membersByPresentation.values()].map((members) =>
      buildSenderPresentationGroup(
        members,
        input.atMs,
        window.startAtMs,
        window.endAtMs,
        receivesByFrame,
        eventOrdinal,
      ),
    );
    const canonicalPairs = senderGroups.flatMap((showcmd) =>
      showcmd.base.senderAppliedDisplayUnitCount === 1 &&
      showcmd.base.senderRowCount === DIRECT_NEOVIM_SHOWCMD_ROW_COUNT
        ? senderGroups
            .filter(
              (dense) =>
                dense !== showcmd &&
                dense.base.generation === showcmd.base.generation &&
                dense.base.inputSeq === showcmd.base.inputSeq &&
                dense.base.presentationId === nextPositiveU32(showcmd.base.presentationId) &&
                dense.base.firstDisplaySeq === nextPositiveU32(showcmd.base.lastDisplaySeq) &&
                dense.visualMembersInApplyOrder.length > 0,
            )
            .map((dense) => ({ showcmd, dense }))
        : [],
    );
    if (canonicalPairs.length !== 1) {
      throw new Error(
        `Direct Neovim window ${ordinal} owns ${canonicalPairs.length} canonical showcmd/dense sender-presentation pairs; expected exactly one`,
      );
    }
    const canonical = canonicalPairs[0];
    if (canonical === undefined) throw new Error(`Direct Neovim window ${ordinal} has no pair`);
    const showcmdGroup = canonical.showcmd;
    const denseGroup = canonical.dense;
    const dense = buildRenderedPresentationEvidence(
      'dense-page-redraw',
      denseGroup,
      input.atMs,
      commitByTransaction,
      appliesByTransaction,
      renderStartBySeq,
      renderEndBySeq,
      frameCompleteBySeq,
      renderStarts,
      eventOrdinal,
    );
    const denseFinalSegment = directNeovimFinalRenderedSegment(dense);
    if (
      dense.visualRowCount < DIRECT_NEOVIM_DENSE_ROW_MINIMUM ||
      dense.senderRowCount < DIRECT_NEOVIM_DENSE_ROW_MINIMUM
    ) {
      throw new Error(
        `Direct Neovim window ${ordinal} dense update has ${dense.visualRowCount} visual/${dense.senderRowCount} sender rows; expected at least ${DIRECT_NEOVIM_DENSE_ROW_MINIMUM}`,
      );
    }

    let showcmd: DirectNeovimShowcmdEvidence;
    if (showcmdGroup.visualMembersInApplyOrder.length > 0) {
      const renderedShowcmd = buildRenderedPresentationEvidence(
        'showcmd-early-feedback',
        showcmdGroup,
        input.atMs,
        commitByTransaction,
        appliesByTransaction,
        renderStartBySeq,
        renderEndBySeq,
        frameCompleteBySeq,
        renderStarts,
        eventOrdinal,
      );
      if (
        renderedShowcmd.visualRowCount !== DIRECT_NEOVIM_SHOWCMD_ROW_COUNT ||
        renderedShowcmd.visualAppliedDisplayUnitCount !== 1 ||
        renderedShowcmd.renderedSegmentCount !== 1 ||
        directNeovimFinalRenderedSegment(renderedShowcmd).gate !== 'immediate'
      ) {
        throw new Error(
          `Direct Neovim window ${ordinal} rendered showcmd is not one independently submitted complete row unit`,
        );
      }
      const showcmdSegment = directNeovimFinalRenderedSegment(renderedShowcmd);
      if (
        showcmdSegment.commitTraceOrdinal >= denseFinalSegment.commitTraceOrdinal ||
        showcmdSegment.commitAtMs > denseFinalSegment.commitAtMs ||
        !seriallyAfter(denseFinalSegment.transactionSeq, showcmdSegment.transactionSeq) ||
        !seriallyAfter(denseFinalSegment.renderSeq, showcmdSegment.renderSeq)
      ) {
        throw new Error(`Direct Neovim window ${ordinal} has ambiguous renderer update order`);
      }
      showcmd = renderedShowcmd;
    } else {
      requireNoPresentationCommit(
        showcmdGroup,
        commits,
        `Direct Neovim window ${ordinal} obsolete showcmd`,
      );
      if (
        showcmdGroup.base.nonvisualAppliedDisplayUnitCount !== 1 ||
        dense.stateReadyTraceOrdinal >= showcmdGroup.base.firstReceiveTraceOrdinal ||
        dense.stateReadyAtMs > showcmdGroup.base.firstReceivedAtMs
      ) {
        throw new Error(
          `Direct Neovim window ${ordinal} lacks exact dense-before-showcmd-receipt nonvisual evidence`,
        );
      }
      showcmd = {
        kind: 'showcmd-early-feedback',
        ...showcmdGroup.base,
        outcome: 'obsolete-before-receipt',
        transactionSeq: null,
        renderSeq: null,
        laterDensePresentationId: dense.presentationId,
        laterDenseLastDisplaySeq: dense.lastDisplaySeq,
        denseStateReadyBeforeShowcmdReceiptMs:
          showcmdGroup.base.firstReceivedAtMs - dense.stateReadyAtMs,
      };
    }

    const previousDenseFinalSegment =
      previousEvidence === undefined
        ? null
        : directNeovimFinalRenderedSegment(previousEvidence.dense);
    const renderedShowcmdSegment =
      showcmd.outcome === 'rendered' ? directNeovimFinalRenderedSegment(showcmd) : null;
    if (
      showcmd.generation !== dense.generation ||
      showcmd.presentationId === 0 ||
      dense.presentationId !== nextPositiveU32(showcmd.presentationId) ||
      dense.firstDisplaySeq !== nextPositiveU32(showcmd.lastDisplaySeq) ||
      (previousEvidence !== undefined &&
        (showcmd.generation !== previousEvidence.dense.generation ||
          previousSenderTail === null ||
          !seriallyAfter(showcmd.presentationId, previousSenderTail.presentationId) ||
          !seriallyAfter(showcmd.firstDisplaySeq, previousSenderTail.lastDisplaySeq) ||
          previousDenseFinalSegment === null ||
          !seriallyAfter(
            denseFinalSegment.transactionSeq,
            previousDenseFinalSegment.transactionSeq,
          ) ||
          !seriallyAfter(denseFinalSegment.renderSeq, previousDenseFinalSegment.renderSeq))) ||
      (showcmd.outcome === 'rendered' &&
        previousEvidence !== undefined &&
        (renderedShowcmdSegment === null ||
          previousDenseFinalSegment === null ||
          !seriallyAfter(
            renderedShowcmdSegment.transactionSeq,
            previousDenseFinalSegment.transactionSeq,
          ) ||
          !seriallyAfter(renderedShowcmdSegment.renderSeq, previousDenseFinalSegment.renderSeq)))
    ) {
      throw new Error(`Direct Neovim window ${ordinal} has ambiguous sender/renderer lineage`);
    }

    if (
      (renderedShowcmdSegment !== null &&
        renderedShowcmdSegment.observedWebglSyncReadinessAtMs >
          denseFinalSegment.observedWebglSyncReadinessAtMs) ||
      denseFinalSegment.observedWebglSyncReadinessAtMs > window.endAtMs
    ) {
      throw new Error(`Direct Neovim window ${ordinal} did not settle its actual command fences`);
    }

    const supplementalNonvisualPresentations = senderGroups
      .filter((group) => group !== showcmdGroup && group !== denseGroup)
      .sort(
        (left, right) =>
          serialDistance(left.base.presentationId, dense.presentationId) -
          serialDistance(right.base.presentationId, dense.presentationId),
      )
      .map((group): DirectNeovimSupplementalNonvisualEvidence => {
        if (
          group.base.generation !== dense.generation ||
          !seriallyAfter(group.base.presentationId, dense.presentationId) ||
          !seriallyAfter(group.base.firstDisplaySeq, dense.lastDisplaySeq) ||
          group.visualMembersInApplyOrder.length !== 0 ||
          group.base.nonvisualAppliedDisplayUnitCount !== group.base.senderAppliedDisplayUnitCount
        ) {
          throw new Error(
            `Direct Neovim window ${ordinal} has an unowned or non-successor supplemental presentation`,
          );
        }
        requireNoPresentationCommit(
          group,
          commits,
          `Direct Neovim window ${ordinal} supplemental presentation`,
        );
        return {
          kind: 'dense-page-redraw',
          ...group.base,
          outcome: 'supplemental-nonvisual',
          transactionSeq: 0,
        };
      });
    for (let index = 1; index < supplementalNonvisualPresentations.length; index += 1) {
      const prior = supplementalNonvisualPresentations[index - 1];
      const current = supplementalNonvisualPresentations[index];
      if (
        prior === undefined ||
        current === undefined ||
        !seriallyAfter(current.presentationId, prior.presentationId) ||
        !seriallyAfter(current.firstDisplaySeq, prior.lastDisplaySeq)
      ) {
        throw new Error(`Direct Neovim window ${ordinal} has ambiguous supplemental lineage`);
      }
    }
    for (let index = 0; index < supplementalNonvisualPresentations.length; index += 1) {
      const current = supplementalNonvisualPresentations[index];
      const admittedAncestors = [
        dense.presentationId,
        ...supplementalNonvisualPresentations
          .slice(0, index)
          .map((presentation) => presentation.presentationId),
      ];
      if (
        current === undefined ||
        !admittedAncestors.includes(current.rowPredecessorPresentationId)
      ) {
        throw new Error(
          `Direct Neovim window ${ordinal} supplemental presentation is not linked to the canonical dense lineage`,
        );
      }
    }

    const nonmemberDisplayUnits = windowApplies
      .filter((event) => event.presentationMemberCount === 0)
      .map((event) =>
        buildNonmemberEvidence(
          event,
          input.atMs,
          window.startAtMs,
          window.endAtMs,
          receivesByFrame,
          eventOrdinal,
        ),
      )
      .sort((left, right) => left.applyTraceOrdinal - right.applyTraceOrdinal);

    // Audit the producer's entire serial lineage, including header-only 0/0
    // units. Receipt order may differ, but a nonmember cannot hide a generation
    // change, overlap another group's sequence interval or escape the next
    // window's predecessor check. These are unframed nonvisual updates, not K1
    // probes (which carry inputSeq=0 and different coherent/END advice).
    const senderUnits = [
      ...senderGroups.map((group) => group.base),
      ...nonmemberDisplayUnits.map((unit) => ({
        generation: unit.generation,
        presentationId: unit.presentationId,
        firstDisplaySeq: unit.displaySeq,
        lastDisplaySeq: unit.displaySeq,
      })),
    ].sort(
      (left, right) =>
        ((left.firstDisplaySeq - showcmd.firstDisplaySeq) | 0) -
        ((right.firstDisplaySeq - showcmd.firstDisplaySeq) | 0),
    );
    for (const unit of senderUnits) {
      if (
        unit.generation !== dense.generation ||
        !validPositiveU32(unit.presentationId) ||
        !validPositiveU32(unit.firstDisplaySeq) ||
        !validPositiveU32(unit.lastDisplaySeq) ||
        (previousSenderTail !== null &&
          (!seriallyAfter(unit.presentationId, previousSenderTail.presentationId) ||
            !seriallyAfter(unit.firstDisplaySeq, previousSenderTail.lastDisplaySeq)))
      ) {
        throw new Error(`Direct Neovim window ${ordinal} has invalid complete sender lineage`);
      }
      previousSenderTail = unit;
    }

    const actualRenderedSegments = [
      ...dense.renderedSegments,
      ...(showcmd.outcome === 'rendered' ? showcmd.renderedSegments : []),
    ].sort(
      (left, right) =>
        (left.memberApplyTraceOrdinals[0] ?? Number.POSITIVE_INFINITY) -
        (right.memberApplyTraceOrdinals[0] ?? Number.POSITIVE_INFINITY),
    );
    for (const segment of actualRenderedSegments) {
      const firstApplyOrdinal = segment.memberApplyTraceOrdinals[0];
      const previousLastApplyOrdinal = previousRenderedSegment?.memberApplyTraceOrdinals.at(-1);
      if (
        firstApplyOrdinal === undefined ||
        (previousRenderedSegment !== null &&
          (previousLastApplyOrdinal === undefined ||
            firstApplyOrdinal <= previousLastApplyOrdinal ||
            segment.renderStartTraceOrdinal <= previousRenderedSegment.renderStartTraceOrdinal ||
            segment.commitTraceOrdinal <= previousRenderedSegment.commitTraceOrdinal ||
            !seriallyAfter(segment.transactionSeq, previousRenderedSegment.transactionSeq) ||
            !seriallyAfter(segment.renderSeq, previousRenderedSegment.renderSeq)))
      ) {
        throw new Error(
          `Direct Neovim window ${ordinal} has ambiguous raw-order renderer segment lineage`,
        );
      }
      previousRenderedSegment = segment;
    }
    const actualRenderSeqs = new Set(actualRenderedSegments.map((segment) => segment.renderSeq));
    const actualTransactionKeys = new Set(
      actualRenderedSegments.map((segment) =>
        transactionKey(segment.generation, segment.transactionSeq),
      ),
    );
    const windowCommits = commits.filter(
      (commit) => commit.atMs >= window.startAtMs && commit.atMs <= window.endAtMs,
    );
    const renderStartsInWindow = renderStarts.filter(
      (event) => event.atMs >= window.startAtMs && event.atMs <= window.endAtMs,
    );
    const renderEndsInWindow = [...renderEndBySeq.values()].filter(
      (event) => event.atMs >= window.startAtMs && event.atMs <= window.endAtMs,
    );
    const frameCompletionsInWindow = [...frameCompleteBySeq.values()].filter(
      (event) => event.atMs >= window.startAtMs && event.atMs <= window.endAtMs,
    );
    if (
      windowCommits.length !== actualRenderedSegments.length ||
      renderStartsInWindow.length !== actualRenderedSegments.length ||
      renderEndsInWindow.length !== actualRenderedSegments.length ||
      frameCompletionsInWindow.length !== actualRenderedSegments.length ||
      !windowCommits.every((event) =>
        actualTransactionKeys.has(transactionKey(event.generation, event.transactionSeq)),
      ) ||
      !renderStartsInWindow.every((event) => actualRenderSeqs.has(event.renderSeq)) ||
      !renderEndsInWindow.every((event) => actualRenderSeqs.has(event.renderSeq)) ||
      !frameCompletionsInWindow.every((event) => actualRenderSeqs.has(event.renderSeq))
    ) {
      throw new Error(
        `Direct Neovim window ${ordinal} contains missing or unrelated renderer evidence`,
      );
    }

    const priorReadinessBlocked =
      denseFinalSegment.gate === 'fence' || denseFinalSegment.gate === 'fence-and-opportunity';
    let fenceReleaseOwner: DirectNeovimWindowEvidence['denseScheduling']['fenceReleaseOwner'] =
      null;
    let stateReadyBeforeFenceOwnerReadinessMs = 0;
    if (priorReadinessBlocked) {
      const owner = frameCompleteBySeq.get(denseFinalSegment.fenceReleasedRenderSeq);
      const ownerOrdinal = owner === undefined ? undefined : eventOrdinal.get(owner);
      if (
        owner === undefined ||
        ownerOrdinal === undefined ||
        owner.atMs !== denseFinalSegment.fenceReleasedAtMs ||
        denseFinalSegment.fenceReleasedAtMs > denseFinalSegment.renderStartAtMs ||
        denseFinalSegment.stateReadyAtMs > owner.atMs ||
        denseFinalSegment.renderWantedAtMs > owner.atMs
      ) {
        throw new Error(
          `Direct Neovim window ${ordinal} has no exact completed renderer owner for its blocked dense page`,
        );
      }
      priorReadinessBlockedDensePageCount += 1;
      stateReadyBeforeFenceOwnerReadinessMs = owner.atMs - denseFinalSegment.stateReadyAtMs;
      fenceReleaseOwner = {
        renderSeq: owner.renderSeq,
        inputSeq: owner.displayInputSeq,
        completionDisposition: owner.completionDisposition,
        readinessTraceOrdinal: ownerOrdinal,
        observedWebglSyncReadinessAtMs: owner.atMs,
        releasedAtMs: denseFinalSegment.fenceReleasedAtMs,
        releaseObservationLagMs: denseFinalSegment.fenceReleasedAtMs - owner.atMs,
        isSameWindowShowcmd:
          renderedShowcmdSegment !== null && owner.renderSeq === renderedShowcmdSegment.renderSeq,
      };
    }

    for (const segment of actualRenderedSegments) {
      const key = transactionKey(segment.generation, segment.transactionSeq);
      if (ownedTransactions.has(key) || ownedRenderSeqs.has(segment.renderSeq)) {
        throw new Error(`Direct Neovim window ${ordinal} reuses transaction/render identity`);
      }
      ownedTransactions.add(key);
      ownedRenderSeqs.add(segment.renderSeq);
    }
    for (const group of senderGroups) {
      for (const member of group.members) {
        ownedDisplayFrames.add(frameKey(member.generation, member.displaySeq));
      }
    }
    for (const member of nonmemberDisplayUnits) {
      ownedDisplayFrames.add(frameKey(member.generation, member.displaySeq));
    }
    for (const segment of dense.renderedSegments) {
      gateCounts[segment.gate] += 1;
      denseDispositions[segment.completionDisposition] += 1;
    }
    finalGateCounts[denseFinalSegment.gate] += 1;
    denseFinalDispositions[denseFinalSegment.completionDisposition] += 1;
    showcmdOutcomeCounts[showcmd.outcome] += 1;
    if (showcmd.outcome === 'rendered') {
      if (renderedShowcmdSegment === null) {
        throw new Error(`Direct Neovim window ${ordinal} lost its rendered showcmd segment`);
      }
      showcmdDispositions[renderedShowcmdSegment.completionDisposition] += 1;
    }
    denseRenderedSegmentCount += dense.renderedSegmentCount;
    if (dense.renderedSegmentCount > 1) splitDenseWindowCount += 1;
    supplementalNonvisualPresentationCount += supplementalNonvisualPresentations.length;
    nonmemberDisplayUnitCount += nonmemberDisplayUnits.length;
    evidence.push({
      ordinal,
      measurementId: window.measurementId,
      windowStartAtMs: window.startAtMs,
      windowEndAtMs: window.endAtMs,
      inputAtMs: input.atMs,
      inputSeq: input.inputSeq,
      showcmd,
      dense,
      supplementalNonvisualPresentations,
      nonmemberDisplayUnits,
      applicationTransactionSpan: {
        firstReceiveMs: dense.firstReceivedAtMs - showcmd.firstReceivedAtMs,
        stateReadyMs: dense.stateReadyAtMs - showcmd.stateReadyAtMs,
        renderStartMs:
          renderedShowcmdSegment === null
            ? null
            : denseFinalSegment.renderStartAtMs - renderedShowcmdSegment.renderStartAtMs,
        commitMs:
          renderedShowcmdSegment === null
            ? null
            : denseFinalSegment.commitAtMs - renderedShowcmdSegment.commitAtMs,
        observedWebglSyncReadinessMs:
          renderedShowcmdSegment === null
            ? null
            : denseFinalSegment.observedWebglSyncReadinessAtMs -
              renderedShowcmdSegment.observedWebglSyncReadinessAtMs,
      },
      denseScheduling: {
        priorReadinessBlocked,
        stateReadyBeforeFenceOwnerReadinessMs,
        fenceReleaseOwner,
      },
    });
  }

  if (
    commitByTransaction.size !== commits.length ||
    ownedTransactions.size !== commits.length ||
    inputBySeq.size !== DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT ||
    appliesByFrame.size !== ownedDisplayFrames.size ||
    receives.length !== ownedDisplayFrames.size ||
    ![...appliesByFrame.keys()].every((key) => ownedDisplayFrames.has(key)) ||
    ![...receivesByFrame.entries()].every(
      ([key, owned]) => owned.length === 1 && ownedDisplayFrames.has(key),
    ) ||
    renderStartBySeq.size !== commits.length ||
    renderEndBySeq.size !== commits.length ||
    frameCompleteBySeq.size !== commits.length ||
    events.some((event) => event.kind === 'presentation_transaction_discarded')
  ) {
    throw new Error('Direct Neovim trace has unowned application or renderer transaction evidence');
  }

  const outstandingRenderSeqs: number[] = [];
  let maximumOutstandingSubmissionCount = 0;
  for (const event of events) {
    if (event.kind === 'render_start') {
      if (outstandingRenderSeqs.includes(event.renderSeq)) {
        throw new Error(`Direct Neovim render ${event.renderSeq} was submitted twice`);
      }
      outstandingRenderSeqs.push(event.renderSeq);
      maximumOutstandingSubmissionCount = Math.max(
        maximumOutstandingSubmissionCount,
        outstandingRenderSeqs.length,
      );
    } else if (event.kind === 'frame_complete') {
      if (outstandingRenderSeqs.shift() !== event.renderSeq) {
        throw new Error(`Direct Neovim render ${event.renderSeq} completed outside FIFO order`);
      }
    }
  }
  if (outstandingRenderSeqs.length !== 0 || maximumOutstandingSubmissionCount > 2) {
    throw new Error('Direct Neovim render-readiness census exceeds the bounded submission owner');
  }
  const depthTwoOverlapWindowCount = evidence.filter((window) => {
    if (window.showcmd.outcome !== 'rendered') return false;
    const showcmdReadinessTraceOrdinal = directNeovimFinalRenderedSegment(
      window.showcmd,
    ).readinessTraceOrdinal;
    return window.dense.renderedSegments.some(
      (segment) => segment.renderStartTraceOrdinal < showcmdReadinessTraceOrdinal,
    );
  }).length;
  const terminalLatestSubmittedWindowCount = evidence.filter(
    (window) =>
      directNeovimFinalRenderedSegment(window.dense).completionDisposition === 'latest-submitted',
  ).length;

  return {
    schemaVersion: 4,
    interpretation: {
      applicationBoundary:
        'each pinned Neovim navigation owns two producer-consecutive complete coherent sender presentations: one one-row showcmd followed by one dense update; legal delivery inversion may make the already-obsolete showcmd nonvisual',
      completionBoundary:
        'frame_complete is browser-observed WebGL sync command readiness; completionDisposition retains latest, superseded, and semantically invalidated submissions without treating them as photons',
      crossTransactionSpan:
        'showcmd-to-dense sender spans are two intentional application updates and are never classified as progressive exposure within one redraw; each sender presentation retains every raw-order renderer segment and its own first-to-last commit exposure',
      renderReadinessCensus:
        'raw render-start/frame-complete order counts submitted commands still awaiting browser-observed WebGL sync readiness; the deterministic 500-dirty worker test separately proves third-dirty backpressure',
    },
    windowCount: evidence.length,
    transactionCount: evidence.length * 2,
    renderedTransactionCount: commits.length,
    denseRenderedSegmentCount,
    splitDenseWindowCount,
    showcmdRowCount: DIRECT_NEOVIM_SHOWCMD_ROW_COUNT,
    denseMinimumRows: DIRECT_NEOVIM_DENSE_ROW_MINIMUM,
    showcmdOutcomeCounts,
    supplementalNonvisualPresentationCount,
    nonmemberDisplayUnitCount,
    denseGateCounts: gateCounts,
    denseFinalGateCounts: finalGateCounts,
    priorReadinessBlockedDensePageCount,
    showcmdCompletionDispositionCounts: showcmdDispositions,
    denseCompletionDispositionCounts: denseDispositions,
    denseFinalCompletionDispositionCounts: denseFinalDispositions,
    renderReadinessCensus: {
      maximumOutstandingSubmissionCount,
      depthTwoOverlapWindowCount,
      terminalLatestSubmittedWindowCount,
    },
    distributions: {
      inputToShowcmdFirstReceiveMs: distribution(
        evidence,
        (window) => window.showcmd.firstReceivedAtMs - window.inputAtMs,
      ),
      inputToShowcmdObservedWebglSyncReadinessMs: distribution(
        renderedShowcmdWindows(evidence),
        (window) =>
          directNeovimFinalRenderedSegment(window.showcmd).inputToObservedWebglSyncReadinessMs,
      ),
      inputToShowcmdObservedWebglSyncReadinessByDispositionMs: dispositionDistributions(
        renderedShowcmdWindows(evidence),
        (window) => directNeovimFinalRenderedSegment(window.showcmd),
        (transaction) => transaction.inputToObservedWebglSyncReadinessMs,
      ),
      showcmdRenderEndToObservedWebglSyncReadinessByDispositionMs: dispositionDistributions(
        renderedShowcmdWindows(evidence),
        (window) => directNeovimFinalRenderedSegment(window.showcmd),
        (transaction) => transaction.renderEndToObservedWebglSyncReadinessMs,
      ),
      showcmdToDenseFirstReceiveMs: signedDistribution(
        evidence,
        (window) => window.applicationTransactionSpan.firstReceiveMs,
      ),
      showcmdToDenseStateReadyMs: signedDistribution(
        evidence,
        (window) => window.applicationTransactionSpan.stateReadyMs,
      ),
      showcmdToDenseRenderStartMs: distribution(
        renderedShowcmdWindows(evidence),
        (window) =>
          directNeovimFinalRenderedSegment(window.dense).renderStartAtMs -
          directNeovimFinalRenderedSegment(window.showcmd).renderStartAtMs,
      ),
      showcmdToDenseCommitMs: distribution(
        renderedShowcmdWindows(evidence),
        (window) =>
          directNeovimFinalRenderedSegment(window.dense).commitAtMs -
          directNeovimFinalRenderedSegment(window.showcmd).commitAtMs,
      ),
      showcmdToDenseObservedWebglSyncReadinessMs: distribution(
        renderedShowcmdWindows(evidence),
        (window) =>
          directNeovimFinalRenderedSegment(window.dense).observedWebglSyncReadinessAtMs -
          directNeovimFinalRenderedSegment(window.showcmd).observedWebglSyncReadinessAtMs,
      ),
      obsoleteDenseStateReadyBeforeShowcmdReceiptMs: distribution(
        evidence.filter(
          (
            window,
          ): window is DirectNeovimWindowEvidence & {
            readonly showcmd: DirectNeovimObsoleteShowcmdEvidence;
          } => window.showcmd.outcome === 'obsolete-before-receipt',
        ),
        (window) => window.showcmd.denseStateReadyBeforeShowcmdReceiptMs,
      ),
      denseFirstReceiveToStateReadyMs: distribution(
        evidence,
        (window) => window.dense.stateReadyAtMs - window.dense.firstReceivedAtMs,
      ),
      denseStateReadyToRenderStartMs: distribution(
        evidence,
        (window) =>
          directNeovimFinalRenderedSegment(window.dense).renderStartAtMs -
          directNeovimFinalRenderedSegment(window.dense).stateReadyAtMs,
      ),
      denseRenderCpuMs: distribution(
        evidence,
        (window) => directNeovimFinalRenderedSegment(window.dense).renderCpuMs,
      ),
      denseRenderEndToObservedWebglSyncReadinessMs: distribution(
        evidence,
        (window) =>
          directNeovimFinalRenderedSegment(window.dense).renderEndToObservedWebglSyncReadinessMs,
      ),
      inputToDenseObservedWebglSyncReadinessMs: distribution(
        evidence,
        (window) =>
          directNeovimFinalRenderedSegment(window.dense).inputToObservedWebglSyncReadinessMs,
      ),
      denseRenderedSegmentCount: distribution(
        evidence,
        (window) => window.dense.renderedSegmentCount,
      ),
      denseSenderPresentationCommitExposureMs: distribution(
        evidence,
        (window) => window.dense.senderPresentationCommitExposureMs,
      ),
      priorReadinessBlockedMs: referenceDistribution(
        evidence
          .filter((window) => window.denseScheduling.priorReadinessBlocked)
          .map((window) => window.denseScheduling.stateReadyBeforeFenceOwnerReadinessMs),
      ),
      fenceReleaseToDenseRenderStartMs: referenceDistribution(
        evidence.flatMap((window) => {
          const owner = window.denseScheduling.fenceReleaseOwner;
          return owner === null
            ? []
            : [directNeovimFinalRenderedSegment(window.dense).renderStartAtMs - owner.releasedAtMs];
        }),
      ),
    },
    windows: evidence,
  };
}

interface SenderPresentationGroup {
  readonly base: Omit<DirectNeovimSenderPresentationEvidence, 'kind'>;
  readonly members: readonly DisplayAppliedEvent[];
  readonly receives: readonly DisplayReceivedEvent[];
  readonly visualMembersInApplyOrder: readonly DisplayAppliedEvent[];
}

function buildSenderPresentationGroup(
  unorderedMembers: readonly DisplayAppliedEvent[],
  inputAtMs: number,
  windowStartAtMs: number,
  windowEndAtMs: number,
  receivesByFrame: ReadonlyMap<string, readonly DisplayReceivedEvent[]>,
  eventOrdinal: ReadonlyMap<TerminalPerfEvent, number>,
): SenderPresentationGroup {
  const members = [...unorderedMembers].sort(
    (left, right) => left.presentationMemberIndex - right.presentationMemberIndex,
  );
  const first = members[0];
  if (
    first === undefined ||
    !validPositiveU32(first.generation) ||
    !validPositiveU32(first.inputSeq) ||
    !validPositiveU32(first.presentationId) ||
    first.presentationMemberCount === 0 ||
    members.length !== first.presentationMemberCount ||
    members.some(
      (member, index) =>
        member.generation !== first.generation ||
        member.inputSeq !== first.inputSeq ||
        member.presentationId !== first.presentationId ||
        member.presentationMemberCount !== members.length ||
        member.presentationMemberIndex !== index ||
        member.presentationCoherent !== true ||
        member.presentationEnd !== (index === members.length - 1) ||
        member.fecRecovered ||
        member.authoritativeVisualMutation === null ||
        member.byteLength <= 0 ||
        member.rowCount < 0 ||
        member.chunkIndex !== 0 ||
        member.chunkCount !== 1 ||
        member.displayKind !== 'display_delta' ||
        member.atMs < windowStartAtMs ||
        member.atMs > windowEndAtMs,
    ) ||
    new Set(members.map((member) => member.displaySeq)).size !== members.length
  ) {
    throw new Error('Direct Neovim sender presentation has incomplete or malformed membership');
  }
  for (let index = 1; index < members.length; index += 1) {
    const previous = members[index - 1];
    const current = members[index];
    if (
      previous === undefined ||
      current === undefined ||
      current.displaySeq !== nextPositiveU32(previous.displaySeq)
    ) {
      throw new Error('Direct Neovim sender-presentation display membership is not contiguous');
    }
  }
  const predecessorIds = new Set(members.map((member) => member.rowPredecessorPresentationId));
  if (predecessorIds.size !== 1) {
    throw new Error('Direct Neovim sender-presentation members disagree on predecessor lineage');
  }
  const visualMembers = members.filter((member) => member.authoritativeVisualMutation === true);
  if (
    visualMembers.some((member) => !validPositiveU32(member.presentationTransactionSeq)) ||
    members.some(
      (member) =>
        member.authoritativeVisualMutation === false && member.presentationTransactionSeq !== 0,
    )
  ) {
    throw new Error('Direct Neovim sender presentation has inconsistent visual ownership');
  }

  const receives: DisplayReceivedEvent[] = [];
  const receiveOrdinals: number[] = [];
  const applyOrdinals: number[] = [];
  for (const member of members) {
    const received = receivesByFrame.get(frameKey(member.generation, member.displaySeq));
    const exact = received?.[0];
    const receiveOrdinal = exact === undefined ? undefined : eventOrdinal.get(exact);
    const applyOrdinal = eventOrdinal.get(member);
    if (
      received?.length !== 1 ||
      exact === undefined ||
      receiveOrdinal === undefined ||
      applyOrdinal === undefined ||
      receiveOrdinal >= applyOrdinal ||
      exact.atMs > member.atMs ||
      exact.atMs < windowStartAtMs ||
      exact.atMs > windowEndAtMs ||
      exact.inputSeq !== member.inputSeq ||
      exact.presentationId !== member.presentationId ||
      exact.presentationMemberIndex !== member.presentationMemberIndex ||
      exact.presentationMemberCount !== member.presentationMemberCount ||
      exact.rowPredecessorPresentationId !== member.rowPredecessorPresentationId ||
      exact.presentationCoherent !== member.presentationCoherent ||
      exact.presentationEnd !== member.presentationEnd ||
      exact.frameId !== member.frameId ||
      exact.chunkIndex !== member.chunkIndex ||
      exact.chunkCount !== member.chunkCount ||
      exact.displayKind !== member.displayKind ||
      exact.authoritativeVisualMutation !== null ||
      exact.rowCount !== member.rowCount ||
      exact.byteLength !== member.byteLength ||
      exact.fecRecovered !== member.fecRecovered
    ) {
      throw new Error(
        `Direct Neovim sender presentation lacks one exact receive for display ${member.displaySeq}`,
      );
    }
    receives.push(exact);
    receiveOrdinals.push(receiveOrdinal);
    applyOrdinals.push(applyOrdinal);
  }
  const firstReceiveTraceOrdinal = Math.min(...receiveOrdinals);
  const stateReadyTraceOrdinal = Math.max(...applyOrdinals);
  const firstReceiveIndex = receiveOrdinals.indexOf(firstReceiveTraceOrdinal);
  const stateReadyIndex = applyOrdinals.indexOf(stateReadyTraceOrdinal);
  const firstReceive = receives[firstReceiveIndex];
  const stateReady = members[stateReadyIndex];
  const firstReceivedAtMs = Math.min(...receives.map((event) => event.atMs));
  const stateReadyAtMs = Math.max(...members.map((member) => member.atMs));
  if (
    firstReceive === undefined ||
    stateReady === undefined ||
    firstReceive.atMs !== firstReceivedAtMs ||
    stateReady.atMs !== stateReadyAtMs ||
    inputAtMs > firstReceivedAtMs ||
    Math.max(...receives.map((event) => event.atMs)) > stateReadyAtMs
  ) {
    throw new Error('Direct Neovim sender presentation has invalid input/receive/apply order');
  }

  return {
    base: {
      generation: first.generation,
      inputSeq: first.inputSeq,
      presentationId: first.presentationId,
      rowPredecessorPresentationId: first.rowPredecessorPresentationId,
      firstDisplaySeq: first.displaySeq,
      lastDisplaySeq: members[members.length - 1]?.displaySeq ?? first.displaySeq,
      memberDisplaySeqs: members.map((member) => member.displaySeq),
      memberRowCounts: members.map((member) => member.rowCount),
      memberByteLengths: members.map((member) => member.byteLength),
      firstReceiveTraceOrdinal,
      firstReceivedAtMs,
      lastReceivedAtMs: Math.max(...receives.map((event) => event.atMs)),
      firstAppliedAtMs: Math.min(...members.map((member) => member.atMs)),
      stateReadyTraceOrdinal,
      stateReadyAtMs,
      senderAppliedDisplayUnitCount: members.length,
      visualAppliedDisplayUnitCount: visualMembers.length,
      nonvisualAppliedDisplayUnitCount: members.length - visualMembers.length,
      senderRowCount: members.reduce((sum, member) => sum + member.rowCount, 0),
      senderByteLength: members.reduce((sum, member) => sum + member.byteLength, 0),
    },
    members,
    receives,
    visualMembersInApplyOrder: [...visualMembers].sort(
      (left, right) =>
        (eventOrdinal.get(left) ?? Number.POSITIVE_INFINITY) -
        (eventOrdinal.get(right) ?? Number.POSITIVE_INFINITY),
    ),
  };
}

function buildRenderedPresentationEvidence(
  kind: DirectNeovimTransactionKind,
  group: SenderPresentationGroup,
  inputAtMs: number,
  commitByTransaction: ReadonlyMap<string, PresentationCommitEvent>,
  appliesByTransaction: ReadonlyMap<string, readonly DisplayAppliedEvent[]>,
  renderStartBySeq: ReadonlyMap<number, RenderStartEvent>,
  renderEndBySeq: ReadonlyMap<number, RenderEndEvent>,
  frameCompleteBySeq: ReadonlyMap<number, FrameCompleteEvent>,
  renderStarts: readonly RenderStartEvent[],
  eventOrdinal: ReadonlyMap<TerminalPerfEvent, number>,
): DirectNeovimRenderedPresentationEvidence {
  const memberPartitions: DisplayAppliedEvent[][] = [];
  const seenTransactions = new Set<number>();
  for (const member of group.visualMembersInApplyOrder) {
    const current = memberPartitions[memberPartitions.length - 1];
    if (current?.[0]?.presentationTransactionSeq === member.presentationTransactionSeq) {
      current.push(member);
      continue;
    }
    if (seenTransactions.has(member.presentationTransactionSeq)) {
      throw new Error(`${kind} reuses a transaction across discontiguous raw apply partitions`);
    }
    seenTransactions.add(member.presentationTransactionSeq);
    memberPartitions.push([member]);
  }
  if (memberPartitions.length === 0) {
    throw new Error(`${kind} has no authoritative visual partition`);
  }
  const renderedSegments = memberPartitions.map((members, segmentOrdinal) =>
    buildRenderedSegmentEvidence(
      kind,
      segmentOrdinal,
      group,
      members,
      inputAtMs,
      commitByTransaction,
      appliesByTransaction,
      renderStartBySeq,
      renderEndBySeq,
      frameCompleteBySeq,
      renderStarts,
      eventOrdinal,
    ),
  );
  for (let index = 1; index < renderedSegments.length; index += 1) {
    const previous = renderedSegments[index - 1];
    const current = renderedSegments[index];
    if (
      previous === undefined ||
      current === undefined ||
      !seriallyAfter(current.transactionSeq, previous.transactionSeq) ||
      !seriallyAfter(current.renderSeq, previous.renderSeq) ||
      current.memberApplyTraceOrdinals[0] === undefined ||
      previous.memberApplyTraceOrdinals.at(-1) === undefined ||
      (current.memberApplyTraceOrdinals[0] ?? 0) <=
        (previous.memberApplyTraceOrdinals.at(-1) ?? Number.POSITIVE_INFINITY) ||
      current.commitTraceOrdinal <= previous.commitTraceOrdinal ||
      current.commitAtMs < previous.commitAtMs
    ) {
      throw new Error(`${kind} has ambiguous raw-order renderer partitions`);
    }
  }
  const firstSegment = renderedSegments[0];
  const finalSegment = renderedSegments.at(-1);
  if (firstSegment === undefined || finalSegment === undefined) {
    throw new Error(`${kind} lost its rendered segment endpoints`);
  }
  const partitionedDisplaySeqs = renderedSegments.flatMap((segment) => segment.memberDisplaySeqs);
  if (
    partitionedDisplaySeqs.length !== group.visualMembersInApplyOrder.length ||
    partitionedDisplaySeqs.some(
      (displaySeq, index) => displaySeq !== group.visualMembersInApplyOrder[index]?.displaySeq,
    )
  ) {
    throw new Error(`${kind} visual partitions do not exactly cover raw applied membership`);
  }
  const senderPresentationCommitExposureMs = finalSegment.commitAtMs - firstSegment.commitAtMs;
  if (
    !Number.isFinite(senderPresentationCommitExposureMs) ||
    senderPresentationCommitExposureMs < 0
  ) {
    throw new Error(`${kind} has invalid sender-presentation commit exposure`);
  }
  return {
    kind,
    ...group.base,
    outcome: 'rendered',
    renderedSegments,
    renderedSegmentCount: renderedSegments.length,
    finalSegmentIndex: renderedSegments.length - 1,
    visualRowCount: group.visualMembersInApplyOrder.reduce(
      (sum, member) => sum + member.rowCount,
      0,
    ),
    visualByteLength: group.visualMembersInApplyOrder.reduce(
      (sum, member) => sum + member.byteLength,
      0,
    ),
    firstCommitTraceOrdinal: firstSegment.commitTraceOrdinal,
    lastCommitTraceOrdinal: finalSegment.commitTraceOrdinal,
    firstCommitAtMs: firstSegment.commitAtMs,
    lastCommitAtMs: finalSegment.commitAtMs,
    senderPresentationCommitExposureMs,
  };
}

function buildRenderedSegmentEvidence(
  kind: DirectNeovimTransactionKind,
  segmentOrdinal: number,
  group: SenderPresentationGroup,
  visualMembers: readonly DisplayAppliedEvent[],
  inputAtMs: number,
  commitByTransaction: ReadonlyMap<string, PresentationCommitEvent>,
  appliesByTransaction: ReadonlyMap<string, readonly DisplayAppliedEvent[]>,
  renderStartBySeq: ReadonlyMap<number, RenderStartEvent>,
  renderEndBySeq: ReadonlyMap<number, RenderEndEvent>,
  frameCompleteBySeq: ReadonlyMap<number, FrameCompleteEvent>,
  renderStarts: readonly RenderStartEvent[],
  eventOrdinal: ReadonlyMap<TerminalPerfEvent, number>,
): DirectNeovimRenderedSegmentEvidence {
  const firstVisualMember = visualMembers[0];
  const lastVisualMember = visualMembers.at(-1);
  if (firstVisualMember === undefined || lastVisualMember === undefined) {
    throw new Error(`${kind} segment ${segmentOrdinal} has no visual membership`);
  }
  const transactionSeq = firstVisualMember.presentationTransactionSeq;
  const transactionMembers = appliesByTransaction.get(
    transactionKey(group.base.generation, transactionSeq),
  );
  const commit = commitByTransaction.get(transactionKey(group.base.generation, transactionSeq));
  const memberApplyTraceOrdinals: number[] = [];
  for (const member of visualMembers) {
    const ordinal = eventOrdinal.get(member);
    if (ordinal === undefined) {
      throw new Error(`${kind} segment ${segmentOrdinal} has no exact member apply ordinal`);
    }
    memberApplyTraceOrdinals.push(ordinal);
  }
  const receiveByDisplaySeq = new Map(group.receives.map((event) => [event.displaySeq, event]));
  const segmentReceives = visualMembers.map((member) => receiveByDisplaySeq.get(member.displaySeq));
  const receiveTraceOrdinals = segmentReceives.map((event) =>
    event === undefined ? undefined : eventOrdinal.get(event),
  );
  const firstReceiveTraceOrdinal = Math.min(
    ...receiveTraceOrdinals.map((ordinal) => ordinal ?? Number.POSITIVE_INFINITY),
  );
  const firstReceiveIndex = receiveTraceOrdinals.indexOf(firstReceiveTraceOrdinal);
  const firstReceive = segmentReceives[firstReceiveIndex];
  const stateReadyTraceOrdinal = memberApplyTraceOrdinals.at(-1);
  const stateReady = visualMembers.at(-1);
  if (
    commit === undefined ||
    transactionMembers === undefined ||
    transactionMembers.length !== visualMembers.length ||
    transactionMembers.some((member, index) => member !== visualMembers[index]) ||
    !commit.authoritativeVisualChange ||
    !commit.coherent ||
    !validPositiveU32(commit.generation) ||
    commit.generation !== group.base.generation ||
    commit.displayInputSeq !== group.base.inputSeq ||
    commit.firstPresentationId !== group.base.presentationId ||
    commit.lastPresentationId !== group.base.presentationId ||
    commit.firstDisplaySeq !== firstVisualMember.displaySeq ||
    commit.lastDisplaySeq !== lastVisualMember.displaySeq ||
    commit.datagramCount !== visualMembers.length ||
    commit.rowCount !== visualMembers.reduce((sum, member) => sum + member.rowCount, 0) ||
    commit.byteLength !== visualMembers.reduce((sum, member) => sum + member.byteLength, 0) ||
    visualMembers.some((member) => member.presentationTransactionSeq !== commit.transactionSeq) ||
    receiveTraceOrdinals.some((ordinal) => ordinal === undefined) ||
    firstReceive === undefined ||
    stateReady === undefined ||
    stateReadyTraceOrdinal === undefined ||
    !Number.isFinite(firstReceiveTraceOrdinal) ||
    firstReceive.atMs !== Math.min(...segmentReceives.map((event) => event?.atMs ?? Infinity)) ||
    segmentReceives.some((event) => event === undefined || event.atMs > stateReady.atMs) ||
    visualMembers.some((member) => member.atMs > stateReady.atMs) ||
    commit.rowCount < 0 ||
    commit.byteLength <= 0 ||
    stateReady.atMs > commit.atMs
  ) {
    throw new Error(`${kind} segment ${segmentOrdinal} is not an exact visual partition commit`);
  }

  const renderStart = renderStartBySeq.get(commit.renderSeq);
  const renderEnd = renderEndBySeq.get(commit.renderSeq);
  const completion = frameCompleteBySeq.get(commit.renderSeq);
  if (
    renderStart === undefined ||
    renderEnd === undefined ||
    completion === undefined ||
    renderStart.displayInputSeq !== commit.displayInputSeq ||
    renderEnd.displayInputSeq !== commit.displayInputSeq ||
    completion.displayInputSeq !== commit.displayInputSeq ||
    renderEnd.completionMode !== 'gpu-queue' ||
    renderStart.wantedAtMs <= 0 ||
    renderStart.wantedAtMs > renderStart.atMs ||
    stateReady.atMs > renderStart.atMs ||
    renderStart.atMs > renderEnd.atMs ||
    renderEnd.atMs !== commit.atMs ||
    commit.atMs > completion.atMs ||
    (completion.previousPollAtMs !== 0 &&
      (completion.previousPollAtMs < renderEnd.atMs ||
        completion.previousPollAtMs > completion.atMs))
  ) {
    throw new Error(
      `${kind} segment ${segmentOrdinal} lacks one ordered render-start/end/command-readiness join`,
    );
  }
  validateRenderGate(renderStart);

  const renderStartOrdinal = eventOrdinal.get(renderStart);
  const renderEndOrdinal = eventOrdinal.get(renderEnd);
  const completionOrdinal = eventOrdinal.get(completion);
  const commitTraceOrdinal = eventOrdinal.get(commit);
  if (
    renderStartOrdinal === undefined ||
    renderEndOrdinal === undefined ||
    completionOrdinal === undefined ||
    commitTraceOrdinal === undefined ||
    stateReadyTraceOrdinal >= renderStartOrdinal ||
    renderStartOrdinal >= renderEndOrdinal ||
    renderEndOrdinal >= commitTraceOrdinal ||
    commitTraceOrdinal >= completionOrdinal
  ) {
    throw new Error(
      `${kind} segment ${segmentOrdinal} has no exact ordered submission/readiness record`,
    );
  }
  const supersededBeforeReadiness = renderStarts.some((candidate) => {
    const candidateOrdinal = eventOrdinal.get(candidate);
    return (
      candidateOrdinal !== undefined &&
      candidateOrdinal > renderStartOrdinal &&
      candidateOrdinal < completionOrdinal &&
      candidate.atMs >= renderStart.atMs &&
      candidate.atMs <= completion.atMs &&
      seriallyAfter(candidate.renderSeq, renderStart.renderSeq)
    );
  });
  if (
    (completion.completionDisposition === 'latest-submitted' && supersededBeforeReadiness) ||
    (completion.completionDisposition === 'superseded' && !supersededBeforeReadiness)
  ) {
    throw new Error(
      `${kind} segment ${segmentOrdinal} completion disposition disagrees with exact later renderer submissions`,
    );
  }

  return {
    segmentOrdinal,
    generation: group.base.generation,
    inputSeq: group.base.inputSeq,
    presentationId: group.base.presentationId,
    transactionSeq: commit.transactionSeq,
    renderSeq: commit.renderSeq,
    firstDisplaySeq: firstVisualMember.displaySeq,
    lastDisplaySeq: lastVisualMember.displaySeq,
    memberDisplaySeqs: visualMembers.map((member) => member.displaySeq),
    memberApplyTraceOrdinals,
    firstReceiveTraceOrdinal,
    firstReceivedAtMs: firstReceive.atMs,
    stateReadyTraceOrdinal,
    stateReadyAtMs: stateReady.atMs,
    renderWantedAtMs: renderStart.wantedAtMs,
    renderStartTraceOrdinal: renderStartOrdinal,
    renderStartAtMs: renderStart.atMs,
    renderEndTraceOrdinal: renderEndOrdinal,
    renderEndAtMs: renderEnd.atMs,
    commitTraceOrdinal,
    commitAtMs: commit.atMs,
    observedWebglSyncReadinessAtMs: completion.atMs,
    readinessTraceOrdinal: completionOrdinal,
    previousUnreadyPollAtMs: completion.previousPollAtMs,
    completionDisposition: completion.completionDisposition,
    supersededBeforeReadiness,
    gate: renderStart.gate,
    fenceReleasedRenderSeq: renderStart.fenceReleasedRenderSeq,
    fenceReleasedAtMs: renderStart.fenceReleasedAtMs,
    opportunityEnteredAtMs: renderStart.opportunityEnteredAtMs,
    opportunityDelayMs: renderStart.opportunityDelayMs,
    fenceWaitMs: renderStart.fenceWaitMs,
    opportunityWaitMs: renderStart.opportunityWaitMs,
    refreshPeriodMs: renderStart.refreshPeriodMs,
    commitReason: commit.reason,
    commitEndSeen: commit.endSeen,
    appliedDisplayUnitCount: visualMembers.length,
    rowCount: commit.rowCount,
    byteLength: commit.byteLength,
    inputToFirstReceiveMs: firstReceive.atMs - inputAtMs,
    firstReceiveToStateReadyMs: stateReady.atMs - firstReceive.atMs,
    stateReadyToRenderStartMs: renderStart.atMs - stateReady.atMs,
    renderCpuMs: renderEnd.atMs - renderStart.atMs,
    renderEndToObservedWebglSyncReadinessMs: completion.atMs - renderEnd.atMs,
    inputToObservedWebglSyncReadinessMs: completion.atMs - inputAtMs,
    lastUnreadyPollToObservedReadinessMs:
      completion.previousPollAtMs === 0 ? 0 : completion.atMs - completion.previousPollAtMs,
  };
}

function buildNonmemberEvidence(
  applied: DisplayAppliedEvent,
  inputAtMs: number,
  windowStartAtMs: number,
  windowEndAtMs: number,
  receivesByFrame: ReadonlyMap<string, readonly DisplayReceivedEvent[]>,
  eventOrdinal: ReadonlyMap<TerminalPerfEvent, number>,
): DirectNeovimNonmemberEvidence {
  const received = receivesByFrame.get(frameKey(applied.generation, applied.displaySeq));
  const exact = received?.[0];
  const receiveTraceOrdinal = exact === undefined ? undefined : eventOrdinal.get(exact);
  const applyTraceOrdinal = eventOrdinal.get(applied);
  if (
    applied.presentationMemberIndex !== 0 ||
    applied.presentationMemberCount !== 0 ||
    applied.rowPredecessorPresentationId !== 0 ||
    applied.presentationCoherent ||
    !applied.presentationEnd ||
    applied.authoritativeVisualMutation !== false ||
    applied.presentationTransactionSeq !== 0 ||
    applied.fecRecovered ||
    applied.chunkIndex !== 0 ||
    applied.chunkCount !== 1 ||
    applied.displayKind !== 'display_delta' ||
    applied.byteLength <= 0 ||
    applied.rowCount !== 0 ||
    applied.atMs < windowStartAtMs ||
    applied.atMs > windowEndAtMs ||
    received?.length !== 1 ||
    exact === undefined ||
    receiveTraceOrdinal === undefined ||
    applyTraceOrdinal === undefined ||
    receiveTraceOrdinal >= applyTraceOrdinal ||
    inputAtMs > exact.atMs ||
    exact.atMs > applied.atMs ||
    exact.inputSeq !== applied.inputSeq ||
    exact.frameId !== applied.frameId ||
    exact.presentationId !== applied.presentationId ||
    exact.presentationMemberIndex !== 0 ||
    exact.presentationMemberCount !== 0 ||
    exact.rowPredecessorPresentationId !== applied.rowPredecessorPresentationId ||
    exact.presentationCoherent !== applied.presentationCoherent ||
    exact.presentationEnd !== applied.presentationEnd ||
    exact.rowCount !== applied.rowCount ||
    exact.byteLength !== applied.byteLength ||
    exact.displayKind !== applied.displayKind ||
    exact.fecRecovered !== applied.fecRecovered
  ) {
    throw new Error(`Direct Neovim nonmember display ${applied.displaySeq} is not exactly owned`);
  }
  return {
    generation: applied.generation,
    inputSeq: applied.inputSeq,
    displaySeq: applied.displaySeq,
    presentationId: applied.presentationId,
    rowPredecessorPresentationId: applied.rowPredecessorPresentationId,
    receiveTraceOrdinal,
    receivedAtMs: exact.atMs,
    applyTraceOrdinal,
    appliedAtMs: applied.atMs,
    rowCount: applied.rowCount,
    byteLength: applied.byteLength,
  };
}

function requireNoPresentationCommit(
  group: SenderPresentationGroup,
  commits: readonly PresentationCommitEvent[],
  label: string,
): void {
  if (
    group.visualMembersInApplyOrder.length !== 0 ||
    commits.some(
      (commit) =>
        commit.generation === group.base.generation &&
        commit.displayInputSeq === group.base.inputSeq &&
        (commit.firstPresentationId === group.base.presentationId ||
          commit.lastPresentationId === group.base.presentationId),
    )
  ) {
    throw new Error(`${label} has fabricated visual/commit ownership`);
  }
}

function renderedShowcmdWindows(
  windows: readonly DirectNeovimWindowEvidence[],
): readonly (DirectNeovimWindowEvidence & {
  readonly showcmd: DirectNeovimRenderedPresentationEvidence;
})[] {
  return windows.filter(
    (
      window,
    ): window is DirectNeovimWindowEvidence & {
      readonly showcmd: DirectNeovimRenderedPresentationEvidence;
    } => window.showcmd.outcome === 'rendered',
  );
}

export function directNeovimFinalRenderedSegment(
  presentation: DirectNeovimRenderedPresentationEvidence,
): DirectNeovimRenderedSegmentEvidence {
  const segment = presentation.renderedSegments[presentation.finalSegmentIndex];
  if (
    segment === undefined ||
    presentation.finalSegmentIndex !== presentation.renderedSegments.length - 1 ||
    presentation.renderedSegmentCount !== presentation.renderedSegments.length
  ) {
    throw new Error('Direct Neovim rendered presentation has no exact final segment');
  }
  return segment;
}

function validateRenderGate(event: RenderStartEvent): void {
  const fence = event.gate === 'fence' || event.gate === 'fence-and-opportunity';
  const opportunity = event.gate === 'opportunity' || event.gate === 'fence-and-opportunity';
  if (
    !Number.isFinite(event.fenceWaitMs) ||
    event.fenceWaitMs < 0 ||
    !Number.isFinite(event.opportunityWaitMs) ||
    event.opportunityWaitMs < 0 ||
    (!fence && event.fenceWaitMs !== 0) ||
    (!opportunity && event.opportunityWaitMs !== 0) ||
    (event.wantedAtMs > 0 &&
      event.fenceWaitMs + event.opportunityWaitMs > event.atMs - event.wantedAtMs + 0.001) ||
    (fence
      ? event.fenceReleasedRenderSeq <= 0 ||
        event.fenceReleasedAtMs <= 0 ||
        event.fenceReleasedAtMs > event.atMs
      : event.fenceReleasedRenderSeq !== 0 || event.fenceReleasedAtMs !== 0) ||
    (opportunity
      ? event.opportunityEnteredAtMs <= 0 ||
        event.opportunityEnteredAtMs > event.atMs ||
        event.opportunityDelayMs <= 0
      : event.opportunityEnteredAtMs !== 0 || event.opportunityDelayMs !== 0)
  ) {
    throw new Error(`render ${event.renderSeq} has inconsistent ${event.gate} gate evidence`);
  }
}

function distribution<T>(
  values: readonly T[],
  select: (value: T) => number,
): ReferenceDistribution {
  const samples = values.map(select);
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error('Direct Neovim transaction distribution contains an invalid duration');
  }
  return referenceDistribution(samples);
}

function signedDistribution<T>(
  values: readonly T[],
  select: (value: T) => number,
): ReferenceDistribution {
  const samples = values.map(select);
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('Direct Neovim transaction distribution contains an invalid signed duration');
  }
  return referenceDistribution(samples);
}

function dispositionDistributions<T>(
  values: readonly T[],
  transaction: (value: T) => DirectNeovimTransactionEvidence,
  select: (value: DirectNeovimTransactionEvidence) => number,
): Record<FrameCompleteEvent['completionDisposition'], ReferenceDistribution> {
  const samples: Record<FrameCompleteEvent['completionDisposition'], number[]> = {
    'latest-submitted': [],
    superseded: [],
    invalidated: [],
  };
  for (const value of values) {
    const evidence = transaction(value);
    const sample = select(evidence);
    if (!Number.isFinite(sample) || sample < 0) {
      throw new Error('Direct Neovim disposition distribution contains an invalid duration');
    }
    samples[evidence.completionDisposition].push(sample);
  }
  return {
    'latest-submitted': referenceDistribution(samples['latest-submitted']),
    superseded: referenceDistribution(samples.superseded),
    invalidated: referenceDistribution(samples.invalidated),
  };
}

function uniqueEventMap<T, K>(
  events: readonly T[],
  keyOf: (event: T) => K,
  label: string,
): Map<K, T> {
  const map = new Map<K, T>();
  for (const event of events) {
    const key = keyOf(event);
    if (map.has(key))
      throw new Error(`Direct Neovim trace duplicates ${label} identity ${String(key)}`);
    map.set(key, event);
  }
  return map;
}

function renderGateCounts(): Record<TerminalRenderGate, number> {
  return { immediate: 0, fence: 0, opportunity: 0, 'fence-and-opportunity': 0 };
}

function dispositionCounts(): Record<FrameCompleteEvent['completionDisposition'], number> {
  return { 'latest-submitted': 0, superseded: 0, invalidated: 0 };
}

function transactionKey(generation: number, transactionSeq: number): string {
  return `${generation}:${transactionSeq}`;
}

function presentationKey(generation: number, presentationId: number): string {
  return `${generation}:${presentationId}`;
}

function frameKey(generation: number, displaySeq: number): string {
  return `${generation}:${displaySeq}`;
}

function nextPositiveU32(value: number): number {
  return value === 0xffff_ffff ? 1 : value + 1;
}

function validPositiveU32(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function seriallyAfter(candidate: number, previous: number): boolean {
  if (!validPositiveU32(candidate) || !validPositiveU32(previous)) {
    return false;
  }
  const distance = (candidate - previous) >>> 0;
  return distance > 0 && distance < 0x8000_0000;
}

function serialDistance(candidate: number, previous: number): number {
  const distance = (candidate - previous) >>> 0;
  return distance > 0 && distance < 0x8000_0000 ? distance : Number.POSITIVE_INFINITY;
}
