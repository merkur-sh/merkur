/**
 * Input-stream error analysis for one line of typing: which erased taps were
 * mistakes, and what was meant in their place.
 *
 * Wobbrock and Myers, "Analyzing the input stream for character-level errors in
 * unconstrained text entry evaluations" (TOCHI 13(4), 2006), classifies every
 * keystroke of a transcription trial against the presented string P, including
 * the ones later erased. It recovers what a one-Backspace rule cannot: a
 * mistake noticed several letters late, and the correct letters erased on the
 * way back to it. Measured on the HOW-WE-TYPE-MOBILE logs, 62.5% of corrected
 * misses were noticed only after at least one more letter, and erased correct
 * letters outnumbered the misses themselves.
 *
 * A keyboard in ordinary use has no presented string, so the line the user
 * finished with stands in for it: whatever survived is what they meant. With
 * P = T the optimal alignment of the two is the identity, so the paper's
 * weighting across alternative alignments has nothing to weigh and every tap
 * gets exactly one class. On the same logs, taking the final text for the
 * presented sentence changed 13 of 1,189 substitution labels, all in sentences
 * left with an uncorrected error.
 *
 * The paper's assumptions carry over unchanged: text is entered serially,
 * Backspace deletes the previous symbol, and at most one symbol is inserted or
 * omitted in a row. Symbols are compared by identity only; the keyboard passes
 * key ids, so a slip on Shift is not a miss. `null` is a Backspace.
 */

/** Survived into the finished line. */
export const INPUT_STREAM_KEPT = 0;
/** Erased, although it is what the finished line holds at that position. */
export const INPUT_STREAM_ERASED_CORRECT = 1;
/** Erased, and a different symbol took its place: `intended`. */
export const INPUT_STREAM_SUBSTITUTION = 2;
/** Erased, and nothing took its place: an extra tap. */
export const INPUT_STREAM_INSERTION = 3;
/**
 * Erased, and it was the symbol after `intended`: the tap itself was right, but
 * came early and skipped `intended`.
 */
export const INPUT_STREAM_OMISSION = 4;

export type InputStreamClass =
  | typeof INPUT_STREAM_KEPT
  | typeof INPUT_STREAM_ERASED_CORRECT
  | typeof INPUT_STREAM_SUBSTITUTION
  | typeof INPUT_STREAM_INSERTION
  | typeof INPUT_STREAM_OMISSION;

/**
 * Called once per typed entry, in stream order; Backspaces are not visited.
 * `intended` is the symbol for a kept or correctly erased entry itself, the
 * replacement for a substitution, the skipped symbol for an omission, and null
 * for an insertion. `noticedAfter` is how many later symbols were still on the
 * line when the Backspace that erased this one came, so 0 is a mistake caught
 * at once; -1 for a kept entry.
 */
export type InputStreamVisitor = (
  index: number,
  kind: InputStreamClass,
  intended: string | null,
  noticedAfter: number,
) => void;

export interface InputStreamAnalyzer {
  /** Classifies `symbols[0, length)`, where `null` is a Backspace. */
  analyze(symbols: readonly (string | null)[], length: number, visit: InputStreamVisitor): void;
}

/**
 * Buffers grow to the longest line seen and are reused, so a line close
 * allocates nothing once warm.
 */
