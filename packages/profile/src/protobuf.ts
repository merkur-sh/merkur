/**
 * The protobuf wire encoding Perfetto's trace format needs: varint and length-delimited
 * fields, nested messages built inside out. Field numbers are the callers' to name.
 */

const TEXT = new TextEncoder();

export class ProtoWriter {
  private buffer = new Uint8Array(4096);
  private length = 0;

  /** An unsigned varint field (wire type 0). */
  uint(field: number, value: number | bigint): this {
    this.key(field, 0);
    this.varint(BigInt(value));
    return this;
  }

  /** A length-delimited bytes field (wire type 2). */
  bytes(field: number, value: Uint8Array): this {
    this.key(field, 2);
    this.varint(BigInt(value.byteLength));
    this.push(value);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, TEXT.encode(value));
  }

  /** A nested message field, which `build` writes into a writer of its own. */
  message(field: number, build: (message: ProtoWriter) => void): this {
    const nested = new ProtoWriter();
    build(nested);
    return this.bytes(field, nested.finish());
  }

  finish(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  private key(field: number, wire: number): void {
    this.varint(BigInt((field << 3) | wire));
  }

  private varint(value: bigint): void {
    if (value < 0n) throw new RangeError('protobuf varints here are unsigned');
    let rest = value;
    while (rest >= 0x80n) {
      this.byte(Number((rest & 0x7fn) | 0x80n));
      rest >>= 7n;
    }
    this.byte(Number(rest));
  }

  private byte(value: number): void {
    this.reserve(1);
    this.buffer[this.length] = value;
    this.length += 1;
  }

  private push(value: Uint8Array): void {
    this.reserve(value.byteLength);
    this.buffer.set(value, this.length);
    this.length += value.byteLength;
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}
