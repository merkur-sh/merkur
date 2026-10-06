import { expect, test } from 'bun:test';
import {
  instrumentReferenceRenderContent,
  parseReferenceRenderContent,
} from './reference-render-content';

const CALL = 'r.render(t.memory.buffer,s.bg,s.glyph,s.deco,s.cursor,s.viewport,s.versions)';

test('content observer refuses absent, ambiguous, or already instrumented GPU calls', () => {
  expect(() => instrumentReferenceRenderContent('')).toThrow('exactly one');
  expect(() => instrumentReferenceRenderContent(`${CALL};${CALL}`)).toThrow('exactly one');
  expect(() => instrumentReferenceRenderContent(instrumentReferenceRenderContent(CALL))).toThrow(
    'exactly one',
  );
});

test('identical newer-sequence submissions do not advance exact grid-content revision', () => {
  const logs: string[] = [];
  let submissions = 0;
  const hashes = new Uint32Array([1, 2, 3, 4]);
  const cursor = new Uint32Array(8);
  const memory = { buffer: cursor.buffer };
  const terminal = {
    cols: () => 80,
    rows: () => 2,
    rowHashes: () => hashes,
    cursorInfo: () => {
      throw new Error('observer must not mutate cursor-motion telemetry');
    },
    atlasGeneration: () => 1,
    atlasWidth: () => 1024,
    atlasHeight: () => 1024,
    memory,
  };
  const state = {
    bg: {},
    glyph: {},
    deco: {},
    cursor: { ptr: 0, count: 1 },
    viewport: [800, 40],
    versions: {},
  };
  const renderer = {
    render: (...args: unknown[]) => {
      expect(args).toEqual([
        memory.buffer,
        state.bg,
        state.glyph,
        state.deco,
        state.cursor,
        state.viewport,
        state.versions,
      ]);
      submissions += 1;
    },
  };
  const source = instrumentReferenceRenderContent(`return () => ${CALL};`);
  const submit = new Function('r', 't', 's', 'console', source)(renderer, terminal, state, {
    debug: (entry: string) => logs.push(entry),
  });
  submit();
  submit();
  hashes[3] = 5;
  submit();
  cursor[0] = 7;
  submit();
  submit();
  expect(submissions).toBe(5);
  const observations = logs.map(parseReferenceRenderContent);
  expect(observations.map((entry) => entry?.stateRevision)).toEqual([1, 1, 2, 3, 3]);
  expect(observations.map((entry) => entry?.changedRows)).toEqual([2, 0, 1, 0, 0]);
  expect(observations.map((entry) => entry?.cursorChanged)).toEqual([
    true,
    false,
    false,
    true,
    false,
  ]);
});

test('malformed content observations cannot become evidence', () => {
  expect(parseReferenceRenderContent('unrelated log')).toBeNull();
  expect(() => parseReferenceRenderContent('[merkur-reference-render-content]{}')).toThrow();
  expect(() => parseReferenceRenderContent('[merkur-reference-render-content]null')).toThrow();
});
