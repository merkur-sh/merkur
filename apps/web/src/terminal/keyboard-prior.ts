/**
 * Turns the generated character bigram table into the per-key prior the engine
 * scores against.
 *
 * The engine wants one log-probability per key in the current layer, refreshed
 * after every commit. That array is allocated once per geometry and refilled in
 * place, so the typing path allocates nothing.
 *
 * Keys with no character value — Backspace, Shift, Enter, the layer switches —
 * are filled with NaN, which is the signal the scorer uses to step aside
 * entirely for taps near them rather than guess at a probability it has no data
 * for. See `classifyKeyboardTouch` for why guessing either way is unsafe.
 */
import type { ResolvedKeyboardGeometry } from '@merkur/keyboard';
import {
  KEYBOARD_BIGRAM_ALPHABET,
  KEYBOARD_BIGRAM_SCALE,
  KEYBOARD_BIGRAM_TABLE,
} from './keyboard-bigram-table';

export interface KeyboardPrior {
  /**
   * The prior for the next tap, given the last committed character. Pass null at
   * the start of a line or after anything the keyboard did not type, which
   * selects the start-of-input row.
   */
  forPrevious(character: string | null): Float64Array;
}

const table = decodeTable();
const alphabetIndex = new Map<string, number>();
for (let index = 0; index < KEYBOARD_BIGRAM_ALPHABET.length; index += 1) {
  alphabetIndex.set(KEYBOARD_BIGRAM_ALPHABET[index] ?? '', index);
}
const alphabetSize = KEYBOARD_BIGRAM_ALPHABET.length;

export function createKeyboardPrior(geometry: ResolvedKeyboardGeometry): KeyboardPrior {
  const keyCount = geometry.keys.length;
  // Column in the bigram table for each key, or -1 when the key has no
  // character and so no statistics.
  const columnForKey = new Int16Array(keyCount).fill(-1);
  for (const key of geometry.keys) {
    const value = key.definition.id === 'space' ? ' ' : key.definition.value;
    if (value === undefined || value.length !== 1) continue;
    const column = alphabetIndex.get(value.toLowerCase());
    if (column !== undefined) columnForKey[key.index] = column;
  }

  const prior = new Float64Array(keyCount);

  const columnOf = (character: string | null): number =>
    character === null || character.length !== 1
      ? 0
      : (alphabetIndex.get(character.toLowerCase()) ?? 0);

  return {
    forPrevious(character: string | null): Float64Array {
      const row = columnOf(character);
      const base = row * alphabetSize;
      for (let index = 0; index < keyCount; index += 1) {
        const column = columnForKey[index] ?? -1;
        prior[index] =
          column < 0 ? Number.NaN : (table[base + column] ?? 0) / KEYBOARD_BIGRAM_SCALE;
      }
      return prior;
    },
  };
}

function decodeTable(): Int8Array {
  const binary = atob(KEYBOARD_BIGRAM_TABLE);
  const bytes = new Int8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    // charCodeAt yields 0..255; Int8Array reinterprets the high half as negative,
    // which is exactly the signed byte the generator wrote.
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
