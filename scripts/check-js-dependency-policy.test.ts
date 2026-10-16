import { expect, test } from 'bun:test';
import {
  declaredLicense,
  decodeLockfile,
  type Installed,
  type InstalledManifest,
  licenseGranted,
  parseLicense,
  policyFindings,
  readLockfile,
  supportedArchitectures,
} from './check-js-dependency-policy';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

function lockfile<P extends object, I extends object, S extends object>(
  packages: P,
  importer?: I,
  snapshots?: S,
) {
  const lock = {
    importers: {
      '.': {
        dependencies: { effect: { specifier: 'catalog:', version: '4.0.2' } },
        ...importer,
      },
      'packages/auth': {
        dependencies: { nanoid: { specifier: '^6.0.1', version: '6.0.1' } },
      },
    },
    catalogs: { default: { effect: { specifier: '4.0.2', version: '4.0.2' } } },
    packages,
  };
  return readLockfile(decodeLockfile(snapshots === undefined ? lock : { ...lock, snapshots }));
}

function registry<I extends object>(info?: I) {
  return { resolution: { integrity: INTEGRITY }, ...info };
}

function manifest(ident: string, license?: string): InstalledManifest {
  const at = ident.lastIndexOf('@');
  const named = { name: ident.slice(0, at), version: ident.slice(at + 1) };
  return license === undefined ? named : { ...named, license };
}

function installed(
  manifests: readonly (readonly [key: string, manifest: InstalledManifest | null])[],
  bindingGyp: readonly string[] = [],
): Map<string, Installed> {
  return new Map(
    manifests.map(([key, manifest]) => [key, { manifest, bindingGyp: bindingGyp.includes(key) }]),
  );
}

const SETTINGS = { onlyBuiltDependencies: [] };
const UNUSED_EXCEPTIONS = [
  'LICENSE_EXCEPTIONS names lightningcss, which pnpm-lock.yaml does not resolve',
  'LICENSE_EXCEPTIONS names caniuse-lite, which pnpm-lock.yaml does not resolve',
];

test('SPDX expressions are granted by OR of any and AND of all allowed licences', () => {
  for (const granted of [
    'MIT',
    'MIT OR Apache-2.0',
    '(BSD-2-Clause OR MIT OR Apache-2.0)',
    'MIT OR GPL-3.0-only',
    'Apache-2.0 WITH LLVM-exception',
    '(MIT AND Zlib)',
  ]) {
    const tree = parseLicense(granted);
    expect(tree).not.toBeNull();
    if (tree !== null) expect(licenseGranted(tree)).toBe(true);
  }
  for (const refused of [
    'MIT AND GPL-3.0-only',
    'AGPL-3.0-only',
    'GPL-3.0-only WITH Classpath-exception-2.0',
    'UNLICENSED',
  ]) {
    const tree = parseLicense(refused);
    expect(tree).not.toBeNull();
    if (tree !== null) expect(licenseGranted(tree)).toBe(false);
  }
});

test('text that is not an SPDX expression does not parse', () => {
  for (const text of [
    '',
    'MIT OR',
    '(MIT',
    'MIT)',
    'SEE LICENSE IN LICENSE',
    'MIT or Apache-2.0',
  ]) {
    expect(parseLicense(text)).toBeNull();
  }
});

test('the declared licence reads SPDX, object and single-entry legacy forms only', () => {
  const named = { name: 'x', version: '1.0.0' };
  expect(declaredLicense({ ...named, license: 'MIT' })).toBe('MIT');
  expect(declaredLicense({ ...named, license: { type: 'ISC' } })).toBe('ISC');
  expect(declaredLicense({ ...named, licenses: [{ type: 'MIT' }] })).toBe('MIT');
  expect(declaredLicense({ ...named, licenses: [{ type: 'MIT' }, { type: 'GPL-2.0-only' }] })).toBe(
    null,
  );
  expect(declaredLicense(named)).toBeNull();
});

