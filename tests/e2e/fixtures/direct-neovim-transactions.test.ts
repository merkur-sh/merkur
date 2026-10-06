import { describe, expect, test } from 'bun:test';

import type { TerminalPerfEvent } from '../../../apps/web/src/perf/terminal-latency';
import {
  DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT,
  directNeovimFinalRenderedSegment,
  summarizeDirectNeovimTransactions,
  validateDirectNeovimSteadyTransactions,
} from './direct-neovim-transactions';
import type { DirectCoherentInputPopulation } from './direct-tui-workloads';

describe('Direct Neovim application-transaction evidence', () => {
  test('proves 100 one-row showcmd and dense redraw transactions with exact fence owners', () => {
    const fixture = neovimFixture('one-credit');
    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);

    expect(summary.windowCount).toBe(100);
    expect(summary.transactionCount).toBe(200);
    expect(summary.renderedTransactionCount).toBe(200);
    expect(summary.showcmdOutcomeCounts).toEqual({
      rendered: 100,
      'obsolete-before-receipt': 0,
    });
    expect(summary.showcmdCompletionDispositionCounts).toEqual({
      'latest-submitted': 100,
      superseded: 0,
      invalidated: 0,
    });
    expect(summary.denseCompletionDispositionCounts).toEqual({
      'latest-submitted': 100,
      superseded: 0,
      invalidated: 0,
    });
    expect(summary.denseGateCounts).toEqual({
      immediate: 0,
      fence: 100,
      opportunity: 0,
      'fence-and-opportunity': 0,
    });
    expect(summary.priorReadinessBlockedDensePageCount).toBe(100);
    expect(summary.renderReadinessCensus).toEqual({
      maximumOutstandingSubmissionCount: 1,
      depthTwoOverlapWindowCount: 0,
      terminalLatestSubmittedWindowCount: 100,
    });
    expect(summary.distributions.priorReadinessBlockedMs.count).toBe(100);
    expect(
      summary.distributions.inputToShowcmdObservedWebglSyncReadinessByDispositionMs[
        'latest-submitted'
      ].count,
    ).toBe(100);
    expect(
      summary.distributions.inputToShowcmdObservedWebglSyncReadinessByDispositionMs.superseded
        .count,
    ).toBe(0);
    expect(summary.distributions.fenceReleaseToDenseRenderStartMs.max).toBe(0);
    expect(summary.windows[0]?.denseScheduling.fenceReleaseOwner).toMatchObject({
      isSameWindowShowcmd: true,
      releaseObservationLagMs: 0,
    });
  });

  test('retains superseded showcmd readiness when the dense render was submitted first', () => {
    const fixture = neovimFixture('two-credit');
    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);

    expect(summary.showcmdCompletionDispositionCounts).toEqual({
      'latest-submitted': 0,
      superseded: 100,
      invalidated: 0,
    });
    expect(summary.denseCompletionDispositionCounts).toEqual({
      'latest-submitted': 100,
      superseded: 0,
      invalidated: 0,
    });
    expect(summary.denseGateCounts.immediate).toBe(100);
    expect(summary.renderedTransactionCount).toBe(200);
    expect(summary.showcmdOutcomeCounts).toEqual({
      rendered: 100,
      'obsolete-before-receipt': 0,
    });
    expect(summary.priorReadinessBlockedDensePageCount).toBe(0);
    expect(summary.renderReadinessCensus).toEqual({
      maximumOutstandingSubmissionCount: 2,
      depthTwoOverlapWindowCount: 100,
      terminalLatestSubmittedWindowCount: 100,
    });
    expect(
      summary.distributions.inputToShowcmdObservedWebglSyncReadinessByDispositionMs.superseded
        .count,
    ).toBe(100);
    expect(
      summary.distributions.showcmdRenderEndToObservedWebglSyncReadinessByDispositionMs.superseded
        .count,
    ).toBe(100);
    const firstShowcmd = summary.windows[0]?.showcmd;
    if (firstShowcmd?.outcome !== 'rendered') throw new Error('fixture showcmd was not rendered');
    expect(directNeovimFinalRenderedSegment(firstShowcmd).supersededBeforeReadiness).toBe(true);
    const firstDense = summary.windows[0]?.dense;
    if (firstDense === undefined) throw new Error('fixture dense update is missing');
    expect(directNeovimFinalRenderedSegment(firstDense).supersededBeforeReadiness).toBe(false);
  });

  test('retains a producer-complete showcmd that became obsolete before receipt without inventing readiness', () => {
    const fixture = neovimFixture('two-credit');
    makeFirstShowcmdObsolete(fixture);

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    expect(summary.transactionCount).toBe(200);
    expect(summary.renderedTransactionCount).toBe(199);
    expect(summary.showcmdOutcomeCounts).toEqual({
      rendered: 99,
      'obsolete-before-receipt': 1,
    });
    expect(summary.distributions.inputToShowcmdFirstReceiveMs.count).toBe(100);
    expect(summary.distributions.inputToShowcmdObservedWebglSyncReadinessMs.count).toBe(99);
    expect(summary.distributions.obsoleteDenseStateReadyBeforeShowcmdReceiptMs.count).toBe(1);
    expect(summary.distributions.showcmdToDenseObservedWebglSyncReadinessMs.count).toBe(99);
    const showcmd = summary.windows[0]?.showcmd;
    if (showcmd?.outcome !== 'obsolete-before-receipt') {
      throw new Error('fixture showcmd did not retain its obsolete outcome');
    }
    expect(showcmd.transactionSeq).toBeNull();
    expect(showcmd.renderSeq).toBeNull();
    expect(showcmd.visualAppliedDisplayUnitCount).toBe(0);
    expect(showcmd.nonvisualAppliedDisplayUnitCount).toBe(1);
    expect(showcmd.laterDensePresentationId).toBe(2);
    expect(showcmd.denseStateReadyBeforeShowcmdReceiptMs).toBeGreaterThan(0);
    expect(summary.windows[0]?.applicationTransactionSpan.renderStartMs).toBeNull();
  });

  test('retains an interleaved late-tail dense split and fails only the steady coherence gate', () => {
    const fixture = neovimFixture('two-credit');
    splitFirstDensePresentation(fixture);

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    const firstWindow = summary.windows[0];
    if (firstWindow === undefined || firstWindow.showcmd.outcome !== 'rendered') {
      throw new Error('split fixture lost its first canonical window');
    }
    expect(summary.schemaVersion).toBe(4);
    expect(summary.transactionCount).toBe(200);
    expect(summary.renderedTransactionCount).toBe(201);
    expect(summary.denseRenderedSegmentCount).toBe(101);
    expect(summary.splitDenseWindowCount).toBe(1);
    expect(summary.denseCompletionDispositionCounts).toEqual({
      'latest-submitted': 101,
      superseded: 0,
      invalidated: 0,
    });
    expect(summary.denseFinalCompletionDispositionCounts).toEqual({
      'latest-submitted': 100,
      superseded: 0,
      invalidated: 0,
    });
    expect(firstWindow.dense.renderedSegments).toHaveLength(2);
    expect(firstWindow.dense.renderedSegments.map((segment) => segment.transactionSeq)).toEqual([
      1, 3,
    ]);
    expect(firstWindow.dense.renderedSegments.map((segment) => segment.renderSeq)).toEqual([1, 3]);
    expect(firstWindow.dense.renderedSegments.map((segment) => segment.memberDisplaySeqs)).toEqual([
      [2],
      [3],
    ]);
    expect(directNeovimFinalRenderedSegment(firstWindow.showcmd).transactionSeq).toBe(2);
    expect(firstWindow.dense.finalSegmentIndex).toBe(1);
    expect(directNeovimFinalRenderedSegment(firstWindow.dense).memberDisplaySeqs).toEqual([3]);
    expect(firstWindow.dense.senderPresentationCommitExposureMs).toBeCloseTo(1.7);
    expect(summary.distributions.denseRenderedSegmentCount).toMatchObject({
      count: 100,
      p50: 1,
      p95: 1,
      p99: 1,
      max: 2,
    });
    expect(validateDirectNeovimSteadyTransactions(summary)).toEqual([
      'steady Neovim phase split 1/100 dense sender presentations across 101 renderer segments',
    ]);
  });

  test('uses raw apply order, not sender member index, to choose the final dense segment', () => {
    const fixture = neovimFixture('two-credit');
    splitFirstDensePresentation(fixture, true);

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    const dense = summary.windows[0]?.dense;
    if (dense === undefined) throw new Error('reverse-arrival fixture lost its dense update');
    expect(dense.memberDisplaySeqs).toEqual([2, 3]);
    expect(dense.renderedSegments.map((segment) => segment.memberDisplaySeqs)).toEqual([[3], [2]]);
    expect(directNeovimFinalRenderedSegment(dense).memberDisplaySeqs).toEqual([2]);
    expect(dense.finalSegmentIndex).toBe(1);
  });

  test('accepts an exact zero-row visual segment without weakening dense row coverage', () => {
    const fixture = neovimFixture('two-credit');
    splitFirstDensePresentation(fixture);
    fixture.events = fixture.events.map((event) => {
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.inputSeq === 1 &&
        event.displaySeq === 2
      ) {
        return { ...event, rowCount: 0 };
      }
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.inputSeq === 1 &&
        event.displaySeq === 3
      ) {
        return { ...event, rowCount: 25 };
      }
      if (event.kind === 'presentation_commit' && event.displayInputSeq === 1) {
        if (event.transactionSeq === 1) return { ...event, rowCount: 0 };
        if (event.transactionSeq === 3) return { ...event, rowCount: 25 };
      }
      return event;
    });

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    const dense = summary.windows[0]?.dense;
    if (dense === undefined) throw new Error('zero-row fixture lost its dense update');
    expect(dense.visualRowCount).toBe(25);
    expect(dense.renderedSegments.map((segment) => segment.rowCount)).toEqual([0, 25]);
  });

  test('retains a late nonvisual sender tail without moving the final visual endpoint', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) => {
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.inputSeq === 1 &&
        event.displaySeq === 2
      ) {
        return { ...event, rowCount: 25 };
      }
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.inputSeq === 1 &&
        event.displaySeq === 3
      ) {
        return {
          ...event,
          atMs: event.kind === 'display_received' ? 1_007.1 : 1_007.2,
          rowCount: 0,
          ...(event.kind === 'worker_display_applied'
            ? { authoritativeVisualMutation: false, presentationTransactionSeq: 0 }
            : {}),
        };
      }
      if (
        event.kind === 'presentation_commit' &&
        event.displayInputSeq === 1 &&
        event.firstPresentationId === 2
      ) {
        return {
          ...event,
          firstDisplaySeq: 2,
          lastDisplaySeq: 2,
          datagramCount: 1,
          rowCount: 25,
          byteLength: 120,
          endSeen: false,
          reason: 'deadline-timer',
        };
      }
      return event;
    });
    fixture.events.sort((left, right) => left.atMs - right.atMs);

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    const dense = summary.windows[0]?.dense;
    if (dense === undefined) throw new Error('nonvisual-tail fixture lost its dense update');
    expect(dense.lastDisplaySeq).toBe(3);
    expect(dense.stateReadyAtMs).toBe(1_007.2);
    expect(dense.nonvisualAppliedDisplayUnitCount).toBe(1);
    expect(directNeovimFinalRenderedSegment(dense)).toMatchObject({
      lastDisplaySeq: 2,
      stateReadyAtMs: 1_005.3,
      commitEndSeen: false,
      commitReason: 'deadline-timer',
    });
    expect(summary.distributions.denseStateReadyToRenderStartMs.p50).toBeGreaterThanOrEqual(0);
  });

  test('rejects missing, duplicate, foreign, and contradicted split-segment ownership', () => {
    const missingMember = neovimFixture('two-credit');
    splitFirstDensePresentation(missingMember);
    missingMember.events = missingMember.events.filter(
      (event) =>
        !(
          event.kind === 'worker_display_applied' &&
          event.inputSeq === 1 &&
          event.displaySeq === 3
        ),
    );
    expect(() =>
      summarizeDirectNeovimTransactions(missingMember.events, missingMember.inputs),
    ).toThrow(/incomplete|canonical/);

    const missingCommit = neovimFixture('two-credit');
    splitFirstDensePresentation(missingCommit);
    missingCommit.events = missingCommit.events.filter(
      (event) => !(event.kind === 'presentation_commit' && event.transactionSeq === 1),
    );
    expect(() =>
      summarizeDirectNeovimTransactions(missingCommit.events, missingCommit.inputs),
    ).toThrow('not an exact visual partition commit');

    const duplicateCommit = neovimFixture('two-credit');
    splitFirstDensePresentation(duplicateCommit);
    const firstDenseCommit = duplicateCommit.events.find(
      (event): event is Extract<TerminalPerfEvent, { kind: 'presentation_commit' }> =>
        event.kind === 'presentation_commit' && event.transactionSeq === 1,
    );
    if (firstDenseCommit === undefined) throw new Error('split fixture lacks its first commit');
    duplicateCommit.events.push({ ...firstDenseCommit, atMs: firstDenseCommit.atMs + 0.01 });
    duplicateCommit.events.sort((left, right) => left.atMs - right.atMs);
    expect(() =>
      summarizeDirectNeovimTransactions(duplicateCommit.events, duplicateCommit.inputs),
    ).toThrow('duplicates presentation transaction identity');

    const foreignMember = neovimFixture('two-credit');
    splitFirstDensePresentation(foreignMember);
    foreignMember.events = foreignMember.events.map((event) =>
      event.kind === 'worker_display_applied' && event.inputSeq === 1 && event.displaySeq === 1
        ? { ...event, presentationTransactionSeq: 1 }
        : event,
    );
    expect(() =>
      summarizeDirectNeovimTransactions(foreignMember.events, foreignMember.inputs),
    ).toThrow('not an exact visual partition commit');

    const mismatchedCommit = neovimFixture('two-credit');
    splitFirstDensePresentation(mismatchedCommit);
    mismatchedCommit.events = mismatchedCommit.events.map((event) =>
      event.kind === 'presentation_commit' && event.transactionSeq === 1
        ? { ...event, lastDisplaySeq: 3 }
        : event,
    );
    expect(() =>
      summarizeDirectNeovimTransactions(mismatchedCommit.events, mismatchedCommit.inputs),
    ).toThrow('not an exact visual partition commit');

    const falseVisualMetadata = neovimFixture('two-credit');
    splitFirstDensePresentation(falseVisualMetadata);
    falseVisualMetadata.events = falseVisualMetadata.events.map((event) =>
      event.kind === 'worker_display_applied' && event.inputSeq === 1 && event.displaySeq === 3
        ? { ...event, authoritativeVisualMutation: false }
        : event,
    );
    expect(() =>
      summarizeDirectNeovimTransactions(falseVisualMetadata.events, falseVisualMetadata.inputs),
    ).toThrow('inconsistent visual ownership');
  });

  test('requires raw apply/start/end/commit/readiness order even when timestamps tie', () => {
    for (const reversed of ['apply-start', 'start-end', 'end-commit', 'commit-complete']) {
      const fixture = neovimFixture('two-credit');
      const belongsToShowcmd = (event: TerminalPerfEvent) =>
        (event.kind === 'worker_display_applied' && event.displaySeq === 1) ||
        ((event.kind === 'render_start' ||
          event.kind === 'render_end' ||
          event.kind === 'presentation_commit' ||
          event.kind === 'frame_complete') &&
          event.renderSeq === 1);
      fixture.events = fixture.events.map((event) =>
        belongsToShowcmd(event)
          ? {
              ...event,
              atMs: 1_003,
              ...(event.kind === 'render_start' ? { wantedAtMs: 1_003 } : {}),
            }
          : event,
      );
      fixture.events.sort((left, right) => left.atMs - right.atMs);
      // The dense command has not yet started at this tied showcmd completion.
      fixture.events = fixture.events.map((event) =>
        event.kind === 'frame_complete' && event.renderSeq === 1
          ? { ...event, completionDisposition: 'latest-submitted', previousPollAtMs: 0 }
          : event,
      );
      expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).not.toThrow();
      const orderedKinds = [
        'worker_display_applied',
        'render_start',
        'render_end',
        'presentation_commit',
        'frame_complete',
      ];
      const pair = ['apply-start', 'start-end', 'end-commit', 'commit-complete'].indexOf(reversed);
      const left = fixture.events.findIndex(
        (event) => belongsToShowcmd(event) && event.kind === orderedKinds[pair],
      );
      const right = fixture.events.findIndex(
        (event) => belongsToShowcmd(event) && event.kind === orderedKinds[pair + 1],
      );
      const leftEvent = fixture.events[left];
      const rightEvent = fixture.events[right];
      if (leftEvent === undefined || rightEvent === undefined)
        throw new Error('missing tied fixture pair');
      fixture.events[left] = rightEvent;
      fixture.events[right] = leftEvent;
      expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).toThrow(
        'no exact ordered',
      );
    }
  });

  test('rejects a supplemental presentation from another generation', () => {
    const fixture = neovimFixture('one-credit');
    appendLastSupplementalPresentation(fixture);
    fixture.events = fixture.events.map((event) =>
      (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
      event.presentationId === 201
        ? { ...event, generation: 2 }
        : event,
    );
    expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).toThrow(
      'unowned or non-successor',
    );
  });

  test('audits nonmember generation, serial placement and the next window tail', () => {
    const make = (inputSeq: number, displaySeq: number, presentationId: number, generation = 1) => {
      const fixture = neovimFixture('one-credit');
      const base = 1_000 + (inputSeq - 1) * 100;
      const fields = {
        atMs: base + 9,
        inputSeq,
        displaySeq,
        presentationId,
        predecessorId: 0,
        memberIndex: 0,
        memberCount: 0,
        rowCount: 0,
        byteLength: 76,
      };
      fixture.events.push(
        { ...received(fields), generation, presentationCoherent: false, presentationEnd: true },
        {
          ...applied({ ...fields, atMs: base + 10, transactionSeq: 0 }),
          generation,
          presentationCoherent: false,
          presentationEnd: true,
          authoritativeVisualMutation: false,
        },
      );
      fixture.events.sort((left, right) => left.atMs - right.atMs);
      return fixture;
    };
    const valid = make(100, 301, 201);
    expect(
      summarizeDirectNeovimTransactions(valid.events, valid.inputs).nonmemberDisplayUnitCount,
    ).toBe(1);
    const wrongPredecessor = make(100, 301, 201);
    wrongPredecessor.events = wrongPredecessor.events.map((event) =>
      (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
      event.presentationMemberCount === 0
        ? { ...event, rowPredecessorPresentationId: 200 }
        : event,
    );
    expect(() =>
      summarizeDirectNeovimTransactions(wrongPredecessor.events, wrongPredecessor.inputs),
    ).toThrow('not exactly owned');
    for (const invalid of [make(100, 301, 201, 2), make(100, 301, 199), make(1, 301, 201)]) {
      expect(() => summarizeDirectNeovimTransactions(invalid.events, invalid.inputs)).toThrow(
        /sender.*lineage/,
      );
    }
  });

  test('keeps the complete sender lineage ordered across positive-u32 wrap', () => {
    const fixture = neovimFixture('one-credit');
    const wrap = (value: number) =>
      value === 0 ? 0 : ((value - 1 + 0xffff_fffe) % 0xffff_ffff) + 1;
    fixture.events = fixture.events.map((event) => {
      if (event.kind === 'display_received' || event.kind === 'worker_display_applied') {
        return {
          ...event,
          displaySeq: wrap(event.displaySeq),
          presentationId: wrap(event.presentationId),
          rowPredecessorPresentationId: wrap(event.rowPredecessorPresentationId),
        };
      }
      if (event.kind === 'presentation_commit') {
        return {
          ...event,
          firstDisplaySeq: wrap(event.firstDisplaySeq),
          lastDisplaySeq: wrap(event.lastDisplaySeq),
          firstPresentationId: wrap(event.firstPresentationId),
          lastPresentationId: wrap(event.lastPresentationId),
        };
      }
      return event;
    });
    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    expect(summary.windows[0]?.showcmd.presentationId).toBe(0xffff_ffff);
    expect(summary.windows[0]?.dense.presentationId).toBe(1);
    expect(summary.renderedTransactionCount).toBe(200);
  });

  test('rejects incomplete reordered membership and fabricated obsolete evidence', () => {
    const missingReceive = neovimFixture('two-credit');
    makeFirstShowcmdObsolete(missingReceive);
    missingReceive.events = missingReceive.events.filter(
      (event) => !(event.kind === 'display_received' && event.displaySeq === 1),
    );
    expect(() =>
      summarizeDirectNeovimTransactions(missingReceive.events, missingReceive.inputs),
    ).toThrow('lacks one exact receive');

    const visualButUnowned = neovimFixture('two-credit');
    makeFirstShowcmdObsolete(visualButUnowned);
    visualButUnowned.events = visualButUnowned.events.map((event) =>
      event.kind === 'worker_display_applied' && event.displaySeq === 1
        ? {
            ...event,
            authoritativeVisualMutation: true,
            presentationTransactionSeq: 999,
          }
        : event,
    );
    expect(() =>
      summarizeDirectNeovimTransactions(visualButUnowned.events, visualButUnowned.inputs),
    ).toThrow('not an exact visual partition commit');

    const fabricatedNonvisual = neovimFixture('two-credit');
    makeFirstShowcmdObsolete(fabricatedNonvisual);
    fabricatedNonvisual.events = fabricatedNonvisual.events.map((event) =>
      (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
      event.displaySeq === 1
        ? {
            ...event,
            atMs: event.kind === 'display_received' ? 1_005.2 : 1_005.3,
          }
        : event,
    );
    fabricatedNonvisual.events.sort((left, right) => left.atMs - right.atMs);
    expect(() =>
      summarizeDirectNeovimTransactions(fabricatedNonvisual.events, fabricatedNonvisual.inputs),
    ).toThrow('lacks exact dense-before-showcmd-receipt nonvisual evidence');
  });

  test('joins a dense visual commit to its complete sender membership, including nonvisual members', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) => {
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.displaySeq === 2
      ) {
        return {
          ...event,
          rowCount: 1,
          ...(event.kind === 'worker_display_applied'
            ? { authoritativeVisualMutation: false, presentationTransactionSeq: 0 }
            : {}),
        };
      }
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.displaySeq === 3
      ) {
        return { ...event, rowCount: 24 };
      }
      if (event.kind === 'presentation_commit' && event.firstPresentationId === 2) {
        return {
          ...event,
          firstDisplaySeq: 3,
          datagramCount: 1,
          rowCount: 24,
          byteLength: 130,
        };
      }
      return event;
    });

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    expect(summary.windows[0]?.dense.senderAppliedDisplayUnitCount).toBe(2);
    expect(summary.windows[0]?.dense.visualAppliedDisplayUnitCount).toBe(1);
    expect(summary.windows[0]?.dense.nonvisualAppliedDisplayUnitCount).toBe(1);
    expect(summary.windows[0]?.dense.senderRowCount).toBe(25);
    expect(summary.windows[0]?.dense.visualRowCount).toBe(24);
  });

  test('retains complete successor-linked nonvisual presentations and rejects fabricated visual ownership', () => {
    const fixture = neovimFixture('one-credit');
    appendLastSupplementalPresentation(fixture);

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    expect(summary.supplementalNonvisualPresentationCount).toBe(1);
    expect(summary.windows[99]?.supplementalNonvisualPresentations).toHaveLength(1);
    expect(summary.windows[99]?.supplementalNonvisualPresentations[0]).toMatchObject({
      outcome: 'supplemental-nonvisual',
      presentationId: 201,
      rowPredecessorPresentationId: 200,
      senderAppliedDisplayUnitCount: 2,
      visualAppliedDisplayUnitCount: 0,
    });

    const fabricatedVisual = neovimFixture('one-credit');
    appendLastSupplementalPresentation(fabricatedVisual);
    fabricatedVisual.events = fabricatedVisual.events.map((event) =>
      event.kind === 'worker_display_applied' && event.displaySeq === 301
        ? {
            ...event,
            authoritativeVisualMutation: true,
            presentationTransactionSeq: 999,
          }
        : event,
    );
    expect(() =>
      summarizeDirectNeovimTransactions(fabricatedVisual.events, fabricatedVisual.inputs),
    ).toThrow('unowned or non-successor supplemental presentation');

    const brokenLineage = neovimFixture('one-credit');
    appendLastSupplementalPresentation(brokenLineage);
    brokenLineage.events = brokenLineage.events.map((event) =>
      (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
      event.presentationId === 201
        ? { ...event, rowPredecessorPresentationId: 999 }
        : event,
    );
    expect(() =>
      summarizeDirectNeovimTransactions(brokenLineage.events, brokenLineage.inputs),
    ).toThrow('not linked to the canonical dense lineage');
  });

  test('rejects command readiness that completes outside renderer FIFO order', () => {
    const fixture = neovimFixture('two-credit');
    const showcmdCompletionIndex = fixture.events.findIndex(
      (event) => event.kind === 'frame_complete' && event.renderSeq === 1,
    );
    if (showcmdCompletionIndex < 0) throw new Error('fixture lacks the first showcmd completion');
    const [showcmdCompletion] = fixture.events.splice(showcmdCompletionIndex, 1);
    if (showcmdCompletion?.kind !== 'frame_complete') {
      throw new Error('fixture showcmd completion disappeared');
    }
    const denseCompletionIndex = fixture.events.findIndex(
      (event) => event.kind === 'frame_complete' && event.renderSeq === 2,
    );
    if (denseCompletionIndex < 0) throw new Error('fixture lacks the first dense completion');
    fixture.events.splice(denseCompletionIndex + 1, 0, {
      ...showcmdCompletion,
      atMs: 1_008,
    });

    expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).toThrow(
      'completed outside FIFO order',
    );
  });

  test('uses raw commit order when both application commits share a clock tick', () => {
    const fixture = neovimFixture('two-credit');
    fixture.events = fixture.events.map((event) => {
      if (
        (event.kind === 'render_end' || event.kind === 'presentation_commit') &&
        (event.renderSeq === 1 || event.renderSeq === 2)
      ) {
        return { ...event, atMs: 1_005.5 };
      }
      return event;
    });

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    const firstShowcmd = summary.windows[0]?.showcmd;
    if (firstShowcmd?.outcome !== 'rendered') throw new Error('fixture showcmd was not rendered');
    const firstDense = summary.windows[0]?.dense;
    if (firstDense === undefined) throw new Error('fixture dense update is missing');
    const showcmdSegment = directNeovimFinalRenderedSegment(firstShowcmd);
    const denseSegment = directNeovimFinalRenderedSegment(firstDense);
    expect(showcmdSegment.commitAtMs).toBe(1_005.5);
    expect(denseSegment.commitAtMs).toBe(1_005.5);
    expect(showcmdSegment.commitTraceOrdinal < denseSegment.commitTraceOrdinal).toBe(true);
  });

  test('retains signed receive/apply spans under clean datagram reordering', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) => {
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.presentationId % 2 === 0
      ) {
        return { ...event, atMs: event.atMs - 4 };
      }
      return event;
    });

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    expect(summary.distributions.showcmdToDenseFirstReceiveMs.p50).toBeLessThan(0);
    expect(summary.distributions.showcmdToDenseStateReadyMs.p50).toBeLessThan(0);
  });

  test('retains invalidated command readiness for the steady-workload gate to reject', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) =>
      event.kind === 'frame_complete' && event.renderSeq === 1
        ? { ...event, completionDisposition: 'invalidated' }
        : event,
    );

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    expect(summary.showcmdCompletionDispositionCounts.invalidated).toBe(1);
    const firstShowcmd = summary.windows[0]?.showcmd;
    if (firstShowcmd?.outcome !== 'rendered') throw new Error('fixture showcmd was not rendered');
    expect(directNeovimFinalRenderedSegment(firstShowcmd).completionDisposition).toBe(
      'invalidated',
    );
    expect(validateDirectNeovimSteadyTransactions(summary)).toEqual([
      'steady Neovim phase recorded 1 semantically invalidated completions',
    ]);
  });

  test('requires every terminal dense completion to clear semantic publication debt', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) =>
      event.kind === 'frame_complete' && event.renderSeq === 2
        ? { ...event, completionDisposition: 'invalidated' }
        : event,
    );

    const summary = summarizeDirectNeovimTransactions(fixture.events, fixture.inputs);
    expect(summary.renderReadinessCensus.terminalLatestSubmittedWindowCount).toBe(99);
    expect(validateDirectNeovimSteadyTransactions(summary)).toEqual([
      'steady Neovim phase recorded 1 semantically invalidated completions',
      'steady Neovim phase cleared publication debt in 99/100 terminal dense completions',
    ]);
  });

  test('rejects a disposition contradicted by exact submission order', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) =>
      event.kind === 'frame_complete' && event.renderSeq === 1
        ? { ...event, completionDisposition: 'superseded' }
        : event,
    );

    expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).toThrow(
      'completion disposition disagrees',
    );
  });

  test('rejects a stale next-window presentation epoch even when generation is unchanged', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) =>
      event.kind === 'presentation_commit' && event.displayInputSeq === 2 && event.rowCount === 1
        ? { ...event, transactionSeq: 0x8000_0002 }
        : event,
    );

    expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).toThrow(
      'not an exact visual partition commit',
    );
  });

  test('rejects a fence-bearing dense page without its exact completed render owner', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) =>
      event.kind === 'render_start' && event.renderSeq === 2
        ? { ...event, fenceReleasedRenderSeq: 999 }
        : event,
    );

    expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).toThrow(
      'no exact completed renderer owner',
    );
  });

  test('rejects a one-row substitute for the dense redraw', () => {
    const fixture = neovimFixture('one-credit');
    fixture.events = fixture.events.map((event) => {
      if (
        (event.kind === 'display_received' || event.kind === 'worker_display_applied') &&
        event.presentationId === 2
      ) {
        return { ...event, rowCount: event.presentationMemberIndex === 0 ? 1 : 0 };
      }
      if (event.kind === 'presentation_commit' && event.firstPresentationId === 2) {
        return { ...event, rowCount: 1 };
      }
      return event;
    });

    expect(() => summarizeDirectNeovimTransactions(fixture.events, fixture.inputs)).toThrow(
      'dense update has 1 visual/1 sender rows',
    );
  });

  test('rejects missing receive membership and a third visual transaction', () => {
    const missingReceive = neovimFixture('one-credit');
    missingReceive.events = missingReceive.events.filter(
      (event) => !(event.kind === 'display_received' && event.displaySeq === 2),
    );
    expect(() =>
      summarizeDirectNeovimTransactions(missingReceive.events, missingReceive.inputs),
    ).toThrow('lacks one exact receive');

    const thirdTransaction = neovimFixture('one-credit');
    const firstCommit = thirdTransaction.events.find(
      (event): event is Extract<TerminalPerfEvent, { kind: 'presentation_commit' }> =>
        event.kind === 'presentation_commit',
    );
    if (firstCommit === undefined) throw new Error('fixture lacks a presentation commit');
    thirdTransaction.events.push({
      ...firstCommit,
      atMs: firstCommit.atMs + 0.1,
      transactionSeq: 999,
      renderSeq: 999,
      firstPresentationId: 999,
      lastPresentationId: 999,
    });
    expect(() =>
      summarizeDirectNeovimTransactions(thirdTransaction.events, thirdTransaction.inputs),
    ).toThrow('missing or unrelated renderer evidence');
  });
});

