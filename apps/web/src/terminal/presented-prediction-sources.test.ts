import { describe, expect, test } from 'bun:test';
import { createPresentedPredictionSources } from './presented-prediction-sources';
import { MAX_IN_FLIGHT_RENDER_FRAMES } from './render-mailbox';

describe('presented prediction sources', () => {
  test('a source is presented only once its frame completes', () => {
    const sources = createPresentedPredictionSources();
    const token = sources.noteFrameSubmitted([4, 5], false);
    expect(sources.sourceWasPresented(4)).toBe(false);
    sources.noteFrameCompleted(token);
    expect(sources.sourceWasPresented(4)).toBe(true);
    expect(sources.sourceWasPresented(5)).toBe(true);
    expect(sources.sourceWasPresented(6)).toBe(false);
  });

  test('the newest completed frame replaces the presented set', () => {
    const sources = createPresentedPredictionSources();
    const first = sources.noteFrameSubmitted([4], false);
    const second = sources.noteFrameSubmitted([5], false);
    sources.noteFrameCompleted(first);
    sources.noteFrameCompleted(second);
    expect(sources.sourceWasPresented(4)).toBe(false);
    expect(sources.sourceWasPresented(5)).toBe(true);
  });

  test('a discarded or truncated frame presents nothing', () => {
    const sources = createPresentedPredictionSources();
    const lost = sources.noteFrameSubmitted([4], false);
    sources.discardFrame(lost);
    sources.noteFrameCompleted(lost);
    expect(sources.sourceWasPresented(4)).toBe(false);
    const truncated = sources.noteFrameSubmitted([5], true);
    sources.noteFrameCompleted(truncated);
    expect(sources.sourceWasPresented(5)).toBe(false);
  });

  test('frame ownership is bounded by the render mailbox and released on completion', () => {
    const sources = createPresentedPredictionSources();
    const tokens: number[] = [];
    for (let frame = 0; frame < MAX_IN_FLIGHT_RENDER_FRAMES; frame += 1) {
      tokens.push(sources.noteFrameSubmitted([frame + 1], false));
    }
    expect(() => sources.noteFrameSubmitted([99], false)).toThrow('ownership overflow');
    sources.noteFrameCompleted(tokens[0] ?? 0);
    expect(() => sources.noteFrameSubmitted([99], false)).not.toThrow();
  });

  test('reset forgets presented sources and frees every frame', () => {
    const sources = createPresentedPredictionSources();
    const token = sources.noteFrameSubmitted([4], false);
    sources.noteFrameCompleted(token);
    sources.reset();
    expect(sources.sourceWasPresented(4)).toBe(false);
    for (let frame = 0; frame < MAX_IN_FLIGHT_RENDER_FRAMES; frame += 1) {
      sources.noteFrameSubmitted([frame + 1], false);
    }
  });
});
