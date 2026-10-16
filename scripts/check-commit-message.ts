import { readFileSync } from 'node:fs';

import { findProseSlop } from './prose-rules';

/**
 * The `commit-msg` hook's check (`.githooks/commit-msg`): a commit message carries no AI
 * attribution and none of the phrasings of `scripts/prose-rules.ts`.
 *
 * Attribution is a trailer or a line that credits a model or an assistant (`Co-Authored-By:
 * Claude …`, `Generated with Claude Code`, the robot emoji). The commits are the author's; a
 * harness that asks for the trailer is overruled here. Git's comment lines and everything below
 * the scissors line of `commit -v` are not the message. Inline code is not prose.
 *
 *   bun run scripts/check-commit-message.ts <message-file>
 */

const SCISSORS = /^# -+ >8 -+$/;
const INLINE_CODE = /`[^`\n]+`/g;
const ATTRIBUTION =
  /^[ \t]*(?:co-authored-by|generated-by|assisted-by|made-with)[ \t]*:.*\b(?:claude|anthropic|codex|openai|chatgpt|gpt-\d|copilot|gemini)\b|\bgenerated (?:with|by) \[?(?:claude|codex|chatgpt|copilot)|🤖/iu;

export interface MessageProblem {
  readonly line: number;
  readonly detail: string;
  readonly reason: string;
}

/** The lines of the message itself, numbered from 1, without comments or the diff below the scissors. */
export function messageLines(text: string): { line: number; text: string }[] {
  const lines: { line: number; text: string }[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (SCISSORS.test(line)) break;
    if (line.startsWith('#')) continue;
    lines.push({ line: index + 1, text: line });
  }
  return lines;
}

export function checkCommitMessage(text: string): MessageProblem[] {
  const lines = messageLines(text);
  const problems: MessageProblem[] = [];
  for (const { line, text: content } of lines) {
    if (ATTRIBUTION.test(content)) {
      problems.push({
        line,
        detail: content.trim(),
        reason: 'commits carry no AI attribution; delete the line',
      });
    }
  }
  const prose = lines.map(({ line, text: content }) => ({
    line,
    text: content.replace(INLINE_CODE, ''),
  }));
  for (const finding of findProseSlop(prose)) {
    problems.push({
      line: finding.line,
      detail: `${finding.rule}: ${finding.text}`,
      reason: finding.message,
    });
  }
  return problems.sort((left, right) => left.line - right.line);
}

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write('usage: bun run scripts/check-commit-message.ts <message-file>\n');
    process.exit(2);
  }
  const problems = checkCommitMessage(readFileSync(file, 'utf8'));
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(
        `commit message:${problem.line} ${problem.detail} — ${problem.reason}\n`,
      );
    }
    process.stderr.write(
      '\nThe message is kept in .git/COMMIT_EDITMSG; fix it and commit again.\n',
    );
    process.exit(1);
  }
}