type FixtureMode = 'one-credit' | 'two-credit';

function neovimFixture(mode: FixtureMode): {
  events: TerminalPerfEvent[];
  inputs: DirectCoherentInputPopulation;
} {
  const events: TerminalPerfEvent[] = [];
  const windows: DirectCoherentInputPopulation['windows'][number][] = [];
  for (let ordinal = 0; ordinal < DIRECT_NEOVIM_TRANSACTION_WINDOW_COUNT; ordinal += 1) {
    const base = 1_000 + ordinal * 100;
    const inputSeq = ordinal + 1;
    const showcmdPresentationId = ordinal * 2 + 1;
    const densePresentationId = showcmdPresentationId + 1;
    const showcmdRenderSeq = ordinal * 2 + 1;
    const denseRenderSeq = showcmdRenderSeq + 1;
    const showcmdDisplaySeq = ordinal * 3 + 1;
    const denseFirstDisplaySeq = showcmdDisplaySeq + 1;
    const denseSecondDisplaySeq = showcmdDisplaySeq + 2;
    const previousDensePresentationId = ordinal === 0 ? 0 : showcmdPresentationId - 1;
    const windowStartAtMs = base;
    const windowEndAtMs = base + 20;
    windows.push({
      measurementId: ordinal + 1,
      startAtMs: windowStartAtMs,
      endAtMs: windowEndAtMs,
      inputSeq,
    });
    events.push(input(inputSeq, base + 1));
    events.push(
      received({
        atMs: base + 2,
        displaySeq: showcmdDisplaySeq,
        inputSeq,
        presentationId: showcmdPresentationId,
        predecessorId: previousDensePresentationId,
        memberIndex: 0,
        memberCount: 1,
        rowCount: 1,
        byteLength: 100,
      }),
      applied({
        atMs: base + 3,
        displaySeq: showcmdDisplaySeq,
        inputSeq,
        presentationId: showcmdPresentationId,
        predecessorId: previousDensePresentationId,
        transactionSeq: showcmdPresentationId,
        memberIndex: 0,
        memberCount: 1,
        rowCount: 1,
        byteLength: 100,
      }),
      renderStart({
        atMs: base + 4,
        wantedAtMs: base + 3,
        inputSeq,
        renderSeq: showcmdRenderSeq,
        gate: 'immediate',
      }),
      renderEnd(base + 5, inputSeq, showcmdRenderSeq),
      commit({
        atMs: base + 5,
        inputSeq,
        transactionSeq: showcmdPresentationId,
        renderSeq: showcmdRenderSeq,
        presentationId: showcmdPresentationId,
        firstDisplaySeq: showcmdDisplaySeq,
        lastDisplaySeq: showcmdDisplaySeq,
        datagramCount: 1,
        rowCount: 1,
        byteLength: 100,
      }),
      received({
        atMs: base + 5.1,
        displaySeq: denseFirstDisplaySeq,
        inputSeq,
        presentationId: densePresentationId,
        predecessorId: showcmdPresentationId,
        memberIndex: 0,
        memberCount: 2,
        rowCount: 12,
        byteLength: 120,
      }),
      received({
        atMs: base + 5.2,
        displaySeq: denseSecondDisplaySeq,
        inputSeq,
        presentationId: densePresentationId,
        predecessorId: showcmdPresentationId,
        memberIndex: 1,
        memberCount: 2,
        rowCount: 13,
        byteLength: 130,
      }),
      applied({
        atMs: base + 5.3,
        displaySeq: denseFirstDisplaySeq,
        inputSeq,
        presentationId: densePresentationId,
        predecessorId: showcmdPresentationId,
        transactionSeq: densePresentationId,
        memberIndex: 0,
        memberCount: 2,
        rowCount: 12,
        byteLength: 120,
      }),
      applied({
        atMs: base + 5.4,
        displaySeq: denseSecondDisplaySeq,
        inputSeq,
        presentationId: densePresentationId,
        predecessorId: showcmdPresentationId,
        transactionSeq: densePresentationId,
        memberIndex: 1,
        memberCount: 2,
        rowCount: 13,
        byteLength: 130,
      }),
    );
    if (mode === 'two-credit') {
      events.push(
        renderStart({
          atMs: base + 5.5,
          wantedAtMs: base + 5.4,
          inputSeq,
          renderSeq: denseRenderSeq,
          gate: 'immediate',
        }),
        frameComplete(base + 6, inputSeq, showcmdRenderSeq, 'superseded'),
      );
    } else {
      events.push(
        frameComplete(base + 6, inputSeq, showcmdRenderSeq, 'latest-submitted'),
        renderStart({
          atMs: base + 6,
          wantedAtMs: base + 5.4,
          inputSeq,
          renderSeq: denseRenderSeq,
          gate: 'fence',
          fenceReleasedAtMs: base + 6,
          fenceReleasedRenderSeq: showcmdRenderSeq,
        }),
      );
    }
    events.push(
      renderEnd(base + 7, inputSeq, denseRenderSeq),
      commit({
        atMs: base + 7,
        inputSeq,
        transactionSeq: densePresentationId,
        renderSeq: denseRenderSeq,
        presentationId: densePresentationId,
        firstDisplaySeq: denseFirstDisplaySeq,
        lastDisplaySeq: denseSecondDisplaySeq,
        datagramCount: 2,
        rowCount: 25,
        byteLength: 250,
      }),
      frameComplete(base + 8, inputSeq, denseRenderSeq, 'latest-submitted'),
    );
  }
  events.sort((left, right) => left.atMs - right.atMs);
  return {
    events,
    inputs: {
      windowCount: windows.length,
      inputCount: windows.length,
      inputBytesPerWindow: 1,
      windows,
    },
  };
}

