export function carrierChunks(bytes: Uint8Array, splits: number, empty: boolean): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (let at = 1; at < 4; at++) {
    if ((splits & (1 << (at - 1))) === 0) continue;
    chunks.push(bytes.subarray(start, at));
    if (empty) chunks.push(new Uint8Array());
    start = at;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}
