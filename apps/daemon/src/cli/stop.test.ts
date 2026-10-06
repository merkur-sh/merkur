import { describe, expect, test } from 'bun:test';

import { isMerkurProcessInfo, parseProcessInfo } from './stop';

describe('daemon stop process verification', () => {
  test('accepts the merkur executable name', () => {
    expect(
      isMerkurProcessInfo({
        command: '/Users/test/.bun/bin/merkur',
        args: 'merkur stop',
      }),
    ).toBe(true);
  });

  test('accepts local daemon source execution', () => {
    expect(
      isMerkurProcessInfo({
        command: '/Users/test/.bun/bin/bun',
        args: 'bun run --cwd apps/daemon src/index.ts',
      }),
    ).toBe(true);
  });

  test('rejects unrelated live processes', () => {
    expect(
      isMerkurProcessInfo({
        command: '/usr/bin/python3',
        args: 'python3 unrelated.py',
      }),
    ).toBe(false);
  });

  test('parses ps command and args output', () => {
    expect(
      parseProcessInfo('/Users/test/.bun/bin/bun bun run --cwd apps/daemon src/index.ts'),
    ).toEqual({
      command: '/Users/test/.bun/bin/bun',
      args: 'bun run --cwd apps/daemon src/index.ts',
    });
  });

  test('returns null for empty ps output', () => {
    expect(parseProcessInfo('\n')).toBeNull();
  });
});