test('the current lockfile shape passes the source and spec checks', () => {
  const result = lockfile({ 'nanoid@6.0.1': registry() });
  expect(result.findings).toEqual([]);
  expect(result.workspaces).toEqual(['packages/auth']);
  expect(result.packages.map((locked) => locked.name)).toEqual(['nanoid']);
});

test('sources outside the npm registry, foreign registries and missing integrity are refused', () => {
  const result = lockfile({
    'left-pad@https://codeload.github.com/x/left-pad/tar.gz/abc': {
      resolution: { tarball: 'https://codeload.github.com/x/left-pad/tar.gz/abc' },
    },
    'mirror@1.3.0': {
      resolution: { integrity: INTEGRITY, tarball: 'https://mirror.invalid/mirror-1.3.0.tgz' },
    },
    'from-git@1.0.0': {
      resolution: { type: 'git', repo: 'https://github.com/x/y', commit: 'abc' },
    },
    'right-pad@1.0.0': { resolution: { integrity: 'sha1-abc' } },
    'bare@1.0.0': { resolution: {} },
  });
  expect(result.packages).toEqual([]);
  expect(result.findings).toEqual([
    'left-pad@https://codeload.github.com/x/left-pad/tar.gz/abc: resolved outside the npm registry',
    'mirror@1.3.0: resolved from "https://mirror.invalid/mirror-1.3.0.tgz", not npm',
    'from-git@1.0.0: resolved from "https://github.com/x/y", not npm',
    'right-pad@1.0.0: has no sha512 integrity',
    'bare@1.0.0: has no sha512 integrity',
  ]);
});

test('wildcard, tag, URL and inexact catalog specs are refused', () => {
  const spec = (specifier: string) => ({ specifier, version: '1.0.0' });
  const result = readLockfile(
    decodeLockfile({
      importers: {
        '.': {
          devDependencies: {
            a: spec('*'),
            b: spec('latest'),
            c: spec('github:x/c'),
            d: spec('>=1.0.0'),
            e: spec('npm:left-pad@1.3.0'),
            f: spec('~1.2.3'),
            g: spec('1.2.3-rc.1'),
            h: spec('catalog:'),
            i: spec('workspace:*'),
          },
        },
      },
      catalogs: { default: { effect: { specifier: '^4.0.2', version: '4.0.5' } } },
    }),
  );
  expect(result.findings).toHaveLength(6);
  expect(result.findings).toContain('catalog default effect: "^4.0.2" is not an exact version');
});

test('the policy install covers every platform any locked package names', () => {
  const result = lockfile({
    'binding-darwin-arm64@1.0.0': registry({ os: ['darwin'], cpu: ['arm64'] }),
    'binding-linux-x64-musl@1.0.0': registry({ os: ['linux'], cpu: ['x64'], libc: ['musl'] }),
    'binding-not-windows@1.0.0': registry({ os: ['!win32'] }),
    '@emnapi/core@1.10.0': registry(),
  });
  expect(result.architectures).toEqual({
    os: ['darwin', 'linux'],
    cpu: ['arm64', 'x64'],
    libc: ['musl'],
  });
  expect(supportedArchitectures(result.architectures)).toBe(
    [
      'supportedArchitectures:',
      '  os: ["darwin", "linux"]',
      '  cpu: ["arm64", "x64"]',
      '  libc: ["musl"]',
      '',
    ].join('\n'),
  );
  expect(policyFindings(SETTINGS, result.packages, installed([])).findings).toEqual([
    ...UNUSED_EXCEPTIONS,
    'binding-darwin-arm64@1.0.0: not installed',
    'binding-linux-x64-musl@1.0.0: not installed',
    'binding-not-windows@1.0.0: not installed',
    '@emnapi/core@1.10.0: not installed',
  ]);
});

