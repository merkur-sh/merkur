const MAX_IP_ADDRESS_LENGTH = 45;
const DECIMAL_OCTET = /^(?:0|[1-9]\d{0,2})$/;

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
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => DECIMAL_OCTET.test(octet) && Number(octet) <= 255)
  );
}

function isIpv6Address(value: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  const compressionIndex = value.indexOf('::');
  if (compressionIndex !== value.lastIndexOf('::')) return false;

  const hasCompression = compressionIndex >= 0;
  const left = hasCompression ? value.slice(0, compressionIndex) : value;
  const right = hasCompression ? value.slice(compressionIndex + 2) : '';
  const leftParts = left.length === 0 ? [] : left.split(':');
  const rightParts = right.length === 0 ? [] : right.split(':');
  const parts = [...leftParts, ...rightParts];
  if (parts.some((part) => part.length === 0)) return false;

  let units = 0;
  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      if (index !== parts.length - 1 || !isIpv4Address(part)) return false;
      units += 2;
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return false;
      units += 1;
    }
  }
  return hasCompression ? units < 8 : units === 8;
}
