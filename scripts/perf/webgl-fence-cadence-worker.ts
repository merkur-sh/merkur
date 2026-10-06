import { createTaskPollScheduler } from 'merkur-historical-task-poll';
import { WebGl2Renderer } from 'merkur-historical-webgl';

export interface FenceCadenceRequest {
  readonly canvas: OffscreenCanvas;
  readonly samples: number;
  readonly warmups: number;
  readonly arm: 'production' | 'readback-diagnostic';
  readonly idleMs: number;
}

export interface FenceCadenceSample {
  readonly arm: 'production' | 'readback-diagnostic';
  readonly idleMs: number;
  readonly ordinal: number;
  readonly submitGapMs: number;
  readonly submitCpuMs: number;
  readonly readbackCpuMs: number;
  readonly endToObservedMs: number;
  readonly pollCount: number;
  readonly lastPollIntervalMs: number;
  /** The changed pixel was read back, yet the JS fence cache is still pending. */
  readonly unsignaledAfterReadback: boolean;
}

export interface FenceCadenceResult {
  readonly renderer: string;
  readonly contextAttributes: WebGLContextAttributes | null;
  readonly samples: readonly FenceCadenceSample[];
  readonly pixelOracle: readonly number[];
}

/**
 * Component experiment, not a terminal or input-to-photon benchmark. The
 * production renderer and fair fence-poll scheduler are unmodified. Synchronous
 * readback is a diagnostic control, never a proposed hot path. `finish` is not
 * used: Chromium intentionally implements it as another nonblocking flush.
 */
