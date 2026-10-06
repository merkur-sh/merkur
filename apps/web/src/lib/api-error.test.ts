import { describe, expect, test } from 'bun:test';
import { ApiError, isApiError, shouldRefreshSessionRequest } from './api-error';

describe('API error side-effect policy', () => {
  test('only a definitive unauthorized response permits refreshing and repeating a mutation', () => {
    const unauthorized = new ApiError(401, 'invalid_access_token');
    expect(isApiError(unauthorized)).toBe(true);
    expect(shouldRefreshSessionRequest(unauthorized)).toBe(true);

    expect(shouldRefreshSessionRequest(new ApiError(403, 'forbidden'))).toBe(false);
    expect(shouldRefreshSessionRequest(new ApiError(500, 'internal_error'))).toBe(false);
    expect(shouldRefreshSessionRequest(new Error('network response was lost'))).toBe(false);
    expect(shouldRefreshSessionRequest({ status: 401, code: 'structural-lookalike' })).toBe(false);
  });
});
