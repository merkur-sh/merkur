/** Script-only contract for archived source loaded by historicalWebGlPlugin.
 * There is no WebGL implementation in the current browser application.
 * Fallow cannot resolve these Bun virtual modules; .fallowrc.json exempts only
 * their two imported declarations, not the archived source or its consumers.
 */
declare module 'merkur-historical-webgl' {
  export class WebGl2Renderer {
    init(
      canvas: OffscreenCanvas,
      width: number,
      height: number,
      clear?: readonly [number, number, number],
    ): Promise<void>;
    uploadAtlas(
      pixels: Uint8Array,
      dirty: [number, number, number, number],
      dimensions: readonly [number, number],
    ): void;
    render(
      memory: ArrayBuffer,
      bg: { ptr: number; count: number },
      glyph: { ptr: number; count: number },
      deco: { ptr: number; count: number },
      cursor: { ptr: number; count: number },
      viewport: [number, number],
      versions?: import('../../apps/web/src/terminal-renderer').GeometryVersions,
    ): number;
    frameInFlight(): boolean;
    canSubmitFrame(): boolean;
    pollFrameComplete(): number;
    destroy(): void;
  }
}

declare module 'merkur-historical-task-poll' {
  export function createTaskPollScheduler(
    poll: (fromScheduledTask: boolean) => boolean,
    postTask: (token: number) => void,
  ): {
    schedule(): void;
    pollNow(): void;
    cancel(): void;
    handleTask(token: number): void;
  };
}
