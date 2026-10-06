import type { OwnedAnimationFrame, OwnedTimeout } from '../lib/owned-scheduled-callback';
import {
  LINK_ACTIVITY_COLUMNS,
  LINK_ACTIVITY_INTERVAL_MS,
  type LinkActivitySnapshot,
} from '../transport/link-activity';

export const LINK_STRIP_PITCH = 3;
export const IDLE_COLOR = '#9899a1';
const HEALTH_COLORS = ['#3fca7f', '#e0a44f', '#ff6b74'] as const;
const BASELINE_COLOR = '#454550';
const TRAFFIC_SCALE_BYTES = 64;
const TRAFFIC_CEILING_BYTES = 65_536;
const TRAFFIC_LOG_SPAN = Math.log1p(TRAFFIC_CEILING_BYTES / TRAFFIC_SCALE_BYTES);

export function healthColor(rttMs: number | null, degraded: boolean): string {
  if (rttMs === null) return IDLE_COLOR;
  const bucket = rttMs <= 80 ? 0 : rttMs <= 250 ? 1 : 2;
  return HEALTH_COLORS[degraded && bucket === 0 ? 1 : bucket] ?? IDLE_COLOR;
}

/** Same fixed logarithmic scale in both directions; a burst cannot resize history. */
export function trafficHeight(bytes: number, span: number): number {
  if (bytes <= 0) return 0;
  return Math.min(
    span,
    Math.max(
      1,
      Math.round(1 + ((span - 1) * Math.log1p(bytes / TRAFFIC_SCALE_BYTES)) / TRAFFIC_LOG_SPAN),
    ),
  );
}

export interface LinkStripSeries {
  readonly txHeight: Uint8Array;
  readonly rxHeight: Uint8Array;
  clear(): void;
  load(snapshot: LinkActivitySnapshot, now: number, reduced: boolean): boolean;
}

/** Convert a worker snapshot once per visible frame, and retain only drawable pixels. */
export function createLinkStripSeries(columns: number, span: number): LinkStripSeries {
  const count = Math.max(1, Math.min(columns, LINK_ACTIVITY_COLUMNS));
  const txHeight = new Uint8Array(count);
  const rxHeight = new Uint8Array(count);
  const cachedBytes = new Float64Array(LINK_ACTIVITY_COLUMNS * 2);
  const cachedHeights = new Uint8Array(LINK_ACTIVITY_COLUMNS * 2);

  function height(bytes: number, slot: number): number {
    if (bytes === 0) return 0;
    if (cachedBytes[slot] !== bytes) {
      cachedBytes[slot] = bytes;
      cachedHeights[slot] = trafficHeight(bytes, span);
    }
    return cachedHeights[slot] ?? 0;
  }

  function clear(): void {
    txHeight.fill(0);
    rxHeight.fill(0);
  }

  return {
    txHeight,
    rxHeight,
    clear,
    load(snapshot, now, reduced): boolean {
      const newestTick = Math.max(snapshot.tick, Math.floor(now / LINK_ACTIVITY_INTERVAL_MS));
      let reducedTx = 0;
      let reducedRx = 0;
      let changed = false;
      for (let index = 0; index < count; index += 1) {
        const tick = newestTick - count + 1 + index;
        const slot = (tick % LINK_ACTIVITY_COLUMNS) * 2;
        const valid =
          tick >= 0 && tick <= snapshot.tick && tick > snapshot.tick - LINK_ACTIVITY_COLUMNS;
        const tx = valid ? (snapshot.buckets[slot] ?? 0) : 0;
        const rx = valid ? (snapshot.buckets[slot + 1] ?? 0) : 0;
        if (tx > 0 || rx > 0) {
          reducedTx = height(tx, slot);
          reducedRx = height(rx, slot + 1);
        }
        const nextTx = reduced ? (index === count - 1 ? reducedTx : 0) : height(tx, slot);
        const nextRx = reduced ? (index === count - 1 ? reducedRx : 0) : height(rx, slot + 1);
        changed = changed || nextTx !== txHeight[index] || nextRx !== rxHeight[index];
        txHeight[index] = nextTx;
        rxHeight[index] = nextRx;
      }
      return changed;
    },
  };
}

export function drawLinkStrip(
  ctx: Pick<CanvasRenderingContext2D, 'clearRect' | 'fillRect' | 'globalAlpha' | 'fillStyle'>,
  width: number,
  height: number,
  pitch: number,
  series: LinkStripSeries,
  color: string,
): void {
  const middle = Math.floor(height / 2);
  const columns = series.txHeight.length;
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = BASELINE_COLOR;
  ctx.fillRect(0, middle, width, 1);
  ctx.fillStyle = color;
  // Heights are quantized on observation. Paint does no scaling, sorting,
  // normalization, allocations, or path-dependent dimming.
  for (let index = 0; index < columns; index += 1) {
    const tx = series.txHeight[index] ?? 0;
    const rx = series.rxHeight[index] ?? 0;
    const x = index * pitch;
    if (tx > 0) ctx.fillRect(x, middle - tx, pitch - 1, tx);
    if (rx > 0) ctx.fillRect(x, middle + 1, pitch - 1, rx);
  }
}

interface LinkStripSchedulerOptions {
  readonly now: () => number;
  readonly timer: OwnedTimeout;
  readonly frame: OwnedAnimationFrame;
  /** Paint once and return the next text deadline, or null to park. */
  readonly paint: (atMs: number) => number | null;
}

/**
 * The worker owns the fast cadence. Main coalesces worker snapshots into one
 * animation frame; a text deadline paints straight from its timer, because a
 * total that settles needs no frame alignment and an idle session must not
 * spend an animation frame per heartbeat on it.
 */
export function createLinkStripScheduler(options: LinkStripSchedulerOptions): {
  invalidate(): void;
  at(deadline: number): void;
  pause(): void;
  resume(): void;
} {
  let active = false;
  let timerAt = Number.POSITIVE_INFINITY;

  function requestPaint(): void {
    if (active && !options.frame.isArmed()) options.frame.arm(paint);
  }

  function paintDue(): void {
    timerAt = Number.POSITIVE_INFINITY;
    paint();
  }

  function schedule(atMs: number): void {
    if (!active || options.frame.isArmed()) return;
    const remaining = atMs - options.now();
    if (remaining <= 0) {
      options.timer.cancel();
      paintDue();
    } else if (!options.timer.isArmed() || atMs < timerAt) {
      timerAt = atMs;
      options.timer.arm(paintDue, remaining);
    }
  }

  function paint(): void {
    if (!active) return;
    const expiresAt = options.paint(options.now());
    if (expiresAt !== null) schedule(expiresAt);
  }

  return {
    invalidate: requestPaint,
    at: schedule,
    pause(): void {
      active = false;
      options.timer.cancel();
      options.frame.cancel();
      timerAt = Number.POSITIVE_INFINITY;
    },
    resume(): void {
      active = true;
      this.invalidate();
    },
  };
}
