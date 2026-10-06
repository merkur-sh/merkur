import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { moduleRequests } from './module-requests';

test('shadowed imported APIs remain unresolved instead of inventing their file inputs', () => {
  const source = `
    import { mock } from 'bun:test';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    function replacement(mock, { readFile }) {
      mock.module('./invented-module', factory);
      readFile('./invented-file');
    }
    function fixture(path) {
      readFile(path.join(import.meta.dir, 'invented.json'));
    }
  `;
  expect(moduleRequests('fixture.test.ts', source)).toEqual({
    requests: ['bun:test', 'node:fs/promises', 'node:path'],
    relativeFiles: [],
    programFiles: [],
    computedImports: 1,
    computedFiles: 2,
  });
});

test('declares mock module originals through the Bun test import binding', () => {
  const source = `
    import { mock as registry } from 'bun:test';
    import * as testApi from 'bun:test';
    registry.module('./replacement', () => ({}));
    testApi.mock.module('@merkur/shared', () => ({}));
    registry.module(computed, () => ({}));
    const unrelated = { module() {} };
    unrelated.module('./not-a-module');
  `;
  expect(moduleRequests('fixture.test.ts', source)).toEqual({
    requests: ['./replacement', '@merkur/shared', 'bun:test'],
    relativeFiles: [],
    programFiles: [],
    computedImports: 1,
    computedFiles: 0,
  });
});

test('declares source-relative assets read by Bun and imported filesystem aliases', () => {
  const source = `
    import filesystem from 'node:fs';
    import { readFileSync as read, promises as files } from 'node:fs';
    import { readFile as readAsync } from 'node:fs/promises';
    import path from 'node:path';
    import { join as combine, resolve } from 'node:path';
    Bun.file(\`\${import.meta.dir}/fixtures/raw.bin\`);
    read(path.join(import.meta.dir, 'fixtures', 'read.json'));
    readAsync(combine(import.meta.dir, '..', 'asset.txt'));
    filesystem.readFile(resolve(import.meta.dir, 'fixtures', 'async.json'), callback);
    files.readFile('root-relative.json');
    read(new URL('./url.json', import.meta.url));
    Bun.file(dynamic);
    read(path.join(import.meta.dir, computed));
    read('/absolute/ambient');
  `;
  expect(moduleRequests('fixture.test.ts', source)).toEqual({
    requests: ['node:fs', 'node:fs/promises', 'node:path'],
    relativeFiles: [
      '../asset.txt',
      './fixtures/raw.bin',
      './url.json',
      'fixtures/async.json',
      'fixtures/read.json',
    ],
    programFiles: ['root-relative.json'],
    computedImports: 0,
    computedFiles: 3,
  });
});

test('preserves type imports, reexports, import types, CommonJS, and literal dynamic imports', () => {
  const source = `
    import type { Shape } from './types';
    export type { Other } from './reexports';
    export * from './namespace';
    type Deferred = import('./import-type').Deferred;
    import common = require('./import-equals');
    const required = require('./commonjs');
    const dynamic = import('./dynamic');
  `;
  expect(moduleRequests('fixture.ts', source)).toEqual({
    requests: [
      './commonjs',
      './dynamic',
      './import-equals',
      './import-type',
      './namespace',
      './reexports',
      './types',
    ],
    relativeFiles: [],
    programFiles: [],
    computedImports: 0,
    computedFiles: 0,
  });
});

test('reports computed imports without inventing their dependencies', () => {
  expect(
    moduleRequests('fixture.ts', 'const input = import(name); const value = require(name);'),
  ).toEqual({
    requests: [],
    relativeFiles: [],
    programFiles: [],
    computedImports: 2,
    computedFiles: 0,
  });
});

test('ignores import text in comments and strings and rejects malformed source', () => {
  expect(
    moduleRequests('fixture.ts', `// import './phantom';\nconst text = "import './fake'";`)
      .requests,
  ).toEqual([]);
  expect(() => moduleRequests('fixture.ts', 'import {')).toThrow();
});

