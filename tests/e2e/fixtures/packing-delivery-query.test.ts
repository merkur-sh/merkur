import { expect, test } from 'bun:test';
import {
  instrumentPackingSemanticQuery,
  parsePackingSemanticQuery,
} from './packing-delivery-query';

const SOURCE =
  'function render(){renderer.render(terminal.memory.buffer,state.bg,state.glyph,state.deco,state.cursor,state.viewport,state.versions)}function viewport(){return terminal?.viewportRows()??""}';

test('semantic query overlay refuses drift and never instruments the render call', () => {
  const instrumented = instrumentPackingSemanticQuery(SOURCE);
  expect(instrumented).toContain(SOURCE.slice(0, SOURCE.indexOf('function viewport')));
  expect(() => instrumentPackingSemanticQuery('')).toThrow();
  expect(() => instrumentPackingSemanticQuery(SOURCE + SOURCE)).toThrow();
  expect(() => instrumentPackingSemanticQuery(instrumented)).toThrow();
  expect(() =>
    instrumentPackingSemanticQuery(SOURCE.replace('terminal?.', 'different?.')),
  ).toThrow();
});

test('query recomputes every canonical row and captures last-submitted cursor without render', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Float32Array(memory.buffer, 0, 8).set([8, 16, 8, 16, 1, 1, 1, 1]);
  const visited: number[] = [];
  const terminal = {
    memory,
    cols: () => 2,
    rows: () => 2,
    rowHash: (row: number) => {
      visited.push(row);
      return BigInt(row + 1);
    },
    rowHashes: () => {
      throw new Error('must not read cached hashes');
    },
    viewportRows: () => 'ab\ncd',
    viewportWrapBits: () => new Uint8Array(1),
  };
  const records: string[] = [];
  const read = new Function(
    'terminal',
    'state',
    'console',
    'performance',
    `${instrumentPackingSemanticQuery(SOURCE)}; return viewport();`,
  );
  const result = read(
    terminal,
    { cursor: { ptr: 0, count: 1 }, versions: { bg: 1, glyph: 2, deco: 3, cursor: 4 } },
    { debug: (value: string) => records.push(value) },
    { timeOrigin: 100, now: () => 2 },
  );
  expect(result).toBe('ab\ncd');
  expect(visited).toEqual([0, 1]);
  expect(records).toHaveLength(1);
  const query = parsePackingSemanticQuery(records[0] ?? '');
  expect(query?.rowHashes).toEqual(['0000000000000001', '0000000000000002']);
  expect(query?.cursor).toEqual([8, 16, 8, 16, 1, 1, 1, 1]);
  expect(query?.versions.cursor).toBe(4);
});
