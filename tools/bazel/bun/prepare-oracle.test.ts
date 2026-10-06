import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clientSessionOracleExecutable } from '../../../scripts/perf/client-session-oracle';
import { createOracleProofFixture } from '../../../scripts/perf/client-session-oracle-test-fixture';
import { CLIENT_SESSION_ORACLE_PRODUCER, publishClientSessionOracle } from './prepare-oracle';
import { oraclePreparationArguments } from './prepare-oracle-cli';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const original = createOracleProofFixture();
  const action = path.join(original.root, 'action');
  mkdirSync(action);
  const binary = path.join(action, 'original-native');
  writeFileSync(binary, readFileSync(original.executable));
  const input = path.join(action, 'inputs.json');
  writeFileSync(
    input,
    JSON.stringify(
      Object.fromEntries(
        Object.keys(original.sourceInputs).map((file) => [file, path.join(original.root, file)]),
      ),
    ),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${path.join(import.meta.dir, 'empty-bunfig.toml')}`,
      path.join(import.meta.dir, 'package-oracle.ts'),
      input,
      binary,
      path.join(action, 'retained'),
      path.join(action, 'manifest.json'),
      '//tools/bazel/rust/native_protocol:u_selected-unit',
      '//tools/bazel/rust/native_protocol:u_selected-unit',
      path.join(
        original.root,
        'tools/bazel/rust/native_protocol/provenance/browser_session_oracle_native.json',
      ),
    ],
    { env: { PATH: '' }, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await new Response(child.stderr).text()).toBe('');
  expect(await child.exited).toBe(0);
  rmSync(path.join(original.root, 'target'), { recursive: true });
  const events = (exit = 0, groups = ['oracle_manifest', 'oracle_binary']) => {
    const members = ['manifest.json', 'original-native'];
    const sets = members.map((name, index) => {
      const bytes = readFileSync(path.join(action, name));
      return {
        id: { namedSet: { id: String(index) } },
        namedSetOfFiles: {
          files: [
            {
              name,
              digest: sha256(bytes),
              length: String(bytes.byteLength),
            },
          ],
        },
      };
    });
    return `${[
      { id: { started: {} }, started: { uuid: 'oracle-control', buildToolVersion: '9.2.0' } },
      ...sets,
      {
        id: {
          targetCompleted: {
            label: CLIENT_SESSION_ORACLE_PRODUCER,
            configuration: { id: 'configured-original' },
          },
        },
        completed: {
          success: exit === 0,
          outputGroup: groups.map((name, index) => ({ name, fileSets: [{ id: String(index) }] })),
        },
      },
      { id: { buildFinished: {} }, finished: { exitCode: { code: exit } }, lastMessage: true },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`;
  };
  return {
    ...original,
    action,
    events,
    request: () => ({ root: original.root, executionRoot: action, events: events(), exitCode: 0 }),
  };
}

test('oracle preparation takes exact declared credentials and source admission arguments', () => {
  expect(oraclePreparationArguments('/workspace', [])).toEqual({
    credentialFile: '/workspace/.bazelrc.local',
  });
  expect(
    oraclePreparationArguments('/workspace', [
      '--credential-file',
      '/private/credential',
      '--admit-file',
      '/private/inputs',
    ]),
  ).toEqual({ credentialFile: '/private/credential', admitFile: '/private/inputs' });
  for (const args of [
    ['--credential-file', 'relative'],
    ['--credential-file'],
    ['--unknown', '/file'],
    ['--credential-file', '/a', '--credential-file', '/b'],
  ])
    expect(() => oraclePreparationArguments('/workspace', args)).toThrow();
});

test('actual package runner manifest and native bytes publish to the strict configured reader', async () => {
  const f = await fixture();
  try {
    expect(await publishClientSessionOracle(f.request())).toBe(f.executable);
    expect(clientSessionOracleExecutable(f.root)).toBe(f.executable);
    expect(readFileSync(path.join(f.root, 'target/rust/client-session-oracle.json'))).toEqual(
      readFileSync(path.join(f.action, 'manifest.json')),
    );
    expect(readFileSync(f.executable)).toEqual(
      readFileSync(path.join(f.action, 'original-native')),
    );
    expect(await publishClientSessionOracle(f.request())).toBe(f.executable);
  } finally {
    f.close();
  }
});

test('failed or incomplete configured builds cannot publish an oracle', async () => {
  const f = await fixture();
  try {
    await expect(publishClientSessionOracle({ ...f.request(), exitCode: 37 })).rejects.toThrow(
      'complete pinned-engine',
    );
    await expect(
      publishClientSessionOracle({ ...f.request(), events: f.events(1) }),
    ).rejects.toThrow('complete pinned-engine');
    await expect(
      publishClientSessionOracle({ ...f.request(), events: f.events(0, ['oracle_binary']) }),
    ).rejects.toThrow('output group');
    expect(() => clientSessionOracleExecutable(f.root)).toThrow();
  } finally {
    f.close();
  }
});

test('changed source or different native output refuses before manifest publication', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.root, f.source);
    const original = readFileSync(source);
    writeFileSync(source, 'mutated selected compiler input');
    await expect(publishClientSessionOracle(f.request())).rejects.toThrow('source facts changed');
    writeFileSync(source, original);
    writeFileSync(path.join(f.action, 'original-native'), 'foreign ordinary executable');
    await expect(publishClientSessionOracle(f.request())).rejects.toThrow('evidence changed');
    expect(() => clientSessionOracleExecutable(f.root)).toThrow();
  } finally {
    f.close();
  }
});

test('source entrypoint cannot fall back to ambient compiler tools', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${path.join(import.meta.dir, 'empty-bunfig.toml')}`,
      path.join(import.meta.dir, 'prepare-oracle-cli.ts'),
    ],
    { env: { PATH: '', BUILD_WORKSPACE_DIRECTORY: process.cwd() }, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await new Response(child.stderr).text()).toContain('Missing absolute declared tool');
  expect(await child.exited).toBe(1);
});

