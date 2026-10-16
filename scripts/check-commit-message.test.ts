import { expect, test } from 'bun:test';

import { checkCommitMessage, messageLines } from './check-commit-message';

function problems(text: string): string[] {
  return checkCommitMessage(text).map((problem) => `${problem.line} ${problem.detail}`);
}

test('an AI attribution trailer or credit line is refused, a human co-author is not', () => {
  const message = [
    'Scope the Stop hook to the session',
    '',
    'The hook reads the files this session edited.',
    '',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    'Co-authored-by: Dana Doe <dana@example.com>',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    '',
  ].join('\n');
  expect(problems(message)).toEqual([
    '5 Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    '7 🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ]);
});

test('the prose rules hold the message, outside inline code', () => {
  expect(
    problems('Make the relay seamless\n\nThe cache is not just a gate; `robust` is a flag name.\n'),
  ).toEqual(['1 stock-word: seamless', '3 not-x-but-y: is not just']);
});

test('comment lines and the diff below the scissors are not the message', () => {
  const message = [
    'Name the timer',
    '# Please enter the commit message. A robust seamless comment.',
    '# ------------------------ >8 ------------------------',
    '+// Co-Authored-By: Claude, a seamless line in the diff',
  ].join('\n');
  expect(messageLines(message)).toEqual([{ line: 1, text: 'Name the timer' }]);
  expect(problems(message)).toEqual([]);
});
