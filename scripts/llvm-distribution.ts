/**
 * The LLVM the C and C++ toolchain fetches (`tools/bazel/llvm/distribution.bzl`), cut from each
 * official release archive down to the files `@toolchains_llvm`'s repository template and tools
 * directory name, the programs their links resolve to, and LLVM's licence: about 900 MB of a
 * release's 8 GB, 190-235 MB packed. A CI job then downloads that rather than the release's
 * 1.5 GB and decodes none of what it leaves out.
 *
 * An archive is a function of its release and the zstd version: entries in byte order, every time
 * zero, every owner root, modes reduced to executable or not, compressed at level 19. A rerun
 * writes the same bytes, which `MODULE.bazel` pins by SHA-256.
 *
 *   bun run build:llvm-distribution <directory>            write the archives, print each SHA-256
 *   bun run build:llvm-distribution <directory> --publish  and upload them as the release
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import path from 'node:path';

const LLVM_VERSION = '23.1.3';
const RELEASE_TAG = `toolchain-llvm-${LLVM_VERSION}`;

/** Each host the build runs on: the official archive's platform, SHA-256 and Linux triple. */
const HOSTS = [
  {
    platform: 'macOS-ARM64',
    sha256: '3dcfd88aec10be204a24037bcb0dc0ad777882e9dbe8ac60e2639060d8a794b1',
    triple: '',
  },
  {
    platform: 'Linux-ARM64',
    sha256: '56d005e339c979a696ed6c244e6472e16f3b1371e48987a07e6145bda7ee0d03',
    triple: 'aarch64-unknown-linux-gnu',
  },
  {
    platform: 'Linux-X64',
    sha256: 'ca9fe385a5d9e2d88132dc0e23a00e9f87f38fa75f67207b5e457d208e71d013',
    triple: 'x86_64-unknown-linux-gnu',
  },
] as const;

const PROGRAMS = [
  'clang',
  'clang++',
  'clang-23',
  'clang-cpp',
  'clang-format',
  'clang-tidy',
  'clangd',
  'ld.lld',
  'ld64.lld',
  'lld',
  'llvm-ar',
  'llvm-as',
  'llvm-cov',
  'llvm-dwp',
  'llvm-install-name-tool',
  'llvm-nm',
  'llvm-objcopy',
  'llvm-objdump',
  'llvm-profdata',
  'llvm-ranlib',
  'llvm-readelf',
  'llvm-readobj',
  'llvm-strip',
  'llvm-symbolizer',
  'wasm-ld',
];

const HEADERS = [
  'include/c++',
  'include/__libunwind_config.h',
  'include/libunwind.h',
  'include/libunwind.modulemap',
  'include/unwind.h',
  'include/unwind_arm_ehabi.h',
  'include/unwind_itanium.h',
];

// Darwin's libc++ and libunwind sit in `lib`, beside the LTO plugin Apple's linker loads; Linux
// keeps its libraries and `__config_site` under the target's triple.
const DARWIN = [
  'bin/llvm-libtool-darwin',
  'lib/libc++.a',
  'lib/libc++abi.a',
  'lib/libc++experimental.a',
  'lib/libunwind.a',
  'lib/libLTO.dylib',
];

// A release archive points to LLVM's licence without holding it; the archive holds the text from
// the release's tag at its root, outside every directory the toolchain's globs read.
const LICENSE = {
  url: `https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-${LLVM_VERSION}/llvm/LICENSE.TXT`,
  sha256: '8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee',
};

function archiveName(platform: string): string {
  return `LLVM-${LLVM_VERSION}-${platform}.tar.zst`;
}

function members(triple: string): string[] {
  return [
    ...PROGRAMS.map((program) => `bin/${program}`),
    ...HEADERS,
    'lib/clang',
    ...(triple === '' ? DARWIN : [`include/${triple}`, `lib/${triple}`]),
  ];
}

