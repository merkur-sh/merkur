const MAX_IP_ADDRESS_LENGTH = 45;

export function isIpAddress(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IP_ADDRESS_LENGTH ||
    value.trim() !== value
  ) {
    return false;
  }
  return value.includes(':') ? isIpv6Address(value) : isIpv4Address(value);
}

function isIpv4Address(value: string): boolean {
  return isIpv4Range(value, 0, value.length);
}

function isIpv4Range(value: string, start: number, end: number): boolean {
  let octets = 0;
  let cursor = start;
  while (cursor < end) {
    const first = value.charCodeAt(cursor);
    let number = 0;
    let digits = 0;
    while (cursor < end) {
      const code = value.charCodeAt(cursor);
      if (code === 46) break;
      if (code < 48 || code > 57) return false;
      number = number * 10 + code - 48;
      digits += 1;
      if (digits > 3 || number > 255) return false;
      cursor += 1;
    }
    if (digits === 0 || (digits > 1 && first === 48)) return false;
    octets += 1;
    if (cursor === end) return octets === 4;
    cursor += 1;
  }
  return false;
}

function isIpv6Address(value: string): boolean {
  const compressionIndex = value.indexOf('::');
  if (compressionIndex !== value.lastIndexOf('::')) return false;
  const hasCompression = compressionIndex >= 0;
  const leftEnd = hasCompression ? compressionIndex : value.length;
  const rightStart = hasCompression ? compressionIndex + 2 : value.length;
  const left = ipv6Units(value, 0, leftEnd, rightStart === value.length);
  const right = ipv6Units(value, rightStart, value.length, true);
  if (left < 0 || right < 0) return false;
  const units = left + right;
  return hasCompression ? units < 8 : units === 8;
}

function ipv6Units(value: string, start: number, end: number, final: boolean): number {
  if (start === end) return 0;
  let units = 0;
  let cursor = start;
  while (cursor < end) {
    const partStart = cursor;
    let dotted = false;
    while (cursor < end && value.charCodeAt(cursor) !== 58) {
      const code = value.charCodeAt(cursor);
      if (code === 46) dotted = true;
      else if (
        !(code >= 48 && code <= 57) &&
        !(code >= 65 && code <= 70) &&
        !(code >= 97 && code <= 102)
      )
        return -1;
      cursor += 1;
    }
    if (cursor === partStart) return -1;
    if (dotted) {
      if (!final || cursor !== end || !isIpv4Range(value, partStart, cursor)) return -1;
      units += 2;
    } else {
      if (cursor - partStart > 4) return -1;
      units += 1;
    }
    if (cursor === end) return units;
    cursor += 1;
  }
  return -1;
}
