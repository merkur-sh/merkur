import { resolveKeyboardBehavior } from './behavior';
import { createKeyboardEngine, type KeyboardEngine } from './engine';
import {
  CUPERTINO_LANDSCAPE_PROFILE,
  CUPERTINO_PORTRAIT_PROFILE,
  keyboardOrientation,
  solveKeyboardGeometry,
} from './geometry';
import { createKeyboardLayout } from './layout';
import type {
  KeyboardBehaviorOptions,
  KeyboardCommit,
  KeyboardGeometryProfile,
  KeyboardKeyDefinition,
  KeyboardLabelResolver,
  KeyboardLayout,
  KeyboardProfileContext,
  KeyboardProfileResolver,
  KeyboardTheme,
  KeyboardTouchModel,
  KeyboardTouchModelResolver,
  KeyboardTouchTrace,
  ResolvedKeyboardBehavior,
  ResolvedKeyboardGeometry,
  ResolvedKeyboardKey,
} from './types';

export interface DomKeyboardOptions {
  readonly layout: KeyboardLayout;
  readonly initialLayer?: string;
  readonly profile?: KeyboardGeometryProfile | KeyboardProfileResolver;
  readonly behavior?: KeyboardBehaviorOptions;
  readonly activeModifiers?: readonly string[];
  readonly theme?: KeyboardTheme;
  readonly labelResolver?: KeyboardLabelResolver;
  readonly touchModel?: KeyboardTouchModel | KeyboardTouchModelResolver;
  /** Build inactive layer geometry during idle periods so the first switch cannot block input. */
  readonly prewarmLayers?: boolean;
  /** Optional development telemetry; omitted from the hot path when undefined. */
  readonly onPerformanceSample?: (sample: KeyboardPerformanceSample) => void;
  /** Minimal allocation-free semantic callback for latency-sensitive adapters. */
  readonly onKey?: (
    key: KeyboardKeyDefinition,
    value: string | undefined,
    pointerId: number,
    /** Touch-down timestamp in the caller's event time base, not an elapsed duration. */
    contactAtMs: number,
    repeat: boolean,
  ) => void;
  /** Provisional pointer intent for immediate local feedback; never a commit. */
  readonly onProvisionalKey?: (
    key: KeyboardKeyDefinition | null,
    value: string | undefined,
    pointerId: number,
  ) => void;
  /** Rich pointer metadata; creates one event object per committed key. */
  readonly onKeyCommit?: (commit: KeyboardCommit) => void;
  readonly onTouchTrace?: (trace: KeyboardTouchTrace) => void;
  readonly onLayerChange?: (layerId: string) => void;
}

export type KeyboardPerformancePhase =
  | 'geometry-build'
  | 'geometry-prewarm'
  | 'pointerdown-handler'
  | 'pointerup-handler'
  | 'pressed-next-frame';

export interface KeyboardPerformanceSample {
  readonly phase: KeyboardPerformancePhase;
  readonly layerId: string;
  readonly durationMs: number;
  readonly pointerId?: number;
  /** Time between browser event generation and handler entry, when timestamps share a time origin. */
  readonly inputDelayMs?: number;
}

export interface DomKeyboardController {
  getLayer(): string;
  getGeometry(): ResolvedKeyboardGeometry | null;
  setLayer(layerId: string): void;
  setLayout(layout: KeyboardLayout, initialLayer?: string): void;
  setProfile(profile: KeyboardGeometryProfile | KeyboardProfileResolver): void;
  setBehavior(behavior: KeyboardBehaviorOptions): void;
  setTouchModel(model: KeyboardTouchModel | KeyboardTouchModelResolver | undefined): void;
  /**
   * Sets the causal probability of each key given the text committed so far, or
   * clears it. Indexed by key in the CURRENT layer; a layer switch clears it, so
   * the owner must set a fresh one after `setLayer`.
   */
  setKeyPrior(logPrior: Float64Array | null): void;
  setModifiers(modifiers: readonly string[]): void;
  setTheme(theme: KeyboardTheme): void;
  setVisible(visible: boolean): void;
  refreshGeometry(): void;
  destroy(): void;
}

