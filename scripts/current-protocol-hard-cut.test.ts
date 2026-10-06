import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCurrentProtocolHardCut } from './current-protocol-hard-cut';

describe('current protocol hard cut', () => {
  test('the repository contains only the current protocol surface', async () => {
    await expect(assertCurrentProtocolHardCut()).resolves.toBeUndefined();
  });

  const retiredPathCases = [
    'Dockerfile.relay',
    'apps/server/iroh-sidecar',
    'apps/web/src/lib/daemon-pairing-key-store.ts',
    'packages/iroh-bridge-protocol',
    'packages/shared/src/signaling/builders.ts',
    'packages/shared/src/signaling-sequence.ts',
    'scripts/build-server-artifacts.ts',
  ].map((retiredPath) => ({ retiredPath }));

  test.each(retiredPathCases)(
    'rejects restored retired path $retiredPath',
    async ({ retiredPath }) => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-path-'));
      try {
        const restoredPath = path.join(repoRoot, retiredPath);
        await fs.mkdir(path.dirname(restoredPath), { recursive: true });
        await fs.writeFile(restoredPath, 'export const restored = true;\n');

        await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
          `retired path exists: ${retiredPath}`,
        );
      } finally {
        await fs.rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test('rejects retired APIs inside a current production file', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-source-'));
    try {
      const signalingPath = path.join(repoRoot, 'apps/web/src/session/edge-signaling.ts');
      await fs.mkdir(path.dirname(signalingPath), { recursive: true });
      await fs.writeFile(signalingPath, 'const getResumeRequest = () => null;\n');

      await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
        'retired browser signaling sequence/resume API or URL facade',
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('allows retired config field spellings only in the exact migration module', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-migration-'));
    try {
      const migrationPath = path.join(
        repoRoot,
        'apps/daemon/src/cli/legacy-daemon-config-migration.ts',
      );
      await fs.mkdir(path.dirname(migrationPath), { recursive: true });
      await fs.writeFile(migrationPath, "const fields = ['pairing_id', 'pairing_root'];\n");

      await expect(assertCurrentProtocolHardCut(repoRoot)).resolves.toBeUndefined();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects retired config fields outside the exact migration module', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-migration-'));
    try {
      const sourcePath = path.join(repoRoot, 'apps/daemon/src/cli/link.ts');
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, "const fields = ['pairing_root'];\n");

      await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
        'retired pairing-root or persistent-browser trust mode',
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not exempt any other retired API in the migration module', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-migration-'));
    try {
      const migrationPath = path.join(
        repoRoot,
        'apps/daemon/src/cli/legacy-daemon-config-migration.ts',
      );
      await fs.mkdir(path.dirname(migrationPath), { recursive: true });
      await fs.writeFile(migrationPath, 'const pairingRoot = loadSecret();\n');

      await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
        'retired pairing-root or persistent-browser trust mode',
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  const retiredSurfaceCases = [
    {
      name: 'server password hash column',
      label: 'retired server-password authentication path',
      file: 'apps/server/src/db/schema.ts',
      source: "const password_hash = 'legacy';\n",
    },
    {
      name: 'plaintext-password continuation route',
      label: 'retired server-password authentication path',
      file: 'apps/server/src/http/routes/auth-routes.ts',
      source: "const route = '/api/auth/continue';\n",
    },
    {
      name: 'persistent browser pairing credential',
      label: 'retired pairing-root or persistent-browser trust mode',
      file: 'apps/web/src/session/auth.ts',
      source: 'const pairingRoot = await loadPersistentSecret();\n',
    },
    {
      name: 'pairing-era hybrid bootstrap API',
      label: 'retired pairing-root or persistent-browser trust mode',
      file: 'packages/e2e-wasm/src/lib.rs',
      source: 'pub struct HybridClientBootstrap;\n',
    },
    {
      name: 'Iroh Cargo dependency',
      label: 'retired Iroh control-plane dependency, configuration, or environment',
      file: 'Cargo.toml',
      source: '[dependencies]\niroh = "0.95"\n',
    },
    {
      name: 'Iroh daemon config key',
      label: 'retired Iroh control-plane dependency, configuration, or environment',
      file: 'apps/daemon/src/config.ts',
      source: 'const iroh_relay_url = "https://relay.example";\n',
    },
    {
      name: 'Iroh server environment variable',
      label: 'retired Iroh control-plane dependency, configuration, or environment',
      file: 'apps/server/.env.example',
      source: 'IROH_SECRET_KEY_PATH=/run/secrets/daemon.key\n',
    },
    {
      name: 'Iroh relay Dockerfile reference',
      label: 'retired Iroh control-plane dependency, configuration, or environment',
      file: 'docker-compose.dev.yaml',
      source: 'services:\n  relay:\n    dockerfile: Dockerfile.relay\n',
    },
    {
      name: 'browser daemon transport identity alias',
      label: 'retired Iroh-era daemon identity alias',
      file: 'apps/web/src/session/request.ts',
      source: 'const daemonNodeId = response.daemonNodeId;\n',
    },
    {
      name: 'server bridge presence identity alias',
      label: 'retired Iroh-era daemon identity alias',
      file: 'apps/server/src/services/realtime-coordination-service.ts',
      source: 'const bridgePresenceId = presence.bridgePresenceId;\n',
    },
    {
      name: 'Rust daemon transport identity alias',
      label: 'retired Iroh-era daemon identity alias',
      file: 'apps/daemon/dataplane/src/network/mod.rs',
      source: 'let daemon_node_id = config.daemon_node_id;\n',
    },
    {
      name: 'shared daemon-control signaling type',
      label: 'retired shared daemon-control signaling surface',
      file: 'packages/shared/src/signaling/types.ts',
      source: 'export interface SignalingSessionStartServerMessage {}\n',
    },
    {
      name: 'shared daemon-control signaling builder',
      label: 'retired shared daemon-control signaling surface',
      file: 'packages/shared/src/signaling/types.ts',
      source: 'export function createDaemonSignalingRegisterMessage() {}\n',
    },
    {
      name: 'shared daemon-control signaling parser',
      label: 'retired shared daemon-control signaling surface',
      file: 'packages/shared/src/signaling/types.ts',
      source: 'export function parseSignalingHeartbeatAckServerMessage() {}\n',
    },
    {
      name: 'optional preedit capability',
      label: 'retired optional preedit capability/DOM-overlay path',
      file: 'apps/web/src/terminal/capability.ts',
      source: 'const supportsPreedit = true;\n',
    },
    {
      name: 'carrier backend alias',
      label: 'retired carrier/backend alias',
      file: 'apps/web/src/config.ts',
      source: 'const BACKEND_WS_ORIGIN = "wss://old.example";\n',
    },
    {
      name: 'daemon PTY facade',
      label: 'retired daemon PTY facade',
      file: 'apps/daemon/src/services/daemon-runtime.ts',
      source: 'interface PtySession {}\n',
    },
    {
      name: 'daemon connect-peer token',
      label: 'retired daemon connect-peer session token',
      file: 'apps/daemon/dataplane/src/ipc/commands.rs',
      source: 'struct Connect { session_token: String }\n',
    },
    {
      name: 'terminal WASM inspection API',
      label: 'retired unsequenced or inspection-only terminal WASM ABI',
      file: 'apps/web/src/wasm-loader.ts',
      source: 'terminal.refresh_damage();\n',
    },
    {
      name: 'transport-worker diagnostic variant',
      label: 'retired transport-worker message variants',
      file: 'apps/web/src/transport-worker-protocol.ts',
      source: "const message = { kind: 'diag' };\n",
    },
    {
      name: 'global edge certificate registry',
      label: 'retired global edge certificate registry',
      file: 'apps/server/src/services/edge-registry-service.ts',
      source: "const key = 'merkur:edge:cert-hash';\n",
    },
    {
      name: 'protocol encoder facade',
      label: 'retired protocol encoder facade',
      file: 'packages/protocol/src/channel.ts',
      source: 'export function encodeProtocolChannelFrame() {}\n',
    },
    {
      name: 'retired package reference',
      label: 'retired package or workspace reference',
      file: 'bun.lock',
      source: '"@merkur/typebox": ["@merkur/typebox@workspace:packages/typebox"]\n',
    },
    {
      name: 'permissive auth default',
      label: 'retired permissive server authentication defaults',
      file: 'packages/config/src/server-config.ts',
      source:
        "const enabled = Config.boolean('AUTH_ALLOW_REGISTRATION').pipe(Config.withDefault(true));\n",
    },
    {
      name: 'server-readable password continuation service',
      label: 'retired server-readable password authentication',
      file: 'apps/server/src/services/auth-service.ts',
      source: 'export function continueSession() {}\n',
    },
    {
      name: 'one-step daemon link service',
      label: 'retired one-step daemon link authority',
      file: 'apps/server/src/services/device-service.ts',
      source: 'export function linkDevice() {}\n',
    },
    {
      name: 'synthetic IPC error command',
      label: 'retired synthetic IPC error command',
      file: 'apps/daemon/dataplane/src/main.rs',
      source: 'let _ = tx.blocking_send((0xFF, b"read failed".to_vec()));\n',
    },
    {
      name: 'duplicate edge-handshake authority',
      label: 'duplicate browser edge-handshake authority',
      file: 'apps/web/src/session/connect-webtransport-edge.ts',
      source: 'const DATA_HANDSHAKE_VERSION = 1;\n',
    },
  ] as const;

  for (const { name, label, file, source } of retiredSurfaceCases) {
    test(`rejects ${name}`, async () => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-rule-'));
      try {
        const sourcePath = path.join(repoRoot, file);
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, source);
        await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(label);
      } finally {
        await fs.rm(repoRoot, { recursive: true, force: true });
      }
    });
  }

  test('scans deployed generated WASM glue', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-generated-'));
    try {
      const sourcePath = path.join(repoRoot, 'apps/web/src/term-wasm/pkg/term_wasm.js');
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        "console.warn('using deprecated parameters for `initSync()`; pass an object');\n",
      );
      await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
        'retired unsequenced or inspection-only terminal WASM ABI',
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects restored producer-only terminal WASM constructors', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-wasm-rust-'));
    try {
      const sourcePath = path.join(repoRoot, 'packages/term-wasm/src/lib.rs');
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        '#[wasm_bindgen(constructor)]\npub fn new(cols: u16, rows: u16) -> Terminal {}\n',
      );
      await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
        'retired unsequenced or inspection-only terminal WASM ABI',
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('ignores test files and named inline Rust test modules', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-tests-'));
    try {
      const typescriptTest = path.join(repoRoot, 'apps/web/src/session/edge-signaling.test.ts');
      const rustSource = path.join(repoRoot, 'apps/daemon/dataplane/src/connection.rs');
      await Promise.all([
        fs.mkdir(path.dirname(typescriptTest), { recursive: true }),
        fs.mkdir(path.dirname(rustSource), { recursive: true }),
      ]);
      await fs.writeFile(typescriptTest, 'const getResumeRequest = () => null;\n');
      await fs.writeFile(
        rustSource,
        [
          'pub fn current() {}',
          '#[cfg(test)]',
          'mod browser_carrier_tests {',
          '    const RETIRED: &str = r###"DEFAULT_SHELL"###;',
          '    mod nested {',
          '        /* nested { comment } */',
          "        fn sample() { assert_eq!('{', '{'); }",
          '    }',
          '}',
          'pub fn current_after_tests() {}',
          '',
        ].join('\n'),
      );

      await expect(assertCurrentProtocolHardCut(repoRoot)).resolves.toBeUndefined();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('resumes scanning production Rust after an inline test module', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-rust-suffix-'));
    try {
      const rustSource = path.join(repoRoot, 'apps/daemon/dataplane/src/main.rs');
      await fs.mkdir(path.dirname(rustSource), { recursive: true });
      await fs.writeFile(
        rustSource,
        [
          'pub fn before() {}',
          '#[cfg(test)]',
          'mod early_tests {',
          '    fn nested() { let json = r#"{ \\"test\\": true }"#; }',
          '}',
          'pub fn restored() { let shell = DEFAULT_SHELL; }',
          '',
        ].join('\n'),
      );

      await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
        'retired optional edge-coordinate path',
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test.each(['r', 'br'])(
    'preserves 255-hash %s raw strings and rescans changed files',
    async (prefix) => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merkur-hard-cut-raw-bound-'));
      try {
        const rustSource = path.join(repoRoot, 'apps/daemon/dataplane/src/main.rs');
        await fs.mkdir(path.dirname(rustSource), { recursive: true });
        const hashes = '#'.repeat(255);
        const tests = [
          '#[cfg(test)]',
          'mod boundary_tests {',
          `const SAMPLE: &str = ${prefix}${hashes}"} DEFAULT_SHELL {"${hashes};`,
          '}',
        ].join('\n');
        await fs.writeFile(rustSource, tests);
        await expect(assertCurrentProtocolHardCut(repoRoot)).resolves.toBeUndefined();
        await fs.writeFile(
          rustSource,
          `${tests}\npub fn restored() { let shell = DEFAULT_SHELL; }\n`,
        );
        await expect(assertCurrentProtocolHardCut(repoRoot)).rejects.toThrow(
          'retired optional edge-coordinate path',
        );
      } finally {
        await fs.rm(repoRoot, { recursive: true, force: true });
      }
    },
  );
});
