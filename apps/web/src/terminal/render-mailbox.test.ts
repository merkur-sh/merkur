import { describe, expect, test } from 'bun:test';
import { createRenderMailbox, MAX_IN_FLIGHT_RENDER_FRAMES } from './render-mailbox';

describe('task-driven render mailbox', () => {
  test('idle submits now; continuous dirty state uses one next opportunity', () => {
    const m = createRenderMailbox();
    expect(m.noteDirty().kind).toBe('render-now');
    expect(m.noteSubmitted(0, 1).kind).toBe('wait-frame');
    expect(m.renderQueued()).toBe(false);
    expect(m.noteDirty().kind).toBe('wait-frame');
    expect(m.renderQueued()).toBe(true);
    expect(m.noteFrameComplete(1).kind).toBe('render-now');
    expect(m.noteOpportunity(16).kind).toBe('none');
    expect(m.noteSubmitted(16, 2).kind).toBe('wait-frame');
    expect(m.noteOpportunity(32).kind).toBe('none');
    expect(m.noteDirty().kind).toBe('render-now');
  });
  test('10000 dirty offers retain only one replaceable pending state', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    const waiting = m.noteDirty();
    for (let i = 0; i < 10000; i++) expect(m.noteDirty()).toBe(waiting);
    expect(m.renderQueued()).toBe(true);
    expect(m.noteOpportunity(16).kind).toBe('render-now');
    m.noteSubmitted(16, 2);
    expect(m.noteFrameComplete(1).kind).toBe('none');
    expect(m.noteFrameComplete(2).kind).toBe('none');
  });
  test('dirty during a claim survives without duplicating that claim', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    expect(m.noteDirty().kind).toBe('none');
    expect(m.noteSubmitted(2, 1).kind).toBe('wait-frame');
    expect(m.noteOpportunity(16).kind).toBe('render-now');
    expect(m.noteSubmitted(16, 2).kind).toBe('wait-frame');
  });
  test('aborted or held work is retained but cannot spin synchronously', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    expect(m.noteRenderAborted().kind).toBe('none');
    expect(m.noteDirty().kind).toBe('render-now');
    m.noteSubmitted(1, 1);
    expect(m.noteFrameComplete(1).kind).toBe('none');
  });
  test('rejects unowned completions/submissions and resets actual device loss', () => {
    const m = createRenderMailbox();
    expect(() => m.noteFrameComplete(1)).toThrow();
    expect(() => m.noteSubmitted(0, 1)).toThrow();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    m.reset();
    expect(() => m.noteFrameComplete(1)).toThrow();
    expect(m.noteDirty().kind).toBe('render-now');
  });
  test('a queued render waits for a real frame, never a wall clock', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    // No timer can release this: only a delivered frame or a genuine fence.
    for (let offer = 0; offer < 64; offer += 1) expect(m.noteDirty().kind).toBe('wait-frame');
    expect(m.renderQueued()).toBe(true);
    expect(m.noteOpportunity(17).kind).toBe('render-now');
  });
  test('unknown service explores at most two submissions and cannot spin', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    m.noteDirty();
    m.noteOpportunity(16);
    m.noteSubmitted(16, 2);
    expect(m.noteDirty().kind).toBe('wait-fence');
    expect(m.renderQueued()).toBe(false);
    expect(m.noteOpportunity(32).kind).toBe('wait-fence');
  });
  test('a released coherent transaction does not acquire a second cadence hold', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    m.noteFrameComplete(1);
    m.noteOpportunity(4);
    expect(m.noteDirty().kind).toBe('render-now');
    m.noteSubmitted(5, 2);
    // The presentation coordinator already spent this image's frame. No new rAF
    // arrives, and its release must still submit immediately.
    expect(m.noteDirty(true).kind).toBe('render-now');
    m.noteSubmitted(16, 3);
    expect(m.renderQueued()).toBe(false);
  });
  test('an immediate offer cannot bypass unresolved GPU ownership', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    m.noteOpportunity(16);
    m.noteDirty();
    m.noteSubmitted(16, 2);
    expect(m.noteDirty(true).kind).toBe('wait-fence');
    expect(m.renderQueued()).toBe(false);
  });
  test('prior delayed callbacks never authorize additional unconfirmed owners', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    m.noteDirty();
    m.noteOpportunity(16);
    m.noteSubmitted(16, 2);
    m.noteFrameComplete(1);
    m.noteFrameComplete(2);
    for (let id = 3; id <= 4; id++) {
      const at = 166 + (id - 3) * 16;
      m.noteOpportunity(at);
      expect(m.noteDirty().kind).toBe('render-now');
      m.noteSubmitted(at, id);
    }
    expect(m.noteOpportunity(400).kind).toBe('none');
    // A large old callback delay cannot distinguish future delay from GPU debt.
    expect(m.noteDirty().kind).toBe('wait-fence');
  });
  test('hard cap survives out-of-order callbacks and exact identity reuse checks', () => {
    const m = createRenderMailbox();
    m.noteDirty();
    m.noteSubmitted(0, 1);
    m.noteOpportunity(1);
    m.noteDirty();
    m.noteSubmitted(1, 2);
    m.noteFrameComplete(1);
    m.noteFrameComplete(2);
    for (let id = 3; id < 3 + MAX_IN_FLIGHT_RENDER_FRAMES; id++) {
      const at = 10001 + id;
      m.noteOpportunity(at);
      expect(m.noteDirty().kind).toBe('render-now');
      m.noteSubmitted(at, id);
    }
    expect(m.noteDirty().kind).toBe('wait-fence');
    // Completing one of two owners returns capacity, not a cadence opportunity:
    // with a frame still in flight the next image waits for a real frame.
    expect(m.noteFrameComplete(2 + MAX_IN_FLIGHT_RENDER_FRAMES).kind).toBe('wait-frame');
    expect(m.noteOpportunity(10100).kind).toBe('render-now');
    m.noteSubmitted(10100, 3 + MAX_IN_FLIGHT_RENDER_FRAMES);
    expect(m.noteFrameComplete(3).kind).toBe('none');
    expect(() => m.noteFrameComplete(3)).toThrow();
  });
});
