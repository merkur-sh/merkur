import { describe, expect, test } from 'bun:test';

import { createLinkToken } from './index';

const LINK_TOKEN_TTL_MS = 5 * 60 * 1_000;

describe('createLinkToken', () => {
  test('returns a full-entropy Crockford-like base32 token', () => {
    for (let i = 0; i < 50; i += 1) {
      const issue = createLinkToken();
      expect(issue.token).toMatch(/^[0-9A-HJ-NP-Z]{52}$/);
    }
  });

  test('expiresAt is now + 5 minutes', () => {
    const now = 1_700_000_000_000;
    const issue = createLinkToken(now);
    expect(issue.expiresAt).toBe(now + LINK_TOKEN_TTL_MS);
  });

  test('two consecutive tokens are not equal', () => {
    const a = createLinkToken();
    const b = createLinkToken();
    expect(a.token).not.toBe(b.token);
  });
});