const THEME_PROPERTIES: Readonly<Record<keyof KeyboardTheme, string>> = {
  background: '--merkur-keyboard-background',
  keyBackground: '--merkur-keyboard-key-background',
  specialKeyBackground: '--merkur-keyboard-special-background',
  accentKeyBackground: '--merkur-keyboard-accent-background',
  pressedKeyBackground: '--merkur-keyboard-pressed-background',
  activeKeyBackground: '--merkur-keyboard-active-background',
  foreground: '--merkur-keyboard-foreground',
  mutedForeground: '--merkur-keyboard-muted-foreground',
  keyShadow: '--merkur-keyboard-key-shadow',
  fontFamily: '--merkur-keyboard-font-family',
  characterFontSize: '--merkur-keyboard-character-size',
  specialFontSize: '--merkur-keyboard-special-size',
};

const KEYCAP_PREVIEW_WIDTH = 50;
const KEYCAP_PREVIEW_HEIGHT = 62;
const KEYCAP_PREVIEW_OVERLAP = 7;
const PREWARM_FALLBACK_DELAY_MS = 32;
const PREWARM_IDLE_TIMEOUT_MS = 250;

type KeyboardPrewarmHandle =
  | { readonly kind: 'idle'; readonly value: number }
  | { readonly kind: 'timer'; readonly value: number };

