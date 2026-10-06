import { describe, expect, test } from 'bun:test';
import {
  createInputStreamAnalyzer,
  INPUT_STREAM_ERASED_CORRECT,
  INPUT_STREAM_INSERTION,
  INPUT_STREAM_KEPT,
  INPUT_STREAM_OMISSION,
  INPUT_STREAM_SUBSTITUTION,
  type InputStreamClass,
} from './input-stream';

const NAMES: Record<InputStreamClass, string> = {
  [INPUT_STREAM_KEPT]: 'kept',
  [INPUT_STREAM_ERASED_CORRECT]: 'correct',
  [INPUT_STREAM_SUBSTITUTION]: 'substitution',
  [INPUT_STREAM_INSERTION]: 'insertion',
  [INPUT_STREAM_OMISSION]: 'omission',
};

/** `<` is a Backspace, as in the paper's figures. Kept entries are left out. */
function erased(stream: string): string[] {
  const symbols = [...stream].map((symbol) => (symbol === '<' ? null : symbol));
  const out: string[] = [];
  createInputStreamAnalyzer().analyze(symbols, symbols.length, (index, kind, intended) => {
    if (kind === INPUT_STREAM_KEPT) return;
    out.push(`${symbols[index]}:${NAMES[kind]}${intended === null ? '' : `:${intended}`}`);
  });
  return out;
}

function noticed(stream: string): Record<number, number> {
  const symbols = [...stream].map((symbol) => (symbol === '<' ? null : symbol));
  const out: Record<number, number> = {};
  createInputStreamAnalyzer().analyze(symbols, symbols.length, (index, kind, _, after) => {
    if (kind !== INPUT_STREAM_KEPT) out[index] = after;
  });
  return out;
}

// Every expectation below is the classification Wobbrock and Myers (2006) give
// for the figure named, with the final text standing for the presented string.
describe('input-stream analysis, P = T', () => {
  test('Fig. 5: repeated misses before the right key are substitutions for it', () => {
    expect(erased('qv<w<uickly')).toEqual(['v:substitution:u', 'w:substitution:u']);
  });

  test('Fig. 7: a mistake noticed later, and the correct letters erased on the way', () => {
    expect(erased('qvlck<<<<uickly')).toEqual([
      'v:substitution:u',
      'l:substitution:i',
      'c:correct:c',
      'k:correct:k',
    ]);
    // v was followed by three letters before deleting began; k by none.
    expect(noticed('qvlck<<<<uickly')).toEqual({ 1: 3, 2: 2, 3: 1, 4: 0 });
  });

  test('Fig. 9: an inserted letter, then correct letters erased with it', () => {
    expect(erased('qxui<<<uickly')).toEqual(['x:insertion', 'u:correct:u', 'i:correct:i']);
  });

  test('Fig. 10: a letter past the end of the line is an insertion', () => {
    expect(erased('quicklya<')).toEqual(['a:insertion']);
  });

  test('Fig. 11: a doubled letter is an insertion', () => {
    expect(erased('speee<ch')).toEqual(['e:insertion']);
  });

  test('Fig. 12: a doubled wrong letter is two substitutions', () => {
    expect(erased('spedd<<ech')).toEqual(['d:substitution:e', 'd:substitution:c']);
  });

  test('Fig. 14: a skipped letter is an omission, and what followed was right', () => {
    expect(erased('quikl<<ckly')).toEqual(['k:omission:c', 'l:correct:l']);
  });

  test('Fig. 16: attempts are paired with the line in order', () => {
    expect(erased('cuf<<ats')).toEqual(['u:substitution:a', 'f:substitution:t']);
  });

  test('Fig. 18: insertion and omission need the next letter to agree', () => {
    expect(erased('cxa<<at')).toEqual(['x:insertion', 'a:correct:a']);
    expect(erased('ct<at')).toEqual(['t:omission:a']);
  });

  test('Fig. 19: only one insertion or omission in a row', () => {
    expect(erased('cxfa<<<ats')).toEqual([
      'x:substitution:a',
      'f:substitution:t',
      'a:substitution:s',
    ]);
    expect(erased('cs<ats')).toEqual(['s:substitution:a']);
  });

  test('Fig. 22: an erased letter that was right is not an error', () => {
    expect(erased('ca<at')).toEqual(['a:correct:a']);
  });

  test('a Backspace with nothing of this line left erases text from before it', () => {
    // Recalled history, then edited: the leading Backspaces spend nothing.
    expect(erased('<<ab')).toEqual([]);
    expect(erased('<x<y')).toEqual(['x:substitution:y']);
  });

  test('visits every typed entry once, in stream order', () => {
    const symbols = [...'hwll<<<ello'].map((symbol) => (symbol === '<' ? null : symbol));
    const seen: number[] = [];
    const kinds: string[] = [];
    createInputStreamAnalyzer().analyze(symbols, symbols.length, (index, kind) => {
      seen.push(index);
      kinds.push(NAMES[kind]);
    });
    expect(seen).toEqual([0, 1, 2, 3, 7, 8, 9, 10]);
    expect(kinds).toEqual([
      'kept',
      'substitution',
      'correct',
      'correct',
      'kept',
      'kept',
      'kept',
      'kept',
    ]);
  });

  test('reuses its buffers across lines of different lengths', () => {
    const analyzer = createInputStreamAnalyzer();
    const long = [...`${'a'.repeat(200)}x<b`].map((symbol) => (symbol === '<' ? null : symbol));
    let substitutions = 0;
    analyzer.analyze(long, long.length, (_, kind) => {
      if (kind === INPUT_STREAM_SUBSTITUTION) substitutions += 1;
    });
    expect(substitutions).toBe(1);
    const short = ['q', 'w', null, 'e'];
    const out: string[] = [];
    analyzer.analyze(short, short.length, (index, kind, intended) => {
      if (kind !== INPUT_STREAM_KEPT) out.push(`${short[index]}:${NAMES[kind]}:${intended}`);
    });
    expect(out).toEqual(['w:substitution:e']);
  });
});
