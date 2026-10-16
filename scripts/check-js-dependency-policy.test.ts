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
} from './check-js-dependency-policy';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

function lockfile<P extends object, W extends object>(packages: P, workspace?: W) {
  return readLockfile(
    decodeLockfile({
      workspaces: {
        '': { name: 'merkur', dependencies: { effect: 'catalog:' }, ...workspace },
        'packages/auth': { name: '@merkur/auth', dependencies: { nanoid: '^6.0.1' } },
      },
      catalog: { effect: '4.0.2' },
      packages: { '@merkur/auth': ['@merkur/auth@workspace:packages/auth'], ...packages },
    }),
  );
}

function registry<I extends object>(ident: string, info?: I) {
  return [ident, '', info ?? {}, INTEGRITY];
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

const ROOT = { trustedDependencies: [] };
const UNUSED_EXCEPTIONS = [
  'LICENSE_EXCEPTIONS names lightningcss, which bun.lock does not resolve',
  'LICENSE_EXCEPTIONS names caniuse-lite, which bun.lock does not resolve',
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
  const result = lockfile({ nanoid: registry('nanoid@6.0.1') });
  expect(result.findings).toEqual([]);
  expect(result.workspaces).toEqual(['packages/auth']);
  expect(result.packages.map((locked) => locked.name)).toEqual(['nanoid']);
});

test('sources outside the npm registry, foreign registries and missing integrity are refused', () => {
  const result = lockfile({
    fromGit: ['left-pad@git+ssh://git@github.com/x/left-pad.git#abc', {}, 'abc'],
    fromGithub: ['left-pad@github:x/left-pad#abc', {}, 'abc'],
    fromTarball: ['left-pad@https://example.invalid/left-pad.tgz', '', {}, INTEGRITY],
    fromMirror: ['left-pad@1.3.0', 'https://mirror.invalid/', {}, INTEGRITY],
    unpinned: ['right-pad@1.0.0', '', {}, 'sha1-abc'],
    stray: ['@merkur/ghost@workspace:packages/ghost'],
  });
  expect(result.packages).toEqual([]);
  expect(result.findings).toHaveLength(6);
  expect(result.findings).toContain(
    'left-pad@1.3.0: resolved from "https://mirror.invalid/", not npm',
  );
  expect(result.findings).toContain('right-pad@1.0.0: has no sha512 integrity');
});

test('wildcard, tag, URL and inexact catalog specs are refused', () => {
  const result = readLockfile(
    decodeLockfile({
      workspaces: {
        '': {
          devDependencies: {
            a: '*',
            b: 'latest',
            c: 'github:x/c',
            d: '>=1.0.0',
            e: 'npm:left-pad@1.3.0',
            f: '~1.2.3',
            g: '1.2.3-rc.1',
            h: 'catalog:',
            i: 'workspace:*',
          },
        },
      },
      catalog: { effect: '^4.0.2' },
      packages: {},
    }),
  );
  expect(result.findings).toHaveLength(6);
  expect(result.findings).toContain('catalog effect: "^4.0.2" is not an exact version');
});

test('a package installable nowhere, and everything beneath it, is skipped', () => {
  const result = lockfile({
    'binding-wasm32': registry('binding-wasm32@1.0.0', { cpu: 'none' }),
    'binding-wasm32/@emnapi/core': registry('@emnapi/core@1.10.0'),
    'binding-riscv': registry('binding-riscv@1.0.0', { os: 'linux', cpu: 'none' }),
    '@emnapi/core': registry('@emnapi/core@1.10.0'),
  });
  expect(
    Object.fromEntries(result.packages.map((locked) => [locked.key, locked.installable])),
  ).toEqual({
    'binding-wasm32': false,
    'binding-wasm32/@emnapi/core': false,
    'binding-riscv': false,
    '@emnapi/core': true,
  });
  expect(policyFindings(ROOT, result.packages, installed([])).findings).toEqual([
    ...UNUSED_EXCEPTIONS,
    '@emnapi/core@1.10.0: not installed',
  ]);
});

test('licences are checked, and an exception admits its exact expression and platform binaries', () => {
  const { packages } = lockfile({
    lightningcss: registry('lightningcss@1.33.0', {
      optionalDependencies: { 'lightningcss-linux-x64-gnu': '1.33.0' },
    }),
    'lightningcss-linux-x64-gnu': registry('lightningcss-linux-x64-gnu@1.33.0'),
    'caniuse-lite': registry('caniuse-lite@1.0.30001810'),
    copyleft: registry('copyleft@1.0.0'),
    unstated: registry('unstated@1.0.0'),
    prose: registry('prose@1.0.0'),
  });
  const report = policyFindings(
    ROOT,
    packages,
    installed([
      ['lightningcss', manifest('lightningcss@1.33.0', 'MPL-2.0')],
      ['lightningcss-linux-x64-gnu', manifest('lightningcss-linux-x64-gnu@1.33.0', 'MPL-2.0')],
      ['caniuse-lite', manifest('caniuse-lite@1.0.30001810', 'CC-BY-4.0 OR MIT')],
      ['copyleft', manifest('copyleft@1.0.0', 'GPL-2.0-only')],
      ['unstated', manifest('unstated@1.0.0')],
      ['prose', manifest('prose@1.0.0', 'SEE LICENSE IN LICENSE.md')],
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
    nanoid: registry('nanoid@6.0.1'),
    odd: registry('odd@1.0.0'),
  });
  const report = policyFindings(
    ROOT,
    packages,
    installed([
      ['nanoid', manifest('nanoid@6.0.2', 'MIT')],
      ['odd', null],
    ]),
  );
  expect(report.findings).toEqual([
    ...UNUSED_EXCEPTIONS,
    'nanoid@6.0.1: the installed manifest names another package',
    'odd@1.0.0: the installed manifest has no readable licence or scripts',
  ]);
});

test('install scripts stay blocked unless trusted, and trust must be explicit and current', () => {
  const { packages } = lockfile({
    native: registry('native@1.0.0'),
    gyp: registry('gyp@1.0.0'),
    plain: registry('plain@1.0.0'),
  });
  const manifests = installed(
    [
      ['native', { ...manifest('native@1.0.0', 'MIT'), scripts: { postinstall: 'node build.js' } }],
      ['gyp', manifest('gyp@1.0.0', 'MIT')],
      ['plain', { ...manifest('plain@1.0.0', 'MIT'), scripts: { test: 'x' } }],
    ],
    ['gyp'],
  );

  const blocked = policyFindings(ROOT, packages, manifests);
  expect(blocked.findings).toEqual(UNUSED_EXCEPTIONS);
  expect(blocked.blocked).toEqual(['gyp', 'native']);

  const trusted = policyFindings({ trustedDependencies: ['native', 'plain'] }, packages, manifests);
  expect(trusted.blocked).toEqual(['gyp']);
  expect(trusted.findings).toEqual([
    ...UNUSED_EXCEPTIONS,
    'package.json: trustedDependencies names plain, which has no install script',
  ]);

  expect(policyFindings({}, packages, manifests).findings).toContain(
    'package.json: trustedDependencies must list the dependencies allowed to run install scripts; without it Bun runs its built-in list',
  );
});
