import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { SECRET_SCAN_ARGUMENTS } from '../../../scripts/secret-scanning';
import pin from '../../../scripts/trufflehog.json';
import { captureGitContext } from './git-context';
import { manifestFromInventory } from './snapshot';
import {
  declaredStagedRatchet,
  declaredStagedSecretScan,
  type StagedGateInputs,
} from './staged-gates';

function fixture(
  run: (options: StagedGateInputs, scanner: string, directory: string) => void,
  fault: 'clean' | 'complexity' | 'secret' | 'encrypted-key' = 'clean',
): void {
  const git = process.env.MERKUR_VERIFICATION_GIT;
  const scratch = process.env.TEST_TMPDIR;
  if (git === undefined || !path.isAbsolute(git) || scratch === undefined)
    throw new Error('Staged controls require declared Git and private test scratch');
  const directory = mkdtempSync(path.join(scratch, 'staged-controls-'));
  const live = path.join(directory, 'live');
  const index = path.join(directory, 'index');
  for (const root of [live, index]) mkdirSync(root);
  const sdkEnvironment = Object.fromEntries(
    [
      'DYLD_LIBRARY_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'OPENSSL_CONF',
      'OPENSSL_MODULES',
      'MERKUR_BAZEL_NATIVE_SDK_PREFIX',
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key] ?? '']])),
  );
  const environment = {
    ...sdkEnvironment,
    HOME: directory,
    PATH: path.dirname(git),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    LC_ALL: 'C',
  };
  const read = (args: readonly string[], stdin?: Uint8Array): Buffer => {
    const result = Bun.spawnSync([git, ...args], {
      cwd: live,
      env: environment,
      stdin: stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0 || result.signalCode) throw new Error(result.stderr.toString());
    return Buffer.from(result.stdout);
  };
  const initial = new Map<string, string>([
    ['package.json', '{"name":"staged-fixture","private":true}'],
    [
      '.fallowrc.json',
      JSON.stringify({
        entry: ['entry.ts'],
        includeEntryExports: true,
        health: { maxCyclomatic: 3, maxCognitive: 3 },
      }),
    ],
    [
      '.fallowrc.semantic.json',
      '{"extends":["./.fallowrc.json"],"duplicates":{"mode":"semantic"}}',
    ],
    ['fallow-baselines/complexity-ceilings.json', '{}'],
    ['entry.ts', 'function value() { return 1; }\nprocess.stdout.write(String(value()));\n'],
    ['deleted.txt', 'deleted index bytes'],
  ]);
  try {
    read(['init', '--template=']);
    for (const [name, bytes] of initial)
      for (const root of [live, index]) {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        writeFileSync(path.join(root, name), bytes);
        chmodSync(path.join(root, name), 0o644);
      }
    read(['add', '--all']);
    read(['commit', '-m', 'base']);
    const head = read(['rev-parse', 'HEAD']).toString().trim();
    const entry =
      fault === 'complexity'
        ? `function value(n: number) {\n${Array.from({ length: 8 }, (_, i) => `if (n === ${i}) return ${i};`).join('\n')}\nreturn 9;\n}\nprocess.stdout.write(String(value(3)));\n`
        : 'function value() { return 2; }\nprocess.stdout.write(String(value()));\n';
    const changed = new Map<string, Uint8Array>([
      ['entry.ts', Buffer.from(entry)],
      ['nested/space tab\tnewline\n雪.txt', Buffer.from([0, 255, 1, 10, 128])],
      ['-leading-dash', Buffer.from('staged ordinary bytes')],
    ]);
    if (fault === 'secret') changed.set('secret.txt', Buffer.from('STAGED_TEST_SECRET'));
    if (fault === 'encrypted-key') {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: {
          type: 'pkcs1',
          format: 'pem',
          cipher: 'aes-256-cbc',
          passphrase: randomBytes(32).toString('hex'),
        },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });
      changed.set('ephemeral-encrypted-key.pem', Buffer.from(privateKey));
    }

    for (const [name, bytes] of changed)
      for (const root of [live, index]) {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        writeFileSync(path.join(root, name), bytes);
        chmodSync(path.join(root, name), 0o644);
      }
    for (const root of [live, index]) {
      rmSync(path.join(root, 'deleted.txt'));
      symlinkSync('STAGED_LINK_TEXT', path.join(root, 'symbolic.txt'));
    }
    read(['add', '--all']);
    const context = captureGitContext((args) => read(args).toString(), head, head);
    const source = manifestFromInventory(
      index,
      context.index.map((entry) => entry.path),
      head,
    );
    const objects = read(['rev-list', '--objects', '--no-object-names', head])
      .toString()
      .trim()
      .split('\n');
    const packed = read(
      ['pack-objects', '--stdout'],
      Buffer.from(
        `${[...new Set([...objects, ...context.index.map((entry) => entry.object)])].join('\n')}\n`,
      ),
    );
    const pack = path.join(directory, 'objects.pack');
    writeFileSync(pack, packed);
    // Neither adapter can read the original checkout, its dirty bytes or its .git.
    writeFileSync(path.join(live, 'entry.ts'), 'unstaged hidden change');
    rmSync(path.join(live, '.git'), { recursive: true });
    const scanner = path.join(directory, 'scanner');
    writeFileSync(
      scanner,
      `#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('trufflehog ${pin.version}\\n');process.exit(0);}\nconst files={};for(const name of new Bun.Glob('**/*').scanSync({dot:true})){files[name]=Buffer.from(await Bun.file(name).arrayBuffer()).toString('base64');}\nawait Bun.write(import.meta.dir+'/capture.json',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),files}));\nprocess.exit(Object.values(files).some(bytes=>Buffer.from(bytes,'base64').toString().includes('STAGED_TEST_SECRET'))?183:0);\n`,
      { mode: 0o700 },
    );
    run(
      {
        index: { root: index, manifest: source },
        context,
        scratch: directory,
        git,
        pack,
        objects: {
          contextDigest: context.digest,
          packDigest: createHash('sha256').update(packed).digest('hex'),
          packBytes: packed.length,
          shallow: [],
        },
        sdkEnvironment,
      },
      scanner,
      directory,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Scanner stand-ins only inspect carrier bytes/arguments. They do not qualify detection or hosted execution.
test('staged secret carrier scans exact index blobs, binary/unusual paths and symlink text', () => {
  fixture((options, scanner, directory) => {
    expect(declaredStagedSecretScan({ ...options, scanner })).toBe(0);
    const captured = JSON.parse(readFileSync(path.join(directory, 'capture.json'), 'utf8'));
    expect(captured.args).toEqual(SECRET_SCAN_ARGUMENTS);
    expect(captured.files).toEqual({
      'entry.ts': Buffer.from(
        'function value() { return 2; }\nprocess.stdout.write(String(value()));\n',
      ).toString('base64'),
      'nested/space tab\tnewline\n雪.txt': Buffer.from([0, 255, 1, 10, 128]).toString('base64'),
      '-leading-dash': Buffer.from('staged ordinary bytes').toString('base64'),
      'symbolic.txt': Buffer.from('STAGED_LINK_TEXT').toString('base64'),
    });
    expect(() => lstatSync(captured.cwd)).toThrow('ENOENT');
    expect(() => readFileSync(path.join(options.index.root, '.git'))).toThrow();
  });
});

test('staged secret failure cannot be hidden by an unavailable original checkout', () => {
  fixture(
    (options, scanner) => expect(declaredStagedSecretScan({ ...options, scanner })).toBe(183),
    'secret',
  );
});

test('foreign current source and object closure refuse before scanning', () => {
  for (const fault of ['index', 'objects'])
    fixture((options, scanner, directory) => {
      if (fault === 'index')
        writeFileSync(path.join(options.index.root, 'entry.ts'), 'foreign index');
      const altered =
        fault === 'objects'
          ? { ...options, objects: { ...options.objects, packDigest: 'f'.repeat(64) } }
          : options;
      expect(() => declaredStagedSecretScan({ ...altered, scanner })).toThrow();
      expect(() => readFileSync(path.join(directory, 'capture.json'))).toThrow();
    });
});

test('real pinned native scanner passes a benign complete staged blob carrier', () => {
  const scanner = process.env.MERKUR_VERIFICATION_TRUFFLEHOG;
  if (scanner === undefined || !path.isAbsolute(scanner))
    throw new Error('Actual pinned TruffleHog required');
  fixture((options) => expect(declaredStagedSecretScan({ ...options, scanner })).toBe(0));
}, 60_000);

test('actual native Fallow preserves exact staged audits and rejects introduced complexity', () => {
  const fallow = process.env.MERKUR_VERIFICATION_FALLOW;
  const runfiles = process.env.TEST_SRCDIR;
  if (fallow === undefined || !path.isAbsolute(fallow) || runfiles === undefined)
    throw new Error('Actual declared Fallow and engine runfiles required');
  for (const fault of ['clean', 'complexity'] as const)
    fixture((options) => {
      expect(declaredStagedRatchet({ ...options, fallow, runfiles })).toBe(
        fault === 'clean' ? 0 : 1,
      );
    }, fault);
}, 180_000);

test('staged executable consumes declared Files and leaves no private export after failure', () => {
  fixture((options, scanner, directory) => {
    const configuration = process.env.MERKUR_BUN_TEST_CONFIG;
    const runfiles = process.env.TEST_SRCDIR;
    if (configuration === undefined || runfiles === undefined)
      throw new Error('Declared Bun config/runfiles required');
    const files = {
      index_manifest: options.index.manifest,
      context: options.context,
      objects: options.objects,
    };
    for (const [name, value] of Object.entries(files))
      writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value));
    writeFileSync(
      path.join(directory, 'inputs.json'),
      JSON.stringify({
        index_tree: 'index',
        index_manifest: 'index_manifest.json',
        context: 'context.json',
        objects: 'objects.json',
        object_pack: 'objects.pack',
        projections: null,
      }),
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        `--config=${configuration}`,
        path.resolve(import.meta.dir, 'staged-gates.ts'),
        'secrets',
        'inputs.json',
      ],
      {
        cwd: directory,
        env: {
          ...options.sdkEnvironment,
          HOME: directory,
          PATH: path.dirname(options.git),
          TEST_TMPDIR: directory,
          TEST_SRCDIR: runfiles,
          MERKUR_VERIFICATION_GIT: options.git,
          MERKUR_VERIFICATION_TRUFFLEHOG: scanner,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.signalCode).toBeFalsy();
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(183);
    const captured = JSON.parse(readFileSync(path.join(directory, 'capture.json'), 'utf8'));
    expect(captured.files['secret.txt']).toBe(Buffer.from('STAGED_TEST_SECRET').toString('base64'));
    expect(() => lstatSync(captured.cwd)).toThrow('ENOENT');
  }, 'secret');
});

// An uncrackable encrypted key yields the pinned detector's unknown result category.
// The fixture is ephemeral and never authenticates to any external account.
test('actual pinned scanner rejects an unknown encrypted key under unchanged ordinary flags', () => {
  const scanner = process.env.MERKUR_VERIFICATION_TRUFFLEHOG;
  if (scanner === undefined || !path.isAbsolute(scanner))
    throw new Error('Actual pinned TruffleHog required');
  fixture(
    (options) => expect(declaredStagedSecretScan({ ...options, scanner })).toBe(183),
    'encrypted-key',
  );
}, 60_000);
