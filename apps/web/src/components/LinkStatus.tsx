import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onSettled,
} from 'solid-js';
import { createOwnedAnimationFrame, createOwnedTimeout } from '../lib/owned-scheduled-callback';
import type { ConnectionQuality, LinkState } from '../session/session-state';
import {
  LINK_ACTIVITY_COLUMNS,
  type LinkActivitySnapshot,
  linkActivityNow,
} from '../transport/link-activity';
import type { TerminalSession } from '../transport-worker-client';
import {
  createLinkStripScheduler,
  createLinkStripSeries,
  drawLinkStrip,
  healthColor,
  IDLE_COLOR,
  LINK_STRIP_PITCH,
} from './link-strip';

const READOUT_INTERVAL_MS = 300;
const IDLE_QUALITY: ConnectionQuality = {
  rttMs: null,
  rttFloorMs: null,
  inputAckMs: null,
  inputAckSeq: 0,
  path: 'unknown',
  state: 'closed',
  degraded: false,
  resyncCount: 0,
  seq: 0,
};

const stateLabel = (state: LinkState): string => {
  if (state === 'relay-paused')
    return 'Relay paused for the month · direct connection works when available';
  if (state === 'relay-stopped') return 'Relay monthly budget exhausted';
  if (state === 'connecting') return 'Connecting';
  if (state === 'reconnecting' || state === 'dormant') return 'Reconnecting';
  return 'Disconnected';
};

const formatBytes = (n: number): string => {
  if (n < 1000) return `${n}B`;
  const scaled = n < 1_000_000 ? n / 1_000 : n < 1_000_000_000 ? n / 1_000_000 : n / 1_000_000_000;
  const unit = n < 1_000_000 ? 'kB' : n < 1_000_000_000 ? 'MB' : 'GB';
  return `${scaled < 100 ? scaled.toFixed(1) : Math.round(scaled)}${unit}`;
};

interface Props {
  readonly session: Accessor<TerminalSession | null>;
  readonly width?: number;
  readonly height?: number;
  readonly density?: number;
  readonly reduced?: boolean;
}

