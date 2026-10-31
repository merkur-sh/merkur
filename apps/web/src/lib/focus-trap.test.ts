import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./focus-trap.ts', import.meta.url), 'utf8');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  source.replaceAll('export function', 'function'),
);

test('palette Tab containment excludes negative tabindex buttons', () => {
  let prevented = false;
  class FocusTarget {
    constructor(readonly tabIndex: number) {}
    focus() {
      active = this;
    }
  }
  const query = new FocusTarget(0);
  let active = query;
  const context = {
    HTMLElement: FocusTarget,
    document: {
      get activeElement() {
        return active;
      },
    },
    root: { querySelectorAll: () => [query, new FocusTarget(-1), new FocusTarget(-2)] },
    event: {
      key: 'Tab',
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
    },
  };
  runInNewContext(`${program}\ntrapTabKey(event, root);`, context);
  expect(prevented).toBe(true);
  expect(active).toBe(query);
  context.event.shiftKey = true;
  prevented = false;
  runInNewContext('trapTabKey(event, root);', context);
  expect(prevented).toBe(true);
  expect(active).toBe(query);
});
