import { expect, test } from 'bun:test';

import { WAITLIST_MESSAGES, waitlistOutcome } from './waitlist';

test('each answer from /api/box-waitlist reads as the line the copy gives it', () => {
  expect(waitlistOutcome(204, null)).toBe('done');
  expect(waitlistOutcome(400, { error: 'email_refused' })).toBe('refused');
  expect(waitlistOutcome(400, { error: 'email_invalid' })).toBe('refused');
  expect(waitlistOutcome(429, null)).toBe('limited');
  // Nothing reached the list: a malformed request, a foreign origin, a fault.
  expect(waitlistOutcome(400, { error: 'invalid_request' })).toBe('unreached');
  expect(waitlistOutcome(400, null)).toBe('unreached');
  expect(waitlistOutcome(403, null)).toBe('unreached');
  expect(waitlistOutcome(500, null)).toBe('unreached');
  expect(WAITLIST_MESSAGES.done).toBe("You're on the list. I'll write when boxes open.");
});
