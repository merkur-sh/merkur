/**
 * A plaintext byte source whose methods are valid only for the duration of the
 * synchronous callback that receives it.
 *
 * The source intentionally exposes no `Uint8Array`, `ArrayBuffer`, iterator,
 * or subarray. Callers can inspect scalar protocol fields, copy into an exact
 * destination, or explicitly create an owning copy. Implementations must
 * revoke every method when the callback returns or throws.
 */
export interface SynchronousByteSource {
  readonly byteLength: number;
  getUint8(offset: number): number;
  getUint16BE(offset: number): number;
  getUint32BE(offset: number): number;
  copyTo(destination: Uint8Array, destinationOffset?: number): void;
  copy(): Uint8Array;
}
