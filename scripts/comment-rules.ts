/**
 * The comment rules of `check:slop`: comments that hedge about the code beside them, in script
 * files and in Rust. `scripts/check-slop.ts` decides which files are read, and holds the findings
 * to `lint-baselines/anti-slop.json` beside those of the Biome rules.
 *
 * The rules are the `RULES` table, matched on the text of comments and nothing else: four
 * phrases that put off or doubt what the code does, in any letter case, and the two upper-case
 * markers of unfinished work when their comment holds no URL. A word or phrase matches whole: a
 * letter, digit or underscore of any script on either side makes it part of another word, and
 * the words of a phrase stand on one line. A comment is one `//` line or one block, doc comments
 * included, so the URL that excuses a marker is in that line or that block. Each finding is at
 * the line and column of the matched words, and its message is the repair instruction.
 *
 * A script file's comments come from the parser (`scriptComments`), so a string, a template or
 * JSX text is never one; a Rust file's come from `rustComments`. A file that cannot be read for
 * its comments has no answer: the gate fails as unverified, never as a pass.
 */
import { type Comment, parseSync } from 'oxc-parser';

import { type Finding, UnverifiedError } from './lint-ratchet';

/** A comment as both readers give it: the offset of its opener, and its text after the two-character opener. */
export interface SourceComment {
  readonly start: number;
  readonly value: string;
}

export interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  /** A comment this matches is not held to the rule. */
  readonly excuse: RegExp | null;
  readonly message: string;
}

const WORD_CHARACTER = String.raw`[\p{L}\p{N}_]`;

/** `words` standing whole: not continued by a word character on either side. */
function whole(words: string, flags: string): RegExp {
  return new RegExp(`(?<!${WORD_CHARACTER})(?:${words})(?!${WORD_CHARACTER})`, flags);
}

/** Each rule: its name in the baseline, the words it matches, and the repair instruction it prints. */
export const RULES: readonly Rule[] = [
  {
    name: 'comment-for-now',
    pattern: whole(String.raw`for[ \t]+now`, 'giu'),
    excuse: null,
    message:
      'A comment that says "for now" promises a change no one is held to: describe what the code does, or make the change.',
  },
  {
    name: 'comment-temporary',
    pattern: whole('temporary|temporarily', 'giu'),
    excuse: null,
    message:
      'A comment that calls code temporary does not say what ends it: name the condition that removes the code, or describe the code as it stands.',
  },
  {
    name: 'comment-should-work',
    pattern: whole(String.raw`should[ \t]+work`, 'giu'),
    excuse: null,
    message:
      'A comment that says something "should work" records a guess: run it, then state what the code does.',
  },
  {
    name: 'comment-hopefully',
    pattern: whole('hopefully', 'giu'),
    excuse: null,
    message:
      '"Hopefully" marks an outcome nobody checked: find the signal that settles it, then state what the code guarantees.',
  },
  {
    name: 'comment-todo-without-link',
    pattern: whole('TODO|FIXME', 'gu'),
    excuse: /https?:\/\//,
    message:
      'A TODO or FIXME with no link is tracked nowhere: put the URL of the issue that tracks it in the same comment, or do the work now.',
  },
];

/** Matches wherever a rule can: a file's comments are read only when its text holds a candidate. */
const CANDIDATE = new RegExp(RULES.map((rule) => rule.pattern.source).join('|'), 'iu');

