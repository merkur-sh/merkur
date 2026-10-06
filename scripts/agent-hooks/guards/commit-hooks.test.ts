import { expect, test } from 'bun:test';

import { splitCommandLine } from '../shell-command';
import { evaluateCommitHooks, skipsCommitHooks } from './commit-hooks';

function decision(line: string) {
  return splitCommandLine(line, '/repo', '/home/agent')
    .map(evaluateCommitHooks)
    .find((entry) => entry !== null);
}

test('a commit that skips its hooks is denied, however the flag is spelled', () => {
  expect(decision('git commit --no-verify -m "x"')?.kind).toBe('deny');
  expect(decision('git commit -n -m x')?.kind).toBe('deny');
  expect(decision('git commit -anm x')?.kind).toBe('deny');
  expect(decision('git -C /repo commit --no-verify')?.kind).toBe('deny');
  expect(decision('git -c user.name=a commit -n')?.kind).toBe('deny');
  expect(decision('git add a.ts && git commit --no-verify -m x')?.kind).toBe('deny');
  const reason = decision('git commit -n')?.reason ?? '';
  expect(reason).toContain('.githooks/pre-commit');
  expect(reason).toContain('check:ratchet --staged');
});

test('a hooked commit, an n inside a value, and other commands pass', () => {
  expect(decision('git commit -m "no verify here"')).toBeUndefined();
  expect(decision('git commit -mn')).toBeUndefined();
  expect(decision('git commit -m -n')).toBeUndefined();
  expect(decision('git commit -F notes.txt -a')).toBeUndefined();
  expect(decision('git commit -- -n')).toBeUndefined();
  expect(decision('git push --no-verify')).toBeUndefined();
  expect(decision('git log -n 3')).toBeUndefined();
  expect(decision('echo git commit -n')).toBeUndefined();
});

test('value-taking short options consume the rest of the cluster or the next word', () => {
  expect(skipsCommitHooks(['-am', 'msg'])).toBe(false);
  expect(skipsCommitHooks(['-a', '-n'])).toBe(true);
  expect(skipsCommitHooks(['-C', 'HEAD', '-n'])).toBe(true);
  expect(skipsCommitHooks(['-CHEAD'])).toBe(false);
});