export function createDomKeyboard(
  root: HTMLElement,
  options: DomKeyboardOptions,
): DomKeyboardController {
  if (options.onKey === undefined && options.onKeyCommit === undefined) {
    throw new Error('DOM keyboard requires a key callback');
  }
  let layout = createKeyboardLayout(options.layout);
  let layerId = options.initialLayer ?? layout.initialLayer;
  let profileSource = options.profile ?? defaultProfileResolver;
  let behavior = resolveKeyboardBehavior(options.behavior);
  let touchModelSource = options.touchModel;
  let activeModifiers = new Set(options.activeModifiers ?? []);
  let geometry: ResolvedKeyboardGeometry | null = null;
  let engine: KeyboardEngine | null = null;
  let enginePointerCapacity = 0;
  let keyElements: HTMLButtonElement[] = [];
  let previewElements: HTMLDivElement[] = [];
  let activeKeyElementCount = 0;
  let surfaceLeft = 0;
  let surfaceTop = 0;
  let resizeFrame: number | null = null;
  let prewarmHandle: KeyboardPrewarmHandle | null = null;
  let geometryGeneration = 0;
  let destroyed = false;
  const geometryCache = new Map<string, ResolvedKeyboardGeometry>();
  let cachedLayout = layout;
  let cachedWidth = Number.NaN;
  let cachedDpr = Number.NaN;
  let cachedProfile: KeyboardGeometryProfile | null = null;

  root.classList.add('merkur-keyboard');
  root.setAttribute('data-keyboard-layout', layout.id);
  root.setAttribute('data-keyboard-layer', layerId);
  applyBehaviorAttributes(root, behavior);
  const surface = document.createElement('div');
  surface.className = 'merkur-keyboard__surface';
  surface.setAttribute('role', 'group');
  surface.setAttribute('aria-label', 'Terminal keyboard');
  const previewLayer = document.createElement('div');
  previewLayer.className = 'merkur-keyboard__preview-layer';
  previewLayer.setAttribute('aria-hidden', 'true');
  root.replaceChildren(surface);
  if (options.theme !== undefined) applyTheme(root, options.theme);

  const resizeObserver = new ResizeObserver(scheduleGeometryRefresh);
  resizeObserver.observe(root);
  window.visualViewport?.addEventListener('resize', scheduleGeometryRefresh);
  window.addEventListener('orientationchange', scheduleGeometryRefresh);

  // Listen on the root so the invisible bottom-row targets continue through
  // the utility rail below the visible key surface.
  root.addEventListener('pointerdown', onPointerDown, { passive: false });
  root.addEventListener('pointermove', onPointerMove, { passive: true });
  root.addEventListener('pointerup', onPointerUp, { passive: false });
  root.addEventListener('pointercancel', onPointerCancel, { passive: true });
  root.addEventListener('lostpointercapture', onLostPointerCapture);
  root.addEventListener('contextmenu', preventDefault);
  root.addEventListener('dragstart', preventDefault);
  surface.addEventListener('click', onAccessibleClick);

  refreshGeometry();

  function refreshGeometry(): void {
    if (destroyed || root.hidden) return;
    const width = root.getBoundingClientRect().width;
    if (width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const context: KeyboardProfileContext = {
      width,
      devicePixelRatio: dpr,
      orientation: keyboardOrientation(width),
    };
    const profile = resolveProfile(profileSource, context);
    if (
      cachedLayout !== layout ||
      cachedWidth !== width ||
      cachedDpr !== dpr ||
      cachedProfile === null ||
      !sameGeometryProfile(cachedProfile, profile)
    ) {
      invalidateGeometryCache();
      cachedLayout = layout;
      cachedWidth = width;
      cachedDpr = dpr;
      cachedProfile = { ...profile };
    }
    let nextGeometry = geometryCache.get(layerId);
    if (nextGeometry === undefined) {
      const startedAt = options.onPerformanceSample === undefined ? 0 : performance.now();
      nextGeometry = solveKeyboardGeometry(layout, layerId, width, dpr, profile);
      geometryCache.set(layerId, nextGeometry);
      if (options.onPerformanceSample !== undefined) {
        emitPerformanceSample({
          phase: 'geometry-build',
          layerId,
          durationMs: performance.now() - startedAt,
        });
      }
    }

    if (nextGeometry !== geometry) {
      // Clear old pointer highlights while keyElements still describes the old
      // layer. Rebinding first could remove the pressed state from an unrelated
      // key that happens to reuse the same numeric index.
      engine?.cancelAll();
      geometry = nextGeometry;
      setStylePx(surface.style, 'height', nextGeometry.height);
      root.style.setProperty('--merkur-keyboard-radius', `${profile.cornerRadius}px`);
      root.style.setProperty(
        '--merkur-keyboard-bottom-utility-height',
        `${profile.bottomUtilityHeight}px`,
      );
      renderKeys(nextGeometry);

      if (engine === null || enginePointerCapacity !== profile.maximumPointers) {
        engine?.destroy();
        enginePointerCapacity = profile.maximumPointers;
        engine = createKeyboardEngine({
          geometry: nextGeometry,
          profile,
          touchModel: resolveTouchModel(touchModelSource, nextGeometry),
          onKeyStateChange: updatePressedState,
          onRawCommit: handleEngineCommit,
          onRawProvisional: handleEngineProvisional,
          onTouchTrace: options.onTouchTrace,
        });
      } else {
        engine.updateGeometry(nextGeometry, profile);
        const touchModel = resolveTouchModel(touchModelSource, nextGeometry);
        if (touchModel !== undefined) engine.updateTouchModel(touchModel);
      }
    }

    scheduleGeometryPrewarm();
  }

  /**
   * Re-reads where the key surface currently sits in the viewport.
   *
   * Every hit test is `clientX/Y` minus this origin, so it has to describe the
   * surface as it is *now*. It cannot be cached at geometry time: the surface
   * moves without resizing. The terminal panel commits its own height from a
   * settle loop two animation frames after the `resize`/`orientationchange`
   * that triggered it, so a rotation deterministically moved the keyboard one
   * frame AFTER the last geometry refresh — and a ResizeObserver observes size,
   * never position, so nothing corrected it. The offset was the height delta
   * between the two orientations: hundreds of pixels, which put every tap
   * outside the candidate atlas and made the whole keyboard inert until the
   * next rotation.
   *
   * Read once per contact, at touch-down, and reused for that contact's moves
   * and release: those are the same gesture on the same surface, and re-reading
   * per move would put a layout read on the drag path for no accuracy.
   */
  function captureSurfaceOrigin(): void {
    const rect = surface.getBoundingClientRect();
    surfaceLeft = rect.left;
    surfaceTop = rect.top;
  }

  function renderKeys(nextGeometry: ResolvedKeyboardGeometry): void {
    const keyFragment = document.createDocumentFragment();
    const previewFragment = document.createDocumentFragment();
    for (const resolved of nextGeometry.keys) {
      const key = resolved.definition;
      let button = keyElements[resolved.index];
      if (button === undefined) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'merkur-keyboard__key';
        keyElements[resolved.index] = button;
      }
      setDataset(button, 'keyId', key.id);
      setDataset(button, 'keyIndex', String(resolved.index));
      setDataset(
        button,
        'variant',
        key.variant ?? (key.kind === 'input' ? 'character' : 'special'),
      );
      setStylePx(button.style, 'left', resolved.rect.x);
      setStylePx(button.style, 'top', resolved.rect.y);
      setStylePx(button.style, 'width', resolved.rect.width);
      setStylePx(button.style, 'height', resolved.rect.height);
      const label = resolveLabel(key);
      if (button.textContent !== label) button.textContent = label;
      setAttribute(button, 'aria-label', key.ariaLabel ?? key.label);
      button.removeAttribute('data-pressed');
      updateModifierState(button, key.modifier);
      keyFragment.append(button);

      let preview = previewElements[resolved.index];
      if (preview === undefined) {
        preview = document.createElement('div');
        preview.className = 'merkur-keyboard__preview';
        preview.setAttribute('aria-hidden', 'true');
        previewElements[resolved.index] = preview;
      }
      setDataset(preview, 'keyId', key.id);
      setDataset(
        preview,
        'variant',
        key.variant ?? (key.kind === 'input' ? 'character' : 'special'),
      );
      const previewWidth = Math.max(KEYCAP_PREVIEW_WIDTH, resolved.rect.width);
      const previewLeft = Math.min(
        Math.max(2, resolved.rect.x + (resolved.rect.width - previewWidth) / 2),
        Math.max(2, nextGeometry.width - previewWidth - 2),
      );
      setStylePx(preview.style, 'left', previewLeft);
      setStylePx(
        preview.style,
        'top',
        resolved.rect.y - KEYCAP_PREVIEW_HEIGHT + KEYCAP_PREVIEW_OVERLAP,
      );
      setStylePx(preview.style, 'width', previewWidth);
      setStylePx(preview.style, 'height', KEYCAP_PREVIEW_HEIGHT);
      if (preview.textContent !== label) preview.textContent = label;
      preview.hidden = behavior.preview !== 'keycap' || !supportsKeycapPreview(key);
      preview.removeAttribute('data-visible');
      previewFragment.append(preview);
    }
    activeKeyElementCount = nextGeometry.keys.length;
    previewLayer.replaceChildren(previewFragment);
    surface.replaceChildren(keyFragment, previewLayer);
  }

  function handleEngineCommit(
    resolved: ResolvedKeyboardKey,
    currentLayerId: string,
    pointerId: number,
    x: number,
    y: number,
    contactAtMs: number,
    repeat: boolean,
  ): void {
    const key = resolved.definition;
    if (key.kind === 'layer' && key.targetLayer !== undefined) {
      setLayer(key.targetLayer);
      return;
    }
    // Modifier state is read when the key commits. For a key decided at
    // touch-down that is now the state as the finger landed rather than as it
    // lifted, which is deterministic instead of lift-order dependent, and fixes
    // the common Shift-arrives-mid-hold case.
    const shifted = activeModifiers.has('shift');
    const value = shifted ? (key.shiftedValue ?? key.value) : key.value;
    options.onKey?.(key, value, pointerId, contactAtMs, repeat);
    options.onKeyCommit?.({
      key,
      layerId: currentLayerId,
      pointerId,
      x,
      y,
      contactAtMs,
      repeat,
      value,
    });
  }

  function handleEngineProvisional(
    resolved: ResolvedKeyboardKey | null,
    _currentLayerId: string,
    pointerId: number,
  ): void {
    if (resolved === null) {
      options.onProvisionalKey?.(null, undefined, pointerId);
      return;
    }
    const key = resolved.definition;
    const shifted = activeModifiers.has('shift');
    const value = shifted ? (key.shiftedValue ?? key.value) : key.value;
    options.onProvisionalKey?.(key, value, pointerId);
  }

  function setLayer(nextLayerId: string): void {
    if (nextLayerId === layerId) return;
    if (!(nextLayerId in layout.layers)) throw new Error(`Unknown keyboard layer: ${nextLayerId}`);
    layerId = nextLayerId;
    root.setAttribute('data-keyboard-layer', layerId);
    refreshGeometry();
    options.onLayerChange?.(layerId);
  }

  function setLayout(nextLayout: KeyboardLayout, initialLayer = nextLayout.initialLayer): void {
    const validated = createKeyboardLayout(nextLayout);
    if (!(initialLayer in validated.layers)) {
      throw new Error(`Unknown keyboard layer: ${initialLayer}`);
    }
    layout = validated;
    layerId = initialLayer;
    invalidateGeometryCache();
    root.setAttribute('data-keyboard-layout', layout.id);
    root.setAttribute('data-keyboard-layer', layerId);
    refreshGeometry();
    options.onLayerChange?.(layerId);
  }

  function setProfile(nextProfile: KeyboardGeometryProfile | KeyboardProfileResolver): void {
    profileSource = nextProfile;
    refreshGeometry();
  }

  function setBehavior(nextBehavior: KeyboardBehaviorOptions): void {
    const resolved = resolveKeyboardBehavior(nextBehavior);
    if (sameKeyboardBehavior(behavior, resolved)) return;
    behavior = resolved;
    applyBehaviorAttributes(root, behavior);
    const nextGeometry = geometry;
    if (nextGeometry === null) return;
    for (const key of nextGeometry.keys) {
      const preview = previewElements[key.index];
      if (preview === undefined) continue;
      preview.removeAttribute('data-visible');
      preview.hidden = behavior.preview !== 'keycap' || !supportsKeycapPreview(key.definition);
    }
  }

  function setTouchModel(
    nextModel: KeyboardTouchModel | KeyboardTouchModelResolver | undefined,
  ): void {
    touchModelSource = nextModel;
    const nextGeometry = geometry;
    if (nextGeometry === null) return;
    const touchModel = resolveTouchModel(touchModelSource, nextGeometry);
    if (touchModel === undefined) engine?.updateGeometry(nextGeometry);
    else engine?.updateTouchModel(touchModel);
  }

  /**
   * Forwarded straight through. If the engine does not exist yet the call is
   * dropped rather than queued: the owner refreshes the prior after every
   * commit, so at most one keystroke is decided without context, and holding a
   * stale array across a geometry rebuild would index the wrong layer's keys.
   */
  function setKeyPrior(logPrior: Float64Array | null): void {
    engine?.setKeyPrior(logPrior);
  }

  function setModifiers(modifiers: readonly string[]): void {
    if (sameModifiers(activeModifiers, modifiers)) return;
    const shiftedBefore = activeModifiers.has('shift');
    activeModifiers = new Set(modifiers);
    const shiftedAfter = activeModifiers.has('shift');
    const nextGeometry = geometry;
    if (nextGeometry === null) return;
    for (const resolved of nextGeometry.keys) {
      const button = keyElements[resolved.index];
      if (button === undefined) continue;
      const key = resolved.definition;
      if (
        options.labelResolver !== undefined ||
        (shiftedBefore !== shiftedAfter && key.shiftedLabel !== undefined)
      ) {
        const label = resolveLabel(key);
        if (button.textContent !== label) button.textContent = label;
        const preview = previewElements[resolved.index];
        if (preview !== undefined && preview.textContent !== label) preview.textContent = label;
      }
      if (key.modifier !== undefined) updateModifierState(button, key.modifier);
    }
  }

  function setTheme(theme: KeyboardTheme): void {
    applyTheme(root, theme);
  }

  function setVisible(visible: boolean): void {
    const hidden = !visible;
    if (root.hidden === hidden) {
      if (visible && geometry === null) scheduleGeometryRefresh();
      return;
    }
    root.hidden = hidden;
    if (!visible) {
      engine?.cancelAll();
      return;
    }
    scheduleGeometryRefresh();
  }

  function resolveLabel(key: Parameters<KeyboardLabelResolver>[0]): string {
    if (options.labelResolver !== undefined) return options.labelResolver(key, activeModifiers);
    return activeModifiers.has('shift') ? (key.shiftedLabel ?? key.label) : key.label;
  }

  function updateModifierState(button: HTMLButtonElement, modifier: string | undefined): void {
    if (modifier === undefined) {
      if (button.hasAttribute('aria-pressed')) button.removeAttribute('aria-pressed');
      if (button.hasAttribute('data-active')) button.removeAttribute('data-active');
      return;
    }
    const active = activeModifiers.has(modifier);
    setAttribute(button, 'aria-pressed', String(active));
    button.toggleAttribute('data-active', active);
  }

  function updatePressedState(keyIndex: number, active: boolean): void {
    if (keyIndex >= activeKeyElementCount) return;
    keyElements[keyIndex]?.toggleAttribute('data-pressed', active);
    const preview = previewElements[keyIndex];
    if (preview !== undefined && !preview.hidden) preview.toggleAttribute('data-visible', active);
  }

  function onPointerDown(event: PointerEvent): void {
    if (engine === null || geometry === null || event.button > 0) return;
    const startedAt = options.onPerformanceSample === undefined ? 0 : performance.now();
    captureSurfaceOrigin();
    if (
      !engine.beginPointerAt(
        event.pointerId,
        event.clientX - surfaceLeft,
        event.clientY - surfaceTop,
        event.timeStamp,
      )
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (options.onPerformanceSample !== undefined) {
      const completedAt = performance.now();
      emitPointerPerformanceSample('pointerdown-handler', event, startedAt, completedAt);
      const pressedLayerId = layerId;
      const pointerId = event.pointerId;
      requestAnimationFrame((frameAt) => {
        if (destroyed) return;
        emitPerformanceSample({
          phase: 'pressed-next-frame',
          layerId: pressedLayerId,
          pointerId,
          durationMs: Math.max(0, frameAt - startedAt),
        });
      });
    }
    try {
      root.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already have ended between dispatch and capture.
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (engine === null) return;
    const samples =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : undefined;
    if (samples === undefined || samples.length === 0) {
      movePointerEvent(event);
      return;
    }
    for (const sample of samples) movePointerEvent(sample);
  }

  function onPointerUp(event: PointerEvent): void {
    if (engine === null) return;
    const startedAt = options.onPerformanceSample === undefined ? 0 : performance.now();
    const samples =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : undefined;
    if (samples !== undefined) {
      for (const sample of samples) {
        if (sample.timeStamp < event.timeStamp) movePointerEvent(sample);
      }
    }
    const ended = engine.endPointerAt(
      event.pointerId,
      event.clientX - surfaceLeft,
      event.clientY - surfaceTop,
      event.timeStamp,
    );
    if (!ended) return;
    event.preventDefault();
    event.stopPropagation();
    if (options.onPerformanceSample !== undefined) {
      emitPointerPerformanceSample('pointerup-handler', event, startedAt, performance.now());
    }
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
  }

  function movePointerEvent(event: PointerEvent): void {
    engine?.movePointerAt(
      event.pointerId,
      event.clientX - surfaceLeft,
      event.clientY - surfaceTop,
      event.timeStamp,
    );
  }

  function onPointerCancel(event: PointerEvent): void {
    engine?.cancelPointer(event.pointerId);
  }

  function onLostPointerCapture(event: PointerEvent): void {
    engine?.cancelPointer(event.pointerId);
  }

  function onAccessibleClick(event: MouseEvent): void {
    if (event.detail !== 0 || engine === null) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-key-id]');
    if (button === null || !surface.contains(button)) return;
    const keyId = button.dataset.keyId;
    if (keyId !== undefined) engine.activateKey(keyId, event.timeStamp);
  }

  function scheduleGeometryRefresh(): void {
    if (destroyed || resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      refreshGeometry();
    });
  }

  function scheduleGeometryPrewarm(): void {
    if (
      destroyed ||
      options.prewarmLayers !== true ||
      prewarmHandle !== null ||
      cachedProfile === null ||
      Object.keys(layout.layers).every((candidateLayerId) => geometryCache.has(candidateLayerId))
    ) {
      return;
    }
    const generation = geometryGeneration;
    if (typeof window.requestIdleCallback === 'function') {
      prewarmHandle = {
        kind: 'idle',
        value: window.requestIdleCallback(
          (deadline) => {
            prewarmHandle = null;
            if (!deadline.didTimeout && deadline.timeRemaining() < 1) {
              scheduleGeometryPrewarm();
              return;
            }
            prewarmNextLayer(generation);
          },
          { timeout: PREWARM_IDLE_TIMEOUT_MS },
        ),
      };
      return;
    }
    prewarmHandle = {
      kind: 'timer',
      value: window.setTimeout(() => {
        prewarmHandle = null;
        prewarmNextLayer(generation);
      }, PREWARM_FALLBACK_DELAY_MS),
    };
  }

  function prewarmNextLayer(generation: number): void {
    if (destroyed || generation !== geometryGeneration || cachedProfile === null) return;
    const nextLayerId = Object.keys(layout.layers).find(
      (candidateLayerId) => !geometryCache.has(candidateLayerId),
    );
    if (nextLayerId === undefined) return;
    const startedAt = options.onPerformanceSample === undefined ? 0 : performance.now();
    const nextGeometry = solveKeyboardGeometry(
      layout,
      nextLayerId,
      cachedWidth,
      cachedDpr,
      cachedProfile,
    );
    if (destroyed || generation !== geometryGeneration) return;
    geometryCache.set(nextLayerId, nextGeometry);
    if (options.onPerformanceSample !== undefined) {
      emitPerformanceSample({
        phase: 'geometry-prewarm',
        layerId: nextLayerId,
        durationMs: performance.now() - startedAt,
      });
    }
    scheduleGeometryPrewarm();
  }

  function invalidateGeometryCache(): void {
    geometryGeneration += 1;
    geometryCache.clear();
    cancelGeometryPrewarm();
  }

  function cancelGeometryPrewarm(): void {
    const handle = prewarmHandle;
    if (handle === null) return;
    if (handle.kind === 'idle') window.cancelIdleCallback(handle.value);
    else window.clearTimeout(handle.value);
    prewarmHandle = null;
  }

  function emitPointerPerformanceSample(
    phase: 'pointerdown-handler' | 'pointerup-handler',
    event: PointerEvent,
    startedAt: number,
    completedAt: number,
  ): void {
    const inputDelayMs = startedAt - event.timeStamp;
    emitPerformanceSample({
      phase,
      layerId,
      pointerId: event.pointerId,
      durationMs: Math.max(0, completedAt - startedAt),
      ...(inputDelayMs >= 0 && inputDelayMs < 60_000 ? { inputDelayMs } : {}),
    });
  }

  function emitPerformanceSample(sample: KeyboardPerformanceSample): void {
    options.onPerformanceSample?.(sample);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    cancelGeometryPrewarm();
    resizeObserver.disconnect();
    window.visualViewport?.removeEventListener('resize', scheduleGeometryRefresh);
    window.removeEventListener('orientationchange', scheduleGeometryRefresh);
    root.removeEventListener('pointerdown', onPointerDown);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', onPointerUp);
    root.removeEventListener('pointercancel', onPointerCancel);
    root.removeEventListener('lostpointercapture', onLostPointerCapture);
    root.removeEventListener('contextmenu', preventDefault);
    root.removeEventListener('dragstart', preventDefault);
    surface.removeEventListener('click', onAccessibleClick);
    engine?.destroy();
    engine = null;
    geometryCache.clear();
    keyElements = [];
    previewElements = [];
    activeKeyElementCount = 0;
    root.classList.remove('merkur-keyboard');
    root.replaceChildren();
  }

  return {
    getLayer: () => layerId,
    getGeometry: () => geometry,
    setLayer,
    setLayout,
    setProfile,
    setBehavior,
    setTouchModel,
    setKeyPrior,
    setModifiers,
    setTheme,
    setVisible,
    refreshGeometry,
    destroy,
  };
}

