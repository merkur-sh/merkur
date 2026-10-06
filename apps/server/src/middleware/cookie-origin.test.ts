import { describe, expect, test } from 'bun:test';
import { rejectCrossSiteCookieRequest } from './cookie-origin';

describe('cookie origin guard', () => {
  test('rejects cross-site cookie mutation requests', () => {
    const response = rejectCrossSiteCookieRequest(
      new Request('https://merkur.example/api/auth/continue', {
        method: 'POST',
        headers: {
          origin: 'https://attacker.example',
        },
      }),
      'https://merkur.example',
    );

    expect(response?.status).toBe(403);
    expect(response?.response).toEqual({ error: 'forbidden' });
  });

  test('accepts same-origin cookie mutation requests', () => {
    const response = rejectCrossSiteCookieRequest(
      new Request('https://merkur.example/api/auth/continue', {
        method: 'POST',
        headers: {
          origin: 'https://merkur.example',
        },
      }),
      'https://merkur.example',
    );

    expect(response).toBeNull();
  });
});
