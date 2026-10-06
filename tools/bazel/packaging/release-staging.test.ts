import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PreparedCiArtifacts } from './ci-preparation';
import releaseContract from './release-contract.json';
import { type ReleaseArtifactSource, stageReleaseArtifacts } from './release-staging';
import type { BoundProducerArtifact } from './shipping-evidence';

const special: Readonly<Record<string, string>> = {
  'NOTICES.txt': '//release:unsigned_complete',
  'deployment.tar.gz': '//tools/bazel/packaging:deployment_unsigned',
  'edge-image.tar.gz': '//tools/bazel/packaging:edge_image_unsigned',
  'stun-image.tar.gz': '//tools/bazel/packaging:stun_image_unsigned',
};

function fact(relative: string, bytes: Buffer) {
  return {
    path: relative,
    digest: createHash('sha256').update(bytes).digest('hex'),
    length: String(bytes.length),
  };
}

async function fixture(
  run: (fixture: {
    root: string;
    batches: PreparedCiArtifacts[];
    sources: ReleaseArtifactSource[];
    releaseRoot: string;
    evidenceRoot: string;
    assertCurrent: () => void;
  }) => Promise<void>,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-staging-'));
  const batches: PreparedCiArtifacts[] = [];
  const sources: ReleaseArtifactSource[] = [];
  const mapping = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x86_64',
    'linux-arm64': 'linux-arm64',
    'linux-x64': 'linux-x86_64',
  };
  for (const [platform, enginePlatform] of Object.entries(mapping)) {
    const invocation = `invocation-${platform}`;
    const source = path.join(root, invocation);
    mkdirSync(source);
    const artifacts: BoundProducerArtifact[] = [];
    for (const contract of releaseContract.artifacts) {
      if (
        contract.platform !== platform &&
        !(contract.platform === 'all' && platform === 'linux-x64')
      )
        continue;
      const bytes = Buffer.from(`original shipping bytes: ${contract.name}`);
      const target =
        special[contract.name] ??
        `//tools/bazel/packaging:${contract.name.replace(/\.tar\.gz$/, '')}`;
      writeFileSync(path.join(source, contract.name), bytes);
      artifacts.push({
        producer: target,
        configuration: 'original',
        group: 'default',
        destination: contract.name,
        artifact: fact(contract.name, bytes),
      });
    }
    const signing = Buffer.from(`original signing inventory: ${platform}`);
    const descriptor = Buffer.from(`original configured descriptor: ${platform}`);
    writeFileSync(path.join(source, 'signing.json'), signing);
    writeFileSync(path.join(source, 'contract.json'), descriptor);
    artifacts.push({
      producer: '//tools/bazel/packaging:fixture',
      configuration: 'original',
      group: 'default',
      destination: 'signing.json',
      artifact: fact('signing.json', signing),
    });
    batches.push({ invocation, platform: enginePlatform, artifacts });
    sources.push({
      invocation,
      materializedRoot: source,
      retainedFiles: [fact('contract.json', descriptor)],
    });
  }
  try {
    await run({
      root,
      batches,
      sources,
      releaseRoot: path.join(root, 'release'),
      evidenceRoot: path.join(root, 'evidence'),
      assertCurrent: () => {},
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('stages exactly ten shipping files and separately retains original auxiliary bytes', async () => {
  await fixture(async (item) => {
    const directories = await stageReleaseArtifacts(item);
    for (const directory of directories) directory.close();
    expect(readdirSync(item.releaseRoot).sort()).toEqual(
      releaseContract.artifacts.map((entry) => entry.name).sort(),
    );
    for (const entry of releaseContract.artifacts) {
      expect(readFileSync(path.join(item.releaseRoot, entry.name)).toString()).toBe(
        `original shipping bytes: ${entry.name}`,
      );
      expect(lstatSync(path.join(item.releaseRoot, entry.name)).mode & 0o777).toBe(
        /^verify-linux-/.test(entry.name) ? 0o555 : 0o444,
      );
    }
    for (const source of item.sources) {
      expect(
        readFileSync(path.join(item.evidenceRoot, source.invocation, 'outputs/signing.json')),
      ).toEqual(readFileSync(path.join(source.materializedRoot, 'signing.json')));
      expect(
        readFileSync(path.join(item.evidenceRoot, source.invocation, 'engine/contract.json')),
      ).toEqual(readFileSync(path.join(source.materializedRoot, 'contract.json')));
    }
  });
});

test('incomplete current producer set refuses before creating release directories', async () => {
  await fixture(async (item) => {
    const batches = item.batches.map((batch) => ({
      ...batch,
      artifacts: batch.artifacts.filter((artifact) => artifact.destination === 'deployment.tar.gz'),
    }));
    await expect(stageReleaseArtifacts({ ...item, batches })).rejects.toThrow(
      'Incomplete release producer inventory',
    );
    expect(existsSync(item.releaseRoot)).toBe(false);
    expect(existsSync(item.evidenceRoot)).toBe(false);
  });
});

test('foreign configured producer and platform cannot supply an expected shipping name', async () => {
  await fixture(async (item) => {
    const original = item.batches[0];
    const output = original?.artifacts[0];
    if (original === undefined || output === undefined) throw new Error('Missing fixture artifact');
    for (const replacement of [
      { ...original, platform: 'linux-arm64' },
      {
        ...original,
        artifacts: [{ ...output, producer: '//other:foreign' }, ...original.artifacts.slice(1)],
      },
    ]) {
      await expect(
        stageReleaseArtifacts({ ...item, batches: [replacement, ...item.batches.slice(1)] }),
      ).rejects.toThrow('foreign producer, platform');
      expect(existsSync(item.releaseRoot)).toBe(false);
    }
  });
});

test('duplicate shipping files and unbound invocation roots refuse before publication', async () => {
  await fixture(async (item) => {
    const original = item.batches[0];
    const output = original?.artifacts[0];
    const source = item.sources[0];
    if (original === undefined || output === undefined || source === undefined)
      throw new Error('Missing fixture');
    await expect(
      stageReleaseArtifacts({
        ...item,
        batches: [
          { ...original, artifacts: [...original.artifacts, output] },
          ...item.batches.slice(1),
        ],
      }),
    ).rejects.toThrow('duplicate name');
    await expect(
      stageReleaseArtifacts({
        ...item,
        sources: [...item.sources, { ...source, invocation: 'foreign' }],
      }),
    ).rejects.toThrow('unbound invocation');
    expect(existsSync(item.releaseRoot)).toBe(false);
  });
});

test('changed original bytes retire all files created during staging', async () => {
  await fixture(async (item) => {
    const source = item.sources.at(-1);
    if (source === undefined) throw new Error('Missing fixture source');
    writeFileSync(path.join(source.materializedRoot, 'contract.json'), 'different descriptor');
    await expect(stageReleaseArtifacts(item)).rejects.toThrow();
    expect(readdirSync(item.releaseRoot)).toEqual([]);
    expect(readdirSync(item.evidenceRoot)).toEqual([]);
  });
});

test('revocation during asynchronous capture removes owned shipping and evidence', async () => {
  await fixture(async (item) => {
    let checks = 0;
    await expect(
      stageReleaseArtifacts({
        ...item,
        assertCurrent: () => {
          if (++checks === 5) throw new Error('Newer nonce revoked admission');
        },
      }),
    ).rejects.toThrow('Newer nonce');
    expect(readdirSync(item.releaseRoot)).toEqual([]);
    expect(readdirSync(item.evidenceRoot)).toEqual([]);
  });
});

test('fresh root creation never overwrites an existing publisher or follows its alias', async () => {
  await fixture(async (item) => {
    mkdirSync(item.releaseRoot);
    writeFileSync(path.join(item.releaseRoot, 'other-publisher'), 'untouched');
    await expect(stageReleaseArtifacts(item)).rejects.toThrow();
    expect(readFileSync(path.join(item.releaseRoot, 'other-publisher')).toString()).toBe(
      'untouched',
    );
    rmSync(item.releaseRoot, { recursive: true });
    symlinkSync(item.sources[0]?.materializedRoot ?? item.root, item.releaseRoot);
    await expect(stageReleaseArtifacts(item)).rejects.toThrow();
    expect(lstatSync(item.releaseRoot).isSymbolicLink()).toBe(true);
  });
});

test('historical packaging notice label cannot replace the public complete notice producer', async () => {
  await fixture(async (item) => {
    const batches = item.batches.map((batch) => ({
      ...batch,
      artifacts: batch.artifacts.map((artifact) =>
        artifact.destination === 'NOTICES.txt'
          ? { ...artifact, producer: '//tools/bazel/packaging:release_notices' }
          : artifact,
      ),
    }));
    await expect(stageReleaseArtifacts({ ...item, batches })).rejects.toThrow(
      'foreign producer, platform',
    );
    expect(existsSync(item.releaseRoot)).toBe(false);
    expect(existsSync(item.evidenceRoot)).toBe(false);
  });
});
