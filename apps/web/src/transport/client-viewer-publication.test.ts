import { describe, expect, test } from 'bun:test';
import { isCurrentViewerPublication, isCurrentViewerStamp } from './client-viewer-publication';

describe('viewer mailbox custody across Session replacement', () => {
  test.each(['client_viewer_fenced', 'client_link_definitions', 'client_graphics_consumed'])(
    '%s from retired same-lineage Session cannot enter the new owner',
    (kind) => {
      const retired = { kind, lineage: 1, frameFenceToken: 7 };
      expect(isCurrentViewerPublication(retired, 1, 7)).toBe(true);
      expect(isCurrentViewerPublication(retired, 1, 8)).toBe(false);
      expect(isCurrentViewerPublication({ ...retired, frameFenceToken: 8 }, 1, 8)).toBe(true);
      expect(isCurrentViewerPublication({ ...retired, frameFenceToken: 8 }, 2, 8)).toBe(false);
    },
  );
  test('a ring entry from a retired same-lineage Session cannot enter the new owner', () => {
    expect(isCurrentViewerStamp(1, 7, 1, 7)).toBe(true);
    expect(isCurrentViewerStamp(1, 7, 1, 8)).toBe(false);
    expect(isCurrentViewerStamp(1, 8, 1, 8)).toBe(true);
    expect(isCurrentViewerStamp(1, 8, 2, 8)).toBe(false);
  });
  test('no peer output is admitted before the first canonical fence', () => {
    expect(isCurrentViewerPublication({ lineage: 0, frameFenceToken: 0 }, 0, 0)).toBe(false);
    expect(isCurrentViewerStamp(0, 0, 0, 0)).toBe(false);
  });
});
