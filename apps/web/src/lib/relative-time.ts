/**
 * How a machine's last-seen instant reads in a device row.
 *
 * A device list is read at a glance, and an absolute timestamp is not: nobody
 * subtracts `8/12/2026, 3:04:11 PM` from now to decide whether the machine went
 * down a moment ago or a fortnight ago. Coarse and relative for anything recent
 * enough to act on, an absolute date once "how long ago" has stopped being the
 * question.
 *
 * Deliberately not `Intl.RelativeTimeFormat`: its output is a sentence
 * fragment tuned for prose ("3 minutes ago"), where a row wants the compact
 * form, and its wording varies with the host's locale data, which would make
 * these buckets untestable without pinning a locale the app never sets.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** Below this, "ago" is noise: the event is still happening as far as a reader is concerned. */
const JUST_NOW_MS = 45_000;

export function formatLastSeen(atMs: number, nowMs: number): string {
  const elapsedMs = nowMs - atMs;
  // A clock that stepped back, or a server slightly ahead of this browser,
  // must not render as a machine last seen in the future.
  if (elapsedMs < JUST_NOW_MS) return 'just now';
  if (elapsedMs < HOUR_MS) return `${Math.max(1, Math.round(elapsedMs / MINUTE_MS))} min ago`;
  if (elapsedMs < DAY_MS) return `${Math.max(1, Math.round(elapsedMs / HOUR_MS))} hr ago`;
  if (elapsedMs < WEEK_MS) {
    const days = Math.max(1, Math.round(elapsedMs / DAY_MS));
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  const at = new Date(atMs);
  return at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * The absolute instant, for the title of whatever renders {@link formatLastSeen}.
 * The compact form is what a row can carry; the exact one is a hover away.
 */
export function formatExactTime(atMs: number): string {
  return new Date(atMs).toLocaleString();
}

/**
 * The same instant as {@link formatLastSeen}, in the width a row's value column
 * can hold.
 *
 * The machine list gives every row one right-aligned mono figure, and a figure
 * that is sometimes "just now" and sometimes "yesterday" is not a column — it
 * is prose that happens to be right-aligned. One number and one unit, always,
 * so the digits line up and the eye can read down them.
 */
export function formatLastSeenCompact(atMs: number, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - atMs);
  if (elapsedMs < MINUTE_MS) return `${Math.max(1, Math.round(elapsedMs / 1000))} s`;
  if (elapsedMs < HOUR_MS) return `${Math.round(elapsedMs / MINUTE_MS)} m`;
  if (elapsedMs < DAY_MS) return `${Math.round(elapsedMs / HOUR_MS)} h`;
  if (elapsedMs < WEEK_MS) return `${Math.round(elapsedMs / DAY_MS)} d`;
  return `${Math.round(elapsedMs / WEEK_MS)} w`;
}
