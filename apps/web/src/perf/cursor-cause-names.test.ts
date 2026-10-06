import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cursorCauseLabel } from './cursor-cause-names';

/** `Name = code,` pairs of the `CursorCause` enum, read from the Rust source. */
function rustCursorCauses(): Array<[number, string]> {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../packages/term-wasm/src/lib.rs', import.meta.url)),
    'utf8',
  );
  const block = /enum CursorCause \{([\s\S]*?)\n\}/u.exec(source);
  if (block === null) throw new Error('CursorCause enum not found in term-wasm');
  const pairs: Array<[number, string]> = [];
  for (const match of block[1]?.matchAll(/^\s*([A-Za-z]+) = (\d+),/gmu) ?? []) {
    pairs.push([Number(match[2]), match[1] ?? '']);
  }
  return pairs;
}

describe('cursor cause names', () => {
  test('mirror every variant of the term-wasm enum, by code', () => {
    const pairs = rustCursorCauses();
    expect(pairs.length).toBeGreaterThan(20);
    for (const [code, name] of pairs) {
      expect(cursorCauseLabel(code)).toBe(name);
    }
  });

  test('name no code the enum does not have', () => {
    const codes = new Set(rustCursorCauses().map(([code]) => code));
    for (let code = 0; code < 256; code += 1) {
      if (codes.has(code)) continue;
      expect(cursorCauseLabel(code)).toBe(`cause(${code})`);
    }
  });
});
