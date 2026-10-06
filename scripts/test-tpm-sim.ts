import { randomUUID } from 'node:crypto';

if (import.meta.main) {
  // An ephemeral TPM with no host devices, persistent handles, or shared state.
  const name = `merkur-tpm-test-${randomUUID()}`;
  const lifetime = new AbortController();
  const interrupt = () => lifetime.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const startup =
    'apt-get update -qq && apt-get install -y -qq --no-install-recommends swtpm && mkdir /tmp/tpm && exec swtpm socket --tpm2 --tpmstate dir=/tmp/tpm --server type=tcp,bindaddr=0.0.0.0,port=2321 --flags not-need-init,startup-clear';

  async function docker(args: string[], cleaningUp = false): Promise<string> {
    const process = Bun.spawn(['docker', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: cleaningUp ? undefined : lifetime.signal,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) throw new Error(`docker ${args[0]} failed: ${stderr.trim()}`);
    return stdout.trim();
  }

  try {
    await docker([
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::2321',
      'debian:12-slim',
      'sh',
      '-c',
      startup,
    ]);
    const address = await docker(['port', name, '2321/tcp']);
    await waitForTpm(address, lifetime.signal);
    const test = Bun.spawn(
      [
        'cargo',
        'test',
        '-p',
        'merkur-identity-seal',
        '--locked',
        '--features',
        'tpm-sim',
        '--',
        'tpm_sim',
      ],
      {
        env: { ...process.env, MERKUR_TPM_SIM_ADDR: address },
        signal: lifetime.signal,
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    process.exitCode = await test.exited;
  } finally {
    try {
      await docker(['rm', '-f', name], true);
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}

// Docker's port proxy accepts TCP before swtpm has started. Require an actual
// TPM2_GetRandom(1) response so a warm Cargo cache cannot outrun provisioning.
export async function probeTpm(port: number): Promise<void> {
  const result = Promise.withResolvers<void>();
  const response = Buffer.alloc(13);
  let received = 0;
  let connection: Bun.Socket | undefined;
  let finished = false;
  const fail = () => result.reject(new Error('TPM is not responding'));
  const timer = setTimeout(fail, 1000);
  const connected = Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(socket) {
        if (finished) {
          socket.terminate();
          return;
        }
        socket.write(Buffer.from('80010000000c0000017b0001', 'hex'));
      },
      data(_socket, chunk) {
        if (received + chunk.length > response.length) {
          fail();
          return;
        }
        response.set(chunk, received);
        received += chunk.length;
        if (received === response.length) {
          if (response.subarray(0, 12).equals(Buffer.from('80010000000d000000000001', 'hex')))
            result.resolve();
          else fail();
        }
      },
      error: fail,
      close: fail,
      end: fail,
    },
  }).then((socket) => {
    connection = socket;
    if (finished) socket.terminate();
  }, fail);
  try {
    await result.promise;
  } finally {
    finished = true;
    clearTimeout(timer);
    connection?.terminate();
    await connected;
  }
}

export async function waitForTpm(
  address: string,
  signal: AbortSignal,
  readiness: (port: number) => Promise<void> = probeTpm,
) {
  const port = Number(address.split(':').at(-1));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid simulator port');
  const deadline = performance.now() + 120_000;
  for (;;) {
    signal.throwIfAborted();
    try {
      await readiness(port);
      break;
    } catch {
      if (performance.now() >= deadline) throw new Error('TPM simulator did not start');
      await Bun.sleep(250);
    }
  }
}
