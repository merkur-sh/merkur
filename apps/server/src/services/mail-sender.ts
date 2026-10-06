import { Effect, Redacted } from 'effect';

import type { EmailDeliveryConfig } from '../config';
import { type InfrastructureError, infrastructureError } from './errors';

/**
 * Resend answers in well under a second; a sign-up waiting on it is a person
 * looking at a spinner, so a stalled send fails and the resend button retries.
 */
const SEND_TIMEOUT = '10 seconds';

/**
 * The only mail the server sends: what email-identity sign-up and password
 * reset need.
 *
 * Every message but the last goes to an address somebody typed, so each call is
 * one send and nothing else: no account lookup, no retries that would make the
 * response time say which message of a pair was sent.
 */
export interface MailSender {
  sendSignUpCode(input: {
    readonly to: string;
    readonly code: string;
    readonly idempotencyKey: string;
  }): Effect.Effect<void, InfrastructureError>;
  sendAlreadyRegistered(input: {
    readonly to: string;
    readonly idempotencyKey: string;
  }): Effect.Effect<void, InfrastructureError>;
  sendPasswordResetCode(input: {
    readonly to: string;
    readonly code: string;
    readonly idempotencyKey: string;
  }): Effect.Effect<void, InfrastructureError>;
  /** The reset form's answer to an address that has no account. */
  sendPasswordResetNoAccount(input: {
    readonly to: string;
    readonly idempotencyKey: string;
  }): Effect.Effect<void, InfrastructureError>;
  /** Tells the account's address that its password was just reset. */
  sendPasswordWasReset(input: {
    readonly to: string;
    readonly idempotencyKey: string;
  }): Effect.Effect<void, InfrastructureError>;
}

export function createResendMailSender(
  config: EmailDeliveryConfig,
  publicOrigin: string,
): MailSender {
  const host = new URL(publicOrigin).host;
  const send = (
    operation: string,
    idempotencyKey: string,
    message: { readonly to: string; readonly subject: string; readonly text: string },
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${config.resendApiUrl}/emails`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${Redacted.value(config.resendApiKey)}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          signal,
        });
        // The body names the provider's reason, never anything the caller
        // needs; it is drained so the connection returns to the pool.
        const detail = await response.text();
        if (!response.ok) throw new Error(`Resend answered ${response.status}: ${detail}`);
      },
      catch: infrastructureError('mail', operation),
    }).pipe(
      Effect.timeout(SEND_TIMEOUT),
      Effect.mapError((error) =>
        error._tag === 'InfrastructureError'
          ? error
          : infrastructureError('mail', operation)(error),
      ),
    );

  return {
    sendSignUpCode: ({ to, code, idempotencyKey }) =>
      send('send-sign-up-code', idempotencyKey, {
        to,
        subject: `${code} is your Merkur code`,
        text: [
          `Enter this code to finish creating your Merkur account on ${host}:`,
          '',
          code,
          '',
          'It expires in 10 minutes. If you did not try to sign up, ignore this email;',
          'no account is created without the code.',
        ].join('\n'),
      }),
    sendAlreadyRegistered: ({ to, idempotencyKey }) =>
      send('send-already-registered', idempotencyKey, {
        to,
        subject: 'Your Merkur sign-in did not match',
        text: [
          `Someone just tried to sign in or sign up on ${host} with this address.`,
          '',
          'This address already has an account, so no code was sent. If it was you,',
          'the password you entered was wrong: go back and sign in with the',
          'password you chose when you created the account.',
          '',
          'If it was not you, nothing has changed and no one has access.',
        ].join('\n'),
      }),
    sendPasswordResetCode: ({ to, code, idempotencyKey }) =>
      send('send-password-reset-code', idempotencyKey, {
        to,
        subject: `${code} is your Merkur password reset code`,
        text: [
          `Enter this code on ${host} to reset the password of your Merkur account:`,
          '',
          code,
          '',
          'It expires in 10 minutes. Resetting the password signs out every browser,',
          'unlinks every machine and deletes every hosted box with everything on it.',
          '',
          'Nobody from Merkur will ask you for this code. If you did not ask for a',
          'reset, ignore this email: nothing changes without the code.',
        ].join('\n'),
      }),
    sendPasswordResetNoAccount: ({ to, idempotencyKey }) =>
      send('send-password-reset-no-account', idempotencyKey, {
        to,
        subject: 'Your Merkur password reset',
        text: [
          `Someone just asked to reset a Merkur password on ${host} with this address.`,
          '',
          'No account uses this address, so there is nothing to reset. If it was you,',
          'your account is under a different address, or you have not created one yet.',
          '',
          'If it was not you, ignore this email.',
        ].join('\n'),
      }),
    sendPasswordWasReset: ({ to, idempotencyKey }) =>
      send('send-password-was-reset', idempotencyKey, {
        to,
        subject: 'Your Merkur password was reset',
        text: [
          `The password of your Merkur account on ${host} was just reset with a code`,
          'mailed to this address. Every browser was signed out, every machine was',
          'unlinked and every hosted box was deleted.',
          '',
          'If it was you, link your machines again from the machine list.',
          '',
          'If it was not you, someone can read this mailbox. Secure it first, then',
          `reset the password again on ${host}. Your machines were not reached:`,
          'a reset cannot open a terminal.',
        ].join('\n'),
      }),
  };
}
