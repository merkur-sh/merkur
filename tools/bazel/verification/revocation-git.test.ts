import { expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BazelVerificationEngine } from './bazel-engine';
import type { EventReport, RequiredCheck } from './events';
import {
  admitTestReservation,
  parseLedger,
  reserveTests,
  reusableNonces,
  type TestAdmissionExpectation,
  type TestReservation,
} from './revocation';
import {
  GitRevocationStore,
  type LedgerGit,
  ledgerCredentialHelperCommand,
  ledgerGitEnvironment,
  ledgerGitTransportArguments,
} from './revocation-git';

function declaredGit(directory: string): LedgerGit {
  const executable = process.env.MERKUR_VERIFICATION_GIT;
  if (executable === undefined || !path.isAbsolute(executable))
    throw new Error('Actual revocation controls require the declared native Git executable');
  return (args, input) => {
    const result = Bun.spawnSync([executable, '-c', 'core.fsmonitor=false', ...args], {
      cwd: directory,
      env: { ...process.env, ...ledgerGitEnvironment() },
      stdin: input === undefined ? 'ignore' : input,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { stdout: result.stdout.toString(), exitCode: result.signalCode ? -1 : result.exitCode };
  };
}

function fixture(): {
  directory: string;
  authority: string;
  clients: readonly GitRevocationStore[];
  readers: readonly LedgerGit[];
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'merkur-revocation-git-'));
  const git = declaredGit(directory);
  const authority = path.join(directory, 'authority.git');
  function checked(args: readonly string[]): void {
    if (git(args).exitCode !== 0) throw new Error('Cannot initialize isolated native Git fixture');
  }
  checked(['init', '--bare', authority]);
  checked(['-C', authority, 'config', 'receive.denyNonFastForwards', 'true']);
  checked(['-C', authority, 'config', 'receive.denyDeletes', 'true']);
  const readers = [0, 1].map((index) => {
    const client = path.join(directory, `client-${index}.git`);
    checked(['init', '--bare', client]);
    const read = declaredGit(client);
    if (read(['remote', 'add', 'origin', authority]).exitCode !== 0)
      throw new Error('Cannot configure isolated fixture authority');
    return read;
  });
  return {
    directory,
    authority,
    readers,
    clients: readers.map((read) => new GitRevocationStore(read)),
  };
}

function completedEvidence(reservation: TestReservation) {
  const invocation = '11111111-1111-4111-8111-111111111111';
  const configuration = 'a'.repeat(64);
  const required: RequiredCheck[] = reservation.labels.map((label) => ({
    label,
    kind: 'test',
    fresh: true,
  }));
  const events: EventReport = {
    invocation,
    buildToolVersion: '9.2.0',
    complete: true,
    exitCode: 0,
    checks: required.map((check) => ({
      ...check,
      status: 'passed',
      origin: 'executed',
      configuration,
      attempts: 1,
      durationMs: 1,
    })),
    problems: [],
  };
  const expected: TestAdmissionExpectation[] = [
    {
      platform: 'darwin-arm64',
      invocation,
      required,
      configurations: new Map(required.map((check) => [check.label, configuration])),
    },
  ];
  return { events, expected };
}

