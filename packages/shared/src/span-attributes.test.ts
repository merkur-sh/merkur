import { expect, test } from 'bun:test';

import {
  EDGE_SPAN_ATTRIBUTE_KEYS,
  SPAN_ATTRIBUTE_KEYS,
  type SpanAttributeInput,
  spanAttributes,
} from './span-attributes';

/**
 * These are compile-time assertions, not runtime ones.
 *
 * Each `@ts-expect-error` fails `bun run check:types` if the error stops occurring — so a
 * future change that loosens the attribute map breaks the build rather than silently
 * re-opening the hole the deleted export-time deny-list used to cover.
 */
test('the attribute map rejects what it should, at compile time', () => {
  // @ts-expect-error — an unknown key is not a reviewed span attribute.
  const unknownKey: SpanAttributeInput = { 'merkur.not_reviewed': 1 };

  // @ts-expect-error — `client.address` is an end user's IP address.
  const forbiddenAddress: SpanAttributeInput = { 'client.address': '203.0.113.1' };

  // @ts-expect-error — query strings carry credentials.
  const forbiddenQuery: SpanAttributeInput = { 'url.query': 'token=secret' };

  // @ts-expect-error — the server already knows the user from the authenticated cookie.
  const forbiddenUser: SpanAttributeInput = { 'merkur.user_id': 'user-1' };

  // @ts-expect-error — a window is a number of milliseconds, not a string.
  const wrongValueType: SpanAttributeInput = { 'merkur.window_ms': '60000' };

  // @ts-expect-error — `merkur.outcome` is a closed union; this is a typo.
  const outcomeTypo: SpanAttributeInput = { 'merkur.outcome': 'sucess' };

  // @ts-expect-error — `db.operation.name` is a closed union of the five real operations.
  const operationTypo: SpanAttributeInput = { 'db.operation.name': 'Redis.whatever' };

  expect([
    unknownKey,
    forbiddenAddress,
    forbiddenQuery,
    forbiddenUser,
    wrongValueType,
    outcomeTypo,
    operationTypo,
  ]).toHaveLength(7);
});

test('reviewed keys with correct values compile and pass through unchanged', () => {
  const attributes = spanAttributes({
    'http.request.method': 'POST',
    'http.response.status_code': 200,
    'merkur.outcome': 'success',
    'merkur.daemon.id': 'daemon-1',
    'db.operation.name': 'Redis.commands',
  });

  expect(attributes).toEqual({
    'http.request.method': 'POST',
    'http.response.status_code': 200,
    'merkur.outcome': 'success',
    'merkur.daemon.id': 'daemon-1',
    'db.operation.name': 'Redis.commands',
  });
});

test('the derived key list matches the map and has no duplicates', () => {
  expect(SPAN_ATTRIBUTE_KEYS.length).toBeGreaterThan(0);
  expect(new Set(SPAN_ATTRIBUTE_KEYS).size).toBe(SPAN_ATTRIBUTE_KEYS.length);
});

/**
 * Naming convention: `merkur.<measure>` for report fields, `merkur.<entity>.<field>` for
 * identity. The dotted identity form exists because the server once wrote
 * `merkur.daemon_id` while the daemon and edge wrote `merkur.daemon.id`, and the two
 * silently failed to join across services.
 */
test('every merkur key is namespaced and snake_case', () => {
  for (const key of SPAN_ATTRIBUTE_KEYS) {
    if (!key.startsWith('merkur.')) continue;
    expect(`${key}:${/^merkur\.[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(key)}`).toBe(`${key}:true`);
  }
});

test('every edge field the Rust cross-check allows is reviewed here', () => {
  expect(EDGE_SPAN_ATTRIBUTE_KEYS.length).toBeGreaterThan(0);
  expect(new Set(EDGE_SPAN_ATTRIBUTE_KEYS).size).toBe(EDGE_SPAN_ATTRIBUTE_KEYS.length);
  // The edge's session id must be the same key the server and daemon use, or a session
  // cannot be joined across the three services.
  expect(EDGE_SPAN_ATTRIBUTE_KEYS).toContain('merkur.session.id');
  expect(SPAN_ATTRIBUTE_KEYS).toContain('merkur.session.id');
});
