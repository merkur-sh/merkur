import path from 'node:path';

/**
 * A shell-line splitter for the PreToolUse guards.
 *
 * Guards reason about *simple commands*: one program, its arguments, and the directory it
 * will run in. A Bash tool call hands us a whole line — pipelines, `&&` lists, `cd x && …`,
 * `$( )` substitutions, `env FOO=1 cmd`, `xargs cmd` — so this module reduces that line to
 * the list of simple commands it will execute. It is deliberately an over-approximation:
 * a command inside a `$( )` or a subshell is reported as if it ran at top level, and a `cd`
 * anywhere in a list changes the effective cwd of everything after it. A guard that denies
 * on the over-approximation denies a command the line really would have run.
 *
 * Pure: no filesystem, no environment. `cwd` is the hook's reported directory; `home` is
 * what an unquoted leading `~` expands to, as the shell would expand it.
 */

export interface SimpleCommand {
  /** Program and arguments after prefix stripping; quotes removed. */
  readonly argv: readonly string[];
  /** Absolute effective working directory, tracked through `cd`. */
  readonly cwd: string;
  /** This command reads the previous one's stdout (`a | b`). */
  readonly pipedFromPrevious: boolean;
  /** Terminated by a single `&`. */
  readonly background: boolean;
  /** `--help` or `-h` appears among the arguments. */
  readonly hasHelp: boolean;
  /** The original text of this segment, for messages. */
  readonly raw: string;
}

type Separator = '&&' | '||' | ';' | '|' | '\n' | '&';

interface Segment {
  readonly text: string;
  /** The separator that preceded this segment (undefined for the first). */
  readonly before: Separator | undefined;
  /** The separator that followed this segment. */
  readonly after: Separator | undefined;
}

const GLOB_CHARS = /[*?[]/;

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r';
}

/**
 * Find the index of the `)` closing a `$(` opened just before `from`, honouring nested
 * parentheses and quotes. Returns the text length when unbalanced.
 */
function findClosingParen(text: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '\\') {
      index += 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

/** Lift every `$( )` and backtick substitution in `text` out into `into`. */
function collectSubstitutions(text: string, into: string[]): void {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '$' && text[index + 1] === '(') {
      const close = findClosingParen(text, index + 2);
      into.push(text.slice(index + 2, close));
      index = close;
    } else if (text[index] === '`') {
      let close = text.indexOf('`', index + 1);
      if (close === -1) close = text.length;
      into.push(text.slice(index + 1, close));
      index = close;
    }
  }
}

interface Heredoc {
  readonly delimiter: string;
  /** A quoted delimiter makes the body literal: no substitutions run inside it. */
  readonly quoted: boolean;
  /** `<<-` strips leading tabs, so an indented delimiter line still ends the body. */
  readonly stripTabs: boolean;
}

/** Parse the delimiter after a `<<` that ends at `from`; `end` is the index just past it. */
function heredocAt(line: string, from: number): { heredoc: Heredoc; end: number } | null {
  let index = from;
  const stripTabs = line[index] === '-';
  if (stripTabs) index += 1;
  while (line[index] === ' ' || line[index] === '\t') index += 1;
  let delimiter = '';
  let quoted = false;
  for (; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (char === "'" || char === '"') {
      const close = line.indexOf(char, index + 1);
      if (close === -1) return null;
      delimiter += line.slice(index + 1, close);
      quoted = true;
      index = close;
    } else if (char === '\\') {
      quoted = true;
    } else if (/[\s;&|<>()]/.test(char)) {
      break;
    } else {
      delimiter += char;
    }
  }
  return delimiter === '' ? null : { heredoc: { delimiter, quoted, stripTabs }, end: index };
}

/**
 * Skip the bodies of the heredocs opened on the line that just ended, starting at `from`.
 * A body is data, not commands; only an unquoted body's substitutions run. Returns the
 * index of the first character after the last delimiter line.
 */
function skipHeredocBodies(
  line: string,
  from: number,
  heredocs: readonly Heredoc[],
  substitutions: string[],
): number {
  let position = from;
  for (const heredoc of heredocs) {
    while (position < line.length) {
      let lineEnd = line.indexOf('\n', position);
      if (lineEnd === -1) lineEnd = line.length;
      const text = line.slice(position, lineEnd);
      position = lineEnd + 1;
      const candidate = heredoc.stripTabs ? text.replace(/^\t+/, '') : text;
      if (candidate === heredoc.delimiter) break;
      if (!heredoc.quoted) collectSubstitutions(text, substitutions);
    }
  }
  return Math.min(position, line.length);
}

