import {
  CUPERTINO_LANDSCAPE_PROFILE,
  CUPERTINO_PORTRAIT_PROFILE,
  createKeyboardSpatialPrior,
  type KeyboardGeometryProfile,
  type KeyboardKeyDefinition,
  type KeyboardLayout,
  type KeyboardProfileContext,
  type KeyboardProfileResolver,
  type KeyboardTheme,
  type KeyboardTouchModel,
  type ResolvedKeyboardGeometry,
} from '@merkur/keyboard';
import type { KeyboardMacro } from '@merkur/shared';
import '@merkur/keyboard/cupertino.css';
import { createDomKeyboard, type DomKeyboardController } from '@merkur/keyboard/dom';
import { TERMINAL_US_LAYOUT } from '@merkur/keyboard/layouts/terminal-us';
import { type Component, createEffect, For, onSettled, Show } from 'solid-js';
import { ariaBool } from '../lib/aria';
import type { TerminalModifierState } from '../lib/key-record';
import {
  recordKeyboardBreak,
  recordKeyboardCommit,
  recordKeyboardTouch,
} from '../terminal/keyboard-diagnostics-store';
import {
  applyKeyboardOffsets,
  recordKeyboardOffsetTouch,
  subscribeKeyboardOffsets,
} from '../terminal/keyboard-offset-store';
import { createKeyboardPrior, type KeyboardPrior } from '../terminal/keyboard-prior';
import {
  getToolbarKeyDefinition,
  getVirtualKeyDefinition,
  type ToolbarKeyId,
  type VirtualKeyDefinition,
} from '../terminal/virtual-keyboard';

interface Props {
  readonly visible: boolean;
  readonly modifiers: TerminalModifierState;
  readonly macros: readonly KeyboardMacro[];
  readonly toolbarKeys: readonly ToolbarKeyId[];
  readonly keyPreview: boolean;
  readonly layout?: KeyboardLayout;
  readonly initialLayer?: string;
  readonly profile?: KeyboardGeometryProfile | KeyboardProfileResolver;
  readonly theme?: KeyboardTheme;
  readonly onLayerChange?: (layerId: string) => void;
  readonly onKeyPress: (
    definition: VirtualKeyDefinition,
    touchStartedAtMs?: number,
    repeat?: boolean,
  ) => void;
  readonly onProvisionalKey: (definition: VirtualKeyDefinition | null, pointerId: number) => void;
  readonly onModifierToggle: (modifier: keyof TerminalModifierState) => void;
}

const INLINE_TOOLBAR_PROFILE: KeyboardProfileResolver = (context) => ({
  ...(context.orientation === 'landscape'
    ? CUPERTINO_LANDSCAPE_PROFILE
    : CUPERTINO_PORTRAIT_PROFILE),
  // The quick-access row occupies the native keyboard's upper chrome, so only
  // one key-gap is needed before the character row.
  topPadding: 5,
});

/**
 * Thin Solid adapter. Pointer recognition, geometry, layer rendering, repeats,
 * and direct pressed-state mutations stay inside the framework-independent
 * package so the typing hot path never enters Solid's reactive graph.
 */
/** Geometry-keyed base priors; entries die with their geometry objects. */
const basePriors = new WeakMap<ResolvedKeyboardGeometry, KeyboardTouchModel>();