function makeFirstShowcmdObsolete(fixture: { events: TerminalPerfEvent[] }): void {
  fixture.events = fixture.events.flatMap((event): TerminalPerfEvent[] => {
    if (
      (event.kind === 'render_start' ||
        event.kind === 'render_end' ||
        event.kind === 'frame_complete') &&
      event.renderSeq === 1
    ) {
      return [];
    }
    if (
      event.kind === 'presentation_commit' &&
      event.firstPresentationId === 1 &&
      event.displayInputSeq === 1
    ) {
      return [];
    }
    if (event.kind === 'display_received' && event.displaySeq === 1) {
      return [{ ...event, atMs: 1_007.5 }];
    }
    if (event.kind === 'worker_display_applied' && event.displaySeq === 1) {
      return [
        {
          ...event,
          atMs: 1_007.6,
          authoritativeVisualMutation: false,
          presentationTransactionSeq: 0,
        },
      ];
    }
    return [event];
  });
  fixture.events.sort((left, right) => left.atMs - right.atMs);
}

function splitFirstDensePresentation(
  fixture: { events: TerminalPerfEvent[] },
  reverseDenseMemberArrival = false,
): void {
  const shifted = fixture.events.flatMap((event): TerminalPerfEvent[] => {
    if (event.kind === 'input_queued') return [event];
    if (event.kind === 'display_received' || event.kind === 'worker_display_applied') {
      if (event.inputSeq === 1) return [];
      if (event.kind === 'worker_display_applied' && event.presentationTransactionSeq > 0) {
        return [
          {
            ...event,
            presentationTransactionSeq: event.presentationTransactionSeq + 1,
          },
        ];
      }
      return [event];
    }
    if (
      event.kind !== 'presentation_commit' &&
      event.kind !== 'render_start' &&
      event.kind !== 'render_end' &&
      event.kind !== 'frame_complete'
    ) {
      return [event];
    }
    if (event.displayInputSeq === 1) return [];
    if (event.kind === 'presentation_commit') {
      return [
        { ...event, transactionSeq: event.transactionSeq + 1, renderSeq: event.renderSeq + 1 },
      ];
    }
    if (event.kind === 'render_start') {
      return [
        {
          ...event,
          renderSeq: event.renderSeq + 1,
          fenceReleasedRenderSeq:
            event.fenceReleasedRenderSeq === 0 ? 0 : event.fenceReleasedRenderSeq + 1,
        },
      ];
    }
    return [{ ...event, renderSeq: event.renderSeq + 1 }];
  });

  const earlyDisplaySeq = reverseDenseMemberArrival ? 3 : 2;
  const finalDisplaySeq = reverseDenseMemberArrival ? 2 : 3;
  const earlyMemberIndex = reverseDenseMemberArrival ? 1 : 0;
  const finalMemberIndex = reverseDenseMemberArrival ? 0 : 1;
  const denseFields = (displaySeq: number, memberIndex: number, atMs: number) => ({
    atMs,
    displaySeq,
    inputSeq: 1,
    presentationId: 2,
    predecessorId: 1,
    memberIndex,
    memberCount: 2,
    rowCount: memberIndex === 0 ? 12 : 13,
    byteLength: memberIndex === 0 ? 120 : 130,
  });
  const early = denseFields(earlyDisplaySeq, earlyMemberIndex, 1_002);
  const final = denseFields(finalDisplaySeq, finalMemberIndex, 1_003.4);
  const showcmd = {
    atMs: 1_003,
    displaySeq: 1,
    inputSeq: 1,
    presentationId: 1,
    predecessorId: 0,
    memberIndex: 0,
    memberCount: 1,
    rowCount: 1,
    byteLength: 100,
  } as const;
  shifted.push(
    received(early),
    applied({ ...early, atMs: 1_002.1, transactionSeq: 1 }),
    renderStart({
      atMs: 1_002.2,
      wantedAtMs: 1_002.1,
      inputSeq: 1,
      renderSeq: 1,
      gate: 'immediate',
    }),
    renderEnd(1_002.3, 1, 1),
    commit({
      atMs: 1_002.3,
      inputSeq: 1,
      transactionSeq: 1,
      renderSeq: 1,
      presentationId: 2,
      firstDisplaySeq: earlyDisplaySeq,
      lastDisplaySeq: earlyDisplaySeq,
      datagramCount: 1,
      rowCount: early.rowCount,
      byteLength: early.byteLength,
      endSeen: earlyMemberIndex === 1,
      reason: 'deadline-timer',
    }),
    frameComplete(1_002.9, 1, 1, 'latest-submitted'),
    received(showcmd),
    applied({ ...showcmd, atMs: 1_003.1, transactionSeq: 2 }),
    renderStart({
      atMs: 1_003.2,
      wantedAtMs: 1_003.1,
      inputSeq: 1,
      renderSeq: 2,
      gate: 'immediate',
    }),
    renderEnd(1_003.3, 1, 2),
    commit({
      atMs: 1_003.3,
      inputSeq: 1,
      transactionSeq: 2,
      renderSeq: 2,
      presentationId: 1,
      firstDisplaySeq: 1,
      lastDisplaySeq: 1,
      datagramCount: 1,
      rowCount: 1,
      byteLength: 100,
    }),
    received(final),
    applied({ ...final, atMs: 1_003.5, transactionSeq: 3 }),
    renderStart({
      atMs: 1_003.6,
      wantedAtMs: 1_003.5,
      inputSeq: 1,
      renderSeq: 3,
      gate: 'immediate',
    }),
    frameComplete(1_003.9, 1, 2, 'superseded'),
    renderEnd(1_004, 1, 3),
    commit({
      atMs: 1_004,
      inputSeq: 1,
      transactionSeq: 3,
      renderSeq: 3,
      presentationId: 2,
      firstDisplaySeq: finalDisplaySeq,
      lastDisplaySeq: finalDisplaySeq,
      datagramCount: 1,
      rowCount: final.rowCount,
      byteLength: final.byteLength,
    }),
    frameComplete(1_004.6, 1, 3, 'latest-submitted'),
  );
  fixture.events = shifted.sort((left, right) => left.atMs - right.atMs);
}