async function measure(request: FenceCadenceRequest): Promise<FenceCadenceResult> {
  const { canvas, samples, warmups, arm, idleMs } = request;
  const renderer = new WebGl2Renderer();
  let rendererInitialized = false;
  try {
    await renderer.init(canvas, 8, 8, [0, 0, 0]);
    rendererInitialized = true;
    const gl = canvas.getContext('webgl2');
    if (gl === null) throw new Error('production renderer has no WebGL2 context');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu: unknown = gl.getParameter(
      debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL,
    );
    if (typeof gpu !== 'string') throw new Error('WebGL renderer identity is unavailable');
    if (/SwiftShader|llvmpipe|software/iu.test(gpu))
      throw new Error(`hardware GPU required: ${gpu}`);
    const attributes = gl.getContextAttributes();
    const atlas = new Uint8Array(64);
    for (let i = 0; i < atlas.length; i += 1) atlas[i] = i % 8 < 4 ? 255 : 0;
    renderer.uploadAtlas(atlas, [0, 0, 8, 8], [8, 8]);

    const cols = 80;
    const rows = 24;
    const count = cols * rows;
    const storage = new Float32Array(count * 14 + 8);
    for (let i = 0; i < count; i += 1) {
      storage.set(
        [(i % cols) * 8, Math.floor(i / cols) * 16, 0, 0, 8, 16, 0, 0, 1, 1, 0.8, 0.6, 0.4, 1],
        i * 14,
      );
    }
    storage.set([320, 192, 8, 16, 0.2, 0.8, 0.3, 0], count * 14);
    const empty = { ptr: 0, count: 0 };
    const glyph = { ptr: 0, count };
    const cursor = { ptr: count * 14 * 4, count: 1 };
    const viewport: [number, number] = [canvas.width, canvas.height];
    const versions = {
      bg: 1,
      glyph: 1,
      deco: 1,
      cursor: 1,
      bgDirtyOffset: 0,
      bgDirtyCount: 0,
      glyphDirtyOffset: 0,
      glyphDirtyCount: 1,
      decoDirtyOffset: 0,
      decoDirtyCount: 0,
      cursorDirtyOffset: 0,
      cursorDirtyCount: 1,
    };
    const bounce = new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveFence: (() => void) | null = null;
    let rejectFence: ((error: Error) => void) | null = null;
    let submittedAt = 0;
    let previousPollAt = 0;
    let observedAt = 0;
    let pollCount = 0;
    const scheduler = createTaskPollScheduler(
      () => {
        try {
          pollCount += 1;
          if (performance.now() - submittedAt > 5_000) {
            throw new Error('production fence did not become observable within five seconds');
          }
          if (renderer.pollFrameComplete() === 0) {
            previousPollAt = performance.now();
            return false;
          }
          observedAt = performance.now();
          const resolve = resolveFence;
          resolveFence = null;
          rejectFence = null;
          resolve?.();
          return true;
        } catch (error) {
          const reject = rejectFence;
          resolveFence = null;
          rejectFence = null;
          reject?.(error instanceof Error ? error : new Error(String(error)));
          return true;
        }
      },
      (token) => bounce.port2.postMessage(token),
    );
    bounce.port1.onmessage = (event: MessageEvent<number>) => {
      timer = setTimeout(() => {
        timer = null;
        scheduler.handleTask(event.data);
      }, 1);
    };

    const results: FenceCadenceSample[] = [];
    const readbackPixel = new Uint8Array(4);
    let previousSubmitAt = performance.now();
    try {
      // Each population owns a fresh browser process and repeats one cadence.
      // Diagnostic readbacks must not keep the production arm's GPU/cache warm.
      for (let ordinal = -warmups; ordinal < samples; ordinal += 1) {
        if (idleMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, idleMs));
        // One changed glyph/cursor; retained geometry still draws the full
        // terminal, exactly as the production renderer does for small edits.
        versions.glyph += 1;
        versions.cursor += 1;
        storage[10] = versions.glyph % 2 === 0 ? 0.8 : 0.4;
        submittedAt = performance.now();
        const submitGapMs = submittedAt - previousSubmitAt;
        previousSubmitAt = submittedAt;
        renderer.render(storage.buffer, empty, glyph, empty, cursor, viewport, versions);
        const endAt = performance.now();
        if (!renderer.frameInFlight()) throw new Error('render produced no GPU fence');
        pollCount = 0;
        previousPollAt = endAt;
        let readbackCpuMs = 0;
        let unsignaledAfterReadback = false;
        let observedByDirectPoll = false;
        if (arm === 'readback-diagnostic') {
          const readbackAt = performance.now();
          gl.readPixels(1, canvas.height - 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, readbackPixel);
          readbackCpuMs = performance.now() - readbackAt;
          const expectedRed = versions.glyph % 2 === 0 ? 204 : 102;
          if (Math.abs((readbackPixel[0] ?? 0) - expectedRed) > 1 || readbackPixel[3] !== 255) {
            throw new Error('diagnostic readback did not contain the current changed glyph');
          }
          pollCount += 1;
          unsignaledAfterReadback = renderer.pollFrameComplete() === 0;
          if (unsignaledAfterReadback) previousPollAt = performance.now();
          else {
            observedAt = performance.now();
            observedByDirectPoll = true;
          }
        }
        if (!observedByDirectPoll) {
          await new Promise<void>((resolve, reject) => {
            resolveFence = resolve;
            rejectFence = reject;
            scheduler.schedule();
          });
        }
        if (ordinal >= 0)
          results.push({
            arm,
            idleMs,
            ordinal,
            submitGapMs,
            submitCpuMs: endAt - submittedAt,
            readbackCpuMs,
            endToObservedMs: observedAt - endAt,
            pollCount,
            lastPollIntervalMs: observedAt - previousPollAt,
            unsignaledAfterReadback,
          });
      }
      // Readback is deliberately outside all timed samples and only validates
      // the fixture/real GPU execution. It must never be an implicit fence arm.
      const pixel = new Uint8Array(4);
      renderer.render(storage.buffer, empty, glyph, empty, cursor, viewport, versions);
      gl.readPixels(1, canvas.height - 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (pixel[3] !== 255 || (pixel[0] ?? 0) < 90 || (pixel[1] ?? 0) < 140) {
        throw new Error(`glyph fixture did not render: ${Array.from(pixel).join(',')}`);
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL fixture raised a GL error');
      return {
        renderer: gpu,
        contextAttributes: attributes,
        samples: results,
        pixelOracle: Array.from(pixel),
      };
    } finally {
      scheduler.cancel();
      if (timer !== null) clearTimeout(timer);
      bounce.port1.close();
      bounce.port2.close();
    }
  } finally {
    // The parent always terminates this worker, including partial init failure.
    // Do not mask a missing-context error by destroying an uninitialized owner.
    if (rendererInitialized) renderer.destroy();
  }
}

self.onmessage = (event: MessageEvent<FenceCadenceRequest>) => {
  void measure(event.data).then(
    (result) => self.postMessage({ result }),
    (error: unknown) =>
      self.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
};
