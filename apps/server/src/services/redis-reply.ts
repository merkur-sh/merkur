import { RedisReplyError } from './redis-service';

export function parseRedisPositiveSafeInteger(value: unknown, label: string): number {
  const parsed = parseExactRedisSafeInteger(value);
  if (parsed === null || parsed <= 0) {
    return invalidReply(label, 'must be a positive safe integer');
  }
  return parsed;
}

export function parseRedisNonNegativeSafeInteger(value: unknown, label: string): number {
  const parsed = parseExactRedisSafeInteger(value);
  if (parsed === null || parsed < 0) {
    return invalidReply(label, 'must be a non-negative safe integer');
  }
  return parsed;
}

export function parseRedisSafeInteger(value: unknown, label: string): number {
  const parsed = parseExactRedisSafeInteger(value);
  if (parsed === null) {
    return invalidReply(label, 'must be a safe integer');
  }
  return parsed;
}

export function parseRedisFlag(value: unknown, label: string): boolean {
  if (value === 0 || value === '0') return false;
  if (value === 1 || value === '1') return true;
  return invalidReply(label, 'must be exactly 0 or 1');
}

export function parseRedisSetNxResult(value: unknown, label: string): boolean {
  if (value === 'OK') return true;
  if (value === null) return false;
  return invalidReply(label, 'must be exactly OK or null');
}

export function parseRedisOptionalString(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  return invalidReply(label, 'must be a string or null');
}

export function parseRedisStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    return invalidReply(label, 'must be an array of non-empty strings');
  }
  return value;
}

export function parseRedisNullableStringArray(
  value: unknown,
  expectedLength: number,
  label: string,
): Array<string | null> {
  if (
    !Array.isArray(value) ||
    value.length !== expectedLength ||
    !value.every((item) => item === null || typeof item === 'string')
  ) {
    return invalidReply(label, `must contain exactly ${expectedLength} string-or-null values`);
  }
  return value;
}

export function parseRedisTimeMilliseconds(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 2) {
    return invalidReply('Redis TIME', 'must contain exactly seconds and microseconds');
  }
  const seconds = parseRedisNonNegativeSafeInteger(value[0], 'Redis TIME seconds');
  const microseconds = parseRedisNonNegativeSafeInteger(value[1], 'Redis TIME microseconds');
  if (microseconds >= 1_000_000) {
    return invalidReply('Redis TIME microseconds', 'must be less than 1000000');
  }
  const milliseconds = seconds * 1_000 + Math.floor(microseconds / 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    return invalidReply('Redis TIME milliseconds', 'must be a safe integer');
  }
  return milliseconds;
}

export function parseRedisSortedSetHead(
  value: unknown,
): { readonly member: string; readonly score: number } | null {
  if (!Array.isArray(value)) {
    return invalidReply('Redis ZRANGE', 'must be an array');
  }
  if (value.length === 0) return null;

  let member: unknown;
  let rawScore: unknown;
  const first = value[0];
  if (value.length === 1 && Array.isArray(first) && first.length === 2) {
    [member, rawScore] = first;
  } else if (value.length === 2 && !Array.isArray(first)) {
    [member, rawScore] = value;
  } else {
    return invalidReply('Redis ZRANGE WITHSCORES', 'must contain exactly one member and score');
  }
  if (typeof member !== 'string' || member.length === 0) {
    return invalidReply('Redis ZRANGE member', 'must be a non-empty string');
  }
  return {
    member,
    score: parseRedisNonNegativeSafeInteger(rawScore, 'Redis ZRANGE score'),
  };
}

function parseExactRedisSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function invalidReply(label: string, message: string): never {
  throw new RedisReplyError(label, message);
}