function resolveProfile(
  profile: KeyboardGeometryProfile | KeyboardProfileResolver,
  context: KeyboardProfileContext,
): KeyboardGeometryProfile {
  return typeof profile === 'function' ? profile(context) : profile;
}

function resolveTouchModel(
  model: KeyboardTouchModel | KeyboardTouchModelResolver | undefined,
  geometry: ResolvedKeyboardGeometry,
): KeyboardTouchModel | undefined {
  return typeof model === 'function' ? model(geometry) : model;
}

function defaultProfileResolver(context: KeyboardProfileContext): KeyboardGeometryProfile {
  return context.orientation === 'landscape'
    ? CUPERTINO_LANDSCAPE_PROFILE
    : CUPERTINO_PORTRAIT_PROFILE;
}

function supportsKeycapPreview(key: KeyboardKeyDefinition): boolean {
  const variant = key.variant ?? (key.kind === 'input' ? 'character' : 'special');
  return key.kind === 'input' && variant === 'character';
}

function applyBehaviorAttributes(root: HTMLElement, behavior: ResolvedKeyboardBehavior): void {
  root.setAttribute('data-keyboard-preview', behavior.preview);
}

function sameKeyboardBehavior(
  left: ResolvedKeyboardBehavior,
  right: ResolvedKeyboardBehavior,
): boolean {
  return left.preview === right.preview;
}

