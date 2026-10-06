import { describe, expect, test } from 'bun:test';
import { isIpAddress } from './ip-address';

describe('IP address contract', () => {
  test.each([
    '0.0.0.0',
    '192.0.2.10',
    '255.255.255.255',
    '::',
    '::1',
    '2001:db8::1',
    '::ffff:192.0.2.1',
  ])('accepts %s', (address) => {
    expect(isIpAddress(address)).toBe(true);
  });

  test.each([
    '',
    ' 192.0.2.1',
    '192.0.2.1 ',
    '01.2.3.4',
    '256.1.1.1',
    '127.1',
    'example.com',
    '[::1]',
    'fe80::1%lo0',
    '::d:',
    '7D0:9879::C:',
    '4fC3::7D33:',
    'not-an-ip',
    null,
    42,
  ])('rejects %s', (address) => {
    expect(isIpAddress(address)).toBe(false);
  });
});
