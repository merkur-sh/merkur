import { type Component, createEffect, createMemo, createSignal, For, Show } from 'solid-js';

import { ariaBool } from '../lib/aria';
import { fuzzyScore } from '../lib/fuzzy';
import { formatKeys } from '../lib/keybinds';
import { OVERLAY_AUTOFOCUS_ATTRIBUTE, type OverlayControls } from './overlay-controls';

/**
 * One thing the palette can do. `section` groups the list; `keys` is shown as
 * the shortcut hint when the same action also has a direct binding, so the
 * palette teaches the keyboard rather than competing with it.
 */
export interface Command {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly section: string;
  readonly keys?: string;
  run(): void;
}

interface Props {
  readonly commands: readonly Command[];
  readonly controls: OverlayControls;
}

/**
 * The search-anything surface.
 *
 * Movement is Ctrl+J / Ctrl+K rather than the bare `j`/`k` used everywhere
 * else, because here every unmodified key belongs to the query. That is the
 * same split fzf makes, and it is why the query field can hold focus for the
 * whole interaction — the list never needs it.
 */
const CommandPalette: Component<Props> = (props) => {
  const [query, setQuery] = createSignal('');
  const [activeIndex, setActiveIndex] = createSignal(0);
  let listEl!: HTMLDivElement;

  const matches = createMemo(() => {
    // Spaces are dropped from the query so "new box" still reads as a
    // subsequence of the title, and the section joins the haystack so typing a
    // category name pulls its whole group up.
    const needle = query().trim().replace(/\s+/g, '');
    const scored = props.commands
      .map((command) => ({
        command,
        score: fuzzyScore(`${command.title} ${command.subtitle ?? ''} ${command.section}`, needle),
      }))
      .filter((entry): entry is { command: Command; score: number } => entry.score !== null);

    // Ranked, but grouped: a flat score sort scatters sections through the
    // list and the headings then repeat all the way down it. Sections keep
    // their members together and are themselves ordered by their best hit, so
    // the closest answer is still the one under the cursor.
    const sections = new Map<string, { command: Command; score: number }[]>();
    for (const entry of scored) {
      const bucket = sections.get(entry.command.section);
      if (bucket === undefined) sections.set(entry.command.section, [entry]);
      else bucket.push(entry);
    }
    return [...sections.values()]
      .map((bucket) => bucket.sort((a, b) => b.score - a.score))
      .sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0))
      .flat()
      .map((entry) => entry.command);
  });

  // Any change to the result set puts the cursor back on the best answer.
  // Holding position would leave Enter pointing at whatever happened to land
  // under a stale index, which is how a palette runs the wrong command.
  const cursor = createMemo(() => {
    const count = matches().length;
    if (count === 0) return -1;
    return Math.min(activeIndex(), count - 1);
  });

  function move(delta: 1 | -1): void {
    const count = matches().length;
    if (count === 0) return;
    setActiveIndex((cursor() + delta + count) % count);
  }

  function run(command: Command | undefined): void {
    if (command === undefined) return;
    // Close first: several commands push another overlay, and the palette must
    // be gone by then rather than stacked underneath it.
    props.controls.dismiss();
    command.run();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      run(matches()[cursor()]);
      return;
    }
    // ⌘ is deliberately *not* excluded here. The palette is summoned with
    // right ⌘ K, and the hand that summoned it is still on the modifier when
    // the first Ctrl+J follows a fraction of a second later — excluding
    // `metaKey` left the movement keys dead for exactly as long as the key
    // that opened the palette stayed down, which reads as them not working at
    // all. Nothing else claims ⌘ Ctrl J/K, so accepting it costs nothing.
    if (!event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'j' && key !== 'k') return;
    event.preventDefault();
    move(key === 'j' ? 1 : -1);
  }

  // Keep the cursor in view without stealing focus from the query field: the
  // field owns focus for the whole interaction, so the list is scrolled to the
  // active option rather than focusing it.
  createEffect(
    () => cursor(),
    (index) => {
      if (index < 0) return;
      listEl
        .querySelector<HTMLElement>(`[data-command-index="${index}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    },
  );

  return (
    <div class="flex flex-col">
      <h2 id="command-palette-title" class="sr-only">
        Command palette
      </h2>
      <input
        {...{ [OVERLAY_AUTOFOCUS_ATTRIBUTE]: '' }}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-palette-list"
        aria-activedescendant={cursor() < 0 ? undefined : `command-option-${cursor()}`}
        aria-label="Search commands"
        autocomplete="off"
        spellcheck={false}
        placeholder="Search machines and actions…"
        value={query()}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        class="h-11 w-full shrink-0 border-none border-b border-solid border-line1 bg-transparent px-4 text-[14px] text-ink outline-none placeholder:text-faint"
      />

      <div
        ref={listEl}
        id="command-palette-list"
        role="listbox"
        aria-label="Commands"
        class="max-h-[46vh] min-h-[64px] overflow-y-auto overscroll-contain px-[5px] py-[6px]"
      >
        <Show
          when={matches().length > 0}
          fallback={
            <p class="px-4 py-[22px] text-center text-[12.5px] text-meta">No matching commands</p>
          }
        >
          <For each={matches()}>
            {(command, index) => (
              <>
                <Show when={index() === 0 || matches()[index() - 1]?.section !== command.section}>
                  <p class="eyebrow px-[9px] pb-1 pt-2">{command.section}</p>
                </Show>
                {/* A real button, not a styled div: the option has to be
                    activatable by pointer and by the platform's own keyboard
                    handling. `tabindex={-1}` keeps it out of the tab order,
                    because the query field holds focus for the whole
                    interaction and points here with `aria-activedescendant`. */}
                <button
                  type="button"
                  tabindex={-1}
                  id={`command-option-${index()}`}
                  data-command-index={index()}
                  role="option"
                  aria-selected={ariaBool(index() === cursor())}
                  onPointerMove={() => setActiveIndex(index())}
                  onClick={() => run(command)}
                  class={[
                    'flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm border-none px-[9px] py-[7px] text-left transition-[background-color,color] duration-tint motion-reduce:transition-none',
                    {
                      // The same cursor the machine list wears, for the same
                      // reason: a surface step alone is 1.34:1 on this ramp, so
                      // the accent ring does the work, the tint gives it an
                      // interior, and the lit top edge gives it a body. The two
                      // backgrounds are mutually exclusive rather than stacked —
                      // both are plain utilities in the same layer and Uno emits
                      // `.bg-transparent` last, so a row carrying both loses its
                      // highlight to the reset.
                      'bg-cursor shadow-cursor text-ink': index() === cursor(),
                      'bg-transparent text-body': index() !== cursor(),
                    },
                  ]}
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[12.5px] text-ink">{command.title}</span>
                    <Show when={command.subtitle}>
                      {(subtitle) => <span class="row-meta block pt-px">{subtitle()}</span>}
                    </Show>
                  </span>
                  <Show when={command.keys}>
                    {(keys) => <kbd class="kbd shrink-0">{formatKeys(keys())}</kbd>}
                  </Show>
                </button>
              </>
            )}
          </For>
        </Show>
      </div>

      <div class="hintbar shrink-0">
        <span class="hint">
          <kbd class="kbd">^J</kbd>
          <kbd class="kbd">^K</kbd> move
        </span>
        <span class="hint">
          <kbd class="kbd">↵</kbd> run
        </span>
        <span class="hint">
          <kbd class="kbd">esc</kbd> close
        </span>
      </div>
    </div>
  );
};

export default CommandPalette;