test('publication cleanup preserves a foreign nonempty replacement directory', async () => {
  const f = await fixture();
  const originalRename = fs.renameSync;
  let replacement: string | undefined;
  const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    const file = String(from);
    if (file.endsWith('/manifest.json') && file.includes('/.oracle-publication-')) {
      replacement = path.dirname(file);
      const retired = `${replacement}.original`;
      originalRename(replacement, retired);
      mkdirSync(replacement);
      writeFileSync(
        path.join(replacement, 'manifest.json'),
        readFileSync(path.join(retired, 'manifest.json')),
      );
      writeFileSync(path.join(replacement, 'foreign-sentinel'), 'foreign-owned-content');
    }
    originalRename(from, to);
  });
  try {
    await expect(publishClientSessionOracle(f.request())).rejects.toThrow();
    if (replacement === undefined) throw new Error('Actual publication boundary was not invoked');
    expect(readFileSync(path.join(replacement, 'foreign-sentinel'), 'utf8')).toBe(
      'foreign-owned-content',
    );
  } finally {
    rename.mockRestore();
    f.close();
  }
});

test('declared preparation never treats its runfiles directory as the source workspace', async () => {
  for (const workspace of [undefined, 'relative-workspace']) {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        `--config=${path.join(import.meta.dir, 'empty-bunfig.toml')}`,
        path.join(import.meta.dir, 'prepare-oracle-cli.ts'),
      ],
      {
        env: {
          PATH: '',
          ...(workspace === undefined
            ? {}
            : {
                BUILD_WORKSPACE_DIRECTORY: workspace,
              }),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(await new Response(child.stderr).text()).toContain('declared absolute workspace');
    expect(await child.exited).toBe(1);
  }
});
