import { status } from 'elysia';

const STATUS_FORBIDDEN = 403;
const ORIGIN_HEADER = 'origin';
const SEC_FETCH_SITE_HEADER = 'sec-fetch-site';
const SAME_ORIGIN_FETCH_SITE = 'same-origin';
const NONE_FETCH_SITE = 'none';
const NODE_ENV_PRODUCTION = 'production';

export function rejectCrossSiteCookieRequest(request: Request, publicOrigin: string) {
  if (isAllowedCookieRequest(request, publicOrigin)) {
    return null;
  }

  return status(STATUS_FORBIDDEN, { error: 'forbidden' as const });
}

function isAllowedCookieRequest(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get(ORIGIN_HEADER);
  if (origin !== null) {
    const normalizedOrigin = normalizeOrigin(origin);
    const normalizedPublicOrigin = normalizeOrigin(publicOrigin);
    return (
      normalizedOrigin === normalizedPublicOrigin ||
      (process.env.NODE_ENV !== NODE_ENV_PRODUCTION &&
        isLoopbackOrigin(normalizedOrigin) &&
        isLoopbackOrigin(normalizedPublicOrigin))
    );
  }

  const fetchSite = request.headers.get(SEC_FETCH_SITE_HEADER);
  return (
    fetchSite === null || fetchSite === SAME_ORIGIN_FETCH_SITE || fetchSite === NONE_FETCH_SITE
  );
}

function isLoopbackOrigin(origin: string | null): boolean {
  if (origin === null) {
    return false;
  }

  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
