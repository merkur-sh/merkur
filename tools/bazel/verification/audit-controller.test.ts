import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BazelVerificationEngine } from './bazel-engine';
import { verifyReservedBatch } from './controller';
import { DeclaredEngineProcess } from './engine-process';
import type { EnginePlan } from './front-end';
import { captureGitContext } from './git-context';
import { type LedgerSnapshot, parseLedger, type RevocationStore } from './revocation';
import { manifestFromInventory } from './snapshot';

// Genuine controller/adapter methods with synthetic command I/O and ordinary
// Files. No native audit, authenticated ledger, or admitted report is fabricated.
const label = '//tools/bazel/verification:dependency_audit';
const head = 'a'.repeat(40);
const oldNonce = '1'.repeat(64);
const inputs = ['.bazelversion', 'BUILD.bazel', 'MODULE.bazel', 'input.ts'];
const required = [{ label, kind: 'test' as const, fresh: true }];
const plan: EnginePlan = {
  coverage: {
    files: [],
    docsOnly: false,
    required,
    deferred: [],
    pendingDeferred: [],
    reasons: [],
    staticOperations: [],
  },
  actionSources: inputs,
  analysisSources: inputs,
  contextDigest: 'b'.repeat(64),
  pendingQualifications: ['Explicit synthetic command-I/O control'],
};

function fixture() {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'audit controller boundary ')));
  const root = path.join(parent, 'source');
  const directory = path.join(parent, 'private');
  const sdk = path.join(parent, 'sdk');
  mkdirSync(root);
  mkdirSync(directory);
  mkdirSync(path.join(sdk, 'ssl'), { recursive: true });
  writeFileSync(path.join(sdk, 'ssl/cert.pem'), 'unexecuted constructor trust fixture');
  for (const input of inputs) writeFileSync(path.join(root, input), 'original source fixture');
  const abort = new AbortController();
  const tools = {
    bazel: path.join(parent, 'unexecuted-bazel'),
    acquisition: path.join(parent, 'unread-acquisition'),
    git: path.join(parent, 'unexecuted-git'),
    credentialHelper: path.join(parent, 'unexecuted-helper'),
    credentialFile: path.join(parent, 'unread-auth-file'),
    runfiles: parent,
    sdkEnvironment: { MERKUR_BAZEL_NATIVE_SDK_PREFIX: sdk },
  };
  const engine = new BazelVerificationEngine({
    root,
    directory,
    tools,
    signal: abort.signal,
    admittedUntracked: [],
    all: false,
  });
  const process = Reflect.get(engine, 'process') as DeclaredEngineProcess;
  const git = captureGitContext(
    (args) => {
      if (args[0] === 'rev-parse') return `${head}\n`;
      if (args.includes('-v')) return inputs.map((name) => `H ${name}\0`).join('');
      if (args.includes('--stage'))
        return inputs.map((name) => `100644 ${head} 0\t${name}\0`).join('');
      return '';
    },
    head,
    head,
  );
  Reflect.set(engine, 'source', manifestFromInventory(root, inputs, head));
  Reflect.set(engine, 'candidate', head);
  Object.defineProperty(engine, 'readGit', { value: async () => git });
  Object.defineProperty(engine, 'completeTestInventory', { value: async () => [label] });
  const calls: string[] = [];
  let capture: (args: readonly string[]) => Promise<{ stdout: string; exitCode: number | null }> =
    async () => ({ stdout: '', exitCode: 1 });
  Object.defineProperty(process, 'run', {
    value: async (_root: string, command: string, args: readonly string[]) => {
      calls.push(command);
      expect(command).toBe('run');
      expect(args[0]).toBe('//tools/bazel/verification:dependency_audit_capture');
      return capture(args);
    },
  });
  const acquire = Reflect.get(engine, 'acquireAudit');
  if (typeof acquire !== 'function') throw new Error('Original acquisition method required');
  Object.defineProperty(engine, 'plan', {
    value: async (selectedRoot: string, _git: unknown, acquireFreshAudit = true) => {
      if (acquireFreshAudit) await Reflect.apply(acquire, engine, [selectedRoot]);
      return plan;
    },
  });
  let current: LedgerSnapshot = {
    revision: 'original-ready',
    ledger: parseLedger({ [label]: { nonce: oldNonce, state: 'ready' } }),
  };
  let revision = 0;
  const store: RevocationStore = {
    read: () => current,
    compareExchange(previous, ledger) {
      if (previous !== current) return null;
      current = { revision: String(++revision), ledger: parseLedger(ledger) };
      return current;
    },
  };
  let published = false;
  const controller = () =>
    verifyReservedBatch({
      signal: abort.signal,
      store,
      force: true,
      attempts: [
        {
          engine,
          options: {
            root,
            destination: path.join(parent, 'frozen'),
            admittedUntracked: [],
          },
        },
      ],
      expectationOutputs: [],
      retainReports: () => {},
      publishAdmission: () => {
        published = true;
      },
    });
  return {
    parent,
    root,
    engine,
    process,
    abort,
    store,
    calls,
    acquire: () => Reflect.apply(acquire, engine, [root]),
    capture(value: typeof capture) {
      capture = value;
    },
    controller,
    published: () => published,
    close: () => rmSync(parent, { recursive: true, force: true }),
  };
}

