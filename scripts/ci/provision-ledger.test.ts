import { test as declaredTest, expect, spyOn } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reserveTests } from '../../tools/bazel/verification/revocation';
import {
  GitRevocationStore,
  type LedgerGit,
  ledgerGitEnvironment,
} from '../../tools/bazel/verification/revocation-git';
import { type LedgerProvisioning, provisionLedger, provisionLedgerMain } from './provision-ledger';

// These controls drive the Git SDK a declaring runner supplies; a source run has none.
const test = process.env.TEST_SRCDIR === undefined ? declaredTest.skip : declaredTest;

function fixture() {
  const directory = mkdtempSync(path.join(realTemporaryDirectory(), 'merkur-ledger-bootstrap-'));
  const executable = process.env.MERKUR_VERIFICATION_GIT;
  if (executable === undefined || !path.isAbsolute(executable))
    throw new Error('Ledger bootstrap controls require declared native Git');
  const gitFile = executable;
  const helper = path.join(directory, 'external helper');
  copyFileSync(process.execPath, helper);
  chmodSync(helper, 0o700);
  const commands: string[][] = [];
  function native(cwd: string): LedgerGit {
    return (args, input) => {
      const result = Bun.spawnSync([gitFile, ...args], {
        cwd,
        env: { ...process.env, ...ledgerGitEnvironment(), PATH: '' },
        stdin: input ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        stdout: result.stdout.toString(),
        exitCode: result.signalCode ? -1 : result.exitCode,
      };
    };
  }
  const authority = path.join(directory, 'authority.git');
  expect(native(directory)(['init', '--bare', '--template=', authority]).exitCode).toBe(0);
  expect(native(authority)(['remote', 'add', 'origin', authority]).exitCode).toBe(0);
  reserveTests(new GitRevocationStore(native(authority)), ['//fixture:test'], true);
  const sdkPrefix = path.join(directory, 'sdk');
  mkdirSync(path.join(sdkPrefix, 'bin'), { recursive: true });
  mkdirSync(path.join(sdkPrefix, 'ssl'));
  writeFileSync(path.join(sdkPrefix, 'ssl', 'cacert.pem'), 'unexecuted CA fixture');
  symlinkSync('cacert.pem', path.join(sdkPrefix, 'ssl', 'cert.pem'));
  const shell = path.join(sdkPrefix, 'bin', 'sh');
  // Explicit local mechanics fixture, not a declared SDK or rebuilt Git qualification.
  copyFileSync('/bin/sh', shell);
  const options: LedgerProvisioning = {
    workspace: process.cwd(),
    directory: path.join(directory, 'client.git'),
    origin: 'https://ledger.example.invalid/verification.git',
    credentialHelper: helper,
    shell,
    sdkPrefix,
    git: (cwd) => (args, input) => {
      commands.push([...args]);
      // The new compiled-shell field is a data fixture until the supported SDK is acquired.
      if (args[0] === 'var') return { stdout: 'sh\n', exitCode: 0 };
      // Only the low-level fixture substitutes local transport. The shipped API refuses local origins.
      const local =
        args[0] === 'ls-remote' || args[0] === 'fetch'
          ? args.map((argument) => (argument === 'origin' ? authority : argument))
          : args;
      return native(cwd)(local, input);
    },
  };
  return {
    directory,
    authority,
    options,
    commands,
    native,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function realTemporaryDirectory(): string {
  // The actual fixture uses physical /private/tmp on Darwin, avoiding presentation aliases.
  return process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
}

test('client mechanics with an explicit compiled-contract fixture read canonical native Git state without publication', () => {
  const setup = fixture();
  try {
    expect(provisionLedger(setup.options)).toBe(setup.options.directory);
    const git = setup.native(setup.options.directory);
    expect(git(['rev-parse', '--is-bare-repository']).stdout).toBe('true\n');
    expect(git(['remote', 'get-url', 'origin']).stdout.trim()).toBe(setup.options.origin);
    expect(git(['config', '--get-all', 'credential.helper']).stdout).toBe(
      `\n${setup.options.credentialHelper.replace(/[^A-Za-z0-9_./-]/g, (value) => `\\${value}`)}\n`,
    );
    expect(git(['config', '--get', 'http.followRedirects']).stdout).toBe('false\n');
    expect(git(['config', '--get', 'http.sslVerify']).stdout).toBe('true\n');
    expect(git(['config', '--get', 'http.sslBackend']).stdout).toBe('openssl\n');
    expect(git(['config', '--get', 'http.sslCAInfo']).stdout).toBe(
      `${path.join(setup.options.sdkPrefix, 'ssl', 'cacert.pem')}\n`,
    );
    expect(git(['config', '--get', `http.${setup.options.origin}.sslVerify`]).stdout).toBe(
      'true\n',
    );
    expect(setup.commands.some((args) => args[0] === 'push' || args[0] === 'commit-tree')).toBe(
      false,
    );
    expect(existsSync(path.join(setup.options.directory, 'hooks'))).toBe(false);
    // This transport fixture does not exercise HTTPS authentication, helper execution or a declared shell SDK.
  } finally {
    setup.close();
  }
});

test('ledger transport retains the declared SDK-only process PATH after fixed ledger environment merging', () => {
  const setup = fixture();
  try {
    const executable = process.env.MERKUR_VERIFICATION_GIT;
    if (executable === undefined || !path.isAbsolute(executable))
      throw new Error('Ledger PATH controls require declared native Git');
    const gitFile = executable;
    const sdkBin = path.dirname(gitFile);
    const processEnvironment = Object.freeze({ ...process.env, PATH: sdkBin });
    // A client that does not hold the authority's revision, so reading it transfers objects.
    const client = path.join(setup.directory, 'reader.git');
    expect(setup.native(setup.directory)(['init', '--bare', '--template=', client]).exitCode).toBe(
      0,
    );
    expect(setup.native(client)(['remote', 'add', 'origin', setup.authority]).exitCode).toBe(0);
    const transportCommands: string[] = [];
    const git: LedgerGit = (args, input) => {
      const environment = { ...processEnvironment, ...ledgerGitEnvironment() };
      expect(environment.PATH).toBe(sdkBin);
      const result = Bun.spawnSync([gitFile, ...args], {
        cwd: client,
        env: environment,
        stdin: input ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const command = args[0];
      if (command === undefined) throw new Error('Missing fixture ledger command');
      transportCommands.push(command);
      return {
        stdout: result.stdout.toString(),
        exitCode: result.signalCode ? -1 : result.exitCode,
      };
    };
    const snapshot = new GitRevocationStore(git).read();
    expect(snapshot.ledger['//fixture:test']?.state).toBe('pending');
    expect(transportCommands).toContain('ls-remote');
    expect(transportCommands).toContain('fetch');
    expect(transportCommands).toContain('show');
    expect(processEnvironment.PATH).toBe(sdkBin);
    // Genuine local Git state/transport, not supported sh or protected HTTPS authentication proof.
  } finally {
    setup.close();
  }
});

test('local, credential-bearing, redirected and noncanonical policy origins refuse before client creation', () => {
  const setup = fixture();
  try {
    for (const origin of [
      setup.directory,
      'file:///tmp/ledger.git',
      'http://ledger.example.invalid/a',
      // Joined so the staged secret scan does not read the fixture as a credential URI.
      ['https://user', 'secret@ledger.example.invalid/a'].join(':'),
      'https://ledger.example.invalid/a?secret=x',
      'https://ledger.example.invalid/a#fragment',
      'https://LEDGER.example.invalid/a',
    ]) {
      expect(() => provisionLedger({ ...setup.options, origin })).toThrow();
      expect(existsSync(setup.options.directory)).toBe(false);
    }
  } finally {
    setup.close();
  }
});

test('existing clients, source descendants and parent aliases never become implicit ledger authority', () => {
  const setup = fixture();
  try {
    expect(() =>
      provisionLedger({
        ...setup.options,
        directory: path.join(process.cwd(), 'unwanted-ledger.git'),
      }),
    ).toThrow('outside the source');
    expect(() => provisionLedger({ ...setup.options, directory: setup.directory })).toThrow();
    const alias = path.join(setup.directory, 'alias');
    symlinkSync(setup.directory, alias);
    expect(() =>
      provisionLedger({ ...setup.options, directory: path.join(alias, 'client.git') }),
    ).toThrow('outside the source');
    expect(existsSync(setup.options.directory)).toBe(false);
  } finally {
    setup.close();
  }
});

test('compiled-shell mismatch and absent or foreign helper Files prevent remote acquisition', () => {
  const setup = fixture();
  try {
    expect(() =>
      provisionLedger({ ...setup.options, credentialHelper: path.join(setup.directory, 'absent') }),
    ).toThrow();
    const alias = path.join(setup.directory, 'helper-alias');
    symlinkSync(setup.options.credentialHelper, alias);
    expect(() => provisionLedger({ ...setup.options, credentialHelper: alias })).toThrow(
      'physical Files',
    );
    expect(() =>
      provisionLedger({ ...setup.options, shell: setup.options.credentialHelper }),
    ).toThrow('original declared SDK bin/sh');
    expect(setup.commands.some((args) => args[0] === 'ls-remote')).toBe(false);
  } finally {
    setup.close();
  }
});

test('absolute or foreign compiled shell names are refused rather than using the old host shell contract', () => {
  for (const compiled of ['/bin/sh', 'bash', '/foreign/sh']) {
    const setup = fixture();
    try {
      const read = setup.options.git;
      expect(() =>
        provisionLedger({
          ...setup.options,
          git: (cwd) => {
            const git = read(cwd);
            return (args, input) =>
              args[0] === 'var' ? { stdout: `${compiled}\n`, exitCode: 0 } : git(args, input);
          },
        }),
      ).toThrow('supported compiled sh');
      expect(setup.commands.some((args) => args[0] === 'ls-remote')).toBe(false);
    } finally {
      setup.close();
    }
  }
});

test('remote refusal or malformed ledger cannot return a usable client or dispatch verification', () => {
  for (const remoteResult of [
    { stdout: 'unauthorized', exitCode: 1 },
    { stdout: 'malformed ref\n', exitCode: 0 },
  ]) {
    const setup = fixture();
    try {
      let returned = false;
      const original = setup.options.git;
      expect(() => {
        provisionLedger({
          ...setup.options,
          git: (cwd) => {
            const git = original(cwd);
            return (args, input) => (args[0] === 'ls-remote' ? remoteResult : git(args, input));
          },
        });
        returned = true;
      }).toThrow('authoritative revocation ref');
      expect(returned).toBe(false);
    } finally {
      setup.close();
    }
  }
});

test('helper replacement and client namespace replacement refuse while preserving replacement callers', () => {
  for (const kind of ['helper', 'client']) {
    const setup = fixture();
    try {
      const original = setup.options.git;
      const held = `${setup.options.directory}.held`;
      expect(() =>
        provisionLedger({
          ...setup.options,
          git: (cwd) => {
            const git = original(cwd);
            return (args, input) => {
              const result = git(args, input);
              if (args[0] === 'init') {
                if (kind === 'helper') {
                  const bytes = readFileSync(setup.options.credentialHelper);
                  renameSync(
                    setup.options.credentialHelper,
                    `${setup.options.credentialHelper}.held`,
                  );
                  copyFileSync(
                    `${setup.options.credentialHelper}.held`,
                    setup.options.credentialHelper,
                  );
                  expect(readFileSync(setup.options.credentialHelper)).toEqual(bytes);
                } else {
                  renameSync(setup.options.directory, held);
                  symlinkSync(held, setup.options.directory);
                }
              }
              return result;
            };
          },
        }),
      ).toThrow();
      expect(setup.commands.some((args) => args[0] === 'ls-remote')).toBe(false);
      expect(existsSync(setup.options.credentialHelper)).toBe(true);
    } finally {
      setup.close();
    }
  }
});

test('the real entrypoint refuses missing declared acquisition tools and malformed arguments without publishing', () => {
  for (const [argv, cause] of [
    [[], 'Missing declared ledger acquisition tool'],
    [
      ['--unknown', 'harmless-private-sentinel'],
      'Expected each explicit ledger provisioning argument exactly once',
    ],
    [
      [
        '--origin',
        'https://ledger.example.invalid/a',
        '--origin',
        'https://ledger.example.invalid/b',
      ],
      'Expected each explicit ledger provisioning argument exactly once',
    ],
  ] as const) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        '--config=' + path.join(process.cwd(), 'tools/bazel/bun/empty-bunfig.toml'),
        path.join(process.cwd(), 'scripts/ci/provision-ledger.ts'),
        ...argv,
      ],
      {
        cwd: process.cwd(),
        env: { HOME: realTemporaryDirectory(), TMPDIR: realTemporaryDirectory(), PATH: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe(
      `Ledger client provisioning refused; verification must not dispatch: ${cause}\n`,
    );
  }
});

test('entrypoint resolves declared launcher carriers into the same SDK before native client mechanics', () => {
  const setup = fixture();
  const suppliedGit = process.env.MERKUR_VERIFICATION_GIT;
  if (suppliedGit === undefined) throw new Error('Original native Git fixture required');
  const originalGit = realpathSync(suppliedGit);
  const sdk = setup.options.sdkPrefix;
  const sdkGit = path.join(sdk, 'bin', 'git');
  // Original native Git bytes, explicit local mechanics SDK: no acquisition or auth claim.
  copyFileSync(originalGit, sdkGit);
  symlinkSync(path.join(path.dirname(path.dirname(originalGit)), 'lib'), path.join(sdk, 'lib'));
  for (const name of ['libexec', 'share'])
    symlinkSync(path.join(path.dirname(path.dirname(originalGit)), name), path.join(sdk, name));
  const tools = path.join(setup.directory, 'provision_ledger.tools');
  mkdirSync(tools);
  const gitCarrier = path.join(tools, 'git');
  const shellCarrier = path.join(tools, 'sh');
  symlinkSync(sdkGit, gitCarrier);
  symlinkSync(setup.options.shell, shellCarrier);
  const prefixCarrier = path.join(setup.directory, 'sdk-runfiles');
  symlinkSync(sdk, prefixCarrier);
  const savedEnvironment = { ...process.env };
  const originalSpawn = Bun.spawnSync;
  const transport: string[][] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
  Reflect.set(
    Bun,
    'spawnSync',
    (command: readonly string[], options: Parameters<typeof Bun.spawnSync>[1]) => {
      if (!Array.isArray(command) || command[0] !== sdkGit)
        throw new Error('Fixture entrypoint left its exact native Git');
      const args = command.slice(1);
      expect(options?.env?.PATH).toBe(path.join(sdk, 'bin'));
      expect(options?.env?.GIT_EXEC_PATH).toBe(path.join(sdk, 'libexec', 'git-core'));
      expect(options?.env?.DYLD_FALLBACK_LIBRARY_PATH).toBe(path.join(sdk, 'lib'));
      expect(options?.env?.DYLD_LIBRARY_PATH).toBeUndefined();
      transport.push(args);
      const operation = args.findIndex((argument) =>
        ['var', 'ls-remote', 'fetch'].includes(String(argument)),
      );
      const local =
        operation !== -1 && args[operation] !== 'var'
          ? args.map((argument) => (argument === setup.options.origin ? setup.authority : argument))
          : args;
      const result = originalSpawn([sdkGit, ...local], {
        ...options,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (operation !== -1 && args[operation] !== 'var' && result.exitCode !== 0)
        throw new Error(`Fixture local Git transport failed: ${String(result.stderr)}`);
      // The literal-sh observation is synthetic; HTTPS alone is redirected locally.
      return operation !== -1 && args[operation] === 'var'
        ? { ...result, stdout: Buffer.from('sh\n') }
        : result;
    },
  );
  try {
    process.env.MERKUR_VERIFICATION_GIT = gitCarrier;
    process.env.MERKUR_LEDGER_GIT_SHELL = shellCarrier;
    process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX = prefixCarrier;
    process.env.DYLD_LIBRARY_PATH = '/__foreign_libraries__';
    process.env.GIT_EXEC_PATH = '/__foreign_git_helpers__';
    const argv = [
      '--workspace',
      process.cwd(),
      '--directory',
      setup.options.directory,
      '--origin',
      setup.options.origin,
      '--credential-helper',
      setup.options.credentialHelper,
    ];
    const foreign = path.join(setup.directory, 'foreign-original');
    copyFileSync(originalGit, foreign);
    for (const [variable, value, error] of [
      ['MERKUR_VERIFICATION_GIT', foreign, 'differs from its exact SDK member'],
      ['MERKUR_BAZEL_NATIVE_SDK_PREFIX', tools, 'ENOENT'],
      ['MERKUR_LEDGER_GIT_SHELL', foreign, 'original declared SDK bin/sh File'],
    ]) {
      if (variable === undefined || value === undefined || error === undefined)
        throw new Error('Missing carrier refusal fixture');
      const previous = process.env[variable];
      process.env[variable] = value;
      expect(() => provisionLedgerMain(argv)).toThrow(error);
      expect(existsSync(setup.options.directory)).toBe(false);
      expect(transport).toHaveLength(0);
      process.env[variable] = previous;
    }
    provisionLedgerMain(argv);
    expect(transport.some((args) => args.includes('ls-remote'))).toBe(true);
    expect(transport.some((args) => args.includes('fetch'))).toBe(true);
    expect(stdout).toHaveBeenCalledWith(`${setup.options.directory}\n`);
    Reflect.set(Bun, 'spawnSync', originalSpawn);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
    const clientGit: LedgerGit = (args, input) =>
      setup.native(setup.options.directory)(
        args[0] === 'ls-remote' || args[0] === 'fetch'
          ? args.map((argument) => (argument === 'origin' ? setup.authority : argument))
          : args,
        input,
      );
    expect(new GitRevocationStore(clientGit).read().ledger).toEqual(
      new GitRevocationStore(setup.native(setup.authority)).read().ledger,
    );
  } finally {
    Reflect.set(Bun, 'spawnSync', originalSpawn);
    stdout.mockRestore();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
    setup.close();
  }
});

test('absent and external CA bundles refuse before remote acquisition or client creation', () => {
  for (const kind of ['absent', 'external']) {
    const setup = fixture();
    try {
      const alias = path.join(setup.options.sdkPrefix, 'ssl', 'cert.pem');
      rmSync(alias);
      if (kind === 'external') symlinkSync(setup.options.credentialHelper, alias);
      expect(() => provisionLedger(setup.options)).toThrow();
      expect(existsSync(setup.options.directory)).toBe(false);
      expect(setup.commands.some((args) => args[0] === 'ls-remote')).toBe(false);
    } finally {
      setup.close();
    }
  }
});

test('CA bundle replacement refuses before remote acquisition and preserves the replacement', () => {
  const setup = fixture();
  try {
    const original = setup.options.git;
    const bundle = path.join(setup.options.sdkPrefix, 'ssl', 'cacert.pem');
    expect(() =>
      provisionLedger({
        ...setup.options,
        git: (cwd) => {
          const git = original(cwd);
          return (args, input) => {
            const result = git(args, input);
            if (args[0] === 'init') {
              renameSync(bundle, `${bundle}.held`);
              writeFileSync(bundle, 'replacement CA fixture');
            }
            return result;
          };
        },
      }),
    ).toThrow('tool identity changed');
    expect(readFileSync(bundle, 'utf8')).toBe('replacement CA fixture');
    expect(setup.commands.some((args) => args[0] === 'ls-remote')).toBe(false);
  } finally {
    setup.close();
  }
});
