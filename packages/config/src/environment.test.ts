import { expect, test } from 'bun:test';
import { Effect, Redacted } from 'effect';
import { environmentSources, resolveEnvironment } from './environment';

test('one parser handles quoting, comments, exports, and file-local expansion', async () => {
  const result = await Effect.runPromise(
    resolveEnvironment(
      [
        'LOCAL_HOST=127.0.0.1',
        'export HOST="127.0.0.1"',
        'PORT=3200 # local port',
        'REDIS_URL="redis://$LOCAL_HOST:6379"',
        "EDGE_REGISTRATION_KEYS_JSON='{" + '"edge":"test"' + "}'",
      ].join('\n'),
    ),
  );
  expect(Redacted.value(result.values)).toEqual({
    HOST: '127.0.0.1',
    PORT: '3200',
    REDIS_URL: 'redis://127.0.0.1:6379',
    EDGE_REGISTRATION_KEYS_JSON: '{"edge":"test"}',
  });
});

test('literal external overrides win, and empty values do not fall back', async () => {
  const result = await Effect.runPromise(
    resolveEnvironment('PORT=3100\nREDIS_URL=redis://file:6379', {
      PORT: '',
      REDIS_URL: 'redis://user:literal$PASSWORD@external:6379',
      VITE_UNREQUESTED_SECRET: 'must not be copied',
    }),
  );
  const values = Redacted.value(result.values);
  expect(values.PORT).toBe('');
  expect(values.REDIS_URL).toBe('redis://user:literal$PASSWORD@external:6379');
  expect(values.VITE_UNREQUESTED_SECRET).toBeUndefined();
  expect(environmentSources(result.sources)).toContain('REDIS_URL: environment');
  expect(JSON.stringify(result)).not.toContain('literal$PASSWORD');
});

test('cyclic file expansions fail with a redacted diagnostic', async () => {
  await expect(Effect.runPromise(resolveEnvironment('REDIS_URL=$REDIS_URL'))).rejects.toThrow(
    'Cannot parse or expand',
  );
});
