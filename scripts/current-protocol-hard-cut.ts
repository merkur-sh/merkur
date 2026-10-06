import type { Stats } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RETIRED_PATHS = [
  'Dockerfile.relay',
  'apps/daemon/src/services/edge-coords-refresh-controller.test.ts',
  'apps/daemon/src/services/edge-coords-refresh-controller.ts',
  'apps/daemon/src/services/session-manager.ts',
  'apps/daemon/src/cli/minisign.test.ts',
  'apps/daemon/src/cli/minisign.ts',
  'apps/server/iroh-sidecar',
  'apps/server/src/services/iroh-bridge-service.test.ts',
  'apps/server/src/services/iroh-bridge-service.ts',
  'apps/server/src/services/iroh-daemon-message-handler.test.ts',
  'apps/server/src/services/iroh-daemon-message-handler.ts',
  'apps/web/src/lib/daemon-pairing-key-store.test.ts',
  'apps/web/src/lib/daemon-pairing-key-store.ts',
  'apps/web/src/terminal/preedit-overlay.ts',
  'apps/web/src/transport/display-dictionary-capability.test.ts',
  'apps/web/src/transport/display-dictionary-capability.ts',
  'packages/config/src/iroh-relay-url.ts',
  'packages/iroh-bridge-protocol',
  'packages/shared/src/signaling.test.ts',
  'packages/shared/src/signaling/builders.ts',
  'packages/shared/src/signaling/constants.ts',
  'packages/shared/src/signaling/parse.ts',
  'packages/shared/src/signaling-compat.test.ts',
  'packages/shared/src/signaling-sequence.test.ts',
  'packages/shared/src/signaling-sequence.ts',
  'packages/shared/src/signaling.ts',
  'packages/shared/src/signaling/url.ts',
  'packages/shared/test-fixtures/signaling-v1.json',
  'packages/typebox',
  'scripts/build-server-artifacts.ts',
  'scripts/check-compat.ts',
  'scripts/run-dragonfly-compat.ts',
] as const;

interface ForbiddenSourceRule {
  readonly label: string;
  readonly roots: readonly string[];
  readonly patterns: readonly RegExp[];
  readonly exceptions?: readonly ForbiddenSourceException[];
}

interface ForbiddenSourceException {
  readonly relativeFile: string;
  readonly patterns: readonly RegExp[];
}

const LEGACY_DAEMON_CONFIG_MIGRATION_FILE = 'apps/daemon/src/cli/legacy-daemon-config-migration.ts';
const RETIRED_PAIRING_CONFIG_FIELD_PATTERN = /\bpairing_(?:id|root|credential|code)\b/;

