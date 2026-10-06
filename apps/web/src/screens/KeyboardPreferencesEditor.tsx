import { CUPERTINO_PORTRAIT_PROFILE } from '@merkur/keyboard';
import { TERMINAL_US_LAYOUT } from '@merkur/keyboard/layouts/terminal-us';
import {
  MAX_TOOLBAR_KEYS,
  TERMINAL_KEYBOARD_LAYER_IDS,
  type TerminalKeyboardLayerId,
} from '@merkur/shared';
import { type Component, createMemo, createSignal, For, Show } from 'solid-js';
import Sheet from '../components/Sheet';
import ToggleSwitch from '../components/ToggleSwitch';
import { ariaBool } from '../lib/aria';
import {
  formatKeyboardDiagnostics,
  type KeyboardDiagnosticsSummary,
} from '../terminal/keyboard-diagnostics';
import {
  keyboardDiagnosticsSummary,
  resetKeyboardDiagnostics,
} from '../terminal/keyboard-diagnostics-store';
import {
  learnedKeyboardOffsetCount,
  resetKeyboardOffsets,
} from '../terminal/keyboard-offset-store';
import {
  addToolbarKey,
  DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
  DEFAULT_TOOLBAR_KEYS,
  DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES,
  getToolbarKeyDefinition,
  isTouchKeyboardEligible,
  moveToolbarKey,
  removeToolbarKey,
  swapTerminalKeyboardLayerKeys,
  type ToolbarKeyId,
  type VirtualKeyboardPreferences,
} from '../terminal/virtual-keyboard';
import KeyboardKeyPicker from './KeyboardKeyPicker';
import KeyboardMacrosEditor from './KeyboardMacrosEditor';

interface Props {
  readonly preferences: VirtualKeyboardPreferences;
  readonly onChange: (preferences: VirtualKeyboardPreferences) => void;
}

interface PointerDrag {
  readonly pointerId: number;
  readonly fromIndex: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
  targetIndex: number | null;
}

const DRAG_THRESHOLD_SQUARED = 36;
type KeyboardEditorKind = 'toolbar' | 'layout' | 'macros' | 'diagnostics';

const EDITOR_TITLE: Record<KeyboardEditorKind, string> = {
  toolbar: 'Quick Access',
  layout: 'Keyboard Layout',
  macros: 'Macros',
  diagnostics: 'Typing Diagnostics',
};