/**
 * First pass: cut the line into segments at list/pipe operators, quote-aware, lift every
 * `$( )` / backtick substitution out into its own segment list, and step over heredoc bodies.
 */
function segment(line: string): { segments: Segment[]; substitutions: string[] } {
  const segments: Segment[] = [];
  const substitutions: string[] = [];
  const heredocs: Heredoc[] = [];
  let current = '';
  let before: Separator | undefined;
  let quote: string | null = null;

  const push = (after: Separator | undefined): void => {
    if (current.trim() !== '') segments.push({ text: current, before, after });
    current = '';
    before = after;
  };

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    const next = line[index + 1] ?? '';
    if (quote !== null) {
      current += char;
      if (char === '\\' && quote === '"' && next !== '') {
        current += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '\\') {
      current += char + next;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '$' && next === '(') {
      const close = findClosingParen(line, index + 2);
      substitutions.push(line.slice(index + 2, close));
      current += line.slice(index, close + 1);
      index = close;
      continue;
    }
    if (char === '`') {
      let close = line.indexOf('`', index + 1);
      if (close === -1) close = line.length;
      substitutions.push(line.slice(index + 1, close));
      current += line.slice(index, close + 1);
      index = close;
      continue;
    }
    if (char === '&' && next === '&') {
      push('&&');
      index += 1;
      continue;
    }
    if (char === '|' && next === '|') {
      push('||');
      index += 1;
      continue;
    }
    if (char === '|') {
      if (next === '&') index += 1;
      push('|');
      continue;
    }
    // `<<` opens a heredoc; `<<<` is a here-string, whichever `<` the scan is on.
    if (char === '<' && next === '<' && line[index + 2] !== '<' && line[index - 1] !== '<') {
      const opened = heredocAt(line, index + 2);
      if (opened !== null) {
        heredocs.push(opened.heredoc);
        current += line.slice(index, opened.end);
        index = opened.end - 1;
        continue;
      }
    }
    if (char === ';' || char === '\n') {
      push(char);
      if (char === '\n' && heredocs.length > 0) {
        index = skipHeredocBodies(line, index + 1, heredocs, substitutions) - 1;
        heredocs.length = 0;
      }
      continue;
    }
    if (char === '&') {
      // `&>` and `>&` / `<&` are redirections, not the background operator.
      const previous = line[index - 1] ?? '';
      if (next === '>' || previous === '>' || previous === '<') {
        current += char;
        continue;
      }
      push('&');
      continue;
    }
    current += char;
  }
  push(undefined);
  return { segments, substitutions };
}

/**
 * Second pass: split one segment into words, removing quotes and escapes and expanding an
 * unquoted `~` or `~/` at the start of a word to `home`.
 */
export function tokenize(text: string, home: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && next !== '') {
        word += next;
        index += 1;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === '\\' && next !== '') {
      word += next;
      inWord = true;
      index += 1;
      continue;
    }
    if (char === '$' && next === '(') {
      const close = findClosingParen(text, index + 2);
      word += text.slice(index, close + 1);
      inWord = true;
      index = close;
      continue;
    }
    if (char === '`') {
      let close = text.indexOf('`', index + 1);
      if (close === -1) close = text.length;
      word += text.slice(index, close + 1);
      inWord = true;
      index = close;
      continue;
    }
    if (isSpace(char) || char === '(' || char === ')') {
      if (inWord) {
        words.push(word);
        word = '';
        inWord = false;
      }
      continue;
    }
    if (
      char === '~' &&
      !inWord &&
      (next === '' || next === '/' || isSpace(next) || next === '(' || next === ')')
    ) {
      word += home;
      inWord = true;
      continue;
    }
    word += char;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

const REDIRECTION_OPERATOR = /^\d*(?:<<<|<<-?|>>|>&|<&|<>|>\||[<>])\d*$/;
const REDIRECTION_WITH_TARGET = /^\d*(?:>>|>&|<&|<>|>\||[<>])\S+$/;

/** Drop `> file`, `2>&1`, `<file`, `<< EOF`, keeping every other word in order. */
export function stripRedirections(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (REDIRECTION_OPERATOR.test(word)) {
      if (!/[&]\d+$/.test(word)) index += 1;
      continue;
    }
    if (REDIRECTION_WITH_TARGET.test(word)) continue;
    out.push(word);
  }
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const BARE_WRAPPERS = new Set(['time', 'nice', 'nohup', 'command', 'exec', 'builtin', 'ionice']);
const XARGS_FLAGS_WITH_ARG = new Set(['-n', '-I', '-P', '-L', '-s', '-d', '-E', '-a']);

