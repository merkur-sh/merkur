import { describe, expect, test } from 'bun:test';

import { lineText } from '../../../../../src/blog/kit/lines';
import {
  describe as fate,
  type Group,
  openLink,
  outcome,
  send,
  tally,
  toggle,
} from './parity.model';
import {
  AFTER,
  BEFORE,
  bytesAway,
  formatBytes,
  formatSeconds,
  PANE_ROWS,
  replayRows,
  replaySeconds,
  screenSeconds,
  shownReplayMs,
} from './reconnect.model';
import { commit, enter, openSession, rowRanges, run, type as typed } from './rows.model';

describe('figure 1: what a reconnect sends', () => {
  test('the caption’s numbers are the model’s', () => {
    // 2.5 KB a second for two hours, over 2 Mbit/s with 180 ms round trips.
    expect(formatBytes(bytesAway(4))).toBe('18.4 MB');
    expect(formatSeconds(replaySeconds(4))).toBe('1 min 14 s');
    expect(formatSeconds(screenSeconds())).toBe('0.2 s');
    expect(formatBytes(4096)).toBe('4.1 KB');
  });

  test('after ten seconds the two are indistinguishable', () => {
    expect(replaySeconds(0) - screenSeconds()).toBeLessThan(0.1);
  });

  test('a replay is shown sped up, and never for long', () => {
    expect(shownReplayMs(0)).toBe(450);
    expect(shownReplayMs(4)).toBe(5000);
  });

  test('a replay scrolls the old screen away a line at a time', () => {
    expect(replayRows(0).map((row) => lineText(row.line))).toEqual(
      BEFORE.map((row) => lineText(row.line)),
    );
    const later = replayRows(40);
    expect(later).toHaveLength(PANE_ROWS);
    expect(later.every((row) => row.line.length > 0)).toBe(true);
    expect(AFTER).toHaveLength(PANE_ROWS);
  });
});

describe('figure 2: only the rows that changed', () => {
  test('a keystroke sends one row', () => {
    const session = typed(openSession(), 'l');
    expect(session.wire[0]).toEqual({ version: 'v4183', what: 'row 7' });
    expect(session.rowsSent).toBe(1);
    expect(session.flash).toEqual({ 6: 'sent' });
  });

  test('a keystroke that changes nothing sends nothing', () => {
    const session = typed(openSession(), '');
    expect(session.updates).toBe(0);
    expect(session.version).toBe(4182);
  });

  test('a command sends its output, and a scroll is one shift', () => {
    const typedOut = typed(openSession(), 'git status');
    const session = enter(typedOut);
    // Three lines of output and a new prompt from row 7: one row scrolls off the top.
    expect(session.wire[0]?.what).toBe('shift ↑1 + rows 7–10');
    expect(Object.values(session.flash).filter((part) => part === 'moved')).toHaveLength(6);
    expect(session.shell.cursor).toBe(9);
  });

  test('clear is one screen', () => {
    const { shell, scrolled } = run({ ...openSession().shell, input: 'clear' });
    expect(scrolled).toBe(0);
    expect(shell.cursor).toBe(0);
    const session = commit(openSession(), shell, scrolled);
    expect(session.wire[0]?.what).toBe('rows 1–7');
  });

  test('row numbers close up into ranges', () => {
    expect(rowRanges([0])).toBe('1');
    expect(rowRanges([0, 2, 3, 4, 8])).toBe('1, 3–5, 9');
    expect(rowRanges([])).toBe('');
  });
});

describe('figure 3: four packets and a parity shard', () => {
  const group = (...lost: number[]): Group => ({
    id: 1,
    lost: [0, 1, 2, 3, 4].map((index) => lost.includes(index)),
  });

  test('one lost packet is rebuilt; the parity shard alone needs nothing', () => {
    expect(outcome(group())).toBe('arrived');
    expect(outcome(group(2))).toBe('rebuilt');
    expect(fate(group(2))).toBe('packet 3 rebuilt on arrival');
    expect(outcome(group(4))).toBe('parity');
  });

  test('two lost fall to the next update', () => {
    expect(outcome(group(1, 3))).toBe('fallback');
    expect(fate(group(1, 4))).toBe('packets 2, P lost · next update covers it');
  });

  test('the link as it opens counts what it shows', () => {
    expect(tally(openLink(false))).toEqual({ groups: 6, rebuilt: 2, fallback: 1 });
  });

  test('a group crosses with each packet lost by chance', () => {
    const none = send(openLink(true), () => 1);
    expect(none.groups[0]).toEqual({ id: 1046, lost: [false, false, false, false, false] });
    expect(none.next).toBe(1047);
    const all = send({ ...openLink(true), loss: 30 }, () => 0);
    expect(outcome(all.groups[0] ?? group())).toBe('fallback');
  });

  test('losing a packet by hand stops the link', () => {
    const link = toggle(openLink(true), 1045, 0);
    expect(link.playing).toBe(false);
    expect(outcome(link.groups[0] ?? group())).toBe('rebuilt');
  });
});
