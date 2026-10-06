import { describe, expect, test } from 'bun:test';

import { createTerminalSessionEpochHandoff } from './terminal-session-epoch-handoff';

describe('terminal session epoch handoff', () => {
  test('replays resize then the exact token when transport connects before worker readiness', () => {
    const events: string[] = [];
    const session = { id: 'session-1' };
    let worker: { notifySessionEpoch(ring: number | null): void } | null = null;
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => worker,
      sendCurrentResize: (target) => events.push(`resize:${target.id}`),
    });

    handoff.onTransportConnected(session, 3);
    worker = { notifySessionEpoch: (ring) => events.push(`epoch:${String(ring)}`) };
    handoff.onWorkerReady(worker);

    expect(events).toEqual(['resize:session-1', 'resize:session-1', 'epoch:3']);
  });

  test('publishes immediately when the terminal worker is already ready', () => {
    const events: string[] = [];
    const session = { id: 'session-1' };
    const worker = { notifySessionEpoch: () => events.push('epoch') };
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => worker,
      sendCurrentResize: () => events.push('resize'),
    });

    handoff.onTransportConnected(session, 3);
    handoff.onWorkerReady(worker);
    expect(events).toEqual(['resize', 'epoch']);
  });

  test('a return to ready on the fenced lineage is not a new display lineage', () => {
    const session = { id: 'session-1' };
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => ({ notifySessionEpoch: () => {} }),
      sendCurrentResize: () => {},
    });

    expect(handoff.onTransportConnected(session, 3)).toBe(true);
    expect(handoff.onTransportConnected(session, 3)).toBe(false);
    expect(handoff.onTransportConnected(session, 5)).toBe(true);
    handoff.reset();
    expect(handoff.onTransportConnected(session, 5)).toBe(true);
  });

  test('reset prevents a stale pre-teardown edge from reaching a new worker', () => {
    const events: string[] = [];
    const session = { id: 'session-1' };
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => null,
      sendCurrentResize: () => events.push('resize'),
    });
    handoff.onTransportConnected(session, 3);
    handoff.reset();
    handoff.onWorkerReady({ notifySessionEpoch: () => events.push('epoch') });
    expect(events).toEqual(['resize']);
  });

  test('coalesces pending authentications into the newest token', () => {
    const delivered: Array<number | null> = [];
    const session = { id: 'session-1' };
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => null,
      sendCurrentResize: () => {},
    });

    handoff.onTransportConnected(session, 3);
    handoff.onTransportConnected(session, 5);
    handoff.onWorkerReady({ notifySessionEpoch: (ring) => delivered.push(ring) });
    expect(delivered).toEqual([5]);
  });

  test('worker replacement replays a delivered token that may not have reached either SAB', () => {
    const delivered: Array<number | null> = [];
    const session = { id: 'session-1' };
    let worker: { notifySessionEpoch(ring: number | null): void } | null = {
      notifySessionEpoch: (ring) => delivered.push(ring),
    };
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => worker,
      sendCurrentResize: () => {},
    });

    handoff.onTransportConnected(session, 9);
    worker = null;
    handoff.onWorkerClosed();
    handoff.onWorkerReady({ notifySessionEpoch: (ring) => delivered.push(ring) });
    expect(delivered).toEqual([9, 9]);
  });

  test('worker replacement before authentication carries a null token', () => {
    const delivered: Array<number | null> = [];
    const session = { id: 'session-1' };
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => null,
      sendCurrentResize: () => {},
    });
    handoff.onWorkerClosed();
    handoff.onWorkerReady({ notifySessionEpoch: (ring) => delivered.push(ring) });
    expect(delivered).toEqual([null]);
  });

  test('a newer authentication replaces the retained token while the worker is absent', () => {
    const delivered: Array<number | null> = [];
    const session = { id: 'session-1' };
    const handoff = createTerminalSessionEpochHandoff({
      getSession: () => session,
      getWorker: () => null,
      sendCurrentResize: () => {},
    });
    handoff.onTransportConnected(session, 3);
    handoff.onWorkerClosed();
    handoff.onTransportConnected(session, 5);
    handoff.onWorkerReady({ notifySessionEpoch: (ring) => delivered.push(ring) });
    expect(delivered).toEqual([5]);
  });
});
