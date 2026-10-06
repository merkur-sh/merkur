import { TERMINAL_US_LAYOUT } from '@merkur/keyboard/layouts/terminal-us';
import { type Component, createMemo, createSignal, For } from 'solid-js';
import { ariaBool } from '../lib/aria';
import {
  getVirtualKeyDefinition,
  TOOLBAR_KEY_OPTIONS,
  type VirtualKeyId,
} from '../terminal/virtual-keyboard';

interface Props {
  readonly selected: readonly string[];
  readonly onSelect: (key: VirtualKeyId) => void;
  readonly inputOnly?: boolean;
  readonly disabled?: boolean;
}

const GROUPS = ['controls', 'alpha', 'numbers', 'symbols'] as const;
const LABELS = { controls: 'Controls', alpha: 'ABC', numbers: '123', symbols: '#+=' };

const KeyboardKeyPicker: Component<Props> = (props) => {
  const [group, setGroup] = createSignal<(typeof GROUPS)[number]>('controls');
  const keys = createMemo(() => {
    const id = group();
    if (id === 'controls') {
      return TOOLBAR_KEY_OPTIONS.filter((key) => {
        const definition = getVirtualKeyDefinition(key);
        return (
          definition !== undefined &&
          (definition.inputKey === undefined || definition.inputKey.length > 1) &&
          (!props.inputOnly || definition.inputKey !== undefined)
        );
      });
    }
    const ids = new Set(
      TERMINAL_US_LAYOUT.layers[id]?.rows.flatMap((row) => row.keys.map((slot) => slot.key)),
    );
    return TOOLBAR_KEY_OPTIONS.filter(
      (key) => ids.has(key) && getVirtualKeyDefinition(key)?.inputKey !== undefined,
    );
  });
  return (
    <div>
      <div class="mb-3 grid grid-cols-4 gap-1 rounded-md border border-solid border-line2 p-1">
        <For each={GROUPS}>
          {(id) => (
            <button
              type="button"
              aria-pressed={ariaBool(group() === id)}
              onClick={() => setGroup(id)}
              class={[
                'focusable cursor-pointer rounded-sm border-none py-2 text-[12px] font-semibold',
                {
                  'bg-line2 text-white': group() === id,
                  'bg-transparent text-meta': group() !== id,
                },
              ]}
            >
              {LABELS[id]}
            </button>
          )}
        </For>
      </div>
      <fieldset class="m-0 grid grid-cols-5 gap-1.5 rounded-md border-0 bg-sunken p-2 sm:grid-cols-8">
        <legend class="sr-only">{LABELS[group()]} keys</legend>
        <For each={keys()}>
          {(key) => (
            <button
              type="button"
              aria-label={`${props.inputOnly ? 'Choose' : 'Add'} ${getVirtualKeyDefinition(key)?.label}`}
              aria-pressed={ariaBool(props.selected.includes(key))}
              disabled={props.disabled || (!props.inputOnly && props.selected.includes(key))}
              onClick={() => props.onSelect(key)}
              class={[
                'focusable h-11 min-w-0 cursor-pointer select-none overflow-hidden rounded-xs border border-solid px-1 text-[12px] font-semibold shadow-[0_1px_0_rgba(0,0,0,0.7)] disabled:cursor-default',
                {
                  'border-accentink/70 bg-accent/35 text-white': props.selected.includes(key),
                  'border-white/8 bg-raised text-white/85': !props.selected.includes(key),
                  'opacity-40':
                    props.disabled || (!props.inputOnly && props.selected.includes(key)),
                },
              ]}
            >
              {getVirtualKeyDefinition(key)?.label}
            </button>
          )}
        </For>
      </fieldset>
    </div>
  );
};

export default KeyboardKeyPicker;