test('licences are checked, and an exception admits its exact expression and platform binaries', () => {
  const { packages } = lockfile(
    {
      'lightningcss@1.33.0': registry(),
      'lightningcss-linux-x64-gnu@1.33.0': registry(),
      'caniuse-lite@1.0.30001810': registry(),
      'copyleft@1.0.0': registry(),
      'unstated@1.0.0': registry(),
      'prose@1.0.0': registry(),
    },
    undefined,
    // The binaries are the snapshot's optional dependencies, under each peer set it resolved with.
    {
      'lightningcss@1.33.0(peer@1.0.0)': {
        optionalDependencies: { 'lightningcss-linux-x64-gnu': '1.33.0' },
      },
    },
  );
  const report = policyFindings(
    SETTINGS,
    packages,
    installed([
      ['lightningcss@1.33.0', manifest('lightningcss@1.33.0', 'MPL-2.0')],
      [
        'lightningcss-linux-x64-gnu@1.33.0',
        manifest('lightningcss-linux-x64-gnu@1.33.0', 'MPL-2.0'),
      ],
      ['caniuse-lite@1.0.30001810', manifest('caniuse-lite@1.0.30001810', 'CC-BY-4.0 OR MIT')],
      ['copyleft@1.0.0', manifest('copyleft@1.0.0', 'GPL-2.0-only')],
      ['unstated@1.0.0', manifest('unstated@1.0.0')],
      ['prose@1.0.0', manifest('prose@1.0.0', 'SEE LICENSE IN LICENSE.md')],
    ]),
  );
  expect(report.checked).toBe(6);
  expect(report.findings).toEqual([
    'caniuse-lite@1.0.30001810: declares CC-BY-4.0 OR MIT, but its exception admits CC-BY-4.0',
    'copyleft@1.0.0: GPL-2.0-only is not an allowed licence',
    'unstated@1.0.0: declares no licence',
    'prose@1.0.0: "SEE LICENSE IN LICENSE.md" is not an SPDX expression',
  ]);
});

test('a manifest for another package, or one that does not decode, is refused', () => {
  const { packages } = lockfile({
    'nanoid@6.0.1': registry(),
    'odd@1.0.0': registry(),
  });
  const report = policyFindings(
    SETTINGS,
    packages,
    installed([
      ['nanoid@6.0.1', manifest('nanoid@6.0.2', 'MIT')],
      ['odd@1.0.0', null],
    ]),
  );
  expect(report.findings).toEqual([
    ...UNUSED_EXCEPTIONS,
    'nanoid@6.0.1: the installed manifest names another package',
    'odd@1.0.0: the installed manifest has no readable licence or scripts',
  ]);
});

test('install scripts stay blocked unless built, and the build list must stay current', () => {
  const { packages } = lockfile({
    'native@1.0.0': registry(),
    'gyp@1.0.0': registry(),
    'plain@1.0.0': registry(),
  });
  const manifests = installed(
    [
      [
        'native@1.0.0',
        { ...manifest('native@1.0.0', 'MIT'), scripts: { postinstall: 'node build.js' } },
      ],
      ['gyp@1.0.0', manifest('gyp@1.0.0', 'MIT')],
      ['plain@1.0.0', { ...manifest('plain@1.0.0', 'MIT'), scripts: { test: 'x' } }],
    ],
    ['gyp@1.0.0'],
  );

  const blocked = policyFindings(SETTINGS, packages, manifests);
  expect(blocked.findings).toEqual(UNUSED_EXCEPTIONS);
  expect(blocked.blocked).toEqual(['gyp', 'native']);

  const built = policyFindings({ onlyBuiltDependencies: ['native', 'plain'] }, packages, manifests);
  expect(built.blocked).toEqual(['gyp']);
  expect(built.findings).toEqual([
    ...UNUSED_EXCEPTIONS,
    'pnpm-workspace.yaml: onlyBuiltDependencies names plain, which has no install script',
  ]);
  // Without the setting pnpm builds nothing, as with an empty list.
  expect(policyFindings({}, packages, manifests).blocked).toEqual(['gyp', 'native']);
});
