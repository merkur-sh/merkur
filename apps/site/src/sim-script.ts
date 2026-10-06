/**
 * The commands the "Feels local" terminal types and what they print, as the
 * markup of a `<template>` the page carries (`page-facts.ts`, `sim.wide` and
 * `sim.narrow`). The page's script only clones these lines in order
 * (`motion/sim.ts`), so the session's text is in the HTML, set in the pages'
 * own classes, and none of it is in the bundle.
 *
 * A command prints in writes. The rows of one write reach the screen in the
 * same frame, as the rows a real `ls` writes in one go do; a write comes
 * `after` ms of the command's own work, counted from the write before it. A
 * write marked `replace` takes the place of the last row, the way a progress
 * line redraws.
 */
import { escapeHtml } from './vite/html';

type Colour = 'dim' | 'blue' | 'green' | 'yellow' | 'red' | 'peach' | 'sky' | 'mauve';
/** Text, its colour (the terminal's own when absent), and whether it is bold. */
type Segment = readonly [text: string, colour?: Colour, bold?: boolean];
type Row = readonly Segment[];

interface Write {
  readonly after: number;
  readonly rows: readonly Row[];
  readonly replace: boolean;
}

interface Job {
  readonly command: string;
  /** What the command prints; absent for `clear`, which empties the screen. */
  readonly output?: readonly Write[];
}

const write = (after: number, ...rows: readonly Row[]): Write => ({ after, rows, replace: false });
const redraw = (after: number, row: Row): Write => ({ after, rows: [row], replace: true });
const text = (value: string): Row => [[value]];

const PERMISSION_COLOURS: Readonly<Record<string, Colour>> = {
  d: 'blue',
  r: 'yellow',
  w: 'red',
  x: 'green',
};

/** One row of `lsd -l`. */
function listing(
  permissions: string,
  size: string,
  date: string,
  name: string,
  directory = false,
): Segment[] {
  return [
    ...[...permissions].map((flag): Segment => [flag, PERMISSION_COLOURS[flag] ?? 'dim']),
    [' dmytro', 'yellow'],
    [' staff', 'peach'],
    [size.padStart(8), 'green'],
    [`  ${date}  `, 'blue'],
    directory ? [name, 'blue', true] : [name],
  ];
}

/** A passing test, as `bun test` prints it. */
const passed = (name: string, time: string): Segment[] => [
  ['✓', 'green'],
  [` ${name} `],
  [`[${time}]`, 'dim'],
];

const WIDE: readonly Job[] = [
  {
    command: 'lsd -l',
    output: [
      write(
        20,
        listing('drwxr-xr-x', '4.0 KB', 'Fri Oct  2 18:04', 'apps', true),
        listing('drwxr-xr-x', '4.0 KB', 'Thu Oct  1 09:52', 'packages', true),
        listing('.rw-r--r--', '2.1 KB', 'Fri Oct  2 18:04', 'README.md'),
        listing('.rw-r--r--', '148 KB', 'Fri Oct  2 18:04', 'bun.lock'),
        listing('.rw-r--r--', '1.3 KB', 'Wed Sep 30 14:20', 'package.json'),
      ),
    ],
  },
  {
    command: 'git status -sb',
    output: [
      write(
        20,
        [['## '], ['main', 'green'], ['...'], ['origin/main', 'red'], [' [ahead 1]']],
        [[' M', 'red'], [' apps/web/src/terminal/themes.ts']],
        [[' M', 'red'], [' apps/web/src/components/LinkStatus.tsx']],
        [['??', 'red'], [' apps/web/src/components/link-strip.ts']],
      ),
    ],
  },
  {
    command: 'bun test src/session',
    output: [
      write(
        60,
        [
          ['bun test ', undefined, true],
          ['v1.1.30', 'dim'],
        ],
        text(''),
      ),
      write(140, text('src/session/ticket.test.ts:')),
      write(110, passed('issues a ticket for a known device', '0.62ms')),
      write(80, passed('rejects an expired ticket', '0.18ms')),
      write(80, passed('stores expiresAt in milliseconds', '0.09ms')),
      write(
        160,
        text(''),
        [[' 18 pass', 'green']],
        [[' 0 fail', 'dim']],
        [['Ran 18 tests across 3 files. '], ['[214.00ms]', 'dim']],
      ),
    ],
  },
  {
    command: 'git log --oneline -3',
    output: [
      write(
        30,
        [
          ['a41c9e2 ', 'yellow'],
          ['(', 'yellow'],
          ['HEAD -> ', 'sky', true],
          ['main', 'green', true],
          [') ', 'yellow'],
          ['fix: compare expiresAt in ms'],
        ],
        [
          ['7f02b18 ', 'yellow'],
          ['(', 'yellow'],
          ['origin/main', 'red', true],
          [') ', 'yellow'],
          ['feat: link status strip'],
        ],
        [['3c9d5e0 ', 'yellow'], ['relay: drop idle peers after 30s']],
      ),
    ],
  },
  {
    command: 'git push',
    output: [
      write(90, text('Enumerating objects: 9, done.')),
      write(50, text('Counting objects: 100% (9/9), done.')),
      write(90, text('Writing objects:  40% (2/5)')),
      redraw(140, text('Writing objects: 100% (5/5), 612 bytes | 612.00 KiB/s, done.')),
      write(
        420,
        text('To github.com:merkur-sh/merkur.git'),
        text('   7f02b18..a41c9e2  main -> main'),
      ),
    ],
  },
  { command: 'clear' },
];

