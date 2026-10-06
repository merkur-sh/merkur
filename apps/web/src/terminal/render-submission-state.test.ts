import { expect, test } from 'bun:test';
import { MAX_IN_FLIGHT_RENDER_FRAMES } from './render-mailbox';
import { createRenderSubmissionState } from './render-submission-state';

test('exact bounded owners retire in either callback order and reuse storage', () => {
  const s = createRenderSubmissionState();
  const a = s.reserve();
  a.stateRevision = 11;
  s.commit(a, 1);
  const b = s.reserve();
  b.stateRevision = 22;
  s.commit(b, 2);
  const extra = Array.from({ length: MAX_IN_FLIGHT_RENDER_FRAMES - 2 }, (_, index) => {
    const frame = s.reserve();
    s.commit(frame, index + 3);
    return frame;
  });
  expect(() => s.reserve()).toThrow();
  expect(s.count()).toBe(MAX_IN_FLIGHT_RENDER_FRAMES);
  expect(s.retire(2)).toBe(b);
  expect(s.isLatest(b)).toBe(extra.length === 0);
  s.release(b);
  const c = s.reserve();
  expect(c).toBe(b);
  c.stateRevision = 33;
  s.commit(c, MAX_IN_FLIGHT_RENDER_FRAMES + 1);
  expect(a.stateRevision).toBe(11);
  expect(s.retire(1)).toBe(a);
  expect(s.isLatest(a)).toBe(false);
  s.release(a);
  expect(s.count()).toBe(MAX_IN_FLIGHT_RENDER_FRAMES - 1);
});

test('semantic invalidation never releases physical credits or preserves calibration', () => {
  const s = createRenderSubmissionState();
  const a = s.reserve();
  a.trackerToken = 8;
  a.firstDisplayOwner = true;
  s.commit(a, 1);
  const b = s.reserve();
  b.trackerToken = 9;
  s.commit(b, 2);
  for (let id = 3; id <= MAX_IN_FLIGHT_RENDER_FRAMES; id += 1) s.commit(s.reserve(), id);
  const discarded: number[] = [];
  s.invalidateSemantics((token) => discarded.push(token));
  expect(discarded).toEqual([8, 9]);
  expect(s.count()).toBe(MAX_IN_FLIGHT_RENDER_FRAMES);
  expect(a.semanticValid).toBe(false);
  expect(a.firstDisplayOwner).toBe(false);
  expect(() => s.reserve()).toThrow();
  s.contextDestroyed((token) => discarded.push(token));
  expect(discarded).toEqual([8, 9]);
  expect(s.count()).toBe(0);
  expect(() => s.retire(1)).toThrow();
  const fresh = s.reserve();
  expect(fresh.semanticValid).toBe(true);
  expect(fresh.trackerToken).toBeNull();
});

test('full-window owners survive out-of-order retirement and repeated invalidation', () => {
  const s = createRenderSubmissionState();
  const owners = Array.from({ length: MAX_IN_FLIGHT_RENDER_FRAMES }, (_, index) => {
    const frame = s.reserve();
    frame.predictionRevision = index + 100;
    frame.trackerToken = index + 1000;
    frame.firstDisplayOwner = true;
    s.commit(frame, index + 1);
    return frame;
  });
  const discarded: number[] = [];
  s.invalidateSemantics((token) => discarded.push(token));
  s.invalidateSemantics((token) => discarded.push(token));
  expect(discarded).toHaveLength(MAX_IN_FLIGHT_RENDER_FRAMES);
  expect(s.count()).toBe(MAX_IN_FLIGHT_RENDER_FRAMES);
  expect(() => s.reserve()).toThrow();
  for (let index = owners.length - 1; index >= 0; index -= 1) {
    const frame = s.retire(index + 1);
    const owner = owners[index];
    if (owner === undefined) throw new Error('missing submitted owner');
    expect(frame).toBe(owner);
    expect(frame.predictionRevision).toBe(index + 100);
    expect(frame.semanticValid).toBe(false);
    expect(frame.firstDisplayOwner).toBe(false);
    expect(s.isLatest(frame)).toBe(index === owners.length - 1);
    expect(() => s.retire(index + 1)).toThrow();
    s.release(frame);
    expect(() => s.release(frame)).toThrow();
  }
  expect(s.count()).toBe(0);
});

test('a retired but borrowed owner cannot be reused or released before retirement', () => {
  const s = createRenderSubmissionState();
  const owners = Array.from({ length: MAX_IN_FLIGHT_RENDER_FRAMES }, (_, index) => {
    const frame = s.reserve();
    s.commit(frame, index + 1);
    return frame;
  });
  const first = owners[0];
  if (first === undefined) throw new Error('missing owner');
  expect(() => s.release(first)).toThrow();
  expect(s.retire(1)).toBe(first);
  expect(() => s.reserve()).toThrow('no released slot');
  s.release(first);
  expect(s.reserve()).toBe(first);
});

test('reservation abort and ID validation cannot steal another owner', () => {
  const s = createRenderSubmissionState();
  const a = s.reserve();
  expect(() => s.reserve()).toThrow();
  expect(() => s.commit(a, 0)).toThrow();
  s.abortReserved(a);
  expect(s.count()).toBe(0);
  const b = s.reserve();
  s.commit(b, 9);
  const c = s.reserve();
  expect(() => s.commit(c, 9)).toThrow();
  s.abortReserved(c);
  expect(() => s.retire(10)).toThrow();
  expect(s.count()).toBe(1);
});
