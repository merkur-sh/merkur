import { describe, expect, test } from 'bun:test';

import { isReleaseVersionBehind } from './release-version';

describe('release version ordering', () => {
  test('reports an update only when the daemon is older', () => {
    expect(isReleaseVersionBehind('v0.1.19', 'v0.1.20')).toBe(true);
    expect(isReleaseVersionBehind('v0.9.99', 'v0.10.0')).toBe(true);
    expect(isReleaseVersionBehind('v1.99.99', 'v2.0.0')).toBe(true);
  });

  test('does not report an update for equal or newer daemons', () => {
    expect(isReleaseVersionBehind('v0.1.20', 'v0.1.20')).toBe(false);
    expect(isReleaseVersionBehind('v0.1.20', 'v0.1.19')).toBe(false);
    expect(isReleaseVersionBehind('v0.10.0', 'v0.9.99')).toBe(false);
    expect(isReleaseVersionBehind('v2.0.0', 'v1.99.99')).toBe(false);
  });

  test('fails closed when either version is absent or not an exact release', () => {
    expect(isReleaseVersionBehind(null, 'v0.1.20')).toBe(false);
    expect(isReleaseVersionBehind('v0.1.19', null)).toBe(false);
    expect(isReleaseVersionBehind('dev', 'v0.1.20')).toBe(false);
    expect(isReleaseVersionBehind('v0.1.19', 'dev')).toBe(false);
    expect(isReleaseVersionBehind('0.1.19', 'v0.1.20')).toBe(false);
    expect(isReleaseVersionBehind('v0.01.19', 'v0.1.20')).toBe(false);
    expect(isReleaseVersionBehind('v0.1.19-rc.1', 'v0.1.20')).toBe(false);
  });
});
