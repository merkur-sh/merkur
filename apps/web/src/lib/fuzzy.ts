/**
 * Subsequence scoring for the command palette.
 *
 * Small and hand-written on purpose: the palette ranks a list the size of the
 * machine count plus a fixed handful of actions, so a scorer that walks the
 * candidate once beats pulling in a matcher built for thousands of entries.
 *
 * Higher is better. `null` means the query is not a subsequence at all, which
 * is the only way an entry is filtered out — ranking never hides a match.
 */

const CONSECUTIVE_BONUS = 14;
const WORD_START_BONUS = 10;
const LEADING_BONUS = 16;
/** Each unmatched character before the first hit, up to a floor. */
const GAP_PENALTY = 1;
const MAX_GAP_PENALTY = 12;

function isWordBoundary(previous: string): boolean {
  return previous === ' ' || previous === '-' || previous === '_' || previous === '.';
}

export function fuzzyScore(haystack: string, needle: string): number | null {
  if (needle.length === 0) return 0;

  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();

  let score = 0;
  let textIndex = 0;
  let previousMatchIndex = -1;

  for (let queryIndex = 0; queryIndex < query.length; queryIndex += 1) {
    const wanted = query[queryIndex];
    const found = text.indexOf(wanted ?? '', textIndex);
    if (found < 0) return null;

    if (found === 0) {
      score += LEADING_BONUS;
    } else if (isWordBoundary(text[found - 1] ?? '')) {
      score += WORD_START_BONUS;
    }
    if (found === previousMatchIndex + 1) score += CONSECUTIVE_BONUS;

    const gap = previousMatchIndex < 0 ? found : found - previousMatchIndex - 1;
    score -= Math.min(gap * GAP_PENALTY, MAX_GAP_PENALTY);

    previousMatchIndex = found;
    textIndex = found + 1;
  }

  // A short candidate that used most of its characters is a better answer than
  // a long one that happened to contain the same letters.
  return score - Math.min(haystack.length - query.length, 20) / 4;
}