export function createInputStreamAnalyzer(): InputStreamAnalyzer {
  let flagged = new Uint8Array(64);
  let position = new Int32Array(64);
  let noticed = new Int32Array(64);
  let pending = new Int32Array(64);
  const transcribed: string[] = [];
  // The paper's M and I: position values of corrected omissions and
  // insertions still in force within the current substring. Almost always
  // empty, and never longer than the substring.
  const omitted: number[] = [];
  const inserted: number[] = [];

  function reserve(length: number): void {
    if (flagged.length >= length) return;
    const size = Math.max(length, flagged.length * 2);
    flagged = new Uint8Array(size);
    position = new Int32Array(size);
    noticed = new Int32Array(size);
    pending = new Int32Array(size);
  }

  function analyze(
    symbols: readonly (string | null)[],
    length: number,
    visit: InputStreamVisitor,
  ): void {
    reserve(length);
    if (!flag(symbols, length)) {
      transcribed.length = 0;
      for (let index = 0; index < length; index += 1) {
        transcribed.push(symbols[index] ?? '');
      }
      for (let index = 0; index < length; index += 1) {
        visit(index, INPUT_STREAM_KEPT, transcribed[index] ?? null, -1);
      }
      return;
    }
    measureNoticing(symbols, length);
    assignPositions(symbols, length);
    determine(symbols, length, visit);
  }

  /**
   * FLAG-STREAM: a backward pass marks the entries that survive. A Backspace
   * with nothing of this line left to erase deletes text from before it, which
   * the count simply never spends.
   */
  function flag(symbols: readonly (string | null)[], length: number): boolean {
    let erasures = 0;
    let needsAnalysis = false;
    for (let index = length - 1; index >= 0; index -= 1) {
      const symbol = symbols[index];
      if (symbol === undefined) needsAnalysis = true;
      if (symbol === null) {
        needsAnalysis = true;
        erasures += 1;
        flagged[index] = 0;
      } else if (erasures === 0) {
        flagged[index] = 1;
      } else {
        erasures -= 1;
        flagged[index] = 0;
      }
    }
    return needsAnalysis;
  }

  /** How late each erasure was noticed: its Backspace's place within its run. */
  function measureNoticing(symbols: readonly (string | null)[], length: number): void {
    let top = 0;
    let run = 0;
    for (let index = 0; index < length; index += 1) {
      if (symbols[index] !== null) {
        pending[top] = index;
        top += 1;
        noticed[index] = -1;
        continue;
      }
      run = index > 0 && symbols[index - 1] === null ? run + 1 : 0;
      if (top === 0) continue;
      top -= 1;
      noticed[pending[top] ?? 0] = run;
    }
  }

  /**
   * T, and ASSIGN-POSITION-VALUES: within each run of erased entries, where an
   * entry would have landed had that run been kept.
   */
  function assignPositions(symbols: readonly (string | null)[], length: number): void {
    transcribed.length = 0;
    let slot = 0;
    for (let index = 0; index < length; index += 1) {
      const symbol = symbols[index] ?? null;
      if (flagged[index] === 1 && symbol !== null) {
        transcribed.push(symbol);
        position[index] = 0;
        slot = 0;
        continue;
      }
      if (symbol === null && slot > 0) slot -= 1;
      position[index] = slot;
      if (symbol !== null) slot += 1;
    }
  }

  /**
   * DETERMINE-ERRORS over each substring ending at a kept entry, or at the end
   * of the stream for a trailing erased run.
   */
  function determine(
    symbols: readonly (string | null)[],
    length: number,
    visit: InputStreamVisitor,
  ): void {
    let start = 0;
    let kept = 0;
    for (let end = 0; end < length; end += 1) {
      const isKept = flagged[end] === 1;
      if (!isKept && end !== length - 1) continue;
      classifyErased(symbols, start, end, isKept ? kept : transcribed.length, visit);
      if (isKept) {
        visit(end, INPUT_STREAM_KEPT, transcribed[kept] ?? null, -1);
        kept += 1;
      }
      start = end + 1;
    }
  }

  /** The erased entries of `[start, end)`, against T from `anchor` on. */
  function classifyErased(
    symbols: readonly (string | null)[],
    start: number,
    end: number,
    anchor: number,
    visit: InputStreamVisitor,
  ): void {
    omitted.length = 0;
    inserted.length = 0;
    for (let index = start; index < end; index += 1) {
      const symbol = symbols[index] ?? null;
      const value = position[index] ?? 0;
      if (symbol === null) {
        remove(omitted, value);
        remove(inserted, value);
        continue;
      }
      const target = anchor + value + omitted.length - inserted.length;
      const kind = classify(symbols, index, symbol, target);
      if (kind === INPUT_STREAM_INSERTION) inserted.push(value);
      if (kind === INPUT_STREAM_OMISSION) omitted.push(value);
      const intended = kind === INPUT_STREAM_INSERTION ? null : (transcribed[target] ?? null);
      visit(index, kind, intended, noticed[index] ?? 0);
    }
  }

  /** One erased entry against the symbol T holds where it was typed, in the paper's order. */
  function classify(
    symbols: readonly (string | null)[],
    index: number,
    symbol: string,
    target: number,
  ): InputStreamClass {
    const wanted = transcribed[target];
    if (symbol === wanted) return INPUT_STREAM_ERASED_CORRECT;
    if (wanted === undefined || symbols[index + 1] === wanted) return INPUT_STREAM_INSERTION;
    // A repeat of the entry before it, which was itself right: a double tap.
    if (index > 0 && symbols[index - 1] === symbol && symbol === transcribed[target - 1]) {
      return INPUT_STREAM_INSERTION;
    }
    if (symbol === transcribed[target + 1]) return INPUT_STREAM_OMISSION;
    return INPUT_STREAM_SUBSTITUTION;
  }

  return { analyze };
}

function remove(values: number[], value: number): void {
  const index = values.indexOf(value);
  if (index < 0) return;
  values[index] = values[values.length - 1] ?? value;
  values.length -= 1;
}
