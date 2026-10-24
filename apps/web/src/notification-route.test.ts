import { describe, expect, test } from 'bun:test';
import {
  machineNotificationPath,
  notificationMachineId,
  notificationTarget,
} from './notification-route';

describe('notification destination', () => {
  test('round-trips an exact machine identity through a fragment', () => {
    const id = 'machine/with a?#name';
    const url = new URL(machineNotificationPath(id), 'https://app.merkur.test');
    expect(notificationMachineId(url.hash)).toBe(id);
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
  });

  test('refuses external, credential-bearing, malformed and unrelated destinations', () => {
    for (const path of [
      'https://other.test/#machine=machine-b',
      '//other.test/#machine=machine-b',
      'https://user@app.merkur.test/#machine=machine-b',
      '/privacy#machine=machine-b',
      '/?machine=machine-b',
      '/#machine=',
      '/#machine=%ZZ',
      '/#machine=machine-b&next=machine-c',
      '/#unrelated',
      'javascript:alert(1)',
    ]) {
      expect(notificationTarget(path, 'https://app.merkur.test')).toBeNull();
    }
    expect(notificationTarget('/', 'https://app.merkur.test')?.href).toBe(
      'https://app.merkur.test/',
    );
  });
});