const NARROW: readonly Job[] = [
  {
    command: 'lsd',
    output: [
      write(
        20,
        [['apps', 'blue', true], ['  '], ['packages', 'blue', true], ['  README.md']],
        text('bun.lock  package.json'),
      ),
    ],
  },
  {
    command: 'git status -s',
    output: [
      write(
        20,
        [[' M', 'red'], [' src/terminal/themes.ts']],
        [['??', 'red'], [' src/link-strip.ts']],
      ),
    ],
  },
  {
    command: 'bun test',
    output: [
      write(
        60,
        [
          ['bun test ', undefined, true],
          ['v1.1.30', 'dim'],
        ],
        text(''),
      ),
      write(180, passed('issues a ticket', '0.62ms')),
      write(80, passed('rejects expired', '0.18ms')),
      write(80, passed('ms timestamps', '0.09ms')),
      write(
        160,
        text(''),
        [[' 18 pass', 'green']],
        [[' 0 fail', 'dim']],
        [['Ran 18 tests '], ['[214ms]', 'dim']],
      ),
    ],
  },
  {
    command: 'git log --oneline -3',
    output: [
      write(
        30,
        [['a41c9e2 ', 'yellow'], ['fix: expiresAt in ms']],
        [['7f02b18 ', 'yellow'], ['feat: link strip']],
        [['3c9d5e0 ', 'yellow'], ['relay: drop idle']],
      ),
    ],
  },
  { command: 'clear' },
];

/** A character outside printable ASCII is a terminal mark, set in its own span. */
function glyphs(value: string): string {
  return [...value]
    .map((character) =>
      character.charCodeAt(0) > 0x7e
        ? `<span class="tg" aria-hidden="true">${character}</span>`
        : escapeHtml(character),
    )
    .join('');
}

function segmentMarkup([value, colour, bold]: Segment): string {
  const marks = `${colour === undefined ? '' : ` data-ink="${colour}"`}${bold === true ? ' data-bold' : ''}`;
  // An empty line still takes its row.
  const body = value === '' ? ' ' : glyphs(value);
  return marks === '' ? body : `<span${marks}>${body}</span>`;
}

function jobMarkup(job: Job): string {
  if (job.output === undefined) {
    return `<div data-cmd="${escapeHtml(job.command)}" data-clear></div>`;
  }
  const writes = job.output
    .map(
      (entry) =>
        `<div data-after="${entry.after}"${entry.replace ? ' data-replace' : ''}>${entry.rows
          .map((row) => `<div>${row.map(segmentMarkup).join('')}</div>`)
          .join('')}</div>`,
    )
    .join('');
  return `<div data-cmd="${escapeHtml(job.command)}">${writes}</div>`;
}

export function simScriptMarkup(layout: 'wide' | 'narrow'): string {
  const greeting =
    layout === 'wide'
      ? 'Last login: Sat Oct  3 09:41:12 on ttys004'
      : 'Last login: Sat Oct  3 09:41';
  return `<div data-ink="dim" data-greeting>${greeting}</div>${(layout === 'wide' ? WIDE : NARROW)
    .map(jobMarkup)
    .join('')}`;
}
