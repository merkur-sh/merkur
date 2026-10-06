/**
 * Figure 2's shell and its diff: a ten-row screen, a few commands, and after
 * every write the rows that differ from what was last sent. A row that only
 * moved up with a scroll is not sent again; the scroll is one shift.
 */
import { type Line, lineText, PROMPT, PROMPT_TEXT, seg } from '../../../../../src/blog/kit/lines';

/** The rows the terminal shows. */
export const ROWS = 10;

/** The longest command the prompt takes, in characters. */
export const INPUT_LIMIT = 44;

/** The updates "On the wire" keeps in view. */
const WIRE_KEPT = 9;

export interface Shell {
  readonly lines: readonly Line[];
  /** The row the prompt is on. */
  readonly cursor: number;
  readonly input: string;
}

/** A row's part in the last update: sent, or moved up by its scroll. */
export type Flash = 'sent' | 'moved';

export interface Session {
  readonly shell: Shell;
  /** The screen's version; every update bumps it. */
  readonly version: number;
  readonly flash: Readonly<Record<number, Flash>>;
  /** The updates sent, newest first. */
  readonly wire: readonly { readonly version: string; readonly what: string }[];
  readonly rowsSent: number;
  readonly updates: number;
}

const LISTING: Line = [
  seg('apps', 'blue'),
  seg('  '),
  seg('crates', 'blue'),
  seg('  '),
  seg('docs', 'blue'),
  seg('  '),
  seg('notes', 'blue'),
  seg('  Cargo.toml  README.md'),
];

export function openSession(): Session {
  return {
    shell: {
      lines: [
        [...PROMPT, seg('cargo build --release')],
        [seg('   Compiling ', 'green'), seg('merkur-proto v0.9.2')],
        [seg('   Compiling ', 'green'), seg('merkur-daemon v0.9.2')],
        [seg('    Finished ', 'green'), seg('release in 41.8s')],
        [...PROMPT, seg('ls')],
        LISTING,
        [],
        [],
        [],
        [],
      ],
      cursor: 6,
      input: '',
    },
    version: 4182,
    flash: {},
    wire: [],
    rowsSent: 0,
    updates: 0,
  };
}

/** What a command prints. */
export function output(command: string): Line[] {
  const [name = '', ...rest] = command.split(/\s+/);
  const first = rest[0] ?? '';

  if (name === '') return [];

  if (name === 'ls') return [LISTING];

  if (name === 'git' && first === 'status') {
    return [
      [seg('On branch main')],
      [seg('Changes not staged for commit:')],
      [seg('        modified:   crates/proto/src/diff.rs', 'red')],
    ];
  }

  if (name === 'git' && first === 'log') {
    return [
      [seg('a3f9c21 ', 'yellow'), seg('proto: send scrolls as one instruction')],
      [seg('9be04d7 ', 'yellow'), seg('daemon: hash rows on write')],
      [seg('51c0e8a ', 'yellow'), seg('web: draw rows as they arrive')],
    ];
  }

  if (name === 'git') return [[seg(`git: '${first}' is not a git command. See 'git --help'.`)]];

  if (name === 'date') return [[seg('Thu Sep 24 21:14:07 BST 2026')]];

  if (name === 'echo') return [[seg(rest.join(' '))]];

  if (name === 'whoami') return [[seg('dmytro')]];

  if (name === 'pwd') return [[seg('/Users/dmytro/mercury')]];

  if (name === 'help') {
    return [[seg('try ls, git status, git log, date, echo or clear', 'overlay1')]];
  }

  return [[seg(`zsh: command not found: ${name}`)]];
}

/** A command's effect on the screen: the shell after it, and how many rows it scrolled by. */
export interface Ran {
  readonly shell: Shell;
  readonly scrolled: number;
}

/** The shell after Enter, and how many rows the screen scrolled by. */
export function run(shell: Shell): Ran {
  const command = shell.input.trim();

  if (command === 'clear') {
    return {
      shell: { lines: Array.from({ length: ROWS }, () => []), cursor: 0, input: '' },
      scrolled: 0,
    };
  }

  const lines = [...shell.lines];
  let cursor = shell.cursor;
  let scrolled = 0;
  lines[cursor] = [...PROMPT, seg(shell.input)];

  for (const line of [...output(command), []]) {
    if (cursor < ROWS - 1) {
      cursor += 1;
      lines[cursor] = line;
    } else {
      lines.shift();
      lines.push(line);
      scrolled += 1;
    }
  }

  return { shell: { lines, cursor, input: '' }, scrolled };
}

/** The screen as text, one string a row: what a row's hash is taken of. */
export function screenText(shell: Shell): string[] {
  return shell.lines.map((line, index) =>
    index === shell.cursor ? PROMPT_TEXT + shell.input : lineText(line),
  );
}

/** Row numbers as a reader counts them, runs closed up: "1, 3–5". */
export function rowRanges(rows: readonly number[]): string {
  const ranges: string[] = [];
  let start = rows[0];
  let end = rows[0];

  if (start === undefined || end === undefined) return '';

  for (const row of [...rows.slice(1), Number.NaN]) {
    if (row === end + 1) {
      end = row;
      continue;
    }

    ranges.push(start === end ? String(start + 1) : `${start + 1}–${end + 1}`);
    start = row;
    end = row;
  }

  return ranges.join(', ');
}

/**
 * The session once the screen has become `next`: the rows that differ are
 * sent, less those a scroll of `scrolled` rows merely moved up. A screen that
 * did not change sends nothing.
 */
export function commit(session: Session, next: Shell, scrolled: number): Session {
  const before = screenText(session.shell);
  const after = screenText(next);
  const sent: number[] = [];
  const moved: number[] = [];

  for (const [index, row] of after.entries()) {
    if (row === before[index]) continue;

    if (scrolled > 0 && before[index + scrolled] === row) moved.push(index);
    else sent.push(index);
  }

  if (sent.length === 0 && moved.length === 0) return { ...session, shell: next };
  const flash: Record<number, Flash> = {};

  for (const index of sent) flash[index] = 'sent';

  for (const index of moved) flash[index] = 'moved';
  const parts: string[] = [];

  if (scrolled > 0) parts.push(`shift ↑${scrolled}`);

  if (sent.length > 0) parts.push(`${sent.length > 1 ? 'rows' : 'row'} ${rowRanges(sent)}`);
  const version = session.version + 1;

  return {
    shell: next,
    version,
    flash,
    wire: [{ version: `v${version}`, what: parts.join(' + ') }, ...session.wire].slice(
      0,
      WIRE_KEPT,
    ),
    rowsSent: session.rowsSent + sent.length,
    updates: session.updates + 1,
  };
}

/** The session after the prompt's text has become `input`. */
export function type(session: Session, input: string): Session {
  return commit(session, { ...session.shell, input: input.slice(0, INPUT_LIMIT) }, 0);
}

/** The session after Enter. */
export function enter(session: Session): Session {
  const { shell, scrolled } = run(session.shell);

  return commit(session, shell, scrolled);
}
