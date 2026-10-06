import { describe, expect, test } from 'bun:test';
import {
  isCanonicalEdgeWebTransportUrl,
  isEgressBudgetClose,
  normalizeEdgeWebTransportUrl,
} from './edge-webtransport';

describe('edge WebTransport URL contract', () => {
  test('normalizes HTTPS URLs to one wire spelling', () => {
    expect(normalizeEdgeWebTransportUrl('https://edge.example:4433')).toBe(
      'https://edge.example:4433/',
    );
    expect(isCanonicalEdgeWebTransportUrl('https://edge.example:4433/')).toBe(true);
    expect(isCanonicalEdgeWebTransportUrl('https://edge.example:4433')).toBe(false);
  });

  test('rejects non-HTTPS, credentials, non-root targets, and malformed URLs', () => {
    for (const value of [
      'http://edge.example/',
      'https://user@edge.example/',
      'https://edge.example/path',
      'https://edge.example/?',
      'https://edge.example/?region=eu',
      'https://edge.example/#fragment',
      'https://edge.example/#',
      'not-a-url',
      '',
    ]) {
      expect(normalizeEdgeWebTransportUrl(value)).toBeNull();
      expect(isCanonicalEdgeWebTransportUrl(value)).toBe(false);
    }
  });
});

describe('edge egress-budget close contract', () => {
  test('classification requires both exact wire fields', () => {
    expect(isEgressBudgetClose({ closeCode: 0x4d03, reason: 'egress-budget' })).toBe(true);
    expect(isEgressBudgetClose({ closeCode: 0, reason: 'egress-budget' })).toBe(false);
    expect(isEgressBudgetClose({ closeCode: 0x4d03, reason: 'other' })).toBe(false);
    expect(isEgressBudgetClose(undefined)).toBe(false);
  });
});