async function run(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], { stdin: 'ignore', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}`);
}

async function sha256(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

/** `url`'s bytes at `file`, held to `expected`; a file already there with those bytes is kept. */
async function fetchVerified(url: string, expected: string, file: string): Promise<void> {
  if (existsSync(file) && (await sha256(file)) === expected) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await Bun.write(file, response);
  const digest = await sha256(file);
  if (digest !== expected) throw new Error(`${url} is ${digest}, not ${expected}`);
}

/** Every file and link under `root`, as paths relative to it, in byte order. */
function entries(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

const BLOCK = 512;
const encoder = new TextEncoder();

function field(header: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = encoder.encode(text);
  if (bytes.length > length) throw new Error(`${text} does not fit a ${length}-byte tar field`);
  header.set(bytes, offset);
}

function octal(header: Uint8Array, offset: number, length: number, value: number): void {
  field(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

/** A ustar header: a name past 100 bytes splits at a slash into the 155-byte prefix. */
function header(name: string, mode: number, size: number, link: string): Uint8Array {
  const block = new Uint8Array(BLOCK);
  let prefix = '';
  let base = name;
  if (encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf('/', 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  field(block, 0, 100, base);
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  field(block, 156, 1, link === '' ? '0' : '2');
  field(block, 157, 100, link);
  field(block, 257, 8, 'ustar\x0000');
  field(block, 265, 32, 'root');
  field(block, 297, 32, 'root');
  field(block, 345, 155, prefix);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  field(block, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

async function pack(root: string, output: string): Promise<void> {
  const zstd = Bun.spawn(['zstd', '-19', '-T0', '-q', '-f', '-o', output], {
    stdin: 'pipe',
    stderr: 'inherit',
  });
  for (const name of entries(root)) {
    const file = path.join(root, name);
    const stats = lstatSync(file);
    if (stats.isSymbolicLink()) {
      zstd.stdin.write(header(name, 0o777, 0, readlinkSync(file)));
      continue;
    }
    const mode = (stats.mode & 0o111) === 0 ? 0o644 : 0o755;
    zstd.stdin.write(header(name, mode, stats.size, ''));
    zstd.stdin.write(await Bun.file(file).bytes());
    zstd.stdin.write(new Uint8Array((BLOCK - (stats.size % BLOCK)) % BLOCK));
    await zstd.stdin.flush();
  }
  zstd.stdin.write(new Uint8Array(2 * BLOCK));
  await zstd.stdin.end();
  const code = await zstd.exited;
  if (code !== 0) throw new Error(`zstd exited ${code}`);
}

async function build(directory: string, host: (typeof HOSTS)[number]): Promise<string> {
  const release = `LLVM-${LLVM_VERSION}-${host.platform}`;
  const download = path.join(directory, `${release}.tar.xz`);
  await fetchVerified(
    `https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/${release}.tar.xz`,
    host.sha256,
    download,
  );

  const stage = path.join(directory, release);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  const list = path.join(directory, `${release}.members`);
  await Bun.write(
    list,
    members(host.triple)
      .map((member) => `${release}/${member}\n`)
      .join(''),
  );
  await run([
    'bash',
    '-o',
    'pipefail',
    '-c',
    'xz -T0 -dc "$1" | tar -xf - -C "$2" --strip-components=1 -T "$3"',
    'unpack',
    download,
    stage,
    list,
  ]);
  await fetchVerified(LICENSE.url, LICENSE.sha256, path.join(stage, 'LICENSE.TXT'));

  const output = path.join(directory, archiveName(host.platform));
  await pack(stage, output);
  rmSync(stage, { recursive: true });
  rmSync(list);
  return output;
}

if (import.meta.main) {
  const [directory, flag] = process.argv.slice(2);
  if (directory === undefined || (flag !== undefined && flag !== '--publish')) {
    throw new Error('usage: bun run build:llvm-distribution <directory> [--publish]');
  }
  mkdirSync(directory, { recursive: true });
  const archives: string[] = [];
  for (const host of HOSTS) {
    const archive = await build(directory, host);
    archives.push(archive);
    process.stdout.write(`${host.platform} ${await sha256(archive)} ${archive}\n`);
  }
  if (flag === '--publish') {
    await run([
      'gh',
      'release',
      'create',
      RELEASE_TAG,
      '--repo',
      'merkur-sh/merkur',
      '--latest=false',
      '--title',
      `LLVM ${LLVM_VERSION} toolchain`,
      '--notes',
      `The files of LLVM ${LLVM_VERSION}'s release archives that Merkur's C and C++ toolchain ` +
        "uses, with LLVM's licence, written by `scripts/llvm-distribution.ts`.",
      ...archives,
    ]);
  }
}
