import { expect, test } from 'bun:test';
import { bazelClientEnvironment, sanitizeBuildEvents } from './sanitize';

test('command, environment, progress and arbitrary diagnostic payloads are not retained', () => {
  const secret = 'synthetic-secret-for-negative-control';
  const raw = [
    {
      id: { started: {} },
      started: { uuid: 'invocation', buildToolVersion: '9.2.0', optionsDescription: secret },
      children: [{ buildFinished: {} }],
    },
    { id: { unstructuredCommandLine: {} }, unstructuredCommandLine: { args: [secret] } },
    { id: { optionsParsed: {} }, optionsParsed: { cmdLine: [secret] } },
    { id: { progress: { opaqueCount: 1 } }, progress: { stderr: secret } },
    {
      id: { buildFinished: {} },
      finished: { exitCode: { code: 0, name: 'SUCCESS' }, failureDetail: secret },
      lastMessage: true,
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const safe = sanitizeBuildEvents(raw);
  expect(safe).not.toContain(secret);
  expect(safe).toContain('invocation');
  expect(safe).toContain('SUCCESS');
  expect(safe).toContain('lastMessage');
  expect(safe).toContain('9.2.0');
});

test('Bazel client environment uses an explicit allowlist without inherited auth', () => {
  expect(
    bazelClientEnvironment({ HOME: '/actual/home', PATH: '/tools', SECRET_TOKEN: 'synthetic' }),
  ).toEqual({ HOME: '/actual/home', PATH: '/tools' });
});

test('artifact provenance preserves engine identities and digests without URIs or inline bytes', () => {
  const secret = 'synthetic-artifact-uri-secret';
  const raw = [
    {
      id: { namedSet: { id: 'files' } },
      namedSetOfFiles: {
        files: [
          {
            name: 'app',
            pathPrefix: ['bazel-out', 'cpu-fastbuild', 'bin'],
            digest: 'a'.repeat(64),
            length: '42',
            uri: `https://user:${secret}@example.invalid/file`,
            contents: secret,
          },
          { name: 'link', symlinkTargetPath: secret },
        ],
        fileSets: [{ id: 'nested' }],
      },
    },
    {
      id: { targetCompleted: { label: '//app:binary', configuration: { id: 'configuration' } } },
      completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: 'files' }] }] },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const safe = sanitizeBuildEvents(raw);
  expect(safe).not.toContain(secret);
  expect(safe).not.toContain('https:');
  expect(safe).toContain('"digest"');
  expect(safe).toContain('"length":"42"');
  expect(safe).toContain('"symlink":true');
  expect(safe).toContain('"fileSets"');
  expect(sanitizeBuildEvents(safe)).toBe(safe);
});
