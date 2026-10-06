import { createLogger } from '@merkur/logger';
import {
  createOrbAnimation,
  createOrbSurface,
  ORB_REST_TIME,
  type OrbFailure,
} from '@merkur/quicksilver/orb';
import { type Component, createEffect, onSettled } from 'solid-js';

import { prefersReducedMotion } from '../lib/motion';
import { createOwnedAnimationFrame } from '../lib/owned-scheduled-callback';
import { useViewShown } from './view-visibility';

/**
 * The mark: a raymarched machined-metal sphere, reflecting a three-lobe
 * environment through a lathe-grooved surface, tone-mapped with ACES and
 * dithered so the gradient across it has no banding. The shader, its constants
 * and its clock live in `@merkur/quicksilver/orb`, shared with the legal pages;
 * this component adds the app's half of "on screen".
 *
 * It appears in exactly three places — the boot splash, sign-in, and the top
 * left of the machine list — at one intensity. It is never a gauge: it does not
 * read round trip, relay state or loss, and it is never shown on the terminal
 * screen where those facts live.
 *
 * Lightweight: throttled to ~40fps, and animating only while it is actually on
 * screen, which takes two facts. Geometry (an IntersectionObserver) says
 * whether the canvas is scrolled into the viewport. The route
 * (`ViewShownContext`) says whether the screen it sits on is showing, because
 * every route stays mounted: the machine list is still in the document behind
 * a connected terminal, at opacity zero, and still intersects the viewport, so
 * geometry alone kept this shader drawing under the terminal for the whole
 * session. A captured frame of this shader ships as `.orb-rest`, for the two
 * places that need the orb before the shader can draw it: the boot splash in
 * `index.html`, which cannot run a shader at all, and `SplashScreen`, which
 * hands over to this canvas while it is still warming up. Both sit on the page
 * background the still was flattened onto, which is why neither is `class`
 * applied here by default — anywhere else it would lay a slightly wrong ground
 * under a transparent canvas.
 */

const logger = createLogger('web');

/** The warning each way of failing to draw has always logged. */
function warnOrbFailure(failure: OrbFailure): void {
  switch (failure.reason) {
    case 'webgl2-unavailable':
      logger.warn('MerkurOrb: WebGL2 unavailable, orb will not render');
      return;
    case 'shader-compile-failed':
      logger.warn('MerkurOrb: shader compile failed', { log: failure.log });
      return;
    case 'program-build-failed':
      logger.warn('MerkurOrb: failed to build shader program');
      return;
    case 'program-link-failed':
      logger.warn('MerkurOrb: program link failed', { log: failure.log });
      return;
    case 'geometry-buffers-unavailable':
      logger.warn('MerkurOrb: failed to allocate geometry buffers');
      return;
  }
}

interface Props {
  readonly size?: number;
  readonly reduced?: boolean;
  readonly class?: string;
}

const MerkurOrb: Component<Props> = (props) => {
  let canvasEl!: HTMLCanvasElement;

  const size = () => props.size ?? 16;
  const reduced = () => props.reduced ?? prefersReducedMotion();

  // The route half of "on screen". Read into a plain value and applied through
  // `syncRunning`, which the settled canvas installs: the effect lives at
  // component scope (an effect created inside `onSettled` stops reactive setup
  // in development) and the canvas does not exist when it first runs.
  const viewShown = useViewShown();
  let layerShown = viewShown();
  let syncRunning: (() => void) | null = null;
  createEffect(
    () => viewShown(),
    (value) => {
      layerShown = value;
      syncRunning?.();
    },
  );

  onSettled(() => {
    const created = createOrbSurface(canvasEl, size(), window.devicePixelRatio);
    if (!created.ok) {
      warnOrbFailure(created.failure);
      return;
    }
    const { surface } = created;

    if (reduced()) {
      surface.draw(ORB_REST_TIME);
      return surface.destroy;
    }

    const raf = createOwnedAnimationFrame(
      (callback) => requestAnimationFrame(callback),
      (handle) => cancelAnimationFrame(handle),
    );
    const animation = createOrbAnimation(
      surface,
      { arm: (frame) => raf.arm(frame), cancel: () => raf.cancel() },
      () => performance.now(),
    );
    let intersecting = false;

    // Both facts, one decision. Runs when either changes; the animation frame
    // is armed exactly while the mark is on a showing screen and in view.
    const sync = (): void => animation.setRunning(intersecting && layerShown);
    syncRunning = sync;

    // Delivers the initial entry as well, so the animation starts from here.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) intersecting = entry.isIntersecting;
        sync();
      },
      { threshold: 0.05 },
    );
    observer.observe(canvasEl);

    return () => {
      syncRunning = null;
      animation.stop();
      observer.disconnect();
      surface.destroy();
    };
  });

  return (
    // Only the measured size stays inline. Solid hoists the constant half of a
    // `style` object into the template's HTML attribute, which `style-src 'self'`
    // drops, so `position`/`flex-shrink`/`display`/`z-index` have to be classes
    // to survive in a production build.
    <div
      class={`relative shrink-0 ${props.class ?? ''}`}
      aria-hidden="true"
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <canvas
        ref={canvasEl}
        class="relative z-1 block"
        style={{ width: `${size()}px`, height: `${size()}px` }}
      />
    </div>
  );
};

export default MerkurOrb;
