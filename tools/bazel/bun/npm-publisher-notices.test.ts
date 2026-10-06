import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const originalIdentities = [
  'asn1.js@4.10.1',
  'brorand@1.1.0',
  'elliptic@6.6.1',
  'hash.js@1.1.7',
  'hmac-drbg@1.0.1',
  'minimalistic-crypto-utils@1.0.1',
];
const kinds = ['metadata', 'source', 'npm'] as const;

function declaredFile(variable: string): string {
  const file = process.env[variable];
  if (file === undefined || !path.isAbsolute(file))
    throw new Error(`Publisher notices require the declared File ${variable}`);
  return file;
}

function originalFiles(): Record<string, Record<(typeof kinds)[number], string>> {
  return Object.fromEntries(
    originalIdentities.map((identity) => {
      const suffix = identity.replaceAll('.', '_').replaceAll('-', '_').replaceAll('@', '_');
      return [
        identity,
        Object.fromEntries(
          kinds.map((kind) => [
            kind,
            declaredFile(
              `MERKUR_NPM_PUBLISHER_${kind === 'npm' ? 'ARCHIVE' : kind.toUpperCase()}_${suffix.toUpperCase()}`,
            ),
          ]),
        ) as Record<(typeof kinds)[number], string>,
      ];
    }),
  );
}

const source = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

test('publisher controls bind all six original configured File selectors to the original lock', async () => {
  const pins: { packages: { package: { name: string; version: string } }[] } = JSON.parse(
    await readFile(source('./npm_publisher_licenses/pins.json'), 'utf8'),
  );
  const catalog: { packages: { name: string; version: string }[] } = JSON.parse(
    await readFile(source('./bun-runtime-build-npm.json'), 'utf8'),
  );
  expect(pins.packages.map(({ package: item }) => `${item.name}@${item.version}`).sort()).toEqual(
    originalIdentities,
  );
  expect(catalog.packages).toHaveLength(163);
  for (const { package: item } of pins.packages) {
    expect(
      catalog.packages.filter(
        (entry) => `${entry.name}@${entry.version}` === `${item.name}@${item.version}`,
      ),
    ).toEqual([item]);
  }
  const files = Object.values(originalFiles()).flatMap((entry) => Object.values(entry));
  expect(new Set(files).size).toBe(18);
  for (const file of files) expect((await stat(file)).isFile()).toBe(true);
});

test('the declared Python runs all twelve original publisher and actual consumer admission controls', async () => {
  const python = declaredFile('MERKUR_NPM_PUBLISHER_PYTHON');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'publisher-notice-controls-'));
  try {
    const inputs = path.join(temporary, 'inputs.json');
    await writeFile(inputs, JSON.stringify(originalFiles()));
    const child = Bun.spawn(
      [
        python,
        '-B',
        '-I',
        source('./npm_publisher_licenses/select-test.py'),
        '--selector',
        source('./npm_publisher_licenses/select.py'),
        '--pins',
        source('./npm_publisher_licenses/pins.json'),
        '--original-catalog',
        source('./bun-runtime-build-npm.json'),
        '--inputs',
        inputs,
        '--custody',
        source('./bun-runtime-attribution.py'),
        '--linked',
        source('./bun-runtime-linked-sources.py'),
        '--licenses',
        source('../packaging/license-inputs.py'),
        '--consumer',
        source('./bun-runtime-generated-origins.py'),
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { PATH: '', TMPDIR: temporary } },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stdout, stderr: status === 0 ? '' : stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
    });
    expect(stderr).toContain('Ran 12 tests');
    expect(stderr.trim().endsWith('OK')).toBe(true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
