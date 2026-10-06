/**
 * Figure 1's arithmetic: what a byte stream replays after time away, against
 * one screen. Every number the caption states is here, so the two cannot
 * disagree.
 */
import { type Line, PROMPT, seg } from '../../../../../src/blog/kit/lines';

/** How long the lid was closed: the label and the seconds. */
export const AWAY = [
  ['10 s', 10],
  ['1 min', 60],
  ['10 min', 600],
  ['30 min', 1800],
  ['2 h', 7200],
] as const;

/** Bytes the suite prints a second. */
export const RATE = 2560;

/** The link, in bytes a second: 2 Mbit/s. */
export const LINK = 250_000;

/** A round trip, in seconds. */
export const RTT = 0.18;

/** One screen as Merkur sends it, in bytes. */
export const SCREEN = 4000;

/** The rows a terminal in the figure shows. */
export const PANE_ROWS = 10;

export interface Row {
  readonly line: Line;
  readonly caret: boolean;
}

const row = (line: Line, caret = false): Row => ({ line, caret });

const passed = (name: string): Row => row([seg(`test ${name} ... `), seg('ok', 'green')]);

const compiling = (name: string): Row => row([seg('   Compiling ', 'green'), seg(name)]);

const BLANK = row([]);

/** The screen when the lid closed. */
export const BEFORE: readonly Row[] = [
  row([...PROMPT, seg('cargo test --workspace')]),
  compiling('merkur-proto v0.9.2'),
  compiling('merkur-daemon v0.9.2'),
  compiling('merkur-web v0.9.2'),
  BLANK,
  BLANK,
  BLANK,
  BLANK,
  BLANK,
  BLANK,
];

/** What the suite printed while nobody watched; a replay scrolls through it again and again. */
const LOG: readonly Row[] = [
  compiling('merkur-cli v0.9.2'),
  row([seg('    Finished ', 'green'), seg('test profile in 38.2s')]),
  row([seg('     Running ', 'green'), seg('unittests src/lib.rs')]),
  passed('proto::diff::row_hash_is_stable'),
  passed('proto::diff::scroll_is_one_op'),
  passed('proto::fec::rebuilds_lost_shard'),
  passed('proto::fec::two_lost_falls_back'),
  passed('daemon::grid::scroll_region'),
  passed('daemon::grid::wide_glyphs'),
  passed('daemon::pty::resize_keeps_cursor'),
  passed('web::render::box_drawing'),
  passed('web::render::true_colour'),
  row([seg('     Running ', 'green'), seg('tests/reconnect.rs')]),
  passed('reconnect::after_sleep'),
  passed('reconnect::after_network_change'),
];

/** The screen as it is now. */
export const AFTER: readonly Row[] = [
  passed('daemon::pty::resize_keeps_cursor'),
  passed('web::render::box_drawing'),
  passed('web::render::true_colour'),
  passed('reconnect::after_sleep'),
  passed('reconnect::after_network_change'),
  BLANK,
  row([seg('test result: '), seg('ok', 'green'), seg('. 412 passed; 0 failed')]),
  BLANK,
  row([...PROMPT], true),
  BLANK,
];

export function bytesAway(away: number): number {
  return RATE * (AWAY[away]?.[1] ?? 0);
}

/** Seconds until the byte stream has replayed everything it buffered. */
export function replaySeconds(away: number): number {
  return RTT + bytesAway(away) / LINK;
}

/** Seconds until Merkur has sent the current screen. */
export function screenSeconds(): number {
  return RTT + SCREEN / LINK;
}

/** How long the figure takes to show a replay, in ms: sped up, and never long. */
export function shownReplayMs(away: number): number {
  return Math.min(5000, Math.max(450, replaySeconds(away) * 120));
}

/** How many lines a replay of that many bytes scrolls past. */
export function replayedLines(away: number): number {
  return Math.max(6, Math.min(600, Math.round(bytesAway(away) / 60)));
}

/** The byte stream's screen once `lines` of the replay have scrolled past. */
export function replayRows(lines: number): Row[] {
  const total = 4 + lines;
  const start = Math.max(0, total - PANE_ROWS);

  return Array.from({ length: PANE_ROWS }, (_, offset) => {
    const at = start + offset;

    if (at >= total) return BLANK;

    return (at < 4 ? BEFORE[at] : LOG[(at - 4) % LOG.length]) ?? BLANK;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;

  if (bytes < 1e5) return `${(bytes / 1e3).toFixed(1)} KB`;

  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;

  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;

  if (seconds < 60) return `${Math.round(seconds)} s`;

  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