function appendLastSupplementalPresentation(fixture: { events: TerminalPerfEvent[] }): void {
  const first = {
    atMs: 10_909,
    displaySeq: 301,
    inputSeq: 100,
    presentationId: 201,
    predecessorId: 200,
    memberIndex: 0,
    memberCount: 2,
    rowCount: 24,
    byteLength: 120,
  } as const;
  const second = {
    ...first,
    atMs: 10_909.2,
    displaySeq: 302,
    memberIndex: 1,
    byteLength: 130,
  } as const;
  fixture.events.push(
    received(first),
    {
      ...applied({ ...first, atMs: 10_909.1, transactionSeq: 201 }),
      authoritativeVisualMutation: false,
      presentationTransactionSeq: 0,
    },
    received(second),
    {
      ...applied({ ...second, atMs: 10_909.3, transactionSeq: 201 }),
      authoritativeVisualMutation: false,
      presentationTransactionSeq: 0,
    },
  );
  fixture.events.sort((left, right) => left.atMs - right.atMs);
}

function input(
  inputSeq: number,
  atMs: number,
): Extract<TerminalPerfEvent, { kind: 'input_queued' }> {
  return { kind: 'input_queued', atMs, admittedAtMs: atMs + 0.01, inputSeq, byteLength: 1 };
}

