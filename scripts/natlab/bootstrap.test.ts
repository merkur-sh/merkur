import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import { normalizeEdgeWebTransportUrl } from '../../packages/shared/src/edge-webtransport';
import { waitForHarnessEdgeRegistration } from '../../tests/e2e/global-setup';
import { runTestProcess } from '../test-process';
import { NATIVE_EDGE_URL } from './native-edge';
import { playwrightCli } from './playwright-cli';

const packageVersion = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));
const root = path.resolve(import.meta.dir, '../..');
const nativeConfiguration = path.join(import.meta.dir, 'playwright.native.config.mjs');
const decodeConfiguration = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      globalSetup: Schema.Array(Schema.String),
      globalTeardown: Schema.Array(Schema.String),
      projects: Schema.Array(
        Schema.Struct({
          testDir: Schema.String,
          outputDir: Schema.String,
          snapshotDir: Schema.String,
          baseURL: Schema.String,
          executablePath: Schema.String,
        }),
      ),
      servers: Schema.Array(
        Schema.Struct({ command: Schema.String, cwd: Schema.String, databasePath: Schema.String }),
      ),
    }),
  ),
);
const node = (() => {
  const executable = Bun.which('node');
  if (executable === null) throw new Error('the bootstrap proof requires Node');
  return executable;
})();

async function loadedConfiguration() {
  const loaded = await runTestProcess(
    [
      node,
      '--input-type=module',
      '-e',
      `import { createRequire } from 'node:module';
const { configLoader: { loadConfigFromFile } } = createRequire(process.argv[1])('playwright/lib/common');
const loaded = await loadConfigFromFile(process.argv[2], {});
process.stdout.write(JSON.stringify({
  globalSetup: loaded.globalSetups,
  globalTeardown: loaded.globalTeardowns,
  projects: loaded.config.projects.map(project => ({
    testDir: project.testDir, outputDir: project.outputDir, snapshotDir: project.snapshotDir,
    baseURL: project.use.baseURL, executablePath: project.use.launchOptions.executablePath,
  })),
  servers: loaded.webServers.map(server => ({
    command: server.command, cwd: server.cwd, databasePath: server.env.PW_E2E_DB_PATH,
  })),
}));`,
      playwrightCli,
      nativeConfiguration,
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        PW_E2E_OUTPUT_DIR: 'test-results/native-config-proof',
        PW_E2E_DB_PATH: 'data/native-config-proof.db',
        PW_E2E_PORT: '24331',
        PW_E2E_BROWSER: 'chromium',
      },
    },
  );
  expect(loaded.exitCode, loaded.stderr).toBe(0);
  return decodeConfiguration(loaded.stdout);
}

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
        cwd: root,
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
  test('readiness accepts the canonical registration produced for the native edge', async () => {
    const certHash = Buffer.alloc(32, 0x91).toString('base64');
    const record = JSON.stringify({
      edgeId: 'local-harness-1',
      edgeWtUrl: normalizeEdgeWebTransportUrl(NATIVE_EDGE_URL),
      activeCertHash: certHash,
      certHashes: [certHash],
      updatedAt: 123,
    });
    let reads = 0;
    await waitForHarnessEdgeRegistration(
      async () => {
        reads += 1;
        return { record, score: 123 };
      },
      { edgeId: 'local-harness-1', edgeUrl: NATIVE_EDGE_URL, certHash },
      AbortSignal.timeout(1_000),
    );
    expect(reads).toBe(1);
  });

  test('Playwright resolves the nested config paths and lists its real spec from the nested cwd', async () => {
    const loaded = await loadedConfiguration();
    expect(loaded.globalSetup).toEqual([path.join(root, 'tests/e2e/global-setup.ts')]);
    expect(loaded.globalTeardown).toEqual([path.join(root, 'tests/e2e/global-teardown.ts')]);
    expect(loaded.projects).toEqual([
      {
        testDir: path.join(root, 'tests/e2e'),
        snapshotDir: path.join(root, 'tests/e2e'),
        outputDir: path.join(root, 'test-results/native-config-proof'),
        baseURL: 'http://127.0.0.1:24331',
        executablePath: path.join(import.meta.dir, 'browser.sh'),
      },
    ]);
    const listed = await runTestProcess(
      [node, playwrightCli, 'test', '--config', nativeConfiguration, '--list'],
      {
        cwd: import.meta.dir,
        // The standalone CLI must not inherit the outer unit-test worker marker.
        env: { ...process.env, JEST_WORKER_ID: undefined },
      },
    );
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('Total: 5 tests in 1 file');
  });

  test('the inherited web server loads its actual entry from the canonical repository cwd', async () => {
    const loaded = await loadedConfiguration();
    expect(loaded.servers).toHaveLength(1);
    for (const server of loaded.servers) {
      expect(server.cwd).toBe(root);
      expect(server.databasePath).toBe(path.join(root, 'data/native-config-proof.db'));
      // Missing configuration stops before Redis or application startup. Reaching
      // this exact guard proves the real command and all entry imports resolved.
      const started = await runTestProcess(['/bin/bash', '-c', server.command], {
        cwd: server.cwd,
        env: { ...process.env, PW_E2E_PORT: '' },
      });
      expect(started.exitCode).not.toBe(0);
      expect(started.stderr).toContain('PW_E2E_PORT must be set by the Playwright config');
    }
  });

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
