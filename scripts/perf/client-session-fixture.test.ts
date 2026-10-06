import { expect, test } from 'bun:test';
import { measureReconnect } from '../bench-reconnect-latency';
import { createClientSessionFixture, type SessionFixtureAction } from './client-session-fixture';

test('closing all incumbent carriers reaches authenticated readiness with only successor data dials', async () => {
  const result = await measureReconnect(85, 0, true);
  expect(result.scenario).toBe('closed-carriers');
  expect(result.dials).toBe(3);
  expect(result.lineage).toBeGreaterThan(1);
  expect(result.phases.usable).toBe(255);
}, 120_000);

test('native reliable writer credit leaves authenticated datagram input and ACKs live without queue growth', async () => {
  const fixture = await createClientSessionFixture();
  const held: SessionFixtureAction[] = [];
  try {
    expect(fixture.input(1, Uint8Array.of(0, 97))).toBe(true);
    for (;;) {
      const action = fixture.pollIo();
      if (action === null) break;
      if (action.kind === 5 && (action.channel === 1 || action.channel === 2)) {
        fixture.session.reliable_blocked(fixture.now(), action.conn, action.channel, true);
        held.push(action);
      } else {
        if (action.kind === 7 && action.topSequence !== 0)
          fixture.session.input_datagram_sent(fixture.now(), action.conn, action.topSequence);
        await fixture.transmit(action);
      }
    }
    expect(held.map((action) => action.channel).sort()).toEqual([1, 2]);
    for (let sequence = 2; sequence <= 128; sequence++) {
      expect(fixture.input(sequence, Uint8Array.of(0, 97))).toBe(true);
      await fixture.settle();
      expect(fixture.pollIo()).toBeNull();
    }
    expect(fixture.session.released_input()).toBe(128);
    expect(fixture.applied.length).toBe(128);
    expect(fixture.session.has_reliable_capacity(1)).toBe(false);
    // Each held native write completes once; only the current owed control/suffix follows.
    for (const action of held) {
      await fixture.transmit(action);
      fixture.session.reliable_blocked(fixture.now(), action.conn, action.channel, false);
    }
    await fixture.settle();
    expect(fixture.applied.length).toBe(128);
    expect(fixture.session.has_reliable_capacity(1)).toBe(true);
  } finally {
    await fixture.close();
  }
}, 120_000);

test('authoritative authorization denial closes an authenticated Session and forbids recovery', async () => {
  const fixture = await createClientSessionFixture();
  try {
    expect(fixture.session.is_ready()).toBe(true);
    fixture.session.authorization_denied(fixture.now());
    const closed: string[] = [];
    fixture.drainHost((kind, words, _payload, metadata) => {
      if (kind === 11 && words[0] === 5) closed.push(metadata);
    });
    expect(closed).toEqual(['AuthRejected']);
    expect(fixture.session.is_ready()).toBe(false);
    expect(fixture.input(1, Uint8Array.of(0, 97))).toBe(false);
    const retirement: number[] = [];
    for (;;) {
      const action = fixture.pollIo();
      if (action === null) break;
      retirement.push(action.kind);
    }
    expect(retirement.length).toBeGreaterThan(0);
    expect(retirement.every((kind) => kind === 8)).toBe(true);
    fixture.recover();
    expect(fixture.pollIo()).toBeNull();
  } finally {
    await fixture.close();
  }
}, 120_000);