interface DisplayFixture {
  readonly atMs: number;
  readonly displaySeq: number;
  readonly inputSeq: number;
  readonly presentationId: number;
  readonly predecessorId: number;
  readonly memberIndex: number;
  readonly memberCount: number;
  readonly rowCount: number;
  readonly byteLength: number;
}

function received(value: DisplayFixture): Extract<TerminalPerfEvent, { kind: 'display_received' }> {
  return {
    kind: 'display_received',
    atMs: value.atMs,
    displaySeq: value.displaySeq,
    generation: 1,
    inputSeq: value.inputSeq,
    frameId: value.displaySeq,
    chunkIndex: 0,
    chunkCount: 1,
    presentationId: value.presentationId,
    presentationMemberIndex: value.memberIndex,
    presentationMemberCount: value.memberCount,
    rowPredecessorPresentationId: value.predecessorId,
    presentationTransactionSeq: 0,
    presentationCoherent: true,
    presentationEnd: value.memberIndex === value.memberCount - 1,
    fecRecovered: false,
    authoritativeVisualMutation: null,
    workerReceiptToDecodeMs: 0.1,
    decodeToApplyMs: null,
    byteLength: value.byteLength,
    rowCount: value.rowCount,
    displayKind: 'display_delta',
  };
}

function applied(
  value: DisplayFixture & { readonly transactionSeq: number },
): Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }> {
  return {
    ...received(value),
    kind: 'worker_display_applied',
    presentationTransactionSeq: value.transactionSeq,
    authoritativeVisualMutation: true,
    workerReceiptToDecodeMs: null,
    decodeToApplyMs: 0.1,
  };
}

