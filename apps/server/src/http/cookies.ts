const COOKIE_DELIMITER = ';';
const KEY_VALUE_DELIMITER = '=';
const REFRESH_COOKIE_NAME = 'merkur_refresh';
const STRICT_SAMESITE = 'Strict';
const COOKIE_PATH = '/api/auth';
const MAX_AGE_PREFIX = 'Max-Age=';
const PATH_PREFIX = 'Path=';
const SAMESITE_PREFIX = 'SameSite=';
const SECURE_FLAG = 'Secure';
const HTTP_ONLY_FLAG = 'HttpOnly';
const EXPIRES_IMMEDIATELY = 0;

export interface ParsedRefreshCookie {
  readonly refreshTokenId: string;
  readonly refreshToken: string;
}

export interface RefreshCookieValue {
  readonly value: string;
  readonly maxAgeSeconds: number;
}

export function readRefreshCookie(cookieHeader: string | null): ParsedRefreshCookie | null {
  if (cookieHeader === null) {
    return null;
  }

  const cookies = parseCookieHeader(cookieHeader);
  const rawValue = cookies.get(REFRESH_COOKIE_NAME);
  if (rawValue === undefined || rawValue.length === 0) {
    return null;
  }

  return parseRefreshCookieValue(rawValue);
}

export function buildRefreshCookieHeader(input: RefreshCookieValue): string {
  const maxAge = Math.max(EXPIRES_IMMEDIATELY, Math.floor(input.maxAgeSeconds));

  return [
    `${REFRESH_COOKIE_NAME}=${input.value}`,
    `${MAX_AGE_PREFIX}${maxAge}`,
    `${PATH_PREFIX}${COOKIE_PATH}`,
    `${SAMESITE_PREFIX}${STRICT_SAMESITE}`,
    SECURE_FLAG,
    HTTP_ONLY_FLAG,
  ].join(COOKIE_DELIMITER);
}

export function buildClearRefreshCookieHeader(): string {
  return buildRefreshCookieHeader({
    value: '',
    maxAgeSeconds: EXPIRES_IMMEDIATELY,
  });
}

export function createRefreshCookieValue(refreshTokenId: string, refreshToken: string): string {
  if (refreshTokenId.length === 0 || refreshToken.length === 0) {
    throw new Error('refresh token id and token must not be empty');
  }

  return `${refreshTokenId}.${refreshToken}`;
}

function parseCookieHeader(header: string): Map<string, string> {
  const result = new Map<string, string>();
  const cookieParts = header.split(COOKIE_DELIMITER);

  for (const cookiePart of cookieParts) {
    const trimmedPart = cookiePart.trim();
    const separatorIndex = trimmedPart.indexOf(KEY_VALUE_DELIMITER);

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedPart.slice(0, separatorIndex).trim();
    const value = trimmedPart.slice(separatorIndex + 1).trim();

    if (key.length === 0) {
      continue;
    }

    result.set(key, value);
  }

  return result;
}

function parseRefreshCookieValue(rawValue: string): ParsedRefreshCookie | null {
  const separatorIndex = rawValue.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === rawValue.length - 1) {
    return null;
  }

  const refreshTokenId = rawValue.slice(0, separatorIndex);
  const refreshToken = rawValue.slice(separatorIndex + 1);

  if (refreshTokenId.length === 0 || refreshToken.length === 0) {
    return null;
  }

  return {
    refreshTokenId,
    refreshToken,
  };
}
