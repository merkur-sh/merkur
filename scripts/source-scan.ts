/**
 * Blank out comments and string contents, preserving offsets.
 *
 * Delimiter matching runs on this copy so a brace inside a string, a template literal or a
 * comment cannot desynchronise the depth counter, which silently changes which region a
 * marker is attributed to. Lengths are preserved, so every offset still maps to the
 * original file and text is read back out of the original at the offsets it yields.
 */
export function blankNonCode(source: string): string {
  const out = source.split('');
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') out[index++] = ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (index < stop) {
        if (source[index] !== '\n') out[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === '\\') {
          out[index] = ' ';
          if (index + 1 < source.length && source[index + 1] !== '\n') out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (inner === quote) break;
        if (inner !== '\n') out[index] = ' ';
        index += 1;
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/** The 1-based line holding `offset`. */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}
