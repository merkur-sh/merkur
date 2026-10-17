import { Effect, Redacted } from 'effect';

import type { EmailDeliveryConfig } from '../config';
import { type InfrastructureError, infrastructureError } from './errors';
import { MAIL_LOCKUP, type MailContent, renderMail } from './mail-message';

/**
 * Resend answers in well under a second; a sign-up waiting on it is a person
 * looking at a spinner, so a stalled send fails and the resend button retries.
 */
const SEND_TIMEOUT = '10 seconds';

/**
 * Email-identity sign-up, password reset and account inactivity notices.
 *
 * Authentication messages go to an address somebody typed, so each call is
 * one send and nothing else: no account lookup, no retries that would make the
 * response time say which message of a pair was sent.
 */
export interface MailSender {
  /** Starts the 30-day notice period for an account inactive for 12 months. */
  sendInactivityNotice(input: {
    readonly to: string;
    readonly idempotencyKey: string;
  }): Effect.Effect<void, InfrastructureError>;
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
  const send = (operation: string, idempotencyKey: string, to: string, content: MailContent) => {
    const mail = renderMail(content, publicOrigin);
    return Effect.tryPromise({
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
            to: [to],
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            attachments: [
              {
                content: MAIL_LOCKUP.content,
                filename: MAIL_LOCKUP.filename,
                content_type: 'image/png',
                content_id: MAIL_LOCKUP.contentId,
              },
            ],
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
  };
  // Every mail sent to an address somebody typed into the form says so; the
  // two sent to an account's own address say that instead.
  const typedHere = `You got this because this address was entered on ${host}.`;
  const accountAddress = `You got this because this is the address of a Merkur account on ${host}.`;

  return {
    sendInactivityNotice: ({ to, idempotencyKey }) =>
      send('send-inactivity-notice', idempotencyKey, to, {
        subject: 'Your inactive Merkur account will be deleted',
        preview: 'Sign in within 30 days to keep it.',
        title: 'Your account will be deleted in 30 days.',
        deck: 'Nobody has signed in to it for 12 months.',
        paragraphs: [
          `You have not signed in to your Merkur account on ${host} for 12 months. Your account, linked machines and hosted boxes with everything on them will be deleted in 30 days. Files on your own machines are unaffected.`,
          'To keep your account, sign in within 30 days.',
        ],
        action: { label: 'Sign in to keep it', href: publicOrigin },
        reason: accountAddress,
      }),
    sendSignUpCode: ({ to, code, idempotencyKey }) =>
      send('send-sign-up-code', idempotencyKey, to, {
        subject: `${code} is your Merkur code`,
        preview: `Enter it on ${host} to finish creating your account.`,
        title: 'Finish creating your account.',
        deck: `Enter this code on ${host}.`,
        code: { label: 'Sign-up code', value: code, expiry: 'It expires in 10 minutes.' },
        paragraphs: [],
        footnote:
          'If you did not try to sign up, ignore this email; no account is created without the code.',
        reason: typedHere,
      }),
    sendAlreadyRegistered: ({ to, idempotencyKey }) =>
      send('send-already-registered', idempotencyKey, to, {
        subject: 'Your Merkur sign-in did not match',
        preview: 'This address already has an account, so no code was sent.',
        title: 'This address already has an account.',
        deck: 'So no code was sent.',
        paragraphs: [
          `Someone just tried to sign in or sign up on ${host} with this address.`,
          'If it was you, the password you entered was wrong: go back and sign in with the password you chose when you created the account.',
        ],
        action: { label: 'Sign in', href: publicOrigin },
        footnote: 'If it was not you, nothing has changed and no one has access.',
        reason: typedHere,
      }),
    sendPasswordResetCode: ({ to, code, idempotencyKey }) =>
      send('send-password-reset-code', idempotencyKey, to, {
        subject: `${code} is your Merkur password reset code`,
        preview: `Enter it on ${host} to reset your password.`,
        title: 'Reset your password.',
        deck: `Enter this code on ${host}.`,
        code: { label: 'Reset code', value: code, expiry: 'It expires in 10 minutes.' },
        paragraphs: [],
        notice: {
          tone: 'warn',
          text: 'Resetting the password signs out every browser, unlinks every machine and deletes every hosted box with everything on it.',
        },
        footnote:
          'Nobody from Merkur will ask you for this code. If you did not ask for a reset, ignore this email: nothing changes without the code.',
        reason: typedHere,
      }),
    sendPasswordResetNoAccount: ({ to, idempotencyKey }) =>
      send('send-password-reset-no-account', idempotencyKey, to, {
        subject: 'Your Merkur password reset',
        preview: 'No account uses this address, so there is nothing to reset.',
        title: 'No account uses this address.',
        deck: 'There is nothing to reset.',
        paragraphs: [
          `Someone just asked to reset a Merkur password on ${host} with this address.`,
          'If it was you, your account is under a different address, or you have not created one yet.',
        ],
        footnote: 'If it was not you, ignore this email.',
        reason: typedHere,
      }),
    sendPasswordWasReset: ({ to, idempotencyKey }) =>
      send('send-password-was-reset', idempotencyKey, to, {
        subject: 'Your Merkur password was reset',
        preview: 'Every browser was signed out and every machine was unlinked.',
        title: 'Your password was reset.',
        deck: 'With a code mailed to this address.',
        paragraphs: [
          `The password of your Merkur account on ${host} was just reset. Every browser was signed out, every machine was unlinked and every hosted box was deleted.`,
          'If it was you, link your machines again from the machine list.',
        ],
        action: { label: 'Open Merkur', href: publicOrigin },
        notice: {
          tone: 'bad',
          text: `If it was not you, someone can read this mailbox. Secure it first, then reset the password again on ${host}. Your machines were not reached: a reset cannot open a terminal.`,
        },
        reason: accountAddress,
      }),
  };
}