const VirtualTerminalKeyboard: Component<Props> = (props) => {
  let rootEl!: HTMLDivElement;
  let controller: DomKeyboardController | null = null;
  let mountedLayout: KeyboardLayout = props.layout ?? TERMINAL_US_LAYOUT;
  let prior: KeyboardPrior | null = null;
  let priorGeometry: ResolvedKeyboardGeometry | null = null;
  /**
   * The last character this keyboard committed, which is all the context a
   * strictly causal per-tap prior can use. It is deliberately not the terminal's
   * line buffer: the shell echoes, completes and redraws, and anything the
   * keyboard did not type itself is not evidence about what the thumb was aiming
   * at next. Anything non-printable resets it to the start-of-input row.
   */
  let lastCharacter: string | null = null;

  onSettled(() => {
    const mounted = createDomKeyboard(rootEl, {
      layout: mountedLayout,
      initialLayer: props.initialLayer,
      profile: resolveProfile,
      touchModel: personalizedTouchModel,
      theme: props.theme,
      behavior: {
        preview: props.keyPreview ? 'keycap' : 'none',
      },
      prewarmLayers: true,
      activeModifiers: activeModifierNames(props.modifiers),
      onKey: handleKey,
      onProvisionalKey: handleProvisionalKey,
      onLayerChange: (layerId) => {
        // A layer key commits at pointerdown and is consumed by the controller,
        // so `onKey` never fires for it and the prior would stay cleared until
        // the tap after next. Switching layers is also exactly when context
        // matters most in shell text: it is how '-', '/', '.' and '|' are
        // reached.
        refreshPriorForContext();
        props.onLayerChange?.(layerId);
      },
      onTouchTrace: (trace) => {
        const geometry = mounted.getGeometry();
        // Folded into per-key sums and histograms immediately; no keystroke
        // sequence is retained, so this cannot reconstruct typed text.
        recordKeyboardTouch(trace, geometry);
        // Rebuilding the model allocates, so it happens on the learner's own
        // cadence rather than once per keystroke.
        if (recordKeyboardOffsetTouch(trace, geometry)) {
          mounted.setTouchModel(personalizedTouchModel);
        }
      },
    });
    controller = mounted;
    mounted.setVisible(props.visible);
    // A settings-screen reset must reach the live engine now, not on the 25th
    // accepted tap after it; so must corrections a finished line folded in.
    const unsubscribeOffsets = subscribeKeyboardOffsets(() => {
      mounted.setTouchModel(personalizedTouchModel);
    });
    return () => {
      unsubscribeOffsets();
      mounted.destroy();
      if (controller === mounted) controller = null;
      recordKeyboardBreak();
    };
  });

  createEffect(
    () => props.visible,
    (visible) => {
      controller?.setVisible(visible);
      // Whatever is typed next arrives some other way, so the line ends here.
      if (!visible) recordKeyboardBreak();
    },
  );

  createEffect(
    () => activeModifierNames(props.modifiers),
    (modifiers) => controller?.setModifiers(modifiers),
  );

  createEffect(
    () => props.layout ?? TERMINAL_US_LAYOUT,
    (nextLayout) => {
      if (nextLayout === mountedLayout) return;
      mountedLayout = nextLayout;
      controller?.setLayout(nextLayout, props.initialLayer);
    },
  );

  createEffect(
    () => props.profile ?? INLINE_TOOLBAR_PROFILE,
    (source) => controller?.setProfile((context) => resolveProfile(context, source)),
  );

  createEffect(
    () => props.theme,
    (theme) => {
      if (theme !== undefined) controller?.setTheme(theme);
    },
  );

  createEffect(
    () => props.keyPreview,
    (keyPreview) =>
      controller?.setBehavior({
        preview: keyPreview ? 'keycap' : 'none',
      }),
  );

  function handleKey(
    key: KeyboardKeyDefinition,
    _value: string | undefined,
    pointerId: number,
    contactAtMs: number,
    repeat: boolean,
  ): void {
    refreshPrior(key);
    if (key.kind === 'modifier' && isTerminalModifier(key.modifier)) {
      props.onModifierToggle(key.modifier);
      return;
    }
    // Read before sending, which spends the latch. A latched Ctrl, Alt or ⌘
    // makes this key a chord: it types nothing the correction analysis could
    // compare, and may edit the line in ways it cannot see.
    const chord = props.modifiers.ctrl || props.modifiers.alt || props.modifiers.meta;
    const definition = getVirtualKeyDefinition(key.id);
    if (definition !== undefined) {
      // Pointer event timestamps share `performance.now()`'s origin; the perf
      // recorder works in the epoch domain, so this is the one place that knows
      // enough to convert. A synthetic activation carries no contact at all.
      props.onKeyPress(
        definition,
        pointerId >= 0 ? performance.timeOrigin + contactAtMs : undefined,
        repeat,
      );
    }
    // Commits are what a Backspace undoes, so the correction analysis reads
    // them here rather than from touch traces: Backspace activates on press and
    // leaves no trace at all. After the send, so a line's analysis never delays
    // the key that finished it.
    if (chord) recordKeyboardBreak();
    else recordKeyboardCommit(key, pointerId, repeat);
  }

  function handleProvisionalKey(
    key: KeyboardKeyDefinition | null,
    _value: string | undefined,
    pointerId: number,
  ): void {
    props.onProvisionalKey(
      key === null ? null : (getVirtualKeyDefinition(key.id) ?? null),
      pointerId,
    );
  }

  function resolveProfile(
    context: KeyboardProfileContext,
    source: KeyboardGeometryProfile | KeyboardProfileResolver = props.profile ??
      INLINE_TOOLBAR_PROFILE,
  ): KeyboardGeometryProfile {
    return typeof source === 'function' ? source(context) : source;
  }

  /**
   * The spatial model the engine scores against: the geometric prior, with the
   * grip field and offsets learned from ordinary typing applied on top. The
   * online learner measures residuals from whatever centre it is given, so
   * this converges on the true offset regardless of starting point.
   *
   * The base prior is cached per geometry: this runs synchronously inside
   * pointerup every 25 accepted taps, and the prior depends on nothing but the
   * geometry. Safe because `apply` copy-on-writes the centre arrays and only
   * aliases the precision arrays, which nothing mutates — every personalised
   * model shares the cached base's Float32 precisions, and that immutability
   * is load-bearing.
   */
  function personalizedTouchModel(geometry: ResolvedKeyboardGeometry): KeyboardTouchModel {
    let base = basePriors.get(geometry);
    if (base === undefined) {
      base = createKeyboardSpatialPrior(geometry);
      basePriors.set(geometry, base);
    }
    return applyKeyboardOffsets(geometry, base);
  }

  /**
   * Advances the causal context by the key just committed and hands the engine
   * the prior for the next tap. The prior is rebuilt only when the geometry
   * changes; per keystroke this refills one preallocated array.
   */
  function refreshPrior(key: KeyboardKeyDefinition): void {
    // Only a single printable character is context. Enter, Backspace, Escape and
    // the modifiers reset it: after any of them the next tap starts a fresh run
    // whose first character the start-of-input row describes better than a
    // bigram conditioned on a character that is no longer adjacent.
    const value = key.id === 'space' ? ' ' : key.value;
    lastCharacter = value !== undefined && value.length === 1 ? value : null;
    refreshPriorForContext();
  }

  /**
   * Rebuilds the prior for whatever geometry is live now, without advancing the
   * context. `updateGeometry` clears the engine's prior because it is indexed by
   * key and a new layer has different keys, so every geometry change has to be
   * followed by this.
   */
  function refreshPriorForContext(): void {
    const active = controller;
    if (active === null) return;
    const geometry = active.getGeometry();
    if (geometry === null) return;
    if (prior === null || priorGeometry !== geometry) {
      prior = createKeyboardPrior(geometry);
      priorGeometry = geometry;
    }
    active.setKeyPrior(prior.forPrevious(lastCharacter));
  }

  return (
    <div hidden={!props.visible} class="shrink-0" data-terminal-keyboard-shell>
      <Show when={props.visible && props.toolbarKeys.length > 0}>
        <QuickAccessToolbar
          keys={props.toolbarKeys}
          macros={props.macros}
          modifiers={props.modifiers}
          onKeyPress={props.onKeyPress}
          onModifierToggle={props.onModifierToggle}
        />
      </Show>
      <div ref={rootEl} data-terminal-custom-keyboard />
    </div>
  );
};

