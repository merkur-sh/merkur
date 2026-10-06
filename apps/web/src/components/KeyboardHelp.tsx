import { type Component, For, Show } from 'solid-js';

import { keybindScopes } from '../hooks/createKeybinds';
import { formatKeys } from '../lib/keybinds';

/**
 * The `?` sheet.
 *
 * It renders the scopes that are accepting keys *right now*, read from the
 * same registry the dispatcher reads. There is no second list to maintain, so
 * the sheet cannot drift from the handlers — and it shows only what would
 * actually work from where the reader is standing.
 */
const KeyboardHelp: Component = () => {
  // `active()` is the route gate, not the dispatch gate — dispatch is
  // suspended while this very overlay is open — so the sheet shows exactly the
  // bindings that will work once it closes.
  const sections = () => keybindScopes().filter((scope) => scope.active());

  return (
    <div>
      <h2
        id="keyboard-help-title"
        class="pb-1 text-[16px] font-semibold tracking-[-0.018em] text-ink"
      >
        Keyboard
      </h2>
      <p id="keyboard-help-description" class="pb-4 text-[12.5px] leading-[1.55] text-meta">
        Everything here is reachable without the mouse. Press <kbd class="kbd">esc</kbd> to close.
      </p>

      <div class="max-h-[60vh] overflow-y-auto overscroll-contain pr-1">
        <For each={sections()}>
          {(section) => (
            <Show when={section.bindings.length > 0}>
              <section class="pb-4 last:pb-0">
                <h3 class="eyebrow pb-2">{section.title}</h3>
                <dl class="flex flex-col gap-1.5">
                  <For each={section.bindings}>
                    {(binding) => (
                      <div class="flex items-baseline justify-between gap-4">
                        <dt class="min-w-0 text-[13px] text-body">{binding.label}</dt>
                        <dd class="shrink-0">
                          <kbd class="kbd">{formatKeys(binding.keys)}</kbd>
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            </Show>
          )}
        </For>
      </div>
    </div>
  );
};

export default KeyboardHelp;
