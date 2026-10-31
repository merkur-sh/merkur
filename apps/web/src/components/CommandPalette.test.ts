import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./CommandPalette.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  function onKeyDown(');
const end = source.indexOf('\n  }\n', start);
if (start < 0 || end < start) throw new Error('missing palette key handler');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 4));

for (const key of ['Enter', 'j']) {
  test(`palette composition owns ${key}`, () => {
    let ran = false,
      moved = false,
      prevented = false;
    const context = {
      event: {
        key,
        isComposing: true,
        keyCode: 229,
        ctrlKey: true,
        altKey: false,
        preventDefault() {
          prevented = true;
        },
      },
      run() {
        ran = true;
      },
      move() {
        moved = true;
      },
      matches: () => ['selected'],
      cursor: () => 0,
    };
    runInNewContext(`${program}\nonKeyDown(event);`, context);
    expect(ran).toBe(false);
    expect(moved).toBe(false);
    expect(prevented).toBe(false);
  });
}
