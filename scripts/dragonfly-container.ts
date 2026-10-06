const DRAGONFLY_IMAGE = 'docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.0';
const READY_TIMEOUT_MS = 15_000;

export interface DragonflyContainer {
  readonly id: string;
  readonly redisUrl: string;
}

export async function withDragonflyContainer<T>(
  operation: (container: DragonflyContainer) => Promise<T>,
): Promise<T> {
  const containerId = (await capture(dragonflyCreateCommand())).trim();
  if (containerId.length === 0) {
    throw new Error('Dragonfly container did not return an id');
  }

  const health = watchDockerHealth(containerId);
  let cleanupPromise: Promise<void> | null = null;
  const stopOnce = (): Promise<void> => {
    cleanupPromise ??= stopContainer(containerId);
    return cleanupPromise;
  };
  const stopForSignal = (exitCode: number): void => {
    health.cancel();
    void stopOnce().finally(() => process.exit(exitCode));
  };
  const onInterrupt = (): void => stopForSignal(130);
  const onTerminate = (): void => stopForSignal(143);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  let operationFailure: unknown = null;
  let cleanupFailure: unknown = null;
  let result: T | undefined;
  try {
    await runChecked(['docker', 'start', containerId]);
    const port = parseDragonflyPort(await capture(['docker', 'port', containerId, '6379/tcp']));
    const inspectedStatus = (
      await capture(['docker', 'inspect', '--format={{.State.Health.Status}}', containerId])
    ).trim();
    if (inspectedStatus !== 'healthy') {
      await health.ready;
    }
    result = await operation({ id: containerId, redisUrl: `redis://127.0.0.1:${port}` });
  } catch (error) {
    operationFailure = error;
  } finally {
    health.cancel();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    try {
      await stopOnce();
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (operationFailure !== null && cleanupFailure !== null) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      'Dragonfly operation and container cleanup both failed',
    );
  }
  if (cleanupFailure !== null) throw cleanupFailure;
  if (operationFailure !== null) throw operationFailure;
  return result as T;
}

export function dragonflyCreateCommand(): string[] {
  return [
    'docker',
    'create',
    '--rm',
    '--publish',
    '127.0.0.1::6379',
    '--health-cmd',
    "redis-cli ping | grep -q '^PONG$'",
    '--health-interval',
    '50ms',
    '--health-timeout',
    '1s',
    '--health-retries',
    '300',
    DRAGONFLY_IMAGE,
  ];
}

export function parseDragonflyPort(output: string): string {
  const port = /(?:127\.0\.0\.1|\[::1\]):(\d+)/.exec(output)?.[1];
  if (port === undefined) {
    throw new Error(`Could not resolve Dragonfly host port: ${output.trim()}`);
  }
  return port;
}

export function dockerHealthStatusFromEventLine(line: string): 'healthy' | 'unhealthy' | null {
  if (line.trim() === 'health_status: healthy') return 'healthy';
  if (line.trim() === 'health_status: unhealthy') return 'unhealthy';
  return null;
}

function watchDockerHealth(containerId: string): {
  readonly ready: Promise<void>;
  readonly cancel: () => void;
} {
  const processHandle = Bun.spawn(dockerHealthWatchCommand(containerId), {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    settle(() =>
      rejectReady(new Error(`Dragonfly did not become healthy within ${READY_TIMEOUT_MS}ms`)),
    );
  }, READY_TIMEOUT_MS);

  const settle = (complete: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    complete();
    processHandle.kill('SIGTERM');
  };
  const cancel = (): void => {
    // Cancellation means the owner has either observed readiness or is already
    // unwinding for another error. Resolve a watcher that was never awaited so
    // intentional cleanup cannot surface as an unhandled rejection.
    settle(resolveReady);
  };

  void (async () => {
    const reader = processHandle.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    while (!settled) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const status = dockerHealthStatusFromEventLine(line);
        if (status === 'healthy') {
          settle(resolveReady);
          return;
        }
        if (status === 'unhealthy') {
          settle(() => rejectReady(new Error('Dragonfly container reported unhealthy')));
          return;
        }
      }
    }
  })().catch((error: unknown) => {
    settle(() => rejectReady(new Error(`Docker health event stream failed: ${String(error)}`)));
  });
  void processHandle.exited.then(async (exitCode) => {
    if (!settled) {
      const stderr = await new Response(processHandle.stderr).text();
      settle(() =>
        rejectReady(
          new Error(
            `Docker health event stream exited with ${exitCode}: ${formatProcessOutput('', stderr)}`,
          ),
        ),
      );
    }
  });

  return { ready, cancel };
}

export function dockerHealthWatchCommand(containerId: string): string[] {
  return [
    'docker',
    'events',
    `--filter=container=${containerId}`,
    // Docker 29 removed the deprecated .Status event alias. .Action is the
    // current schema field and carries "health_status: healthy".
    '--format={{.Action}}',
  ];
}

async function capture(command: readonly string[]): Promise<string> {
  const processHandle = Bun.spawn([...command], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} exited with ${exitCode}: ${formatProcessOutput(stdout, stderr)}`,
    );
  }
  return stdout;
}

async function runChecked(command: readonly string[]): Promise<void> {
  await capture(command);
}

async function stopContainer(containerId: string): Promise<void> {
  const stopped = await runForResult(['docker', 'stop', '--timeout', '2', containerId]);
  if (stopped.exitCode === 0 || isMissingContainerOutput(stopped.stdout, stopped.stderr)) return;

  const removed = await runForResult(['docker', 'rm', '--force', containerId]);
  if (removed.exitCode === 0 || isMissingContainerOutput(removed.stdout, removed.stderr)) return;

  throw new Error(
    `Failed to stop Dragonfly container ${containerId}: ` +
      `docker stop exited ${stopped.exitCode} ` +
      `(${formatProcessOutput(stopped.stdout, stopped.stderr)}); ` +
      `docker rm --force exited ${removed.exitCode} ` +
      `(${formatProcessOutput(removed.stdout, removed.stderr)})`,
  );
}

async function runForResult(
  command: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  const processHandle = Bun.spawn([...command], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function isMissingContainerOutput(stdout: string, stderr: string): boolean {
  return /no such (?:container|object)/i.test(`${stdout}\n${stderr}`);
}

function formatProcessOutput(stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.trim();
  return output.length === 0 ? 'no output' : output;
}
