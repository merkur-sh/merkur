import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { RedisClient } from 'bun';
import { withDeclaredDragonfly } from './dragonfly-runtime';

const executable = process.env.MERKUR_DRAGONFLY_BIN;
const scratch = process.env.TEST_TMPDIR;
const loader = process.env.MERKUR_DRAGONFLY_LOADER;
const sdk = process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
if (executable === undefined || scratch === undefined || loader === undefined || sdk === undefined)
  throw new Error(
    'Genuine Dragonfly qualification requires the declared native backend and engine scratch',
  );
const declared = { executable, scratch, loader, libraryDirectory: path.join(sdk, 'lib') };

async function genuineFixture(
  operation: (url: string, signal: AbortSignal) => Promise<void>,
  signal = new AbortController().signal,
): Promise<void> {
  const directory = await mkdtemp(path.join(declared.scratch, 'dragonfly-native-control-'));
  try {
    await withDeclaredDragonfly(
      {
        executable: declared.executable,
        loader: declared.loader,
        libraryDirectory: declared.libraryDirectory,
        directory,
        signal,
      },
      operation,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function authenticatedBackendPid(url: string): Promise<number> {
  const client = new RedisClient(url, { autoReconnect: false });
  try {
    await client.connect();
    expect(await client.send('PING', [])).toBe('PONG');
    const info: unknown = await client.send('INFO', ['server']);
    if (typeof info !== 'string') throw new Error('Genuine INFO server reply is absent');
    const field = info.split('\r\n').find((line) => line.startsWith('process_id:'));
    const pid = Number(field?.slice('process_id:'.length));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Owned native backend PID is absent');
    return pid;
  } finally {
    client.close();
  }
}

test('the real native backend authenticates and its owned process exits after success', async () => {
  let pid = 0;
  await genuineFixture(async (url) => {
    pid = await authenticatedBackendPid(url);
  });
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);

test('the real native backend is cleaned up when the original operation fails', async () => {
  let pid = 0;
  await expect(
    genuineFixture(async (url) => {
      pid = await authenticatedBackendPid(url);
      throw new Error('original operation failure');
    }),
  ).rejects.toThrow('original operation failure');
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);

test('cancellation retires the authenticated native fixture and waits for its exit', async () => {
  let pid = 0;
  const controller = new AbortController();
  await expect(
    genuineFixture(async (url, signal) => {
      pid = await authenticatedBackendPid(url);
      controller.abort(new Error('cancel owned Dragonfly fixture'));
      signal.throwIfAborted();
    }, controller.signal),
  ).rejects.toThrow('cancel owned Dragonfly fixture');
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);