const QuickAccessToolbar: Component<{
  readonly macros: readonly KeyboardMacro[];
  readonly keys: readonly ToolbarKeyId[];
  readonly modifiers: TerminalModifierState;
  readonly onKeyPress: (
    definition: VirtualKeyDefinition,
    touchStartedAtMs?: number,
    repeat?: boolean,
  ) => void;
  readonly onModifierToggle: (modifier: keyof TerminalModifierState) => void;
}> = (props) => (
  <div class="border-t border-solid border-line1 bg-sunken p-2">
    <div
      role="toolbar"
      data-terminal-key-toolbar
      aria-label="Terminal quick keys"
      class="flex max-w-full flex-nowrap gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [touch-action:pan-x] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden"
    >
      <For
        each={props.keys
          .map((id) => getToolbarKeyDefinition(id, props.macros))
          .filter((definition): definition is VirtualKeyDefinition => definition !== undefined)}
      >
        {(definition) => {
          const active = () =>
            definition.modifier !== undefined && props.modifiers[definition.modifier];
          return (
            <button
              type="button"
              data-terminal-key={definition.id}
              data-terminal-toolbar-key={definition.id}
              aria-pressed={definition.modifier === undefined ? undefined : ariaBool(active())}
              onClick={(event) => {
                event.stopPropagation();
                if (definition.modifier !== undefined) {
                  props.onModifierToggle(definition.modifier);
                } else {
                  props.onKeyPress(definition);
                  // A toolbar key reaches the terminal between keyboard commits,
                  // so it ends the line the correction analysis holds.
                  recordKeyboardBreak();
                }
              }}
              // A held modifier fills with the accent rather than merely
              // brightening: it is a latch that stays down until the next key
              // spends it, and that has to read from a thumb's distance.
              class={[
                'focusable h-9 shrink-0 select-none rounded-sm border border-solid px-[10px] font-mono text-[12.5px] shadow-lift transition-[background-color,border-color,color,transform] duration-tint active:duration-0 active:scale-[0.96] motion-reduce:transition-none',
                {
                  'min-w-16': definition.wide === true,
                  'min-w-11': definition.wide !== true,
                  'border-accentline bg-accentsoft text-accentink': active(),
                  'border-line2 bg-raised text-ink': !active(),
                },
              ]}
            >
              {definition.label}
            </button>
          );
        }}
      </For>
    </div>
  </div>
);

function activeModifierNames(modifiers: TerminalModifierState): string[] {
  const active: string[] = [];
  if (modifiers.shift) active.push('shift');
  if (modifiers.ctrl) active.push('ctrl');
  if (modifiers.alt) active.push('alt');
  if (modifiers.meta) active.push('meta');
  return active;
}

function isTerminalModifier(value: string | undefined): value is keyof TerminalModifierState {
  return value === 'shift' || value === 'ctrl' || value === 'alt' || value === 'meta';
}

export default VirtualTerminalKeyboard;