const FORBIDDEN_SOURCE_RULES: readonly ForbiddenSourceRule[] = [
  {
    label: 'retired server-password authentication path',
    roots: ['apps/server/src', 'apps/web/src', 'packages/auth/src', 'packages/auth/package.json'],
    patterns: [
      /\bpassword_hash\b/,
      /\/api\/auth\/continue\b/,
      /\bhashPassword\b/,
      /\bverifyPassword\b/,
      /@node-rs\/argon2/,
    ],
  },
  {
    label: 'retired pairing-root or persistent-browser trust mode',
    roots: [
      'apps/daemon/dataplane/src/auth.rs',
      'apps/daemon/dataplane/src/ipc/commands.rs',
      'apps/daemon/src',
      'apps/server/src/http',
      'apps/server/src/services',
      'apps/web/src',
      'packages/auth/src',
      'packages/config/src/daemon-config.ts',
      'packages/daemon-control-protocol/src',
      'packages/e2e-wasm/src',
      'packages/merkur-e2e/src',
      'packages/shared/src',
    ],
    patterns: [
      /\bpairing(?:Id|Root|Credential|Code)\b/,
      RETIRED_PAIRING_CONFIG_FIELD_PATTERN,
      /\bHybridClientBootstrap\b/,
      /\bbuildHybrid[A-Za-z0-9_]*\b/,
      /daemon-pairing-key-store/,
      /root-authenticated/,
    ],
    exceptions: [
      {
        relativeFile: LEGACY_DAEMON_CONFIG_MIGRATION_FILE,
        patterns: [RETIRED_PAIRING_CONFIG_FIELD_PATTERN],
      },
    ],
  },
  {
    label: 'retired classical or unsigned daemon release trust path',
    roots: [
      'apps/daemon/src/cli',
      'apps/server/src/http/install-script.ts',
      'packages/shared/src/release.ts',
      'scripts',
    ],
    patterns: [/minisign/i, /SHA256SUMS/, /RELEASE_CHECKSUMS/, /RELEASE_MINISIGN/],
  },
  {
    label: 'retired Iroh control-plane dependency, configuration, or environment',
    roots: [
      'Cargo.lock',
      'Cargo.toml',
      'Dockerfile',
      'Dockerfile.daemon-release',
      'apps',
      'bun.lock',
      'docker-compose.dev.yaml',
      'package.json',
      'packages',
      'scripts',
    ],
    patterns: [/iroh/i, /Dockerfile\.relay/],
  },
  {
    label: 'retired Iroh-era daemon identity alias',
    roots: ['apps', 'packages', 'scripts'],
    patterns: [
      /\bdaemonNodeId\b/,
      /\bdaemon_node_id\b/,
      /\bdaemonEndpointId\b/,
      /\bdaemon_endpoint_id\b/,
      /\bbridgeInstanceId\b/,
      /\bbridge_instance_id\b/,
      /\bbridgePresenceId\b/,
      /\bbridge_presence_id\b/,
      /\bbridgeClaimSeq\b/,
      /\bbridge_claim_seq\b/,
      /\bbridgeNodeId\b/,
      /\bbridge_node_id\b/,
      /\bbridgeRelayUrl\b/,
      /\bbridge_relay_url\b/,
    ],
  },
  {
    label: 'retired shared daemon-control signaling surface',
    roots: ['packages/shared/src/index.ts', 'packages/shared/src/signaling'],
    patterns: [
      /\bSIGNAL_PROTOCOL_VERSION\b/,
      /\bSIGNAL_HEARTBEAT_INTERVAL_MS\b/,
      /\bSignalingRegisterDaemonClientMessage\b/,
      /\bSignalingHeartbeatClientMessage\b/,
      /\bNormalizedSignalingRegisterDaemonMessage\b/,
      /\bSignalingSessionStartServerMessage\b/,
      /\bSignalingSessionCancelServerMessage\b/,
      /\bSignalingRegisteredServerMessage\b/,
      /\bSignalingHeartbeatAckServerMessage\b/,
      /\bcreateDaemonSignalingRegisterMessage\b/,
      /\bcreateSignalingHeartbeatMessage\b/,
      /\bcreateSignalingSessionStartMessage\b/,
      /\bcreateSignalingSessionCancelMessage\b/,
      /\bcreateSignalingRegisteredMessage\b/,
      /\bcreateSignalingHeartbeatAckMessage\b/,
      /\bparseSignalingDaemonRegisterMessage\b/,
      /\bparseSignalingHeartbeatClientMessage\b/,
      /\bparseSignalingRegisteredServerMessage\b/,
      /\bparseSignalingHeartbeatAckServerMessage\b/,
      /\bparseSignalingSessionStartMessage\b/,
      /\bparseSignalingSessionCancelMessage\b/,
    ],
  },
  {
    label: 'retired browser signaling sequence/resume API or URL facade',
    roots: [
      'apps/web/src/session/edge-signaling.ts',
      'packages/shared/package.json',
      'packages/shared/src/edge-signaling.ts',
      'packages/shared/src/index.ts',
      'packages/shared/src/signaling',
    ],
    patterns: [
      /\bdecideInboundSignalingSequence\b/,
      /\bSignalingSequenceDecision\b/,
      /\bSignalingResumeClientMessage\b/,
      /\bcreateSignalingResumeMessage\b/,
      /\bcreateBrowserSignalingRegisterMessage\b/,
      /\bSignalingRegisterBrowserClientMessage\b/,
      /\bNormalizedSignalingRegisterBrowserMessage\b/,
      /\bgetResumeRequest\b/,
      /\bsendResume\b/,
      /\bresolveSignalUrl\b/,
      /\bhttpOriginFromSignalUrl\b/,
      /\btype\s*:\s*['"]resume['"]/,
      /['"]\.\/signaling['"]\s*:/,
    ],
  },
  {
    label: 'retired optional preedit capability/DOM-overlay path',
    roots: ['apps/web/src'],
    patterns: [
      /\bsupportsInlinePreedit\b/,
      /\bsupportsPreedit\b/,
      /\bpreeditSupported\b/,
      /\bcreatePreeditOverlay\b/,
      /\bPreeditOverlay\b/,
      /preedit-overlay/,
    ],
  },
  {
    label: 'retired carrier/backend alias',
    roots: ['apps/web/src', 'apps/web/vite.config.ts'],
    patterns: [/\bBACKEND_WS_ORIGIN\b/],
  },
  {
    label: 'retired optional edge-coordinate path',
    roots: [
      'apps/daemon/dataplane/src',
      'apps/daemon/src/config.ts',
      'apps/daemon/src/services/daemon-runtime.ts',
      'apps/daemon/src/services/dataplane-client.ts',
      'packages/config/src/daemon-config.ts',
    ],
    patterns: [
      /\bEDGE_AFFINITY_CAPABILITY\b/,
      /\bsupportsEdgeAffinity\b/,
      /\bMERKUR_EDGE_WT_URL\b/,
      /\bEDGE_COORDS_(?:PATH|REFRESH_INTERVAL_MS)\b/,
      /\bEVT_PTY_ERROR\b/,
      /\bEVT_BINARY_MESSAGE\b/,
      /\bCMD_RESIZE\b/,
      /\bCMD_CLOSE_PTY\b/,
      /\bserver_tls_fingerprint\b/,
      /\bhot_path_logs\b/,
      /\bpeer_node_id\s*:\s*Option<&str>/,
      /\bDataHandshakeGeneration::Legacy\b/,
      /\bDEFAULT_SHELL\b/,
      /std::env::var\(["']SHELL["']\)/,
    ],
  },
  {
    label: 'retired daemon PTY facade',
    roots: [
      'apps/daemon/src/services/daemon-runtime.ts',
      'apps/daemon/src/services/dataplane-client.ts',
    ],
    patterns: [/\bPtySession\b/, /\bcreatePtySession\b/, /\bclosePty\b/],
  },
  {
    label: 'retired daemon connect-peer session token',
    roots: [
      'apps/daemon/dataplane/src/ipc/commands.rs',
      'apps/daemon/src/services/dataplane-client.ts',
    ],
    patterns: [/\bsession_token\b/],
  },
  {
    label: 'retired unsequenced or inspection-only terminal WASM ABI',
    roots: [
      'apps/web/src/term-wasm/pkg',
      'apps/web/src/wasm-loader.ts',
      'packages/term-wasm/pkg',
      'packages/term-wasm/src/lib.rs',
    ],
    patterns: [
      /\badvance_x\b/,
      /\bapply_state\s*\(/,
      /\bapply_delta\s*\(/,
      /\bapply_preview_delta_seq\b/,
      /\bclear_preview_overlay\b/,
      /\bdamaged_cells_(?:len|ptr)\b/,
      /\bdamaged_rows_(?:len|ptr)\b/,
      /\bdisplay_state_version\b/,
      /\bfill_row_buffer\b/,
      /\bis_full_damage\b/,
      /\brefresh_damage\b/,
      /\bvisible_text\b/,
      /\brow_buffer\b/,
      /\bhas_visible_predictions\b/,
      /\binitTerminal\b/,
      /\bset_preedit\s*\?/,
      /\bpub\s+fn\s+init\s*\(/,
      /#\[wasm_bindgen\(constructor\)\]\s*pub\s+fn\s+new\s*\(/,
      /pub\s+fn\s+inject_glyph\s*\([^)]*\badvance\s*:\s*f32/s,
      /deprecated parameters for (?:`initSync\(\)`|the initialization function)/,
      /initSync\(module:\s*\{\s*module:\s*SyncInitInput\s*\}\s*\|\s*SyncInitInput\)/,
      /module_or_path\?:[^;\n]*\}\s*\|\s*InitInput/,
    ],
  },
  {
    label: 'retired transport-worker message variants',
    roots: [
      'apps/web/src/transport-worker-client.ts',
      'apps/web/src/transport-worker-protocol.ts',
      'apps/web/src/transport-worker.ts',
    ],
    patterns: [/\bcold_start_replay\b/, /\btransport_worker_diag\b/, /\bkind\s*:\s*['"]diag['"]/],
  },
  {
    label: 'retired global edge certificate registry',
    roots: ['apps/server/src/services/edge-registry-service.ts'],
    patterns: [
      /\bLEGACY_CERT_HASH_KEY\b/,
      /\bstoreLegacyCertHash\b/,
      /\bgetLegacyCertHash\b/,
      /merkur:edge:cert-hash/,
    ],
  },
  {
    label: 'retired protocol encoder facade',
    roots: ['packages/protocol/src'],
    patterns: [
      /\bencodeProtocolChannelFrame\b/,
      /\bencodeProtocolChannelBytesFrame\b/,
      /\bcreateProtocolChannelBytesFrame\b/,
      /\bencodeInputAckFrame\b/,
      /\bencodeAuthChallengeFrame\b/,
      /\bencodeAuthResultFrame\b/,
      /\bencodeAuthResumptionTokenFrame\b/,
      /\bencodeDisplayFenceFrame\b/,
    ],
  },
  {
    label: 'retired package or workspace reference',
    roots: [
      'Dockerfile',
      'README.md',
      'bun.lock',
      'package.json',
      'scripts/check-dead.ts',
      'tsconfig.base.json',
    ],
    patterns: [/@merkur\/typebox/, /packages\/typebox/],
  },
  {
    label: 'retired permissive server authentication defaults',
    roots: ['packages/config/src/server-config.ts'],
    patterns: [
      /\bDEFAULT_HMAC_SECRET\b/,
      /Config\.boolean\(['"]AUTH_ALLOW_REGISTRATION['"]\)[\s\S]{0,160}withDefault\(true\)/,
      /Config\.int\(['"]TRUSTED_PROXY_HOPS['"]\)[\s\S]{0,160}withDefault\(/,
    ],
  },
  {
    label: 'retired server-readable password authentication',
    roots: ['apps/server/src', 'apps/web/src', 'packages/auth/src', 'scripts'],
    patterns: [
      /\bhashPassword\b/,
      /\bverifyPassword\b/,
      /\bpassword_hash\b/,
      /\bcontinueSession\b/,
      /\/api\/auth\/continue\b/,
    ],
  },
  {
    label: 'retired one-step daemon link authority',
    roots: ['apps/daemon/src', 'apps/server/src', 'apps/web/src', 'packages/shared/src'],
    patterns: [/\blinkDevice\b/, /\bDaemonLinkRequest\b/, /\/api\/devices\/link\b/],
  },
  {
    label: 'retired synthetic IPC error command',
    roots: ['apps/daemon/dataplane/src/main.rs'],
    patterns: [/\bblocking_send\s*\(\s*\(\s*0xFF\b/],
  },
  {
    label: 'retired display capability negotiation',
    roots: ['apps/daemon/dataplane/src', 'apps/web/src', 'packages/protocol/src'],
    patterns: [
      /\bMSG_TYPE_DISPLAY_CAPABILITIES\b/,
      /\bMESSAGE_TYPE_DISPLAY_CAPABILITIES\b/,
      /\bDISPLAY_CAP_ROW_COPY\b/,
      /\bDISPLAY_CAP_COMPRESSION_DICT\b/,
      /\bDISPLAY_CAP_EDITOR_ANCHOR\b/,
      /\bdisplay_capabilities\b/,
      /\bDisplayCapabilitiesMessage\b/,
      /\bencodeDisplayCapabilitiesFrame\b/,
      /\bcreateDisplayDictionaryCapabilityGate\b/,
      /display-dictionary-capability/,
    ],
  },
  {
    label: 'retired unflagged input run',
    roots: ['apps/daemon/dataplane/src', 'apps/web/src', 'packages/protocol/src'],
    patterns: [
      /\bMSG_TYPE_INPUT_RUN_V2\b/,
      /\bMESSAGE_TYPE_INPUT_RUN_V2\b/,
      /\bparse_input_run_v2\b/,
      /\bencode_input_run_v2\b/,
      /\bInputRunV2(?:Entry|Iter|Message)\b/,
      /\bencodeInputRunV2Frame\b/,
      /['"]input_run_v2['"]/,
    ],
  },
  {
    label: 'duplicate browser edge-handshake authority',
    roots: ['apps/web/src/session/connect-webtransport-edge.ts'],
    patterns: [
      /\bconst\s+PREFACE_VERSION\b/,
      /\bconst\s+DATA_HANDSHAKE_(?:VERSION|NONCE_BYTES|PAYLOAD_BYTES|KIND_[A-Z]+)\b/,
    ],
  },
];

export async function assertCurrentProtocolHardCut(repoRoot: string = REPO_ROOT): Promise<void> {
  const violations: string[] = [];

  for (const retiredPath of RETIRED_PATHS) {
    if (await pathExists(path.join(repoRoot, retiredPath))) {
      violations.push(`retired path exists: ${retiredPath}`);
    }
  }

  // Roots overlap heavily between rules. Discover their exact membership first,
  // then read and strip each file once, without retaining all source strings or
  // weakening any rule's scope. This cache belongs to one assertion only.
  const filesByRoot = new Map<string, string[]>();
  const rulesByFile = new Map<string, Set<ForbiddenSourceRule>>();
  for (const rule of FORBIDDEN_SOURCE_RULES) {
    for (const root of rule.roots) {
      let files = filesByRoot.get(root);
      if (files === undefined) {
        files = await productionFiles(path.join(repoRoot, root));
        filesByRoot.set(root, files);
      }
      for (const file of files) {
        let rules = rulesByFile.get(file);
        if (rules === undefined) {
          rules = new Set();
          rulesByFile.set(file, rules);
        }
        rules.add(rule);
      }
    }
  }
  for (const [file, rules] of rulesByFile) {
    const relativeFile = path.relative(repoRoot, file);
    if (relativeFile === 'scripts/current-protocol-hard-cut.ts') continue;
    const source = stripInlineRustTests(file, await fs.readFile(file, 'utf8'));
    for (const rule of rules) {
      for (const pattern of rule.patterns) {
        const isExactException = rule.exceptions?.some(
          (exception) =>
            exception.relativeFile === relativeFile && exception.patterns.includes(pattern),
        );
        if (pattern.test(source) && !isExactException) {
          violations.push(`${rule.label}: ${relativeFile} matches ${String(pattern)}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`Current-protocol hard cut violated:\n${violations.join('\n')}`);
  }
}

async function productionFiles(root: string): Promise<string[]> {
  let stat: Stats;
  try {
    stat = await fs.stat(root);
  } catch {
    return [];
  }
  if (stat.isFile()) return isProductionFile(root) ? [root] : [];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'target') {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionFiles(entryPath)));
    } else if (entry.isFile() && isProductionFile(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function isProductionFile(file: string): boolean {
  const basename = path.basename(file);
  return (
    !/\.test\.[cm]?[jt]sx?$/.test(file) &&
    !/\.spec\.[cm]?[jt]sx?$/.test(file) &&
    (/\.(?:json|md|rs|sh|toml|ya?ml|[cm]?[jt]sx?)$/.test(file) ||
      /^\.env\..+$/.test(basename) ||
      basename === 'bun.lock' ||
      basename === 'Cargo.lock' ||
      basename.startsWith('Dockerfile'))
  );
}

function stripInlineRustTests(file: string, source: string): string {
  if (!file.endsWith('.rs')) return source;
  const testModule =
    /^[\t ]*#\[cfg\(test\)\][\t ]*\r?\n[\t ]*(?:pub(?:\([^)]*\))?[\t ]+)?mod[\t ]+[A-Za-z_]\w*[\t ]*\{/gm;
  let cursor = 0;
  let stripped = '';
  for (let match = testModule.exec(source); match !== null; match = testModule.exec(source)) {
    const openingBrace = match.index + match[0].lastIndexOf('{');
    const closingBrace = findMatchingRustBrace(source, openingBrace);
    if (closingBrace === null) {
      // Never hide a malformed suffix. Leaving it visible is safer than
      // accidentally exempting production code from the hard-cut scan.
      continue;
    }
    stripped += source.slice(cursor, match.index);
    stripped += '\n';
    cursor = closingBrace + 1;
    testModule.lastIndex = cursor;
  }
  return stripped + source.slice(cursor);
}

function findMatchingRustBrace(source: string, openingBrace: number): number | null {
  let depth = 0;
  let blockCommentDepth = 0;
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' | 'char' | 'raw-string' = 'code';
  let rawTerminator = '';

  for (let index = openingBrace; index < source.length; index += 1) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (state === 'line-comment') {
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (current === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) state = 'code';
      }
      continue;
    }
    if (state === 'string' || state === 'char') {
      if (current === '\\') {
        index += 1;
      } else if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) {
        state = 'code';
      }
      continue;
    }
    if (state === 'raw-string') {
      if (source.startsWith(rawTerminator, index)) {
        index += rawTerminator.length - 1;
        state = 'code';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (current === '"' || (current === 'b' && next === '"')) {
      state = 'string';
      if (current === 'b') index += 1;
      continue;
    }

    const rawPrefix =
      current === 'r' || (current === 'b' && next === 'r')
        ? source.slice(index, index + 258).match(/^(?:b)?r(#{0,255})"/)
        : null;
    if (rawPrefix !== null) {
      const hashes = rawPrefix[1] ?? '';
      rawTerminator = `"${hashes}`;
      state = 'raw-string';
      index += rawPrefix[0].length - 1;
      continue;
    }
    if (current === "'" && hasNearbyRustCharTerminator(source, index)) {
      state = 'char';
      continue;
    }
    if (current === '{') {
      depth += 1;
    } else if (current === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function hasNearbyRustCharTerminator(source: string, openingQuote: number): boolean {
  let escaped = false;
  const limit = Math.min(source.length, openingQuote + 12);
  for (let index = openingQuote + 1; index < limit; index += 1) {
    const current = source[index];
    if (current === '\n') return false;
    if (!escaped && current === "'") return true;
    if (!escaped && current === '\\') {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return false;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
