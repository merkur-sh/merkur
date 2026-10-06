import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { RedisClient } from 'bun';

const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 2_000;
const VERSION = 'df-v2.0.0';

export function dragonflyCommand(
  executable: string,
  loader: string,
  libraryDirectory: string,
  directory: string,
  password: string,
): string[] {
  if (
    !path.isAbsolute(executable) ||
    !statSync(executable).isFile() ||
    !path.isAbsolute(loader) ||
    !statSync(loader).isFile() ||
    !path.isAbsolute(libraryDirectory) ||
    !statSync(libraryDirectory).isDirectory() ||
    !path.isAbsolute(directory)
  )
    throw new Error(
      'Dragonfly fixture requires its declared native executable and private directory',
    );
  return [
    loader,
    '--inhibit-cache',
    '--library-path',
    libraryDirectory,
    executable,
    '--bind=127.0.0.1',
    '--port=-1',
    `--unixsocket=${path.join(directory, 'redis.sock')}`,
    '--unixsocketperm=700',
    `--requirepass=${password}`,
    `--dir=${directory}`,
    '--dbfilename=fixture',
    '--version_check=false',
    '--logtostderr=true',
  ];
}

/** Endpoint facts come from authenticated native replies, never a reserved-then-released port. */
export function dragonflyPort(configuration: unknown, information: unknown): number {
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration))
    throw new Error('Dragonfly CONFIG GET did not return its native RESP3 map');
  const port = (configuration as Record<string, unknown>).port;
  if (typeof port !== 'string' || !/^[1-9][0-9]*$/.test(port))
    throw new Error('Dragonfly did not report its bound ephemeral TCP port');
  const value = Number(port);
  if (!Number.isSafeInteger(value) || value > 65_535)
    throw new Error('Dragonfly reported an invalid TCP port');
  if (typeof information !== 'string') throw new Error('Dragonfly INFO server reply is absent');
  const facts = new Map<string, string>();
  for (const line of information.split('\r\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 1 || facts.has(line.slice(0, separator)))
      throw new Error('Dragonfly INFO server facts are malformed or ambiguous');
    facts.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (facts.get('dragonfly_version') !== VERSION || facts.get('tcp_port') !== port)
    throw new Error(
      'Authenticated backend does not match declared Dragonfly v2.0.0 and bound port',
    );
  return value;
}

export async function withDeclaredDragonfly<T>(
  options: {
    readonly executable: string;
    readonly loader: string;
    readonly libraryDirectory: string;
    readonly directory: string;
    readonly signal: AbortSignal;
  },
  operation: (redisUrl: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  options.signal.throwIfAborted();
  const password = randomUUID();
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(options.signal.reason);
  const ready = Promise.withResolvers<void>();
  const socket = path.join(options.directory, 'redis.sock');
  let stopping = false;
  const child = Bun.spawn(
    dragonflyCommand(
      options.executable,
      options.loader,
      options.libraryDirectory,
      options.directory,
      password,
    ),
    {
      cwd: options.directory,
      env: {
        HOME: options.directory,
        TMPDIR: options.directory,
        PATH: '/__no_ambient_path__',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  options.signal.addEventListener('abort', abort, { once: true });
  const abortReady = () => ready.reject(lifetime.signal.reason);
  lifetime.signal.addEventListener('abort', abortReady, { once: true });
  // This native bind-success event only triggers connection. Acceptance still
  // requires authenticated INFO/CONFIG and PING on the actual TCP listener.
  async function drain(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of stream) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines)
        if (line.endsWith(`Listening on unix socket ${socket}`)) ready.resolve();
    }
  }
  const output = Promise.all([drain(child.stdout), drain(child.stderr)]);
  void output.catch((error: unknown) => lifetime.abort(error));
  void child.exited.then((code) => {
    if (!stopping)
      lifetime.abort(new Error(`Owned Dragonfly backend exited unexpectedly (${code})`));
  });
  const startupTimer = setTimeout(
    () =>
      lifetime.abort(new Error(`Dragonfly did not authenticate within ${STARTUP_TIMEOUT_MS}ms`)),
    STARTUP_TIMEOUT_MS,
  );
  let discovery: RedisClient | undefined;
  let probe: RedisClient | undefined;
  try {
    await ready.promise;
    lifetime.signal.throwIfAborted();
    discovery = new RedisClient(`redis+unix://:${password}@localhost${socket}`, {
      autoReconnect: false,
    });
    const closeClients = () => {
      discovery?.close();
      probe?.close();
    };
    lifetime.signal.addEventListener('abort', closeClients, { once: true });
    try {
      await discovery.connect();
      const configuration: unknown = await discovery.send('CONFIG', ['GET', 'port']);
      const information: unknown = await discovery.send('INFO', ['server']);
      const port = dragonflyPort(configuration, information);
      const redisUrl = `redis://:${password}@127.0.0.1:${port}`;
      probe = new RedisClient(redisUrl, { autoReconnect: false });
      await probe.connect();
      if ((await probe.send('PING', [])) !== 'PONG')
        throw new Error('Owned authenticated Dragonfly TCP listener did not answer PING');
      clearTimeout(startupTimer);
      lifetime.signal.throwIfAborted();
      const value = await operation(redisUrl, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (child.exitCode !== null)
        throw new Error('Owned Dragonfly backend exited before operation completion');
      return value;
    } finally {
      lifetime.signal.removeEventListener('abort', closeClients);
    }
  } finally {
    clearTimeout(startupTimer);
    stopping = true;
    discovery?.close();
    probe?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, STOP_TIMEOUT_MS);
    try {
      await child.exited;
      await output;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      lifetime.signal.removeEventListener('abort', abortReady);
    }
  }
}