test('a persisted Git update followed by an unrelated update retains its own immutable receipt', () => {
  const setup = fixture();
  try {
    const reader = setup.readers[0];
    const other = setup.clients[1];
    if (reader === undefined || other === undefined) throw new Error('Missing native Git client');
    let raced = false;
    const first = new GitRevocationStore((args, input) => {
      const result = reader(args, input);
      if (!raced && args[0] === 'push' && result.exitCode === 0) {
        raced = true;
        reserveTests(other, ['//other:test'], true);
      }
      return result;
    });
    const own = reserveTests(first, ['//own:test'], true);
    const current = first.read();
    expect(raced).toBe(true);
    expect(own.snapshot.revision).not.toBe(current.revision);
    expect(own.snapshot.ledger['//other:test']).toBeUndefined();
    expect(own.snapshot.ledger['//own:test']).toEqual(current.ledger['//own:test']);
    expect(current.ledger['//other:test']?.state).toBe('pending');
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

test('a client transfers only a revision it does not hold', () => {
  const setup = fixture();
  try {
    const reader = setup.readers[0];
    const other = setup.clients[1];
    if (reader === undefined || other === undefined) throw new Error('Missing native Git client');
    let transfers = 0;
    const first = new GitRevocationStore((args, input) => {
      if (args[0] === 'fetch') transfers += 1;
      return reader(args, input);
    });
    // Its own push and the readback that confirms it move no objects.
    const own = reserveTests(first, ['//own:test'], true);
    expect(first.read().revision).toBe(own.snapshot.revision);
    expect(transfers).toBe(0);
    // Another client's revision is transferred once, then held.
    const foreign = reserveTests(other, ['//other:test'], true);
    expect(first.read()).toEqual(foreign.snapshot);
    expect(transfers).toBe(1);
    expect(first.read()).toEqual(foreign.snapshot);
    expect(transfers).toBe(1);
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

for (const competingLabel of ['//other:test', '//own:test']) {
  test(`Git admission checks an authoritative post-push update of ${competingLabel}`, () => {
    const setup = fixture();
    try {
      const reader = setup.readers[0];
      const other = setup.clients[1];
      if (reader === undefined || other === undefined) throw new Error('Missing native Git client');
      let intervene = false;
      let raced = false;
      const first = new GitRevocationStore((args, input) => {
        const result = reader(args, input);
        if (intervene && args[0] === 'push' && result.exitCode === 0) {
          intervene = false;
          raced = true;
          reserveTests(other, [competingLabel], true);
        }
        return result;
      });
      const reservation = reserveTests(first, ['//own:test'], true);
      const proof = completedEvidence(reservation);
      intervene = true;
      if (competingLabel === '//own:test') {
        expect(() =>
          admitTestReservation(first, reservation, proof.expected, [
            { events: proof.events, processExitCode: 0 },
          ]),
        ).toThrow();
        const epoch = first.read().ledger['//own:test'];
        expect(epoch?.state).toBe('pending');
        expect(epoch?.nonce).not.toBe(reservation.snapshot.ledger['//own:test']?.nonce);
      } else {
        const admitted = admitTestReservation(first, reservation, proof.expected, [
          { events: proof.events, processExitCode: 0 },
        ]);
        expect(admitted.ledger['//own:test']?.state).toBe('ready');
        expect(first.read().ledger['//own:test']?.state).toBe('ready');
        expect(first.read().ledger['//other:test']?.state).toBe('pending');
      }
      expect(raced).toBe(true);
    } finally {
      rmSync(setup.directory, { recursive: true, force: true });
    }
  });
}

test('two actual native Git clients reject a stale atomic update and observe the same persisted pending nonce', () => {
  const setup = fixture();
  try {
    const first = setup.clients[0];
    const second = setup.clients[1];
    if (first === undefined || second === undefined)
      throw new Error('Missing isolated ledger client');
    const label = '//fixture:test';
    const stale = second.read();
    const reservation = reserveTests(first, [label], true);
    expect(second.read()).toEqual(reservation.snapshot);
    expect(
      second.compareExchange(
        stale,
        parseLedger({ [label]: { nonce: 'a'.repeat(64), state: 'ready' } }),
      ),
    ).toBeNull();
    expect(second.read()).toEqual(reservation.snapshot);
    expect(() => reusableNonces(second.read(), [label])).toThrow();
    const retry = reserveTests(second, [label], false);
    expect(retry.snapshot.ledger[label]?.nonce).not.toBe(reservation.snapshot.ledger[label]?.nonce);
    expect(first.read()).toEqual(retry.snapshot);
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

test('uncertain Git push completion is accepted only after authoritative readback confirms persistence', () => {
  const setup = fixture();
  try {
    const reader = setup.readers[0];
    if (reader === undefined) throw new Error('Missing native Git client');
    const uncertain = new GitRevocationStore((args, input) => {
      const result = reader(args, input);
      return args[0] === 'push' && result.exitCode === 0 ? { ...result, exitCode: 1 } : result;
    });
    const reservation = reserveTests(uncertain, ['//fixture:test'], true);
    expect(uncertain.read()).toEqual(reservation.snapshot);
    expect(reservation.snapshot.ledger['//fixture:test']?.state).toBe('pending');
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

test('unavailable shared authority refuses reuse rather than using a cached local ledger', () => {
  const setup = fixture();
  try {
    const first = setup.clients[0];
    if (first === undefined) throw new Error('Missing native Git client');
    reserveTests(first, ['//fixture:test'], true);
    rmSync(setup.authority, { recursive: true });
    expect(() => first.read()).toThrow('authoritative');
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

test('protected native Git authority rejects ledger rollback and deletion', () => {
  const setup = fixture();
  try {
    const first = setup.clients[0];
    const reader = setup.readers[0];
    if (first === undefined || reader === undefined) throw new Error('Missing native Git client');
    const initial = reserveTests(first, ['//fixture:test'], true);
    const latest = reserveTests(first, ['//fixture:test'], true);
    const ref = 'refs/heads/merkur-verification-revocations';
    expect(
      reader(['push', '--force', 'origin', `${initial.snapshot.revision}:${ref}`]).exitCode,
    ).not.toBe(0);
    expect(reader(['push', 'origin', `:${ref}`]).exitCode).not.toBe(0);
    expect(first.read()).toEqual(latest.snapshot);
  } finally {
    rmSync(setup.directory, { recursive: true, force: true });
  }
});

test('protected transport pins exact HTTPS verification and bypasses mutable remote URL lists', () => {
  const origin = 'https://ledger.example.invalid/verification.git';
  const prefix = [
    '-c',
    'http.sslBackend=openssl',
    '-c',
    `http.${origin}.sslVerify=true`,
    '-c',
    `http.${origin}.followRedirects=false`,
  ];
  for (const args of [
    ['ls-remote', '--exit-code', 'origin', 'refs/heads/ledger'],
    ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', 'refs/heads/ledger'],
    [
      'push',
      '--porcelain',
      '--force-with-lease=refs/heads/ledger:',
      'origin',
      'a:refs/heads/ledger',
    ],
  ]) {
    const invocation = ledgerGitTransportArguments(origin, args);
    expect(invocation).toEqual([
      ...prefix,
      ...args.map((argument) => (argument === 'origin' ? origin : argument)),
    ]);
    expect(invocation).not.toContain('origin');
    expect(Object.isFrozen(invocation)).toBe(true);
  }
  expect(ledgerGitTransportArguments(origin, ['remote', 'get-url', 'origin'])).toEqual([
    ...prefix,
    'remote',
    'get-url',
    'origin',
  ]);
  expect(() =>
    ledgerGitTransportArguments('http://ledger.example.invalid/a', ['ls-remote', 'origin']),
  ).toThrow('canonical HTTPS');
});

function isolatedLedgerFixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'merkur-isolated-ledger-')));
  const client = path.join(root, 'provisioned.git');
  const foreign = path.join(root, 'foreign.git');
  const source = path.join(root, 'source');
  const directory = path.join(root, 'engine');
  mkdirSync(source);
  mkdirSync(directory);
  const native = declaredGit(root);
  function checked(args: readonly string[]): string {
    const result = native(args);
    if (result.exitCode !== 0) throw new Error('Cannot initialize native isolated-ledger control');
    return result.stdout;
  }
  checked(['init', '--bare', '--template=', client]);
  checked(['init', '--bare', '--template=', foreign]);
  const origin = 'https://ledger.example.invalid/verification.git';
  const helper = path.join(root, 'declared helper');
  copyFileSync(process.execPath, helper);
  chmodSync(helper, 0o700);
  checked(['-C', client, 'remote', 'add', 'origin', origin]);
  checked(['-C', client, 'config', '--add', 'credential.helper', '']);
  checked([
    '-C',
    client,
    'config',
    '--add',
    'credential.helper',
    ledgerCredentialHelperCommand(helper),
  ]);
  const sdkEnvironment: Record<string, string> = {};
  for (const key of [
    'DYLD_LIBRARY_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH',
    'GIT_EXEC_PATH',
    'GIT_TEMPLATE_DIR',
    'OPENSSL_CONF',
    'OPENSSL_MODULES',
    'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
  ]) {
    const value = process.env[key];
    if (value !== undefined) sdkEnvironment[key] = value;
  }
  const executable = process.env.MERKUR_VERIFICATION_GIT;
  if (executable === undefined)
    throw new Error('Isolated ledger controls require declared native Git');
  const engine = new BazelVerificationEngine({
    signal: new AbortController().signal,
    root: source,
    directory,
    admittedUntracked: [],
    all: false,
    tools: {
      bazel: '/unexecuted/bazel',
      acquisition: '/unread/acquisition.json',
      git: executable,
      credentialHelper: '/unexecuted/buildbuddy-helper',
      credentialFile: '/unread/buildbuddy-key',
      runfiles: root,
      sdkEnvironment,
    },
  });
  return {
    root,
    client,
    foreign,
    directory,
    origin,
    helper,
    engine,
    checked,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('the production ledger adapter isolates captured config before caller URL rewrites', () => {
  const setup = isolatedLedgerFixture();
  try {
    const config = path.join(setup.client, 'config');
    const original = readFileSync(config);
    const store = setup.engine.ledgerStore(setup.client);
    expect(readFileSync(config)).toEqual(original);
    expect(() => store.read()).toThrow('authoritative revocation ref');
    setup.checked([
      '-C',
      setup.client,
      'config',
      `url.file://${setup.foreign}.insteadOf`,
      setup.origin,
    ]);
    expect(() => store.read()).toThrow('authoritative revocation ref');
    // This genuine native negative uses a reserved invalid host, never credential or service data.
  } finally {
    setup.close();
  }
});

test('the production ledger adapter refuses file and HTTPS rewrites present during capture', () => {
  for (const rewritten of ['file:///foreign.git', 'https://foreign.example.invalid/foreign.git']) {
    const setup = isolatedLedgerFixture();
    try {
      setup.checked(['-C', setup.client, 'config', `url.${rewritten}.insteadOf`, setup.origin]);
      expect(() => setup.engine.ledgerStore(setup.client)).toThrow('undeclared configuration');
    } finally {
      setup.close();
    }
  }
});

test('the production ledger adapter preserves captured SHA-256 object format without caller metadata', () => {
  const setup = isolatedLedgerFixture();
  try {
    setup.checked(['-C', setup.client, 'config', 'core.repositoryFormatVersion', '1']);
    setup.checked(['-C', setup.client, 'config', 'extensions.objectFormat', 'sha256']);
    const original = readFileSync(path.join(setup.client, 'config'));
    setup.engine.ledgerStore(setup.client);
    expect(readFileSync(path.join(setup.client, 'config'))).toEqual(original);
    const clients = readdirSync(setup.directory).filter((name) =>
      name.startsWith('ledger-client-'),
    );
    expect(clients).toHaveLength(1);
    const privateClient = clients[0];
    if (privateClient === undefined) throw new Error('Missing owned private ledger client');
    expect(
      setup.checked([
        '-C',
        path.join(setup.directory, privateClient),
        'rev-parse',
        '--show-object-format',
      ]),
    ).toBe('sha256\n');
  } finally {
    setup.close();
  }
});

test('the production ledger adapter refuses includes, proxies, headers and arbitrary helpers', () => {
  for (const [key, value] of [
    ['include.path', '/never-read/foreign-ledger-config'],
    ['http.proxy', 'https://foreign.example.invalid/proxy'],
    ['http.extraHeader', 'test-only injected-header'],
    ['credential.helper', '!printf test-only-arbitrary-command'],
  ]) {
    const setup = isolatedLedgerFixture();
    try {
      if (key === undefined || value === undefined)
        throw new Error('Missing hostile config fixture');
      setup.checked(['-C', setup.client, 'config', '--add', key, value]);
      expect(() => setup.engine.ledgerStore(setup.client)).toThrow();
      expect(readdirSync(setup.directory).some((name) => name.startsWith('ledger-client-'))).toBe(
        false,
      );
    } finally {
      setup.close();
    }
  }
});
