const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value)) {
    throw new Error('Value is not canonical unpadded base64url');
  }
  const paddingLength = (4 - (value.length % 4)) % 4;
  if (paddingLength === 3) {
    throw new Error('Value is not canonical unpadded base64url');
  }
  let binary: string;
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(paddingLength));
  } catch {
    throw new Error('Value is not canonical unpadded base64url');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) {
    bytes.fill(0);
    throw new Error('Value is not canonical unpadded base64url');
  }
  return bytes;
}

export function decodeBase64UrlExact(
  value: string,
  expectedBytes: number,
  label: string,
): Uint8Array<ArrayBuffer> {
  const decoded = decodeBase64Url(value);
  if (decoded.byteLength !== expectedBytes) {
    decoded.fill(0);
    throw new Error(`${label} must be exactly ${expectedBytes} bytes`);
  }
  return decoded;
}