/** Sent above, received below; link RTT and the session total stay in words. */
const LinkStatus: Component<Props> = (props) => {
  let canvasEl: HTMLCanvasElement | undefined;
  const width = () => Math.max(2, props.width ?? 104);
  const height = () => Math.max(5, props.height ?? 22);
  const density = () => Math.max(2, props.density ?? LINK_STRIP_PITCH);
  const [quality, setQuality] = createSignal<ConnectionQuality>(IDLE_QUALITY);
  const [txBytes, setTxBytes] = createSignal(0);
  const [rxBytes, setRxBytes] = createSignal(0);
  const [motionReduced, setMotionReduced] = createSignal(false);
  const [mounted, setMounted] = createSignal(false);

  const readoutColor = createMemo(() => {
    const q = quality();
    return q.state === 'ready' ? healthColor(q.rttMs, q.degraded) : IDLE_COLOR;
  });
  const readoutFigure = createMemo((): string => {
    const q = quality();
    if (q.state !== 'ready') return stateLabel(q.state);
    const path = q.path === 'direct' ? 'Direct' : q.path === 'relay' ? 'Relay' : '';
    if (q.rttMs === null) return path || '—';
    return `${path ? `${path} · ` : ''}${Math.round(q.rttMs)}`;
  });
  const readoutLatency = createMemo(() => {
    const q = quality();
    return q.state === 'ready' && q.rttMs !== null ? Math.round(q.rttMs) : null;
  });
  const readoutUnit = createMemo(() =>
    quality().state === 'ready' && quality().rttMs !== null ? 'ms' : '',
  );
  const totalText = createMemo(() => `Σ${formatBytes(txBytes() + rxBytes())}`);
  const byteDescription = createMemo(
    () =>
      `Sent ${txBytes().toLocaleString()} B; received ${rxBytes().toLocaleString()} B; ` +
      `total ${(txBytes() + rxBytes()).toLocaleString()} B this session.`,
  );
  const recoveryDescription = createMemo(() =>
    quality().degraded ? ' Recent display recovery.' : '',
  );
  const description = createMemo(
    () =>
      `${readoutFigure()}${readoutUnit()}. Traffic: sent above, received below. ` +
      byteDescription() +
      recoveryDescription(),
  );

  onSettled(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = (): void => {
      setMotionReduced(motion.matches);
    };
    onMotionChange();
    motion.addEventListener('change', onMotionChange);

    setMounted(true);
    return () => motion.removeEventListener('change', onMotionChange);
  });

  createEffect(
    () =>
      mounted()
        ? ([
            width(),
            height(),
            density(),
            props.reduced ?? motionReduced(),
            props.session(),
          ] as const)
        : null,
    (configuration) => {
      if (configuration === null) return;
      const [w, h, pitch, reduced, session] = configuration;
      const element = canvasEl;
      if (!element) return;
      const canvas = element;
      const context = canvas.getContext('2d');
      if (!context) return;
      const ctx = context;
      const span = Math.max(1, Math.min(255, Math.floor((h - 1) / 2)));
      const columns = Math.min(LINK_ACTIVITY_COLUMNS, Math.max(1, Math.floor(w / pitch)));
      const series = createLinkStripSeries(columns, span);
      const now = linkActivityNow;
      const activeSession = session;
      let currentQuality = IDLE_QUALITY;
      let currentTx = 0;
      let currentRx = 0;
      let readoutAt = Number.NEGATIVE_INFINITY;
      let readoutDirty = false;
      let drawingDirty = true;
      let pendingTraffic: LinkActivitySnapshot | null = null;
      let awaitingBaseline = false;
      let offQuality: (() => void) | null = null;
      let offActivity: (() => void) | null = null;
      let intersecting = false;
      let visible = false;
      let disposed = false;
      let pixelRatio = 0;

      function flushReadout(at: number): void {
        setTxBytes(currentTx);
        setRxBytes(currentRx);
        readoutDirty = false;
        readoutAt = at;
      }

      const scheduler = createLinkStripScheduler({
        now,
        timer: createOwnedTimeout(
          (callback, delayMs) => setTimeout(callback, delayMs),
          (handle) => clearTimeout(handle),
        ),
        frame: createOwnedAnimationFrame(
          (callback) => requestAnimationFrame(callback),
          (handle) => cancelAnimationFrame(handle),
        ),
        paint(at) {
          const ready = currentQuality.state === 'ready';
          if (ready && pendingTraffic !== null) {
            drawingDirty = series.load(pendingTraffic, at, reduced) || drawingDirty;
          }
          pendingTraffic = null;
          if (drawingDirty) {
            drawLinkStrip(
              ctx,
              w,
              h,
              pitch,
              series,
              ready ? healthColor(currentQuality.rttMs, currentQuality.degraded) : IDLE_COLOR,
            );
            drawingDirty = false;
          }
          if (readoutDirty && at - readoutAt >= READOUT_INTERVAL_MS) flushReadout(at);
          return readoutDirty ? readoutAt + READOUT_INTERVAL_MS : null;
        },
      });

      function observeTotals(tx: number, rx: number): void {
        if (tx === currentTx && rx === currentRx) return;
        currentTx = tx;
        currentRx = rx;
        readoutDirty = true;
        scheduler.at(readoutAt + READOUT_INTERVAL_MS);
      }

      function observeQuality(): void {
        if (!visible || disposed || activeSession === null) return;
        const next = activeSession.getConnectionQuality();
        const before = currentQuality;
        const changed =
          next.rttMs !== before.rttMs ||
          next.path !== before.path ||
          next.state !== before.state ||
          next.degraded !== before.degraded;
        if (changed) {
          const beforeColor =
            before.state === 'ready' ? healthColor(before.rttMs, before.degraded) : IDLE_COLOR;
          const afterColor =
            next.state === 'ready' ? healthColor(next.rttMs, next.degraded) : IDLE_COLOR;
          drawingDirty = drawingDirty || beforeColor !== afterColor;
          if (next.state !== before.state) {
            pendingTraffic = null;
            if (next.state === 'ready') series.clear();
            drawingDirty = true;
          }
          currentQuality = next;
          setQuality(next);
        }
        const totals = activeSession.getThroughput();
        observeTotals(totals.txBytes, totals.rxBytes);
        if (drawingDirty) scheduler.invalidate();
      }

      function observeTraffic(snapshot: LinkActivitySnapshot): void {
        if (!visible || disposed) return;
        if (awaitingBaseline) {
          awaitingBaseline = false;
          currentTx = snapshot.txBytes;
          currentRx = snapshot.rxBytes;
          flushReadout(now());
        } else observeTotals(snapshot.txBytes, snapshot.rxBytes);
        if (currentQuality.state === 'ready') {
          pendingTraffic = snapshot;
          scheduler.invalidate();
        }
      }

      function detach(): void {
        offQuality?.();
        offActivity?.();
        offQuality = null;
        offActivity = null;
        pendingTraffic = null;
      }

      function attach(): void {
        const session = activeSession;
        if (!visible || disposed) return;
        if (session === null) {
          setQuality(IDLE_QUALITY);
          flushReadout(now());
          return;
        }
        observeQuality();
        flushReadout(now());
        offQuality = session.onConnectionQualityChange(observeQuality);
        awaitingBaseline = true;
        offActivity = session.onTransportActivity(observeTraffic, columns);
      }

      function resizeCanvas(): void {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (pixelRatio === dpr) return;
        pixelRatio = dpr;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawingDirty = true;
        scheduler.invalidate();
      }
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);

      function updateVisibility(): void {
        const next = intersecting && !document.hidden;
        if (next === visible || disposed) return;
        visible = next;
        if (!visible) {
          detach();
          scheduler.pause();
          return;
        }
        series.clear();
        drawingDirty = true;
        attach();
        scheduler.resume();
      }
      document.addEventListener('visibilitychange', updateVisibility);
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          intersecting = entry.isIntersecting;
          updateVisibility();
        }
      });
      observer.observe(canvas);

      return () => {
        disposed = true;
        detach();
        scheduler.pause();
        observer.disconnect();
        document.removeEventListener('visibilitychange', updateVisibility);
        window.removeEventListener('resize', resizeCanvas);
      };
    },
  );

  return (
    <div
      class="flex shrink-0 items-center gap-2.5"
      role="img"
      aria-label={description()}
      title={description()}
    >
      <canvas
        ref={(canvas) => {
          canvasEl = canvas;
        }}
        class="block shrink-0"
        style={{ width: `${width()}px`, height: `${height()}px` }}
      />
      <div
        class="flex flex-col justify-center overflow-hidden font-mono text-[12px] leading-[1.25] tabular-nums frame:text-[14px]"
        aria-hidden="true"
      >
        <span
          class="inline-block min-w-[15ch] whitespace-nowrap font-medium"
          style={{ color: readoutColor() }}
        >
          {readoutLatency() === null ? (
            readoutFigure()
          ) : (
            <>
              {quality().path === 'direct'
                ? 'Direct · '
                : quality().path === 'relay'
                  ? 'Relay · '
                  : ''}
              <span class="inline-block min-w-[6ch]">
                {readoutLatency()}
                <span>{readoutUnit()}</span>
              </span>
            </>
          )}
        </span>
        <span class="whitespace-nowrap text-meta">{totalText()}</span>
      </div>
    </div>
  );
};

export default LinkStatus;
