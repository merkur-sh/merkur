/**
 * The page's render worker: every WebGL context and every animation frame
 * the site asks for live here, off the thread that scrolls and types.
 *
 * One frame loop serves every renderer, and it only runs while a surface is
 * on screen: when the page reports the last one gone the loop ends, and
 * nothing in this worker wakes until one comes back.
 */
import { createBoxesRenderer } from './boxes';
import { createMarkRenderer } from './marks';
import { createOrbRenderer } from './orb';
import { createPlanetRenderer } from './planet';
import type { FromWorker, PlanetInit, RetrogradeSky, ToWorker } from './protocol';
import { createRetrogradeRenderer } from './retrograde';

export interface Renderer {
  /** The least time between two of its frames. */
  readonly minFrameMs: number;
  wantsFrames(): boolean;
  draw(now: number): void;
}

/** What the page can tell one surface. */
interface Surface {
  setVisible(on: boolean): void;
  pointer?(at: readonly [number, number] | null): void;
  drag?(phase: 'start' | 'move' | 'end', dx: number, dy: number): void;
  turn?(by: number): void;
  fit?(width: number, height: number, planet: PlanetInit | null): void;
  lay?(width: number, height: number, sky: RetrogradeSky): void;
}

/** The orb the retrograde sky carries, in device pixels: its 36 CSS pixels at 2x. */
const SKY_ORB_PIXELS = 72;

const renderers = new Map<Renderer, number>();
const surfaces = new Map<number, Surface>();
const say = (message: FromWorker): void => postMessage(message);

let frame = 0;
function loop(now: number): void {
  frame = 0;
  let wanted = false;
  for (const [renderer, last] of renderers) {
    if (!renderer.wantsFrames()) continue;
    wanted = true;
    if (now - last < renderer.minFrameMs) continue;
    renderers.set(renderer, now);
    renderer.draw(now);
  }
  if (wanted) frame = requestAnimationFrame(loop);
}
const wake = (): void => {
  if (frame === 0) frame = requestAnimationFrame(loop);
};
const run = <T extends Renderer>(renderer: T): T => {
  renderers.set(renderer, 0);
  return renderer;
};

const orbIds = new Map<OffscreenCanvas, number>();
const orbs = run(
  createOrbRenderer((canvas) => {
    const id = orbIds.get(canvas);
    if (id !== undefined) say({ type: 'drawn', id });
  }),
);
const marks = run(createMarkRenderer((id) => say({ type: 'drawn', id })));

addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'add') {
    const { id, canvas, init } = message;
    if (init.kind === 'orb') {
      orbIds.set(canvas, id);
      surfaces.set(id, orbs.add(canvas));
    } else if (init.kind === 'mark') {
      surfaces.set(id, marks.add(id, canvas, init.mask, init.seed));
    } else if (init.kind === 'boxes') {
      surfaces.set(id, run(createBoxesRenderer(canvas, () => say({ type: 'drawn', id }))));
    } else if (init.kind === 'retrograde') {
      // The sky's orb is one more copy of the page's one orb, drawn before the sky is.
      const orb = new OffscreenCanvas(SKY_ORB_PIXELS, SKY_ORB_PIXELS);
      const carried = orbs.add(orb);
      const sky = run(
        createRetrogradeRenderer(
          canvas,
          init.sky,
          orb,
          () => say({ type: 'drawn', id }),
          (on) => say({ type: 'backwards', id, on }),
        ),
      );
      surfaces.set(id, {
        setVisible(on) {
          carried.setVisible(on);
          sky.setVisible(on);
        },
        lay: sky.lay,
      });
    } else {
      surfaces.set(id, run(createPlanetRenderer(canvas, init, () => say({ type: 'drawn', id }))));
    }
    return;
  }
  const surface = surfaces.get(message.id);
  if (surface === undefined) throw new Error(`site: no surface ${message.id}`);
  if (message.type === 'visible') surface.setVisible(message.on);
  else if (message.type === 'pointer') surface.pointer?.(message.at);
  else if (message.type === 'turn') surface.turn?.(message.by);
  else if (message.type === 'fit') surface.fit?.(message.width, message.height, message.planet);
  else if (message.type === 'lay') surface.lay?.(message.width, message.height, message.sky);
  else surface.drag?.(message.phase, message.dx, message.dy);
  wake();
});
