import { describe, expect, test } from 'bun:test';

import { isEdgeSignalingChannel } from './edge-signaling';
import { TRANSPORT_CHANNEL_ID } from './transport';

describe('isEdgeSignalingChannel', () => {
  test('claims only channel 0x00', () => {
    expect(isEdgeSignalingChannel(TRANSPORT_CHANNEL_ID.signaling)).toBe(true);
    expect(isEdgeSignalingChannel(TRANSPORT_CHANNEL_ID.pty)).toBe(false);
    expect(isEdgeSignalingChannel(TRANSPORT_CHANNEL_ID.displayDatagram)).toBe(false);
  });
});
