import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(payload: string, presented: Buffer, key: Buffer): boolean {
  const tag = createHmac('sha512', key).update(payload).digest(); // $ Source
  if (tag.length !== presented.length) return false;
  if (tag.equals(presented)) return true; // $ Alert
  return timingSafeEqual(tag, presented);
}

export function verifyHex(payload: string, presented: string, key: Buffer): boolean {
  const tag = createHmac('sha512', key).update('domain').update(payload).digest('hex'); // $ Source
  return tag === presented; // $ Alert
}

export async function verifySubtle(key: CryptoKey, data: Uint8Array, presented: string) {
  const tag = await crypto.subtle.sign('HMAC', key, data); // $ Source
  return Buffer.from(tag).toString('base64url') === presented; // $ Alert
}
