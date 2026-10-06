/**
 * How many visible steps each keystroke's redraw took, from the browser's own
 * perf events joined with the daemon's native trace.
 *
 * The question a "the screen flickers when I move the cursor" report asks is
 * not whether the redraw arrived but whether it arrived *as one image*. A
 * keystroke whose redraw commits twice was seen twice: the first commit is the
 * partial state — old line numbers next to new, a cursor parked mid-repaint —
 * and the second is the repair. The census counts, per keystroke: the PTY
 * reads the application's output arrived in (native trace), the display
 * datagrams the daemon sent for it, the renderer commits those datagrams
 * produced and why each released, and how many sender presentation groups were
 * painted across more than one commit. None of this is a timing claim; it is a
 * count of exposures.
 */

interface CommitEvent {
  readonly kind: 'presentation_commit';
  readonly atMs: number;
  readonly generation: number;
  readonly displayInputSeq: number;
  readonly firstDisplaySeq: number;
  readonly lastDisplaySeq: number;
  readonly firstApplyToCommitMs: number;
  readonly datagramCount: number;
  readonly rowCount: number;
  readonly reason: string;
  readonly endSeen: boolean;
  readonly coherent: boolean;
}

interface AppliedEvent {
  readonly kind: 'worker_display_applied';
  readonly displaySeq: number;
  readonly generation: number;
  readonly inputSeq: number;
  readonly presentationId: number;
  readonly presentationMemberIndex: number;
  readonly presentationMemberCount: number;
  readonly presentationEnd: boolean;
  readonly rowCount: number;
}

interface QueuedInputEvent {
  readonly kind: 'input_queued';
  readonly atMs: number;
  readonly inputSeq: number;
}

export interface NativeRecordLike {
  readonly kind: string;
  readonly ordinal: number;
  readonly fields: readonly number[];
}

export interface KeystrokeRedrawCensus {
  readonly inputSeq: number;
  /** Renderer commits attributed to this keystroke's display input sequence. */
  readonly commits: number;
  readonly reasons: Readonly<Record<string, number>>;
  /** Milliseconds from each commit's first apply to its release. */
  readonly firstApplyToCommitMs: readonly number[];
  readonly datagrams: number;
  readonly headerOnlyDatagrams: number;
  readonly rows: number;
  /** Sender presentation groups (member count > 1) painted across several commits. */
  readonly splitGroups: number;
  /** PTY reads the application's output for this keystroke arrived in. */
  readonly ptyReads: number | null;
  readonly ptyBytes: number | null;
  /** Display datagrams the daemon sent between this keystroke's write and the next. */
  readonly nativeDatagrams: number | null;
}

