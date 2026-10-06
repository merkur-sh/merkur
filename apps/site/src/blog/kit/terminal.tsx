/**
 * The terminal a figure draws on. A figure's model says what the rows are
 * (`lines.ts`); these draw them, the same at build time and in the page.
 */
import type { JSX } from '@solidjs/web';
import { For } from 'solid-js';

import type { Line } from './lines';

export function Segments(props: { readonly line: Line }): JSX.Element {
  return (
    <>
      {props.line.map((segment) => (
        <span class={`tk-${segment.tone}`}>
          {segment.mark === true ? <span class="tg">{segment.text}</span> : segment.text}
        </span>
      ))}
    </>
  );
}

/** Rows that keep their elements while what they show changes, so a row can fade. */
export function Rows<T>(props: {
  readonly rows: readonly T[];
  readonly children: (row: () => T, index: number) => JSX.Element;
}): JSX.Element {
  return (
    <For each={props.rows} keyed={false}>
      {props.children}
    </For>
  );
}