function applyTheme(root: HTMLElement, theme: KeyboardTheme): void {
  for (const key of Object.keys(THEME_PROPERTIES) as Array<keyof KeyboardTheme>) {
    const value = theme[key];
    if (value !== undefined) root.style.setProperty(THEME_PROPERTIES[key], value);
  }
}

function sameGeometryProfile(
  left: KeyboardGeometryProfile,
  right: KeyboardGeometryProfile,
): boolean {
  return (
    left.horizontalPadding === right.horizontalPadding &&
    left.topPadding === right.topPadding &&
    left.bottomPadding === right.bottomPadding &&
    left.bottomUtilityHeight === right.bottomUtilityHeight &&
    left.keyGap === right.keyGap &&
    left.rowGap === right.rowGap &&
    left.keyHeight === right.keyHeight &&
    left.cornerRadius === right.cornerRadius &&
    left.hysteresis === right.hysteresis &&
    left.tapDrift === right.tapDrift &&
    left.releaseWeight === right.releaseWeight &&
    left.maximumPointers === right.maximumPointers
  );
}

function sameModifiers(current: ReadonlySet<string>, next: readonly string[]): boolean {
  if (current.size !== next.length) return false;
  for (const modifier of next) {
    if (!current.has(modifier)) return false;
  }
  return true;
}

function setDataset(
  element: HTMLElement,
  property: 'keyId' | 'keyIndex' | 'variant',
  value: string,
): void {
  if (element.dataset[property] !== value) element.dataset[property] = value;
}

function setStylePx(
  style: CSSStyleDeclaration,
  property: 'height' | 'left' | 'top' | 'width',
  value: number,
): void {
  const next = `${value}px`;
  if (style[property] !== next) style[property] = next;
}

function setAttribute(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
