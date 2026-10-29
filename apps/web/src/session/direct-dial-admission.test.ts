import { describe, expect, test } from 'bun:test';
import { createDirectDialAdmission, type DirectDialClaim } from './direct-dial-admission';

interface ClaimResult {
  value: DirectDialClaim | null | undefined;
}

function request(
  ledger: ReturnType<typeof createDirectDialAdmission>,
  endpoint: string,
  admission = 0,
  controller = new AbortController(),
) {
  const result: ClaimResult = { value: undefined };
  ledger.claim(endpoint, admission, controller.signal, (value) => {
    result.value = value;
  });
  return result;
}

describe('page-owned direct dial admission', () => {
  test('a second terminal waits for native readiness and owns the next constructor', () => {
    const ledger = createDirectDialAdmission();
    const first = request(ledger, 'endpoint');
    const second = request(ledger, 'endpoint');
    expect(first.value).toEqual({ settle: expect.any(Function) });
    expect(second.value).toBeUndefined();
    first.value?.settle('ready');
    expect(second.value).toEqual({ settle: expect.any(Function) });
    const third = request(ledger, 'endpoint');
    first.value?.settle('failed');
    expect(third.value).toBeUndefined();
    second.value?.settle('ready');
    expect(third.value).toEqual({ settle: expect.any(Function) });
  });

  test('native failure denies the same preparation and transfers to completed new evidence', () => {
    const ledger = createDirectDialAdmission();
    const original = request(ledger, 'endpoint');
    const duplicate = request(ledger, 'endpoint');
    const prepared = request(ledger, 'endpoint', 41);
    expect(prepared.value).toBeUndefined();
    original.value?.settle('failed');
    expect(duplicate.value).toBeNull();
    expect(prepared.value).toEqual({ settle: expect.any(Function) });
    const repeated = request(ledger, 'endpoint', 41);
    const successor = request(ledger, 'endpoint', 42);
    expect(successor.value).toBeUndefined();
    prepared.value?.settle('failed');
    expect(repeated.value).toBeNull();
    expect(successor.value).toEqual({ settle: expect.any(Function) });
  });

  test('unused reservations transfer without spending reachability evidence', () => {
    const ledger = createDirectDialAdmission();
    const unused = request(ledger, 'endpoint');
    const next = request(ledger, 'endpoint');
    unused.value?.settle('unused');
    expect(next.value).toEqual({ settle: expect.any(Function) });
    expect(request(ledger, 'another-endpoint').value).toEqual({ settle: expect.any(Function) });
  });

  test('a cancelled waiter cannot reserve the endpoint when its predecessor ends', () => {
    const ledger = createDirectDialAdmission();
    const first = request(ledger, 'endpoint');
    const controller = new AbortController();
    const cancelled = request(ledger, 'endpoint', 0, controller);
    controller.abort();
    expect(cancelled.value).toBeNull();
    const live = request(ledger, 'endpoint');
    first.value?.settle('ready');
    expect(live.value).toEqual({ settle: expect.any(Function) });
    expect(request(ledger, 'unused', 0, controller).value).toBeNull();
  });

  test('a network change retires waiting requests and late outcomes stay in their visit', () => {
    const ledger = createDirectDialAdmission();
    ledger.observePath('192.0.2.1');
    const onA = request(ledger, 'endpoint');
    const waitingA = request(ledger, 'endpoint');
    expect(ledger.observePath('192.0.2.1')).toBe(false);
    expect(waitingA.value).toBeUndefined();
    expect(ledger.observePath('198.51.100.7')).toBe(true);
    expect(waitingA.value).toBeNull();
    const onB = request(ledger, 'endpoint');
    onA.value?.settle('failed');
    const waitingB = request(ledger, 'endpoint');
    expect(waitingB.value).toBeUndefined();
    onB.value?.settle('failed');
    expect(waitingB.value).toBeNull();
    expect(ledger.observePath('192.0.2.1')).toBe(true);
    expect(request(ledger, 'endpoint').value).toEqual({ settle: expect.any(Function) });
  });

  test('one failed native handshake denies every duplicate without another constructor', () => {
    const ledger = createDirectDialAdmission();
    const first = request(ledger, 'endpoint');
    const waiting = Array.from({ length: 8 }, () => request(ledger, 'endpoint'));
    expect(waiting.every((item) => item.value === undefined)).toBe(true);
    first.value?.settle('failed');
    expect(waiting.every((item) => item.value === null)).toBe(true);
  });
});