test('initial selection uses the refusing default pair without acquiring before forced reservation', async () => {
  const f = fixture();
  try {
    expect(await f.engine.selectedChecks()).toEqual(required);
    expect(f.calls).toEqual([]);
    expect(f.store.read().ledger[label]?.nonce).toBe(oldNonce);
  } finally {
    f.close();
  }
});

for (const cancelled of [false, true])
  test(`fresh audit ${cancelled ? 'cancellation' : 'failure'} retires the old ready pass before publication`, async () => {
    const f = fixture();
    let reservedNonce = '';
    try {
      f.capture(async (args) => {
        const epoch = f.store.read().ledger[label];
        expect(epoch?.state).toBe('pending');
        expect(epoch?.nonce).not.toBe(oldNonce);
        reservedNonce = epoch?.nonce ?? '';
        const requestPath = args[args.indexOf('--request') + 1];
        if (!requestPath) throw new Error('Original capture request required');
        const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
          nonces: [string, string][];
        };
        expect(request.nonces).toEqual([[label, reservedNonce]]);
        if (cancelled) {
          f.abort.abort(new Error('audit acquisition cancelled'));
          throw f.abort.signal.reason;
        }
        return { stdout: '', exitCode: 17 };
      });
      await expect(f.controller()).rejects.toThrow(
        cancelled ? 'audit acquisition cancelled' : 'Fresh dependency audit failed',
      );
      expect(f.calls).toEqual(['run']);
      expect(f.published()).toBe(false);
      expect(f.store.read().ledger[label]?.state).toBe('pending');
      expect(f.store.read().ledger[label]?.nonce).not.toBe(oldNonce);
      expect(f.store.read().ledger[label]?.nonce).not.toBe(reservedNonce);
    } finally {
      f.close();
    }
  });

test('fresh capture refuses changed request bytes before binding any audit repository', async () => {
  const f = fixture();
  try {
    f.engine.bindTestReservation({ labels: [label], fresh: [label], snapshot: f.store.read() });
    f.capture(async (args) => {
      const request = args[args.indexOf('--request') + 1];
      if (!request) throw new Error('Original request required');
      writeFileSync(request, 'substituted request');
      return { stdout: '', exitCode: 0 };
    });
    await expect(f.acquire()).rejects.toThrow('request changed');
    expect(Reflect.get(f.engine, 'audit')).toBeUndefined();
  } finally {
    f.close();
  }
});

test('fresh capture refuses a snapshot for another request before binding it', async () => {
  const f = fixture();
  try {
    f.engine.bindTestReservation({ labels: [label], fresh: [label], snapshot: f.store.read() });
    f.capture(async (args) => {
      const snapshot = args[args.indexOf('--snapshot') + 1];
      if (!snapshot) throw new Error('Original snapshot required');
      writeFileSync(snapshot, JSON.stringify({ request: 'f'.repeat(64) }));
      return { stdout: '', exitCode: 0 };
    });
    await expect(f.acquire()).rejects.toThrow('another acquisition request');
    expect(Reflect.get(f.engine, 'audit')).toBeUndefined();
  } finally {
    f.close();
  }
});

