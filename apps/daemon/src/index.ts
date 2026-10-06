import '@merkur/shared/e2e-wasm-bun';
import { merkurReleasePublicKey, merkurVersion } from '@merkur/shared';
import { waitForProcessSignal } from '@merkur/shared/node-signals';
import { releasePublicKeyFingerprint } from '@merkur/shared/release-signature';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { createCliLogger } from './cli/cli-output';
import { renderCliHelp } from './cli/help';
import { runInstallCommand } from './cli/install';
import { runLicensesCommand } from './cli/licenses';
import { runLinkCommand } from './cli/link';
import { runOpenCommand } from './cli/open';
import { runSetupCommand } from './cli/setup';
import { runShellIntegrationCommand } from './cli/shell-integration';
import { runStartCommand } from './cli/start';
import { runStopCommand } from './cli/stop';
import { runTuiCommand } from './cli/tui';
import { runUpdateCommand } from './cli/update';
import { daemonInstanceLockPath, requireDaemonConfigEffect } from './config';
import { createLogger, logEffect, MerkurLoggerLayer } from './logger';
import { daemonTracerLayer } from './observability/telemetry';
import { DaemonHealthServiceLive } from './services/daemon-metrics';
import { createDaemonProofSigner } from './services/daemon-proof-signer';
import { runDaemonRuntimeEffect } from './services/daemon-runtime';
import { acquireDaemonInstanceLockEffect, DaemonAlreadyRunningError } from './single-instance';

const logger = createLogger('daemon');
/** The subcommands talk to a person; the daemon runtime below talks to a log. */
const cliLogger = createCliLogger();

const command = process.argv[2];
const args = process.argv.slice(3);

type CliCommand = (args: string[]) => Promise<number>;

const CLI_COMMANDS: Readonly<Record<string, CliCommand>> = {
  login: (commandArgs) => runTuiCommand(['login', ...commandArgs]),
  logout: (commandArgs) => runTuiCommand(['logout', ...commandArgs]),
  machines: (commandArgs) => runTuiCommand(['machines', ...commandArgs]),
  connect: (commandArgs) => runTuiCommand(['connect', ...commandArgs]),
  setup: (commandArgs) => runSetupCommand(commandArgs, cliLogger),
  link: (commandArgs) => runLinkCommand(commandArgs, cliLogger),
  install: () => runInstallCommand(cliLogger),
  start: () => runStartCommand(cliLogger),
  stop: () => runStopCommand(cliLogger),
  update: () => runUpdateCommand(cliLogger),
  open: (commandArgs) => runOpenCommand(commandArgs),
  'shell-integration': (commandArgs) => runShellIntegrationCommand(commandArgs, cliLogger),
};

if (
  command === 'help' ||
  command === '--help' ||
  command === '-h' ||
  args.includes('--help') ||
  args.includes('-h')
) {
  const topic = command === 'help' ? args[0] : command?.startsWith('-') ? undefined : command;
  const help = renderCliHelp(topic);
  if (help === null) {
    cliLogger.error('daemon_command_failed', {
      error: `Unknown help topic '${topic}'. Run \`merkur help\` for the command guide.`,
    });
    process.exit(2);
  }
  process.stdout.write(help);
  process.exit(0);
}

if (
  command !== undefined &&
  [
    'install',
    'start',
    'stop',
    'update',
    'daemon',
    'version',
    '--version',
    '-v',
    'release-key',
    'licenses',
  ].includes(command) &&
  args.length !== 0
) {
  cliLogger.error('daemon_command_failed', {
    error: `merkur ${command} takes no arguments. Run \`merkur help\` for the command guide.`,
  });
  process.exit(2);
}

if (command === 'version' || command === '--version' || command === '-v') {
  process.stdout.write(`${merkurVersion()}\n`);
  process.exit(0);
}

if (command === 'release-key') {
  const publicKey = merkurReleasePublicKey();
  if (publicKey.length === 0) {
    process.stderr.write('This build has no release key: it was built from source.\n');
    process.exit(1);
  }
  process.stdout.write(`${releasePublicKeyFingerprint(publicKey)}\n`);
  process.exit(0);
}

