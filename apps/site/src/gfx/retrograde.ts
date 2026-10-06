/**
 * The orb's trip along its line, on the page for an address with nothing at
 * it: it crosses from one edge, climbs the loop, backs up, and carries on off
 * the far edge, then sets out again.
 *
 * The page keeps what stands still, the stars and the dotted line, as markup.
 * This draws only what moves, over them: the loop lighting as the orb passes,
 * the orb's tail, and the orb itself, copied from the one render every orb on
 * the page shares (`orb.ts`). Its first frame is the page's still, the orb at
 * the top of the loop, so the canvas takes over without a jump.
 */
import type { RetrogradeSky } from './protocol';
import { ORBIT, sampleAt, TAIL_SAMPLES, tailWeight } from './retrograde-orbit';
import type { Renderer } from './worker';

/** The loop's light, as the stylesheet sets it on the still (`.retro-lit`). */
const LIT = 'rgba(203, 166, 247, 0.9)';
const LIT_GLOW = 'rgba(203, 166, 247, 0.7)';
const LIT_GLOW_BLUR = 5;
/** The orb's glow, as the stylesheet sets it on the still (`.retro-orb`): half the orb's width. */
const ORB_GLOW = 'rgba(127, 90, 240, 0.6)';

/** The tail's stroke for each sample back from its faint end. */
const TAIL_STYLES = Array.from(
  { length: TAIL_SAMPLES + 1 },
  (_, behind) => `rgba(248, 248, 252, ${tailWeight(behind) * 0.95})`,
);
const TAIL_WIDTHS = Array.from(
  { length: TAIL_SAMPLES + 1 },
  (_, behind) => 0.6 + tailWeight(behind) * 2.2,
);

export interface RetrogradeRenderer extends Renderer {
  setVisible(on: boolean): void;
  /** The layout gave the line a new place and the canvas a new size in device pixels. */
  lay(width: number, height: number, sky: RetrogradeSky): void;
}

export function createRetrogradeRenderer(
  canvas: OffscreenCanvas,
  first: RetrogradeSky,
  orb: OffscreenCanvas,
  drawn: () => void,
  backwards: (on: boolean) => void,
): RetrogradeRenderer {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('site: the retrograde sky has no 2D context');
  const samples = ORBIT.time.length;
  const xs = new Float64Array(samples);
  const ys = new Float64Array(samples);
  let sky = first;
  const place = (): void => {
    for (let index = 0; index < samples; index += 1) {
      xs[index] = sky.left + (ORBIT.across[index] ?? 0) * sky.run;
      ys[index] = sky.level - (ORBIT.lift[index] ?? 0) * sky.rise;
    }
  };
  place();

  let started = -1;
  let visible = false;
  let announced = false;
  // The still shows the orb past the point where it turns back.
  let goingBack = true;

  return {
    minFrameMs: 0,
    wantsFrames: () => visible,
    setVisible(on) {
      visible = on;
    },
    lay(width, height, next) {
      canvas.width = width;
      canvas.height = height;
      sky = next;
      place();
    },
    draw(now) {
      if (started < 0) started = now;
      const at = ((ORBIT.time[ORBIT.top] ?? 0) + (now - started) / 1000) % ORBIT.duration;
      const reached = sampleAt(at);
      // The orb is between two samples for most of a frame.
      const next = Math.min(reached + 1, samples - 1);
      const reachedAt = ORBIT.time[reached] ?? 0;
      const step = (ORBIT.time[next] ?? 0) - reachedAt;
      const part = step > 0 ? (at - reachedAt) / step : 0;
      const fromX = xs[reached] ?? 0;
      const fromY = ys[reached] ?? 0;
      const headX = fromX + ((xs[next] ?? 0) - fromX) * part;
      const headY = fromY + ((ys[next] ?? 0) - fromY) * part;

      const { scale } = sky;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, canvas.width / scale, canvas.height / scale);
      context.lineCap = 'round';
      context.lineJoin = 'round';

      // The loop, lit as far as the orb has come, and for the rest of this trip.
      if (reached >= ORBIT.loopFrom - 1) {
        context.shadowColor = LIT_GLOW;
        context.shadowBlur = LIT_GLOW_BLUR * scale;
        context.strokeStyle = LIT;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(xs[ORBIT.loopFrom - 1] ?? 0, ys[ORBIT.loopFrom - 1] ?? 0);
        const lit = Math.min(reached, ORBIT.loopTo);
        for (let index = ORBIT.loopFrom; index <= lit; index += 1) {
          context.lineTo(xs[index] ?? 0, ys[index] ?? 0);
        }
        if (reached < ORBIT.loopTo) context.lineTo(headX, headY);
        context.stroke();
        context.shadowColor = 'transparent';
        context.shadowBlur = 0;
      }

      // The tail: each step brighter and wider than the one behind it.
      const faintEnd = reached - TAIL_SAMPLES;
      for (let index = Math.max(1, faintEnd + 1); index <= reached; index += 1) {
        context.strokeStyle = TAIL_STYLES[index - faintEnd] ?? '';
        context.lineWidth = TAIL_WIDTHS[index - faintEnd] ?? 0;
        context.beginPath();
        context.moveTo(xs[index - 1] ?? 0, ys[index - 1] ?? 0);
        context.lineTo(xs[index] ?? 0, ys[index] ?? 0);
        context.stroke();
      }
      context.strokeStyle = TAIL_STYLES[TAIL_SAMPLES] ?? '';
      context.lineWidth = TAIL_WIDTHS[TAIL_SAMPLES] ?? 0;
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(headX, headY);
      context.stroke();

      context.shadowColor = ORB_GLOW;
      context.shadowBlur = (sky.orb / 2) * scale;
      context.imageSmoothingQuality = 'high';
      context.drawImage(orb, headX - sky.orb / 2, headY - sky.orb / 2, sky.orb, sky.orb);
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;

      const back = reached >= ORBIT.firstBackwards;
      if (back !== goingBack) {
        goingBack = back;
        backwards(back);
      }
      if (!announced) {
        announced = true;
        drawn();
      }
    },
  };
}