function commit(value: {
  readonly atMs: number;
  readonly inputSeq: number;
  readonly transactionSeq: number;
  readonly renderSeq: number;
  readonly presentationId: number;
  readonly firstDisplaySeq: number;
  readonly lastDisplaySeq: number;
  readonly datagramCount: number;
  readonly rowCount: number;
  readonly byteLength: number;
  readonly endSeen?: boolean;
  readonly reason?: Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>['reason'];
}): Extract<TerminalPerfEvent, { kind: 'presentation_commit' }> {
  return {
    kind: 'presentation_commit',
    atMs: value.atMs,
    releaseFrameTimeMs: 0,
    releaseFrameCount: 0,
    membershipReleaseDisableBits: 0,
    transactionSeq: value.transactionSeq,
    renderSeq: value.renderSeq,
    generation: 1,
    firstDisplaySeq: value.firstDisplaySeq,
    lastDisplaySeq: value.lastDisplaySeq,
    displayInputSeq: value.inputSeq,
    displayEchoHorizonSeq: value.inputSeq,
    firstPresentationId: value.presentationId,
    lastPresentationId: value.presentationId,
    firstApplyToCommitMs: 1,
    lastApplyToCommitMs: 1,
    deadlineOverrunMs: 0,
    refreshPeriodMs: 8.33,
    datagramCount: value.datagramCount,
    rowCount: value.rowCount,
    byteLength: value.byteLength,
    queueHighWater: value.datagramCount,
    coherent: true,
    endSeen: value.endSeen ?? true,
    authoritativeVisualChange: true,
    reason: value.reason ?? 'membership-complete',
  };
}

