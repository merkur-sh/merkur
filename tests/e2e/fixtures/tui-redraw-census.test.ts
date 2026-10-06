import { describe, expect, test } from 'bun:test';

import { summarizeTuiRedrawCensus } from './tui-redraw-census';

function commit(
  displayInputSeq: number,
  firstDisplaySeq: number,
  lastDisplaySeq: number,
  reason: string,
) {
  return {
    kind: 'presentation_commit',
    atMs: 1_000 + firstDisplaySeq,
    generation: 3,
    displayInputSeq,
    firstDisplaySeq,
    lastDisplaySeq,
    firstApplyToCommitMs: 4,
    datagramCount: lastDisplaySeq - firstDisplaySeq + 1,
    rowCount: 2,
    reason,
    endSeen: true,
    coherent: true,
  };
}

function applied(
  displaySeq: number,
  inputSeq: number,
  presentationId: number,
  memberIndex: number,
  memberCount: number,
  rowCount: number,
) {
  return {
    kind: 'worker_display_applied',
    displaySeq,
    generation: 3,
    inputSeq,
    presentationId,
    presentationMemberIndex: memberIndex,
    presentationMemberCount: memberCount,
    presentationEnd: memberIndex === memberCount - 1,
    rowCount,
  };
}

describe('summarizeTuiRedrawCensus', () => {
  test('counts commits, header-only datagrams and split groups per keystroke', () => {
    const events = [
      { kind: 'input_queued', atMs: 10, inputSeq: 7 },
      { kind: 'input_queued', atMs: 20, inputSeq: 8 },
      // Keystroke 7: one group of two members, painted by one commit.
      applied(100, 7, 50, 0, 2, 1),
      applied(101, 7, 50, 1, 2, 1),
      commit(7, 100, 101, 'group-end-vsync'),
      // Keystroke 8: a header-only frame, then a three-member group whose last
      // member arrived after the deadline release.
      applied(102, 8, 51, 0, 1, 0),
      applied(103, 8, 52, 0, 3, 4),
      applied(104, 8, 52, 1, 3, 4),
      commit(8, 102, 104, 'deadline-vsync'),
      applied(105, 8, 52, 2, 3, 4),
      commit(8, 105, 105, 'urgent'),
      // Keystroke 9: one PTY read, two single-member groups, two commits — the
      // one image more than the application's writes can explain.
      { kind: 'input_queued', atMs: 30, inputSeq: 9 },
      applied(106, 9, 53, 0, 1, 2),
      commit(9, 106, 106, 'group-end-vsync'),
      applied(107, 9, 54, 0, 1, 3),
      commit(9, 107, 107, 'group-end-vsync'),
    ];
    const native = [
      { kind: 'pty_enqueue', ordinal: 1, fields: [0, 1, 7, 0] },
      { kind: 'pty_read', ordinal: 2, fields: [1, 1, 30] },
      { kind: 'display_member', ordinal: 3, fields: [100] },
      { kind: 'display_member', ordinal: 4, fields: [101] },
      { kind: 'pty_enqueue', ordinal: 5, fields: [0, 2, 8, 0] },
      { kind: 'pty_read', ordinal: 6, fields: [1, 2, 900] },
      { kind: 'pty_read', ordinal: 7, fields: [1, 3, 400] },
      { kind: 'display_member', ordinal: 8, fields: [102] },
      { kind: 'display_member', ordinal: 9, fields: [103] },
      { kind: 'display_member', ordinal: 10, fields: [104] },
      { kind: 'display_member', ordinal: 11, fields: [105] },
      { kind: 'pty_enqueue', ordinal: 12, fields: [0, 3, 9, 0] },
      { kind: 'pty_read', ordinal: 13, fields: [1, 4, 500] },
      { kind: 'display_member', ordinal: 14, fields: [106] },
      { kind: 'display_member', ordinal: 15, fields: [107] },
    ];
    const census = summarizeTuiRedrawCensus(events, native);
    expect(census.keystrokes).toBe(3);
    expect(census.perKeystroke[0]).toEqual({
      inputSeq: 7,
      commits: 1,
      reasons: { 'group-end-vsync': 1 },
      firstApplyToCommitMs: [4],
      datagrams: 2,
      headerOnlyDatagrams: 0,
      rows: 2,
      splitGroups: 0,
      ptyReads: 1,
      ptyBytes: 30,
      nativeDatagrams: 2,
    });
    expect(census.perKeystroke[1]).toEqual({
      inputSeq: 8,
      commits: 2,
      reasons: { 'deadline-vsync': 1, urgent: 1 },
      firstApplyToCommitMs: [4, 4],
      datagrams: 4,
      headerOnlyDatagrams: 1,
      rows: 12,
      splitGroups: 1,
      ptyReads: 2,
      ptyBytes: 1_300,
      nativeDatagrams: 4,
    });
    expect(census.perKeystroke[2]).toMatchObject({
      inputSeq: 9,
      commits: 2,
      splitGroups: 0,
      ptyReads: 1,
      ptyBytes: 500,
    });
    expect(census.totals).toEqual({
      commits: 5,
      reasons: { 'group-end-vsync': 3, 'deadline-vsync': 1, urgent: 1 },
      keystrokesWithSeveralCommits: 2,
      keystrokesWithMoreCommitsThanReads: 1,
      splitGroups: 1,
      datagrams: 8,
      headerOnlyDatagrams: 1,
    });
    expect(census.commitsPerKeystroke).toEqual({ p50: 2, max: 2 });
    expect(census.nativeUnjoined).toBe(0);
  });

  test('reports keystrokes the native trace does not cover instead of inventing zeros', () => {
    const census = summarizeTuiRedrawCensus([{ kind: 'input_queued', atMs: 1, inputSeq: 3 }], []);
    expect(census.perKeystroke[0]?.ptyReads).toBeNull();
    expect(census.nativeUnjoined).toBe(1);
    expect(summarizeTuiRedrawCensus([], null).keystrokes).toBe(0);
  });
});
