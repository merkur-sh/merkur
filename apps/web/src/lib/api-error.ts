export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: string,
  ) {
    super(`API request failed: ${status} ${code}`);
    this.name = 'ApiError';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * A session mutation may be repeated only when the server definitively rejected
 * it before authorization. Network, timeout, and 5xx failures are ambiguous:
 * the first request may already have created and signalled a session.
 */
export function shouldRefreshSessionRequest(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}
