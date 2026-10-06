import type { Page } from '@playwright/test';

import type { AppPhase, ConnectionStatus } from '../../apps/web/src/app/navigation';
import type { DeviceListStatus } from '../../apps/web/src/hooks/device-events-atoms';
import { expect } from './fixtures/test';

/**
 * The app's observable state, as the DOM exposes it.
 *
 * Everything here reads `apps/web/src/app/navigation.ts`'s three orthogonal
 * facts, written onto `document.body` by `createAppController`. It replaces the
 * single `data-state` enum the suite used to poll, which conflated "which
 * screen is mounted" with "what the transport is doing" — the exact conflation
 * `navigation.ts` was written to remove. A test that wanted "connected" had to
 * name a value that also asserted a route.
 *
 * Kept in one file so the suite has a single place that knows attribute names.
 * Deliberately not a reconstruction of the old enum: these assert the real
 * attributes, so a failure names the fact that is wrong.
 */

// Imported, never restated. A local copy of these unions would still compile
// after the app renamed a value, and the suite would fail on a polling timeout
// that names neither the attribute nor the rename. Both readers had already
// drifted that way: `terminal-performance-matrix` asserted an uppercase
// `CONNECTED` the app had replaced, and the iOS harness polled a `data-state`
// attribute nothing writes. Both now share these types.

/** Poll timeout for transport transitions, which cross a real network. */
const CONNECTION_TIMEOUT_MS = 20_000;

function appPhase(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.body.dataset.phase);
}

export function appConnection(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.body.dataset.connection);
}

/** The login screen is mounted. */
export async function expectAuthPhase(page: Page): Promise<void> {
  await expect.poll(() => appPhase(page)).toBe('auth' satisfies AppPhase);
}

/** The signed-in shell is mounted, whatever route or connection it holds. */
export async function expectShellPhase(page: Page): Promise<void> {
  await expect.poll(() => appPhase(page)).toBe('shell' satisfies AppPhase);
}

/**
 * A terminal session is live.
 *
 * Asserts the connection alone. The old `CONNECTED` value additionally implied
 * the terminal route, which meant a transport assertion failed for a routing
 * reason; callers that care about the route assert it separately.
 */
export async function expectConnected(
  page: Page,
  timeoutMs = CONNECTION_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(() => appConnection(page), { timeout: timeoutMs })
    .toBe('connected' satisfies ConnectionStatus);
}

/**
 * The machine list is being confirmed by a live stream.
 *
 * `data-devices` rather than the badge's text: the badge is a rendered string,
 * and what a test needs to assert is the state behind it. Written by the same
 * effect as `phase` and `connection`, from the union in
 * `apps/web/src/hooks/device-events-atoms.ts`, so a rename fails this file's
 * type check instead of leaving the suite polling for a value nothing writes.
 */
export async function expectDeviceListLive(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.devices), { timeout: timeoutMs })
    .toBe('live' satisfies DeviceListStatus);
}

/** Stream attempts this page's device-events loop has begun. */
export function deviceListAttempts(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.body.dataset.deviceAttempts ?? '0'));
}
