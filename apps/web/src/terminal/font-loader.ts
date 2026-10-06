import type { TerminalFontFamily } from './fonts';

export type TerminalStyleFontBuffers = readonly [
  bold: ArrayBuffer,
  italic: ArrayBuffer,
  boldItalic: ArrayBuffer,
];

/**
 * Which faces belong to each startup stage.
 *
 * This is loader policy rather than catalogue data, so it lives here and there
 * is exactly one description of it. Two divergent copies is how you end up
 * measuring one tier and fetching another.
 */
export function terminalBlockingFontUrls(fontFamily: TerminalFontFamily): readonly [boot: string] {
  return [fontFamily.boot];
}

/** Faces fetched after first paint, in promotion order. */
export function terminalPromotionFontUrls(fontFamily: TerminalFontFamily): readonly string[] {
  const urls = new Set([
    fontFamily.regular,
    fontFamily.bold,
    fontFamily.italic,
    fontFamily.boldItalic,
  ]);
  urls.delete(fontFamily.boot);
  return [...urls];
}

export interface TerminalFontLoader {
  /**
   * Load only the face required for first render. WASM parses it once and
   * clones the parsed font into the style slots.
   */
  loadBlocking(fontFamily: TerminalFontFamily, signal?: AbortSignal): Promise<ArrayBuffer>;
  /**
   * Begin fetching the full regular face without waiting for it.
   *
   * Called at init so the network request starts as early as it did when the
   * regular face was itself the blocking asset. That keeps an offline cold
   * start able to promote, and collapses the promotion window to roughly parse
   * time whenever the fetch has already landed.
   */
  prefetchRegular(fontFamily: TerminalFontFamily, signal?: AbortSignal): void;
  /** The full regular face, restoring the glyph coverage the boot face lacks. */
  loadRegular(fontFamily: TerminalFontFamily, signal?: AbortSignal): Promise<ArrayBuffer>;
  /**
   * Load the style faces sequentially at low network priority after
   * first-visible. This avoids a multi-megabyte burst competing with terminal
   * traffic. The regular face is deliberately absent: it is already parsed, and
   * re-fetching it here only to hand it back for a re-parse wastes both.
   */
  loadStyleFaces(
    fontFamily: TerminalFontFamily,
    signal?: AbortSignal,
  ): Promise<TerminalStyleFontBuffers>;
}

export type TerminalFontFetchPriority = 'high' | 'low';
export type TerminalFontBufferFetcher = (
  url: string,
  priority: TerminalFontFetchPriority,
  signal: AbortSignal,
) => Promise<ArrayBuffer>;

interface FontBufferRequest {
  readonly url: string;
  readonly promise: Promise<ArrayBuffer>;
  readonly controller: AbortController;
  abortableConsumers: number;
  hasUnabortableConsumer: boolean;
  pending: boolean;
}

export function createTerminalFontLoader(
  fetchBuffer: TerminalFontBufferFetcher = fetchTerminalFontBuffer,
): TerminalFontLoader {
  const buffersByUrl = new Map<string, FontBufferRequest>();

  function aborted(signal: AbortSignal): Promise<ArrayBuffer> {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error('terminal font load aborted'),
    );
  }

  function consume(request: FontBufferRequest, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal === undefined) {
      // This caller deliberately has no cancellation owner (startup/background
      // promotion). It keeps the shared fetch alive for every abortable waiter.
      request.hasUnabortableConsumer = true;
      return request.promise;
    }
    if (signal.aborted) return aborted(signal);

    request.abortableConsumers += 1;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      let active = true;
      const release = (): void => {
        if (!active) return;
        active = false;
        signal.removeEventListener('abort', onAbort);
        request.abortableConsumers -= 1;
        if (
          request.pending &&
          request.abortableConsumers === 0 &&
          !request.hasUnabortableConsumer
        ) {
          // Evict before aborting. Fetch normally rejects on abort, but a test
          // double, service-worker interception, or broken browser fetch can
          // ignore the signal forever; retaining that abandoned promise would
          // wedge every later request for the same family too.
          if (buffersByUrl.get(request.url) === request) buffersByUrl.delete(request.url);
          request.controller.abort(new Error('terminal font load has no owner'));
        }
      };
      const onAbort = (): void => {
        release();
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('terminal font load aborted'),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void request.promise.then(
        (buffer) => {
          if (!active) return;
          release();
          resolve(buffer);
        },
        (error: unknown) => {
          if (!active) return;
          release();
          reject(error);
        },
      );
    });
  }

  function loadUrl(
    url: string,
    priority: TerminalFontFetchPriority,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted === true) return aborted(signal);
    const cached = buffersByUrl.get(url);
    if (cached !== undefined) return consume(cached, signal);

    // Defer invocation so a synchronous test double failure follows the same
    // rejection/eviction path as fetch().
    const controller = new AbortController();
    const request: FontBufferRequest = {
      url,
      promise: Promise.resolve().then(() => fetchBuffer(url, priority, controller.signal)),
      controller,
      abortableConsumers: 0,
      hasUnabortableConsumer: false,
      pending: true,
    };
    buffersByUrl.set(url, request);
    void request.promise.then(
      () => {
        request.pending = false;
      },
      () => {
        request.pending = false;
        if (buffersByUrl.get(url) === request) buffersByUrl.delete(url);
      },
    );
    return consume(request, signal);
  }

  return {
    loadBlocking(fontFamily, signal): Promise<ArrayBuffer> {
      return loadUrl(fontFamily.boot, 'high', signal);
    },

    prefetchRegular(fontFamily, signal): void {
      // Rejections belong to whoever awaits `loadRegular`; swallow here so a
      // prefetch can never surface as an unhandled rejection.
      void loadUrl(fontFamily.regular, 'high', signal).catch(() => undefined);
    },

    loadRegular(fontFamily, signal): Promise<ArrayBuffer> {
      return loadUrl(fontFamily.regular, 'high', signal);
    },

    async loadStyleFaces(fontFamily, signal): Promise<TerminalStyleFontBuffers> {
      const bold = await loadUrl(fontFamily.bold, 'low', signal);
      const italic = await loadUrl(fontFamily.italic, 'low', signal);
      const boldItalic = await loadUrl(fontFamily.boldItalic, 'low', signal);
      return [bold, italic, boldItalic];
    },
  };
}

async function fetchTerminalFontBuffer(
  url: string,
  priority: TerminalFontFetchPriority,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { priority, signal } as RequestInit & {
    readonly priority: TerminalFontFetchPriority;
  });
  if (!response.ok) {
    throw new Error(`Failed to load terminal font ${url}: ${response.status}`);
  }
  return response.arrayBuffer();
}
