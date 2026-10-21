/**
 * Two-finger touch scrolling, as wheel notches for the application under the
 * fingers: one notch per cell height the fingers travel, so the content keeps
 * pace with them, and a glide after they lift that decelerates the way a
 * UIKit scroll view does, so a flick carries on as it would anywhere else on
 * the phone.
 *
 * Positive notches scroll down (the fingers move up). Times are milliseconds
 * on one clock: touch event and animation frame timestamps both qualify.
 */

/** UIKit's `UIScrollView.DecelerationRate.normal`: the velocity kept per millisecond. */
const DECELERATION_PER_MS = 0.998;
const LN_DECELERATION = Math.log(DECELERATION_PER_MS);
/**
 * The recent movement a release velocity is fitted over: Android's
 * `VelocityTracker` horizon. Movement older than this does not describe the
 * finger at release, and a finger that rested longer than this lifts at rest.
 */
const VELOCITY_HORIZON_MS = 100;
/**
 * A resource bound: samples kept for the fit. Touch events arrive at most
 * once per 120 Hz frame, 12 per horizon; the ring holds them with room left.
 */
const VELOCITY_SAMPLES = 16;

export interface TouchScroll {
  /** Whether a glide is in progress after the fingers lifted. */
  readonly gliding: boolean;
  /** Two fingers touched down at `y`: any glide stops where it is. */
  begin(y: number, timeMs: number): void;
  /** The fingers moved to `y`: the notches the travel since the last call completes. */
  move(y: number, timeMs: number, cellHeight: number): number;
  /** The fingers lifted at `timeMs`: whether a glide follows. */
  release(timeMs: number, cellHeight: number): boolean;
  /** An animation frame at `timeMs` during a glide: the notches it completes. */
  glide(timeMs: number, cellHeight: number): number;
  /** Stop without a glide. */
  stop(): void;
}

export function createTouchScroll(): TouchScroll {
  const times = new Float64Array(VELOCITY_SAMPLES);
  const positions = new Float64Array(VELOCITY_SAMPLES);
  let samples = 0;
  let next = 0;
  let lastY = 0;
  /** Travel since the gesture began, the fitted position. */
  let travel = 0;
  /** Travel not yet spent on a whole notch, signed. */
  let residual = 0;
  let gliding = false;
  let glideStartMs = 0;
  let glideVelocity = 0;
  /** How far the glide has carried the content so far. */
  let glided = 0;

  function sample(timeMs: number): void {
    times[next] = timeMs;
    positions[next] = travel;
    next = (next + 1) % VELOCITY_SAMPLES;
    samples = Math.min(VELOCITY_SAMPLES, samples + 1);
  }

  /** Least-squares velocity, in pixels per millisecond, of the samples within the horizon of `timeMs`. */
  function releaseVelocity(timeMs: number): number {
    let count = 0;
    let sumT = 0;
    let sumP = 0;
    for (let index = 0; index < samples; index += 1) {
      const t = times[index] ?? 0;
      if (timeMs - t > VELOCITY_HORIZON_MS) continue;
      count += 1;
      sumT += t;
      sumP += positions[index] ?? 0;
    }
    if (count < 2) return 0;
    const meanT = sumT / count;
    const meanP = sumP / count;
    let covariance = 0;
    let variance = 0;
    for (let index = 0; index < samples; index += 1) {
      const t = times[index] ?? 0;
      if (timeMs - t > VELOCITY_HORIZON_MS) continue;
      covariance += (t - meanT) * ((positions[index] ?? 0) - meanP);
      variance += (t - meanT) * (t - meanT);
    }
    return variance > 0 ? covariance / variance : 0;
  }

  /** Spend `distance` of travel on whole notches, keeping the remainder. */
  function spend(distance: number, cellHeight: number): number {
    if (!(cellHeight > 0)) return 0;
    residual += distance;
    const notches = Math.trunc(residual / cellHeight);
    residual -= notches * cellHeight;
    return notches;
  }

  /** How far the glide carries the content by `elapsedMs`: the integral of `v·dᵗ`. */
  function glideDistance(elapsedMs: number): number {
    return (glideVelocity * (DECELERATION_PER_MS ** elapsedMs - 1)) / LN_DECELERATION;
  }

  /** The glide's whole remaining distance, past what it has carried already. */
  function glideRemaining(): number {
    return -glideVelocity / LN_DECELERATION - glided;
  }

  return {
    get gliding() {
      return gliding;
    },

    begin(y, timeMs): void {
      gliding = false;
      lastY = y;
      travel = 0;
      residual = 0;
      samples = 0;
      next = 0;
      sample(timeMs);
    },

    move(y, timeMs, cellHeight): number {
      const distance = lastY - y;
      lastY = y;
      travel += distance;
      sample(timeMs);
      return spend(distance, cellHeight);
    },

    release(timeMs, cellHeight): boolean {
      glideVelocity = releaseVelocity(timeMs);
      glideStartMs = timeMs;
      glided = 0;
      samples = 0;
      // A glide that would never complete another notch is no glide.
      gliding = cellHeight > 0 && Math.abs(residual + glideRemaining()) >= cellHeight;
      if (!gliding) residual = 0;
      return gliding;
    },

    glide(timeMs, cellHeight): number {
      if (!gliding) return 0;
      const carried = glideDistance(Math.max(0, timeMs - glideStartMs));
      const notches = spend(carried - glided, cellHeight);
      glided = carried;
      // The glide ends once what is left of it cannot complete a notch.
      if (!(cellHeight > 0) || Math.abs(residual + glideRemaining()) < cellHeight) {
        gliding = false;
        residual = 0;
      }
      return notches;
    },

    stop(): void {
      gliding = false;
      residual = 0;
      samples = 0;
    },
  };
}
