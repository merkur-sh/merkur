import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = 'd5727e6f91db77be699cc909661a5860125a8a462a1a1816b3fa9be5645b6d1f';
const descriptorLogical =
  'tools/bazel/rust/native_protocol/provenance/browser_session_oracle_native.json';
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

async function fixture(
  use: (files: {
    directory: string;
    inputs: Record<string, string>;
    descriptor: string;
    source: string;
    run: (unit?: string, descriptor?: string) => Promise<{ exit: number; stderr: string }>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oracle-package-control-'));
  try {
    const source = path.join(directory, 'original.rs');
    const descriptor = path.join(directory, 'descriptor.json');
    const executable = path.join(directory, 'original-executable');
    await writeFile(source, '// original compiler source fixture\n');
    await writeFile(executable, 'ordinary retained artifact fixture; never executed');
    const inputs = {
      'packages/merkur-client/src/lib.rs': source,
      [descriptorLogical]: descriptor,
    };
    await writeFile(
      descriptor,
      JSON.stringify({
        roots: [root],
        compiler_label: `//tools/bazel/rust/native_protocol:u_${root}`,
        source_membership: Object.keys(inputs).sort(),
      }),
    );
    await mkdir(path.join(directory, 'out'));
    const run = async (unit = root, originalDescriptor = descriptor) => {
      const inputPath = path.join(directory, 'inputs.json');
      await writeFile(inputPath, JSON.stringify(inputs));
      const child = Bun.spawn(
        [
          process.execPath,
          '--no-install',
          '--no-env-file',
          '--config=' + path.join(import.meta.dir, 'empty-bunfig.toml'),
          path.join(import.meta.dir, 'package-oracle.ts'),
          inputPath,
          executable,
          path.join(directory, 'out'),
          path.join(directory, 'manifest.json'),
          `//tools/bazel/rust/native_protocol:u_${root}`,
          unit.includes(':')
            ? unit
            : unit.includes(':')
              ? unit
              : `//tools/bazel/rust/native_protocol:u_${unit}`,
          originalDescriptor,
        ],
        { env: { PATH: '/merkur-no-ambient-tools' }, stdout: 'pipe', stderr: 'pipe' },
      );
      const stderr = await new Response(child.stderr).text();
      return { exit: await child.exited, stderr };
    };
    await use({ directory, inputs, descriptor, source, run });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('packages the explicit captured dev root and current original source bytes', async () => {
  await fixture(async ({ directory, source, run }) => {
    expect(await run()).toEqual({ exit: 0, stderr: '' });
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    expect(manifest.configuredUnit).toBe(root);
    expect(manifest.sourceInputs['packages/merkur-client/src/lib.rs']).toBe(
      sha256(await readFile(source)),
    );
    expect(manifest.sha256).toBe(
      sha256(await readFile(path.join(directory, 'original-executable'))),
    );
    expect(
      await readFile(path.join(directory, 'out', manifest.sha256, 'browser_session_oracle')),
    ).toEqual(await readFile(path.join(directory, 'original-executable')));
    const previous = manifest.source;
    await writeFile(source, '// legitimate edited compiler input; original action rebuilds\n');
    await rm(path.join(directory, 'out'), { recursive: true });
    await mkdir(path.join(directory, 'out'));
    expect((await run()).exit).toBe(0);
    const rebuilt = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    expect(rebuilt.source).not.toBe(previous);
    expect(rebuilt.sourceInputs['packages/merkur-client/src/lib.rs']).toBe(
      sha256(await readFile(source)),
    );
  });
});

test('refuses the separate test-profile example and changed original membership', async () => {
  await fixture(async ({ inputs, run }) => {
    const testProfileRoot = '5dd70ca4978cf0ab36ba76764cb27837fc46f0160c815d5e058f1ff8023ef7b9';
    const wrongRoot = await run(testProfileRoot);
    expect(wrongRoot.exit).toBe(1);
    expect(wrongRoot.stderr).toContain('declared configured compiler root');
    const foreignNamespace = await run(`@foreign//tools/bazel/rust/native_protocol:u_${root}`);
    expect(foreignNamespace.exit).toBe(1);
    expect(foreignNamespace.stderr).toContain('declared configured compiler root');
    delete inputs['packages/merkur-client/src/lib.rs'];
    const missing = await run();
    expect(missing.exit).toBe(1);
    expect(missing.stderr).toContain('selected compiler membership');
  });
});

test('refuses an undeclared descriptor File or duplicate physical descriptor mapping', async () => {
  await fixture(async ({ directory, inputs, descriptor, run }) => {
    const foreign = path.join(directory, 'foreign-descriptor.json');
    await writeFile(foreign, await readFile(descriptor));
    const copied = await run(root, foreign);
    expect(copied.exit).toBe(1);
    expect(copied.stderr).toContain('exact declared source File');
    inputs['foreign/descriptor.json'] = descriptor;
    const duplicate = await run();
    expect(duplicate.exit).toBe(1);
    expect(duplicate.stderr).toContain('exact declared source File');
  });
});
