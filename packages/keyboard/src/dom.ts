import { resolveKeyboardBehavior } from './behavior';
import { createKeyboardEngine, type KeyboardEngine } from './engine';
import {
  CUPERTINO_LANDSCAPE_PROFILE,
  CUPERTINO_PORTRAIT_PROFILE,
  keyboardOrientation,
  solveKeyboardGeometry,
} from './geometry';
import { createKeyboardLayout } from './layout';
import { createKeyboardSpatialPrior } from './touch-model';
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
  /**
   * Build inactive layers' geometry and key nodes during idle periods, so the
   * first switch to each is a visibility flip rather than a build.
   */
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
  /**
   * Fires once the engine decides against a new geometry: a layer switch, a
   * resize, a rotation or a new layout. The engine's key prior is indexed by key
   * and is cleared at every such swap, so an owner that supplies one sets it
   * again here. It can fire during `createDomKeyboard`, before the controller
   * has been returned.
   */
  readonly onGeometryChange?: (geometry: ResolvedKeyboardGeometry) => void;
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
   * clears it. Indexed by key in the CURRENT geometry; every geometry swap
   * clears it, so the owner sets a fresh one from `onGeometryChange`.
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

type ProfileField = keyof KeyboardGeometryProfile;

/**
 * Accepts a field list only when it names every profile field, so a field
 * added to `KeyboardGeometryProfile` and left out of the list does not build.
 * A hand-written comparison once omitted `slideDrift` and `priorWeight`, so a
 * change to either never reached the engine.
 */
function everyProfileField<const Fields extends readonly ProfileField[]>(
  fields: Fields & (Exclude<ProfileField, Fields[number]> extends never ? unknown : never),
): Fields {
  return fields;
}

const PROFILE_FIELD_NAMES = everyProfileField([
  'horizontalPadding',
  'topPadding',
  'bottomPadding',
  'bottomUtilityHeight',
  'keyGap',
  'rowGap',
  'keyHeight',
  'cornerRadius',
  'hysteresis',
  'tapDrift',
  'slideDrift',
  'releaseWeight',
  'priorWeight',
  'maximumPointers',
]);

/**
 * The fields that place keys or size the hit atlas. The others are recognition
 * parameters the engine reads live, and changing one must not discard a single
 * cached atlas.
 */
const GEOMETRY_PROFILE_FIELDS = [
  'horizontalPadding',
  'topPadding',
  'bottomPadding',
  'bottomUtilityHeight',
  'keyGap',
  'rowGap',
  'keyHeight',
] as const satisfies readonly ProfileField[];

const KEYCAP_PREVIEW_WIDTH = 50;
const KEYCAP_PREVIEW_HEIGHT = 62;
const KEYCAP_PREVIEW_OVERLAP = 7;
const PREWARM_FALLBACK_DELAY_MS = 32;
const PREWARM_IDLE_TIMEOUT_MS = 250;

type KeyboardPrewarmHandle =
  | { readonly kind: 'idle'; readonly value: number }
  | { readonly kind: 'timer'; readonly value: number };

/**
 * One layer's pooled key and preview nodes. Every layer keeps its own, so a
 * layer switch replaces the one attached subtree with another that is already
 * built, placed and labelled. Rewriting and re-inserting every key instead put
 * a full rebuild of the key surface inside the pointer handler of the key that
 * switched layers, which in a terminal is how '-', '/', '|' and every digit are
 * reached.
 *
 * Only the visible view is in the document. Inactive ones hidden with
 * `display: none` measured a cost on every keystroke in WebKit, so they are
 * kept detached instead.
 *
 * Nodes are created once per layout and layer, with everything that does not
 * depend on the width; a new geometry only moves them. What the modifiers
 * change is written to the visible view at once and to the others while idle
 * or when they are shown, by generation.
 */