/** What can open a comment in Rust source or hide one: an opener, a quote, or a word, which may prefix a raw string. */
const RUST_TOKEN = /\/\/|\/\*|["']|[\p{L}\p{N}_]+/gu;

/** The words that, directly before `"` or `#…#"`, open a raw string: plain, byte and C. */
const RAW_PREFIXES = new Set(['r', 'br', 'cr']);

/** The index after the block comment that opens at `start`. Block comments nest. */
function blockCommentEnd(file: string, source: string, start: number): number {
  let depth = 1;
  let at = start + 2;

  while (depth > 0) {
    const open = source.indexOf('/*', at);
    const close = source.indexOf('*/', at);

    if (close === -1) throw new UnverifiedError(`${file}: a block comment is never closed`);

    if (open !== -1 && open < close) {
      depth += 1;
      at = open + 2;
    } else {
      depth -= 1;
      at = close + 2;
    }
  }

  return at;
}

/** The index after the string literal whose opening quote is at `start`; a backslash escapes the next character. */
function stringEnd(file: string, source: string, start: number): number {
  let at = start + 1;

  while (at < source.length) {
    const character = source[at];

    if (character === '"') return at + 1;

    at += character === '\\' ? 2 : 1;
  }

  throw new UnverifiedError(`${file}: a string literal is never closed`);
}

/**
 * The index after the character literal whose quote is at `start`, or after the quote alone when
 * it opens a lifetime or a label. `'a'`, `'\''` and `'\u{1F600}'` are characters: an escape, or
 * one character with a quote straight after it. `'a` and `'static` are lifetimes.
 */
function quoteEnd(file: string, source: string, start: number): number {
  if (source[start + 1] === '\\') {
    // The character after the backslash is escaped, so the closing quote is the next one after it.
    const close = source.indexOf("'", start + 3);

    if (close === -1) throw new UnverifiedError(`${file}: a character literal is never closed`);

    return close + 1;
  }

  const width = (source.codePointAt(start + 1) ?? 0) > 0xffff ? 2 : 1;

  return source[start + 1 + width] === "'" ? start + width + 2 : start + 1;
}

/**
 * The index after the word at `start`, or after the raw string it opens: `r"…"`, `r#"…"#` with
 * any number of hashes, and the same behind `br` and `cr`. A raw string ends at the first quote
 * followed by as many hashes as opened it, and nothing in it is an escape. A raw identifier
 * (`r#type`) has no quote after its hash and is only a word.
 */
function wordEnd(file: string, source: string, start: number, word: string): number {
  const end = start + word.length;

  if (!RAW_PREFIXES.has(word)) return end;

  let hashes = 0;

  while (source[end + hashes] === '#') hashes += 1;

  if (source[end + hashes] !== '"') return end;

  const closer = `"${'#'.repeat(hashes)}`;
  const close = source.indexOf(closer, end + hashes + 1);

  if (close === -1) throw new UnverifiedError(`${file}: a raw string literal is never closed`);

  return close + closer.length;
}

/**
 * The comments of one script file. A string, a template or JSX text is not a comment, whatever
 * it holds; a file that does not parse has no answer.
 */
export function scriptComments(file: string, source: string): Comment[] {
  const parsed = parseSync(file, source);

  if (parsed.errors.length > 0) {
    throw new UnverifiedError(`could not parse ${file} to read its comments`);
  }

  return parsed.comments;
}

/**
 * The comments of one Rust source file: line comments, block comments, which nest, and the doc
 * forms of both. A `//` or `/*` inside a string, byte string, raw string or character literal is
 * not a comment. Source the lexer cannot follow to its end has no answer.
 */
export function rustComments(file: string, source: string): SourceComment[] {
  const comments: SourceComment[] = [];
  const token = new RegExp(RUST_TOKEN);
  let at = 0;

  for (;;) {
    token.lastIndex = at;

    const match = token.exec(source);

    if (match === null) return comments;

    const start = match.index;
    const [text] = match;

    if (text === '//') {
      const newline = source.indexOf('\n', start);
      at = newline === -1 ? source.length : newline;
      comments.push({ start, value: source.slice(start + 2, at) });
    } else if (text === '/*') {
      at = blockCommentEnd(file, source, start);
      comments.push({ start, value: source.slice(start + 2, at - 2) });
    } else if (text === '"') {
      at = stringEnd(file, source, start);
    } else if (text === "'") {
      at = quoteEnd(file, source, start);
    } else {
      at = wordEnd(file, source, start, text);
    }
  }
}

/** The hedges in the comments of one file, each at the line and column of the matched words, in file order. */
export function findHedges(
  file: string,
  source: string,
  comments: readonly SourceComment[],
): Finding[] {
  const findings: Finding[] = [];

  for (const comment of comments) {
    for (const rule of RULES) {
      if (rule.excuse?.test(comment.value) === true) continue;

      for (const match of comment.value.matchAll(rule.pattern)) {
        // A comment's text starts after its two-character opener.
        const offset = comment.start + 2 + match.index;
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1;

        findings.push({
          file,
          rule: rule.name,
          line: source.slice(0, offset).split('\n').length,
          column: offset - lineStart + 1,
          message: rule.message,
        });
      }
    }
  }

  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

/** Whether a path is Rust source, which `rustComments` reads; any other file is read as a script. */
export function isRustSource(file: string): boolean {
  return file.endsWith('.rs');
}

/** The findings of one file's text; its comments are read only when the text holds a candidate. */
export function measureFile(file: string, source: string): Finding[] {
  if (!CANDIDATE.test(source)) return [];

  const comments = isRustSource(file) ? rustComments(file, source) : scriptComments(file, source);

  return findHedges(file, source, comments);
}
