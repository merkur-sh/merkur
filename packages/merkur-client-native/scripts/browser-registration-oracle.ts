import {
  createOpaqueRegistrationResponse,
  createOpaqueServerSetup,
  validateOpaqueServerSetup,
} from '../../auth/src/opaque';

const setup = await createOpaqueServerSetup();
process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = await validateOpaqueServerSetup(setup);
const client = await import('../../../apps/web/src/auth/account-opaque');
const started = await client.startAccountRegistration('correct horse');
const response = await createOpaqueRegistrationResponse({
  serverSetup: setup,
  userId: 'user-1',
  registrationRequest: started.registrationRequest,
});
const finished = await client.finishAccountRegistration(
  'correct horse',
  started.clientRegistrationState,
  response,
  'user-1',
  'https://merkur.example',
);
try {
  process.stdout.write(
    JSON.stringify({
      setup,
      record: finished.registrationRecord,
      exportKey: Buffer.from(finished.exportKey).toString('base64url'),
    }),
  );
} finally {
  finished.exportKey.fill(0);
}