interface LayerView {
  /**
   * The keys in index order, then the preview layer: the surface's children
   * while this view is shown. No wrapper element, because an extra positioned
   * container between the surface and its keys measured slower relayouts.
   */
  readonly nodes: HTMLElement[];
  readonly previewLayer: HTMLDivElement;
  readonly keys: HTMLButtonElement[];
  readonly previews: HTMLDivElement[];
  readonly definitions: KeyboardKeyDefinition[];
  /** Indices of the keys whose legend can change with the modifiers. */
  readonly relabelled: number[];
  /** Indices of the modifier keys, whose pressed state follows the modifiers. */
  readonly modifierKeys: number[];
  /** The geometry these nodes are positioned for; null until first placed. */
  geometry: ResolvedKeyboardGeometry | null;
  /** The label generation this view's legends were written for. */
  labelGeneration: number;
  /** The modifier generation this view's modifier keys show. */
  modifierGeneration: number;
}

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
  let engineProfile: KeyboardGeometryProfile | null = null;
  let views = new Map<string, LayerView>();
  let layerIds = Object.keys(layout.layers);
  let activeView: LayerView | null = null;
  // Advance whenever the modifiers change a legend, and whenever they change at
  // all. Only the visible view follows at once; the others catch up while idle
  // or when shown.
  let labelGeneration = 0;
  let modifierGeneration = 0;
  let appliedRadius = Number.NaN;
  let appliedUtilityHeight = Number.NaN;
  let surfaceLeft = 0;
  let surfaceTop = 0;
  let resizeFrame: number | null = null;
  let prewarmHandle: KeyboardPrewarmHandle | null = null;
  let geometryGeneration = 0;
  let destroyed = false;
  // A layer key that the engine commits while it is itself mid-swap is applied
  // once the swap is done, rather than starting a second swap inside the first.
  let swappingGeometry = false;
  let pendingLayerId: string | null = null;
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

  /**
   * Measures the keyboard and resolves its profile, then shows the current
   * layer for them. Runs for resizes, rotations, profile and layout changes;
   * a layer switch on an unchanged board skips the measurement (`setLayer`).
   */
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
      !sameProfileFields(cachedProfile, profile, GEOMETRY_PROFILE_FIELDS)
    ) {
      invalidateGeometryCache();
      cachedLayout = layout;
      cachedWidth = width;
      cachedDpr = dpr;
    }
    cachedProfile = { ...profile };
    showGeometry(geometryFor(layerId, cachedProfile), cachedProfile);
  }

  function geometryFor(id: string, profile: KeyboardGeometryProfile): ResolvedKeyboardGeometry {
    const cached = geometryCache.get(id);
    if (cached !== undefined) return cached;
    const startedAt = options.onPerformanceSample === undefined ? 0 : performance.now();
    const built = solveKeyboardGeometry(layout, id, cachedWidth, cachedDpr, profile);
    geometryCache.set(id, built);
    if (options.onPerformanceSample !== undefined) {
      emitPerformanceSample({
        phase: 'geometry-build',
        layerId: id,
        durationMs: performance.now() - startedAt,
      });
    }
    return built;
  }

  /**
   * Makes `nextGeometry` the one the engine decides against and the one on
   * screen, or hands a changed profile to the engine when the geometry stayed.
   *
   * The order is the contract. The engine swaps first, while the visible view
   * still describes the old geometry: a contact that is still down owes the
   * stream its byte and commits against the board it was typed on, and its
   * pressed highlight is cleared on the node it was set on. Only then does the
   * new view show. Clearing contacts before the swap, as this once did,
   * released a resting thumb before the engine could commit it, and the
   * keystroke vanished without a trace.
   */
  function showGeometry(
    nextGeometry: ResolvedKeyboardGeometry,
    profile: KeyboardGeometryProfile,
  ): void {
    const view = viewFor(nextGeometry);
    placeView(view, nextGeometry);
    if (
      nextGeometry !== geometry ||
      engine === null ||
      engineProfile === null ||
      engineProfile.maximumPointers !== profile.maximumPointers
    ) {
      const touchModel = resolveTouchModel(touchModelSource, nextGeometry);
      swappingGeometry = true;
      try {
        if (
          engine === null ||
          engineProfile === null ||
          engineProfile.maximumPointers !== profile.maximumPointers
        ) {
          engine?.destroy();
          engine = createKeyboardEngine({
            geometry: nextGeometry,
            profile,
            touchModel,
            onKeyStateChange: updatePressedState,
            onRawCommit: handleEngineCommit,
            onRawProvisional: handleEngineProvisional,
            onTouchTrace: options.onTouchTrace,
          });
        } else {
          engine.updateGeometry(nextGeometry, profile, touchModel);
        }
      } finally {
        swappingGeometry = false;
      }
      engineProfile = profile;
      geometry = nextGeometry;
      activateView(view);
      setStylePx(surface.style, 'height', nextGeometry.height);
      applyProfileStyle(profile);
      options.onGeometryChange?.(nextGeometry);
    } else if (!sameProfileFields(engineProfile, profile, PROFILE_FIELD_NAMES)) {
      engine.updateProfile(profile);
      engineProfile = profile;
      applyProfileStyle(profile);
    }

    const pending = pendingLayerId;
    if (pending !== null) {
      pendingLayerId = null;
      setLayer(pending);
    }
    scheduleGeometryPrewarm();
  }

  function applyProfileStyle(profile: KeyboardGeometryProfile): void {
    if (appliedRadius !== profile.cornerRadius) {
      appliedRadius = profile.cornerRadius;
      root.style.setProperty('--merkur-keyboard-radius', `${profile.cornerRadius}px`);
    }
    if (appliedUtilityHeight !== profile.bottomUtilityHeight) {
      appliedUtilityHeight = profile.bottomUtilityHeight;
      root.style.setProperty(
        '--merkur-keyboard-bottom-utility-height',
        `${profile.bottomUtilityHeight}px`,
      );
    }
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

  /** The layer's pooled nodes, created detached on first use. */
  function viewFor(nextGeometry: ResolvedKeyboardGeometry): LayerView {
    const existing = views.get(nextGeometry.layerId);
    if (existing !== undefined) return existing;
    const previewLayer = document.createElement('div');
    previewLayer.className = 'merkur-keyboard__preview-layer';
    previewLayer.setAttribute('aria-hidden', 'true');
    const view: LayerView = {
      nodes: [],
      previewLayer,
      keys: [],
      previews: [],
      definitions: [],
      relabelled: [],
      modifierKeys: [],
      geometry: null,
      labelGeneration,
      modifierGeneration,
    };
    const previewFragment = document.createDocumentFragment();
    for (const resolved of nextGeometry.keys) {
      const key = resolved.definition;
      const variant = key.variant ?? (key.kind === 'input' ? 'character' : 'special');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'merkur-keyboard__key';
      button.dataset.keyId = key.id;
      button.dataset.keyIndex = String(resolved.index);
      button.dataset.variant = variant;
      button.setAttribute('aria-label', key.ariaLabel ?? key.label);
      const label = resolveLabel(key);
      button.textContent = label;
      updateModifierState(button, key.modifier);
      view.nodes.push(button);

      const preview = document.createElement('div');
      preview.className = 'merkur-keyboard__preview';
      preview.setAttribute('aria-hidden', 'true');
      preview.dataset.keyId = key.id;
      preview.dataset.variant = variant;
      preview.textContent = label;
      preview.hidden = behavior.preview !== 'keycap' || !supportsKeycapPreview(key);
      previewFragment.append(preview);

      view.keys[resolved.index] = button;
      view.previews[resolved.index] = preview;
      view.definitions[resolved.index] = key;
      if (options.labelResolver !== undefined || key.shiftedLabel !== undefined) {
        view.relabelled.push(resolved.index);
      }
      if (key.modifier !== undefined) view.modifierKeys.push(resolved.index);
    }
    previewLayer.append(previewFragment);
    view.nodes.push(previewLayer);
    views.set(nextGeometry.layerId, view);
    return view;
  }

  /** Moves a view's nodes to the rectangles of `nextGeometry`. */
  function placeView(view: LayerView, nextGeometry: ResolvedKeyboardGeometry): void {
    if (view.geometry === nextGeometry) return;
    for (const resolved of nextGeometry.keys) {
      const button = view.keys[resolved.index];
      if (button !== undefined) {
        setStylePx(button.style, 'left', resolved.rect.x);
        setStylePx(button.style, 'top', resolved.rect.y);
        setStylePx(button.style, 'width', resolved.rect.width);
        setStylePx(button.style, 'height', resolved.rect.height);
      }
      const preview = view.previews[resolved.index];
      if (preview === undefined) continue;
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
    }
    view.geometry = nextGeometry;
  }

  function activateView(view: LayerView): void {
    if (activeView === view) return;
    syncView(view);
    surface.replaceChildren(...view.nodes);
    activeView = view;
  }

  function resolveLabel(key: KeyboardKeyDefinition): string {
    if (options.labelResolver !== undefined) return options.labelResolver(key, activeModifiers);
    return activeModifiers.has('shift') ? (key.shiftedLabel ?? key.label) : key.label;
  }

  /**
   * Writes the legends the current modifiers call for, when this view's are
   * from an older generation. A legend is text rather than CSS generated
   * content on purpose: drawing it from an attribute made Shift one attribute
   * write, but every engine then rebuilt each key's generated box, and the
   * layout after a Shift press measured slower than rewriting the text.
   */
  function syncView(view: LayerView): void {
    if (view.labelGeneration !== labelGeneration) {
      view.labelGeneration = labelGeneration;
      for (const index of view.relabelled) {
        const key = view.definitions[index];
        if (key === undefined) continue;
        const label = resolveLabel(key);
        const button = view.keys[index];
        if (button !== undefined && button.textContent !== label) button.textContent = label;
        const preview = view.previews[index];
        if (preview !== undefined && preview.textContent !== label) preview.textContent = label;
      }
    }
    if (view.modifierGeneration !== modifierGeneration) {
      view.modifierGeneration = modifierGeneration;
      for (const index of view.modifierKeys) {
        const button = view.keys[index];
        if (button !== undefined) updateModifierState(button, view.definitions[index]?.modifier);
      }
    }
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
      if (swappingGeometry) pendingLayerId = key.targetLayer;
      else setLayer(key.targetLayer);
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

  /**
   * A layer switch on an unchanged board reuses the measurement and profile of
   * the last refresh: nothing that feeds them has changed, and every change
   * that does (a resize, a rotation, a profile or layout) refreshes them on its
   * own. This runs inside the pointer handler of the layer key, where a layout
   * read would force the style the key's own pressed state just invalidated.
   */
  function setLayer(nextLayerId: string): void {
    if (nextLayerId === layerId) return;
    if (!(nextLayerId in layout.layers)) throw new Error(`Unknown keyboard layer: ${nextLayerId}`);
    layerId = nextLayerId;
    root.setAttribute('data-keyboard-layer', layerId);
    const profile = cachedProfile;
    if (profile === null || cachedLayout !== layout || root.hidden) refreshGeometry();
    else showGeometry(geometryFor(layerId, profile), profile);
    options.onLayerChange?.(layerId);
  }

  function setLayout(nextLayout: KeyboardLayout, initialLayer = nextLayout.initialLayer): void {
    const validated = createKeyboardLayout(nextLayout);
    if (!(initialLayer in validated.layers)) {
      throw new Error(`Unknown keyboard layer: ${initialLayer}`);
    }
    layout = validated;
    layerIds = Object.keys(layout.layers);
    layerId = initialLayer;
    invalidateGeometryCache();
    // The old layout's visible view stays attached, and `activeView`, until the
    // engine has swapped away from it, so contacts still on it clear their
    // highlights where they were set.
    views = new Map();
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
    for (const view of views.values()) {
      for (let index = 0; index < view.previews.length; index += 1) {
        const preview = view.previews[index];
        const definition = view.definitions[index];
        if (preview === undefined || definition === undefined) continue;
        preview.removeAttribute('data-visible');
        preview.hidden = behavior.preview !== 'keycap' || !supportsKeycapPreview(definition);
      }
    }
  }

  function setTouchModel(
    nextModel: KeyboardTouchModel | KeyboardTouchModelResolver | undefined,
  ): void {
    touchModelSource = nextModel;
    const current = geometry;
    if (current === null || engine === null) return;
    // Clearing the model returns to the geometric one. It is a model change
    // only: contacts that are down stay down.
    engine.updateTouchModel(
      resolveTouchModel(touchModelSource, current) ?? createKeyboardSpatialPrior(current),
    );
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
    if (options.labelResolver !== undefined || shiftedBefore !== activeModifiers.has('shift')) {
      labelGeneration += 1;
    }
    modifierGeneration += 1;
    if (activeView !== null) syncView(activeView);
    scheduleGeometryPrewarm();
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
    const view = activeView;
    if (view === null) return;
    view.keys[keyIndex]?.toggleAttribute('data-pressed', active);
    const preview = view.previews[keyIndex];
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

  /** Whether a layer's geometry is built and its nodes are placed and current for it. */
  function layerReady(candidateLayerId: string): boolean {
    const built = geometryCache.get(candidateLayerId);
    const view = views.get(candidateLayerId);
    return (
      built !== undefined &&
      view?.geometry === built &&
      view.labelGeneration === labelGeneration &&
      view.modifierGeneration === modifierGeneration
    );
  }

  function scheduleGeometryPrewarm(): void {
    if (
      destroyed ||
      options.prewarmLayers !== true ||
      prewarmHandle !== null ||
      cachedProfile === null ||
      layerIds.every(layerReady)
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
    const profile = cachedProfile;
    if (destroyed || generation !== geometryGeneration || profile === null) return;
    const nextLayerId = layerIds.find((candidateLayerId) => !layerReady(candidateLayerId));
    if (nextLayerId === undefined) return;
    const startedAt = options.onPerformanceSample === undefined ? 0 : performance.now();
    const built = geometryCache.get(nextLayerId);
    const nextGeometry =
      built ?? solveKeyboardGeometry(layout, nextLayerId, cachedWidth, cachedDpr, profile);
    if (destroyed || generation !== geometryGeneration) return;
    geometryCache.set(nextLayerId, nextGeometry);
    const view = viewFor(nextGeometry);
    placeView(view, nextGeometry);
    syncView(view);
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
    views.clear();
    activeView = null;
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

function sameProfileFields(
  left: KeyboardGeometryProfile,
  right: KeyboardGeometryProfile,
  fields: readonly ProfileField[],
): boolean {
  for (const field of fields) {
    if (left[field] !== right[field]) return false;
  }
  return true;
}

function sameModifiers(current: ReadonlySet<string>, next: readonly string[]): boolean {
  if (current.size !== next.length) return false;
  for (const modifier of next) {
    if (!current.has(modifier)) return false;
  }
  return true;
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