if (command === 'licenses') {
  // Written through `Bun.write`, not `process.stdout.write`: the notices are
  // three quarters of a megabyte, and `process.exit` drops whatever has not
  // drained, which silently truncated this to one pipe buffer.
  await Bun.write(Bun.stdout, runLicensesCommand());
  process.exit(0);
}

const cliCommand =
  command === undefined || command.startsWith('--')
    ? () => runTuiCommand(process.argv.slice(2))
    : Object.hasOwn(CLI_COMMANDS, command)
      ? CLI_COMMANDS[command]
      : undefined;
if (command !== 'daemon' && cliCommand === undefined) {
  cliLogger.error('daemon_command_failed', {
    error: `Unknown command '${command}'. Run \`merkur help\` for the command guide.`,
  });
  process.exit(2);
}

if (cliCommand !== undefined) {
  try {
    process.exit(await cliCommand(args));
  } catch (error) {
    cliLogger.error('daemon_command_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

const daemonProgram = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* requireDaemonConfigEffect();
    yield* acquireDaemonInstanceLockEffect(daemonInstanceLockPath(config.daemon_id), logger);
    // Completed before the runtime is interrupted, so the control connection's
    // finalizer can tell a deliberate stop from a lost carrier and close with
    // the shutdown code instead of leaving the lease in its resume grace.
    const shutdownIntent = yield* Deferred.make<void>();
    // Provided here rather than at the top-level runtime so the CLI commands
    // above — `link`, `install`, `update` — never open an exporter. They run
    // for a few hundred milliseconds and have no server relationship to speak
    // of; only the long-lived runtime does.
    const signer = createDaemonProofSigner();
    const runtimeFiber = yield* runDaemonRuntimeEffect(config, logger, signer, {
      shutdownIntent,
      enableFinalTransportCapture: process.env.MERKUR_E2E_FINAL_TRANSPORT_CAPTURE === '1',
    }).pipe(Effect.provide(daemonTracerLayer(config, signer)), Effect.forkScoped);
    const shutdownFiber = yield* waitForProcessSignal().pipe(
      Effect.tap((signal) => logEffect('info', 'daemon', 'daemon_shutdown_requested', { signal })),
      Effect.tap(() => Deferred.succeed(shutdownIntent, undefined)),
      Effect.flatMap(() => Fiber.interrupt(runtimeFiber)),
      Effect.forkScoped,
    );

    const runtimeExit = yield* Fiber.await(runtimeFiber);
    yield* Fiber.interrupt(shutdownFiber);

    if (Exit.isFailure(runtimeExit) && !Cause.hasInterruptsOnly(runtimeExit.cause)) {
      yield* logEffect('error', 'daemon', 'daemon_fatal', {
        cause: String(runtimeExit.cause),
        prettyCause: Cause.pretty(runtimeExit.cause),
      });
      return 1;
    }

    return 0;
  }),
  // `withLogSpan` stamps elapsed time onto log records and is safe on a program
  // that runs until a shutdown signal. A *trace* span is not, for the reason
  // `scripts/check-span-lifetimes.ts` enforces: it would never end, so it would
  // never export, and it would adopt every later span as a child. The daemon runs
  // no OTLP exporter today, so this was latent rather than live — but it is the
  // same shape that put 12.7 hours of server requests into a single trace.
).pipe(Effect.withLogSpan('daemon.runtime'));

try {
  const exitCode = await Effect.runPromise(
    daemonProgram.pipe(Effect.provide(DaemonHealthServiceLive), Effect.provide(MerkurLoggerLayer)),
  );
  process.exit(exitCode);
} catch (error) {
  if (error instanceof DaemonAlreadyRunningError) {
    logger.error('daemon_already_running', {
      lockPath: error.lockPath,
      pid: error.pid,
    });
    process.exit(1);
  }

  logger.error('daemon_fatal', {
    error: String(error),
  });
  process.exit(1);
}