/**
 * Peel wrappers off the front until the real program is exposed: `FOO=1`, `env`, `sudo`,
 * `time`, `timeout 5`, `xargs -0 cmd`.
 */
export function stripPrefixes(words: readonly string[]): string[] {
  let argv = [...words];
  for (;;) {
    const head = argv[0];
    if (head === undefined) return argv;
    if (ASSIGNMENT.test(head)) {
      argv = argv.slice(1);
      continue;
    }
    if (BARE_WRAPPERS.has(head)) {
      argv = argv.slice(1);
      continue;
    }
    if (head === 'env' || head === 'sudo' || head === 'doas') {
      let index = 1;
      while (index < argv.length) {
        const word = argv[index] ?? '';
        if (ASSIGNMENT.test(word)) {
          index += 1;
        } else if (word === '-u' || word === '-C' || word === '-S' || word === '-g') {
          index += 2;
        } else if (word.startsWith('-')) {
          index += 1;
        } else {
          break;
        }
      }
      argv = argv.slice(index);
      continue;
    }
    if (head === 'timeout') {
      let index = 1;
      while (index < argv.length && (argv[index] ?? '').startsWith('-')) {
        const word = argv[index] ?? '';
        index += word === '-s' || word === '-k' || word === '--signal' ? 2 : 1;
      }
      argv = argv.slice(index + 1);
      continue;
    }
    if (head === 'xargs') {
      let index = 1;
      while (index < argv.length) {
        const word = argv[index] ?? '';
        if (!word.startsWith('-')) break;
        if (XARGS_FLAGS_WITH_ARG.has(word)) {
          index += 2;
        } else if (word.startsWith('--') && word.includes('=')) {
          index += 1;
        } else if (
          word === '--max-args' ||
          word === '--replace' ||
          word === '--max-procs' ||
          word === '--max-lines' ||
          word === '--delimiter' ||
          word === '--arg-file' ||
          word === '--eof'
        ) {
          index += 2;
        } else {
          index += 1;
        }
      }
      argv = argv.slice(index);
      continue;
    }
    return argv;
  }
}

/**
 * The directory a `cd`/`pushd` moves to. A bare `cd` goes home; `cd -`, a bare `pushd`,
 * and a target the line cannot resolve (`$VAR`, a glob, `~user`) leave the cwd as it was.
 */
function resolveCd(cwd: string, home: string, argv: readonly string[]): string {
  const target = argv.slice(1).find((word) => word === '-' || !word.startsWith('-'));
  if (target === undefined) return argv[0] === 'cd' ? home : cwd;
  if (target === '-' || target.startsWith('~') || target.startsWith('$')) return cwd;
  if (GLOB_CHARS.test(target)) return cwd;
  return path.resolve(cwd, target);
}

function buildCommand(
  text: string,
  cwd: string,
  home: string,
  pipedFromPrevious: boolean,
  background: boolean,
): SimpleCommand | null {
  const words = tokenize(text, home).filter((word) => word !== '{' && word !== '}');
  const argv = stripPrefixes(stripRedirections(words));
  if (argv.length === 0) return null;
  return {
    argv,
    cwd,
    pipedFromPrevious,
    background,
    hasHelp: argv.includes('--help') || argv.includes('-h'),
    raw: text.trim(),
  };
}

/**
 * Reduce a shell line to the simple commands it runs, in source order, with the effective
 * cwd tracked through `cd`. Substitutions are appended after the command that contains them.
 */
export function splitCommandLine(line: string, cwd: string, home: string): SimpleCommand[] {
  const { segments, substitutions } = segment(line);
  const commands: SimpleCommand[] = [];
  let effectiveCwd = path.resolve(cwd);

  for (const item of segments) {
    const command = buildCommand(
      item.text,
      effectiveCwd,
      home,
      item.before === '|',
      item.after === '&',
    );
    if (command === null) continue;
    commands.push(command);
    if (command.argv[0] === 'cd' || command.argv[0] === 'pushd') {
      effectiveCwd = resolveCd(effectiveCwd, home, command.argv);
    }
  }

  for (const inner of substitutions) {
    commands.push(...splitCommandLine(inner, effectiveCwd, home));
  }
  return commands;
}

export function hasGlob(word: string): boolean {
  return GLOB_CHARS.test(word);
}
