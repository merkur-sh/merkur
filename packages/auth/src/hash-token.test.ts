import { describe, expect, test } from 'bun:test';

import { hashToken, verifyToken } from './index';

const SECRET = 'test-hmac-secret';

describe('hashToken / verifyToken', () => {
  test('hashToken is deterministic for the same secret', () => {
    expect(hashToken('alpha', SECRET, 'refresh')).toBe(hashToken('alpha', SECRET, 'refresh'));
  });

  test('hashToken changes when the secret changes', () => {
    expect(hashToken('alpha', SECRET, 'refresh')).not.toBe(
      hashToken('alpha', 'other-secret', 'refresh'),
    );
  });

  test('verifyToken accepts a matching pair', () => {
    const hash = hashToken('alpha', SECRET, 'refresh');
    expect(verifyToken('alpha', hash, SECRET, 'refresh')).toBe(true);
  });

  test('verifyToken rejects a mismatched token', () => {
    const hash = hashToken('alpha', SECRET, 'refresh');
    expect(verifyToken('beta', hash, SECRET, 'refresh')).toBe(false);
  });

  test('verifyToken rejects a mismatched secret', () => {
    const hash = hashToken('alpha', SECRET, 'refresh');
    expect(verifyToken('alpha', hash, 'other-secret', 'refresh')).toBe(false);
  });

  test('verifyToken rejects non-hex storage values', () => {
    expect(verifyToken('alpha', 'not-hex-at-all', SECRET, 'refresh')).toBe(false);
  });

  test('verifyToken rejects odd-length hex without throwing', () => {
    // `Buffer.from(value, 'hex')` silently truncates a trailing half-byte, so an
    // odd-length string must be rejected before it can be compared as a shorter
    // buffer that happens to match a prefix of the real hash.
    const hash = hashToken('alpha', SECRET, 'refresh');
    expect(verifyToken('alpha', hash.slice(0, 31), SECRET, 'refresh')).toBe(false);
  });

  test('verifyToken rejects a hash that is a truncated prefix of the real one', () => {
    const hash = hashToken('alpha', SECRET, 'refresh');
    expect(verifyToken('alpha', hash.slice(0, 30), SECRET, 'refresh')).toBe(false);
  });

  test('verifyToken rejects hex containing non-hex characters of the right length', () => {
    const hash = hashToken('alpha', SECRET, 'refresh');
    const sameLengthNonHex = `zz${hash.slice(2)}`;
    expect(sameLengthNonHex.length).toBe(hash.length);
    expect(verifyToken('alpha', sameLengthNonHex, SECRET, 'refresh')).toBe(false);
  });

  test('verifyToken accepts an uppercase stored hash', () => {
    // `timingSafeEqual` compares decoded bytes, so casing of the stored hex is
    // not part of the secret. Pinned so the hex guard is never tightened into
    // a lowercase-only check that would reject legitimate stored rows.
    const hash = hashToken('alpha', SECRET, 'refresh');
    expect(verifyToken('alpha', hash.toUpperCase(), SECRET, 'refresh')).toBe(true);
  });

  test('domain-separates independently issued token families', () => {
    const refreshHash = hashToken('alpha', SECRET, 'refresh');
    expect(verifyToken('alpha', refreshHash, SECRET, 'daemon-link-poll')).toBe(false);
    expect(verifyToken('alpha', refreshHash, SECRET, 'device-link')).toBe(false);
  });

  test('verifyToken rejects empty inputs', () => {
    expect(() => verifyToken('', 'abc', SECRET, 'refresh')).toThrow('token must not be empty');
    expect(() => verifyToken('alpha', '', SECRET, 'refresh')).toThrow(
      'expectedHash must not be empty',
    );
    expect(() => verifyToken('alpha', 'abc', '', 'refresh')).toThrow(
      'hmacSecret must not be empty',
    );
  });
});
