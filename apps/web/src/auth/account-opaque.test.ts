import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as opaque from '@serenity-kit/opaque';

import {
  finishAccountLogin,
  finishAccountRegistration,
  startAccountLogin,
  startAccountRegistration,
} from './account-opaque';

const USER_ID = 'user-opaque-test';
const SERVER_ORIGIN = 'https://merkur.example';
const PASSWORD = 'correct horse battery staple';
const previousPin = process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
let serverSetup = '';

beforeAll(async () => {
  await opaque.ready;
  serverSetup = opaque.server.createSetup();
  process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = opaque.server.getPublicKey(serverSetup);
});

afterAll(() => {
  if (previousPin === undefined) delete process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY;
  else process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = previousPin;
});

describe('browser OPAQUE identifiers', () => {
  test('round-trips only when client, user, and server identifiers match registration', async () => {
    const registrationStart = await startAccountRegistration(PASSWORD);
    const registrationResponse = opaque.server.createRegistrationResponse({
      serverSetup,
      userIdentifier: USER_ID,
      registrationRequest: registrationStart.registrationRequest,
    });
    const registrationFinish = await finishAccountRegistration(
      PASSWORD,
      registrationStart.clientRegistrationState,
      registrationResponse.registrationResponse,
      USER_ID,
      SERVER_ORIGIN,
    );
    try {
      const loginStart = await startAccountLogin(PASSWORD);
      const serverLogin = opaque.server.startLogin({
        serverSetup,
        registrationRecord: registrationFinish.registrationRecord,
        startLoginRequest: loginStart.startLoginRequest,
        userIdentifier: USER_ID,
        identifiers: { client: USER_ID, server: SERVER_ORIGIN },
      });
      const loginFinish = await finishAccountLogin(
        PASSWORD,
        loginStart.clientLoginState,
        serverLogin.loginResponse,
        USER_ID,
        SERVER_ORIGIN,
      );
      expect(loginFinish).not.toBeNull();
      if (loginFinish === null) throw new Error('OPAQUE login unexpectedly failed');
      try {
        expect(loginFinish.exportKey).toEqual(registrationFinish.exportKey);
        expect(() =>
          opaque.server.finishLogin({
            serverLoginState: serverLogin.serverLoginState,
            finishLoginRequest: loginFinish.finishLoginRequest,
            identifiers: { client: USER_ID, server: SERVER_ORIGIN },
          }),
        ).not.toThrow();
      } finally {
        loginFinish.exportKey.fill(0);
      }

      const mismatchedStart = await startAccountLogin(PASSWORD);
      const mismatchedServer = opaque.server.startLogin({
        serverSetup,
        registrationRecord: registrationFinish.registrationRecord,
        startLoginRequest: mismatchedStart.startLoginRequest,
        userIdentifier: USER_ID,
        identifiers: { client: USER_ID, server: SERVER_ORIGIN },
      });
      expect(
        await finishAccountLogin(
          PASSWORD,
          mismatchedStart.clientLoginState,
          mismatchedServer.loginResponse,
          USER_ID,
          'https://substituted.example',
        ),
      ).toBeNull();
    } finally {
      registrationFinish.exportKey.fill(0);
    }
  }, 30_000);

  test('password stretching leaves the main event loop available', async () => {
    const start = await startAccountRegistration(PASSWORD);
    const response = opaque.server.createRegistrationResponse({
      serverSetup,
      userIdentifier: USER_ID,
      registrationRequest: start.registrationRequest,
    });
    let finished = false;
    const pending = finishAccountRegistration(
      PASSWORD,
      start.clientRegistrationState,
      response.registrationResponse,
      USER_ID,
      SERVER_ORIGIN,
    ).then((result) => {
      finished = true;
      return result;
    });
    const channel = new MessageChannel();
    try {
      await new Promise<void>((resolve) => {
        channel.port1.onmessage = () => {
          expect(finished).toBe(false);
          resolve();
        };
        channel.port2.postMessage(null);
      });
      const result = await pending;
      result.exportKey.fill(0);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }, 30_000);

  test('aborting password stretching rejects the operation', async () => {
    const start = await startAccountRegistration(PASSWORD);
    const response = opaque.server.createRegistrationResponse({
      serverSetup,
      userIdentifier: USER_ID,
      registrationRequest: start.registrationRequest,
    });
    const controller = new AbortController();
    const pending = finishAccountRegistration(
      PASSWORD,
      start.clientRegistrationState,
      response.registrationResponse,
      USER_ID,
      SERVER_ORIGIN,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      finishAccountRegistration(
        PASSWORD,
        start.clientRegistrationState,
        response.registrationResponse,
        USER_ID,
        SERVER_ORIGIN,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
