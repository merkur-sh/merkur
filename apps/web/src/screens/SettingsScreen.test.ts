import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./SettingsScreen.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  function revokeFocusedSession(');
const end = source.indexOf('\n  }\n', start);
if (start < 0 || end < start) throw new Error('missing session shortcut');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 4));

test('revoke shortcut aims the hold control without clicking it', () => {
  let focused = false,
    clicked = false;
  const button = {
    focus() {
      focused = true;
    },
    click() {
      clicked = true;
    },
  };
  class SessionTarget {
    closest() {
      return { querySelector: () => button };
    }
  }
  runInNewContext(`${program}\nrevokeFocusedSession();`, {
    Element: SessionTarget,
    document: { activeElement: new SessionTarget() },
  });
  expect(focused).toBe(true);
  expect(clicked).toBe(false);
});