test('declares literal Worker/source URLs and spawned Bun program inputs from AST nodes', () => {
  const source = `
    const worker = new Worker(new URL('./worker.ts', import.meta.url));
    const fixture = new URL('../native/src/lib.rs', import.meta.url);
    const irrelevant = new URL('./remote', 'https://example.com');
    Bun.spawn(['bun', 'run', 'scripts/benchmark.ts']);
    Bun.spawnSync(['bun', 'run', 'scripts/other.ts']);
    Bun.spawn(['bun', 'run', computed]);
  `;
  expect(moduleRequests('fixture.ts', source)).toEqual({
    requests: [],
    relativeFiles: ['../native/src/lib.rs', './worker.ts'],
    programFiles: ['scripts/benchmark.ts', 'scripts/other.ts'],
    computedImports: 0,
    computedFiles: 0,
  });
});
test('declares global URL, import.meta resolution and exact pinned-runtime source templates', () => {
  const source =
    "const fixture = new globalThis.URL('./vector.json', import.meta.url); " +
    "const packagePath = import.meta.resolve('elysia'); " +
    'Bun.spawnSync([process.execPath, `${import.meta.dir}/benchmark.ts`]);';
  expect(moduleRequests('fixture.ts', source)).toEqual({
    requests: ['elysia'],
    relativeFiles: ['./benchmark.ts', './vector.json'],
    programFiles: [],
    computedImports: 0,
    computedFiles: 0,
  });
});

test('declares the program a test runs through the awaited test process', () => {
  const source =
    "import { runTestProcess } from '../scripts/test-process'; " +
    "import { runTestProcess as other } from './elsewhere'; " +
    "await runTestProcess(['bun', 'run', 'scripts/benchmark.ts'], { cwd: ROOT }); " +
    'await runTestProcess([process.execPath, `${import.meta.dir}/beside.ts`]); ' +
    "await other(['bun', 'run', 'scripts/unrelated.ts']);";

  expect(moduleRequests('fixture.ts', source)).toEqual({
    requests: ['../scripts/test-process', './elsewhere'],
    relativeFiles: ['./beside.ts'],
    programFiles: ['scripts/benchmark.ts'],
    computedImports: 0,
    computedFiles: 0,
  });
});

const executableSource = readFileSync(
  new URL('../../../scripts/test-executables.ts', import.meta.url),
  'utf8',
);
const executableOutputs = [
  { environment: 'MERKUR_BAZEL_SCRATCH_ROOT', directory: 'test-executables' },
] as const;

function changedExecutable(original: string, replacement: string): string {
  expect(executableSource.split(original)).toHaveLength(2);
  return executableSource.replace(original, replacement);
}

test('classifies the genuine helper read through its scratch-root hash/write/rename/private-call relation', () => {
  expect(moduleRequests('scripts/test-executables.ts', executableSource).computedFiles).toBe(1);
  const selected = moduleRequests(
    'scripts/test-executables.ts',
    executableSource,
    executableOutputs,
  );
  expect(selected).toEqual({
    requests: ['node:fs', 'node:path'],
    relativeFiles: [],
    programFiles: [],
    computedImports: 0,
    computedFiles: 0,
  });
  expect(moduleRequests('unrelated-name.ts', executableSource, executableOutputs)).toEqual(
    selected,
  );
  expect(
    moduleRequests('scripts/test-executables.ts', executableSource, [
      { environment: 'MERKUR_BAZEL_SCRATCH_ROOT', directory: 'another-output' },
    ]).computedFiles,
  ).toBe(1);
});

test('the output relation never dismisses unrelated computed reads or source-relative inputs', () => {
  const extra =
    executableSource +
    "\nreadFileSync(foreignInput);\nreadFileSync(new URL('./declared-source.ts', import.meta.url));";
  const selected = moduleRequests('scripts/test-executables.ts', extra, executableOutputs);
  expect(selected.computedFiles).toBe(1);
  expect(selected.relativeFiles).toEqual(['./declared-source.ts']);
  const unrelated = "import {readFileSync} from 'node:fs'; readFileSync(file);";
  expect(
    moduleRequests('scripts/test-executables.ts', unrelated, executableOutputs).computedFiles,
  ).toBe(1);
});

