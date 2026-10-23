import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import { runTestProcess } from '../test-process';
import { playwrightCli } from './playwright-cli';

const packageVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));
const node = Bun.which('node');
if (node === null) throw new Error('the bootstrap proof requires Node');

async function bootstrap(nativeExit: number, cleanupExit: number, installExit = 0) {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-natlab-bootstrap-'));
  const log = path.join(directory, 'commands');
  try {
    const run = await runTestProcess(
      [
        '/bin/bash',
        '-c',
        `
cp() { :; }
cd() { :; }
apt-get() { :; }
bun() { if [[ $1 == -p ]]; then printf 'pnpm@test'; fi; }
node() {
  if [[ $1 == -p ]]; then "$NATLAB_TEST_NODE" "$@"; return; fi
  printf 'cli:%s\\n' "$1" >> "$NATLAB_TEST_LOG"
  return "$NATLAB_INSTALL_EXIT"
}
bash() {
  printf 'native:%s\\n' "$*" >> "$NATLAB_TEST_LOG"
  return "$NATLAB_NATIVE_EXIT"
}
chown() {
  printf 'ownership:%s\\n' "$*" >> "$NATLAB_TEST_LOG"
  return "$NATLAB_CLEANUP_EXIT"
}
export -f cp cd apt-get bun node bash chown
exec /bin/bash "$1" eim-pdf
`,
        'natlab-bootstrap-proof',
        path.join(import.meta.dir, 'native-container.sh'),
      ],
      {
        cwd: path.resolve(import.meta.dir, '../..'),
        env: {
          ...process.env,
          MERKUR_NATLAB_UID: '1001',
          MERKUR_NATLAB_GID: '1002',
          NATLAB_TEST_NODE: node,
          NATLAB_TEST_LOG: log,
          NATLAB_NATIVE_EXIT: String(nativeExit),
          NATLAB_CLEANUP_EXIT: String(cleanupExit),
          NATLAB_INSTALL_EXIT: String(installExit),
        },
      },
    );
    return { exitCode: run.exitCode, commands: readFileSync(log, 'utf8').trim().split('\n') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('native NAT-lab bootstrap', () => {
  test('Node runs the CLI exported by the declared Playwright package', async () => {
    const packagePath = createRequire(import.meta.url).resolve('@playwright/test/package.json');
    const version = packageVersion(JSON.parse(readFileSync(packagePath, 'utf8'))).version;
    const resolved = await runTestProcess([node, '-p', 'require.resolve("@playwright/test/cli")']);
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stdout.trim()).toBe(playwrightCli);
    const cli = await runTestProcess([node, playwrightCli, '--version']);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.trim()).toBe(`Version ${version}`);
  });

  test('a session failure returns only evidence ownership and preserves its exit', async () => {
    const result = await bootstrap(37, 0);
    expect(result.exitCode).toBe(37);
    expect(result.commands).toEqual([
      `cli:${playwrightCli}`,
      'native:scripts/natlab/native.sh eim-pdf',
      'ownership:-hR 1001:1002 /evidence',
    ]);
  });

  test('cleanup failure preserves the primary failure and fails an otherwise successful run', async () => {
    expect((await bootstrap(37, 99)).exitCode).toBe(37);
    expect((await bootstrap(0, 99)).exitCode).toBe(1);
  });

  test('failed browser installation still returns evidence ownership before exit', async () => {
    const result = await bootstrap(0, 0, 42);
    expect(result.exitCode).toBe(42);
    expect(result.commands).toEqual([`cli:${playwrightCli}`, 'ownership:-hR 1001:1002 /evidence']);
  });
});
