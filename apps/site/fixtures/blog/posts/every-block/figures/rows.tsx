/**
 * Figure 2: a terminal the reader types in, and beside it what is sent after
 * every write. Rows flash when they are sent, or when a scroll only moved them.
 */
import type { JSX } from '@solidjs/web';
import { createSignal, For, flush, onCleanup } from 'solid-js';

import { type Line, PROMPT, seg } from '../../../../../src/blog/kit/lines';
import { flash, places, settle } from '../../../../../src/blog/kit/motion';
import { Rows, Segments } from '../../../../../src/blog/kit/terminal';
import { enter, type Flash, openSession, ROWS, type Session, type as typed } from './rows.model';

/** A row that was sent, or only moved, is lit and let go over this long, in seconds. */
const LIT_SECONDS = 0.9;

/** What a row is lit in, and the bar at its edge, by its part in the update; each fades to clear. */
const TINTS: Readonly<Record<Flash, readonly [row: string, bar: string, clear: string]>> = {
  sent: ['rgba(203, 166, 247, 0.18)', 'rgba(203, 166, 247, 1)', 'rgba(203, 166, 247, 0)'],
  moved: ['rgba(127, 132, 156, 0.18)', 'rgba(127, 132, 156, 1)', 'rgba(127, 132, 156, 0)'],
};

/** The pace a button types its command at, and the pause before its Enter, in ms. */
const KEY_MS = 65;

const ENTER_MS = 180;

/** One row of the screen as it is drawn: its text, and whether the prompt is on it. */
interface ScreenRow {
  readonly line: Line;
  readonly prompt: boolean;
}

export default function RowsFigure(): JSX.Element {
  const [session, setSession] = createSignal<Session>(openSession());
  const [focused, setFocused] = createSignal(false);
  /** A button is typing its command; the keyboard waits. */
  let typing = false;
  let timers: number[] = [];
  let screen: HTMLDivElement | undefined;
  let wire: HTMLDivElement | undefined;

  const later = (task: () => void, ms: number): void => {
    timers.push(window.setTimeout(task, ms));
  };

  onCleanup(() => {
    for (const timer of timers) window.clearTimeout(timer);
  });

  /** Shows `next`: the rows its update sent or moved are lit, and the wire makes room for it. */
  const show = (next: Session): void => {
    const updated = next.version !== session().version;
    const before = wire === undefined ? null : places(wire);
    setSession(next);

    if (!updated) return;

    // The rows and the wire are the new ones from here.
    flush();

    for (const [index, part] of Object.entries(next.flash)) {
      const row = screen?.children[Number(index)];
      const bar = row?.firstElementChild;

      if (row === undefined || bar === null || bar === undefined) continue;

      const [rowTint, barTint, clear] = TINTS[part];
      flash(row, rowTint, clear, LIT_SECONDS);
      flash(bar, barTint, clear, LIT_SECONDS);
    }

    if (wire !== undefined && before !== null) settle(wire, before);
  };

  const press = (event: KeyboardEvent & { currentTarget: HTMLElement }): void => {
    if (typing) {
      event.preventDefault();

      return;
    }

    if (event.key === 'Escape') {
      event.currentTarget.blur();

      return;
    }

    if (event.metaKey || event.altKey) return;
    const held = session();

    if (event.ctrlKey) {
      if (event.key !== 'l') return;
      event.preventDefault();
      show(enter({ ...held, shell: { ...held.shell, input: 'clear' } }));

      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      show(enter(held));
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      show(typed(held, held.shell.input.slice(0, -1)));
    } else if (event.key.length === 1) {
      event.preventDefault();
      show(typed(held, held.shell.input + event.key));
    }
  };

  const typeOut = (command: string): void => {
    if (typing) return;
    typing = true;
    let at = 0;

    const step = (): void => {
      if (at < command.length) {
        at += 1;
        show(typed(session(), command.slice(0, at)));
        later(step, KEY_MS);

        return;
      }

      later(() => {
        show(enter(session()));
        typing = false;
      }, ENTER_MS);
    };

    show(typed(session(), ''));
    step();
  };

  const reset = (): void => {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
    typing = false;
    setSession(openSession());
  };

  const rows = (): ScreenRow[] =>
    Array.from({ length: ROWS }, (_, index) => {
      const held = session();
      const prompt = index === held.shell.cursor;

      return {
        line: prompt ? [...PROMPT, seg(held.shell.input)] : (held.shell.lines[index] ?? []),
        prompt,
      };
    });

  return (
    <>
      <div class="ft ft-wired" data-focused={focused() ? '' : undefined}>
        {/* biome-ignore lint/a11y/useSemanticElements: a terminal, not a form field: keys go to its shell */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: Solid spells the attribute tabindex */}
        <div
          class="ft-screen"
          tabindex="0"
          role="textbox"
          aria-label="Simulated terminal. Type a command and press Enter."
          onKeyDown={press}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        >
          <div class="ft-head ft-head-mono">
            <span class="ft-dot" data-link="up" />
            Mac.bbrouter
            <span class="ft-hint">{focused() ? 'Esc to stop typing' : 'click to type'}</span>
          </div>
          <div class="ft-rows" ref={screen}>
            <Rows rows={rows()}>
              {(row, index) => (
                <div class="ft-row ft-numbered">
                  <span class="ft-bar" />
                  <span class="ft-number">{String(index + 1).padStart(2, '0')}</span>
                  <span class="ft-text">
                    <Segments line={row().line} />
                    {row().prompt && (
                      <span class="ft-caret" data-hollow={focused() ? undefined : ''} />
                    )}
                  </span>
                </div>
              )}
            </Rows>
          </div>
        </div>
        <div class="wire">
          <div class="wire-head">On the wire</div>
          <div class="wire-log" ref={wire}>
            {session().wire.length === 0 && (
              <span class="wire-empty">
                Nothing yet. Each update the daemon sends shows up here.
              </span>
            )}
            {/* Kept by version, so an update's line stays itself as newer ones push it down. */}
            <For each={session().wire} keyed={(update) => update.version}>
              {(update, index) => (
                <div class="wire-update" data-latest={index() === 0 ? '' : undefined}>
                  <span>{update().version}</span>
                  <span>{update().what}</span>
                </div>
              )}
            </For>
          </div>
          <div class="wire-sum">
            <span>
              {session().rowsSent} {session().rowsSent === 1 ? 'row' : 'rows'} sent in{' '}
              {session().updates} {session().updates === 1 ? 'update' : 'updates'}
            </span>
            <span class="wire-full">Full redraws would be {session().updates * ROWS} rows</span>
          </div>
        </div>
      </div>
      <div class="fig-controls">
        <button type="button" class="fig-button" onClick={() => typeOut('ls')}>
          Run <code>ls</code>
        </button>
        <button type="button" class="fig-button" onClick={() => typeOut('git status')}>
          Run <code>git status</code>
        </button>
        <button type="button" class="fig-button" onClick={reset}>
          Reset
        </button>
      </div>
    </>
  );
}