test('original commands refuse unbound, missing, duplicate, foreign and split audit overrides before engine identity', async () => {
  const f = fixture();
  const commandRoot = path.join(f.parent, 'command-engine');
  mkdirSync(commandRoot);
  const command = new DeclaredEngineProcess(f.process.tools, commandRoot, f.abort.signal);
  const auditRoot = path.join(f.parent, 'audit');
  mkdirSync(auditRoot);
  for (const member of ['BUILD.bazel', 'REPO.bazel', 'request', 'snapshot'])
    writeFileSync(path.join(auditRoot, member), member);
  const bound = `--override_repository=verification_audit=${auditRoot}`;
  try {
    for (const operation of ['test', 'build', 'run', 'cquery', 'aquery', 'query', 'info']) {
      await expect(command.run(f.root, operation, [bound])).rejects.toThrow(
        'bound fresh audit repository',
      );
    }
    command.bindAudit(
      manifestFromInventory(auditRoot, ['BUILD.bazel', 'REPO.bazel', 'request', 'snapshot'], head),
    );
    for (const operation of ['test', 'build', 'run', 'cquery', 'aquery', 'query', 'info']) {
      for (const flags of [
        [],
        [bound, bound],
        ['--override_repository=verification_audit=/foreign'],
        ['--override_repository', `verification_audit=${auditRoot}`],
      ]) {
        await expect(command.run(f.root, operation, flags)).rejects.toThrow(
          'bound fresh audit repository',
        );
      }
      await expect(command.run(f.root, operation, [bound])).rejects.toThrow(
        'validated declared engine identity',
      );
    }
    await expect(command.run(f.root, '--version', [])).rejects.toThrow(
      'validated declared engine identity',
    );
    await expect(
      command.run(f.root, 'mod', ['dump_repo_mapping', '', '--enable_bzlmod']),
    ).rejects.toThrow('validated declared engine identity');
  } finally {
    await command.close();
    f.close();
  }
});

test('captured snapshot bytes cannot be replaced while the original repository declaration is written', async () => {
  const f = fixture();
  let snapshot = '';
  let captured = '';
  let substituted = false;
  const originalWrite = fs.writeFileSync;
  const write = spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, options) => {
    if (typeof file === 'string' && path.basename(file) === 'BUILD.bazel' && snapshot !== '') {
      originalWrite(snapshot, `${captured}\n`);
      substituted = true;
    }
    return originalWrite(file, bytes, options);
  });
  try {
    f.engine.bindTestReservation({ labels: [label], fresh: [label], snapshot: f.store.read() });
    f.capture(async (args) => {
      const request = args[args.indexOf('--request') + 1];
      const output = args[args.indexOf('--snapshot') + 1];
      if (!request || !output) throw new Error('Original capture File transport required');
      snapshot = output;
      // Deliberately incomplete snapshot fixture tests only byte custody.
      // Its synthetic process return does not establish any native verdict.
      captured = JSON.stringify({
        request: createHash('sha256').update(readFileSync(request)).digest('hex'),
      });
      originalWrite(snapshot, captured);
      return { stdout: '', exitCode: 0 };
    });
    await expect(f.acquire()).rejects.toThrow();
    expect(substituted).toBe(true);
    expect(Reflect.get(f.engine, 'audit')).toBeUndefined();
  } finally {
    write.mockRestore();
    f.close();
  }
});

test('audit binding refuses changed bytes, extra members and authored source aliases', async () => {
  const f = fixture();
  const auditRoot = path.join(f.parent, 'bound-audit');
  mkdirSync(auditRoot);
  const commandRoot = path.join(f.parent, 'bound-process');
  mkdirSync(commandRoot);
  const command = new DeclaredEngineProcess(f.process.tools, commandRoot, f.abort.signal);
  const names = ['BUILD.bazel', 'REPO.bazel', 'request', 'snapshot'];
  for (const name of names) writeFileSync(path.join(auditRoot, name), name);
  const manifest = manifestFromInventory(auditRoot, names, head);
  try {
    command.bindAudit(manifest);
    writeFileSync(path.join(auditRoot, 'snapshot'), 'changed snapshot');
    expect(() => command.bindAudit(manifest)).toThrow('captured origin');
    writeFileSync(path.join(auditRoot, 'snapshot'), 'snapshot');
    writeFileSync(path.join(auditRoot, 'foreign'), 'foreign member');
    expect(() => command.bindAudit(manifest)).toThrow('File inventory changed');
    rmSync(path.join(auditRoot, 'foreign'));
    rmSync(path.join(auditRoot, 'snapshot'));
    symlinkSync('request', path.join(auditRoot, 'snapshot'));
    expect(() => command.bindAudit(manifestFromInventory(auditRoot, names, head))).toThrow(
      'regular File manifest',
    );
  } finally {
    await command.close();
    f.close();
  }
});
