import { createOrbAnimation, createOrbSurface, ORB_REST_TIME } from '@merkur/quicksilver/orb';

/**
 * The live orb on `/privacy` and `/terms`. Those pages are plain documents
 * outside the app shell, so this is their only script, built as the stable
 * `/legal/orb.js` beside them (`vite.config.ts`). Every `canvas[data-orb]`
 * draws the same shader the app's `MerkurOrb` draws, at the CSS size its
 * `data-orb` names.
 *
 * It animates only while the canvas is in view and the tab is visible, and
 * under reduced motion it draws the rest frame once. A browser without WebGL2
 * leaves the canvas empty, which is how the app's own orb behaves.
 */

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-orb]')) {
  const size = Number(canvas.dataset.orb);
  if (!Number.isFinite(size) || size <= 0) continue;
  const created = createOrbSurface(canvas, size, window.devicePixelRatio);
  if (!created.ok) continue;
  const { surface } = created;

  if (reduced) {
    surface.draw(ORB_REST_TIME);
    continue;
  }

  let handle = 0;
  let armed = false;
  const animation = createOrbAnimation(
    surface,
    {
      arm: (frame) => {
        if (armed) cancelAnimationFrame(handle);
        armed = true;
        handle = requestAnimationFrame(() => {
          armed = false;
          frame();
        });
      },
      cancel: () => {
        if (armed) cancelAnimationFrame(handle);
        armed = false;
      },
    },
    () => performance.now(),
  );

  let intersecting = false;
  const sync = (): void => animation.setRunning(intersecting && !document.hidden);
  new IntersectionObserver(
    (entries) => {
      for (const entry of entries) intersecting = entry.isIntersecting;
      sync();
    },
    { threshold: 0.05 },
  ).observe(canvas);
  document.addEventListener('visibilitychange', sync);
}
