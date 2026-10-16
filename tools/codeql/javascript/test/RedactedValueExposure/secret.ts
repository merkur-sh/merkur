import { createLogger, type Logger } from '@merkur/logger';
import { createHmac } from 'node:crypto';
import { Data, Effect, Redacted } from 'effect';
import { status } from 'elysia';

class BoxHostError extends Data.TaggedError('BoxHostError')<{ readonly message: string }> {}
class RefusedBoxHostError extends BoxHostError {}

const logger = createLogger('fixture');

export function useToken(secret: Redacted.Redacted<string>, injected: Logger) {
  const token = Redacted.value(secret); // $ Source
  fetch('https://box.example/boxes', { headers: { authorization: `Bearer ${token}` } });
  const fingerprint = createHmac('sha512', token).update('fingerprint').digest('hex');
  logger.info('box_host_key', { fingerprint });
  logger.info('box_host_request', { token }); // $ Alert
  injected.warn(`token ${token}`); // $ Alert
  Effect.logError('refused', token); // $ Alert
  Effect.withSpan('request', { attributes: { token } }); // $ Alert
  new Error(`refused ${token}`); // $ Alert
  new RefusedBoxHostError({ message: token }); // $ Alert
  status(401, { error: token }); // $ Alert
  return new Response(token); // $ Alert
}