export interface TuiRedrawCensus {
  readonly keystrokes: number;
  readonly perKeystroke: readonly KeystrokeRedrawCensus[];
  readonly totals: {
    readonly commits: number;
    readonly reasons: Readonly<Record<string, number>>;
    readonly keystrokesWithSeveralCommits: number;
    /**
     * Keystrokes painted in more images than the PTY reads their output
     * arrived in — the one count that is Merkur's to answer. An application
     * that writes twice may legitimately show twice; a single read shown as
     * two images is a tear. Counted only where the native trace joined.
     */
    readonly keystrokesWithMoreCommitsThanReads: number;
    readonly splitGroups: number;
    readonly datagrams: number;
    readonly headerOnlyDatagrams: number;
  };
  readonly commitsPerKeystroke: { readonly p50: number; readonly max: number };
  /** Keystrokes the native trace could not be joined to by input sequence. */
  readonly nativeUnjoined: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isCommit(value: unknown): value is CommitEvent {
  return (
    isRecord(value) &&
    value.kind === 'presentation_commit' &&
    typeof value.displayInputSeq === 'number' &&
    typeof value.firstDisplaySeq === 'number' &&
    typeof value.lastDisplaySeq === 'number' &&
    typeof value.reason === 'string'
  );
}

function isApplied(value: unknown): value is AppliedEvent {
  return (
    isRecord(value) &&
    value.kind === 'worker_display_applied' &&
    typeof value.displaySeq === 'number' &&
    typeof value.inputSeq === 'number' &&
    typeof value.presentationId === 'number'
  );
}

function isQueuedInput(value: unknown): value is QueuedInputEvent {
  return isRecord(value) && value.kind === 'input_queued' && typeof value.inputSeq === 'number';
}

function seqWithin(seq: number, first: number, last: number): boolean {
  // Display sequences are RFC-1982 serials; a measurement window is far
  // shorter than half the space, so plain arithmetic on the unsigned values is
  // exact here except across a wrap, which a window this short never spans.
  return seq >>> 0 >= first >>> 0 && seq >>> 0 <= last >>> 0;
}

function countReason(target: Record<string, number>, reason: string): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

/** Native-trace subset: PTY writes, reads and display members in ordinal order. */
function nativePerInputSeq(
  records: readonly NativeRecordLike[],
): Map<number, { reads: number; bytes: number; datagrams: number }> {
  const byInput = new Map<number, { reads: number; bytes: number; datagrams: number }>();
  const ordered = [...records].sort((a, b) => a.ordinal - b.ordinal);
  let current: { reads: number; bytes: number; datagrams: number } | null = null;
  for (const record of ordered) {
    const subkind = record.fields[0] ?? -1;
    if (record.kind === 'pty_enqueue' && subkind === 0 && record.fields[3] === 0) {
      const inputSeq = record.fields[2] ?? 0;
      current = { reads: 0, bytes: 0, datagrams: 0 };
      byInput.set(inputSeq, current);
      continue;
    }
    if (current === null) continue;
    if (record.kind === 'pty_read' && subkind === 1) {
      current.reads += 1;
      current.bytes += record.fields[2] ?? 0;
    } else if (record.kind === 'display_member') {
      current.datagrams += 1;
    }
  }
  return byInput;
}

export function summarizeTuiRedrawCensus(
  events: readonly unknown[],
  nativeRecords: readonly NativeRecordLike[] | null,
): TuiRedrawCensus {
  const commits = events.filter(isCommit);
  const applied = events.filter(isApplied);
  const inputs = events.filter(isQueuedInput).sort((a, b) => a.atMs - b.atMs);
  const native = nativeRecords === null ? null : nativePerInputSeq(nativeRecords);

  const totalReasons: Record<string, number> = {};
  let totalCommits = 0;
  let totalSplit = 0;
  let totalDatagrams = 0;
  let totalHeaderOnly = 0;
  let several = 0;
  let moreThanReads = 0;
  let nativeUnjoined = 0;
  const perKeystroke: KeystrokeRedrawCensus[] = [];
  const commitCounts: number[] = [];

  for (const input of inputs) {
    const seq = input.inputSeq;
    const own = commits.filter((commit) => commit.displayInputSeq === seq);
    const ownApplied = applied.filter((frame) => frame.inputSeq === seq);
    const reasons: Record<string, number> = {};
    for (const commit of own) {
      countReason(reasons, commit.reason);
      countReason(totalReasons, commit.reason);
    }
    // A sender group is split when its members were painted by more than one
    // commit. Members are located by the commit whose sequence range holds
    // them; ranges are disjoint, so each member belongs to at most one.
    const groups = new Map<string, Set<number>>();
    for (const frame of ownApplied) {
      if (frame.presentationMemberCount <= 1) continue;
      const key = `${frame.generation}:${frame.presentationId}`;
      const painters = groups.get(key) ?? new Set<number>();
      const painter = commits.findIndex(
        (commit) =>
          commit.generation === frame.generation &&
          seqWithin(frame.displaySeq, commit.firstDisplaySeq, commit.lastDisplaySeq),
      );
      painters.add(painter);
      groups.set(key, painters);
    }
    let split = 0;
    for (const painters of groups.values()) if (painters.size > 1) split += 1;
    const headerOnly = ownApplied.filter((frame) => frame.rowCount === 0).length;
    const rows = ownApplied.reduce((sum, frame) => sum + frame.rowCount, 0);
    const nativeEntry = native?.get(seq) ?? null;
    if (native !== null && nativeEntry === null) nativeUnjoined += 1;
    perKeystroke.push({
      inputSeq: seq,
      commits: own.length,
      reasons,
      firstApplyToCommitMs: own.map((commit) => commit.firstApplyToCommitMs),
      datagrams: ownApplied.length,
      headerOnlyDatagrams: headerOnly,
      rows,
      splitGroups: split,
      ptyReads: nativeEntry?.reads ?? null,
      ptyBytes: nativeEntry?.bytes ?? null,
      nativeDatagrams: nativeEntry?.datagrams ?? null,
    });
    commitCounts.push(own.length);
    totalCommits += own.length;
    totalSplit += split;
    totalDatagrams += ownApplied.length;
    totalHeaderOnly += headerOnly;
    if (own.length > 1) several += 1;
    if (nativeEntry !== null && own.length > Math.max(1, nativeEntry.reads)) moreThanReads += 1;
  }

  const sorted = [...commitCounts].sort((a, b) => a - b);
  const p50 = sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0);
  return {
    keystrokes: inputs.length,
    perKeystroke,
    totals: {
      commits: totalCommits,
      reasons: totalReasons,
      keystrokesWithSeveralCommits: several,
      keystrokesWithMoreCommitsThanReads: moreThanReads,
      splitGroups: totalSplit,
      datagrams: totalDatagrams,
      headerOnlyDatagrams: totalHeaderOnly,
    },
    commitsPerKeystroke: { p50, max: sorted.at(-1) ?? 0 },
    nativeUnjoined,
  };
}