function renderStart(value: {
  readonly atMs: number;
  readonly wantedAtMs: number;
  readonly inputSeq: number;
  readonly renderSeq: number;
  readonly gate: Extract<TerminalPerfEvent, { kind: 'render_start' }>['gate'];
  readonly fenceReleasedAtMs?: number;
  readonly fenceReleasedRenderSeq?: number;
}): Extract<TerminalPerfEvent, { kind: 'render_start' }> {
  return {
    kind: 'render_start',
    atMs: value.atMs,
    renderSeq: value.renderSeq,
    displayInputSeq: value.inputSeq,
    predictionInputSeq: 0,
    queuedDisplayFrames: 1,
    wantedAtMs: value.wantedAtMs,
    gate: value.gate,
    fenceReleasedAtMs: value.fenceReleasedAtMs ?? 0,
    fenceReleasedRenderSeq: value.fenceReleasedRenderSeq ?? 0,
    opportunityEnteredAtMs: 0,
    opportunityDelayMs: 0,
    fenceWaitMs: 0,
    opportunityWaitMs: 0,
    refreshPeriodMs: 8.33,
    refreshConfidence01: 1,
  };
}

function renderEnd(
  atMs: number,
  inputSeq: number,
  renderSeq: number,
): Extract<TerminalPerfEvent, { kind: 'render_end' }> {
  return {
    kind: 'render_end',
    atMs,
    renderSeq,
    displayInputSeq: inputSeq,
    predictionInputSeq: 0,
    queuedDisplayFrames: 1,
    visiblePredictionInputSeqs: [],
    visiblePredictionInputSeqsTruncated: false,
    completionMode: 'gpu-queue',
    atlasUploaded: false,
    drainedDisplay: false,
  };
}

function frameComplete(
  atMs: number,
  inputSeq: number,
  renderSeq: number,
  completionDisposition: Extract<
    TerminalPerfEvent,
    { kind: 'frame_complete' }
  >['completionDisposition'],
): Extract<TerminalPerfEvent, { kind: 'frame_complete' }> {
  return {
    kind: 'frame_complete',
    atMs,
    renderSeq,
    displayInputSeq: inputSeq,
    predictionInputSeq: 0,
    queuedDisplayFrames: 1,
    visiblePredictionInputSeqs: [],
    visiblePredictionInputSeqsTruncated: false,
    completionDisposition,
    pollCount: 0,
    previousPollAtMs: 0,
  };
}
