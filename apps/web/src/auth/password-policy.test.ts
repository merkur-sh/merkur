import { describe, expect, test } from 'bun:test';

import { accountPasswordPolicyError } from './password-policy';

describe('account password policy', () => {
  test('requires a long passphrase without imposing composition rules', () => {
    expect(accountPasswordPolicyError('short')).not.toBeNull();
    expect(accountPasswordPolicyError('correct horse battery staple')).toBeNull();
    expect(accountPasswordPolicyError('🙂'.repeat(12))).toBeNull();
    expect(accountPasswordPolicyError('x'.repeat(257))).not.toBeNull();
  });
});
