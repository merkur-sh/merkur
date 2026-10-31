import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
const start = source.indexOf('    // Link text, cell identity');
const end = source.indexOf("  } else if (cmd.kind === 'rtt_sample')", start);
if (start < 0 || end < start) throw new Error('missing link viewport handler');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));

test('link viewport reads the presented snapshot while a replacement is held', () => {
  let held = true;
  const replies: { text: string; cols: number; links: Uint32Array }[] = [];
  const context = {
    wasmTerminal: {
      viewer: { presentation_link_definitions: () => new Uint8Array(0) },
      cols: () => 2,
      rows: () => 1,
      presentationCols: () => (held ? 1 : 2),
      presentationRows: () => 1,
      viewportRows: () => 'B',
      presentationViewportRows: () => (held ? 'A' : 'B'),
      viewportWrapBits: () => new Uint8Array(1),
      presentationViewportWrapBits: () => new Uint8Array(1),
      viewportTextColumns: () => new Uint16Array(1),
      viewportLinks: () => Uint32Array.of(held ? 1 : 2),
    },
    viewportWatched: false,
    self: { postMessage: (event: (typeof replies)[number]) => replies.push(event) },
  };
  runInNewContext(program, context);
  expect(replies[0]?.text).toBe('A');
  expect(replies[0]?.cols).toBe(1);
  held = false;
  runInNewContext(program, context);
  expect(replies[1]?.text).toBe('B');
  expect([...(replies[1]?.links ?? [])]).toEqual([2]);
});
