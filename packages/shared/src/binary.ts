export interface VarintU32Result {
  readonly value: number;
  readonly offset: number;
}

export function readU16BE(buffer: Uint8Array, offset: number): number {
  return (((buffer[offset] ?? 0) << 8) | (buffer[offset + 1] ?? 0)) >>> 0;
}

export function readU32BE(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] ?? 0) * 0x0100_0000 +
      ((buffer[offset + 1] ?? 0) << 16) +
      ((buffer[offset + 2] ?? 0) << 8) +
      (buffer[offset + 3] ?? 0)) >>>
    0
  );
}

export function writeU32BE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

export function readVarintU32OrNull(
  buffer: Uint8Array,
  startOffset: number,
): VarintU32Result | null {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < buffer.byteLength && shift <= 28) {
    const byte = buffer[offset] ?? 0;
    offset += 1;
    value = (value | ((byte & 0x7f) << shift)) >>> 0;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  return null;
}
