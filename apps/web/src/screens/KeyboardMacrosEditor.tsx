import {
  type KeyboardMacro,
  type KeyboardMacroStep,
  MAX_KEYBOARD_MACRO_NAME_LENGTH,
  MAX_KEYBOARD_MACRO_STEPS,
  MAX_KEYBOARD_MACROS,
  MAX_TOOLBAR_KEYS,
} from '@merkur/shared';
import { type Component, createSignal, For, Show } from 'solid-js';
import { ariaBool } from '../lib/aria';
import {
  addToolbarKey,
  getVirtualKeyDefinition,
  removeToolbarKey,
  type VirtualKeyboardPreferences,
} from '../terminal/virtual-keyboard';
import KeyboardKeyPicker from './KeyboardKeyPicker';

interface Props {
  readonly preferences: VirtualKeyboardPreferences;
  readonly onChange: (preferences: VirtualKeyboardPreferences) => void;
}

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
const MODIFIER_LABELS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Cmd' };
const EMPTY_STEP: KeyboardMacroStep = {
  key: 'key-c',
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

function formatMacroStep(step: KeyboardMacroStep): string {
  return [
    ...MODIFIERS.filter((modifier) => step[modifier]).map((modifier) => MODIFIER_LABELS[modifier]),
    getVirtualKeyDefinition(step.key)?.label ?? step.key,
  ].join(' + ');
}

const KeyboardMacrosEditor: Component<Props> = (props) => {
  const [editingId, setEditingId] = createSignal<KeyboardMacro['id'] | null>(null);
  const [name, setName] = createSignal('');
  const [steps, setSteps] = createSignal<readonly KeyboardMacroStep[]>([]);
  const [step, setStep] = createSignal<KeyboardMacroStep>(EMPTY_STEP);
  const [editingStep, setEditingStep] = createSignal<number | null>(null);

  function reset(): void {
    setEditingId(null);
    setName('');
    setSteps([]);
    setStep(EMPTY_STEP);
    setEditingStep(null);
  }

  function save(): void {
    const displayName = name().trim();
    if (
      !displayName ||
      steps().length === 0 ||
      (editingId() === null && props.preferences.macros.length >= MAX_KEYBOARD_MACROS)
    )
      return;
    const macro: KeyboardMacro = {
      id: editingId() ?? `macro:${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
      name: displayName,
      steps:
        editingStep() === null
          ? steps()
          : steps().map((current, index) => (index === editingStep() ? step() : current)),
    };
    const macros =
      editingId() === null
        ? [...props.preferences.macros, macro]
        : props.preferences.macros.map((current) => (current.id === macro.id ? macro : current));
    props.onChange({ ...props.preferences, macros });
    reset();
  }

  function moveStep(index: number, direction: number): void {
    const next = [...steps()];
    const target = index + direction;
    const moved = next[index];
    const other = next[target];
    if (moved === undefined || other === undefined) return;
    next[target] = moved;
    next[index] = other;
    setSteps(next);
    setEditingStep(null);
  }

  return (
    <div class="mx-auto w-full max-w-[680px]">
      <p class="pb-4 text-[12px] leading-[1.55] text-meta">
        Combine keys into a named shortcut. Each tap runs its steps in order.
      </p>
      <Show when={props.preferences.macros.length > 0}>
        <div class="pref-group mb-5">
          <For each={props.preferences.macros}>
            {(macro) => (
              <div class="pref-row flex-wrap gap-2">
                <button
                  type="button"
                  aria-label={`Edit ${macro.name}`}
                  class="focusable min-w-0 flex-1 cursor-pointer border-none bg-transparent text-left"
                  onClick={() => {
                    setEditingId(macro.id);
                    setName(macro.name);
                    setSteps(macro.steps);
                    setEditingStep(null);
                    setStep(EMPTY_STEP);
                  }}
                >
                  <span class="pref-name">{macro.name}</span>
                  <span class="pref-sub">{macro.steps.map(formatMacroStep).join(' → ')}</span>
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  aria-label={`${props.preferences.toolbarKeys.includes(macro.id) ? 'Remove' : 'Add'} ${macro.name} ${props.preferences.toolbarKeys.includes(macro.id) ? 'from' : 'to'} toolbar`}
                  disabled={
                    !props.preferences.toolbarKeys.includes(macro.id) &&
                    props.preferences.toolbarKeys.length >= MAX_TOOLBAR_KEYS
                  }
                  onClick={() =>
                    props.onChange({
                      ...props.preferences,
                      toolbarKeys: props.preferences.toolbarKeys.includes(macro.id)
                        ? removeToolbarKey(props.preferences.toolbarKeys, macro.id)
                        : addToolbarKey(
                            props.preferences.toolbarKeys,
                            macro.id,
                            props.preferences.macros,
                          ),
                    })
                  }
                >
                  {props.preferences.toolbarKeys.includes(macro.id)
                    ? 'Remove from toolbar'
                    : 'Add to toolbar'}
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-sm text-meta"
                  aria-label={`Delete ${macro.name}`}
                  onClick={() => {
                    props.onChange({
                      ...props.preferences,
                      macros: props.preferences.macros.filter((current) => current.id !== macro.id),
                      toolbarKeys: removeToolbarKey(props.preferences.toolbarKeys, macro.id),
                    });
                    if (editingId() === macro.id) reset();
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="mb-3 flex items-center justify-between gap-3">
        <h3 class="text-[13px] font-semibold text-ink">
          {editingId() === null ? 'New macro' : 'Edit macro'}
        </h3>
        <Show when={editingId() !== null}>
          <button type="button" class="btn-ghost btn-sm" onClick={reset}>
            Cancel
          </button>
        </Show>
      </div>
      <label class="mb-4 block text-[12px] font-medium text-body">
        Display name
        <input
          class="field mt-2 h-11 w-full"
          maxlength={MAX_KEYBOARD_MACRO_NAME_LENGTH}
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
          placeholder="e.g. Interrupt or Next pane"
        />
      </label>
      <Show when={steps().length > 0}>
        <ol aria-label="Macro steps" class="mb-4 list-none rounded-md bg-sunken p-2">
          <For each={steps()}>
            {(current, index) => (
              <li class="flex items-center gap-1">
                <button
                  type="button"
                  class="focusable min-h-11 min-w-0 flex-1 cursor-pointer border-none bg-transparent px-2 text-left text-[13px] text-ink"
                  aria-label={`Edit step ${index() + 1}`}
                  aria-pressed={ariaBool(editingStep() === index())}
                  onClick={() => {
                    setEditingStep(index());
                    setStep(current);
                  }}
                >
                  {index() + 1}. {formatMacroStep(current)}
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  aria-label={`Move step ${index() + 1} up`}
                  disabled={index() === 0}
                  onClick={() => moveStep(index(), -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  aria-label={`Move step ${index() + 1} down`}
                  disabled={index() === steps().length - 1}
                  onClick={() => moveStep(index(), 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="btn-ghost btn-sm"
                  aria-label={`Remove step ${index() + 1}`}
                  onClick={() => {
                    setSteps(steps().filter((_, i) => i !== index()));
                    setEditingStep(null);
                  }}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <div class="mb-3 grid grid-cols-4 gap-1.5">
        <For each={MODIFIERS}>
          {(modifier) => (
            <button
              type="button"
              aria-pressed={ariaBool(step()[modifier])}
              onClick={() => setStep({ ...step(), [modifier]: !step()[modifier] })}
              class={[
                'focusable h-11 cursor-pointer rounded-xs border border-solid text-[12px] font-semibold',
                {
                  'border-accentink/70 bg-accent/35 text-white': step()[modifier],
                  'border-line2 bg-raised text-ink': !step()[modifier],
                },
              ]}
            >
              {MODIFIER_LABELS[modifier]}
            </button>
          )}
        </For>
      </div>
      <KeyboardKeyPicker
        inputOnly
        selected={[step().key]}
        onSelect={(key) => setStep({ ...step(), key })}
      />
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span class="text-[12px] text-body">{formatMacroStep(step())}</span>
        <button
          type="button"
          class="btn-ghost btn-sm"
          disabled={editingStep() === null && steps().length >= MAX_KEYBOARD_MACRO_STEPS}
          onClick={() => {
            const index = editingStep();
            setSteps(
              index === null
                ? [...steps(), step()]
                : steps().map((current, i) => (i === index ? step() : current)),
            );
            setEditingStep(null);
          }}
        >
          {editingStep() === null ? 'Add step' : 'Update step'}
        </button>
      </div>
      <button
        type="button"
        class="btn-primary btn-lg mt-5 w-full"
        onClick={save}
        disabled={
          !name().trim() ||
          steps().length === 0 ||
          (editingId() === null && props.preferences.macros.length >= MAX_KEYBOARD_MACROS)
        }
      >
        Save macro
      </button>
      <Show when={editingId() === null && props.preferences.macros.length >= MAX_KEYBOARD_MACROS}>
        <p class="pt-2 text-[12px] text-meta">Delete a macro to create another.</p>
      </Show>
    </div>
  );
};

export default KeyboardMacrosEditor;
