import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { openOwnedDirectory } from '../../tools/bazel/bun/owned-files';
import {
  declaredGitCaBundle,
  declaredGitSdkEnvironment,
} from '../../tools/bazel/verification/engine-process';
import {
  GitRevocationStore,
  type LedgerGit,
  ledgerCredentialHelperCommand,
  ledgerGitEnvironment,
  ledgerGitTransportArguments,
  trustedLedgerOrigin,
} from '../../tools/bazel/verification/revocation-git';

export interface LedgerProvisioning {
  readonly workspace: string;
  readonly directory: string;
  readonly origin: string;
  readonly credentialHelper: string;
  /** The declared acquisition tool at Git's compiled shell path, not a shell override. */
  readonly shell: string;
  readonly sdkPrefix: string;
  readonly git: (directory: string) => LedgerGit;
}

function absolute(value: string): string {
  if (!path.isAbsolute(value) || controlCharacters(value) || path.resolve(value) !== value)
    throw new Error('Ledger acquisition requires normalized absolute paths');
  return value;
}

function controlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

/** Creates only a bare client. Reading a public authority does not prove write authentication. */
export function provisionLedger(options: LedgerProvisioning): string {
  const workspace = realpathSync(absolute(options.workspace));
  const directory = absolute(options.directory);
  const parent = path.dirname(directory);
  const remote = trustedLedgerOrigin(options.origin);
  if (
    realpathSync(parent) !== parent ||
    directory === workspace ||
    directory.startsWith(`${workspace}/`)
  )
    throw new Error('Ledger client must be fresh and outside the source workspace');
  const helper = absolute(options.credentialHelper);
  const shell = absolute(options.shell);
  const sdkPrefix = absolute(options.sdkPrefix);
  if (shell !== path.join(sdkPrefix, 'bin', 'sh') || realpathSync(sdkPrefix) !== sdkPrefix)
    throw new Error('Ledger acquisition requires the original declared SDK bin/sh File');
  if (realpathSync(helper) !== helper || realpathSync(shell) !== shell)
    throw new Error('Ledger acquisition tools must use their original physical Files');
  const caBundle = declaredGitCaBundle(sdkPrefix);
  const descriptors: number[] = [];
  let namespace: ReturnType<typeof openOwnedDirectory> | undefined;
  try {
    const helperFd = openSync(
      helper,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    descriptors.push(helperFd);
    const shellFd = openSync(
      shell,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    descriptors.push(shellFd);
    const caFd = openSync(
      caBundle,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    descriptors.push(caFd);
    const heldNamespace = openOwnedDirectory('/');
    namespace = heldNamespace;
    const helperFact = fstatSync(helperFd);
    const shellFact = fstatSync(shellFd);
    const caFact = fstatSync(caFd);
    function toolsUnchanged(): void {
      for (const [file, fd, fact] of [
        [helper, helperFd, helperFact],
        [shell, shellFd, shellFact],
        [caBundle, caFd, caFact],
      ] as const) {
        const current = lstatSync(file);
        const held = fstatSync(fd);
        if (
          !fact.isFile() ||
          (file !== caBundle && (fact.mode & 0o111) === 0) ||
          current.dev !== fact.dev ||
          current.ino !== fact.ino ||
          current.mode !== fact.mode ||
          held.size !== fact.size ||
          held.mtimeMs !== fact.mtimeMs ||
          held.ctimeMs !== fact.ctimeMs
        )
          throw new Error('Ledger acquisition tool identity changed');
      }
    }
    toolsUnchanged();
    heldNamespace.directory(parent.slice(1));
    heldNamespace.verifyDirectory(parent.slice(1));
    heldNamespace.directory(directory.slice(1));
    // This method refuses pre-existing directories; only mkdirat-owned inodes can be chmodded.
    // Creation stays inside the held parent even if its pathname is replaced.
    heldNamespace.setDirectoryMode(directory.slice(1), 0o700);
    const read = options.git(directory);
    const git: LedgerGit = (args, input) => {
      toolsUnchanged();
      heldNamespace.verifyDirectory(directory.slice(1));
      const result = read(args, input);
      heldNamespace.verifyDirectory(directory.slice(1));
      toolsUnchanged();
      return result;
    };
    function checked(args: readonly string[]): string {
      const result = git(args);
      if (result.exitCode !== 0) throw new Error('Declared ledger acquisition Git failed');
      return result.stdout;
    }
    if (checked(['var', 'GIT_SHELL_PATH']).trim() !== 'sh')
      throw new Error('Declared Git must use the supported compiled sh acquisition contract');
    checked(['init', '--bare', '--template=', '.']);
    for (const [key, value] of [
      ['core.fsync', 'all'],
      ['core.fsyncMethod', 'fsync'],
      ['credential.helper', ''],
      ['credential.helper', ledgerCredentialHelperCommand(helper)],
      ['credential.useHttpPath', 'true'],
      ['credential.interactive', 'false'],
      ['http.followRedirects', 'false'],
      ['http.sslVerify', 'true'],
      ['http.sslBackend', 'openssl'],
      ['http.sslCAInfo', caBundle],
      [`http.${remote}.sslVerify`, 'true'],
      [`http.${remote}.followRedirects`, 'false'],
    ]) {
      if (key === undefined || value === undefined)
        throw new Error('Missing acquisition configuration');
      checked(['config', '--local', '--add', key, value]);
    }
    checked(['remote', 'add', 'origin', remote]);
    new GitRevocationStore(git).read();
    return directory;
  } finally {
    namespace?.close();
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

export function provisionLedgerMain(argv: readonly string[]): void {
  const values = new Map<string, string>();
  const flags = ['--workspace', '--directory', '--origin', '--credential-helper'];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flags.includes(flag) || values.has(flag))
      throw new Error('Expected each explicit ledger provisioning argument exactly once');
    values.set(flag, value);
  }
  function required(flag: string): string {
    const value = values.get(flag);
    if (value === undefined) throw new Error('Missing explicit ledger provisioning input');
    return value;
  }
  const gitCarrier = absolute(requiredEnvironment('MERKUR_VERIFICATION_GIT'));
  const sdkEnvironment = declaredGitSdkEnvironment(
    absolute(requiredEnvironment('MERKUR_BAZEL_NATIVE_SDK_PREFIX')),
    gitCarrier,
  );
  const sdkPrefix = sdkEnvironment.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
  if (sdkPrefix === undefined) throw new Error('Declared Git SDK prefix is absent');
  const executable = realpathSync(gitCarrier);
  const shell = realpathSync(absolute(requiredEnvironment('MERKUR_LEDGER_GIT_SHELL')));
  const remote = trustedLedgerOrigin(required('--origin'));

  const environment: Record<string, string> = {
    ...sdkEnvironment,
    ...ledgerGitEnvironment(),
    PATH: path.join(sdkPrefix, 'bin'),
  };
  environment.GIT_SSL_CAINFO = declaredGitCaBundle(sdkPrefix);
  environment.GIT_SSL_CAPATH = '';
  const client = provisionLedger({
    workspace: required('--workspace'),
    directory: required('--directory'),
    origin: required('--origin'),
    credentialHelper: required('--credential-helper'),
    shell,
    sdkPrefix,
    git: (directory) => (args, input) => {
      const result = Bun.spawnSync(
        [executable, '-c', 'core.fsmonitor=false', ...ledgerGitTransportArguments(remote, args)],
        {
          cwd: directory,
          env: environment,
          stdin: input ?? 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      return {
        stdout: result.stdout.toString(),
        exitCode: result.signalCode ? -1 : result.exitCode,
      };
    },
  });
  process.stdout.write(`${client}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error('Missing declared ledger acquisition tool');
  return value;
}

if (import.meta.main) {
  try {
    provisionLedgerMain(process.argv.slice(2));
  } catch (error) {
    // Every refusal is a fixed sentence; arguments and Git output never enter it.
    process.stderr.write(
      `Ledger client provisioning refused; verification must not dispatch: ${
        error instanceof Error ? error.message : 'unidentified failure'
      }\n`,
    );
    process.exitCode = 1;
  }
}