const KeyboardPreferencesEditor: Component<Props> = (props) => {
  // Typing diagnostics measure taps against the virtual keyboard, so they are
  // meaningless — and never populated — on a device that never shows one.
  const touchKeyboardEligible = isTouchKeyboardEligible();
  // Which editor the sheet shows outlives the sheet being open: it keeps
  // showing the one it was dismissed from while it slides away.
  const [editor, setEditor] = createSignal<KeyboardEditorKind>('toolbar');
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [diagnostics, setDiagnostics] = createSignal(
    keyboardDiagnosticsSummary(CUPERTINO_PORTRAIT_PROFILE.tapDrift),
  );
  const [learnedKeys, setLearnedKeys] = createSignal(0);

  function refreshTypingStats(): void {
    setDiagnostics(keyboardDiagnosticsSummary(CUPERTINO_PORTRAIT_PROFILE.tapDrift));
    setLearnedKeys(learnedKeyboardOffsetCount());
  }
  const [activeLayer, setActiveLayer] = createSignal<TerminalKeyboardLayerId>('alpha');
  const [selectedLayerSlot, setSelectedLayerSlot] = createSignal<number | null>(null);
  const [layerDragFrom, setLayerDragFrom] = createSignal<number | null>(null);
  const [layerDragOver, setLayerDragOver] = createSignal<number | null>(null);
  const [selectedToolbarSlot, setSelectedToolbarSlot] = createSignal<number | null>(null);
  const [toolbarDragFrom, setToolbarDragFrom] = createSignal<number | null>(null);
  const [toolbarDragOver, setToolbarDragOver] = createSignal<number | null>(null);
  let layerDrag: PointerDrag | null = null;
  let toolbarDrag: PointerDrag | null = null;

  const layer = createMemo(() => {
    const resolved = TERMINAL_US_LAYOUT.layers[activeLayer()];
    if (resolved === undefined) throw new Error(`Missing keyboard layer ${activeLayer()}`);
    return resolved;
  });

  const toolbarCustomized = createMemo(
    () => !sameKeys(props.preferences.toolbarKeys, DEFAULT_TOOLBAR_KEYS),
  );

  const layoutCustomized = createMemo(() =>
    TERMINAL_KEYBOARD_LAYER_IDS.some(
      (layerId) =>
        !sameKeys(
          props.preferences.layerKeyOrder[layerId],
          DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER[layerId],
        ),
    ),
  );

  const keyboardCustomized = createMemo(
    () =>
      props.preferences.keyPreview !== DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES.keyPreview ||
      toolbarCustomized() ||
      layoutCustomized(),
  );

  function update(next: Partial<VirtualKeyboardPreferences>): void {
    props.onChange({ ...props.preferences, ...next });
  }

  function swapLayerSlots(fromIndex: number, toIndex: number): void {
    const next = swapTerminalKeyboardLayerKeys(
      props.preferences.layerKeyOrder,
      activeLayer(),
      fromIndex,
      toIndex,
    );
    if (next !== props.preferences.layerKeyOrder) update({ layerKeyOrder: next });
  }

  function selectLayerSlot(index: number): void {
    const selected = selectedLayerSlot();
    if (selected === null) {
      setSelectedLayerSlot(index);
      return;
    }
    setSelectedLayerSlot(null);
    swapLayerSlots(selected, index);
  }

  function beginLayerDrag(index: number, event: PointerEvent): void {
    if (event.button > 0) return;
    layerDrag = {
      pointerId: event.pointerId,
      fromIndex: index,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      targetIndex: index,
    };
    try {
      const target = event.currentTarget;
      if (target instanceof Element) target.setPointerCapture(event.pointerId);
    } catch {
      // A very short touch can finish before capture is established.
    }
  }

  function moveLayerDrag(event: PointerEvent): void {
    const drag = layerDrag;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && deltaX * deltaX + deltaY * deltaY < DRAG_THRESHOLD_SQUARED) return;
    if (!drag.moved) {
      drag.moved = true;
      setSelectedLayerSlot(null);
      setLayerDragFrom(drag.fromIndex);
    }
    event.preventDefault();
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-keyboard-layer-slot]');
    const targetIndex =
      target?.dataset.keyboardLayer === activeLayer()
        ? parseSlot(target.dataset.keyboardLayerSlot)
        : null;
    drag.targetIndex = targetIndex;
    setLayerDragOver(targetIndex);
  }

  function finishLayerDrag(event: PointerEvent): void {
    const drag = layerDrag;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      if (drag.targetIndex !== null) swapLayerSlots(drag.fromIndex, drag.targetIndex);
    } else {
      selectLayerSlot(drag.fromIndex);
    }
    releasePointer(event);
    clearLayerDrag();
  }

  function clearLayerDrag(): void {
    layerDrag = null;
    setLayerDragFrom(null);
    setLayerDragOver(null);
  }

  function moveToolbarSlots(fromIndex: number, toIndex: number): void {
    const next = moveToolbarKey(props.preferences.toolbarKeys, fromIndex, toIndex);
    if (next !== props.preferences.toolbarKeys) update({ toolbarKeys: next });
  }

  function selectToolbarSlot(index: number): void {
    const selected = selectedToolbarSlot();
    if (selected === null) {
      setSelectedToolbarSlot(index);
      return;
    }
    setSelectedToolbarSlot(null);
    moveToolbarSlots(selected, index);
  }

  function beginToolbarDrag(index: number, event: PointerEvent): void {
    if (event.button > 0) return;
    toolbarDrag = {
      pointerId: event.pointerId,
      fromIndex: index,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      targetIndex: index,
    };
    try {
      const target = event.currentTarget;
      if (target instanceof Element) target.setPointerCapture(event.pointerId);
    } catch {
      // A very short touch can finish before capture is established.
    }
  }

  function moveToolbarDrag(event: PointerEvent): void {
    const drag = toolbarDrag;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && deltaX * deltaX + deltaY * deltaY < DRAG_THRESHOLD_SQUARED) return;
    if (!drag.moved) {
      drag.moved = true;
      setSelectedToolbarSlot(null);
      setToolbarDragFrom(drag.fromIndex);
    }
    event.preventDefault();
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-toolbar-editor-slot]');
    const targetIndex = parseSlot(target?.dataset.toolbarEditorSlot);
    drag.targetIndex = targetIndex;
    setToolbarDragOver(targetIndex);
  }

  function finishToolbarDrag(event: PointerEvent): void {
    const drag = toolbarDrag;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      if (drag.targetIndex !== null) moveToolbarSlots(drag.fromIndex, drag.targetIndex);
    } else {
      selectToolbarSlot(drag.fromIndex);
    }
    releasePointer(event);
    clearToolbarDrag();
  }

  function clearToolbarDrag(): void {
    toolbarDrag = null;
    setToolbarDragFrom(null);
    setToolbarDragOver(null);
  }

  function addQuickKey(value: string): void {
    const definition = getToolbarKeyDefinition(value, props.preferences.macros);
    if (definition === undefined) return;
    const next = addToolbarKey(
      props.preferences.toolbarKeys,
      definition.id,
      props.preferences.macros,
    );
    if (next !== props.preferences.toolbarKeys) update({ toolbarKeys: next });
  }

  function removeQuickKey(key: ToolbarKeyId): void {
    const next = removeToolbarKey(props.preferences.toolbarKeys, key);
    if (next !== props.preferences.toolbarKeys) update({ toolbarKeys: next });
    setSelectedToolbarSlot(null);
  }

  function openEditor(kind: KeyboardEditorKind): void {
    setEditor(kind);
    setEditorOpen(true);
  }

  function dismissEditor(): void {
    setSelectedToolbarSlot(null);
    setSelectedLayerSlot(null);
    clearToolbarDrag();
    clearLayerDrag();
    setEditorOpen(false);
  }

  return (
    <section aria-label="Keyboard">
      <div class="pref-group">
        <div class="pref-row">
          <span class="min-w-0 flex-1">
            <span class="pref-name">Key preview</span>
            <span class="pref-sub truncate">Native-style keycap on touch</span>
          </span>
          <ToggleSwitch
            label="Key preview"
            checked={props.preferences.keyPreview}
            onChange={(next) => update({ keyPreview: next })}
          />
        </div>

        <button
          type="button"
          data-keyboard-settings-open="toolbar"
          onClick={() => openEditor('toolbar')}
          class="pref-row focusable-inset cursor-pointer active:bg-lifted"
        >
          <span class="min-w-0 flex-1">
            <span class="pref-name">Quick-access toolbar</span>
            <span class="pref-sub truncate">
              {toolbarCustomized() ? 'Customized' : 'Default'} ·{' '}
              {props.preferences.toolbarKeys.length} keys
            </span>
          </span>
          <span aria-hidden="true" class="text-[21px] font-light leading-none text-white/25">
            ›
          </span>
        </button>

        <button
          type="button"
          data-keyboard-settings-open="layout"
          onClick={() => openEditor('layout')}
          class="pref-row focusable-inset cursor-pointer active:bg-lifted"
        >
          <span class="min-w-0 flex-1">
            <span class="pref-name">Keyboard layout</span>
            <span class="pref-sub truncate">
              US · {layoutCustomized() ? 'Customized' : 'Default'}
            </span>
          </span>
          <span aria-hidden="true" class="text-[21px] font-light leading-none text-white/25">
            ›
          </span>
        </button>

        <button
          type="button"
          data-keyboard-settings-open="macros"
          onClick={() => openEditor('macros')}
          class="pref-row focusable-inset cursor-pointer active:bg-lifted"
        >
          <span class="min-w-0 flex-1">
            <span class="pref-name">Macros</span>
            <span class="pref-sub truncate">
              {props.preferences.macros.length === 0
                ? 'Named shortcuts for one-tap actions'
                : `${props.preferences.macros.length} saved`}
            </span>
          </span>
          <span aria-hidden="true" class="text-[21px] font-light leading-none text-white/25">
            ›
          </span>
        </button>

        <Show when={touchKeyboardEligible}>
          <button
            type="button"
            data-keyboard-settings-open="diagnostics"
            onClick={() => {
              refreshTypingStats();
              openEditor('diagnostics');
            }}
            class="pref-row focusable-inset cursor-pointer active:bg-lifted"
          >
            <span class="min-w-0 flex-1">
              <span class="pref-name">Typing diagnostics</span>
              <span class="pref-sub truncate">
                {diagnosticsStatus(diagnostics(), learnedKeys())}
              </span>
            </span>
            <span aria-hidden="true" class="text-[21px] font-light leading-none text-white/25">
              ›
            </span>
          </button>
        </Show>

        <Show when={keyboardCustomized()}>
          <button
            type="button"
            onClick={() => {
              update({
                keyPreview: DEFAULT_VIRTUAL_KEYBOARD_PREFERENCES.keyPreview,
                toolbarKeys: DEFAULT_TOOLBAR_KEYS,
                layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER,
              });
              setSelectedToolbarSlot(null);
              setSelectedLayerSlot(null);
              clearToolbarDrag();
              clearLayerDrag();
            }}
            class="pref-row focusable-inset min-h-[44px] cursor-pointer text-[13px] font-medium text-accentink active:bg-lifted"
          >
            Restore defaults
          </button>
        </Show>
      </div>

      <Sheet open={editorOpen()} title={EDITOR_TITLE[editor()]} onDismiss={dismissEditor}>
        <Show when={editor() === 'toolbar'}>
          <div class="mx-auto w-full max-w-[680px]">
            <div class="flex items-center justify-between gap-3 pb-4">
              <p class="text-[12px] leading-[1.55] text-meta">
                Drag keys, or tap two keys to reorder them.
              </p>
              <button
                type="button"
                onClick={() => {
                  update({ toolbarKeys: DEFAULT_TOOLBAR_KEYS });
                  setSelectedToolbarSlot(null);
                  clearToolbarDrag();
                }}
                class="btn-ghost btn-sm"
              >
                Reset
              </button>
            </div>

            <div>
              <ul
                class="m-0 flex min-h-15 max-w-full list-none flex-wrap gap-1.5 rounded-md bg-sunken p-2"
                aria-label="Quick-access key order"
              >
                <For
                  each={props.preferences.toolbarKeys
                    .map((key) => getToolbarKeyDefinition(key, props.preferences.macros))
                    .filter(
                      (definition): definition is NonNullable<typeof definition> =>
                        definition !== undefined,
                    )}
                >
                  {(definition, index) => {
                    const key = definition.id;
                    return (
                      <li
                        data-toolbar-editor-slot={index()}
                        class={[
                          'flex h-11 min-w-15 shrink-0 select-none items-center rounded-xs border border-solid text-[12px] font-semibold shadow-[0_1px_0_rgba(0,0,0,0.7)] transition-[background-color,border-color,opacity,transform]',
                          {
                            'border-accentink/70 bg-accent/35 text-white':
                              selectedToolbarSlot() === index() || toolbarDragOver() === index(),
                            'border-white/8 bg-raised text-white/85':
                              selectedToolbarSlot() !== index() && toolbarDragOver() !== index(),
                            'scale-[0.97] opacity-50': toolbarDragFrom() === index(),
                          },
                        ]}
                      >
                        <button
                          type="button"
                          aria-label={`Move ${definition.label}`}
                          aria-pressed={ariaBool(selectedToolbarSlot() === index())}
                          onPointerDown={(event) => beginToolbarDrag(index(), event)}
                          onPointerMove={moveToolbarDrag}
                          onPointerUp={finishToolbarDrag}
                          onPointerCancel={clearToolbarDrag}
                          onLostPointerCapture={clearToolbarDrag}
                          onClick={(event) => {
                            if (event.detail === 0) selectToolbarSlot(index());
                          }}
                          class="focusable-inset flex h-full flex-1 cursor-pointer touch-none items-center justify-center rounded-l-sm border-none bg-transparent px-2 text-inherit"
                        >
                          <span>{definition.label}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${definition.label} from toolbar`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            removeQuickKey(key);
                          }}
                          class="focusable grid h-8 w-7 cursor-pointer place-items-center rounded-xs border-none bg-transparent text-[16px] text-faint hover:text-ink"
                        >
                          ×
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ul>

              <Show when={props.preferences.toolbarKeys.length === 0}>
                <p class="py-3 text-center text-[12px] text-meta">
                  Tap a key below to build your toolbar.
                </p>
              </Show>
              <div class="mt-5 mb-3 flex items-center justify-between gap-3">
                <h3 class="text-[13px] font-semibold text-ink">Add keys</h3>
                <span class="text-[12px] text-meta">
                  {props.preferences.toolbarKeys.length} / {MAX_TOOLBAR_KEYS}
                </span>
              </div>
              <KeyboardKeyPicker
                selected={props.preferences.toolbarKeys}
                onSelect={addQuickKey}
                disabled={props.preferences.toolbarKeys.length >= MAX_TOOLBAR_KEYS}
              />
              <div class="mt-5">
                <h3 class="mb-3 text-[13px] font-semibold text-ink">Macros</h3>
                <div class="flex flex-wrap gap-1.5">
                  <For each={props.preferences.macros}>
                    {(macro) => (
                      <button
                        type="button"
                        class="btn-ghost btn-sm"
                        disabled={
                          props.preferences.toolbarKeys.includes(macro.id) ||
                          props.preferences.toolbarKeys.length >= MAX_TOOLBAR_KEYS
                        }
                        onClick={() => addQuickKey(macro.id)}
                      >
                        {macro.name}
                      </button>
                    )}
                  </For>
                </div>
                <button
                  type="button"
                  class="btn-ghost btn-sm mt-3"
                  onClick={() => setEditor('macros')}
                >
                  Manage macros
                </button>
              </div>
            </div>
          </div>
        </Show>

        <Show when={editor() === 'macros'}>
          <KeyboardMacrosEditor preferences={props.preferences} onChange={props.onChange} />
        </Show>

        <Show when={editor() === 'layout'}>
          <div class="mx-auto w-full max-w-[680px]">
            <div class="flex items-center justify-between gap-3 pb-4">
              <p class="text-[12px] leading-[1.55] text-meta">
                Drag a key, or tap two slots to swap them.
              </p>
              <button
                type="button"
                onClick={() => {
                  update({ layerKeyOrder: DEFAULT_TERMINAL_KEYBOARD_LAYER_KEY_ORDER });
                  setSelectedLayerSlot(null);
                  clearLayerDrag();
                }}
                class="btn-ghost btn-sm"
              >
                Reset all
              </button>
            </div>

            <div class="mb-4 grid grid-cols-4 gap-1 rounded-md border border-solid border-line2 p-1">
              <For each={TERMINAL_KEYBOARD_LAYER_IDS}>
                {(layerId) => (
                  <button
                    type="button"
                    aria-pressed={ariaBool(activeLayer() === layerId)}
                    onClick={() => {
                      setActiveLayer(layerId);
                      setSelectedLayerSlot(null);
                      clearLayerDrag();
                    }}
                    class={[
                      'focusable cursor-pointer rounded-sm border-none py-2 text-[12px] font-semibold capitalize transition-colors',
                      {
                        'bg-line2 text-white': activeLayer() === layerId,
                        'bg-transparent text-meta': activeLayer() !== layerId,
                      },
                    ]}
                  >
                    {layerLabel(layerId)}
                  </button>
                )}
              </For>
            </div>

            <fieldset class="m-0 rounded-md border-0 bg-sunken px-2 py-2">
              <legend class="sr-only">{activeLayer()} layout</legend>
              <For each={layer().rows}>
                {(row, rowIndex) => {
                  const firstIndex = rowStartIndex(layer().rows, rowIndex());
                  return (
                    <div class="relative mb-1.5 h-10 last:mb-0">
                      <For each={row.keys}>
                        {(placement, placementIndex) => {
                          const slotIndex = firstIndex + placementIndex();
                          const keyId = () =>
                            props.preferences.layerKeyOrder[activeLayer()][slotIndex] ??
                            placement.key;
                          const label = () => TERMINAL_US_LAYOUT.keys[keyId()]?.label ?? keyId();
                          return (
                            <button
                              type="button"
                              aria-label={`${label()} keyboard slot`}
                              aria-pressed={ariaBool(selectedLayerSlot() === slotIndex)}
                              data-keyboard-layer={activeLayer()}
                              data-keyboard-layer-slot={slotIndex}
                              onPointerDown={(event) => beginLayerDrag(slotIndex, event)}
                              onPointerMove={moveLayerDrag}
                              onPointerUp={finishLayerDrag}
                              onPointerCancel={clearLayerDrag}
                              onLostPointerCapture={clearLayerDrag}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.preventDefault();
                                selectLayerSlot(slotIndex);
                              }}
                              class={[
                                'focusable absolute top-0 grid h-10 cursor-pointer touch-none select-none place-items-center overflow-hidden rounded-xs border px-1 text-[12px] font-semibold shadow-[0_1px_0_rgba(0,0,0,0.7)] transition-[background-color,border-color,opacity,transform]',
                                {
                                  'border-accentink/70 bg-accent/35 text-white':
                                    selectedLayerSlot() === slotIndex ||
                                    layerDragOver() === slotIndex,
                                  'border-white/8 bg-sunken text-white/85':
                                    selectedLayerSlot() !== slotIndex &&
                                    layerDragOver() !== slotIndex,
                                  'scale-[0.97] opacity-45': layerDragFrom() === slotIndex,
                                },
                              ]}
                              style={slotStyle(
                                placement.column,
                                placement.span ?? 1,
                                layer().columns,
                              )}
                            >
                              {label()}
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  );
                }}
              </For>
            </fieldset>
          </div>
        </Show>

        <Show when={touchKeyboardEligible && editor() === 'diagnostics'}>
          <div class="mx-auto w-full max-w-[680px]">
            <p class="pb-4 text-[12px] leading-[1.55] text-meta">
              Measured from ordinary typing on this device, including the taps you correct, and used
              to re-centre each key on where you actually hit it. The line you are typing is held
              only until it ends; what is kept is running totals per key — no keystroke order and no
              text — so this cannot reconstruct anything you typed.
            </p>
            <pre class="overflow-x-auto rounded-md border border-solid border-line2 bg-sunken px-4 py-3 font-mono text-[11px] leading-[17px] text-body">
              {formatKeyboardDiagnostics(diagnostics())}
            </pre>
            <div class="flex gap-3 pt-4">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(formatKeyboardDiagnostics(diagnostics()));
                }}
                class="btn-ghost btn-lg flex-1"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={() => {
                  resetKeyboardDiagnostics();
                  resetKeyboardOffsets();
                  refreshTypingStats();
                }}
                class="btn-ghost btn-lg flex-1 text-accentink"
              >
                Reset
              </button>
            </div>
          </div>
        </Show>
      </Sheet>
    </section>
  );
};

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function rowStartIndex(
  rows: readonly { readonly keys: readonly unknown[] }[],
  rowIndex: number,
): number {
  let result = 0;
  for (let index = 0; index < rowIndex; index += 1) result += rows[index]?.keys.length ?? 0;
  return result;
}

function slotStyle(
  column: number,
  span: number,
  columns: number,
): { readonly left: string; readonly width: string } {
  return {
    left: `calc(${(column / columns) * 100}% + 2px)`,
    width: `calc(${(span / columns) * 100}% - 4px)`,
  };
}

function parseSlot(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function releasePointer(event: PointerEvent): void {
  try {
    const target = event.currentTarget;
    if (target instanceof Element && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  } catch {
    // Pointer capture is already implicitly released after pointerup.
  }
}

function layerLabel(layerId: TerminalKeyboardLayerId): string {
  if (layerId === 'alpha') return 'ABC';
  if (layerId === 'numbers') return '123';
  if (layerId === 'symbols') return '#+=';
  return 'PC';
}

function diagnosticsStatus(summary: KeyboardDiagnosticsSummary, learnedKeys: number): string {
  if (summary.taps === 0) return 'No taps measured yet — type normally, then look here';
  return `${summary.taps} taps · ${learnedKeys} keys re-centred · p50 travel ${summary.driftPx.p50.toFixed(1)}px`;
}

export default KeyboardPreferencesEditor;
