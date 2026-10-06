import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MODULE = new URL('./test-executables.ts', import.meta.url).pathname;
const CONFIG = new URL('../tools/bazel/bun/empty-bunfig.toml', import.meta.url).pathname;
const SOURCE = '#!declared-test-interpreter\nrequested executable bytes\n';
const HASH = new Bun.CryptoHasher('sha256').update(SOURCE).digest('hex');
const CHILD_SOURCE = `
const { linkTestExecutable } = await import(process.env.MERKUR_TEST_EXECUTABLE_MODULE);
const request = JSON.parse(process.env.MERKUR_TEST_EXECUTABLE_REQUEST);
if (request.barrier) {
  process.stderr.write('READY\\n');
  if (await new Response(Bun.stdin.stream()).text() !== 'GO\\n') throw new Error('Missing start event');
}
const link = linkTestExecutable(request.directory, request.name, request.source);
process.stdout.write(JSON.stringify({ link }) + '\\n');
`;

const directories: string[] = [];
const children = new Set<{
  exited: Promise<number>;
  exitCode: number | null;
  kill: () => void;
}>();

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }),
  );
  children.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'merkur-test-executables-'));
  directories.push(root);
  const scratch = path.join(root, 'declared scratch');
  mkdirSync(scratch);
  const caller = (name: string) => {
    const directory = path.join(root, name);
    mkdirSync(directory);
    return directory;
  };
  return { scratch, caller, cached: path.join(scratch, 'test-executables', HASH) };
}

function start(scratch: string, directory: string, barrier = false) {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${CONFIG}`,
      '--eval',
      CHILD_SOURCE,
    ],
    {
      env: {
        MERKUR_BAZEL_SCRATCH_ROOT: scratch,
        MERKUR_TEST_EXECUTABLE_MODULE: MODULE,
        MERKUR_TEST_EXECUTABLE_REQUEST: JSON.stringify({
          directory,
          name: 'stand-in',
          source: SOURCE,
          barrier,
        }),
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  children.add(child);
  return child;
}

async function finish(child: ReturnType<typeof start>, errors = new Response(child.stderr).text()) {
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    errors,
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
  const result: unknown = JSON.parse(stdout);
  if (
    result === null ||
    typeof result !== 'object' ||
    !('link' in result) ||
    typeof result.link !== 'string'
  ) {
    throw new Error('Child returned no executable link');
  }
  return result.link;
}

function assertLink(link: string, cached: string) {
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(realpathSync(link)).toBe(realpathSync(cached));
  expect(readFileSync(link, 'utf8')).toBe(SOURCE);
  expect(statSync(cached).mode & 0o777).toBe(0o555);
}

describe('shared test executable cache', () => {
  test('uses declared scratch and gives callers private links to unchanged read-only bytes', async () => {
    const { scratch, caller, cached } = fixture();
    const first = await finish(start(scratch, caller('first')));
    const originalInode = statSync(cached).ino;
    const second = await finish(start(scratch, caller('second')));
    expect(first).not.toBe(second);
    assertLink(first, cached);
    assertLink(second, cached);
    expect(statSync(cached).ino).toBe(originalInode);
    expect(readdirSync(path.dirname(cached))).toEqual([HASH]);
  });

  test('replaces a corrupt entry and existing caller links see the exact requested bytes', async () => {
    const { scratch, caller, cached } = fixture();
    const first = await finish(start(scratch, caller('first')));
    chmodSync(cached, 0o644);
    writeFileSync(cached, 'corrupt cache bytes');
    chmodSync(cached, 0o555);
    const second = await finish(start(scratch, caller('second')));
    assertLink(first, cached);
    assertLink(second, cached);
    expect(readdirSync(path.dirname(cached))).toEqual([HASH]);
  });

  test('replaces matching bytes with an incorrect mode', async () => {
    const { scratch, caller, cached } = fixture();
    await finish(start(scratch, caller('first')));
    chmodSync(cached, 0o755);
    const link = await finish(start(scratch, caller('second')));
    assertLink(link, cached);
    expect(readdirSync(path.dirname(cached))).toEqual([HASH]);
  });

  test('concurrent children share exact bytes after an explicit start event', async () => {
    const { scratch, caller, cached } = fixture();
    const running = Array.from({ length: 4 }, (_, index) =>
      start(scratch, caller(`caller-${index}`), true),
    );
    const ready = await Promise.all(
      running.map(async (child) => {
        const reader = child.stderr.getReader();
        const decoder = new TextDecoder();
        let readiness = '';
        while (!readiness.endsWith('\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Child exited before ready: ${readiness}`);
          readiness += decoder.decode(chunk.value, { stream: true });
        }
        expect(readiness).toBe('READY\n');
        const errors = (async () => {
          let remaining = '';
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) return remaining + decoder.decode();
              remaining += decoder.decode(chunk.value, { stream: true });
            }
          } finally {
            reader.releaseLock();
          }
        })();
        return { child, errors };
      }),
    );
    for (const child of running) {
      child.stdin.write('GO\n');
      child.stdin.end();
    }
    const links = await Promise.all(ready.map(({ child, errors }) => finish(child, errors)));
    expect(new Set(links).size).toBe(running.length);
    for (const link of links) assertLink(link, cached);
    expect(readdirSync(path.dirname(cached))).toEqual([HASH]);
  });

  test('rejects a relative declared scratch before creating a caller link', async () => {
    const { caller } = fixture();
    const directory = caller('caller');
    const child = start('relative-scratch', directory);
    const [status, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('MERKUR_BAZEL_SCRATCH_ROOT must be absolute');
    expect(readdirSync(directory)).toEqual([]);
  });
});
