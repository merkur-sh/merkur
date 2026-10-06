import { describe, expect, test } from 'bun:test';
import type { TransportToMain } from '../transport-worker-protocol';
import { createTransportStartEvents } from './transport-start-events';

describe('transport start events', () => {
  test('a retained A callback cannot borrow B identity after B takes ownership', () => {
    const messages: TransportToMain[] = [];
    const first = createTransportStartEvents(11, (message) => messages.push(message));
    const staleDisconnect = first.disconnected;

    const replacement = createTransportStartEvents(12, (message) => messages.push(message));
    replacement.inputReady();
    replacement.connected(true, 9, 'session-1');
    staleDisconnect('late-a');

    expect(messages).toEqual([
      { kind: 'input_ready', startId: 12 },
      {
        kind: 'connected',
        startId: 12,
        preserveDisplay: true,
        displayRingFenceToken: 9,
        sessionId: 'session-1',
      },
      { kind: 'disconnected', startId: 11, reason: 'late-a' },
    ]);
  });
});
