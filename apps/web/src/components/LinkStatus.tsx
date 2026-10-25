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
  drawLinkReadout,
  drawLinkStrip,
  healthColor,
  IDLE_COLOR,
  LINK_STRIP_PITCH,
  type LinkReadoutFont,
  linkReadoutWidth,
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

const readoutFigure = (q: ConnectionQuality): string => {
  if (q.state !== 'ready') return stateLabel(q.state);
  const path = q.path === 'direct' ? 'Direct' : q.path === 'relay' ? 'Relay' : '';
  if (q.rttMs === null) return path || '—';
  return `${path ? `${path} · ` : ''}${Math.round(q.rttMs)}ms`;
};

const readoutColor = (q: ConnectionQuality): string =>
  q.state === 'ready' ? healthColor(q.rttMs, q.degraded) : IDLE_COLOR;

/**
 * The computed font of the readout canvas, whose classes size it like text.
 * Canvas fonts take no `font-size-adjust`, so the adjusted size is solved from
 * the measured x-height of the same family.
 */
function readReadoutFont(
  element: HTMLElement,
  ctx: OffscreenCanvasRenderingContext2D,
): LinkReadoutFont {
  const style = getComputedStyle(element);
  const base = Number.parseFloat(style.fontSize);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const adjust = Number.parseFloat(style.fontSizeAdjust.replace('ex-height', ''));
  ctx.font = `400 ${base}px ${style.fontFamily}`;
  const exRatio = ctx.measureText('x').actualBoundingBoxAscent / base;
  return {
    family: style.fontFamily,
    size: Number.isFinite(adjust) && exRatio > 0 ? (base * adjust) / exRatio : base,
    lineHeight: Number.isFinite(lineHeight) ? lineHeight : base * 1.25,
  };
}

interface Props {
  readonly session: Accessor<TerminalSession | null>;
  readonly width?: number;
  readonly height?: number;
  readonly density?: number;
  readonly reduced?: boolean;
}

/**
 * Sent above, received below; link RTT and the session total stay in words.
 * Both canvases are transferred to OffscreenCanvas and drawn here on the main
 * thread: an OffscreenCanvas commits its frame straight to the compositor,
 * while an element canvas, or changing text, marks its frame for display-list
 * rebuild. On Gecko a rebuilt display list flushes the terminal's worker
 * canvas, and a flush that lands just after the terminal presents publishes a
 * CPU copy of a swap-chain texture the GPU has not finished drawing — an older
 * terminal frame (docs/performance.md).
 */
