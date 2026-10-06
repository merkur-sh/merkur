/**
 * The four small pictures under the simulator: cells changing one at a time,
 * one row of six being sent, a bar squeezed for the wire, a packet lost and
 * rebuilt. Each repaints a few pixels a few times a second, and only while it
 * is on screen. They are Motion animations handed to the browser whole
 * (`animateMini`), so no script runs between one step and the next.
 */
import { animateMini } from 'motion';

import { createAgenda, EASE_OUT, onScreen } from './clock';
import { squeeze } from './loops';

const CELL_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789{}[]<>=+-*/$#@';
const pick = <T>(from: ArrayLike<T>): T | undefined =>
  from[Math.floor(Math.random() * from.length)];

/** Runs `step` every `ms` while `element` is on screen. */
function every(element: HTMLElement, ms: number, step: () => void): void {
  const agenda = createAgenda();
  const tick = (): void => {
    step();
    agenda.at(ms, tick);
  };
  agenda.at(ms, tick);
  onScreen(element, (on) => (on ? agenda.resume() : agenda.pause()), 0.2);
}

function playCells(element: HTMLElement): void {
  const cells = element.querySelectorAll<HTMLElement>('span');
  every(element, 110, () => {
    const cell = pick(cells);
    const character = pick(CELL_CHARACTERS);
    if (cell === undefined || character === undefined) return;
    cell.textContent = character;
    animateMini(
      cell,
      {
        color: ['#f8f8fc', '#686871'],
        backgroundColor: ['rgba(127, 90, 240, 0.35)', 'rgba(255, 255, 255, 0.025)'],
      },
      { duration: 0.9, ease: EASE_OUT },
    );
  });
}

function playRows(element: HTMLElement): void {
  const rows = element.querySelectorAll<HTMLElement>('span:not([data-r-tag])');
  const tag = element.querySelector<HTMLElement>('[data-r-tag]');
  if (tag === null) throw new Error('site: the rows picture has no tag');
  every(element, 1100, () => {
    const index = Math.floor(Math.random() * rows.length);
    const row = rows[index];
    if (row !== undefined) {
      animateMini(
        row,
        { backgroundColor: ['#cba6f7', '#26262e'] },
        { duration: 1, ease: EASE_OUT },
      );
    }
    tag.textContent = `row ${index + 1} sent`;
    animateMini(
      tag,
      {
        opacity: [0, 1, 1, 0],
        transform: ['translateX(-6px)', 'translateX(0px)', 'translateX(0px)', 'translateX(6px)'],
      },
      { duration: 1, times: [0, 0.2, 0.7, 1], ease: 'linear' },
    );
  });
}

function playParity(element: HTMLElement): void {
  const packets = element.querySelectorAll<HTMLElement>('[data-p]');
  const note = element.querySelector<HTMLElement>('[data-fec-note]');
  if (note === null) throw new Error('site: the parity picture has no note');
  const rest = note.textContent ?? '';
  const say = (text: string, state: 'lost' | 'rebuilt' | null): void => {
    note.textContent = text;
    if (state === null) delete note.dataset.note;
    else note.dataset.note = state;
    animateMini(
      note,
      { opacity: [0, 1], transform: ['translateY(3px)', 'translateY(0px)'] },
      { duration: 0.3, ease: EASE_OUT },
    );
  };
  let turn = 0;
  let timers: number[] = [];
  every(element, 2600, () => {
    const index = turn % packets.length;
    turn += 1;
    const packet = packets[index];
    if (packet !== undefined) {
      animateMini(
        packet,
        {
          opacity: [1, 0.12, 0.12, 1],
          borderColor: [
            'rgba(255, 255, 255, 0.12)',
            'rgba(243, 139, 168, 0.85)',
            'rgba(166, 227, 161, 0.9)',
            'rgba(255, 255, 255, 0.12)',
          ],
        },
        { duration: 2, times: [0, 0.12, 0.55, 1], ease: 'linear' },
      );
    }
    for (const timer of timers) window.clearTimeout(timer);
    say(`packet ${index + 1} lost`, 'lost');
    timers = [
      window.setTimeout(() => say('rebuilt from parity', 'rebuilt'), 1100),
      window.setTimeout(() => say(rest, null), 2200),
    ];
  });
}

export function playCards(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-fx]')) {
    const kind = element.dataset.fx;
    if (kind === 'cells') playCells(element);
    else if (kind === 'rows') playRows(element);
    else if (kind === 'fec') playParity(element);
  }
  for (const bar of document.querySelectorAll<HTMLElement>('[data-z]')) squeeze(bar);
}
