import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import type { AuthServiceConfig } from './auth-service';
import {
  db,
  finishRegistration,
  OLD_PASSWORD,
  type SentMail,
  service,
  startClientAndServerAuth,
  useAuthServiceFixture,
  useEmailIdentity,
} from './auth-service-fixture';

useAuthServiceFixture();

describe('email identity', () => {
  const ADDRESS = 'someone@example.com';
  const admitAll = () => Effect.void;
  let sent: SentMail[];

  async function emailService(overrides: Partial<AuthServiceConfig> = {}) {
    sent = [];
    await useEmailIdentity(sent, overrides);
  }

  function requestCode(started: Awaited<ReturnType<typeof startClientAndServerAuth>>) {
    return Effect.runPromise(service.requestEmailCode(started.server.login.flowId, admitAll));
  }

  function lastCode(): string {
    const code = sent.at(-1)?.code;
    if (code === undefined || code === null) throw new Error('no code was mailed');
    return code;
  }

  function wrongCode(code: string): string {
    return code === '000000' ? '000001' : '000000';
  }

  test('refuses a name that is not an address', async () => {
    await emailService();
    await expect(startClientAndServerAuth(OLD_PASSWORD, 'plain-username')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(startClientAndServerAuth(OLD_PASSWORD, 'a@b@example.com')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(startClientAndServerAuth(OLD_PASSWORD, 'someone@localhost')).rejects.toMatchObject(
      { code: 'invalid_request' },
    );
  });

  test('creates the account only with the code mailed to the normalized address', async () => {
    await emailService();
    const started = await startClientAndServerAuth(OLD_PASSWORD, '  Someone@Example.COM ');
    await requestCode(started);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'code', to: ADDRESS });
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);

    await expect(finishRegistration(started, 0x22, 'delegation-no-code')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      finishRegistration(started, 0x22, 'delegation-wrong', wrongCode(code)),
    ).rejects.toMatchObject({ code: 'invalid_email_code' });
    // A wrong code leaves the flow for the right one.
    const registered = await finishRegistration(started, 0x22, 'delegation-right', code);

    expect(registered.session.userId).toBe(started.server.registration.userId);
    expect(await db.selectFrom('users').select(['username']).execute()).toEqual([
      { username: ADDRESS },
    ]);
  });

  test('an existing address is sent a notice, never a code, and every guess fails alike', async () => {
    await emailService();
    const first = await startClientAndServerAuth(OLD_PASSWORD, ADDRESS);
    await requestCode(first);
    await finishRegistration(first, 0x22, 'delegation-existing', lastCode());

    const again = await startClientAndServerAuth('not the password', ADDRESS);
    await requestCode(again);

    expect(sent.at(-1)).toMatchObject({ kind: 'already-registered', to: ADDRESS, code: null });
    for (const guess of ['000000', '123456', '999999']) {
      await expect(
        finishRegistration(again, 0x23, `delegation-guess-${guess}`, guess),
      ).rejects.toMatchObject({ code: 'invalid_email_code' });
    }
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  test('five wrong codes destroy the flow, so the sixth guess finds nothing', async () => {
    await emailService();
    const started = await startClientAndServerAuth(OLD_PASSWORD, ADDRESS);
    await requestCode(started);
    const code = lastCode();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        finishRegistration(started, 0x22, `delegation-${attempt}`, wrongCode(code)),
      ).rejects.toMatchObject({ code: 'invalid_email_code' });
    }
    await expect(finishRegistration(started, 0x22, 'delegation-late', code)).rejects.toMatchObject({
      code: 'invalid_flow',
    });
    expect(await db.selectFrom('users').select('id').execute()).toEqual([]);
  });

  test('a resend replaces the code under a new idempotency key and keeps the attempt count', async () => {
    await emailService();
    const started = await startClientAndServerAuth(OLD_PASSWORD, ADDRESS);
    await requestCode(started);
    const first = lastCode();
    await expect(
      finishRegistration(started, 0x22, 'delegation-wrong', wrongCode(first)),
    ).rejects.toMatchObject({ code: 'invalid_email_code' });
    await requestCode(started);
    const second = lastCode();

    expect(sent.map((mail) => mail.idempotencyKey)).toEqual([
      `${started.server.login.flowId}:1`,
      `${started.server.login.flowId}:2`,
    ]);
    if (first !== second) {
      await expect(
        finishRegistration(started, 0x22, 'delegation-stale', first),
      ).rejects.toMatchObject({ code: 'invalid_email_code' });
    }
    await expect(
      finishRegistration(started, 0x22, 'delegation-current', second),
    ).resolves.toBeDefined();
  });

  test('a closed sign-up refuses the code request and mails nothing', async () => {
    await emailService({ allowRegistration: false });
    const started = await startClientAndServerAuth(OLD_PASSWORD, ADDRESS);

    await expect(requestCode(started)).rejects.toMatchObject({ code: 'registration_closed' });
    expect(sent).toEqual([]);
  });

  test('a refused admission records and sends nothing', async () => {
    await emailService();
    const started = await startClientAndServerAuth(OLD_PASSWORD, ADDRESS);
    const recipients: string[] = [];

    await expect(
      Effect.runPromise(
        service.requestEmailCode(started.server.login.flowId, (recipient) =>
          Effect.suspend(() => {
            recipients.push(recipient);
            return Effect.fail('limited' as const);
          }),
        ),
      ),
    ).rejects.toBe('limited');
    expect(recipients).toEqual([ADDRESS]);
    expect(sent).toEqual([]);
  });

  test('a disposable domain is refused before any mail is sent', async () => {
    await emailService();
    const started = await startClientAndServerAuth(OLD_PASSWORD, 'someone@mailinator.com');

    await expect(requestCode(started)).rejects.toMatchObject({ code: 'email_not_accepted' });
    expect(sent).toEqual([]);
  });

  test("a suspended account's mailbox cannot open another account under any spelling", async () => {
    await emailService();
    const first = await startClientAndServerAuth(OLD_PASSWORD, 'first.last@gmail.com');
    await requestCode(first);
    await finishRegistration(first, 0x22, 'delegation-suspended', lastCode());
    await db.updateTable('users').set({ suspended_at: 1 }).execute();

    for (const spelling of ['firstlast+again@gmail.com', 'first.last@googlemail.com']) {
      const again = await startClientAndServerAuth(OLD_PASSWORD, spelling);
      await expect(requestCode(again)).rejects.toMatchObject({ code: 'email_not_accepted' });
    }
    expect(sent).toHaveLength(1);
    // The suspended address itself is an existing account: it gets the same
    // notice any existing address gets, so the refusal names no account.
    const same = await startClientAndServerAuth('not the password', 'first.last@gmail.com');
    await requestCode(same);
    expect(sent.at(-1)).toMatchObject({ kind: 'already-registered' });
  });

  test('a suspension after the code was mailed still refuses the finish', async () => {
    await emailService();
    const first = await startClientAndServerAuth(OLD_PASSWORD, ADDRESS);
    await requestCode(first);
    await finishRegistration(first, 0x22, 'delegation-first', lastCode());
    const second = await startClientAndServerAuth(OLD_PASSWORD, 'someone+two@example.com');
    await requestCode(second);
    const code = lastCode();
    await db.updateTable('users').set({ suspended_at: 1 }).execute();

    await expect(finishRegistration(second, 0x23, 'delegation-second', code)).rejects.toMatchObject(
      { code: 'email_not_accepted' },
    );
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  test('username identity has no code step in either direction', async () => {
    const started = await startClientAndServerAuth(OLD_PASSWORD);

    await expect(requestCode(started)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      finishRegistration(started, 0x22, 'delegation-code', '123456'),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