const LinkStatus: Component<Props> = (props) => {
  let stripElement: HTMLCanvasElement | undefined;
  let readoutElement: HTMLCanvasElement | undefined;
  let stripSurface: OffscreenCanvas | null = null;
  let readoutSurface: OffscreenCanvas | null = null;
  const width = () => Math.max(2, props.width ?? 104);
  const height = () => Math.max(5, props.height ?? 22);
  const density = () => Math.max(2, props.density ?? LINK_STRIP_PITCH);
  const [quality, setQuality] = createSignal<ConnectionQuality>(IDLE_QUALITY);
  const [txBytes, setTxBytes] = createSignal(0);
  const [rxBytes, setRxBytes] = createSignal(0);
  const [motionReduced, setMotionReduced] = createSignal(false);
  const [mounted, setMounted] = createSignal(false);

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
      `${readoutFigure(quality())}. Traffic: sent above, received below. ` +
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
      if (!stripElement || !readoutElement) return;
      const stripCanvas = stripElement;
      const readoutCanvas = readoutElement;
      stripSurface ??= stripCanvas.transferControlToOffscreen();
      readoutSurface ??= readoutCanvas.transferControlToOffscreen();
      const strip = stripSurface;
      const readout = readoutSurface;
      const stripContext = strip.getContext('2d');
      const readoutContext = readout.getContext('2d');
      if (!stripContext || !readoutContext) return;
      const ctx = stripContext;
      const textCtx = readoutContext;
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
      let shownTotal = 0;
      let drawingDirty = true;
      let textDirty = true;
      let font: LinkReadoutFont | null = null;
      let textWidth = 0;
      let textHeight = 0;
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
        shownTotal = currentTx + currentRx;
        readoutDirty = false;
        readoutAt = at;
        textDirty = true;
      }

      function paintReadout(): void {
        font ??= readReadoutFont(readoutCanvas, textCtx);
        const figure = readoutFigure(currentQuality);
        const total = `Σ${formatBytes(shownTotal)}`;
        const nextWidth = linkReadoutWidth(textCtx, font, figure, total);
        const nextHeight = Math.ceil(font.lineHeight * 2);
        if (nextWidth !== textWidth || nextHeight !== textHeight) {
          textWidth = nextWidth;
          textHeight = nextHeight;
          readoutCanvas.style.width = `${textWidth}px`;
          readoutCanvas.style.height = `${textHeight}px`;
          readout.width = Math.max(1, Math.round(textWidth * pixelRatio));
          readout.height = Math.max(1, Math.round(textHeight * pixelRatio));
          textCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        }
        drawLinkReadout(textCtx, font, textWidth, figure, total, readoutColor(currentQuality));
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
            drawLinkStrip(ctx, w, h, pitch, series, readoutColor(currentQuality));
            drawingDirty = false;
          }
          if (readoutDirty && at - readoutAt >= READOUT_INTERVAL_MS) flushReadout(at);
          if (textDirty) {
            paintReadout();
            textDirty = false;
          }
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
          drawingDirty = drawingDirty || readoutColor(before) !== readoutColor(next);
          if (next.state !== before.state) {
            pendingTraffic = null;
            if (next.state === 'ready') series.clear();
            drawingDirty = true;
          }
          textDirty = textDirty || readoutFigure(before) !== readoutFigure(next);
          textDirty = textDirty || readoutColor(before) !== readoutColor(next);
          currentQuality = next;
          setQuality(next);
        }
        const totals = activeSession.getThroughput();
        observeTotals(totals.txBytes, totals.rxBytes);
        if (drawingDirty || textDirty) scheduler.invalidate();
      }

      function observeTraffic(snapshot: LinkActivitySnapshot): void {
        if (!visible || disposed) return;
        if (awaitingBaseline) {
          awaitingBaseline = false;
          currentTx = snapshot.txBytes;
          currentRx = snapshot.rxBytes;
          flushReadout(now());
          scheduler.invalidate();
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
          currentQuality = IDLE_QUALITY;
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
        // A breakpoint can change the readout's computed font.
        font = null;
        textWidth = 0;
        textDirty = true;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (pixelRatio !== dpr) {
          pixelRatio = dpr;
          strip.width = Math.max(1, Math.round(w * dpr));
          strip.height = Math.max(1, Math.round(h * dpr));
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawingDirty = true;
        }
        scheduler.invalidate();
      }
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);

      // The terminal screen may set no other text in the mono face, and a
      // canvas never asks for a font to load; measure again once it has.
      const fontsReady = (): void => {
        if (disposed) return;
        font = null;
        textWidth = 0;
        textDirty = true;
        scheduler.invalidate();
      };
      const family = getComputedStyle(readoutCanvas).fontFamily;
      void Promise.all([
        document.fonts.load(`400 12px ${family}`),
        document.fonts.load(`500 12px ${family}`),
      ]).then(fontsReady, fontsReady);

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
      observer.observe(stripCanvas);

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
          stripElement = canvas;
        }}
        class="block shrink-0"
        style={{ width: `${width()}px`, height: `${height()}px` }}
      />
      <canvas
        ref={(canvas) => {
          readoutElement = canvas;
        }}
        class="block shrink-0 font-mono text-[12px] leading-[1.25] frame:text-[14px]"
      />
    </div>
  );
};

export default LinkStatus;
