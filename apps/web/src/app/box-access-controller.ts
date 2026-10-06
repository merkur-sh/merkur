import { Effect } from 'effect';
import { type Accessor, createSignal } from 'solid-js';

import { type BoxAccess, fetchBoxAccessEffect, joinBoxWaitlistEffect } from '../api';

/**
 * The account's own standing on the hosted-box waitlist, and — for an operator
 * — every account.
 *
 * `access` is null until the first answer arrives, so the New box dialog can
 * tell "not asked yet" from "not approved" rather than flashing the waitlist
 * prompt at an approved account.
 *
 * The operator's view is the account list rather than the waitlist alone: box
 * access is one column of an account, beside whether it is suspended and
 * whether it has asked to be erased.
 */
export interface BoxAccessController {
  readonly access: Accessor<BoxAccess | null>;
  /**
   * Takes the token explicitly: it runs at the sign-in edge, before the
   * controller's token signal has been published.
   */
  load(accessToken: string): Promise<void>;
  /** Joins the waitlist; false when the request failed. */
  join(): Promise<boolean>;
  reset(): void;
}

export function createBoxAccessController(options: {
  getAccessToken(): string | null;
}): BoxAccessController {
  const [access, setAccess] = createSignal<BoxAccess | null>(null);
  // Sign-out resets while a request may still be in flight; a late answer for
  // the previous account must not land on the next one.
  let generation = 0;

  function requireAccessToken(): string {
    const token = options.getAccessToken();
    if (token === null) throw new Error('No active browser account');
    return token;
  }

  async function load(accessToken: string): Promise<void> {
    const started = generation;
    const next = await Effect.runPromise(fetchBoxAccessEffect(accessToken));
    if (started === generation) setAccess(next);
  }

  async function join(): Promise<boolean> {
    const started = generation;
    try {
      const next = await Effect.runPromise(joinBoxWaitlistEffect(requireAccessToken()));
      if (started === generation) setAccess(next);
      return true;
    } catch {
      return false;
    }
  }

  function reset(): void {
    generation += 1;
    setAccess(null);
  }

  return {
    access,
    load,
    join,
    reset,
  };
}
