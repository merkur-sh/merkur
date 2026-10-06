import { describe, expect, test } from 'bun:test';

import { takeDaemonLinkCode } from './link-url';

function history(): {
  replaced: string[];
  replaceState(_data: unknown, _unused: string, url?: string | URL | null): void;
} {
  const replaced: string[] = [];
  return {
    replaced,
    replaceState(_data, _unused, url) {
      replaced.push(String(url));
    },
  };
}

describe('daemon link address', () => {
  test('takes the code from the fragment and rewrites the address to the root', () => {
    const recorded = history();
    const code = takeDaemonLinkCode(
      { pathname: '/link', hash: '#1b4e28ba-2fa1-11d2-883f-0016d3cca427.c2VjcmV0' },
      recorded,
    );
    expect(code).toBe('1b4e28ba-2fa1-11d2-883f-0016d3cca427.c2VjcmV0');
    expect(recorded.replaced).toEqual(['/']);
  });

  test('ignores every other path and leaves its address alone', () => {
    const recorded = history();
    expect(takeDaemonLinkCode({ pathname: '/', hash: '#abc' }, recorded)).toBeNull();
    expect(recorded.replaced).toEqual([]);
  });

  test('clears an empty /link address without opening an approval', () => {
    const recorded = history();
    expect(takeDaemonLinkCode({ pathname: '/link', hash: '' }, recorded)).toBeNull();
    expect(recorded.replaced).toEqual(['/']);
  });
});
