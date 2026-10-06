import { describe, expect, test } from 'bun:test';

import { createTerminalFontLoader } from './font-loader';
import type { TerminalFontFamily } from './fonts';

const FAMILY: TerminalFontFamily = {
  name: 'Test',
  boot: '/boot.ttf',
  regular: '/regular.ttf',
  bold: '/bold.ttf',
  italic: '/italic.ttf',
  boldItalic: '/bold-italic.ttf',
};

function buffer(marker: number): ArrayBuffer {
  return new Uint8Array([marker]).buffer;
}

describe('progressive terminal font loading', () => {
  test('an ownership cancellation aborts a never-resolving fetch', async () => {
    let underlyingAborted = false;
    let attempts = 0;
    const loader = createTerminalFontLoader((_url, _priority, signal) =>
      ++attempts === 1
        ? new Promise<ArrayBuffer>(() => {
            signal.addEventListener(
              'abort',
              () => {
                underlyingAborted = true;
              },
              { once: true },
            );
          })
        : Promise.resolve(buffer(9)),
    );
    const owner = new AbortController();
    const pending = loader.loadBlocking(FAMILY, owner.signal);
    await Promise.resolve();

    owner.abort(new Error('session epoch superseded font load'));

    await expect(pending).rejects.toThrow('session epoch superseded font load');
    expect(underlyingAborted).toBe(true);
    // An implementation that only waits for fetch rejection retains the hung
    // cache entry forever. The abandoned owner is evicted synchronously, so a
    // later authenticated epoch can load the same URL afresh.
    await expect(loader.loadBlocking(FAMILY)).resolves.toEqual(buffer(9));
    expect(attempts).toBe(2);
  });

  test('first-ready loading does not request or wait for style faces', async () => {
    const requested: string[] = [];
    const loader = createTerminalFontLoader(async (url) => {
      requested.push(url);
      if (url !== FAMILY.boot) {
        return new Promise<ArrayBuffer>(() => undefined);
      }
      return buffer(1);
    });

    const regular = await loader.loadBlocking(FAMILY);

    expect(requested).toEqual([FAMILY.boot]);
    expect(new Uint8Array(regular)[0]).toBe(1);
  });

  test('a background style failure does not invalidate the usable regular face', async () => {
    const loader = createTerminalFontLoader(async (url) => {
      if (url === FAMILY.bold) throw new Error('style unavailable');
      return buffer(url === FAMILY.boot ? 1 : 2);
    });

    const blocking = await loader.loadBlocking(FAMILY);
    await expect(loader.loadStyleFaces(FAMILY)).rejects.toThrow('style unavailable');

    expect(new Uint8Array(blocking)[0]).toBe(1);
    await expect(loader.loadBlocking(FAMILY)).resolves.toEqual(blocking);
  });

  test('deduplicates duplicate style URLs and the regular request', async () => {
    const calls = new Map<string, number>();
    const family: TerminalFontFamily = {
      ...FAMILY,
      italic: FAMILY.regular,
      boldItalic: FAMILY.bold,
    };
    const loader = createTerminalFontLoader(async (url) => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      return buffer(calls.size);
    });

    await Promise.all([loader.loadBlocking(family), loader.loadStyleFaces(family)]);

    // Two style slots pointing at the same URL collapse to one fetch. The boot
    // face is its own asset, so it is fetched separately from the styles.
    expect(calls).toEqual(
      new Map([
        [FAMILY.boot, 1],
        [FAMILY.bold, 1],
        [FAMILY.regular, 1],
      ]),
    );
  });

  test('evicts rejected URL requests so a later style update can recover', async () => {
    let boldAttempts = 0;
    const loader = createTerminalFontLoader(async (url) => {
      if (url === FAMILY.bold && ++boldAttempts === 1) throw new Error('temporary failure');
      return buffer(1);
    });

    await expect(loader.loadStyleFaces(FAMILY)).rejects.toThrow('temporary failure');
    await expect(loader.loadStyleFaces(FAMILY)).resolves.toHaveLength(3);
    expect(boldAttempts).toBe(2);
  });

  test('loads post-visible style faces serially at low network priority', async () => {
    const active: string[] = [];
    const observations: Array<{ url: string; priority: string; concurrent: number }> = [];
    const loader = createTerminalFontLoader(async (url, priority) => {
      observations.push({ url, priority, concurrent: active.length });
      active.push(url);
      await Promise.resolve();
      active.pop();
      return buffer(observations.length);
    });

    await loader.loadBlocking(FAMILY);
    await loader.loadStyleFaces(FAMILY);

    // The boot face is the blocking fetch. The style stage never touches it.
    expect(observations).toEqual([
      { url: FAMILY.boot, priority: 'high', concurrent: 0 },
      { url: FAMILY.bold, priority: 'low', concurrent: 0 },
      { url: FAMILY.italic, priority: 'low', concurrent: 0 },
      { url: FAMILY.boldItalic, priority: 'low', concurrent: 0 },
    ]);
  });
});
