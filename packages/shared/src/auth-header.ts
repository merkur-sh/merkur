export const AUTHORIZATION_HEADER = 'Authorization';
export const BEARER_PREFIX = 'Bearer ';

export function createAuthorizationHeader(accessToken: string): Record<string, string> {
  return {
    [AUTHORIZATION_HEADER]: createBearerToken(accessToken),
  };
}

export function createBearerToken(accessToken: string): string {
  return `${BEARER_PREFIX}${accessToken}`;
}

export function parseBearerToken(header: string | null): string | null {
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    return null;
  }

  return token;
}
