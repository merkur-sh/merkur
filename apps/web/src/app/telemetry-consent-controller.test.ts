import { expect, test } from 'bun:test';
import { createRoot, flush } from 'solid-js';
import { createTelemetryConsentController } from './telemetry-consent-controller';

function harness() {
  let token: string | null = 'token';
  const applied: boolean[] = [];
  const requests: Array<{
    token: string;
    enabled: boolean;
    signal: AbortSignal;
    answer(value: { enabled: boolean }): void;
    fail(error: Error): void;
  }> = [];
  let dispose = () => {};
  const controller = createRoot((cleanup) => {
    dispose = cleanup;
    return createTelemetryConsentController({
      getAccessToken: () => token,
      applyEnabled: (enabled) => applied.push(enabled),
      save: (token, enabled, signal) =>
        new Promise((answer, fail) => requests.push({ token, enabled, signal, answer, fail })),
    });
  });
  function request(index = 0) {
    const result = requests[index];
    if (result === undefined) throw new Error('request missing');
    return result;
  }
  return {
    controller,
    applied,
    requests,
    request,
    dispose,
    setToken: (next: string | null) => {
      token = next;
    },
  };
}

test('unknown and unchosen stay off; every reporting transition applies synchronously once', () => {
  const h = harness();
  try {
    expect(h.controller.consent()).toBe('unknown');
    expect(h.controller.pending()).toBeNull();
    expect(h.controller.failed()).toBe(false);
    h.controller.receive(null);
    flush();
    expect(h.controller.consent()).toBe('unchosen');
    expect(h.applied).toEqual([]);
    h.controller.receive(true);
    expect(h.controller.isEnabled()).toBe(true);
    h.controller.receive(true);
    h.controller.receive(false);
    expect(h.controller.isEnabled()).toBe(false);
    flush();
    expect(h.controller.consent()).toBe('off');
    h.controller.receive(true);
    h.controller.receive(null);
    flush();
    expect(h.controller.consent()).toBe('unchosen');
    h.controller.receive(true);
    h.controller.receive(undefined);
    flush();
    expect(h.controller.consent()).toBe('unknown');
    expect(h.applied).toEqual([true, false, true, false, true, false]);
  } finally {
    h.dispose();
  }
});

test('saving keeps the stated consent, guards duplicate clicks and adopts the returned choice', async () => {
  const h = harness();
  try {
    h.controller.receive(null);
    const save = h.controller.choose(true);
    await h.controller.choose(false);
    flush();
    expect(h.requests).toHaveLength(1);
    expect(h.request().token).toBe('token');
    expect(h.request().enabled).toBe(true);
    expect(h.controller.pending()).toBe(true);
    expect(h.controller.consent()).toBe('unchosen');
    expect(h.applied).toEqual([]);
    h.request().answer({ enabled: false });
    await save;
    flush();
    expect(h.controller.consent()).toBe('off');
    expect(h.controller.pending()).toBeNull();
    expect(h.controller.failed()).toBe(false);
  } finally {
    h.dispose();
  }
});

test('a failed save preserves stream statements and the next choice clears failure', async () => {
  const h = harness();
  try {
    h.controller.receive(true);
    const save = h.controller.choose(false);
    flush();
    expect(h.controller.pending()).toBe(false);
    expect(h.controller.isEnabled()).toBe(true);
    h.controller.receive(false);
    h.request().fail(new Error('offline'));
    await save;
    flush();
    expect(h.controller.consent()).toBe('off');
    expect(h.controller.pending()).toBeNull();
    expect(h.controller.failed()).toBe(true);
    const retry = h.controller.choose(true);
    flush();
    expect(h.controller.failed()).toBe(false);
    h.request(1).answer({ enabled: true });
    await retry;
    flush();
    expect(h.controller.consent()).toBe('on');
    expect(h.applied).toEqual([true, false, true]);
  } finally {
    h.dispose();
  }
});

test('ending the lifetime aborts a save and ignores its late answer in a new lifetime', async () => {
  const h = harness();
  try {
    h.controller.receive(true);
    const oldSave = h.controller.choose(false);
    h.controller.reset();
    expect(h.request().signal.aborted).toBe(true);
    expect(h.controller.isEnabled()).toBe(false);
    flush();
    expect(h.controller.consent()).toBe('unknown');
    expect(h.controller.pending()).toBeNull();
    h.setToken('next-token');
    const nextSave = h.controller.choose(true);
    h.request().answer({ enabled: false });
    await oldSave;
    flush();
    expect(h.controller.consent()).toBe('unknown');
    expect(h.controller.pending()).toBe(true);
    h.request(1).answer({ enabled: true });
    await nextSave;
    flush();
    expect(h.controller.consent()).toBe('on');
    expect(h.request(1).token).toBe('next-token');
  } finally {
    h.dispose();
  }
});

test('cleanup turns reporting off and a late rejection cannot fail the next lifetime', async () => {
  const h = harness();
  h.controller.receive(true);
  const save = h.controller.choose(false);
  h.dispose();
  expect(h.request().signal.aborted).toBe(true);
  expect(h.controller.isEnabled()).toBe(false);
  h.request().fail(new Error('aborted'));
  await save;
  flush();
  expect(h.controller.failed()).toBe(false);
  expect(h.applied).toEqual([true, false]);
});

test('a signed-out controller sends no choice', async () => {
  const h = harness();
  try {
    h.setToken(null);
    await h.controller.choose(true);
    expect(h.requests).toHaveLength(0);
    expect(h.applied).toEqual([]);
  } finally {
    h.dispose();
  }
});