test('only exact declared scratch/hash/original-byte write and rename relations classify output reads', () => {
  for (const [original, replacement] of [
    [
      "path.join(declaredScratch, 'test-executables')",
      "path.join('/external', 'test-executables')",
    ],
    [
      "path.join(declaredScratch, 'test-executables')",
      "path.join(declaredScratch, '..', 'test-executables')",
    ],
    ['declaredScratch === undefined', 'declaredScratch !== undefined'],
    ["new Bun.CryptoHasher('sha256').update(bytes).digest('hex')", 'name'],
    [
      "new Bun.CryptoHasher('sha256').update(bytes).digest('hex')",
      "new Bun.CryptoHasher('sha256').update(bytes).digest('base64')",
    ],
    ['writeFileSync(staging, bytes);', 'writeFileSync(staging, foreignBytes);'],
    ['renameSync(staging, file);', 'renameSync(staging, foreignFile);'],
    ['if (!stored(file, bytes))', 'if (!stored(foreignFile, bytes))'],
    [
      'function stored(file: string, bytes: Uint8Array)',
      'export function stored(file: string, bytes: Uint8Array)',
    ],
    [
      'function stored(file: string, bytes: Uint8Array)',
      'function stored(file: string, bytes: Uint8Array, process: unknown)',
    ],
    ['  try {', "  file = '/external';\n  try {"],
    [
      'export function linkTestExecutable(directory: string, name: string, source: string)',
      'export function linkTestExecutable(directory: string, name: string, source: string, STORE: string)',
    ],
    ['const bytes = Buffer.from(source);', 'let bytes = Buffer.from(source);'],
  ]) {
    if (original === undefined || replacement === undefined)
      throw new Error('Missing original mutation');
    const selected = moduleRequests(
      'scripts/test-executables.ts',
      changedExecutable(original, replacement),
      executableOutputs,
    );
    expect(selected.computedFiles).toBe(1);
  }
});

test('every private reader caller must use generated outputs, and escaping the reader refuses classification', () => {
  expect(
    moduleRequests(
      'scripts/test-executables.ts',
      `${executableSource}\nstored(foreignFile, foreignBytes);`,
      executableOutputs,
    ).computedFiles,
  ).toBe(1);
  expect(
    moduleRequests(
      'scripts/test-executables.ts',
      `${executableSource}\nexport const exposed = stored;`,
      executableOutputs,
    ).computedFiles,
  ).toBe(1);
  expect(() =>
    moduleRequests('fixture.ts', executableSource, [
      { environment: 'MERKUR_BAZEL_SCRATCH_ROOT', directory: '../external' },
    ]),
  ).toThrow('declared scratch namespace');
});

test('a module cannot qualify a scratch root or hasher it shadows or modifies', () => {
  for (const change of [
    "process.env.MERKUR_BAZEL_SCRATCH_ROOT = '/foreign';\n",
    "import process from './foreign-env';\n",
    "import Bun from './foreign-hasher';\n",
    "import crypto from './foreign-name';\n",
    'Bun.CryptoHasher = foreignHasher;\n',
    'crypto.randomUUID = foreignName;\n',
  ]) {
    expect(
      moduleRequests('fixture.ts', change + executableSource, executableOutputs).computedFiles,
    ).toBe(1);
  }
});

test('computed properties and escaping or deleting builtin objects cannot qualify runtime output reads', () => {
  for (const source of [
    "const env = 'versions';\n" +
      executableSource.replaceAll(
        'process.env.MERKUR_BAZEL_SCRATCH_ROOT',
        'process[env].MERKUR_BAZEL_SCRATCH_ROOT',
      ),
    `delete process.env.MERKUR_BAZEL_SCRATCH_ROOT;\n${executableSource}`,
    `Object.assign(process.env, { MERKUR_BAZEL_SCRATCH_ROOT: '/outside' });\n${executableSource}`,
    `foreignMutation(process.env);\n${executableSource}`,
  ]) {
    expect(moduleRequests('fixture.ts', source, executableOutputs).computedFiles).toBe(1);
  }
});

test('block-local declaration patterns cannot substitute a private reader parameter', () => {
  for (const declaration of [
    "const { file } = { file: '/outside' };",
    "const { path: file } = { path: '/outside' };",
    "const [file] = ['/outside'];",
    'const { ...file } = foreignInputs;',
  ]) {
    const source = executableSource.replace('  try {', `  try {\n    ${declaration}`);
    expect(moduleRequests('fixture.ts', source, executableOutputs).computedFiles).toBe(1);
  }
});
