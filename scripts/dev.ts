import '../packages/shared/src/e2e-wasm-bun';
import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Redacted } from 'effect';
import {
  developmentServerOrigin,
  developmentWebOrigin,
  loadDevelopmentEnvironment,
  serverProcessEnvironment,
  toolEnvironment,
} from './dev-environment';

export interface DevelopmentStackRuntime {
  readonly root: string;
  readonly sourceRoot: string;
  readonly serverEnvironmentFile: string;
  readonly configurationEnvironment: Readonly<Record<string, string | undefined>>;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly daemonConfigPath: string;
  readonly edgeIdentityDirectory: string;
  readonly commands: {
    readonly server: readonly string[];
    readonly web: (port: string) => readonly string[];
    readonly daemon: readonly string[];
  };
  readonly doctor: (
    environment: Record<string, string | undefined>,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly buildEdge: (signal: AbortSignal) => Promise<string>;
  readonly buildDaemon: (signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
}

export interface DevelopmentStack {
  readonly done: Promise<number>;
  readonly stop: (exitCode: number) => Promise<void>;
  readonly rebuildDaemon: () => Promise<void>;
}

/** One child lifecycle for the active developer script and the declared Bazel entrypoint. */
export async function runDevelopmentStack(
  runtime: DevelopmentStackRuntime,
): Promise<DevelopmentStack> {
  const REPO_ROOT = runtime.root;
  const SERVER_ENV_PATH = runtime.serverEnvironmentFile;
  try {
    await access(SERVER_ENV_PATH);
  } catch {
    process.stderr.write('Missing apps/server/.env. Run `bun run setup` first.\n');
    throw new Error('Development stack preflight failed');
  }

  const environment = await Effect.runPromise(
    loadDevelopmentEnvironment(SERVER_ENV_PATH, runtime.configurationEnvironment),
  );
  const settings = Redacted.value(environment.values);
  const serverConfig = environment.config;
  const EDGE_PORT = Number(settings.MERKUR_EDGE_PORT ?? 4433);
  const SERVER_ORIGIN = developmentServerOrigin(serverConfig.host, serverConfig.port);
  const WEB_ORIGIN = developmentWebOrigin;
  const WEB_PORT = new URL(WEB_ORIGIN).port;
  const EDGE_URL = `https://[::1]:${EDGE_PORT}`;
  const EDGE_ID = 'local-dev-1';
  const edgeKey = serverConfig.edgeRegistrationKeys.get(EDGE_ID);
  const EDGE_REGISTRATION_KEY =
    edgeKey === undefined ? null : Buffer.from(edgeKey).toString('base64url');
  const EDGE_ATTACH_TICKET_KEY = Buffer.from(serverConfig.edgeAttachTicketKey).toString(
    'base64url',
  );
  const platformEnvironment = { ...runtime.environment };
  const serverEnvironment = {
    ...platformEnvironment,
    ...serverProcessEnvironment(platformEnvironment, settings),
  };
  const webEnvironment = {
    ...platformEnvironment,
    VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY: serverConfig.opaqueServerPublicKey,
    MERKUR_BACKEND_ORIGIN: SERVER_ORIGIN,
  };
  let daemonEnvironment = { ...platformEnvironment, LOG_LEVEL: settings.LOG_LEVEL };
  const SERVER_ONLY = runtime.arguments.includes('--server-only');
  const WEB_ONLY = runtime.arguments.includes('--web-only');
  if (!SERVER_ONLY && Number(WEB_PORT) === serverConfig.port)
    throw new Error(
      'PORT must differ from the local Vite port 3000; PUBLIC_ORIGIN describes the browser-facing address, not the Vite listener',
    );
  const WITH_DAEMON = runtime.arguments.includes('--with-daemon');
  const DAEMON_DIRECTORY = path.join(REPO_ROOT, 'apps/daemon');
  const DAEMON_CONFIG_PATH = runtime.daemonConfigPath;
  const DATAPLANE_SOURCE_DIRECTORY = path.join(runtime.sourceRoot, 'apps/daemon/dataplane/src');
  // Editors write a source file in several syscalls, and compiling is far more
  // expensive than the wait, so coalesce a burst into one rebuild.
  const DATAPLANE_REBUILD_DEBOUNCE_MS = 200;
  const children = new Map<string, ReturnType<typeof Bun.spawn>>();
  let stopping = false;
  const cancellation = new AbortController();
  const builds = new Set<Promise<Readonly<Record<string, string>>>>();
  let daemon: ReturnType<typeof Bun.spawn> | null = null;
  // A managed restart kills the daemon on purpose. Without this the supervisor
  // would read that exit as a crash and tear down the whole stack.
  let daemonRestarting = false;

  const interrupted = () => void stop(0);
  let watcher: ReturnType<typeof watch> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const completed = Promise.withResolvers<number>();
  const handle: DevelopmentStack = {
    done: completed.promise,
    stop,
    rebuildDaemon: rebuildDataplaneAndRestartDaemon,
  };

  if (!Number.isInteger(EDGE_PORT) || EDGE_PORT < 1 || EDGE_PORT > 65_535) {
    throw new Error('MERKUR_EDGE_PORT must be an integer from 1 to 65535');
  }

  // Fail before the edge build rather than after it: linking needs a token from
  // the running web app, so it is not something this script can do for you.
  if (WITH_DAEMON) {
    try {
      await access(DAEMON_CONFIG_PATH);
    } catch {
      process.stderr.write(
        [
          `Missing ${DAEMON_CONFIG_PATH}; this machine has no linked daemon.`,
          'Start the stack with `bun run dev`, create a link token in the web app, then run:',
          '  MERKUR_LINK_TOKEN=<token> bun run --cwd apps/daemon link <server-origin>',
          'and re-run `bun run dev:full`.',
          '',
        ].join('\n'),
      );
      throw new Error('Development stack preflight failed');
    }
  }

  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);

  try {
    if (WEB_ONLY) {
      spawnService(
        'web',
        [...runtime.commands.web(WEB_PORT)],
        path.join(REPO_ROOT, 'apps/web'),
        webEnvironment,
      );
      return handle;
    }

    await runtime.doctor(serverEnvironment, cancellation.signal);

    // The doctor already fails on a missing map. Assert the exact local identity is
    // provisioned instead of substituting a key shared by every checkout.
    if (EDGE_REGISTRATION_KEY === null) {
      process.stderr.write(
        `EDGE_REGISTRATION_KEYS_JSON must contain a key for ${EDGE_ID}. Run \`bun run setup\`.\n`,
      );
      throw new Error('Development stack preflight failed');
    }
    if (EDGE_ATTACH_TICKET_KEY === '') {
      process.stderr.write(
        'EDGE_ATTACH_TICKET_KEY is missing from apps/server/.env. Run `bun run setup`.\n',
      );
      throw new Error('Development stack preflight failed');
    }

    try {
      process.stdout.write('\nBuilding the local WebTransport edge...\n');
      const EDGE_BINARY = await runtime.buildEdge(cancellation.signal);

      // The server starts first because the edge waits on it: an edge is not
      // publicly discoverable until it has registered, and `waitForEdge` below waits
      // for exactly that. Starting the edge first deadlocked the whole stack —
      // registration retried against a server this script had not spawned yet, and
      // `bun run dev` died 30s later having started nothing at all.
      spawnService(
        'server',
        [...runtime.commands.server],
        path.join(REPO_ROOT, 'apps/server'),
        serverEnvironment,
      );

      const edge = Bun.spawn([EDGE_BINARY], {
        cwd: REPO_ROOT,
        env: {
          ...platformEnvironment,
          MERKUR_EDGE_PORT: String(EDGE_PORT),
          MERKUR_EDGE_HOSTNAME: 'localhost',
          // The server's own address, not PUBLIC_ORIGIN: the edge is an internal
          // process authenticated by a registration key, and in development
          // PUBLIC_ORIGIN is Vite, which is neither started yet nor part of this
          // hop.
          MERKUR_EDGE_REGISTER_URL: `${SERVER_ORIGIN}/api/edge/register`,
          MERKUR_EDGE_REGISTRATION_KEY: EDGE_REGISTRATION_KEY,
          MERKUR_EDGE_ATTACH_TICKET_KEY: EDGE_ATTACH_TICKET_KEY,
          MERKUR_EDGE_ID: EDGE_ID,
          MERKUR_EDGE_REGION: 'local',
          MERKUR_EDGE_PUBLIC_URL: EDGE_URL,
          MERKUR_EDGE_DATA_BUDGET_GB: '1000000',
          MERKUR_EDGE_SIGNALING_RESERVE_GB: '100000',
          MERKUR_EDGE_EGRESS_INTERFACE: process.platform === 'darwin' ? 'lo0' : 'lo',
          MERKUR_EDGE_IDENTITY_DIR: runtime.edgeIdentityDirectory,
          NO_COLOR: '1',
        },
        stdout: 'pipe',
        stderr: 'inherit',
      });
      children.set('edge', edge);
      try {
        await waitForEdge(edge);
      } catch (error) {
        process.stderr.write(
          `\nFailed to start the local edge: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        await stop(1);
        throw new Error('Development stack preflight failed');
      }
      supervise('edge', edge);

      if (!SERVER_ONLY) {
        spawnService(
          'web',
          [...runtime.commands.web(WEB_PORT)],
          path.join(REPO_ROOT, 'apps/web'),
          webEnvironment,
        );
      }

      if (WITH_DAEMON) {
        process.stdout.write('\nBuilding the dataplane before starting the daemon...\n');
        daemonEnvironment = { ...daemonEnvironment, ...(await buildDaemon()) };
        startDaemon();
        watchDataplaneSources();
      }

      process.stdout.write(
        [
          '',
          'Merkur development stack is running:',
          `  web     ${SERVER_ONLY ? 'not started' : WEB_ORIGIN}`,
          `  server  ${SERVER_ORIGIN}`,
          `  edge    ${EDGE_URL}`,
          `  daemon  ${WITH_DAEMON ? 'running; dataplane sources are watched' : 'not started'}`,
          '',
          'Press Ctrl-C to stop every process.',
          '',
        ].join('\n'),
      );
    } catch (error) {
      await stop(1);
      throw error;
    }

    return handle;
  } catch (error) {
    await stop(1);
    throw error;
  }

  function spawnService(
    name: string,
    command: string[],
    cwd: string,
    env: Record<string, string | undefined>,
  ): void {
    const child = Bun.spawn(command, {
      cwd,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    children.set(name, child);
    supervise(name, child);
  }

  /**
   * The daemon is supervised separately from `spawnService` because it is the one
   * child this script restarts on purpose.
   */
  function startDaemon(): void {
    const child = Bun.spawn([...runtime.commands.daemon], {
      cwd: DAEMON_DIRECTORY,
      env: daemonEnvironment,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    daemon = child;
    children.set('daemon', child);
    void child.exited.then((exitCode) => {
      if (stopping || daemonRestarting) {
        return;
      }
      process.stderr.write(
        [
          `\ndaemon exited unexpectedly with code ${exitCode}.`,
          'If an installed daemon already holds the single-instance lock, stop it first:',
          '  merkur stop',
          'That leaves it stopped until you restore it with:',
          '  merkur start',
          '',
        ].join('\n'),
      );
      void stop(exitCode === 0 ? 1 : exitCode);
    });
  }

  /**
   * `bun --watch` already reloads the daemon's TypeScript. Rust is what goes
   * stale silently: the daemon keeps running the previously built binary, and the
   * mismatch surfaces later as unexplained IPC or auth-timeout failures rather
   * than as a build error.
   */
  function watchDataplaneSources(): void {
    let rebuilding = false;
    let changedDuringRebuild = false;

    const rebuild = (): void => {
      if (stopping) return;
      if (rebuilding) {
        changedDuringRebuild = true;
        return;
      }
      rebuilding = true;
      void rebuildDataplaneAndRestartDaemon().finally(() => {
        rebuilding = false;
        if (changedDuringRebuild) {
          changedDuringRebuild = false;
          rebuild();
        }
      });
    };

    watcher = watch(DATAPLANE_SOURCE_DIRECTORY, { recursive: true }, (_event, filename) => {
      if (
        filename !== null &&
        !['.rs', '.swift'].some((extension) => filename.toString().endsWith(extension))
      ) {
        return;
      }
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(rebuild, DATAPLANE_REBUILD_DEBOUNCE_MS);
    });
  }

  async function buildDaemon(): Promise<Readonly<Record<string, string>>> {
    const build = runtime.buildDaemon(cancellation.signal);
    builds.add(build);
    try {
      return await build;
    } finally {
      builds.delete(build);
    }
  }

  async function rebuildDataplaneAndRestartDaemon(): Promise<void> {
    process.stdout.write('\nDataplane sources changed. Rebuilding...\n');
    if (stopping) return;
    try {
      const binaries = await buildDaemon();
      if (stopping) return;
      daemonEnvironment = { ...daemonEnvironment, ...binaries };
    } catch {
      // Failed rebuilds never replace the daemon's last good executable selection.
      process.stderr.write('Dataplane rebuild failed. The daemon keeps its previous binary.\n');
      return;
    }

    await restartDaemon();
    process.stdout.write('Daemon restarted on the rebuilt dataplane.\n');
  }

  async function restartDaemon(): Promise<void> {
    const current = daemon;
    if (current === null) {
      return;
    }

    daemonRestarting = true;
    if (current.exitCode === null) {
      current.kill('SIGTERM');
    }
    // The daemon holds a single-instance lock, so the replacement cannot start
    // until this process has actually exited and released it.
    await Promise.race([current.exited, Bun.sleep(5_000)]);
    if (current.exitCode === null) {
      current.kill('SIGKILL');
      await current.exited;
    }
    children.delete('daemon');
    daemon = null;

    startDaemon();
    daemonRestarting = false;
  }

  function supervise(name: string, child: ReturnType<typeof Bun.spawn>): void {
    void child.exited.then((exitCode) => {
      if (!stopping) {
        process.stderr.write(`\n${name} exited unexpectedly with code ${exitCode}.\n`);
        void stop(exitCode === 0 ? 1 : exitCode);
      }
    });
  }

  async function waitForEdge(processHandle: ReturnType<typeof Bun.spawn>): Promise<string> {
    const stream = processHandle.stdout;
    if (!(stream instanceof ReadableStream)) {
      throw new Error('Failed to capture merkur-edge output');
    }

    return await new Promise<string>((resolve, reject) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffered = '';
      let settled = false;
      let certHash: string | null = null;
      let listening = false;
      const timer = setTimeout(
        () => finish(new Error('merkur-edge did not become ready in 30s')),
        30_000,
      );

      const finish = (result: string | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      void processHandle.exited.then((exitCode) => {
        finish(new Error(`merkur-edge exited before becoming ready (code ${exitCode})`));
      });

      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            process.stdout.write(text);
            buffered += text;
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            for (const line of lines) {
              const match = /cert_hash_b64=([A-Za-z0-9+/]{43}=)/.exec(line);
              if (match?.[1] !== undefined) certHash = match[1];
              if (line.includes('blind WebTransport relay listening')) listening = true;
              if (listening && certHash !== null) finish(certHash);
            }
          }
          finish(new Error('merkur-edge output closed before its ready message'));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }

  async function stop(exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    cancellation.abort(new Error('Development stack stopped'));
    watcher?.close();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    for (const child of children.values()) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.race([
      Promise.allSettled([...children.values()].map((child) => child.exited)),
      Bun.sleep(3_000),
    ]);
    for (const child of children.values()) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled([...children.values()].map((child) => child.exited));
    await Promise.allSettled([...builds]);
    completed.resolve(exitCode);
  }
}

if (import.meta.main) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const environment = toolEnvironment(process.env);
  async function prerequisite(
    command: string[],
    signal: AbortSignal,
    env: Record<string, string | undefined> = environment,
  ): Promise<void> {
    const child = Bun.spawn(command, {
      cwd: root,
      env,
      signal,
      killSignal: 'SIGTERM',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`Development prerequisite failed with code ${code}`);
  }
  const stack = await runDevelopmentStack({
    root,
    sourceRoot: root,
    serverEnvironmentFile: path.join(root, 'apps/server/.env'),
    configurationEnvironment: process.env,
    arguments: process.argv.slice(2),
    environment,
    daemonConfigPath: path.join(homedir(), '.merkur', 'config.json'),
    edgeIdentityDirectory: path.join(root, 'target', 'edge-dev-identity'),
    commands: {
      server: [process.execPath, '--bun', '--watch', '--no-env-file', 'run', 'src/index.ts'],
      web: (port) => [process.execPath, '--bun', '--no-env-file', 'run', 'dev', '--port', port],
      daemon: [
        process.execPath,
        '--bun',
        '--watch',
        '--no-env-file',
        'run',
        'src/index.ts',
        'daemon',
      ],
    },
    doctor: (env, signal) =>
      prerequisite(
        [process.execPath, '--bun', '--no-env-file', 'run', 'scripts/dev-doctor.ts'],
        signal,
        env,
      ),
    buildEdge: async (signal) => {
      await prerequisite(
        ['cargo', 'build', '--manifest-path', 'Cargo.toml', '--locked', '-p', 'merkur-edge'],
        signal,
      );
      return path.join(
        root,
        'target/rust/debug',
        process.platform === 'win32' ? 'merkur-edge.exe' : 'merkur-edge',
      );
    },
    buildDaemon: async (signal) => {
      await prerequisite(
        [process.execPath, '--bun', '--no-env-file', 'run', 'scripts/build-daemon-artifacts.ts'],
        signal,
      );
      return {};
    },
  });
  process.exit(await stack.done);
}
